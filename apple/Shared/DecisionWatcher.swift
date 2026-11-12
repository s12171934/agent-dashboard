import Foundation

// Watches one metric server for 결정 대기 questions, the way the page does: /events says something changed, then
// /api/decisions (the questions and the sessions holding them) is read again. Runs whether or not the window is open, so the menu bar, the Dock badge and the
// notifications keep up with the page closed.
@MainActor
final class DecisionWatcher {
    typealias Option = DecisionCore.Option
    typealias Question = DecisionCore.Question
    typealias Pending = DecisionCore.Pending

    enum Link { case unknown, connected, down(String) }

    nonisolated static var serverURL: URL {  // UserDefaults: readable from any thread (LocalPage)
        URL(string: UserDefaults.standard.string(forKey: "serverURL") ?? "") ?? URL(string: "http://127.0.0.1:8787")!
    }

    private(set) var link = Link.unknown
    private(set) var pending: [Pending] = []
    private var sessionOf: [String: DecisionCore.Session] = [:]  // question id -> the session it holds
    private let core = DecisionCore()
    var onChange: (() -> Void)?
    var onNew: ((Pending) -> Void)?
    var onGone: (([String]) -> Void)?

    private var fetching = false, again = false

    private var listening: Task<Void, Never>?
    private var fallback: Timer?
    private var generation = 0
    private let session: URLSession
    private var currentServer: URL
    private let persistServer: (URL) -> Void

    init(session: URLSession = .shared, initialServer: URL = DecisionWatcher.serverURL,
         persistServer: @escaping (URL) -> Void = { url in
             UserDefaults.standard.set(url.absoluteString, forKey: "serverURL")
             AppGroup.share(url)
         }) {
        self.session = session
        self.currentServer = initialServer
        self.persistServer = persistServer
    }

    func start() {
        guard listening == nil else { return }
        persistServer(currentServer)
        reconnect()
        fallback = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in await self?.refresh() }
        }
    }

    func stop() {
        generation += 1
        listening?.cancel()
        listening = nil
        fallback?.invalidate()
        fallback = nil
        again = false
    }

    // Resuming from suspension or system sleep needs a fresh stream, while keeping notification priming.
    func resume() { if listening != nil { reconnect() } else { start() } }

    private func reconnect() {
        generation += 1
        listening?.cancel()
        listening = Task { [weak self] in await self?.listen() }
    }

    func use(_ url: URL) {
        guard url != currentServer else { return }
        currentServer = url
        core.reset()
        if !pending.isEmpty { onGone?(pending.map(\.id)) }
        pending = []
        sessionOf = [:]
        set(.unknown)
        if listening == nil { start() }
        else { persistServer(url); reconnect() }
    }

    func sessionPath(of id: String) -> String? { sessionOf[id]?.path }

    func title(of q: Pending) -> String {
        if let t = sessionOf[q.id]?.title, !t.isEmpty { return t }
        return q.agent ?? "에이전트"
    }

    private func listen() async {
        while !Task.isCancelled {
            await refresh()
            if Task.isCancelled { return }
            let revision = generation
            do {
                var req = URLRequest(url: currentServer.appending(path: "events"))
                req.timeoutInterval = 60
                let (bytes, response) = try await session.bytes(for: req)
                guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
                for try await line in bytes.lines where line.hasPrefix("data:") {
                    if Task.isCancelled || revision != generation { return }
                    await refresh()
                }
            } catch {
                if Task.isCancelled || revision != generation { return }
                set(.down(error.localizedDescription))
            }
            if Task.isCancelled { return }
            try? await Task.sleep(for: .seconds(3))
        }
    }

    // Coalesce reads. An old server's response can never replace the new server's state.
    func refresh() async {
        if fetching { again = true; return }
        fetching = true
        defer {
            fetching = false
            if again {
                again = false
                Task { [weak self] in await self?.refresh() }
            }
        }
        repeat {
            if Task.isCancelled { return }
            again = false
            let revision = generation, server = currentServer
            do {
                var request = URLRequest(url: server.appending(path: "api/decisions"))
                request.timeoutInterval = 15
                var (data, response) = try await session.data(for: request)
                if (response as? HTTPURLResponse)?.statusCode == 404 {
                    request.url = server.appending(path: "api/state")
                    (data, response) = try await session.data(for: request)
                }
                guard revision == generation, !Task.isCancelled else { continue }
                guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
                apply(try core.apply(data))
            } catch {
                if revision == generation && !Task.isCancelled { set(.down(error.localizedDescription)) }
            }
            if again { try? await Task.sleep(for: .seconds(1)) }
        } while again
    }

    private func apply(_ update: DecisionCore.Update) {
        sessionOf = update.sessions
        pending = update.pending
        for id in update.new_ids { if let q = pending.first(where: { $0.id == id }) { onNew?(q) } }
        if !update.gone_ids.isEmpty { onGone?(update.gone_ids) }
        set(.connected)
    }

    private func set(_ l: Link) { link = l; onChange?() }

    // Puts one answer per question into the session's terminal, as the page's 결정 버튼 does. nil when it went in,
    // else the server's error.
    func answer(_ id: String, _ answers: [String]) async -> String? {
        var req = URLRequest(url: currentServer.appending(path: "api/decision/answer"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["id": id, "answers": answers])
        do {
            let (data, res) = try await session.data(for: req)
            if (res as? HTTPURLResponse)?.statusCode == 200 { await refresh(); return nil }
            let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            return body?["error"] as? String ?? "응답하지 못했습니다"
        } catch {
            return "대시보드 서버에 보내지 못했습니다"
        }
    }
}
