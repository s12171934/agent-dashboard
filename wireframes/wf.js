// Wireframe runtime, the one script a screen file loads (after wf.css): the board opens a half-folded width with
// ?posture=book|laptop, and this sets <html data-posture> from it, as design-system/foundations/fold.js does from
// the device. Nothing else.
(() => {
  const p = new URLSearchParams(location.search).get('posture');
  if (p === 'book' || p === 'laptop') document.documentElement.dataset.posture = p;
})();
