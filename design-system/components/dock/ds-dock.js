// <ds-dock>: the floating bar. Its children are the buttons (see dock.css); this element adds the last one, ⋯ 바 설정,
// with a menu for where the bar sits (not on a phone: dockLocked() keeps it at the bottom) and how big it is. The choice is saved as adash.dock / adash.dock.size, and
// dock-boot.js (loaded in <head>) applies it before the first paint; applyDock, dockPos and dockSize come from there.
// The menu lives at the end of <body>, not in the bar: the bar's transform would make it the menu's containing block.
// inset-from="SELECTOR": a sticky element (the page header) the bar keeps below when it sits at the top; the bar
// tracks its height and sets --dock-inset-top (its sticky top + height) on <html>.
// On a phone (≤500px) the bar is a launcher (dock.css): this element adds .dock-launch (the current tab — the child
// <a> with .on — the summary attribute and a menu button) and .dock-head (sheet-title attribute, default 「이동과 설정」,
// and a close button), and toggles [open], which turns the bar into a sheet of its own children. The scrim behind it
// lives at the end of <body> for the same reason as the menu. Following a tab, or a button that opens a .dock-pop,
// closes the sheet; toggles and other buttons (the theme) leave it open.
const SIDES = [['top', '↑ 위'], ['bottom', '↓ 아래'], ['left', '← 왼쪽'], ['right', '→ 오른쪽']];
const save = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const PHONE = matchMedia('(max-width: 500px)');

class DsDock extends HTMLElement {
  static observedAttributes = ['summary', 'sheet-title'];
  attributeChangedCallback() { if (this.launch) this.mark(); }
  connectedCallback() {
    if (this.menu) return;
    if (!this.hasAttribute('role')) this.setAttribute('role', 'navigation');
    const above = this.getAttribute('inset-from') && document.querySelector(this.getAttribute('inset-from'));
    // the header's sticky top holds the status bar's safe area, which changes on rotation without resizing it
    const inset = () => document.documentElement.style.setProperty('--dock-inset-top',
      (parseFloat(getComputedStyle(above).top) || 0) + above.offsetHeight + 'px');
    if (above) { new ResizeObserver(inset).observe(above); addEventListener('resize', inset); }
    const btn = document.createElement('button');
    btn.className = 'dock-btn dock-cfg';
    btn.dataset.tip = '바 설정';
    btn.setAttribute('aria-label', '바 설정');
    btn.innerHTML = '<ds-icon name="more"></ds-icon>';
    this.append(btn);

    const menu = this.menu = document.createElement('div');
    menu.className = 'dock-menu dock-pop';
    menu.hidden = true;
    menu.innerHTML = `<div class="dock-side"><span class="st">바 위치</span><div class="seg">${SIDES.map(([k, l]) => `<button data-dock="${k}">${l}</button>`).join('')}</div></div>
      <label class="st dock-size">크기 <input type="range" min="28" max="56" step="2"></label>`;
    document.body.append(menu);
    const mark = () => menu.querySelectorAll('[data-dock]').forEach(b => b.classList.toggle('on', b.dataset.dock === dockPos()));
    btn.onclick = e => { e.stopPropagation(); mark(); menu.querySelector('.dock-side').hidden = dockLocked(); menu.hidden = !menu.hidden; };
    menu.onclick = e => {
      const b = e.target.closest('[data-dock]'); if (!b) return;
      save('adash.dock', b.dataset.dock); applyDock(b.dataset.dock); mark();
    };
    const size = menu.querySelector('input');
    size.value = dockSize();
    size.oninput = () => { save('adash.dock.size', size.value); applyDock(dockPos(), +size.value); };
    document.addEventListener('click', e => { if (!menu.hidden && !this.contains(e.target) && !menu.contains(e.target)) menu.hidden = true; });
    this.phone();
  }
  // the phone launcher and sheet (see the header comment)
  phone() {
    const launch = this.launch = document.createElement('button');
    launch.className = 'dock-launch';
    launch.setAttribute('aria-expanded', 'false');
    launch.innerHTML = '<span><ds-icon></ds-icon><span></span></span><small></small><b><ds-icon name="grid"></ds-icon></b>';
    const head = this.head = document.createElement('div');
    head.className = 'dock-head';
    head.innerHTML = '<b></b><button class="dock-close" aria-label="닫기"><ds-icon name="x"></ds-icon></button>';
    this.prepend(launch, head);
    const scrim = this.scrim = document.createElement('div');
    scrim.className = 'dock-scrim';
    scrim.hidden = true;
    document.body.append(scrim);
    launch.onclick = e => { e.stopPropagation(); this.open(true); };
    head.querySelector('.dock-close').onclick = () => this.open(false);
    scrim.onclick = () => this.open(false);
    addEventListener('keydown', e => { if (e.key === 'Escape') this.open(false); });
    PHONE.addEventListener('change', () => this.open(false));
    // after the click has done its work (page handlers run first): a tab, or a button that opened a popover, closes the sheet
    this.addEventListener('click', e => {
      const hit = e.target.closest('a, button');
      if (!this.hasAttribute('open') || !hit || hit.parentElement === head) return;
      setTimeout(() => { if (hit.matches('a') || [...document.querySelectorAll('.dock-pop')].some(p => !p.hidden)) this.open(false); });
    });
    new MutationObserver(() => this.mark()).observe(this, { subtree: true, attributes: true, attributeFilter: ['class', 'hidden'], childList: true, characterData: true });
    this.mark();
  }
  open(on) {
    if (!this.launch || on === this.hasAttribute('open')) return;
    // the sheet holds every popover's button, so it is one of the group: opening it closes them
    if (on) document.querySelectorAll('.dock-pop').forEach(o => { o.hidden = true; });
    this.toggleAttribute('open', on);
    this.scrim.hidden = !on;
    this.launch.setAttribute('aria-expanded', on);
    if (on) this.head.querySelector('.dock-close').focus({ preventScroll: true });
    else if (this.contains(document.activeElement)) this.launch.focus({ preventScroll: true });
  }
  // the launcher shows the current tab, the summary and a dot when any count badge is up
  mark() {
    const cur = this.querySelector(':scope > a.on'), name = cur?.dataset.tip || '메뉴';
    const icon = this.launch.querySelector('span ds-icon'), label = this.launch.querySelector('span span');
    const iname = cur?.querySelector('ds-icon')?.getAttribute('name') || 'grid';
    if (icon.getAttribute('name') !== iname) icon.setAttribute('name', iname);
    if (label.textContent !== name) label.textContent = name;
    const sum = this.getAttribute('summary') || '', small = this.launch.querySelector('small');
    if (small.textContent !== sum) small.textContent = sum;
    const dot = !!this.querySelector('.dn:not([hidden])'), go = this.launch.querySelector('b');
    if (go.classList.contains('dot') !== dot) go.classList.toggle('dot', dot);
    const aria = `메뉴 열기: 지금 ${name}${sum ? ' · ' + sum : ''}`;
    if (this.launch.getAttribute('aria-label') !== aria) this.launch.setAttribute('aria-label', aria);
    const title = this.getAttribute('sheet-title') || '이동과 설정', h = this.head.querySelector('b');
    if (h.textContent !== title) h.textContent = title;
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
