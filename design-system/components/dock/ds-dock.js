// <ds-dock>: the floating bar. Its children are the buttons (see dock.css); this element adds the last one, ⋯ 더보기,
// with a menu of the items kept off the bar and of where the bar sits (not on a phone: dockLocked() keeps it at the
// bottom) and how big it is. The choice is saved as adash.dock / adash.dock.size, and
// dock-boot.js (loaded in <head>) applies it before the first paint; applyDock, dockPos and dockSize come from there.
// The menu lives at the end of <body>, not in the bar: the bar's transform would make it the menu's containing block.
// inset-from="SELECTOR": a sticky element (the page header) the bar keeps below when it sits at the top; the bar
// tracks its height and sets --dock-inset-top (its sticky top + height) on <html>.
// The bar reads as the App Store's tab bar: a few tabs with their names under the icons (data-name), and ⋯ 더보기 for
// everything else. data-more on a child (a button, toggle, tab or separator) keeps it off the bar: it moves into the ⋯
// menu, a row with its data-tip as the name (a separator's data-label heads a group there); a phone shows the same
// bar, the menu as a sheet across the screen. The element moves, not a copy, so its id, handlers, checkbox and hidden
// keep working. A count badge up in the menu puts a dot on ⋯.
// Half folded (see below) this element adds .dock-head (sheet-title attribute, default 「이동과 설정」) and toggles
// [open], which turns the bar into a sheet of all its own children.
// 「바에 둘 항목」 in the ⋯ menu lets the user move any named item (data-tip) between the bar and the menu; the choice
// overrides data-more and is saved as adash.dock.items.v2 ({key: 'bar' | 'more'}, key = data-key, id, the toggle's input
// id, href or data-tip). A separator left with nothing visible beside it on the bar hides itself ([data-empty]).
// 「바 숨기기」 folds the bar to one button that brings it back (adash.dock.hidden, <html data-dock-hidden> set by
// dock-boot.js's applyDock, before the first paint); a phone keeps its bar.
// Half folded (<html data-posture>, fold.js), the sheet is always open and fills the screen's second half, the page
// keeping to the first as on the cover screen; following a tab leaves it open.
const SIDES = [['top', '↑ 위'], ['bottom', '↓ 아래'], ['left', '← 왼쪽'], ['right', '→ 오른쪽']];
const save = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const HALF = () => !!document.documentElement.dataset.posture;  // half folded (fold.js): the sheet stays open on the second half
const ITEMS = 'adash.dock.items.v2';  // v2: the App Store bar's defaults replaced the old all-on-the-bar choices
const prefs = () => { try { return JSON.parse(localStorage.getItem(ITEMS)) || {}; } catch { return {}; } };
const keyOf = e => e.dataset.key || e.id || e.querySelector('input')?.id || e.getAttribute('href') || e.dataset.tip;
const esc = t => String(t).replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);

class DsDock extends HTMLElement {
  static observedAttributes = ['sheet-title'];
  attributeChangedCallback() { if (this.head) this.mark(); }
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
    const name = '더보기 · 바 설정';
    btn.dataset.tip = name;
    btn.dataset.name = '더보기';
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
    // folded (「바 숨기기」): only this button shows; it unfolds the bar
    const show = this.show = document.createElement('button');
    show.className = 'dock-btn dock-show';
    show.dataset.tip = '바 보이기';
    show.setAttribute('aria-label', '바 보이기');
    show.innerHTML = '<ds-icon name="grid"></ds-icon>';
    show.onclick = e => { e.stopPropagation(); this.collapse(false); };
    this.append(show);
    this.sheet();
    this.picks();
    this.place();
    // a count badge up among the menu's items: a dot on ⋯
    const dot = () => btn.classList.toggle('dot', !!menu.querySelector('.dock-more .dn:not([hidden])'));
    new MutationObserver(dot).observe(menu, { subtree: true, attributes: true, attributeFilter: ['hidden'], childList: true });
    dot();
    const half = () => { this.place(); this.open(HALF()); };
    addEventListener('ds-posture', half);
    if (HALF()) half();
  }
  // menu items (data-more, or moved there in 「바에 둘 항목」): in the ⋯ menu, back in the bar when half folded (its sheet)
  inMore(e) {
    if (!e.dataset.tip) return e.hasAttribute('data-more');
    const p = prefs()[keyOf(e)];
    return p ? p === 'more' : e.hasAttribute('data-more');
  }
  place() {
    const box = this.menu.querySelector('.dock-more');
    for (const [el, mark] of this.more) {
      if (HALF() || !this.inMore(el)) { if (el.parentElement !== this) mark.after(el); } else box.append(el);  // append keeps bar order
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
      } else if (!el.matches('.dock-head, .dock-cfg, .dock-show') && !el.hidden) {
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
  // the half-folded sheet's head (see the header comment)
  sheet() {
    const head = this.head = document.createElement('div');
    head.className = 'dock-head';
    head.innerHTML = '<b></b>';
    this.prepend(head);
    new MutationObserver(() => this.seps()).observe(this, { subtree: true, attributes: true, attributeFilter: ['class', 'hidden'], childList: true });
    this.mark();
  }
  open(on) {
    if (!this.head || on === this.hasAttribute('open')) return;
    // the sheet holds every popover's button, so it is one of the group: opening it closes them
    if (on) document.querySelectorAll('.dock-pop').forEach(o => { o.hidden = true; });
    this.toggleAttribute('open', on);
  }
  mark() {
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
// A click outside them closes the open one. The bar is not outside (its buttons toggle their popover themselves), nor
// is a <dialog> (a popover's confirm). Capture phase: a popover that redraws on the click still holds the target.
document.addEventListener('click', e => {
  if (e.target.closest?.('.dock-pop, ds-dock, dialog')) return;
  document.querySelectorAll('.dock-pop').forEach(o => { if (!o.hidden) o.hidden = true; });
}, true);
