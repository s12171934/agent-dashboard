import Foundation

// Watches one metric server for 결정 대기 questions, the way the page does: /events says something changed, then
// /api/decisions (the questions and the sessions holding them) is read again. Runs whether or not the window is open, so the menu bar, the Dock badge and the
// notifications keep up with the page closed.
@MainActor
final class DecisionWatcher {
    struct Option: Decodable { let label: String }
    struct Question: Decodable { let header: String?; let question: String; let multiSelect: Bool?; let options: [Option] }
    struct Pending: Decodable { let id: String; let agent: String?; let questions: [Question] }
    private struct Ref: Decodable { let id: String }
    private struct Session: Decodable { let path: String; let title: String?; let decision: Ref? }
    private struct Decisions: Decodable { let available: Bool; let pending: [Pending] }
    private struct State: Decodable { let sessions: [Session]?; let decisions: Decisions? }

    enum Link { case unknown, connected, down(String) }

    nonisolated static var serverURL: URL {  // UserDefaults: readable from any thread (LocalPage)
        URL(string: UserDefaults.standard.string(forKey: "serverURL") ?? "") ?? URL(string: "http://127.0.0.1:8787")!
    }

    private(set) var link = Link.unknown
    private(set) var pending: [Pending] = []
    private var sessionOf: [String: Session] = [:]  // question id -> the session it holds
    private var primed = false  // what is pending at launch counts as seen, so a relaunch does not ring again
    var onChange: (() -> Void)?
    var onNew: ((Pending) -> Void)?
    var onGone: (([String]) -> Void)?

    private var fetching = false, again = false

    private var listening: Task<Void, Never>?

    func start() {
        AppGroup.share(Self.serverURL)  // the widgets read the same server
        listening = Task { await listen() }
        // A fallback beat in case /events stays quiet or drops without an error.
        Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { _ in Task { @MainActor in await self.refresh() } }
    }

    // The server changed (the page's server list): drop the old stream and what it had, listen to the new one.
    func use(_ url: URL) {
        guard url != Self.serverURL else { return }
        UserDefaults.standard.set(url.absoluteString, forKey: "serverURL")
        AppGroup.share(url)
        listening?.cancel()
        pending = []
        primed = false
        set(.unknown)
        listening = Task { await listen() }
    }

    func sessionPath(of id: String) -> String? { sessionOf[id]?.path }

    func title(of q: Pending) -> String {
        if let t = sessionOf[q.id]?.title, !t.isEmpty { return t }
        return q.agent ?? "에이전트"
    }

    private func listen() async {
        while !Task.isCancelled {
            await refresh()
            do {
                var req = URLRequest(url: Self.serverURL.appending(path: "events"))
                req.timeoutInterval = 60  // the server pings well inside this
                let (bytes, _) = try await URLSession.shared.bytes(for: req)
                for try await line in bytes.lines where line.hasPrefix("data:") {
                    if Task.isCancelled { return }
                    await refresh()
                }
            } catch {
                set(.down(error.localizedDescription))
            }
            try? await Task.sleep(for: .seconds(3))
        }
    }

    // One read at a time; a change that lands mid-read gets one more read after it, not one per event.
    func refresh() async {
        if fetching { again = true; return }
        fetching = true
        defer { fetching = false }
        repeat {
            again = false
            do {
                // /api/decisions is the few KB of this State; a server older than it (404) is read the old way.
                var (data, res) = try await URLSession.shared.data(from: Self.serverURL.appending(path: "api/decisions"))
                if (res as? HTTPURLResponse)?.statusCode == 404 {
                    (data, _) = try await URLSession.shared.data(from: Self.serverURL.appending(path: "api/state"))
                }
                apply(try JSONDecoder().decode(State.self, from: data))
            } catch {
                set(.down(error.localizedDescription))
            }
            if again { try? await Task.sleep(for: .seconds(1)) }  // at most one read a second
        } while again
    }

    private func apply(_ s: State) {
        sessionOf = [:]
        for x in s.sessions ?? [] { if let d = x.decision { sessionOf[d.id] = x } }
        if let d = s.decisions, d.available {  // decisions unavailable: keep what was seen, as the page does
            let old = Set(pending.map(\.id)), now = Set(d.pending.map(\.id))
            if primed { for q in d.pending where !old.contains(q.id) { onNew?(q) } }
            let gone = old.subtracting(now)
            if !gone.isEmpty { onGone?(Array(gone)) }
            pending = d.pending
            primed = true
        }
        set(.connected)
    }

    private func set(_ l: Link) { link = l; onChange?() }

    // Puts one answer per question into the session's terminal, as the page's 결정 버튼 does. nil when it went in,
    // else the server's error.
    func answer(_ id: String, _ answers: [String]) async -> String? {
        var req = URLRequest(url: Self.serverURL.appending(path: "api/decision/answer"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["id": id, "answers": answers])
        do {
            let (data, res) = try await URLSession.shared.data(for: req)
            if (res as? HTTPURLResponse)?.statusCode == 200 { await refresh(); return nil }
            let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            return body?["error"] as? String ?? "응답하지 못했습니다"
        } catch {
            return "대시보드 서버에 보내지 못했습니다"
        }
    }
}
