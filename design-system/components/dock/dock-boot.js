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
// - --dock-lift: iOS sometimes keeps the upright height after an installed app is turned sideways (or hands out a
//   viewport taller than what shows), so a bottom bar sat below the screen's edge until the next resize. On a touch
//   screen, whatever of the viewport lies past the screen (or past the visual viewport, when not typing or zoomed)
//   raises the bar by that much (tokens.css --dock-bottom).
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
    root.style.setProperty('--dock-lift', dockLift() + 'px');
  };
  const dockLift = () => {
    if (!matchMedia('(pointer: coarse)').matches) return 0;
    const wide = screen.orientation ? screen.orientation.type.startsWith('landscape') : innerWidth > innerHeight;
    let seen = wide ? Math.min(screen.width, screen.height) : Math.max(screen.width, screen.height);
    const vv = window.visualViewport;
    if (vv && Math.abs(vv.scale - 1) < .01 && !document.activeElement?.matches?.('input, textarea, [contenteditable="true"]'))
      seen = Math.min(seen, vv.offsetTop + vv.height);
    return Math.max(0, Math.round(innerHeight - seen));
  };
  addEventListener('resize', () => applyDock());
  // iOS reports the new size late after a turn: look again once it has settled
  const turned = () => { applyDock(); setTimeout(() => applyDock(), 300); setTimeout(() => applyDock(), 1000); };
  addEventListener('orientationchange', turned);
  screen.orientation?.addEventListener('change', turned);
  window.visualViewport?.addEventListener('resize', () => applyDock());
  addEventListener('ds-posture', () => applyDock());
  applyDock();
})();
