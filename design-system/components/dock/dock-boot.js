// <ds-dock> placement, run before the first paint: load it with a plain <script> in <head> (ds-dock.js, a module,
// comes later and only adds the settings menu).
// - adash.dock = top | bottom (default) | left | right. A side bar needs room, so a narrow or short screen (a phone
//   held sideways) shows it at the bottom, and a phone (≤500px wide, where the bar is a launcher, or a finger device
//   with either side ≤500px, i.e. held sideways) always does and offers no choice (dockLocked()); <html data-dock> carries the position in effect,
//   not the choice. dockPos() reads the choice.
// - adash.dock.size = button size in px (28–56), set as --dock-pick; a phone's launcher ignores it. dockSize().
// - adash.dock.hidden = '1' when the bar is folded to its one 「바 보이기」 button: <html data-dock-hidden>, except on
//   a phone (≤500px wide), which keeps its launcher, or a half-folded screen (<html data-posture>, fold.js), whose
//   second half is the bar's sheet.
(() => {
  const read = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
  window.dockPos = () => read('adash.dock', 'bottom');
  window.dockSize = () => +read('adash.dock.size', 38);
  window.dockLocked = () => innerWidth <= 500 || matchMedia('(pointer: coarse)').matches && Math.min(innerWidth, innerHeight) <= 500;
  window.applyDock = (choice = dockPos(), size = dockSize()) => {
    const root = document.documentElement;
    root.dataset.dock = dockLocked() || (innerWidth <= 700 || innerHeight <= 500) && (choice === 'left' || choice === 'right') ? 'bottom' : choice;
    root.style.setProperty('--dock-pick', size + 'px');
    root.toggleAttribute('data-dock-hidden', read('adash.dock.hidden', '') === '1' && innerWidth > 500 && !root.dataset.posture);
  };
  addEventListener('resize', () => applyDock());
  addEventListener('ds-posture', () => applyDock());
  applyDock();
})();
