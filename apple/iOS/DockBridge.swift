import UIKit
import WebKit

// The page's floating bar (<ds-dock>) moved into the app's tab bar and its 설정 sheet (DashboardController). The bar stays
// the page's: the app reads its items (tabs, filters, settings — data-tip, ds-icon name, on, badge) and draws them,
// and a tap presses the page's own element, so every handler, popover and checkbox works as on the bar, and an item
// the page adds shows up here by itself. With the native bar on, the page's bar is hidden and its popovers open as a
// sheet at the bottom, above the native row (--native-bar, set by the app), and its own 설정 button (.dock-fab) is hidden
// too. Items the bar keeps in its 설정 menu (data-more) are read from there.
enum DockBridge {
    static let script = """
    (() => {
      const style = document.createElement('style');
      style.textContent = `html.native-dock :is(ds-dock#dock, .dock-fab) { display: none !important; }
        html.native-dock .dock-pop { left: 8px !important; right: 8px !important; top: auto !important; transform: none !important;
          bottom: max(calc(8px + env(safe-area-inset-bottom)), var(--native-bar, 0px)) !important; max-height: 70vh; overflow: auto; }
        html.native-dock main { padding-bottom: calc(var(--native-bar, 0px) + 12px); }`;
      document.head.appendChild(style);
      const dock = () => document.getElementById('dock');
      // ds-dock.js's own key for an item, so an item is found again after the bar moves it into its 설정 menu
      const keyOf = e => e.dataset.key || e.id || e.querySelector('input')?.id || e.getAttribute('href') || e.dataset.tip;
      const isItem = e => !e.hidden && !e.matches('.dock-cfg, .dock-show, .dock-launch, .dock-head') && (e.matches('ds-theme-toggle') || e.dataset.tip);
      const all = () => [...(dock()?.children || []), ...(document.querySelector('.dock-menu')?.querySelectorAll('[data-tip], ds-theme-toggle, .dock-sep') || [])];
      const items = () => all().map(e => {
        if (e.matches('.dock-sep')) return e.dataset.label ? { sep: e.dataset.label } : null;
        if (!isItem(e)) return null;
        const input = e.querySelector('input[type=checkbox]'), btn = e.matches('ds-theme-toggle') ? e.querySelector('button') : null;
        return { key: keyOf(e) || '', tip: e.dataset.tip || btn?.dataset.tip || btn?.title || btn?.getAttribute('aria-label') || '',
          icon: btn ? 'theme' : e.querySelector('ds-icon')?.getAttribute('name') || '',
          on: e.classList.contains('on') || !!input?.checked || e.getAttribute('aria-pressed') === 'true',
          badge: e.querySelector('b.dn:not([hidden])')?.textContent || '', text: e.querySelector(':scope > span')?.textContent || '',
          toggle: !!input };
      }).filter(Boolean);
      let on = false, timer = 0;
      const send = () => { clearTimeout(timer); timer = setTimeout(() => {
        try { window.webkit.messageHandlers.adash.postMessage({ dock: items() }); } catch (e) {} }, 120); };
      window.adashDock = {
        enable(x) { on = x; document.documentElement.classList.toggle('native-dock', x); if (x) send(); },
        press(key) {
          const e = all().find(x => isItem(x) && keyOf(x) === key);
          if (!e) return;
          (e.querySelector('input[type=checkbox]') || (e.matches('ds-theme-toggle') ? e.querySelector('button') : null) || e).click();
          send();
        },
      };
      const watch = () => {
        const d = dock();
        if (!d) return setTimeout(watch, 300);
        new MutationObserver(() => on && send()).observe(d, { subtree: true, childList: true, attributes: true, characterData: true });
        document.addEventListener('change', () => on && send(), true);
        addEventListener('hashchange', () => on && send());
      };
      watch();
      // the page's light / dark and background (its theme, not the phone's): the bars around the page follow it
      let last = '';
      const chrome = () => {
        const c = { theme: document.documentElement.dataset.theme || '', bg: document.body ? getComputedStyle(document.body).backgroundColor : '' };
        const k = c.theme + c.bg;
        if (k === last) return;
        last = k;
        try { window.webkit.messageHandlers.adash.postMessage({ chrome: c }); } catch (e) {}
      };
      new MutationObserver(chrome).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] });
      chrome();
    })();
    """

    struct Item {
        let key: String, tip: String, icon: String, on: Bool, badge: String, text: String
        let sep: String?
        var isToggle = false  // a checkbox (a filter, a mode): pressing flips it
        // the name without the page's extra words ("결정 대기: 에이전트가…", "홈 · 내 차례 1")
        var name: String { String(tip.split(separator: ":")[0].split(separator: "·")[0]).trimmingCharacters(in: .whitespaces) }
    }

    static func items(_ raw: [[String: Any]]) -> [Item] {
        raw.map { d in
            Item(key: d["key"] as? String ?? "", tip: d["tip"] as? String ?? "", icon: d["icon"] as? String ?? "",
                 on: d["on"] as? Bool ?? false, badge: d["badge"] as? String ?? "", text: d["text"] as? String ?? "",
                 sep: d["sep"] as? String, isToggle: d["toggle"] as? Bool ?? false)
        }
    }

    // a CSS colour as getComputedStyle gives it ("rgb(244, 245, 247)", "rgba(…)"); anything else: nil
    static func color(_ css: String) -> UIColor? {
        let n = css.split { !"0123456789.".contains($0) }.compactMap { Double($0) }
        guard css.hasPrefix("rgb"), n.count >= 3 else { return nil }
        return UIColor(red: n[0] / 255, green: n[1] / 255, blue: n[2] / 255, alpha: n.count > 3 ? n[3] : 1)
    }

    // ds-icon names (design-system/components/icon) as SF Symbols.
    static func symbol(_ icon: String) -> String {
        ["home": "house", "users": "person.2", "chart": "chart.bar", "chat": "bubble.left.and.bubble.right",
         "flow": "point.3.connected.trianglepath.dotted", "book": "book", "layers": "square.3.layers.3d",
         "branch": "arrow.triangle.branch", "help": "questionmark.bubble", "zap": "bolt", "flask": "flask",
         "plus": "plus", "pulse": "waveform.path.ecg", "terminal": "terminal", "gauge": "gauge.with.needle",
         "mail": "envelope", "smile": "face.smiling", "image": "photo", "server": "server.rack",
         "palette": "paintpalette", "shapes": "square.on.circle", "grid": "square.grid.2x2",
         "theme": "circle.lefthalf.filled", "settings": "gearshape"][icon] ?? "circle"
    }
}
