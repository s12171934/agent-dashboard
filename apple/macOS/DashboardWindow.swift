import AppKit
import WebKit

// The dashboard page itself, in a window that is also a tab (⌘T): every window shares the page's storage, so each
// tab is the same dashboard on its own screen. The page is the deployed site (or pageURL), unchanged, served
// through LocalPage on loopback: only its browser notifications are switched off, because the app posts its own
// (they work with the window closed).
final class DashboardWindow: NSObject, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate {
    static var pageURL: URL {
        URL(string: UserDefaults.standard.string(forKey: "pageURL") ?? "") ?? URL(string: "https://dashboard.s-dante.com/")!
    }

    let window: NSWindow
    let web: WKWebView
    private let home: URL
    private var titleWatch: NSKeyValueObservation?
    var onClose: ((DashboardWindow) -> Void)?
    var onNewTab: ((URL) -> Void)?
    var onIcon: ((URL) -> Void)?
    var onServer: ((URL) -> Void)?

    // home: where the page is served (LocalPage, else the site); url: a screen of it to open, else its start.
    init(home: URL, url: URL? = nil, first: Bool) {
        self.home = home
        let conf = WKWebViewConfiguration()
        let relay = Relay()
        PageBridge.install(on: conf.userContentController, platform: "macos", handler: relay)
        if home == LocalPage.url {  // the web VS Code of the loopback server opens through this origin (LocalPage)
            conf.userContentController.addUserScript(WKUserScript(source: "window.adashVscodePort = \(LocalPage.vscodePort);",
                                                                  injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        web = WKWebView(frame: .zero, configuration: conf)
        web.isInspectable = true
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        super.init()
        relay.owner = self
        web.navigationDelegate = self
        web.uiDelegate = self
        window.delegate = self
        window.title = "Agent Dashboard"
        window.isReleasedWhenClosed = false
        window.tabbingIdentifier = "dashboard"
        window.tabbingMode = .preferred
        window.contentView = web
        window.center()
        if first { window.setFrameAutosaveName("main") }  // one name per window: the rest open on top of it
        // The tab shows the page's own title, so tabs on different screens tell apart.
        titleWatch = web.observe(\.title) { [weak self] web, _ in
            if let t = web.title, !t.isEmpty { self?.window.title = t }
        }
        web.load(URLRequest(url: url ?? home))
    }

    func windowWillClose(_ notification: Notification) {
        web.configuration.userContentController.removeScriptMessageHandler(forName: "adash")
        onClose?(self)
    }

    fileprivate func received(_ body: Any) {
        switch PageBridge.parse(body) {
        case .icon(let url): onIcon?(url)
        case .server(let url): onServer?(url)
        case .dock, .chrome, nil: break
        }
    }

    func show() {
        NSApp.activate()
        window.makeKeyAndOrderFront(nil)
    }

    func open(sessionPath: String?) {
        show()
        web.evaluateJavaScript("location.hash = \(jsString(sessionHash(sessionPath)))")
    }

    func reload() { web.reload() }

    // Links out of the page (PRs, Jira, vscode://) go to the default browser or app, not into this window.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.allow) }
        if action.targetFrame?.isMainFrame == true, url.host() != home.host() || url.port != home.port {
            NSWorkspace.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith conf: WKWebViewConfiguration, for action: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        // ⌘-click and target=_blank: the dashboard's own screens open in a new tab, the rest outside.
        guard let url = action.request.url else { return nil }
        if url.host() == home.host() && url.port == home.port { onNewTab?(url) } else { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert()
        a.messageText = message
        a.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert()
        a.messageText = message
        a.addButton(withTitle: "확인")
        a.addButton(withTitle: "취소")
        a.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }
}

// The content controller holds its handlers strongly: this keeps it from holding the window.
private final class Relay: NSObject, WKScriptMessageHandler {
    weak var owner: DashboardWindow?
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) { owner?.received(m.body) }
}
