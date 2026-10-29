import Foundation
import Security

// What the iPhone app shares with its widgets: the metric server the page uses (the page's server list, PageBridge).
// The widgets cannot read the app's own defaults. An App Group would need a paid team, but a keychain group under
// the team's prefix is in every team's provisioning profile (TEAM.*), a free Personal Team's too: the address goes
// there. Unsigned (a simulator build) there is no group, and the widgets fall back to this Mac's server.
enum AppGroup {
    // $(AppIdentifierPrefix) from the Info.plist (project.yml), e.g. "ABCDE12345."
    private static var group: String? {
        (Bundle.main.object(forInfoDictionaryKey: "AppIdentifierPrefix") as? String).map { $0 + "com.s-dante.agent-dashboard.shared" }
    }
    private static func query() -> [String: Any] {
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "agent-dashboard",
                                kSecAttrAccount as String: "serverURL"]
        if let group { q[kSecAttrAccessGroup as String] = group }
        return q
    }

    static var serverURL: URL {
        var q = query()
        q[kSecReturnData as String] = true
        var out: AnyObject?
        if SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data,
           let s = String(data: d, encoding: .utf8), let url = URL(string: s) { return url }
        return URL(string: "http://127.0.0.1:8787")!
    }

    static func share(_ url: URL) {
        let data = Data(url.absoluteString.utf8)
        if SecItemUpdate(query() as CFDictionary, [kSecValueData as String: data] as CFDictionary) == errSecItemNotFound {
            var q = query()
            q[kSecValueData as String] = data
            q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock  // the widget reads it on a locked phone
            SecItemAdd(q as CFDictionary, nil)
        }
    }
}
