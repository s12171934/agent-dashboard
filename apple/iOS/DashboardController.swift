import UIKit
import UserNotifications
import WebKit

// The page in a web view under the system's own tab bar (UITabBarController: the App Store's bar — Liquid Glass, a
// lens that follows a finger dragged across the tabs, the bar shrinking as the page scrolls down). The page's floating
// bar is hidden (DockBridge) and stands in as:
// - tabs for the five screens the page's bar keeps (홈, 에이전트, QA, 프로젝트, 테스트), with the page's badges; a tab
//   press takes the page there (pressed again on 홈 or 에이전트, the page fits the office to the screen), and the page
//   moving elsewhere (a link, a notification) moves the selection with it;
// - 설정, the right button of each tab's navigation bar (the screen's name in the middle), where the App Store keeps
//   its account button (the system tab bar holds five tabs at most, the search tab's place included), opening a sheet
//   listing the rest of the bar as the App Store lists its settings: the other screens, the filters (a check while
//   on), the settings, each pressing the page's own element. A count badge up among them puts a dot on it (iOS 26).
// One web view serves every tab: the selected tab's page holds it. The page fills the screen, the side strip of iPhone
// Duo's outer display included (its content keeps to the safe area). Half folded (the hinge, iOS 27.1) the tab bar
// hides and the page lays itself out as on the web — the first half a page, the second its bar's sheet (fold.js,
// dock.css) — told so through window.dsHalfFolded.
final class DashboardController: UITabBarController, UITabBarControllerDelegate, WKNavigationDelegate, WKUIDelegate {
    static var pageURL: URL {
        URL(string: UserDefaults.standard.string(forKey: "pageURL") ?? "") ?? URL(string: "https://dashboard.s-dante.com/")!
    }

    // (page hash, title, SF Symbol)
    // the page's background (tokens.css --bg), light and dark: under the title and behind the page as it loads
    static let pageBackground = UIColor { $0.userInterfaceStyle == .dark
        ? UIColor(red: 0.06, green: 0.07, blue: 0.08, alpha: 1) : UIColor(red: 0.957, green: 0.961, blue: 0.969, alpha: 1) }

    private static let screens = [("#home", "홈", "house"), ("#agents", "에이전트", "person.2"),
                                  ("#worktrees", "QA", "square.3.layers.3d"),
                                  ("#projects", "프로젝트", "point.3.connected.trianglepath.dotted"), ("#tests", "테스트", "flask")]

    private var web: WKWebView!
    private let relay = Relay()
    private var items: [DockBridge.Item] = []
    private var following = false  // selecting the tab the page went to: not a press
    private weak var sheet: MoreController?
    private var settingsItems: [UIBarButtonItem] = []  // one per tab's navigation bar
    private var settingsDot = false
    private var halfFolded = false {
        didSet { if halfFolded != oldValue { tellFold(); fold() } }
    }
    var onServer: ((URL) -> Void)?
    private var loaded = false, waiting: String?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Self.pageBackground
        let conf = WKWebViewConfiguration()
        relay.owner = self
        PageBridge.install(on: conf.userContentController, platform: "ios", handler: relay)
        conf.userContentController.addUserScript(WKUserScript(source: DockBridge.script, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        web = WKWebView(frame: view.bounds, configuration: conf)
        web.isInspectable = true
        web.isOpaque = false
        web.backgroundColor = view.backgroundColor
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = true
        web.autoresizingMask = [.flexibleWidth, .flexibleHeight]

        delegate = self
        tabs = Self.screens.map { key, title, symbol in
            UITab(title: title, image: UIImage(systemName: symbol), identifier: key) { [weak self] _ in
                let slot = Slot()
                slot.navigationItem.title = title
                if let self { slot.navigationItem.rightBarButtonItem = settingsItem() }
                return UINavigationController(rootViewController: slot)
            }
        }
        if #available(iOS 26.0, *) { tabBarMinimizeBehavior = .onScrollDown }
        if #available(iOS 27.1, *) {
            view.addInteraction(UIHingeInteraction { [weak self] _, update in
                self?.halfFolded = update.hinge?.status == .partiallyOpen
            })
        }
        web.load(URLRequest(url: Self.pageURL))
    }

    // 설정: the navigation bar's right button, where the App Store keeps its account button
    private func settingsItem() -> UIBarButtonItem {
        let item = UIBarButtonItem(image: UIImage(systemName: "gearshape"), primaryAction: UIAction { [weak self] _ in self?.showMore() })
        item.accessibilityLabel = "설정: 다른 화면, 필터와 설정"
        settingsItems.append(item)
        badgeSettings()
        return item
    }
    private func badgeSettings() {
        guard #available(iOS 26.0, *) else { return }
        for item in settingsItems { item.badge = settingsDot ? .indicator() : nil }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        hold()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // The page keeps its popovers and its last lines clear of the tab bar.
        let reach = isTabBarHidden ? 0 : max(0, view.bounds.maxY - tabBar.frame.minY + 8)
        web?.evaluateJavaScript("document.documentElement.style.setProperty('--native-bar', '\(Int(reach))px')")
    }

    // The selected tab's page holds the one web view.
    private func hold() {
        guard let slot = (selectedViewController as? UINavigationController)?.topViewController, web.superview !== slot.view else { return }
        web.frame = slot.view.bounds
        slot.view.addSubview(web)
        slot.setContentScrollView(web.scrollView, for: .bottom)
    }

    func tabBarController(_ c: UITabBarController, shouldSelectTab tab: UITab) -> Bool {
        // the tab already shown pressed again: the page's own tab is pressed again (홈, 에이전트: the office fits the screen)
        if tab === selectedTab && !following { press(tab.identifier); return false }
        return true
    }

    func tabBarController(_ c: UITabBarController, didSelectTab tab: UITab, previousTab: UITab?) {
        hold()
        guard !following else { return }
        press(tab.identifier)
    }

    private var current: String? { items.first { $0.on && $0.key.hasPrefix("#") }?.key }

    private func press(_ key: String) {
        web.evaluateJavaScript("window.adashDock?.press(\(jsString(key)))")
    }

    // The page's bar as it is now: badges onto the tabs, the selection onto the screen the page shows.
    private func sync(_ new: [DockBridge.Item]) {
        items = new
        for t in tabs {
            let b = new.first { $0.key == t.identifier }?.badge
            t.badgeValue = b?.isEmpty == false ? b : nil
        }
        let dot = new.contains { !$0.badge.isEmpty && !Self.screens.map(\.0).contains($0.key) }
        if dot != settingsDot { settingsDot = dot; badgeSettings() }
        // a screen off the tabs (결정 대기, a session) leaves the selection where it was
        if let cur = current, Self.screens.contains(where: { $0.0 == cur }) {
            if selectedTab?.identifier != cur, let t = tabs.first(where: { $0.identifier == cur }) {
                following = true
                selectedTab = t
                following = false
                hold()
            }
        }
        sheet?.items = moreItems
    }

    // 설정: everything on the page's bar but the tabs, by the bar's groups, and the page's reload.
    private var moreItems: [(String, [DockBridge.Item])] {
        var groups: [(String, [DockBridge.Item])] = [("화면", [])]
        for it in items {
            if let sep = it.sep { groups.append((sep, [])) }
            else if !Self.screens.contains(where: { $0.0 == it.key }) { groups[groups.count - 1].1.append(it) }
        }
        groups[groups.count - 1].1.append(DockBridge.Item(key: "", tip: "새로 고침", icon: "", on: false, badge: "", text: "", sep: nil))
        return groups.filter { !$0.1.isEmpty }
    }

    private func showMore() {
        let m = MoreController()
        m.items = moreItems
        m.onPick = { [weak self, weak m] it in
            guard let self else { return }
            if it.key.isEmpty { web.reload(); m?.dismiss(animated: true); return }
            press(it.key)
            if it.key.hasPrefix("#") || !(it.on || it.isToggle) { m?.dismiss(animated: true) }  // a screen or a panel: show it
        }
        let nav = UINavigationController(rootViewController: m)
        if let s = nav.sheetPresentationController {
            s.detents = [.medium(), .large()]
            s.prefersGrabberVisible = true
        }
        sheet = m
        present(nav, animated: true)
    }

    // The page's theme, not the phone's: the navigation and tab bars, the status bar and the strip under the title take
    // the page's light / dark and background, so a light page on a dark phone has no dark band above it.
    private func follow(dark: Bool, bg: UIColor?) {
        // the window's, as the controller's alone leaves the bars it draws (title, tab bar, status bar) on the phone's
        view.window?.overrideUserInterfaceStyle = dark ? .dark : .light
        let c = bg.flatMap { $0.cgColor.alpha > 0 ? $0 : nil } ?? Self.pageBackground
        view.backgroundColor = c
        web.backgroundColor = c
        for case let nav as UINavigationController in viewControllers ?? [] { nav.topViewController?.view.backgroundColor = c }
        Slot.background = c
    }

    private func fold() {
        setTabBarHidden(halfFolded, animated: true)
        for case let nav as UINavigationController in viewControllers ?? [] { nav.setNavigationBarHidden(halfFolded, animated: true) }
        web.evaluateJavaScript("window.adashDock?.enable(\(!halfFolded))")
    }

    private func tellFold() {
        web.evaluateJavaScript("window.dsHalfFolded = \(halfFolded); dispatchEvent(new Event('resize'))")
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded = true
        if let h = waiting { waiting = nil; go(h) }
        web.evaluateJavaScript("window.adashDock?.enable(\(!halfFolded))")
        tellFold()
        view.setNeedsLayout()
    }

    private func go(_ hash: String) {
        guard loaded else { waiting = hash; return }  // opened from a widget or a notification: once the page is up
        web.evaluateJavaScript("location.hash = \(jsString(hash))")
    }

    func open(sessionPath: String?) { go(sessionHash(sessionPath)) }

    // agentdash://<screen> (decide, agents, tests) or agentdash://session?path=… from a widget
    func openLink(_ url: URL) {
        guard url.scheme == "agentdash", let host = url.host() else { return }
        if host == "session" {
            open(sessionPath: URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "path" }?.value)
        } else { go(host) }
    }

    fileprivate func received(_ body: Any) {
        switch PageBridge.parse(body) {
        case .icon(let url): setIcon(url)
        case .server(let url): onServer?(url)
        case .dock(let raw): sync(DockBridge.items(raw))
        case .chrome(let dark, let bg): follow(dark: dark, bg: DockBridge.color(bg))
        case nil: break
        }
    }

    // The 앱 아이콘 choice as the home screen icon: one of the icons built into the app (icons/app/<id>/, or the
    // default icons/). A character's face is not built in, so it leaves the icon as it is.
    private func setIcon(_ url: URL) {
        let parts = url.pathComponents
        let name: String?
        if let i = parts.firstIndex(of: "app"), i > 0, parts[i - 1] == "icons", i + 1 < parts.count { name = parts[i + 1] }
        else if parts.suffix(2) == ["icons", "icon-512.png"] { name = nil }
        else { return }
        let app = UIApplication.shared
        guard app.supportsAlternateIcons, app.alternateIconName != name else { return }
        app.setAlternateIconName(name) { err in
            if let err { log.error("icon \(name ?? "default", privacy: .public): \(err, privacy: .public)") }
        }
    }

    // Links out of the page (PRs, Jira) open in Safari; the page's own screens stay here.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.allow) }
        if action.targetFrame?.isMainFrame == true, url.host() != Self.pageURL.host() {
            UIApplication.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith conf: WKWebViewConfiguration, for action: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { UIApplication.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "확인", style: .default) { _ in completionHandler() })
        present(a, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "취소", style: .cancel) { _ in completionHandler(false) })
        a.addAction(UIAlertAction(title: "확인", style: .default) { _ in completionHandler(true) })
        present(a, animated: true)
    }
}

// The content controller holds its handlers strongly: this keeps it from holding the controller.
private final class Relay: NSObject, WKScriptMessageHandler {
    weak var owner: DashboardController?
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) { owner?.received(m.body) }
}

// A tab's page, under its navigation bar (no title; 설정 on its right): holds the web view while its tab is selected.
private final class Slot: UIViewController {
    static var background = DashboardController.pageBackground  // the page's, once it has told it (follow)
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Self.background
        edgesForExtendedLayout = .bottom  // the page starts below the navigation bar; the tab bar floats over its end
    }
}
