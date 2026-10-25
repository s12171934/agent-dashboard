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
// data-more on a child (a button, toggle, tab or separator) keeps it off the bar: above the phone width it moves into the
// ⋯ menu, a row with its data-tip as the name (a separator's data-label heads a group there), and on a phone it goes back
// to its place in the sheet. The element moves, not a copy, so its id, handlers, checkbox and hidden keep working.
// 「바에 둘 항목」 in the ⋯ menu lets the user move any named item (data-tip) between the bar and the menu; the choice
// overrides data-more and is saved as adash.dock.items ({key: 'bar' | 'more'}, key = data-key, id, the toggle's input
// id, href or data-tip). A separator left with nothing visible beside it on the bar hides itself ([data-empty]).
// 「바 숨기기」 folds the bar to one button that brings it back (adash.dock.hidden, <html data-dock-hidden> set by
// dock-boot.js's applyDock, before the first paint); a phone keeps its launcher.
// Half folded (<html data-posture>, fold.js), the sheet is always open and fills the screen's second half, the page
// keeping to the first as on the cover screen: no scrim, no close button, and following a tab leaves it open.
const SIDES = [['top', '↑ 위'], ['bottom', '↓ 아래'], ['left', '← 왼쪽'], ['right', '→ 오른쪽']];
const save = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const PHONE = matchMedia('(max-width: 500px)');
const HALF = () => !!document.documentElement.dataset.posture;  // half folded (fold.js): the sheet stays open on the second half
const ITEMS = 'adash.dock.items';
const prefs = () => { try { return JSON.parse(localStorage.getItem(ITEMS)) || {}; } catch { return {}; } };
const keyOf = e => e.dataset.key || e.id || e.querySelector('input')?.id || e.getAttribute('href') || e.dataset.tip;
const esc = t => String(t).replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);

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
    // each named child (and data-more separator) keeps a marker at its place in the bar, to go back to
    this.more = [...this.children].filter(e => e.dataset.tip || e.hasAttribute('data-more')).map(e => {
      const mark = document.createComment('dock-more');
      e.before(mark);
      return [e, mark];
    });
    const btn = document.createElement('button');
    btn.className = 'dock-btn dock-cfg';
    const name = '더 보기 · 바 설정';
    btn.dataset.tip = name;
    btn.setAttribute('aria-label', name);
    btn.innerHTML = '<ds-icon name="more"></ds-icon>';
    this.append(btn);

    const menu = this.menu = document.createElement('div');
    menu.className = 'dock-menu dock-pop';
    menu.hidden = true;
    menu.innerHTML = `<div class="dock-more"></div><div class="dock-side"><span class="st">바 위치</span><div class="seg">${SIDES.map(([k, l]) => `<button data-dock="${k}">${l}</button>`).join('')}</div></div>
      <label class="st dock-size">크기 <input type="range" min="28" max="56" step="2"></label>
      <details class="dock-items"><summary class="st">바에 둘 항목</summary><div class="dock-pick"></div>
        <button class="dock-reset">기본값으로</button></details>
      <button class="dock-hide"><ds-icon name="eye-off"></ds-icon>바 숨기기</button>`;
    document.body.append(menu);
    const mark = () => menu.querySelectorAll('[data-dock]').forEach(b => b.classList.toggle('on', b.dataset.dock === dockPos()));
    btn.onclick = e => { e.stopPropagation(); mark(); menu.querySelector('.dock-side').hidden = dockLocked(); menu.hidden = !menu.hidden; };
    menu.onclick = e => {
      if (e.target.closest('a')) { menu.hidden = true; return; }  // a tab moved here: going to it closes the menu
      if (e.target.closest('.dock-hide')) { menu.hidden = true; this.collapse(true); return; }
      if (e.target.closest('.dock-reset')) { save(ITEMS, '{}'); this.place(); this.picks(); return; }
      const b = e.target.closest('[data-dock]'); if (!b) return;
      save('adash.dock', b.dataset.dock); applyDock(b.dataset.dock); mark();
    };
    const size = menu.querySelector('.dock-size input');
    size.value = dockSize();
    size.oninput = () => { save('adash.dock.size', size.value); applyDock(dockPos(), +size.value); };
    menu.querySelector('.dock-pick').onchange = e => {
      const p = prefs(); p[e.target.dataset.k] = e.target.checked ? 'bar' : 'more';
      save(ITEMS, JSON.stringify(p)); this.place();
    };
    document.addEventListener('click', e => { if (!menu.hidden && !this.contains(e.target) && !menu.contains(e.target)) menu.hidden = true; });
    // folded (「바 숨기기」): only this button shows; it unfolds the bar
    const show = this.show = document.createElement('button');
    show.className = 'dock-btn dock-show';
    show.dataset.tip = '바 보이기';
    show.setAttribute('aria-label', '바 보이기');
    show.innerHTML = '<ds-icon name="grid"></ds-icon>';
    show.onclick = e => { e.stopPropagation(); this.collapse(false); };
    this.append(show);
    this.phone();
    this.picks();
    this.place();
    PHONE.addEventListener('change', () => this.place());
    const half = () => { this.place(); this.open(HALF()); };
    addEventListener('ds-posture', half);
    if (HALF()) half();
  }
  // menu items (data-more, or moved there in 「바에 둘 항목」): in the ⋯ menu above the phone width, back in the bar
  // (its sheet) on a phone
  inMore(e) {
    if (!e.dataset.tip) return e.hasAttribute('data-more');
    const p = prefs()[keyOf(e)];
    return p ? p === 'more' : e.hasAttribute('data-more');
  }
  place() {
    const box = this.menu.querySelector('.dock-more');
    for (const [el, mark] of this.more) {
      if (PHONE.matches || HALF() || !this.inMore(el)) { if (el.parentElement !== this) mark.after(el); } else box.append(el);  // append keeps bar order
    }
    this.seps();
  }
  // a bar separator with no visible item on one side of it (up to the next separator or the end) hides
  seps() {
    let seen = false, pend = null;  // pend: a separator after visible items, shown once one follows it
    for (const el of this.children) {
      if (el.classList.contains('dock-sep')) {
        el.toggleAttribute('data-empty', true);
        if (seen) { pend = el; seen = false; }
      } else if (!el.matches('.dock-launch, .dock-head, .dock-cfg, .dock-show') && !el.hidden) {
        seen = true;
        if (pend) { pend.removeAttribute('data-empty'); pend = null; }
      }
    }
  }
  // the 「바에 둘 항목」 list: one checkbox per named item, checked = on the bar
  picks() {
    this.menu.querySelector('.dock-pick').innerHTML = this.more.filter(([e]) => e.dataset.tip).map(([e]) => {
      const icon = e.querySelector('ds-icon')?.getAttribute('name') || (e.localName === 'ds-theme-toggle' ? 'sun' : 'grid');
      return `<label><ds-icon name="${icon}"></ds-icon><span>${esc(e.dataset.tip)}</span><input type="checkbox" data-k="${esc(keyOf(e))}"${this.inMore(e) ? '' : ' checked'}></label>`;
    }).join('');
  }
  collapse(on) {
    save('adash.dock.hidden', on ? '1' : '');
    applyDock();
    (on ? this.show : this.querySelector('.dock-cfg')).focus({ preventScroll: true });
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
    new MutationObserver(() => { this.mark(); this.seps(); }).observe(this, { subtree: true, attributes: true, attributeFilter: ['class', 'hidden'], childList: true, characterData: true });
    this.mark();
  }
  open(on) {
    if (!this.launch || on === this.hasAttribute('open') || !on && HALF()) return;
    // the sheet holds every popover's button, so it is one of the group: opening it closes them
    if (on) document.querySelectorAll('.dock-pop').forEach(o => { o.hidden = true; });
    this.toggleAttribute('open', on);
    this.scrim.hidden = !on || HALF();
    this.launch.setAttribute('aria-expanded', on);
    if (HALF()) return;
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
