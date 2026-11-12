import Foundation
import WebKit

// Keep the current allowed route when WebKit is reclaimed. A foreground transition refreshes a live page rather
// than reloading it, so editors, scroll positions, video and open VS Code panels keep their state.
@MainActor
final class PageRecovery {
    private weak var web: WKWebView?
    private let home: URL
    private var lastURL: URL
    private var observation: NSKeyValueObservation?
    private var needsReload = false
    private var attempts: [Date] = []
    private var lastResume = Date.distantPast

    init(web: WKWebView, home: URL) {
        self.web = web
        self.home = home
        self.lastURL = home
        observation = web.observe(\.url) { [weak self] web, _ in
            MainActor.assumeIsolated {
                guard let self, let url = web.url, Self.sameOrigin(url, self.home) else { return }
                self.lastURL = url
            }
        }
    }

    nonisolated static func sameOrigin(_ a: URL, _ b: URL) -> Bool {
        func port(_ u: URL) -> Int? { u.port ?? (u.scheme == "https" ? 443 : u.scheme == "http" ? 80 : nil) }
        return a.scheme == b.scheme && a.host() == b.host() && port(a) == port(b)
    }

    func finished() { needsReload = false }

    func terminated(active: Bool) {
        needsReload = true
        lastResume = .distantPast
        if active { resume() }
    }

    func resume() {
        guard let web else { return }
        let now = Date()
        guard now.timeIntervalSince(lastResume) > 1 else { return }
        lastResume = now
        if needsReload || (web.url == nil && !web.isLoading) {
            // Repeated crashes must not create an unlimited reload loop. The app's manual reload still works.
            attempts.removeAll { now.timeIntervalSince($0) > 60 }
            guard attempts.count < 3 else { return }
            attempts.append(now)
            needsReload = false
            if let url = web.url, Self.sameOrigin(url, home) { web.reload() }
            else { web.load(URLRequest(url: lastURL)) }
        } else {
            web.evaluateJavaScript(PageBridge.resumeScript, completionHandler: nil)
        }
    }

    func reload() {
        attempts = []
        needsReload = false
        if let web, web.url != nil { web.reload() }
        else { web?.load(URLRequest(url: lastURL)) }
    }
}
