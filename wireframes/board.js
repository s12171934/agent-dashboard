// Wireframe board: every screen of the dashboard at every width on one page (격자), or as a map of how the screens
// lead to one another (흐름 지도). screens.json lists the screens; each variant is a file under screens/ drawn with
// wf.css. The board only reads; nothing here talks to a metric server.
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const ST = { none: '미작성', draft: '시안', picked: '확정', dropped: '보류' };
const KEY = 'wfboard.v1';

let M = null, ver = '', edgesFrom = new Map();
const S = { view: 'grid', widths: null, group: '', status: '', variants: 'all', full: false, slots: false, actual: false, zoom: 0.24, pick: {} };
try { Object.assign(S, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch {}
const h = new URLSearchParams(location.hash.slice(1));
if (h.get('view')) S.view = h.get('view');
const save = () => {
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch {}
  history.replaceState(null, '', '#view=' + S.view);
};

const url = f => f + (ver ? (f.includes('?') ? '&' : '?') + 'v=' + encodeURIComponent(ver) : '');
// a half-folded width opens the screen with ?posture=, which wf.js turns into <html data-posture>
const src = (v, w) => v.file + (w.posture ? '?posture=' + w.posture : '');
const live = v => v.status !== 'dropped';
const statusOf = sc => sc.variants.some(v => v.status === 'picked') ? 'picked' : sc.variants.some(v => v.status === 'draft') ? 'draft' : 'none';
// the variant a single frame shows: the one picked on the board, else the 확정 one, else the first still in play
const mainVariant = sc => sc.variants.find(v => v.id === S.pick[sc.id]) || sc.variants.find(v => v.status === 'picked') || sc.variants.find(live) || null;
const widthsOn = () => M.widths.filter(w => S.widths.includes(w.id));
const visible = () => M.screens.filter(sc => (!S.group || sc.group === S.group) && (!S.status || statusOf(sc) === S.status));

async function load() {
  try { ver = (await (await fetch('../build.json', { cache: 'no-store' })).json()).build || ''; } catch { ver = ''; }
  M = await (await fetch(url('screens.json'), { cache: 'no-store' })).json();
  // a width remembered from an older screens.json that no longer exists drops out; none left means all of them
  const ids = M.widths.map(w => w.id);
  S.widths = (S.widths || []).filter(id => ids.includes(id));
  if (!S.widths.length) S.widths = ids;
  await readEdges();
  controls();
  render();
}

// Where a screen leads: a drawn screen says it itself (data-to="<screen id>" on what is pressed); a screen with no
// wireframe yet keeps the current dashboard's flow from screens.json.
async function readEdges() {
  edgesFrom = new Map();
  await Promise.all(M.screens.map(async sc => {
    const vs = sc.variants.filter(v => v.status === 'picked');
    const use = vs.length ? vs : sc.variants.filter(live);
    if (!use.length) return edgesFrom.set(sc.id, { to: new Set(sc.to || []), from: 'current' });
    const to = new Set();
    for (const v of use) {
      try {
        // the shell's navigation (data-shell: sidebar, dock, the sheet's nav row) leads everywhere; only the screen's own links count
        const doc = new DOMParser().parseFromString(await (await fetch(url(v.file), { cache: 'no-store' })).text(), 'text/html');
        doc.querySelectorAll('[data-shell]').forEach(n => n.remove());
        for (const n of doc.querySelectorAll('[data-to]')) if (n.dataset.to !== sc.id) to.add(n.dataset.to);
      } catch {}
    }
    edgesFrom.set(sc.id, { to, from: 'wireframe' });
  }));
}

function controls() {
  $('#widths').innerHTML = M.widths.map(w => `<label title="${esc(w.env)}"><input type="checkbox" value="${w.id}" ${S.widths.includes(w.id) ? 'checked' : ''}> ${esc(w.name)}</label>`).join('');
  const g = $('#group');
  if (g.options.length === 1) g.insertAdjacentHTML('beforeend', M.groups.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join(''));
  g.value = S.group; $('#status').value = S.status; $('#variants').value = S.variants; $('#full').checked = S.full; $('#slots').checked = S.slots;
  $('#zoom').value = S.zoom; $('#zoom-out').value = Math.round(S.zoom * 100) + '%';
  document.querySelectorAll('#view button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === S.view));
  $('#variants-fld').hidden = S.view !== 'grid';
}

function meta() {
  const n = k => M.screens.filter(sc => statusOf(sc) === k).length;
  $('#meta').textContent = `화면 ${M.screens.length} · 확정 ${n('picked')} · 시안 ${n('draft')} · 미작성 ${n('none')}`;
}

// one frame: the wireframe at its real width, scaled by the board zoom; it loads when it comes near the view
function frame(sc, v, w, z) {
  const W = Math.round(w.w * z), H = Math.round(w.h * z);
  if (!v) return `<div class="shot" style="width:${W}px;height:${H}px"><div class="empty">미작성</div></div>`;
  return `<div class="shot" style="width:${W}px;height:${H}px" data-screen="${sc.id}" data-variant="${v.id}" data-width="${w.id}">
    <iframe data-src="${esc(src(v, w))}" data-file="${esc(v.file)}" data-w="${w.w}" data-h="${w.h}" width="${w.w}" height="${w.h}" style="transform:scale(${z})" loading="lazy" tabindex="-1" title="${esc(sc.name)} ${esc(v.id)} ${esc(w.name)}"></iframe></div>`;
}

function render() {
  meta(); save();
  const b = $('#board');
  if (S.view === 'map') renderMap(b); else renderGrid(b);
  observe();
}

function renderGrid(b) {
  const ws = widthsOn(), z = S.zoom;
  if (!ws.length) { b.innerHTML = '<p>폭을 하나 이상 고르세요.</p>'; return; }
  const cols = `minmax(150px, 180px) ${ws.map(w => Math.round(w.w * z) + 'px').join(' ')}`;
  let out = `<div class="g" style="grid-template-columns:${cols}"><div class="g-head"></div>${ws.map(w => `<div class="g-head">${esc(w.name)}<small>${w.w}×${w.h} · ${esc(w.env)}</small></div>`).join('')}`;
  let lastGroup = null;
  for (const sc of visible()) {
    if (sc.group !== lastGroup) { lastGroup = sc.group; out += `<div class="g-group">${esc(M.groups.find(x => x.id === sc.group)?.name || sc.group)}</div>`; }
    const st = statusOf(sc), e = edgesFrom.get(sc.id);
    const rows = S.variants === 'all' && sc.variants.length > 1 ? sc.variants : [mainVariant(sc)];
    const to = [...(e?.to || [])].map(id => M.screens.find(x => x.id === id)).filter(Boolean);
    rows.forEach((v, i) => {
      out += `<div class="g-label" id="row-${sc.id}${i ? '-' + i : ''}">`;
      if (!i) {
        out += `<b>${esc(sc.name)}</b><span class="v"><span class="st ${st}">${ST[st]}</span><code>${esc(sc.id)}</code></span>`;
        if (S.variants === 'one' && sc.variants.length > 1)
          out += `<div class="tabs">${sc.variants.map(x => `<button data-pick="${sc.id}" data-v="${x.id}" aria-pressed="${x === v}">${esc(x.id.toUpperCase())}</button>`).join('')}</div>`;
        if (to.length) out += `<div class="to">→ ${to.map(x => `<a href="#" data-goto="${x.id}">${esc(x.name)}</a>`).join(', ')}${e.from === 'current' ? ' <small>(현행)</small>' : ''}</div>`;
      }
      if (v && (rows.length > 1 || v.note)) out += `<div class="v"><span class="st ${v.status}">${esc(v.id.toUpperCase())} · ${ST[v.status] || v.status}</span></div>${v.note ? `<div class="to">${esc(v.note)}</div>` : ''}`;
      out += `</div>`;
      for (const w of ws) out += `<div class="cell">${frame(sc, v, w, z)}</div>`;
    });
  }
  b.innerHTML = out + '</div>';
}

function renderMap(b) {
  const scs = visible(), ids = new Set(scs.map(s => s.id)), w = widthsOn()[0] || M.widths[0], z = S.zoom * 0.8;
  // columns: steps from 홈 along the flow; screens nothing leads to go last
  const depth = new Map(), start = ids.has('home') ? 'home' : scs[0]?.id;
  if (start) { depth.set(start, 0); const q = [start]; while (q.length) { const c = q.shift(); for (const t of edgesFrom.get(c)?.to || []) if (ids.has(t) && !depth.has(t)) { depth.set(t, depth.get(c) + 1); q.push(t); } } }
  const maxD = Math.max(0, ...depth.values()), cols = Array.from({ length: maxD + 2 }, () => []);
  for (const sc of scs) cols[depth.has(sc.id) ? depth.get(sc.id) : maxD + 1].push(sc);
  const node = sc => { const st = statusOf(sc); return `<div class="node ${depth.has(sc.id) ? '' : 'lone'}" data-node="${sc.id}">
      <div class="nh"><b>${esc(sc.name)}</b><span class="st ${st}">${ST[st]}</span></div>${frame(sc, mainVariant(sc), w, z)}</div>`; };
  b.innerHTML = `<div class="legend"><span><i></i>앞으로 가는 길</span><span><i class="back"></i>되돌아가는 길</span><span>점선 테두리: 화면 안 링크로는 닿지 않고 공통 내비로만 들어가는 화면 · 폭 ${esc(w.name)}</span></div>
    <div class="map">${cols.map((c, i) => c.length ? `<div class="mcol"><h3>${i <= maxD ? (i ? `${i}단계` : '시작') : '내비로만 닿음'}</h3><div class="mstack" style="grid-template-rows:repeat(${Math.min(c.length, 5)}, auto)">${c.map(node).join('')}</div></div>` : '').join('')}<svg></svg></div>`;
  requestAnimationFrame(drawEdges);
}

function drawEdges() {
  const map = $('.map'); if (!map) return;
  const svg = map.querySelector('svg'), base = map.getBoundingClientRect();
  svg.setAttribute('width', map.scrollWidth); svg.setAttribute('height', map.scrollHeight);
  const box = id => { const n = map.querySelector(`[data-node="${id}"]`); if (!n) return null; const r = n.getBoundingClientRect(); return { l: r.left - base.left, r: r.right - base.left, y: r.top - base.top + 14, x: r.left }; };
  let paths = '';
  for (const [from, e] of edgesFrom) {
    const a = box(from); if (!a) continue;
    for (const to of e.to) {
      const c = box(to); if (!c) continue;
      const fwd = c.l > a.r;
      const d = fwd ? `M${a.r},${a.y} C${a.r + 50},${a.y} ${c.l - 50},${c.y} ${c.l},${c.y}`
        : `M${a.l},${a.y} C${a.l - 70},${a.y} ${c.r + 70},${c.y} ${c.r},${c.y}`;
      paths += `<path d="${d}" class="${fwd ? '' : 'back'}" data-from="${from}" data-to="${to}" marker-end="url(#ah${fwd ? '' : 'b'})"/>`;
    }
  }
  svg.innerHTML = `<defs><marker id="ah" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0L8,4L0,8z" style="fill:var(--edge);stroke:none;opacity:1"/></marker>
    <marker id="ahb" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0L8,4L0,8z" style="fill:var(--edge-back);stroke:none;opacity:1"/></marker></defs>${paths}`;
}

// frames load as they come near the view, and stay loaded
let io;
function observe() {
  io?.disconnect();
  io = new IntersectionObserver(es => es.forEach(e => {
    if (!e.isIntersecting) return;
    const f = e.target.querySelector('iframe'); io.unobserve(e.target);
    if (f && !f.src) { f.onload = () => fit(f); f.src = url(f.dataset.src); }
  }), { root: $('#board'), rootMargin: '800px' });
  document.querySelectorAll('.shot[data-screen]').forEach(s => io.observe(s));
}
// 전체 길이: the frame grows to the page's own height instead of one screenful
// 슬롯 표시: outline what plugins fill, in every frame (same origin)
const slots = f => { try { f.contentDocument.documentElement.classList.toggle('wf-show-slots', S.slots); } catch {} };
function fit(f) {
  slots(f);
  const z = parseFloat(f.style.transform.match(/scale\(([\d.]+)\)/)?.[1] || S.zoom);
  let hgt = +f.dataset.h;
  if (S.full) try { hgt = Math.max(hgt, f.contentDocument.documentElement.scrollHeight); } catch {}
  f.height = hgt; f.parentElement.style.height = Math.round(hgt * z) + 'px';
  if (S.view === 'map') drawEdges();
}

// focus: one screen big, live, its data-to links walk to the next screen
let F = null;
function openFocus(id, variant, width) {
  const sc = M.screens.find(x => x.id === id); if (!sc) return;
  const v = sc.variants.find(x => x.id === variant) || mainVariant(sc);
  F = { sc, v, w: M.widths.find(x => x.id === width) || F?.w || widthsOn()[0] || M.widths[0] };
  $('#f-title').textContent = `${sc.name}${v ? ' · ' + v.id.toUpperCase() : ' · 미작성'}`;
  $('#f-widths').innerHTML = M.widths.map(w => `<button data-fw="${w.id}" aria-pressed="${w === F.w}">${esc(w.name)}</button>`).join('');
  const f = $('#f-frame');
  if (v) { f.src = url(src(v, F.w)); $('#f-open').href = url(src(v, F.w)); $('#f-open').hidden = false; } else { f.removeAttribute('src'); f.srcdoc = '<p style="font:14px system-ui;color:#888;padding:24px">아직 와이어프레임이 없습니다.</p>'; $('#f-open').hidden = true; }
  if (!$('#focus').open) $('#focus').showModal();
  sizeFocus();  // after showModal: before it the dialog has no size to measure
}
// 맞춤 (default): the frame grows or shrinks to fill the room the dialog has, whole screen in view, so a 466px
// phone frame is not left tiny on a wide monitor. 실제 크기: one CSS pixel per pixel, scrolling when larger.
function sizeFocus() {
  if (!F) return;
  const f = $('#f-frame'), body = $('#focus .fbody');
  const W = (body.clientWidth || innerWidth) - 32, H = (body.clientHeight || innerHeight - 60) - 32;
  const s = S.actual ? 1 : Math.max(0.1, Math.min(W / F.w.w, H / F.w.h));
  f.width = F.w.w; f.height = F.w.h;
  f.style.transformOrigin = '0 0'; f.style.transform = s === 1 ? '' : `scale(${s})`;
  // the layout box stays at the frame's own size: margins give the scaled size back to the flow
  f.style.marginRight = `${F.w.w * (s - 1)}px`; f.style.marginBottom = `${F.w.h * (s - 1)}px`;
  $('#f-scale').textContent = Math.round(s * 100) + '%';
  $('#f-fit').setAttribute('aria-pressed', !S.actual); $('#f-actual').setAttribute('aria-pressed', !!S.actual);
}
$('#f-frame').addEventListener('load', e => {
  slots(e.target);
  try {
    e.target.contentDocument.addEventListener('click', ev => {
      const t = ev.target.closest('[data-to]'); if (!t) return;
      ev.preventDefault(); openFocus(t.dataset.to, null, F.w.id);
    });
  } catch {}
});

// controls
$('#view').addEventListener('click', e => { const v = e.target.closest('button')?.dataset.v; if (v) { S.view = v; controls(); render(); } });
$('#widths').addEventListener('change', () => { S.widths = [...document.querySelectorAll('#widths input:checked')].map(i => i.value); render(); });
$('#group').addEventListener('change', e => { S.group = e.target.value; render(); });
$('#status').addEventListener('change', e => { S.status = e.target.value; render(); });
$('#variants').addEventListener('change', e => { S.variants = e.target.value; render(); });
$('#full').addEventListener('change', e => { S.full = e.target.checked; render(); });
$('#slots').addEventListener('change', e => { S.slots = e.target.checked; save(); document.querySelectorAll('iframe').forEach(slots); });
let zt;
$('#zoom').addEventListener('input', e => { S.zoom = +e.target.value; $('#zoom-out').value = Math.round(S.zoom * 100) + '%'; clearTimeout(zt); zt = setTimeout(render, 120); });
// ⌘/Ctrl + wheel zooms the board, not the page
$('#board').addEventListener('wheel', e => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  S.zoom = Math.min(0.6, Math.max(0.1, +(S.zoom * (e.deltaY < 0 ? 1.1 : 0.9)).toFixed(3)));
  $('#zoom').value = S.zoom; $('#zoom-out').value = Math.round(S.zoom * 100) + '%';
  clearTimeout(zt); zt = setTimeout(render, 120);
}, { passive: false });
$('#board').addEventListener('click', e => {
  const g = e.target.closest('[data-goto]');
  if (g) { e.preventDefault(); document.getElementById('row-' + g.dataset.goto)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
  const p = e.target.closest('[data-pick]');
  if (p) { S.pick[p.dataset.pick] = p.dataset.v; render(); return; }
  const s = e.target.closest('.shot[data-screen]');
  if (s) openFocus(s.dataset.screen, s.dataset.variant, s.dataset.width);
});
$('#board').addEventListener('mouseover', e => {
  const n = e.target.closest('[data-node]')?.dataset.node;
  document.querySelectorAll('.map path[data-from]').forEach(p => {
    const on = n && (p.dataset.from === n || p.dataset.to === n);
    p.classList.toggle('hl', !!on); p.classList.toggle('dim', !!n && !on);
  });
  document.querySelectorAll('.node').forEach(x => x.classList.toggle('hl', x.dataset.node === n));
});
$('#f-widths').addEventListener('click', e => { const w = e.target.closest('[data-fw]')?.dataset.fw; if (w) openFocus(F.sc.id, F.v?.id, w); });
$('#f-close').addEventListener('click', () => $('#focus').close());
$('#f-fit').addEventListener('click', () => { S.actual = false; save(); sizeFocus(); });
$('#f-actual').addEventListener('click', () => { S.actual = true; save(); sizeFocus(); });
addEventListener('resize', () => { sizeFocus(); if (S.view === 'map') drawEdges(); });

// local dev (scripts/dev-frontend.py): a saved wireframe reloads just its frames; anything else reloads the board.
// On the deployed site /__reload does not exist and this stops after one try.
(async function poll(seen) {
  let r;
  try { r = await (await fetch('/__reload?since=' + (seen ?? ''), { cache: 'no-store' })).json(); } catch { return; }
  if (seen != null && r.files.length) {
    const fs = r.files.filter(f => f.startsWith('wireframes/')).map(f => f.slice('wireframes/'.length));
    if (fs.some(f => !f.startsWith('screens/') && !['wf.css', 'wf.js'].includes(f) && !f.endsWith('.md'))) return location.reload();
    if (fs.length) {
      await readEdges();
      document.querySelectorAll('iframe[src]').forEach(f => {
        if (fs.includes('wf.css') || fs.includes('wf.js') || fs.includes(f.dataset.file)) f.contentWindow?.location.reload();
      });
      if (F && (fs.includes('wf.css') || fs.includes('wf.js') || fs.includes(F.v?.file))) $('#f-frame').contentWindow?.location.reload();
      if (S.view === 'map') render();
    }
  }
  setTimeout(() => poll(r.stamp), 1000);
})();

load().catch(e => { $('#board').innerHTML = `<p>screens.json 을 읽지 못했습니다: ${esc(e.message)}</p>`; });
