// Design system fold runtime: sets --fold-off (tokens.css), how far right of the viewport's middle the fold of an
// unfolded foldable falls. Load it with a plain <script> in <head>, next to theme.js.
// - Measured on iPhone Duo (iOS 27, home-screen PWA held sideways, landscape-secondary): the status bar takes the right
//   84px of the 951px screen and is left out of the viewport (innerWidth 867) without a safe-area inset, so the fold
//   (half the long side, 475.5) sits 42px right of the middle. Two panes split there (--fold-cols) keep it in their gap.
// - The long side ignores rotation, unlike outerWidth, which keeps the old orientation's value for a moment; the value
//   is set again 150, 400 and 1000ms after a turn. After a portrait-to-landscape turn the PWA spans all 951px (lost 0).
// - Other orientations and devices get 0: the other landscape was not measured, and a portrait fold runs across.
// Also sets <html data-posture> while the fold layout's screen is half folded (the browser reports
// device-posture: folded): "book" held sideways (the fold runs down: left and right halves), "laptop" upright (the
// fold runs across: top and bottom halves). The first half is then a page like the cover screen and the second the
// dock's sheet (dock.css, ds-dock.js); a change fires ds-posture on window. Opened flat or closed, no attribute.
// - A native shell can say instead (window.dsHalfFolded = true | false, then a resize event): WKWebView does not report
//   device-posture, so the iPhone app (apple/) reads the hinge (UIHingeInteraction) and passes it here.
(() => {
  const root = document.documentElement;
  const HALF = matchMedia('(device-posture: folded)');
  const set = () => {
    const fold = getComputedStyle(root).getPropertyValue('--fold').trim() === '1';
    const long = Math.max(outerWidth, outerHeight), lost = long - innerWidth;
    const on = fold && innerWidth > innerHeight && long > 800
      && lost > 0 && lost <= 120 && screen.orientation?.type === 'landscape-secondary';
    root.style.setProperty('--fold-off', on ? lost / 2 + 'px' : '0px');
    const posture = fold && (window.dsHalfFolded ?? HALF.matches) ? (innerWidth > innerHeight ? 'book' : 'laptop') : '';
    if (posture === (root.dataset.posture || '')) return;
    if (posture) root.dataset.posture = posture; else delete root.dataset.posture;
    dispatchEvent(new Event('ds-posture'));
  };
  const again = () => { set(); [150, 400, 1000].forEach(t => setTimeout(set, t)); };
  addEventListener('resize', again);
  screen.orientation?.addEventListener?.('change', again);
  HALF.addEventListener?.('change', again);
  addEventListener('DOMContentLoaded', again);
})();
