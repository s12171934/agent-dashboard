import Foundation
import UserNotifications
import os

let log = Logger(subsystem: "com.s-dante.agent-dashboard", category: "app")

// A notification per new 결정 대기 question. When one click can answer it (one question, one choice) its options are
// buttons that put the answer into the session's terminal; otherwise, or on a plain click, the question's session
// opens. Answered questions' notifications are taken back.
@MainActor
final class DecisionNotifier: NSObject, UNUserNotificationCenterDelegate {
    private let watcher: DecisionWatcher
    private let center = UNUserNotificationCenter.current()
    private var categories: [String: UNNotificationCategory] = [:]  // question id -> its answer buttons
    var onOpen: ((String?) -> Void)?  // a session's path, or nil for the questions list

    init(watcher: DecisionWatcher) {
        self.watcher = watcher
        super.init()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound, .badge]) { ok, err in
            log.info("notifications allowed: \(ok), \(String(describing: err), privacy: .public)")
        }
    }

    func notify(_ q: DecisionWatcher.Pending) {
        let c = UNMutableNotificationContent()
        c.title = "결정 대기 · " + String(watcher.title(of: q).prefix(40))
        let first = q.questions.first
        c.body = [first?.header, first?.question].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: " · ")
            + (q.questions.count > 1 ? " 외 \(q.questions.count - 1)건" : "")
        c.sound = .default
        if q.questions.count == 1, let only = first, only.multiSelect != true {
            let actions = only.options.enumerated().map { i, o in
                UNNotificationAction(identifier: "opt\(i)", title: o.label, options: [])
            }
            categories[q.id] = UNNotificationCategory(identifier: q.id, actions: actions, intentIdentifiers: [])
            center.setNotificationCategories(Set(categories.values))
            c.categoryIdentifier = q.id
        }
        center.add(UNNotificationRequest(identifier: q.id, content: c, trigger: nil)) { err in
            if let err { log.error("notification \(q.id, privacy: .public): \(err, privacy: .public)") }
        }
    }

    func gone(_ ids: [String]) {
        center.removeDeliveredNotifications(withIdentifiers: ids)
        for id in ids { categories.removeValue(forKey: id) }
        center.setNotificationCategories(Set(categories.values))
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent n: UNNotification,
                                            withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner, .sound, .list])
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive r: UNNotificationResponse,
                                            withCompletionHandler done: @escaping () -> Void) {
        let id = r.notification.request.identifier, action = r.actionIdentifier
        Task { @MainActor in
            defer { done() }
            if action.hasPrefix("opt"), let i = Int(action.dropFirst(3)),
               let q = watcher.pending.first(where: { $0.id == id }), let o = q.questions.first?.options[safe: i] {
                if let err = await watcher.answer(id, [o.label]) { failed(err, id) }
            } else if action != UNNotificationDismissActionIdentifier {
                onOpen?(watcher.sessionPath(of: id))
            }
        }
    }

    private func failed(_ err: String, _ id: String) {
        let c = UNMutableNotificationContent()
        c.title = "답을 넣지 못했습니다"
        c.body = err
        center.add(UNNotificationRequest(identifier: id + "-err", content: c, trigger: nil))
    }
}

extension Array {
    subscript(safe i: Int) -> Element? { indices.contains(i) ? self[i] : nil }
}

// The hash the page's own notification opened: a session's page, or the agents list.
func sessionHash(_ path: String?) -> String {
    path.map { "s=" + ($0.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? $0) } ?? "agents"
}

func jsString(_ s: String) -> String {
    let data = try! JSONSerialization.data(withJSONObject: [s])
    return String(String(data: data, encoding: .utf8)!.dropFirst().dropLast())
}
