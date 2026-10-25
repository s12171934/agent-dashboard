// Design system fold runtime: sets --fold-off (tokens.css), how far right of the viewport's middle the fold of an
// unfolded foldable falls. Load it with a plain <script> in <head>, next to theme.js.
// - Measured on iPhone Duo (iOS 27, home-screen PWA held sideways, landscape-secondary): the status bar takes the right
//   84px of the 951px screen and is left out of the viewport (innerWidth 867) without a safe-area inset, so the fold
//   (half the long side, 475.5) sits 42px right of the middle. Two panes split there (--fold-cols) keep it in their gap.
// - The long side ignores rotation, unlike outerWidth, which keeps the old orientation's value for a moment; the value
//   is set again 150, 400 and 1000ms after a turn. After a portrait-to-landscape turn the PWA spans all 951px (lost 0).
// - Other orientations and devices get 0: the other landscape was not measured, and a portrait fold runs across.
(() => {
  const root = document.documentElement;
  const set = () => {
    const long = Math.max(outerWidth, outerHeight), lost = long - innerWidth;
    const on = getComputedStyle(root).getPropertyValue('--fold').trim() === '1' && innerWidth > innerHeight && long > 800
      && lost > 0 && lost <= 120 && screen.orientation?.type === 'landscape-secondary';
    root.style.setProperty('--fold-off', on ? lost / 2 + 'px' : '0px');
  };
  const again = () => { set(); [150, 400, 1000].forEach(t => setTimeout(set, t)); };
  addEventListener('resize', again);
  screen.orientation?.addEventListener?.('change', again);
  addEventListener('DOMContentLoaded', again);
})();
