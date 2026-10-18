// <ds-dock>: the floating bar. Its children are the buttons (see dock.css); this element adds the last one, ⋯ 바 설정,
// with a menu for where the bar sits and how big it is. The choice is saved as adash.dock / adash.dock.size, and
// dock-boot.js (loaded in <head>) applies it before the first paint; applyDock, dockPos and dockSize come from there.
// The menu lives at the end of <body>, not in the bar: the bar's transform would make it the menu's containing block.
// inset-from="SELECTOR": a sticky element (the page header) the bar keeps below when it sits at the top; the bar
// tracks its height and sets --dock-inset-top (its sticky top + height) on <html>.
const SIDES = [['top', '↑ 위'], ['bottom', '↓ 아래'], ['left', '← 왼쪽'], ['right', '→ 오른쪽']];
const save = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

class DsDock extends HTMLElement {
  connectedCallback() {
    if (this.menu) return;
    if (!this.hasAttribute('role')) this.setAttribute('role', 'navigation');
    const above = this.getAttribute('inset-from') && document.querySelector(this.getAttribute('inset-from'));
    // the header's sticky top holds the status bar's safe area, which changes on rotation without resizing it
    const inset = () => document.documentElement.style.setProperty('--dock-inset-top',
      (parseFloat(getComputedStyle(above).top) || 0) + above.offsetHeight + 'px');
    if (above) { new ResizeObserver(inset).observe(above); addEventListener('resize', inset); }
    const btn = document.createElement('button');
    btn.className = 'dock-btn';
    btn.dataset.tip = '바 설정';
    btn.setAttribute('aria-label', '바 설정');
    btn.innerHTML = '<ds-icon name="more"></ds-icon>';
    this.append(btn);

    const menu = this.menu = document.createElement('div');
    menu.className = 'dock-menu dock-pop';
    menu.hidden = true;
    menu.innerHTML = `<span class="st">바 위치</span><div class="seg">${SIDES.map(([k, l]) => `<button data-dock="${k}">${l}</button>`).join('')}</div>
      <label class="st dock-size">크기 <input type="range" min="28" max="56" step="2"></label>`;
    document.body.append(menu);
    const mark = () => menu.querySelectorAll('[data-dock]').forEach(b => b.classList.toggle('on', b.dataset.dock === dockPos()));
    btn.onclick = e => { e.stopPropagation(); mark(); menu.hidden = !menu.hidden; };
    menu.onclick = e => {
      const b = e.target.closest('[data-dock]'); if (!b) return;
      save('adash.dock', b.dataset.dock); applyDock(b.dataset.dock); mark();
    };
    const size = menu.querySelector('input');
    size.value = dockSize();
    size.oninput = () => { save('adash.dock.size', size.value); applyDock(dockPos(), +size.value); };
    document.addEventListener('click', e => { if (!menu.hidden && !this.contains(e.target) && !menu.contains(e.target)) menu.hidden = true; });
  }
}
customElements.define('ds-dock', DsDock);

// .dock-pop elements are one group: whichever opens (its hidden attribute goes away) closes the others, so the bar's
// menu and the page's panels never stack. Pages just toggle `hidden`.
new MutationObserver(records => {
  for (const { target: el } of records) {
    if (!el.classList.contains('dock-pop') || el.hidden) continue;
    document.querySelectorAll('.dock-pop').forEach(o => { if (o !== el && !o.hidden) o.hidden = true; });
  }
}).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
