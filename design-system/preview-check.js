// 「점검」 in the preview (/ds/): measures every component section as it is drawn right now — this theme, material,
// width and pointer — against the GUIDELINES rules only the screen shows, and marks what fails in place. It runs again
// on resize, rotation, fold and on a theme or material change, so the preview can be opened on the device itself.
// 「네 조합」 runs it once in each theme × material and merges the result. ?check in the URL turns it on at load.
// Preview only: the dashboard never loads it, and scripts/check-ds.py stays the check for the source. The story viewer
// (stories.html) runs measure() inside its canvas, one story at a time.
export const RULES = {
  overflow: ['B5', '화면 밖으로 나감'],
  tap: ['A4', '누르는 영역이 작음'],
  input: ['B4', '입력란 글자 16px 미만'],
  contrast: ['대비', '글자 대비 부족'],
  name: ['A1', '아이콘 버튼에 이름 없음'],
};
export const COMBOS = [['light', 'glass'], ['light', 'matte'], ['dark', 'glass'], ['dark', 'matte']];
export const NAMES = { light: '라이트', dark: '다크', glass: '유리', matte: '매트' };
const TARGETS = 'button, a[href], summary, select, textarea, input:not([type=hidden]), [role=button], [tabindex]:not([tabindex="-1"])';
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const px = v => parseFloat(v) || 0;
const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

// any CSS colour (oklch, color-mix …) to [r, g, b, a] by painting one pixel
const ctx = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
const colours = new Map();
const rgba = c => {
  if (!colours.has(c)) {
    ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#0000'; ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    colours.set(c, [r, g, b, a / 255]);
  }
  return colours.get(c);
};
const over = ([r, g, b, a], [R, G, B]) => [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a), 1];
const lum = rgb => { const [r, g, b] = rgb.slice(0, 3).map(v => (v /= 255) <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); return .2126 * r + .7152 * g + .0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + .05) / (y + .05); };

// the colour under an element: its own and its ancestors' backgrounds laid over the page. null when an image or
// gradient is in the way. Glass surfaces blur what is behind them; this lays them over the page colour instead.
const backdrop = el => {
  const layers = [];
  for (let e = el; e; e = e.parentElement) {
    const cs = getComputedStyle(e);
    if (cs.backgroundImage !== 'none') return null;
    const c = rgba(cs.backgroundColor);
    if (c[3]) layers.push(c);
    if (c[3] === 1) break;
  }
  return layers.reverse().reduce((under, c) => over(c, under), [255, 255, 255, 1]);
};
const opacity = el => { let o = 1; for (let e = el; e; e = e.parentElement) o *= px(getComputedStyle(e).opacity) || 0; return o; };

const shown = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
export const label = el => {
  const cls = [...el.classList].filter(c => !c.startsWith('chk')).slice(0, 2).map(c => '.' + c).join('');
  const t = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ');
  return el.localName + cls + (t ? ` 「${t.length > 18 ? t.slice(0, 18) + '…' : t}」` : '');
};
// clipped by a scroll or overflow box inside the page: whatever sticks out of the screen there is not page overflow
const clipped = el => { for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) if (getComputedStyle(e).overflowX !== 'visible') return true; return false; };
// the press area, counting an absolute ::before that widens it (B3)
const pressArea = el => {
  const r = el.getBoundingClientRect(), b = getComputedStyle(el, '::before');
  let w = r.width, h = r.height;
  if (b.content !== 'none' && b.position === 'absolute') {
    w = Math.max(w, r.width - px(b.left) - px(b.right));
    h = Math.max(h, r.height - px(b.top) - px(b.bottom));
  }
  return [w, h];
};

// what each element is checked under: the component section it is in (the dock lives at the end of <body>), else the page
const owner = el => el.closest('section[id^="c-"]') || (el.closest('ds-dock, .dock-pop') ? document.getElementById('c-dock') : null);
const skip = el => el.closest('.chk, .chk-b, section > details, #chk-bar');

export function measure() {
  for (const a of document.getAnimations()) if (a instanceof CSSTransition) a.finish();
  const found = [], add = (kind, el, detail) => found.push({ kind, el, sec: owner(el), detail });
  const W = document.documentElement.clientWidth, coarse = matchMedia('(pointer: coarse)').matches;
  const tap = px(getComputedStyle(document.documentElement).getPropertyValue('--tap')) || (coarse ? 36 : 28);
  const out = new Set();
  for (const el of document.body.querySelectorAll('*')) {
    if (skip(el) || !shown(el)) continue;
    const sec = owner(el);
    const r = el.getBoundingClientRect();
    if ((r.right > W + .5 || r.left < -.5) && !clipped(el) && ![...out].some(o => o.contains(el))) {
      out.add(el);
      add('overflow', el, r.right > W ? `오른쪽으로 ${Math.round(r.right - W)}px` : `왼쪽으로 ${Math.round(-r.left)}px`);
    }
    if (!sec) continue;
    if (el.matches(TARGETS) && !el.closest(':disabled') && !(el.localName === 'a' && getComputedStyle(el).display === 'inline')) {
      const box = el.matches('input[type=checkbox], input[type=radio]') && el.closest('label') || el;
      const [w, h] = pressArea(box);
      if (Math.min(w, h) < tap - .5) add('tap', box, `${Math.round(w)}×${Math.round(h)}, 최소 ${tap}`);
      if (el.matches('button, a') && !el.textContent.trim() && el.querySelector('svg, ds-icon')) {
        const miss = ['aria-label', 'data-tip'].filter(a => !el.hasAttribute(a) && !(a === 'aria-label' && el.hasAttribute('aria-labelledby')));
        if (miss.length) add('name', el, miss.join(', ') + ' 없음');
      }
    }
    if (coarse && el.matches('input:not([type=checkbox], [type=radio], [type=range], [type=color]), textarea, select')) {
      const f = px(getComputedStyle(el).fontSize);
      if (f < 16) add('input', el, `${f}px`);
    }
    if ([...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && !el.closest(':disabled, [aria-disabled="true"]')) {
      const cs = getComputedStyle(el), under = backdrop(el);
      if (!under) continue;
      const [r_, g, b, a] = rgba(cs.color), text = over([r_, g, b, a * opacity(el)], under);
      const size = px(cs.fontSize), big = size >= 24 || (size >= 18.6 && px(cs.fontWeight) >= 700), need = big ? 3 : 4.5;
      const k = ratio(text, under);
      if (k < need) add('contrast', el, `${k.toFixed(2)} : 1, 기준 ${need}`);
    }
  }
  return found;
}

export function initCheck() {
  const root = document.documentElement, main = document.querySelector('main');
  const bar = document.getElementById('chk-bar'), sum = bar.querySelector('#chk-sum');
  const [onBtn, allBtn, onlyBtn] = ['#chk', '#chk-all', '#chk-only'].map(s => bar.querySelector(s));
  const sections = [...document.querySelectorAll('section[id^="c-"]')];
  let on = false, busy = false, timer, marked = [], current = [];

  const clear = () => {
    marked.forEach(el => { delete el.dataset.chk; }); marked = [];
    document.querySelectorAll('.chk, .chk-b').forEach(e => e.remove());
    sections.forEach(s => s.classList.remove('chk-pass', 'chk-fail'));
  };
  // problems: [{kind, el, sec, detail, combos?}]
  const draw = (problems, where) => {
    clear(); current = problems;
    for (const p of problems) { p.el.dataset.chk = ''; marked.push(p.el); }
    const bySec = new Map(sections.map(s => [s, []])), page = [];
    for (const p of problems) (p.sec ? bySec.get(p.sec) : page).push(p);
    let failing = 0;
    for (const [sec, list] of bySec) {
      const h2 = sec.querySelector('h2');
      sec.classList.add(list.length ? 'chk-fail' : 'chk-pass');
      if (list.length) failing++;
      h2.insertAdjacentHTML('beforeend', `<span class="badge chk-b ${list.length ? 'bad' : 'ok'}">${list.length ? `문제 ${list.length}` : '통과'}</span>`);
      if (list.length) h2.insertAdjacentElement('afterend', listEl(list));
    }
    const pageList = page.length ? listEl(page) : null;
    sum.innerHTML = `${failing ? `<b class="bad">문제 있는 컴포넌트 ${failing}</b> / ${sections.length}` : `<b class="ok">모두 통과</b> (${sections.length}개)`}`
      + `${page.length ? ` · 페이지 넘침 ${page.length}` : ''} · ${where}`
      + (failing ? `<span class="chk-jump">${[...bySec].filter(([, l]) => l.length).map(([s]) => `<a href="#${s.id}">${s.id.slice(2)}</a>`).join('')}</span>` : '');
    if (pageList) sum.append(pageList);
  };
  const listEl = list => {
    const ul = document.createElement('ul');
    ul.className = 'chk';
    ul.innerHTML = list.map(p => `<li><button type="button" data-i="${current.indexOf(p)}"><b>${RULES[p.kind][0]}</b> ${RULES[p.kind][1]} · ${esc(label(p.el))} · ${esc(p.detail)}`
      + (p.combos ? ` <span class="st">${p.combos.join(', ')}</span>` : '') + '</button></li>').join('');
    return ul;
  };
  // pressing a problem scrolls its element into view and flashes it
  document.addEventListener('click', e => {
    const b = e.target.closest('.chk button[data-i]');
    if (!b) return;
    const el = current[+b.dataset.i]?.el;
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.remove('chk-flash'); void el.offsetWidth; el.classList.add('chk-flash');
  });

  const state = () => {
    const w = root.clientWidth, coarse = matchMedia('(pointer: coarse)').matches;
    const fold = getComputedStyle(root).getPropertyValue('--fold').trim() === '1';
    return `${NAMES[root.dataset.theme]}·${NAMES[root.dataset.material]} · 폭 ${w}${coarse ? ' · 터치' : ''}${fold ? ' · 펼침' : ''}`;
  };
  const run = async () => {
    if (!on || busy) return;
    clear(); await frame();
    draw(measure(), state());
  };
  const runAll = async () => {
    if (busy) return;
    busy = true; allBtn.disabled = true;
    const keep = [themeChoice(), materialChoice()], merged = new Map();
    clear();
    for (const [t, m] of COMBOS) {
      applyTheme(t); applyMaterial(m); await frame();
      for (const p of measure()) {
        const name = `${NAMES[t]}·${NAMES[m]}`, seen = merged.get(p.el)?.get(p.kind);
        if (seen) seen.combos.push(name);
        else { if (!merged.has(p.el)) merged.set(p.el, new Map()); merged.get(p.el).set(p.kind, { ...p, combos: [name] }); }
      }
    }
    applyTheme(keep[0]); applyMaterial(keep[1]); await frame();
    clearTimeout(timer);  // the theme events above queued a single-combo run that would replace this result
    busy = false; allBtn.disabled = false;
    draw([...merged.values()].flatMap(m => [...m.values()]), `네 조합 · ${state().split(' · ').slice(1).join(' · ')}`);
  };
  const later = () => { clearTimeout(timer); timer = setTimeout(run, 250); };

  const set = v => {
    on = v; onBtn.setAttribute('aria-pressed', v); onBtn.classList.toggle('accent', v);
    allBtn.hidden = onlyBtn.hidden = !v;
    root.classList.toggle('chk-on', v);
    if (v) run(); else { clear(); sum.textContent = ''; main.classList.remove('chk-only'); onlyBtn.setAttribute('aria-pressed', false); }
  };
  onBtn.onclick = () => set(!on);
  allBtn.onclick = runAll;
  onlyBtn.onclick = () => onlyBtn.setAttribute('aria-pressed', main.classList.toggle('chk-only'));
  addEventListener('resize', later);
  document.addEventListener('ds:theme', later);
  document.addEventListener('ds:material', later);
  navigator.devicePosture?.addEventListener?.('change', later);
  if (new URLSearchParams(location.search).has('check')) set(true);
}
