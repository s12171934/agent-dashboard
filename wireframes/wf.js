// Wireframe runtime, the one script a screen file loads (after wf.css).
// - ?posture=book|laptop (the board's half-folded widths) sets <html data-posture>, as
//   design-system/foundations/fold.js does from the device.
// - html.wf-app: on iPhone Duo (cover ≤500px, unfolded or the cover held sideways = the fold condition, half
//   folded) the dashboard is the native app: status bar and bottom tab bar instead of the side rail. Tablet and
//   desktop keep the rail and sidebar. The fold condition is design-system/foundations/tokens.css's, without
//   pointer: coarse (the board's frames run under a mouse).
(() => {
  const root = document.documentElement;
  const p = new URLSearchParams(location.search).get('posture');
  if (p === 'book' || p === 'laptop') root.dataset.posture = p;
  const app = matchMedia('(width <= 500px), ((width > 500px) and (min-aspect-ratio: 5/8) and (max-aspect-ratio: 8/5) and ((width <= 700px) or (height <= 700px)))');
  const set = () => root.classList.toggle('wf-app', !!root.dataset.posture || app.matches);
  set(); app.addEventListener?.('change', set);
})();
