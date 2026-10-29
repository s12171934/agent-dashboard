import AppKit

// The app: dashboard windows and tabs, a menu bar item and the Dock badge for 결정 대기, and a notification per new
// question whose buttons answer it when it is a single single-choice question.
@main @MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var windows: [DashboardWindow] = []
    private let local = LocalPage(site: DashboardWindow.pageURL)
    private var home = DashboardWindow.pageURL
    private let watcher = DecisionWatcher()
    private var item: NSStatusItem!
    private var notifier: DecisionNotifier!

    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.run()
    }

    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.mainMenu = mainMenu()
        if let data = UserDefaults.standard.data(forKey: "iconPNG"), let img = NSImage(data: data) {
            NSApp.applicationIconImage = macIcon(img)
        }
        do { try local.start(); home = LocalPage.url } catch { log.error("LocalPage: \(error)") }  // else the site, local servers unreachable
        newWindow()

        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.menu = NSMenu()
        item.menu!.delegate = self

        notifier = DecisionNotifier(watcher: watcher)
        notifier.onOpen = { [weak self] in self?.front().open(sessionPath: $0) }

        watcher.onChange = { [weak self] in self?.update() }
        watcher.onNew = { [weak self] in self?.notifier.notify($0) }
        watcher.onGone = { [weak self] in self?.notifier.gone($0) }
        update()
        watcher.start()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ app: NSApplication, hasVisibleWindows: Bool) -> Bool {
        front().show()
        return true
    }

    // MARK: windows and tabs

    @discardableResult
    private func make(_ url: URL? = nil) -> DashboardWindow {
        let d = DashboardWindow(home: home, url: url, first: windows.isEmpty)
        d.onClose = { [weak self] gone in self?.windows.removeAll { $0 === gone } }
        d.onNewTab = { [weak self] in self?.newTab(url: $0) }
        d.onIcon = { [weak self] in self?.setIcon($0) }
        d.onServer = { [weak self] in self?.watcher.use($0) }
        windows.append(d)
        return d
    }

    // The window in front, or a new one when every window is closed.
    private func front() -> DashboardWindow {
        windows.first { $0.window.isKeyWindow } ?? windows.first { $0.window.isMainWindow } ?? windows.last ?? make()
    }

    @objc private func newWindow() { make().show() }

    @objc private func newTab(_ sender: Any? = nil) { newTab(url: nil) }

    private func newTab(url: URL?) {
        guard let host = windows.first(where: { $0.window.isKeyWindow || $0.window.isMainWindow }) ?? windows.last else {
            return make(url).show()
        }
        let d = make(url)
        host.window.addTabbedWindow(d.window, ordered: .above)
        d.show()
    }

    // The page's 앱 아이콘 choice on the Dock icon, kept for the next launch. The bundle's own icon (Finder, the Dock
    // while the app is not running) stays the default: changing it would break the app's signature.
    private var iconURL = UserDefaults.standard.string(forKey: "iconURL")

    private func setIcon(_ url: URL) {
        let key = url.path()  // the host is LocalPage's port or the site: the same picture either way
        guard key != iconURL else { return }
        iconURL = key
        Task {
            guard let (data, res) = try? await URLSession.shared.data(from: url),
                  (res as? HTTPURLResponse)?.statusCode == 200, let img = NSImage(data: data) else { return }
            NSApp.applicationIconImage = macIcon(img)
            UserDefaults.standard.set(data, forKey: "iconPNG")
            UserDefaults.standard.set(key, forKey: "iconURL")
        }
    }

    // The tab bar's + button.
    @objc func newWindowForTab(_ sender: Any?) { newTab(url: nil) }

    // MARK: menu bar and Dock

    private func update() {
        let n = watcher.pending.count
        NSApp.dockTile.badgeLabel = n > 0 ? String(n) : nil
        guard let button = item.button else { return }
        button.image = NSImage(systemSymbolName: n > 0 ? "questionmark.bubble.fill" : "rectangle.3.group",
                               accessibilityDescription: "Agent Dashboard")
        button.title = n > 0 ? " \(n)" : ""
        if case .down = watcher.link { button.appearsDisabled = true } else { button.appearsDisabled = false }
    }

    // Built when it opens, so it always shows the current questions.
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        switch watcher.link {
        case .unknown: menu.addItem(withTitle: "서버 확인 중…", action: nil, keyEquivalent: "")
        case .connected: menu.addItem(withTitle: "서버 연결됨 · \(DecisionWatcher.serverURL.absoluteString)", action: nil, keyEquivalent: "")
        case .down(let why): menu.addItem(withTitle: "서버 끊김 · \(why)", action: nil, keyEquivalent: "")
        }
        menu.addItem(.separator())
        if watcher.pending.isEmpty {
            menu.addItem(withTitle: "결정 대기 없음", action: nil, keyEquivalent: "")
        }
        for q in watcher.pending {
            let first = q.questions.first
            let it = NSMenuItem(title: "\(watcher.title(of: q)) — \(first?.header ?? first?.question ?? "")",
                                action: #selector(openQuestion(_:)), keyEquivalent: "")
            it.target = self
            it.representedObject = q.id
            menu.addItem(it)
        }
        menu.addItem(.separator())
        menu.addItem(withTitle: "대시보드 열기", action: #selector(openDashboard), keyEquivalent: "o").target = self
        menu.addItem(withTitle: "새로 고침", action: #selector(reloadAll), keyEquivalent: "r").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "종료", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    }

    @objc private func openQuestion(_ sender: NSMenuItem) {
        front().open(sessionPath: (sender.representedObject as? String).flatMap(watcher.sessionPath(of:)))
    }

    @objc private func openDashboard() { front().show() }

    @objc private func reloadAll() {
        front().reload()
        Task { await watcher.refresh() }
    }

    private func mainMenu() -> NSMenu {
        let menu = NSMenu()
        let app = NSMenu()
        app.addItem(withTitle: "Agent Dashboard 숨기기", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(withTitle: "종료", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let file = NSMenu(title: "파일")
        file.addItem(withTitle: "새 탭", action: #selector(newTab(_:)), keyEquivalent: "t").target = self
        file.addItem(withTitle: "새 윈도우", action: #selector(newWindow), keyEquivalent: "n").target = self
        file.addItem(.separator())
        file.addItem(withTitle: "닫기", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        let edit = NSMenu(title: "편집")  // so ⌘C·⌘V·⌘A reach the page's inputs
        edit.addItem(withTitle: "실행 취소", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "잘라내기", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "복사", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "붙여넣기", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "전체 선택", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        let view = NSMenu(title: "보기")
        view.addItem(withTitle: "새로 고침", action: #selector(reloadAll), keyEquivalent: "r").target = self
        let window = NSMenu(title: "윈도우")
        window.addItem(withTitle: "최소화", action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m")
        for sub in [app, file, edit, view, window] {
            let it = NSMenuItem(title: sub.title, action: nil, keyEquivalent: "")
            it.submenu = sub
            menu.addItem(it)
        }
        NSApp.windowsMenu = window
        return menu
    }
}
