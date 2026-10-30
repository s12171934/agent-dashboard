import UIKit
import WebKit

// An item the page keeps beside its 설정 (data-fab: 새 에이전트) opened as a sheet of its own, as 설정 is: a second web
// view loads the page, presses that item and shows only the popover it opens, its title and 닫기 moved into the sheet's
// navigation bar, on the system's sheet as 설정's (the page's background left out). The popover closing (닫기, or the
// page done with it: an agent launched) closes the sheet. The two web views share the app's website data, so the page
// here has the same servers, theme and choices.
final class PanelSheet: UIViewController, WKScriptMessageHandler {
    private let item: DockBridge.Item
    private var web: WKWebView!

    init(_ item: DockBridge.Item) {
        self.item = item
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError() }

    // the page as the sheet shows it: the item pressed, everything but the popover it opened hidden
    private static func script(_ key: String) -> String { """
    (() => {
      const style = document.createElement('style');
      style.textContent = `html.native-sheet body > :not(.sheet-pop) { display: none !important; }
        html.native-sheet, html.native-sheet body { background: none !important; }
        html.native-sheet .sheet-pop { position: static !important; inset: auto !important; transform: none !important;
          width: auto !important; max-width: none !important; max-height: none !important; margin: 0 !important;
          border: 0 !important; border-radius: 0 !important; box-shadow: none !important; background: none !important;
          -webkit-backdrop-filter: none !important; backdrop-filter: none !important;
          padding-bottom: calc(16px + env(safe-area-inset-bottom)) !important; }
        html.native-sheet .sheet-pop > .pop-h { display: none !important; }`;
      document.head.appendChild(style);
      document.documentElement.classList.add('native-sheet');
      const close = () => { try { window.webkit.messageHandlers.sheet.postMessage('close'); } catch (e) {} };
      const keyOf = e => e.dataset.key || e.id || e.querySelector('input')?.id || e.getAttribute('href') || e.dataset.tip;
      // ds-dock.js (a module) moves the item beside 설정 once it runs: wait for that, then press it
      const go = () => {
        const el = [...document.querySelectorAll('.dock-fab > *')].find(e => keyOf(e) === \(jsString(key)));
        if (!el) return setTimeout(go, 100);
        const shut = [...document.querySelectorAll('.dock-pop')].filter(p => p.hidden);
        el.click();
        const pop = shut.find(p => !p.hidden);
        if (!pop) return close();
        pop.classList.add('sheet-pop');
        new MutationObserver(() => { if (pop.hidden) close(); }).observe(pop, { attributes: true, attributeFilter: ['hidden'] });
      };
      go();
    })();
    """ }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = item.name
        navigationItem.rightBarButtonItem = UIBarButtonItem(systemItem: .close, primaryAction: UIAction { [weak self] _ in
            self?.dismiss(animated: true)
        })
        let conf = WKWebViewConfiguration()
        conf.userContentController.add(WeakHandler(self), name: "sheet")
        conf.userContentController.addUserScript(WKUserScript(source: "window.adashApp = 'ios';", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        conf.userContentController.addUserScript(WKUserScript(source: Self.script(item.key), injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        web = WKWebView(frame: view.bounds, configuration: conf)
        web.isOpaque = false
        web.backgroundColor = .clear
        web.scrollView.backgroundColor = .clear
        // below the sheet's navigation bar (the page lays itself out under the safe area, viewport-fit=cover), down to
        // the sheet's foot or the keyboard
        web.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(web)
        KeyboardFit.pin(web, in: view, top: view.safeAreaLayoutGuide.topAnchor)
        web.load(URLRequest(url: DashboardController.pageURL))
    }

    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        if m.body as? String == "close", presentingViewController != nil { dismiss(animated: true) }
    }
}

// WKUserContentController keeps its handlers: this one holds the sheet weakly, so closing it frees it.
private final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var owner: WKScriptMessageHandler?
    init(_ owner: WKScriptMessageHandler) { self.owner = owner }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) { owner?.userContentController(c, didReceive: m) }
}

// A web view filling its view down to the keyboard while one is up (to the view's foot otherwise): WKWebView alone
// only scrolls, so a field in an element fixed to the page's foot (a popover, a sheet) would stay under the keyboard.
enum KeyboardFit {
    @discardableResult
    static func pin(_ web: UIView, in view: UIView, top: NSLayoutYAxisAnchor? = nil) -> [NSLayoutConstraint] {
        view.keyboardLayoutGuide.usesBottomSafeArea = false
        let cs = [web.topAnchor.constraint(equalTo: top ?? view.topAnchor),
                  web.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
                  web.leadingAnchor.constraint(equalTo: view.leadingAnchor),
                  web.trailingAnchor.constraint(equalTo: view.trailingAnchor)]
        NSLayoutConstraint.activate(cs)
        return cs
    }
}
