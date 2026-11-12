import AppKit
import Foundation
import WebKit

@MainActor
private final class NavigationProbe: NSObject, WKNavigationDelegate {
    private var pending: CheckedContinuation<Void, Error>?
    private var timeout: Task<Void, Never>?
    var onFinish: (() -> Void)?
    func navigate(_ action: () -> Void) async throws {
        try await withCheckedThrowingContinuation { continuation in
            pending = continuation
            timeout = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(10)) } catch { return }
                self?.finish(URLError(.timedOut))
            }
            action()
        }
    }
    private func finish(_ error: Error? = nil) {
        guard let pending else { return }
        self.pending = nil
        timeout?.cancel()
        timeout = nil
        if let error { pending.resume(throwing: error) } else { pending.resume() }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { onFinish?(); finish() }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish(error) }
}

@MainActor
func verifyPageRecovery() async throws {
    // A tiny local page, no production dashboard, preferences or network. No window is presented.
    NSApplication.shared.setActivationPolicy(.prohibited)
    let directory = FileManager.default.temporaryDirectory.appending(path: "adash-recovery-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appending(path: "index.html")
    try "<html><body>Fixture<script>window.resumed=0;window.adashNative={resume(){window.resumed++}};</script></body></html>".write(to: url, atomically: true, encoding: .utf8)
    let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
    let recovery = PageRecovery(web: web, home: url)
    let probe = NavigationProbe()
    probe.onFinish = { recovery.finished() }
    web.navigationDelegate = probe
    try await probe.navigate { web.loadFileURL(url, allowingReadAccessTo: directory) }
    _ = try await web.evaluateJavaScript("location.hash='s=fixture'")
    recovery.resume()
    let resumed = try await web.evaluateJavaScript("window.resumed") as? Int
    precondition(resumed == 1, "foreground resume did not invoke the existing page")
    recovery.resume()
    let coalesced = try await web.evaluateJavaScript("window.resumed") as? Int
    precondition(coalesced == 1, "duplicate lifecycle hooks were not coalesced")
    try await probe.navigate { recovery.terminated(active: true) }
    precondition(web.url?.fragment == "s=fixture", "recovery lost the selected session")
    let restarted = try await web.evaluateJavaScript("window.resumed") as? Int
    precondition(restarted == 0, "the recovery path did not load a new document")
    web.stopLoading()
    print("✓ actual WKWebView resumes in place and reloads the current route after termination")
}
