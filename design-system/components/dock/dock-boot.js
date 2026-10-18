// <ds-dock> placement, run before the first paint: load it with a plain <script> in <head> (ds-dock.js, a module,
// comes later and only adds the settings menu).
// - adash.dock = top | bottom (default) | left | right. A side bar needs room, so a narrow or short screen (a phone
//   held sideways) shows it at the bottom, and a phone (≤500px, where the bar is a launcher) always does; <html data-dock> carries the position in effect, not the choice. dockPos() reads the choice.
// - adash.dock.size = button size in px (28–56), set as --dock-pick; a phone's launcher ignores it. dockSize().
(() => {
  const read = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
  window.dockPos = () => read('adash.dock', 'bottom');
  window.dockSize = () => +read('adash.dock.size', 38);
  window.applyDock = (choice = dockPos(), size = dockSize()) => {
    const root = document.documentElement;
    root.dataset.dock = innerWidth <= 500 || (innerWidth <= 700 || innerHeight <= 500) && (choice === 'left' || choice === 'right') ? 'bottom' : choice;
    root.style.setProperty('--dock-pick', size + 'px');
  };
  addEventListener('resize', () => applyDock());
  applyDock();
})();
