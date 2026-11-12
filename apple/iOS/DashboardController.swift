import UIKit
import UserNotifications
import WebKit

// The page in a web view under the system's own tab bar (UITabBarController: the App Store's bar — Liquid Glass, a
// lens that follows a finger dragged across the tabs, the bar shrinking as the page scrolls down). The page's floating
// bar is hidden (DockBridge) and stands in as:
// - tabs for four screens the person picks (TabScreens: 홈, 에이전트, QA, 프로젝트 until changed), with the page's
//   badges; a tab press takes the page there (pressed again on 홈 or 에이전트, the page fits the office to the screen),
//   and the page moving elsewhere (a link, a notification) moves the selection with it;
// - 더보기, the fifth tab (the system tab bar holds five at most), as the system's More tab: a list of every other
//   screen (ScreenList), a row pushing the page in under 더보기's back button, and 편집 there choosing and ordering
//   the four tabs (TabEditor). The page going to a screen off the tabs selects 더보기 with the page pushed;
// - 설정, the right button of each tab's navigation bar (a bar with no title or background: the page runs to the
//   screen's top under it, only the buttons over it), where the App Store keeps
//   its account button, opening a sheet listing the rest of the bar as the App Store lists its settings: the filters
//   (a check while on), the settings, each pressing the page's own element. A count badge among them shows on its row only: 설정
//   gets no dot. An item the page keeps beside its 설정 (data-fab: 새 에이전트) is a button on 설정's left instead,
//   opening its popover as a sheet of its own (PanelSheet).
// One web view serves every tab: the selected tab's page holds it. The page fills the screen, the side strip of iPhone
// Duo's outer display included (its content keeps to the safe area). Half folded (the hinge, iOS 27.1) the tab bar
// hides and the page lays itself out as on the web — the first half a page, the second its bar's sheet (fold.js,
// dock.css) — told so through window.dsHalfFolded.
final class DashboardController: UITabBarController, UITabBarControllerDelegate, UINavigationControllerDelegate, WKNavigationDelegate, WKUIDelegate {
    static var pageURL: URL {
        URL(string: UserDefaults.standard.string(forKey: "pageURL") ?? "") ?? URL(string: "https://dashboard.s-dante.com/")!
    }

    // (page hash, title, SF Symbol)
    // the page's background (tokens.css --bg), light and dark: under the title and behind the page as it loads
    static let pageBackground = UIColor { $0.userInterfaceStyle == .dark
        ? UIColor(red: 0.06, green: 0.07, blue: 0.08, alpha: 1) : UIColor(red: 0.957, green: 0.961, blue: 0.969, alpha: 1) }

    private static let moreTab = "more"
    private var tabScreens = TabScreens.load()  // the four screens on the tabs
    private weak var screenList: ScreenList?  // 더보기's list, once its tab has been opened
    private var moreShown: String?  // the screen pushed under 더보기, while it is
    private var followed: String?  // the page's screen the selection last followed: a tab pressed on 더보기's list stays

    private var web: WKWebView!
    private var recovery: PageRecovery!
    private let relay = Relay()
    private let pip = PipController()  // 녹화 영상 into Picture in Picture as the app is put away
    private var items: [DockBridge.Item] = []
    private var following = false  // selecting the tab the page went to: not a press
    private weak var sheet: MoreController?
    private var navItems: [UINavigationItem] = []  // each tab's navigation bar: 설정 and the data-fab items
    private var fabKeys: [String] = []
    private var halfFolded = false {
        didSet { if halfFolded != oldValue { tellFold(); fold() } }
    }
    var onServer: ((URL) -> Void)?
    private var loaded = false, waiting: String?
    private var wantedIcon: String??  // the 앱 아이콘 choice not yet on the home screen (.some(nil): the default)
    private var iconBusy = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Self.pageBackground
        NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.switchIcon(); self?.resume() }
        }
        let conf = WKWebViewConfiguration()
        // videos play in the page (playsinline), not in iPhone's own full-screen player: 녹화 영상 keeps its timeline beside
        conf.allowsInlineMediaPlayback = true
        relay.owner = self
        PageBridge.install(on: conf.userContentController, platform: "ios", handler: relay)
        conf.userContentController.addUserScript(WKUserScript(source: Self.facesScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        conf.userContentController.addUserScript(WKUserScript(source: DockBridge.script, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        web = WKWebView(frame: view.bounds, configuration: conf)
        web.isInspectable = true
        web.isOpaque = false
        web.backgroundColor = view.backgroundColor
        web.navigationDelegate = self
        web.uiDelegate = self
        recovery = PageRecovery(web: web, home: Self.pageURL)
        web.allowsBackForwardNavigationGestures = true
        web.translatesAutoresizingMaskIntoConstraints = false

        delegate = self
        makeTabs()
        if #available(iOS 26.0, *) { tabBarMinimizeBehavior = .onScrollDown }
        if #available(iOS 27.1, *) {
            view.addInteraction(UIHingeInteraction { [weak self] _, update in
                self?.halfFolded = update.hinge?.status == .partiallyOpen
            })
        }
        pip.install(in: view)
        pip.page = { [weak self] in self?.web.evaluateJavaScript($0) }
        web.load(URLRequest(url: Self.pageURL))
    }

    // the picked screens' tabs and 더보기 (again after 편집: the controllers are made anew, the page stays where it is)
    private func makeTabs() {
        navItems.removeAll()
        moreShown = nil
        let screens = tabScreens.map { s in
            UITab(title: s.title, image: UIImage(systemName: s.symbol), identifier: s.key) { [weak self] _ in
                let nav = UINavigationController(rootViewController: self?.slot() ?? Slot())
                // no bar of its own: no title, background or line; only its buttons show, over the page
                nav.navigationBar.standardAppearance = Self.clearBar
                nav.navigationBar.scrollEdgeAppearance = Self.clearBar
                return nav
            }
        }
        let more = UITab(title: "더보기", image: UIImage(systemName: "ellipsis"), identifier: Self.moreTab) { [weak self] _ in
            let list = ScreenList()
            list.items = self?.offTabs ?? []
            list.onPick = { [weak self] it in self?.showFromMore(it.key) }
            list.onEdit = { [weak self] in self?.editTabs() }
            self?.screenList = list
            let nav = UINavigationController(rootViewController: list)
            nav.navigationBar.prefersLargeTitles = true
            nav.delegate = self
            return nav
        }
        tabs = screens + [more]
    }

    private static let clearBar: UINavigationBarAppearance = {
        let look = UINavigationBarAppearance()
        look.configureWithTransparentBackground()
        return look
    }()

    // a page under a tab, its navigation bar's buttons 설정 and the data-fab items
    private func slot() -> Slot {
        let slot = Slot()
        navItems.append(slot.navigationItem)
        barButtons(slot.navigationItem)
        return slot
    }

    // the page pushed under 더보기's list: its bar clear (only 더보기's back button and 설정 over the page), as a tab's is
    private func showFromMore(_ key: String) {
        press(key)
        pushUnderMore(key, animated: true)
    }

    private func pushUnderMore(_ key: String, animated: Bool) {
        moreShown = key
        guard let nav = selectedViewController as? UINavigationController, selectedTab?.identifier == Self.moreTab,
              !(nav.topViewController is Slot) else { return }
        let s = slot()
        s.navigationItem.standardAppearance = Self.clearBar
        s.navigationItem.scrollEdgeAppearance = Self.clearBar
        s.navigationItem.largeTitleDisplayMode = .never
        nav.pushViewController(s, animated: animated)
    }

    // the screens 더보기 lists: the page's own (its bar's tabs, data-more ones included) less those on the tabs
    private var allScreens: [DockBridge.Item] { items.filter { $0.key.hasPrefix("#") && !$0.isFab } }
    private var offTabs: [DockBridge.Item] { allScreens.filter { s in !tabScreens.contains { $0.key == s.key } } }

    // 편집 (더보기's list): the four tabs and their order, kept for next time; the tabs are made again
    private func editTabs() {
        let e = TabEditor(tabs: tabScreens, others: offTabs.map(TabScreens.Screen.init))
        e.onDone = { [weak self] picked in
            guard let self, picked != tabScreens else { return }
            tabScreens = picked
            TabScreens.save(picked)
            makeTabs()
            followed = nil
            sync(items)
            hold()
        }
        present(UINavigationController(rootViewController: e), animated: true)
    }

    // 설정: the navigation bar's right button, where the App Store keeps its account button
    // and on its left the page's data-fab items (새 에이전트), each opening its popover as a sheet of its own (PanelSheet)
    private func barButtons(_ nav: UINavigationItem) {
        let settings = UIBarButtonItem(image: UIImage(systemName: "gearshape"), primaryAction: UIAction { [weak self] _ in self?.showMore() })
        settings.accessibilityLabel = "설정: 다른 화면, 필터와 설정"
        let fab = items.filter(\.isFab).map { it in
            let b = UIBarButtonItem(image: UIImage(systemName: DockBridge.symbol(it.icon)), primaryAction: UIAction { [weak self] _ in self?.showPanel(it) })
            b.accessibilityLabel = it.tip
            return b
        }
        for b in [settings] + fab { b.isHidden = halfFolded }  // a tab first opened half folded: the sheet already lists all of it
        nav.rightBarButtonItems = [settings] + fab  // the first is the rightmost
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        hold()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // The page keeps its popovers and its last lines clear of the tab bar: from the bar's top when the bar has a
        // place in the lower half, else (not laid out yet, or iOS 26's floating bar, whose tabBar frame can read as
        // zero) from the page's safe area, which the tab bar is part of
        let bar = tabBar.frame, slot = selectedViewController?.view
        let reach = isTabBarHidden ? 0 : bar.height > 0 && bar.minY > view.bounds.midY ? view.bounds.maxY - bar.minY + 8
            : (slot?.safeAreaInsets.bottom ?? view.safeAreaInsets.bottom) + 8
        web?.evaluateJavaScript("document.documentElement.style.setProperty('--native-bar', '\(Int(reach))px')")
    }

    // The selected tab's page holds the one web view: its whole view, down to the keyboard while one is up, so the
    // page's field and the popover it sits in (fixed to the page's foot) stay above it.
    private var held: [NSLayoutConstraint] = []
    private func hold() {
        guard let slot = (selectedViewController as? UINavigationController)?.topViewController as? Slot, web.superview !== slot.view else { return }
        NSLayoutConstraint.deactivate(held)
        slot.view.addSubview(web)
        held = KeyboardFit.pin(web, in: slot.view)
        slot.setContentScrollView(web.scrollView, for: .bottom)
    }

    func tabBarController(_ c: UITabBarController, shouldSelectTab tab: UITab) -> Bool {
        // the tab already shown pressed again: the page's own tab is pressed again (홈, 에이전트: the office fits the screen)
        // (더보기 pressed again: back to its list, as the system's More tab does)
        if tab === selectedTab && !following {
            if tab.identifier == Self.moreTab { (selectedViewController as? UINavigationController)?.popToRootViewController(animated: true) }
            else { press(tab.identifier) }
            return false
        }
        return true
    }

    func tabBarController(_ c: UITabBarController, didSelectTab tab: UITab, previousTab: UITab?) {
        hold()
        guard !following else { return }
        if tab.identifier != Self.moreTab { press(tab.identifier) }
        else if let key = moreShown, (selectedViewController as? UINavigationController)?.topViewController is Slot { press(key) }  // back to the page left under 더보기
    }

    // 더보기's list shown again (its back button): nothing pushed; the page pushed: it holds the web view
    func navigationController(_ nav: UINavigationController, didShow vc: UIViewController, animated: Bool) {
        if vc is Slot { hold() } else if vc is ScreenList { moreShown = nil }
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
        // 더보기: the sum of its screens' counts, a dot for a badge that is not one
        let off = offTabs.map(\.badge).filter { !$0.isEmpty }
        let sum = off.compactMap { Int($0) }.reduce(0, +)
        tabs.last?.badgeValue = off.isEmpty ? nil : sum > 0 ? String(sum) : ""
        screenList?.items = offTabs
        let fab = new.filter(\.isFab).map(\.key)
        if fab != fabKeys { fabKeys = fab; navItems.forEach(barButtons) }
        // the selection follows the page: its tab, or 더보기 with the page pushed for a screen off the tabs (a session,
        // on no screen, leaves it where it was)
        if let cur = current, cur != followed, !halfFolded {
            followed = cur
            let t = tabs.first { $0.identifier == cur } ?? tabs.last
            let shown = selectedTab?.identifier == cur || selectedTab === t && t === tabs.last && moreShown == cur
            if let t, !shown {
                following = true
                selectedTab = t
                following = false
                if t === tabs.last { pushUnderMore(cur, animated: false) } else { moreShown = nil }
                hold()
            }
        }
        sheet?.items = moreItems
    }

    // 설정: everything on the page's bar but its screens (the tabs and 더보기), by the bar's groups, and the page's reload.
    private var moreItems: [(String, [DockBridge.Item])] {
        var groups: [(String, [DockBridge.Item])] = [("", [])]
        for it in items {
            if let sep = it.sep { groups.append((sep, [])) }
            else if !it.isFab && !it.key.hasPrefix("#") { groups[groups.count - 1].1.append(it) }
        }
        groups[groups.count - 1].1.append(DockBridge.Item(key: "", tip: "새로 고침", icon: "", on: false, badge: "", text: "", sep: nil))
        return groups.filter { !$0.1.isEmpty }
    }

    private func showPanel(_ it: DockBridge.Item) {
        let nav = UINavigationController(rootViewController: PanelSheet(it))
        if let s = nav.sheetPresentationController {
            s.detents = [.medium(), .large()]
            s.selectedDetentIdentifier = .large
            s.prefersGrabberVisible = true
        }
        present(nav, animated: true)
    }

    private func showMore() {
        let m = MoreController()
        m.items = moreItems
        m.onPick = { [weak self, weak m] it in
            guard let self else { return }
            if it.key.isEmpty { loaded = false; recovery.reload(); m?.dismiss(animated: true); return }
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
        // half folded the page is all there is: off 더보기's list (no page in it) onto the first tab, which holds it
        if halfFolded, !((selectedViewController as? UINavigationController)?.topViewController is Slot) {
            following = true
            selectedTab = tabs.first
            following = false
            hold()
        }
        setTabBarHidden(halfFolded, animated: true)
        for case let nav as UINavigationController in viewControllers ?? [] { nav.setNavigationBarHidden(halfFolded, animated: true) }
        // half folded, the page's sheet lists everything 설정 would: no 설정 button, on tabs not opened yet either
        for nav in navItems { nav.rightBarButtonItems?.forEach { $0.isHidden = halfFolded } }
        web.evaluateJavaScript("window.adashDock?.enable(\(!halfFolded))")
    }

    private func tellFold() {
        web.evaluateJavaScript("window.dsHalfFolded = \(halfFolded); dispatchEvent(new Event('resize'))")
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded = true
        recovery.finished()
        if let h = waiting { waiting = nil; go(h) }
        web.evaluateJavaScript("window.adashDock?.enable(\(!halfFolded))")
        tellFold()
        view.setNeedsLayout()
    }

    func resume() { if isViewLoaded { recovery.resume() } }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        loaded = false
        recovery.terminated(active: UIApplication.shared.applicationState == .active)
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
        case .pip(let m): pip.update(m, in: web)
        case nil: break
        }
    }

    // The alternate icons built into the app (tools/make-icons): icons/app/<id>/ as <id>, characters as face-<who>.
    private static let builtInIcons: Set<String> = {
        let icons = Bundle.main.object(forInfoDictionaryKey: "CFBundleIcons") as? [String: Any]
        return Set(((icons?["CFBundleAlternateIcons"] as? [String: Any]) ?? [:]).keys)
    }()
    // the characters the 앱 아이콘 panel may offer (Rust UI): only those built in, a person put up later has none
    static var facesScript: String {
        let faces = builtInIcons.filter { $0.hasPrefix("face-") }.map { "'\($0.dropFirst(5))'" }.sorted()
        return "window.adashFaces = [\(faces.joined(separator: ","))];"
    }

    // The 앱 아이콘 choice as the home screen icon: one of the icons built into the app (icons/app/<id>/, a
    // character's chars/<who>-icon-512.png, or the default icons/). One not built in leaves the icon as it is.
    private func setIcon(_ url: URL) {
        let parts = url.pathComponents
        let name: String?
        if let i = parts.firstIndex(of: "app"), i > 0, parts[i - 1] == "icons", i + 1 < parts.count { name = parts[i + 1] }
        else if parts.suffix(2) == ["icons", "icon-512.png"] { name = nil }
        else if parts.dropLast().last == "chars", url.lastPathComponent.hasSuffix("-icon-512.png") {
            name = "face-" + url.lastPathComponent.dropLast("-icon-512.png".count)
        } else { return }
        if let name, !Self.builtInIcons.contains(name) { return }
        wantedIcon = .some(name)
        switchIcon()
    }

    // iOS turns a switch down while the app is not active or another is under way (the page asks on load, as the app
    // comes up, and again once its DOM is in): one at a time, while active, and again on coming back until it holds.
    private func switchIcon() {
        let app = UIApplication.shared
        guard let name = wantedIcon, !iconBusy, app.applicationState == .active else { return }
        guard app.supportsAlternateIcons, app.alternateIconName != name else { wantedIcon = nil; return }
        iconBusy = true
        app.setAlternateIconName(name) { [weak self] err in
            DispatchQueue.main.async {
                guard let self else { return }
                self.iconBusy = false
                if let err { log.error("icon \(name ?? "default", privacy: .public): \(err, privacy: .public)"); return }  // next time active
                if self.wantedIcon == .some(name) { self.wantedIcon = nil } else { self.switchIcon() }  // chosen again meanwhile
            }
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

// A tab's page, under its navigation bar (only its buttons, on the right): holds the web view while its tab is selected.
private final class Slot: UIViewController {
    static var background = DashboardController.pageBackground  // the page's, once it has told it (follow)
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Self.background
        // the page runs under the navigation bar (to the screen's top, its safe area clear of the buttons) and the tab bar
    }
}
