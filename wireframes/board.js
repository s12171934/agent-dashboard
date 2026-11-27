// Wireframe board: every screen of the dashboard at every width on one page (격자), or as a map of how the screens
// lead to one another (흐름 지도). screens.json lists the screens; each variant is a file under screens/ drawn with
// wf.css. The board only reads; nothing here talks to a metric server.
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const ST = { none: '미작성', draft: '시안', picked: '확정', dropped: '보류' };
const KEY = 'wfboard.v1';

let M = null, ver = '', edgesFrom = new Map();
const S = { view: 'grid', widths: null, group: '', status: '', variants: 'all', full: false, slots: false, actual: false, zoom: 0.24, pick: {},
  hideAreas: [], hideSlots: [], sideClosed: false };
try { Object.assign(S, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch {}
// a narrow window starts with the settings folded away: the sidebar would cover the board
if (matchMedia('(max-width: 700px)').matches) S.sideClosed = true;

// 화면 영역: parts every screen shares, each one hidden in every frame when unchecked. The rules go into the frame
// (same origin) as a <style>, so a screen file needs nothing for it.
const AREAS = [
  { id: 'side', name: '사이드바 · 레일', css: '.wf-side { display: none !important; }' },
  { id: 'dock', name: '하단 탭 바', css: '.wf-dock, .wf-half > [data-shell] { display: none !important; }' },
  { id: 'status', name: '상태 바 (앱)', css: '.wf-app body::before { display: none !important; } .wf-app body { padding-top: 0 !important; } .wf-app .wf-screen { min-height: 100vh !important; }' },
  { id: 'head', name: '머리 줄 (제목 · 주요 행동)', css: '.wf-main > .wf-row:first-child { display: none !important; }' },
  { id: 'body', name: '본문', css: '.wf-main > :not(.wf-row:first-child) { display: none !important; }' },
  { id: 'half', name: '반접힘 보조 시트', css: '.wf-half > :not([data-shell]) { visibility: hidden !important; }' },
  { id: 'note', name: '설계 메모', css: '.wf-note { display: none !important; }' },
  { id: 'fold', name: '주름 선', css: 'body::after { display: none !important; }' },
];
// 플러그인 슬롯: every data-slot the screens use (read with their links in readEdges), each hidden when unchecked
let SLOTS = new Map();
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
  const slots = new Map();
  await Promise.all(M.screens.map(async sc => {
    const vs = sc.variants.filter(v => v.status === 'picked');
    const use = vs.length ? vs : sc.variants.filter(live);
    if (!use.length) return edgesFrom.set(sc.id, { to: new Set(sc.to || []), from: 'current' });
    const to = new Set();
    for (const v of use) {
      try {
        // the shell's navigation (data-shell: sidebar, dock, the sheet's nav row) leads everywhere; only the screen's own links count
        const doc = new DOMParser().parseFromString(await (await fetch(url(v.file), { cache: 'no-store' })).text(), 'text/html');
        for (const n of doc.querySelectorAll('[data-slot]')) slots.set(n.dataset.slot, (slots.get(n.dataset.slot) || 0) + 1);
        doc.querySelectorAll('[data-shell]').forEach(n => n.remove());
        for (const n of doc.querySelectorAll('[data-to]')) if (n.dataset.to !== sc.id) to.add(n.dataset.to);
      } catch {}
    }
    edgesFrom.set(sc.id, { to, from: 'wireframe' });
  }));
  SLOTS = new Map([...slots].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function controls() {
  $('#widths').innerHTML = M.widths.map(w => `<label title="${esc(w.env)}"><input type="checkbox" value="${w.id}" ${S.widths.includes(w.id) ? 'checked' : ''}> ${esc(w.name)}<small>${w.w}×${w.h}</small></label>`).join('');
  $('#areas').innerHTML = AREAS.map(a => `<label><input type="checkbox" value="${a.id}" ${S.hideAreas.includes(a.id) ? '' : 'checked'}> ${esc(a.name)}</label>`).join('');
  slotList();
  document.body.classList.toggle('side-closed', !!S.sideClosed);
  const g = $('#group');
  if (g.options.length === 1) g.insertAdjacentHTML('beforeend', M.groups.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join(''));
  g.value = S.group; $('#status').value = S.status; $('#variants').value = S.variants; $('#full').checked = S.full; $('#slots').checked = S.slots;
  $('#zoom').value = S.zoom; $('#zoom-out').value = Math.round(S.zoom * 100) + '%';
  document.querySelectorAll('#view button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === S.view));
  $('#variants-fld').hidden = S.view !== 'grid';
}

function slotList() {
  $('#slotlist').innerHTML = SLOTS.size ? [...SLOTS].map(([k, n]) => `<label><input type="checkbox" value="${esc(k)}" ${S.hideSlots.includes(k) ? '' : 'checked'}> <code>${esc(k)}</code><small>${n}</small></label>`).join('')
    : '<span class="meta">화면에 슬롯이 없습니다.</span>';
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

// 흐름 지도: screens sit on a regular grid (a column per step from 홈, at most MAP_ROWS high), with empty channels
// between every column and every row. Arrows run only in those channels as right-angled lines, so they never cross a
// screen: out of the source's right side, along the channel right of it, across the row channel above the target,
// down the channel left of the target, into its left side. Each channel gives every arrow its own lane.
const MAP_ROWS = 4, GX = 96, GY = 64, HEAD = 26;
let MAP = null;
function renderMap(b) {
  const scs = visible(), ids = new Set(scs.map(s => s.id)), w = widthsOn()[0] || M.widths[0], z = S.zoom * 0.8;
  const depth = new Map(), start = ids.has('home') ? 'home' : scs[0]?.id;
  if (start) { depth.set(start, 0); const q = [start]; while (q.length) { const c = q.shift(); for (const t of edgesFrom.get(c)?.to || []) if (ids.has(t) && !depth.has(t)) { depth.set(t, depth.get(c) + 1); q.push(t); } } }
  const maxD = Math.max(0, ...depth.values()), groups = Array.from({ length: maxD + 2 }, () => []);
  for (const sc of scs) groups[depth.has(sc.id) ? depth.get(sc.id) : maxD + 1].push(sc);
  // order inside a step by where their sources sit, so arrows run mostly level
  const rowOf = new Map();
  const nodeW = Math.round(w.w * z) + 14, nodeH = Math.round(w.h * z) + 14 + 24;
  const pos = new Map(), heads = [];
  let col = 0;
  groups.forEach((g, d) => {
    if (!g.length) return;
    const key = sc => { const src = scs.filter(x => (edgesFrom.get(x.id)?.to || new Set()).has(sc.id) && rowOf.has(x.id)).map(x => rowOf.get(x.id)); return src.length ? src.reduce((a, b) => a + b, 0) / src.length : 1e3; };
    g.sort((a, b) => key(a) - key(b));
    heads.push({ col, text: d <= maxD ? (d ? `${d}단계` : '시작') : '내비로만 닿음' });
    g.forEach((sc, k) => {
      const c = col + Math.floor(k / MAP_ROWS), r = k % MAP_ROWS;
      pos.set(sc.id, { c, r, x: GX + c * (nodeW + GX), y: HEAD + GY + r * (nodeH + GY) });
      rowOf.set(sc.id, r);
    });
    col += Math.ceil(g.length / MAP_ROWS);
  });
  const rows = Math.min(MAP_ROWS, Math.max(1, ...groups.map(g => g.length)));
  MAP = { pos, nodeW, nodeH, cols: col, rows };
  const W = GX + col * (nodeW + GX), H = HEAD + GY + rows * (nodeH + GY);
  const node = sc => { const st = statusOf(sc), p = pos.get(sc.id); return `<div class="node ${depth.has(sc.id) ? '' : 'lone'}" data-node="${sc.id}" style="left:${p.x}px;top:${p.y}px;width:${nodeW}px;height:${nodeH}px">
      <div class="nh"><b>${esc(sc.name)}</b><span class="st ${st}">${ST[st]}</span></div>${frame(sc, mainVariant(sc), w, z)}</div>`; };
  b.innerHTML = `<div class="legend"><span><i></i>앞으로 가는 길</span><span><i class="back"></i>되돌아가는 길</span><span>점선 테두리: 화면 안 링크로는 닿지 않고 공통 내비로만 들어가는 화면 · 폭 ${esc(w.name)}</span></div>
    <div class="map" style="width:${W}px;height:${H}px"><svg width="${W}" height="${H}"></svg>
    ${heads.map(h => `<h3 class="mhead" style="left:${GX + h.col * (nodeW + GX)}px">${h.text}</h3>`).join('')}${scs.map(node).join('')}</div>`;
  drawEdges();
}

function drawEdges() {
  const map = $('.map'); if (!map || !MAP) return;
  const { pos, nodeW, nodeH } = MAP, svg = map.querySelector('svg');
  const edges = [];
  for (const [from, e] of edgesFrom) for (const to of e.to) if (pos.has(from) && pos.has(to)) edges.push({ from, to, a: pos.get(from), b: pos.get(to) });
  // ports: a screen's outgoing arrows leave spread down its right side, incoming ones arrive spread down its left side
  const port = (list, n) => { const out = new Map(); list.forEach((e, i) => out.set(e, 30 + (nodeH - 40) * (i + 1) / (list.length + 1))); return out; };
  const outs = new Map(), ins = new Map();
  for (const e of edges) { (outs.get(e.from) || outs.set(e.from, []).get(e.from)).push(e); (ins.get(e.to) || ins.set(e.to, []).get(e.to)).push(e); }
  const oy = new Map(), iy = new Map();
  for (const [, l] of outs) { l.sort((p, q) => p.b.y - q.b.y || p.b.x - q.b.x); for (const [e, y] of port(l)) oy.set(e, y); }
  for (const [, l] of ins) { l.sort((p, q) => p.a.y - q.a.y || p.a.x - q.a.x); for (const [e, y] of port(l)) iy.set(e, y); }
  // channels: v<k> runs left of column k (right of column k-1), h<r> runs above row r
  const lanes = new Map(), take = k => { const n = lanes.get(k) || 0; lanes.set(k, n + 1); return n; };
  for (const e of edges) {
    e.v1 = `v${e.a.c + 1}`; e.v2 = `v${e.b.c}`;
    e.direct = e.v1 === e.v2;
    e.l1 = take(e.v1); if (!e.direct) { e.l2 = take(e.v2); e.h = `h${e.b.r}`; e.lh = take(e.h); }
  }
  const vx = (k, l) => { const c = +k.slice(1), n = lanes.get(k); return GX + c * (nodeW + GX) - GX + 10 + (GX - 20) * (l + 1) / (n + 1); };
  const hy = (k, l) => { const r = +k.slice(1), n = lanes.get(k); return HEAD + r * (nodeH + GY) + 8 + (GY - 16) * (l + 1) / (n + 1); };
  let paths = '';
  for (const e of edges) {
    const sx = e.a.x + nodeW, sy = e.a.y + oy.get(e), tx = e.b.x, ty = e.b.y + iy.get(e), x1 = vx(e.v1, e.l1);
    const pts = e.direct ? [[sx, sy], [x1, sy], [x1, ty], [tx, ty]]
      : (() => { const y = hy(e.h, e.lh), x2 = vx(e.v2, e.l2); return [[sx, sy], [x1, sy], [x1, y], [x2, y], [x2, ty], [tx, ty]]; })();
    const back = e.b.c <= e.a.c;
    paths += `<path d="M${pts.map(p => p.map(Math.round).join(',')).join('L')}" class="${back ? 'back' : ''}" data-from="${e.from}" data-to="${e.to}" marker-end="url(#ah${back ? 'b' : ''})"/>`;
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
// 슬롯 경계 표시: outline what plugins fill, in every frame (same origin); 화면 영역 · 플러그인 슬롯: hide what is unchecked
const hideCss = () => AREAS.filter(a => S.hideAreas.includes(a.id)).map(a => a.css)
  .concat(S.hideSlots.map(k => `[data-slot="${CSS.escape(k)}"] { display: none !important; }`)).join('\n');
const slots = f => {
  try {
    const d = f.contentDocument; if (!d?.documentElement) return;
    d.documentElement.classList.toggle('wf-show-slots', S.slots);
    let st = d.getElementById('wfboard-hide');
    if (!st) { st = d.createElement('style'); st.id = 'wfboard-hide'; (d.head || d.documentElement).append(st); }
    st.textContent = hideCss();
  } catch {}
};
// after a hide change: restyle every loaded frame, and refit them since 전체 길이 follows the page's height
const restyle = () => { save(); document.querySelectorAll('iframe').forEach(f => { slots(f); if (f.closest('.shot') && f.src) fit(f); }); };
function fit(f) {
  slots(f);
  const z = parseFloat(f.style.transform.match(/scale\(([\d.]+)\)/)?.[1] || S.zoom);
  let hgt = +f.dataset.h;
  if (S.view === 'map') return;  // map nodes keep one screenful: the grid's channels depend on their size
  if (S.full) try { hgt = Math.max(hgt, f.contentDocument.documentElement.scrollHeight); } catch {}
  f.height = hgt; f.parentElement.style.height = Math.round(hgt * z) + 'px';
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
$('#slots').addEventListener('change', e => { S.slots = e.target.checked; restyle(); });
$('#areas').addEventListener('change', () => { S.hideAreas = [...document.querySelectorAll('#areas input:not(:checked)')].map(i => i.value); restyle(); });
$('#slotlist').addEventListener('change', () => { S.hideSlots = [...document.querySelectorAll('#slotlist input:not(:checked)')].map(i => i.value); restyle(); });
// 전체 · 없음 above a list checks or clears all of it
$('#side').addEventListener('click', e => {
  const b = e.target.closest('[data-all]'); if (!b) return;
  document.querySelectorAll(`#${b.dataset.all} input`).forEach(i => { i.checked = b.dataset.on === '1'; });
  $('#' + b.dataset.all).dispatchEvent(new Event('change'));
});
const side = closed => { S.sideClosed = closed; save(); document.body.classList.toggle('side-closed', closed); };
$('#side-close').addEventListener('click', () => side(true));
$('#side-open').addEventListener('click', () => side(false));
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
addEventListener('resize', () => sizeFocus());

// local dev (scripts/dev-frontend.py): a saved wireframe reloads just its frames; anything else reloads the board.
// On the deployed site /__reload does not exist and this stops after one try.
(async function poll(seen) {
  let r;
  try { r = await (await fetch('/__reload?since=' + (seen ?? ''), { cache: 'no-store' })).json(); } catch { return; }
  if (seen != null && r.files.length) {
    const fs = r.files.filter(f => f.startsWith('wireframes/')).map(f => f.slice('wireframes/'.length));
    if (fs.some(f => !f.startsWith('screens/') && !['wf.css', 'wf.js'].includes(f) && !f.endsWith('.md'))) return location.reload();
    if (fs.length) {
      await readEdges(); slotList();
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
