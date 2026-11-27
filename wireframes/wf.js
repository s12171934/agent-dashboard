// Wireframe runtime, the one script a screen file loads (after wf.css).
// - ?posture=book|laptop (the board's half-folded widths) sets <html data-posture>, as
//   design-system/foundations/fold.js does from the device.
// - html.wf-app: on iPhone Duo (cover ≤500px, unfolded or the cover held sideways = the fold condition, half
//   folded; an ordinary iPhone is the phone stage too) the dashboard is the native app: status bar and the
//   system's sidebar instead of the web's side rail. Tablet and
//   desktop keep the rail and sidebar. The fold condition is design-system/foundations/tokens.css's, without
//   pointer: coarse (the board's frames run under a mouse).
(() => {
  const root = document.documentElement;
  const p = new URLSearchParams(location.search).get('posture');
  if (p === 'book' || p === 'laptop') root.dataset.posture = p;
  const app = matchMedia('(width <= 500px), ((width > 500px) and (min-aspect-ratio: 5/8) and (max-aspect-ratio: 8/5) and ((width <= 700px) or (height <= 700px)))');
  const set = () => root.classList.toggle('wf-app', !!root.dataset.posture || app.matches);
  set(); app.addEventListener?.('change', set);
  // the phone stage's sidebar opens over the page: a toggle at the top left and a scrim that closes it (wf.css);
  // ?side=open shows it open from the start
  if (new URLSearchParams(location.search).get('side') === 'open') root.classList.add('wf-side-open');
  addEventListener('DOMContentLoaded', () => {
    if (!document.querySelector('.wf-side')) return;
    const t = Object.assign(document.createElement('button'), { type: 'button', className: 'wf-sidetoggle', textContent: '◧\ufe0e', title: '사이드바' });
    t.setAttribute('aria-label', '사이드바');
    const scrim = Object.assign(document.createElement('div'), { className: 'wf-scrim' });
    t.onclick = () => root.classList.toggle('wf-side-open');
    scrim.onclick = () => root.classList.remove('wf-side-open');
    document.body.append(t, scrim);
  });
})();
