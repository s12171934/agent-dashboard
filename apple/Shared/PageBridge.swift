import Foundation
import WebKit

// What the app adds to the dashboard page, on both platforms, and what the page tells the app back.
// - window.adashApp ('macos' | 'ios'): the page words its 앱 아이콘 help for the app it runs in.
// - Notification off: the app posts its own notifications (DecisionNotifier), which also work with the page closed.
// - adash messages: {icon: url} from icon-boot.js (the 앱 아이콘 choice), {servers: json} from here (the page's server
//   list, so the app watches the server the page uses), {dock: [items]} and {chrome: {theme, bg}} (the page's light /
//   dark and background colour, which the bars around it follow) from the iPhone app's DockBridge, and {pip: {src, t,
//   playing, rate, rect}} from the 녹화 영상 player (web-ui/src/runtime.js videoBridge), which the iPhone app's PipController mirrors so the
//   video goes on in Picture in Picture when the app is put away.
enum PageBridge {
    static func install(on c: WKUserContentController, platform: String, handler: WKScriptMessageHandler) {
        c.add(handler, name: "adash")
        c.addUserScript(WKUserScript(source: """
            window.adashApp = '\(platform)';
            try { Object.defineProperty(window, 'Notification', { value: undefined }); } catch (e) {}
            """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        c.addUserScript(WKUserScript(source: """
            (() => { const send = () => { try { window.webkit.messageHandlers.adash.postMessage({ servers: localStorage.getItem('adash.servers') || '' }); } catch (e) {} };
              send(); setInterval(send, 30000); document.addEventListener('visibilitychange', send); })();
            """, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
    }

    // New pages refresh their streams and state directly. An older deployment still gets its existing focus /
    // online hooks, without forcing a reload that could discard an unfinished form.
    static let resumeScript = """
        if (window.adashNative?.resume) window.adashNative.resume();
        else {
            dispatchEvent(new Event('online'));
            dispatchEvent(new Event('focus'));
            if (typeof pump === 'function') pump(true);
        }
        """

    enum Message { case icon(URL), server(URL), dock([[String: Any]]), chrome(dark: Bool, bg: String), pip([String: Any]) }

    static func parse(_ body: Any) -> Message? {
        guard let m = body as? [String: Any] else { return nil }
        if let s = m["icon"] as? String, let url = URL(string: s) { return .icon(url) }
        if let s = m["servers"] as? String { return firstServer(s).map(Message.server) }
        if let d = m["dock"] as? [[String: Any]] { return .dock(d) }
        if let p = m["pip"] as? [String: Any] { return .pip(p) }
        if let c = m["chrome"] as? [String: Any] { return .chrome(dark: c["theme"] as? String == "dark", bg: c["bg"] as? String ?? "") }
        return nil
    }

    // The first server the page has turned on ([{id, name, url, on}], api.js); none: keep what the app has.
    private static func firstServer(_ json: String) -> URL? {
        guard let data = json.data(using: .utf8),
              let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return nil }
        return list.first { $0["on"] as? Bool != false }.flatMap { ($0["url"] as? String).flatMap(URL.init(string:)) }
    }
}
