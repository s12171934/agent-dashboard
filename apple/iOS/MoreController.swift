import UIKit

// 설정: the page's bar beyond the tabs, laid out as the App Store lays out its settings — grouped rows, an icon, the
// name, the badge on the right, a check on the screen shown and on each filter or mode that is on.
final class MoreController: UITableViewController {
    var items: [(String, [DockBridge.Item])] = [] { didSet { if isViewLoaded { tableView.reloadData() } } }
    var onPick: ((DockBridge.Item) -> Void)?

    init() { super.init(style: .insetGrouped) }
    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "설정"
        navigationItem.rightBarButtonItem = UIBarButtonItem(systemItem: .close, primaryAction: UIAction { [weak self] _ in
            self?.dismiss(animated: true)
        })
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "row")
    }

    override func numberOfSections(in tableView: UITableView) -> Int { items.count }
    override func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? { items[section].0 }
    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { items[section].1.count }

    override func tableView(_ tableView: UITableView, cellForRowAt ip: IndexPath) -> UITableViewCell {
        let it = items[ip.section].1[ip.row]
        let cell = tableView.dequeueReusableCell(withIdentifier: "row", for: ip)
        var c = UIListContentConfiguration.valueCell()
        c.text = it.key.isEmpty ? it.tip : it.name.isEmpty ? it.text : it.name
        c.secondaryText = it.badge.isEmpty ? nil : it.badge
        c.image = UIImage(systemName: it.key.isEmpty ? "arrow.clockwise" : it.icon.isEmpty ? "circle" : DockBridge.symbol(it.icon))
        c.imageProperties.tintColor = .tintColor
        cell.contentConfiguration = c
        cell.accessoryType = it.on && (it.isToggle || it.key.hasPrefix("#")) ? .checkmark : .none
        return cell
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt ip: IndexPath) {
        tableView.deselectRow(at: ip, animated: true)
        onPick?(items[ip.section].1[ip.row])
    }
}

// The four screens on the tabs (DashboardController), as the person ordered them in 편집; 홈, 에이전트, QA, 프로젝트 until then.
// Kept with their names and symbols, so the tabs are drawn before the page has told its bar.
enum TabScreens {
    struct Screen: Codable, Equatable {
        let key, title, symbol: String
        init(key: String, title: String, symbol: String) { self.key = key; self.title = title; self.symbol = symbol }
        init(_ it: DockBridge.Item) { self.init(key: it.key, title: it.name, symbol: DockBridge.symbol(it.icon)) }
    }
    static let count = 4
    private static let defaultsKey = "tabScreens"
    static let standard = [Screen(key: "#home", title: "홈", symbol: "house"), Screen(key: "#agents", title: "에이전트", symbol: "person.2"),
                           Screen(key: "#worktrees", title: "QA", symbol: "square.3.layers.3d"),
                           Screen(key: "#projects", title: "프로젝트", symbol: "point.3.connected.trianglepath.dotted")]
    static func load() -> [Screen] {
        guard let d = UserDefaults.standard.data(forKey: defaultsKey), let s = try? JSONDecoder().decode([Screen].self, from: d), !s.isEmpty
        else { return standard }
        return Array(s.prefix(count))
    }
    static func save(_ s: [Screen]) { UserDefaults.standard.set(try? JSONEncoder().encode(s), forKey: defaultsKey) }
}

// 더보기 (the fifth tab): every screen not on the tabs, as the system's More tab lists them — an icon, the name, the
// count on the right; a row takes the page there, pushed in under this list. 편집 picks the four tabs (TabEditor).
final class ScreenList: UITableViewController {
    var items: [DockBridge.Item] = [] { didSet { if isViewLoaded { tableView.reloadData() } } }
    var onPick: ((DockBridge.Item) -> Void)?
    var onEdit: (() -> Void)?

    init() { super.init(style: .insetGrouped) }
    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "더보기"
        navigationItem.largeTitleDisplayMode = .always
        navigationItem.rightBarButtonItem = UIBarButtonItem(title: "편집", primaryAction: UIAction { [weak self] _ in self?.onEdit?() })
        navigationItem.rightBarButtonItem?.accessibilityLabel = "탭 편집: 탭에 둘 화면 네 개와 순서"
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "row")
    }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { items.count }

    override func tableView(_ tableView: UITableView, cellForRowAt ip: IndexPath) -> UITableViewCell {
        let it = items[ip.row]
        let cell = tableView.dequeueReusableCell(withIdentifier: "row", for: ip)
        var c = UIListContentConfiguration.valueCell()
        c.text = it.name
        c.secondaryText = it.badge.isEmpty ? nil : it.badge
        c.image = UIImage(systemName: DockBridge.symbol(it.icon))
        c.imageProperties.tintColor = .tintColor
        cell.contentConfiguration = c
        cell.accessoryType = .disclosureIndicator
        return cell
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt ip: IndexPath) {
        tableView.deselectRow(at: ip, animated: true)
        onPick?(items[ip.row])
    }
}

// 편집 (더보기's list): the tabs above, in their order (drag to reorder, − to put one in 더보기), the other screens below
// (+ to put one on the tabs: with four there already, the last tab goes to 더보기). At least one tab stays.
final class TabEditor: UITableViewController {
    private var tabs: [TabScreens.Screen], others: [TabScreens.Screen]
    var onDone: (([TabScreens.Screen]) -> Void)?

    init(tabs: [TabScreens.Screen], others: [TabScreens.Screen]) {
        self.tabs = tabs
        self.others = others
        super.init(style: .insetGrouped)
    }
    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "탭 편집"
        navigationItem.leftBarButtonItem = UIBarButtonItem(systemItem: .cancel, primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) })
        navigationItem.rightBarButtonItem = UIBarButtonItem(systemItem: .done, primaryAction: UIAction { [weak self] _ in
            guard let self else { return }
            dismiss(animated: true)
            onDone?(tabs)
        })
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "row")
        tableView.isEditing = true
    }

    override func numberOfSections(in tableView: UITableView) -> Int { 2 }
    override func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? {
        section == 0 ? "탭 (\(tabs.count)/\(TabScreens.count))" : "더보기"
    }
    override func tableView(_ tableView: UITableView, titleForFooterInSection section: Int) -> String? {
        section == 0 ? "끌어서 순서를 바꿉니다. 다섯 번째 자리는 더보기입니다." : nil
    }
    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { section == 0 ? tabs.count : others.count }

    override func tableView(_ tableView: UITableView, cellForRowAt ip: IndexPath) -> UITableViewCell {
        let s = ip.section == 0 ? tabs[ip.row] : others[ip.row]
        let cell = tableView.dequeueReusableCell(withIdentifier: "row", for: ip)
        var c = UIListContentConfiguration.cell()
        c.text = s.title
        c.image = UIImage(systemName: s.symbol)
        c.imageProperties.tintColor = .tintColor
        cell.contentConfiguration = c
        return cell
    }

    override func tableView(_ tableView: UITableView, editingStyleForRowAt ip: IndexPath) -> UITableViewCell.EditingStyle {
        ip.section == 0 ? (tabs.count > 1 ? .delete : .none) : .insert
    }
    override func tableView(_ tableView: UITableView, titleForDeleteConfirmationButtonForRowAt ip: IndexPath) -> String? { "더보기로" }
    override func tableView(_ tableView: UITableView, shouldIndentWhileEditingRowAt ip: IndexPath) -> Bool { true }

    override func tableView(_ tableView: UITableView, commit style: UITableViewCell.EditingStyle, forRowAt ip: IndexPath) {
        if style == .delete {
            others.insert(tabs.remove(at: ip.row), at: 0)
        } else {
            let pick = others.remove(at: ip.row)
            if tabs.count >= TabScreens.count { others.insert(tabs.removeLast(), at: 0) }
            tabs.append(pick)
        }
        tableView.reloadSections(IndexSet(0...1), with: .automatic)
    }

    // reordering only among the tabs
    override func tableView(_ tableView: UITableView, canMoveRowAt ip: IndexPath) -> Bool { ip.section == 0 }
    override func tableView(_ tableView: UITableView, targetIndexPathForMoveFromRowAt from: IndexPath, toProposedIndexPath to: IndexPath) -> IndexPath {
        to.section == 0 ? to : IndexPath(row: tabs.count - 1, section: 0)
    }
    override func tableView(_ tableView: UITableView, moveRowAt from: IndexPath, to: IndexPath) {
        tabs.insert(tabs.remove(at: from.row), at: to.row)
    }
}
