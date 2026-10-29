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
