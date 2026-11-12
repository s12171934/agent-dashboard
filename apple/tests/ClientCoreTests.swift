import Foundation

// The test executable injects its own URLSession and persistence; it never opens the real keychain or preferences.
enum AppGroup { static func share(_ url: URL) {} }
private func payload(_ ids: [String], available: Bool = true) -> Data {
    try! JSONSerialization.data(withJSONObject: ["decisions": ["available": available, "pending": ids.map { id in
        ["id": id, "agent": "조율자", "questions": [["question": "계속할까요?", "options": [["label": "진행"]]]]] as [String: Any]
    }], "sessions": ids.map { ["path": "/fixture/\($0).jsonl", "title": "한글 제목", "decision": ["id": $0]] as [String: Any] }])
}
private final class MockProtocol: URLProtocol, @unchecked Sendable {
    static let lock = NSLock()
    nonisolated(unsafe) static var reply: (URLRequest) -> (Int, Data, TimeInterval) = { _ in (200, payload([]), 0) }
    private var stopped = false
    private let stateLock = NSLock()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock(); let result = Self.reply(request); Self.lock.unlock()
        let stream = request.url?.path == "/events"
        DispatchQueue.global().asyncAfter(deadline: .now() + result.2) { [self] in
            stateLock.lock(); let cancelled = stopped; stateLock.unlock()
            if cancelled { return }
            let response = HTTPURLResponse(url: request.url!, statusCode: stream ? 200 : result.0,
                httpVersion: "HTTP/1.1", headerFields: ["Content-Type": stream ? "text/event-stream" : "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            if !stream { client?.urlProtocol(self, didLoad: result.1); client?.urlProtocolDidFinishLoading(self) }
        }
    }
    override func stopLoading() { stateLock.lock(); stopped = true; stateLock.unlock() }
    static func set(_ handler: @escaping (URLRequest) -> (Int, Data, TimeInterval)) { lock.lock(); reply = handler; lock.unlock() }
}
@main
private struct ClientCoreTests {
    @MainActor static func main() async throws {
        let core = DecisionCore()
        let first = try core.apply(payload(["a"]))
        precondition(first.new_ids.isEmpty && first.pending[0].id == "a")
        let next = try core.apply(payload(["b"]))
        precondition(next.new_ids == ["b"] && next.gone_ids == ["a"])
        precondition(next.sessions["b"]?.title == "한글 제목")
        print("✓ Swift calls Rust decision state through C ABI")
        let retained = try core.apply(payload([], available: false))
        precondition(retained.pending[0].id == "b")
        do { _ = try core.apply(Data("{\"error\":\"unavailable\"}".utf8)); preconditionFailure("invalid payload accepted") } catch {}
        core.reset()
        let reset = try core.apply(payload(["c"]))
        precondition(reset.new_ids.isEmpty)
        print("✓ unavailable, invalid response and server switch preserve notification semantics")

        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockProtocol.self]
        let session = URLSession(configuration: config)
        let watcher = DecisionWatcher(session: session, initialServer: URL(string: "https://old.test")!, persistServer: { _ in })
        var fresh: [String] = []
        watcher.onNew = { fresh.append($0.id) }
        MockProtocol.set { _ in (200, payload(["one"]), 0) }
        await watcher.refresh()
        precondition(watcher.pending.map(\.id) == ["one"] && fresh.isEmpty)
        MockProtocol.set { _ in (500, payload(["bad"]), 0) }
        await watcher.refresh()
        precondition(watcher.pending.map(\.id) == ["one"])
        if case .down = watcher.link {} else { preconditionFailure("HTTP error was reported as connected") }
        print("✓ HTTP error retains last good native state")
        watcher.stop()

        let switching = DecisionWatcher(session: session, initialServer: URL(string: "https://old.test")!, persistServer: { _ in })
        var seen: [String] = []
        switching.onChange = { [weak switching] in seen.append(contentsOf: switching?.pending.map(\.id) ?? []) }
        MockProtocol.set { request in request.url?.host() == "old.test" ? (200, payload(["old"]), 0.2) : (200, payload(["new"]), 0) }
        let old = Task { await switching.refresh() }
        try await Task.sleep(for: .milliseconds(30))
        switching.use(URL(string: "https://new.test")!)
        await old.value
        for _ in 0..<30 {
            if switching.pending.first?.id == "new" { break }
            try await Task.sleep(for: .milliseconds(100))
        }
        precondition(switching.pending.map(\.id) == ["new"] && !seen.contains("old"))
        switching.stop()
        session.invalidateAndCancel()
        print("✓ late response from the previous server is discarded")
        precondition(PageRecovery.sameOrigin(URL(string: "https://example.test:443/#s=abc")!, URL(string: "https://example.test/")!))
        precondition(!PageRecovery.sameOrigin(URL(string: "http://example.test/")!, URL(string: "https://example.test/")!))
        precondition(!PageRecovery.sameOrigin(URL(string: "https://other.test/#s=abc")!, URL(string: "https://example.test/")!))
        print("✓ recovery accepts only routes from the existing app origin")
        try await verifyPageRecovery()
    }
}
