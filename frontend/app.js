const $ = s => document.querySelector(s);
const fmt = n => n == null ? '–' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n));
const usd = n => n == null ? '—' : n >= 100 ? '$' + n.toFixed(0) : '$' + n.toFixed(2);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cut = (t, n) => { t = String(t ?? ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const hhmm = ts => ts ? new Date(ts).toLocaleTimeString('ko-KR', { hour12: false }) : '';
const ago = ts => { if (!ts) return ''; const s = (Date.now() - new Date(ts)) / 1000; return s < 60 ? Math.max(0, Math.round(s)) + '초 전' : s < 3600 ? Math.round(s / 60) + '분 전' : s < 86400 ? Math.round(s / 3600) + '시간 전' : Math.round(s / 86400) + '일 전'; };
const toDate = a => new Date(a.includes('T') ? a : a.replace(' ', 'T') + 'Z');
const human = sec => sec < 60 ? Math.round(sec) + '초' : sec < 3600 ? Math.round(sec / 60) + '분' : sec < 86400 ? `${Math.floor(sec / 3600)}시간 ${Math.round(sec % 3600 / 60)}분` : `${Math.floor(sec / 86400)}일 ${Math.round(sec % 86400 / 3600)}시간`;
const OPEN = st => st === 'run' || st === 'bg' || st === 'wait' || st === 'stalled';
const ctxPct = s => s.ctx_window ? s.ctx_now / s.ctx_window * 100 : 0;
const ctxLvl = s => { const p = ctxPct(s); return p >= 90 ? 'ctx-bad' : p >= 70 ? 'ctx-warn' : ''; };
const ctxTitle = s => s.ctx_window ? `${fmt(s.ctx_now)} / ${fmt(s.ctx_window)} (${Math.round(ctxPct(s))}%)` : '';
const ctxBar = s => s.ctx_window ? `<div class="ctxbar"><div class="${ctxLvl(s)}" style="width:${Math.min(100, ctxPct(s))}%"></div></div>` : '';
const durHM = sec => { const m = Math.floor(sec / 60); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
const lifetime = s => { if (!s.started) return ''; const end = OPEN(status(s)) ? Date.now() : new Date(s.last_ts || s.started); return durHM(Math.max(0, (end - toDate(s.started)) / 1000)); };
// Lifetime as a headline metric, HH:MM.
const lifeMetric = s => {
  if (!s.started) return '';
  const big = lifetime(s), small = '', open = OPEN(status(s));
  return `<div class="m life${open ? ' on' : ''}" title="시작 ${esc(new Date(toDate(s.started)).toLocaleString('ko-KR', { hour12: false }))}${open ? '' : ' · 마지막 기록까지'}"><span>${open ? '가동 중' : '가동(종료)'}</span><b>${big}</b>${small ? `<small> ${small}</small>` : ''}</div>`;
};
const lifeTag = s => s.started ? `<span title="시작 ${esc(new Date(toDate(s.started)).toLocaleString('ko-KR', { hour12: false }))}">${OPEN(status(s)) ? '가동' : '가동 · 종료'} ${lifetime(s)}</span>` : '';
const dur = (a, b) => { if (!a) return ''; const s = ((b ? new Date(b) : new Date()) - toDate(a)) / 1000; return s < 60 ? Math.round(s) + 's' : s < 3600 ? Math.round(s / 60) + 'm' : (s / 3600).toFixed(1) + 'h'; };
const total = s => s.tokens.input + s.tokens.cache_read + s.tokens.cache_write + s.tokens.output;
const modelKey = m => !m ? 'other' : /opus/.test(m) ? 'opus' : /fable|mythos/.test(m) ? 'fable' : /sonnet/.test(m) ? 'sonnet' : /haiku/.test(m) ? 'haiku' : /gpt|codex|o\d/.test(m) ? 'gpt' : 'other';
const modelName = m => (m || '모델 미상').replace(/^claude-/, '').replace(/^gpt-/, 'gpt-');
const modelChip = m => `<span class="model"><i style="background:var(--m-${modelKey(m)})"></i>${esc(modelName(m))}</span>`;
const STATUS_COLOR = s => ({ completed: 'var(--done)', failed: 'var(--bad)', blocked: 'var(--warn)', cancelled: 'var(--idle)' }[s]
  || (['dispatched', 'running', 'in_progress', 'ready'].includes(s) ? 'var(--run)' : 'var(--idle)'));
// The server decides from turn boundaries (Claude stop_reason/turn_duration, Codex task_started/complete)
// and Orca's agent hooks: run = turn open · bg = turn ended, background tasks (Bash, Monitor, async agents) still run
// · wait = turn ended < 30 min · stalled = turn open, silent 15 min+
// · idle = ended long ago · done = the worker's task settled (wins over everything).
function status(s) {
  if (s.role === 'worker' && ['completed', 'failed', 'cancelled'].includes(IX.tasks[s.task_id]?.status)) return 'done';
  return s.state || 'idle';
}
const famStatus = members => { const st = members.map(m => m.st); return ['run', 'stalled', 'bg', 'wait'].find(x => st.includes(x)) || 'idle'; };
const ST_LABEL = { run: '실행 중', bg: '백그라운드', wait: '입력 대기', stalled: '응답 없음', idle: '유휴', done: '완료', blocked: '선행 대기', planned: '생성 대기', starting: '기동 대기', unborn: '드라이버 미기동' };
function pill(st, s) {
  return `<ds-pill state="${st}" title="${esc(s.state_reason || '')}">${ST_LABEL[st]}${st === 'bg' && s.bg_tasks ? ' ' + s.bg_tasks : ''}${s.manual_idle && st === 'idle' ? '(수동)' : ''}${st === 'run' ? '' : ' · ' + ago(s.last_ts)}</ds-pill>`;
}
// A subagent still running while its parent's own turn has ended is a background agent: the parent shows 백그라운드.
const subBg = (s, a, own) => own !== 'done' && own !== 'run' && a.live && !s.live ? 'bg' : own;
const NOW_ROLE = { tool: '도구', assistant: '응답', user: '입력', system: '시스템' };
const ROLE = { coordinator: '코디네이터', worker: '워커', solo: '단독', sub: '서브에이전트' };

// Metric servers (api.js keeps the list): which are on, their names, and how the agents view shows them.
const srvOn = () => api.servers().filter(x => x.on);
const multiSrv = () => srvOn().length > 1;
const srvName = id => api.server(id)?.name || '';
// The server a row came from, as a badge, once more than one server is on.
const srvBadge = x => multiSrv() && x?.server ? `<span class="badge srv" title="메트릭 서버 ${esc(api.server(x.server)?.url || '')}">${esc(srvName(x.server))}</span>` : '';
let srvView = 'merged';  // merged | split: the agents view as one list, or one section per server
try { srvView = localStorage.getItem('adash.srvview') === 'split' ? 'split' : 'merged'; } catch {}
let state = null, view = 'agents', detail = null, runFull = null, hlTurn = null, openState = {}, goneOpen = false;
let onlyLive = false;
try { onlyLive = localStorage.getItem('adash.live') === '1'; } catch {}
$('#only-live').checked = onlyLive;
$('#only-live').onchange = e => { onlyLive = e.target.checked; try { localStorage.setItem('adash.live', onlyLive ? '1' : '0'); } catch {} gKey = ''; render(); };
// Theme and material: the 테마 button (<ds-theme-toggle>) and the 「색 편집」 panel (<ds-theme-editor>) are design
// system components; SVG charts read the CSS variables, so switching needs no re-render.
$('#theme-edit').onclick = () => { $('#theme-panel').hidden = !$('#theme-panel').hidden; };
// 「Orca 에 열린 것만」: only agents whose connected Orca terminal the server found (session.orca_focus), the same set
// that gets the 「Orca 에서 열기」 button. Combines with 「실행 중만」 (both must hold).
let onlyOrca = false;
try { onlyOrca = localStorage.getItem('adash.orca') === '1'; } catch {}
$('#only-orca').checked = onlyOrca;
$('#only-orca').onchange = e => { onlyOrca = e.target.checked; try { localStorage.setItem('adash.orca', onlyOrca ? '1' : '0'); } catch {} gKey = ''; render(); };

// ---------- model of the world ----------
function index() {
  const o = state.orca, tasks = {}, runOf = {}, runsByCoord = {};
  for (const r of o.runs) {
    (runsByCoord[r.coordinator_handle] ||= []).push(r);
    for (const t of o.tasks[r.id] || []) { tasks[t.id] = t; runOf[t.id] = r; }
  }
  const byId = Object.fromEntries(state.sessions.map(s => [s.id, s]));
  const subsOf = {};
  state.sessions.filter(s => s.parent).forEach(s => (subsOf[s.parent] ||= []).push(s));
  return { tasks, runOf, runsByCoord, byId, subsOf };
}
let IX = null;
const nameOf = s => (s.role === 'worker' && IX.tasks[s.task_id]?.display_name) || s.title;
// additive totals including subagents
const bothUse = x => ({ ...(x.skill_use || {}), ...Object.fromEntries(Object.entries(x.mcp_use || {}).map(([k, c]) => ['mcp:' + k, c])) });
const useOf = (x, key) => key === 'both_use' ? bothUse(x) : key in TOK_USE ? tokUse(x, key) : x[key];
const mergeUse = maps => maps.reduce((o, m) => { for (const [k, c] of Object.entries(m || {})) o[k] = (o[k] || 0) + c; return o; }, {});
// use_tok (server): skill / "mcp:<server>" -> [injected tokens, carried tokens, carried cost $]; one map per column.
const TOK_USE = { inj_use: 0, carry_use: 1, cost_use: 2 };
const tokUse = (x, key) => Object.fromEntries(Object.entries(x.use_tok || {}).map(([k, v]) => [k, v[TOK_USE[key]]]));
const sumUse = m => Object.values(m || {}).reduce((p, q) => p + q, 0);
// Stable colour per skill / MCP server name, so the same skill has the same colour in every row.
// Colours are handed out by overall usage rank from a palette of clearly different hues; names past it fall back to a hash.
const USE_PALETTE = ['#3b82f6', '#f97316', '#10b981', '#a855f7', '#ef4444', '#eab308', '#06b6d4', '#ec4899', '#84cc16', '#6366f1', '#14b8a6', '#f43f5e'];
let useRank = {};
const useColor = n => { if (useRank[n] !== undefined && useRank[n] < USE_PALETTE.length) return USE_PALETTE[useRank[n]]; let h = 0; for (const ch of n) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return `hsl(${h % 360} 45% 55%)`; };
function agg(s) {
  const subs = IX.subsOf[s.id] || [];
  const all = [s, ...subs];
  const sum = f => all.reduce((a, x) => a + (f(x) || 0), 0);
  return {
    cost: all.some(x => x.cost != null) ? sum(x => x.cost) : null,
    costKnown: all.every(x => x.cost != null),
    parts: ['input', 'cache_write', 'cache_read', 'output'].reduce((p, k) => (p[k] = sum(x => x.cost_parts?.[k]), p), {}),
    tok: ['input', 'cache_write', 'cache_read', 'output'].reduce((p, k) => (p[k] = sum(x => x.tokens[k]), p), {}),
    turns: sum(x => x.turns), tools: sum(x => x.tool_calls), skills: sum(x => x.skills),
    uses: Object.fromEntries(['skill_use', 'mcp_use', 'both_use', ...Object.keys(TOK_USE)].map(k => [k, mergeUse(all.map(x => useOf(x, k)))])), mcp: sum(x => Object.values(x.mcp_use || {}).reduce((p, q) => p + q, 0)),
    get both() { return this.skills + this.mcp; }, output: sum(x => x.tokens.output),
    slots: mergeSlots(all.map(x => x.slots)),
    ctx: s.ctx_now, live: all.some(x => x.live), subs,
  };
}
// Server buckets: 5-minute slot (epoch / 300 s) -> [input, cache_write, cache_read, output, cost].
function mergeSlots(hs) {
  const o = {};
  for (const h of hs) for (const [k, v] of Object.entries(h || {})) { const t = o[k] ||= [0, 0, 0, 0, 0]; v.forEach((x, i) => t[i] += x); }
  return o;
}
const isSubCoord = s => s.role === 'worker' && s.coordinates && s.own_handle;
const byStart = (a, b) => (a.started || '').localeCompare(b.started || '');
function buildFam(coord, handle, top, used, depth) {
  const kids = handle ? top.filter(w => w.role === 'worker' && w.coord_handle === handle && !used.has(w.path)).sort(byStart) : [];
  kids.forEach(k => used.add(k.path));
  const f = { handle, key: handle || coord?.path, coord, depth, workers: kids, subs: [] };
  if (depth < 5) {
    f.workers = kids.filter(k => !isSubCoord(k));
    f.subs = kids.filter(isSubCoord).map(k => buildFam(k, k.own_handle, top, used, depth + 1));
  }
  f.members = [coord, ...f.workers].filter(Boolean).concat(...f.subs.map(x => x.members));
  famTotals(f);
  f.runs = (handle && IX.runsByCoord[handle]) || [];
  return f;
}
function famTotals(f) {
  const aggs = f.members.map(agg);
  f.live = aggs.some(a => a.live);
  f.st = famStatus(f.members.map(m => ({ st: status(m) })));
  f.started = f.members.map(m => m.started || '').sort()[0] || '';
  f.cost = aggs.reduce((a, x) => a + (x.cost || 0), 0);
  f.costKnown = aggs.every(x => x.costKnown);
  f.turns = aggs.reduce((a, x) => a + x.turns, 0);
  f.tok = aggs.reduce((a, x) => a + Object.values(x.tok).reduce((p, q) => p + q, 0), 0);
}
function families() {
  const top = state.sessions.filter(s => !s.parent);
  const fams = [], used = new Set();
  // Top-level coordinators first; sub-coordinators are pulled in by their parent's subtree.
  for (const c of top.filter(s => s.role === 'coordinator').sort(byStart).reverse()) {
    if (used.has(c.path) || (c.own_handle && fams.some(f => f.handle === c.own_handle))) continue;
    used.add(c.path);
    fams.push(buildFam(c, c.own_handle, top, used, 0));
  }
  // Workers whose top coordinator session is outside the window: group under their parent handle.
  for (const w of top.filter(w => w.role === 'worker' && !used.has(w.path)).sort(byStart)) {
    if (used.has(w.path)) continue;
    fams.push(buildFam(null, w.coord_handle, top, used, 0));
  }
  const solos = top.filter(s => !used.has(s.path)).sort(byStart).reverse();
  // A run driven by a script in an Orca terminal (no agent session behind the handle) belongs under the
  // session that opened that terminal: the script is that coordinator's delegate.
  const chainTo = (list, s, path = []) => { for (const x of list) { if (x.coord === s) return [...path, x]; const r = chainTo(x.subs, s, [...path, x]); if (r) return r; } };
  const reDepth = (f, d) => { f.depth = d; f.subs.forEach(x => reDepth(x, d + 1)); };
  for (const f of [...fams]) {
    if (f.coord || !f.handle) continue;
    const by = termOwner(f.handle).by;
    if (!by || by.parent || !top.includes(by)) continue;  // opener hidden or out of the window: stay top-level
    let chain = chainTo(fams, by);
    if (!chain) {  // the opener is not a coordinator yet: give it a family of its own
      const i = solos.indexOf(by);
      if (i < 0) continue;
      solos.splice(i, 1); used.add(by.path);
      const host = buildFam(by, by.own_handle, top, used, 0);
      fams.push(host); chain = [host];
    }
    if (chain.some(x => x === f)) continue;
    fams.splice(fams.indexOf(f), 1);
    // A script is not a coordinator: its workers become the opener's own workers.
    const host = chain[chain.length - 1];
    f.workers.forEach(w => { w.viaScript = termOwner(f.handle).title || 'script'; w.viaHandle = f.handle; });
    host.workers.push(...f.workers);
    (host.drivers ||= []).push({ handle: f.handle, title: termOwner(f.handle).title || 'script', workers: f.workers, runs: f.runs });
    f.subs.forEach(x => { reDepth(x, host.depth + 1); host.subs.push(x); });
    host.runs = [...host.runs, ...f.runs];
    host.extra = [...(host.extra || []), f.handle];
    for (const x of chain) { x.members = x.members.concat(f.members); famTotals(x); }
  }
  // Order by start time only: it never changes, so cards do not jump on live updates.
  fams.sort((a, b) => b.started.localeCompare(a.started));
  return { fams, solos };
}

// ---------- routing ----------
function route() {
  const h = decodeURIComponent(location.hash.slice(1) || 'agents');
  if (h === 'projects') return { v: 'projects' };
  if (h.startsWith('s=')) return { v: 'session', id: h.slice(2) };
  if (h.startsWith('r=')) return { v: 'run', id: h.slice(2) };
  return { v: ['agents', 'compare', 'talk', 'tests', 'hidden'].includes(h) ? h : 'agents' };
}
addEventListener('hashchange', () => { hlTurn = null; detail = null; openState = {}; render(true); window.scrollTo(0, 0); });
const openSession = path => location.hash = 's=' + encodeURIComponent(path);
const openRun = id => location.hash = 'r=' + id;

// Hiding a coordinator hides its whole tree; hiding any session hides its subagents.
// A session whose worktree was deleted is out of view too (s.gone).
function hiddenSet(all) {
  const hid = new Set(all.filter(s => s.hidden || s.gone).map(s => s.path));
  for (let changed = true; changed;) {
    changed = false;
    const handles = new Set(all.filter(s => hid.has(s.path) && s.own_handle).map(s => s.own_handle));
    const ids = new Set(all.filter(s => hid.has(s.path)).map(s => s.id));
    for (const s of all) {
      if (hid.has(s.path)) continue;
      if ((s.role === 'worker' && handles.has(s.coord_handle)) || (s.parent && ids.has(s.parent))) { hid.add(s.path); changed = true; }
    }
  }
  return hid;
}

// A run belongs to its coordinator: hiding the coordinator hides its runs too (unless a visible session owns the handle).
function visibleRuns() {
  const shown = new Set(state.sessions.map(s => s.own_handle).filter(Boolean));
  const hidden = new Set(state.all.filter(s => state.hid.has(s.path) && s.own_handle).map(s => s.own_handle));
  return state.orca.runs.filter(r => shown.has(r.coordinator_handle) || !hidden.has(r.coordinator_handle));
}

// A driver creates Orca tasks lazily (or, on older driver code, never ahead of time), so its run holds only part of
// the plan. Every plan row of a started ticket without an Orca task in that run becomes a synthetic task there, so
// worker plans, ticket chips, bars and the graph show the union. Matching: task_id, else task_title within the run.
const PLAN_ROW_ST = { done: 'completed', spawned: 'dispatched' };
const planRowLabel = r => r.status === 'created' ? '생성 예정(태스크 등록됨)' : r.status === 'done' ? '완료' : r.status === 'spawned' ? '워커 실행' : '생성 예정';
function injectPlanTasks() {
  for (const p of state.ext_plans || []) for (const k of p.tickets || []) {
    const ts = k.run_id && state.orca.tasks[k.run_id];
    if (!ts) continue;
    const idOf = {};
    ts.forEach(t => { idOf[t.task_title] = t.id; });
    const missing = (k.sessions || []).filter(r => !(r.task_id && ts.some(t => t.id === r.task_id)) && !idOf[r.key]);
    missing.forEach(r => { idOf[r.key] = 'plan:' + (p.project || '') + ':' + r.key; });
    ts.push(...missing.map(r => ({ id: idOf[r.key], run_id: k.run_id, task_title: r.key, display_name: r.key, status: PLAN_ROW_ST[r.status] || 'planned',
      deps: JSON.stringify((r.deps || []).map(d => idOf[d]).filter(Boolean)), created_at: null, ticket_key: k.jira || null, place_hint: null, plan_row: r })));
  }
}

async function refresh() {
  // Merged over the metrics servers that are on; one that fails or speaks another API version is left out and named
  // in state.server_errors (shown with the collector health).
  state = await api.state();
  state.all = state.sessions;
  state.hid = hiddenSet(state.all);
  state.sessions = state.all.filter(s => !state.hid.has(s.path));
  injectPlanTasks();
  IX = index();
  renderHeader();
  notifyDecisions();
  render();
}

// Live updates rebuild the view's HTML, which drops every scroll position (the page and inner scrollers
// such as the relationship tree, worker-plan stages and timelines). Remember them and put them back.
function scrollKey(el) {
  if (el.id) return '#' + el.id;
  const cls = el.classList[0] || el.tagName;
  const peers = [...$('#view').querySelectorAll(el.classList[0] ? '.' + CSS.escape(cls) : el.tagName)];
  return cls + ':' + peers.indexOf(el);
}
function saveScroll() {
  const inner = [];
  $('#view').querySelectorAll('*').forEach(el => { if ((el.scrollTop || el.scrollLeft) && !el.classList.contains('log')) inner.push([scrollKey(el), el.scrollLeft, el.scrollTop]); });
  return { y: window.scrollY, x: window.scrollX, h: document.documentElement.scrollHeight, inner };
}
function restoreScroll(sv) {
  for (const [k, l, t] of sv.inner) {
    const el = k.startsWith('#') ? document.getElementById(k.slice(1)) : (() => { const [cls, i] = [k.slice(0, k.lastIndexOf(':')), +k.slice(k.lastIndexOf(':') + 1)]; return $('#view').querySelectorAll(/^[A-Z]+$/.test(cls) ? cls : '.' + CSS.escape(cls))[i]; })();
    if (el) { el.scrollLeft = l; el.scrollTop = t; }
  }
  if (window.scrollY !== sv.y || window.scrollX !== sv.x) window.scrollTo(sv.x, sv.y);
}

async function render(navigated) {
  if (!state) return;
  const sv = navigated ? null : saveScroll();
  try { showDecisions(); await renderView(navigated); } finally { if (sv) { restoreScroll(sv); requestAnimationFrame(() => restoreScroll(sv)); } }
}
async function renderView(navigated) {
  const r = route();
  const tab = r.v === 'session' || r.v === 'run' ? 'agents' : r.v;
  document.querySelectorAll('#dock a').forEach(a => a.classList.toggle('on', a.dataset.v === tab));
  if (r.v !== 'talk') talkMounted = false;
  if (r.v !== 'compare') cmpMounted = false;
  if (r.v !== 'tests') testsMounted = false;
  if (r.v === 'agents') renderAgents();
  else if (r.v === 'compare') renderCompare();
  else if (r.v === 'talk') await renderTalk();
  else if (r.v === 'tests') await renderTests();
  else if (r.v === 'hidden') renderHidden();
  else if (r.v === 'projects') await renderProjects();
  else if (r.v === 'run') { runFull = await api.run(r.id); renderRun(r.id); }
  else if (r.v === 'session') {
    detail = await api.session(r.id);
    if (!detail) { $('#view').innerHTML = '<a class="back" href="#agents">← 에이전트</a><div class="empty">세션을 찾을 수 없습니다.</div>'; return; }
    renderSession(navigated);
  }
}

function renderHeader() {
  const ss = state.sessions;
  $('#k-live').textContent = ss.filter(s => s.live).length;
  const bg = ss.filter(s => status(s) === 'bg').length;
  $('#k-bg').textContent = bg;
  $('#k-bg-wrap').hidden = !bg;
  $('#k-agents').textContent = ss.length;
  const priced = ss.filter(s => s.cost != null);
  $('#k-cost').textContent = usd(priced.reduce((a, s) => a + s.cost, 0)) + (priced.length < ss.length ? '+' : '');
  $('#k-tokens').textContent = fmt(ss.reduce((a, s) => a + total(s), 0));
  $('#k-turns').textContent = fmt(ss.reduce((a, s) => a + s.turns, 0));
  { const n = state.all.filter(s => s.hidden).length; $('#k-hidden').textContent = n; $('#k-hidden').hidden = !n; }
  { const n = testItems().filter(testLive).length; $('#k-tests').textContent = n; $('#k-tests').hidden = !n; }
  $('#k-runs').textContent = state.orca.error ? '오류' : visibleRuns().filter(r => (state.orca.tasks[r.id] || []).some(t => !['completed', 'failed', 'cancelled'].includes(t.status))).length;
  renderHealth();
  const dec = state.decisions || { available: false, pending: [] };
  $('#k-dec-wrap').hidden = !dec.available;
  $('#k-dec').textContent = dec.pending.length;
  $('#k-dec-wrap').classList.toggle('on', dec.pending.length > 0);
}
// Header 「결정 대기」: the oldest question's session, or the agents list where unmatched ones are shown.
$('#k-dec-wrap').onclick = () => {
  const r = state?.decisions?.pending?.[0], s = r && state.all.find(x => x.decision?.id === r.id);
  location.hash = s ? 's=' + encodeURIComponent(s.path) : 'agents';
};

// Browser notification for each new 결정 대기 question; clicking it opens the question's session (or the agents list).
// What is already pending when the page opens counts as seen, so a reload does not replay it, and an answered
// question's notification is closed. Permission can only be asked from a gesture: the page's first click.
// Notification exists only in a secure context, so the Tailscale http address goes without.
const decNotes = new Map();  // request id -> its Notification, or null when it was seen without one
let decPrimed = false;
function notifyDecisions() {
  const dec = state.decisions;
  if (!dec?.available) return;  // 8799 down: keep what was seen, so its questions do not ring again on reconnect
  const ids = new Set(dec.pending.map(q => q.id));
  for (const [id, n] of decNotes) if (!ids.has(id)) { n?.close(); decNotes.delete(id); }
  const on = decPrimed && window.Notification?.permission === 'granted';
  for (const q of dec.pending) {
    if (decNotes.has(q.id)) continue;
    const s = state.all.find(x => x.decision?.id === q.id), q0 = q.questions?.[0] || {};
    let n = null;
    if (on) {
      n = new Notification('결정 대기 · ' + cut(s ? nameOf(s) : q.agent || '에이전트', 40),
        { body: [q0.header, q0.question].filter(Boolean).join(' · ') + (q.questions?.length > 1 ? ` 외 ${q.questions.length - 1}건` : ''), tag: 'dec-' + q.id });
      n.onclick = () => { window.focus(); location.hash = s ? 's=' + encodeURIComponent(s.path) : 'agents'; n.close(); };
    }
    decNotes.set(q.id, n);
  }
  decPrimed = true;
}
if (window.Notification?.permission === 'default') document.addEventListener('click', () => Notification.requestPermission(), { once: true });

// 결정 버튼 cards for the current screen: a session's own questions on its page; on the agents list, questions
// whose session is not listed (hidden, outside the window, or asked by a script), so none is out of sight.
function showDecisions() {
  const pending = state.decisions?.pending || [], r = route();
  const sessOf = q => state.all.find(s => s.decision?.id === q.id);
  let items = [];
  if (r.v === 'session') {
    const s = state.all.find(x => x.path === r.id);
    items = s ? pending.filter(q => q.session_id && q.session_id === s.id) : [];
  } else if (r.v === 'agents') items = pending.filter(q => !state.sessions.some(s => s.decision?.id === q.id));
  decisions.show(items, pending, q => {
    const s = sessOf(q);
    return s ? { name: nameOf(s), href: r.v === 'session' ? null : '#s=' + encodeURIComponent(s.path) } : { name: (q.agent || '에이전트') + ' · 세션 목록에 없음' };
  });
}

// Server collector loops (state.health.loops: name -> {ok, error, at}). SSE pings keep 「실시간」 on even when a
// collector has stopped, so a loop whose last clean pass is older than its limit is called out here, as is a
// failure in the last 10 minutes. A refresh that failed in the page itself is shown the same way.
const LOOPS = { scan: ['세션 로그', 60], orca: ['Orca', 300], ext_plan: ['외부 계획', 60], history: ['지난 기록', 1800], decision: ['결정 버튼', 30] };
let refreshError = null;
function renderHealth() {
  const h = state?.health, el = $('#health');
  const stalled = [], failed = [];
  for (const [k, [name, limit]] of Object.entries(LOOPS)) {
    const l = h?.loops?.[k];
    if (!l) continue;
    if (!l.ok || h.now - l.ok > limit) stalled.push(name);
    if (l.error && h.now - l.at < 600) failed.push(`${name}: ${l.error}`);
  }
  if (refreshError) failed.unshift('화면 갱신: ' + refreshError);
  failed.unshift(...(state?.server_errors || []).map(e => '메트릭 서버 ' + e));
  el.hidden = !stalled.length && !failed.length;
  el.textContent = stalled.length ? `⚠ 수집 중단: ${stalled.join(', ')}` : `⚠ 오류 ${failed.length}`;
  el.title = failed.join('\n') || '마지막 정상 수집이 오래됐습니다. 서버 로그를 확인하세요.';
}

// ---------- agents (cards) ----------
// ---------- task plan (written by the agent with aplan) ----------
// One sort order for every tab: attention first, idle last; ties keep the given order (Array.sort is stable).
const byRank = (list, rank) => list.map((x, i) => ({ x, i, r: rank(x) })).sort((a, b) => a.r - b.r || a.i - b.i).map(o => o.x);
const sessRank = s => s.decision ? -1 : RANK[status(s)] ?? 5;  // a pending 결정 버튼 question leads
const ENDED = st => st === 'done' || st === 'idle';
const missed = (p, ended) => ended ? { ...p, steps: p.steps.map(x => x === 'run' || x === 'todo' ? 'miss' : x) } : p;
const pbar = p => `<div class="pbar">${p.steps.map(x => `<i class="${x}"></i>`).join('')}</div>`;
const planLine = (p, ended) => `<div class="pline"><b>계획 ${p.done}/${p.total}</b>${p.done === p.total ? ' · 모두 완료' : ended ? ` · <span class="miss-t">⚠ ${p.total - p.done}단계 표시 안 됨 (세션 종료)</span>` : p.cur_text ? ' · ' + (p.steps[p.cur] === 'fail' ? '✕ ' : '▶ ') + esc(p.cur_text) : ''}</div>`;
const STEP_IC = { done: '✓', skip: '–', fail: '✕', run: '●', todo: '' };

function planBox(d) {
  const plans = d.plans || [];
  if (!plans.length) return `<div class="box"><h3>작업 계획</h3><div class="st">이 세션은 아직 계획을 남기지 않았습니다. 에이전트가 <code>aplan set "단계…"</code> 로 단계를 적으면 여기에 진행이 그려집니다.</div></div>`;
  const p = plans[plans.length - 1], done = p.steps.filter(x => x.st === 'done' || x.st === 'skip').length;
  const prev = plans.slice(0, -1).reverse();
  const miss = ENDED(status(d)) ? p.steps.length - done : 0;
  return `<div class="box"><h3>작업 계획 <span class="st">${done}/${p.steps.length} 완료${miss ? ` · <span class="miss-t">⚠ ${miss}단계 표시 안 됨</span>` : ''}${plans.length > 1 ? ` · 지시 ${plans.length}건 중 최근` : ''}</span></h3>
    ${p.prompt ? `<div class="st" style="margin:-4px 0 10px">지시: ${esc(cut(p.prompt, 160))}</div>` : ''}
    <div class="plan-grid"><div>${stepList(p, ENDED(status(d)))}</div><div id="plan-chart"></div></div>
    ${prev.length ? `<details id="d-prevplans" style="margin-top:8px" ${openState.prevplans ? 'open' : ''}><summary class="st">이전 지시의 계획 ${prev.length}건</summary>${prev.map(q => `<div style="margin-top:10px"><div class="st" style="margin-bottom:6px">${hhmm(q.ts)} · ${esc(cut(q.prompt || '', 100))}</div>${stepList(q, true)}</div>`).join('')}</details>` : ''}</div>`;
}

function stepList(p, ended) {
  return `<ol class="steps">${p.steps.map((x, i) => { const st = ended && (x.st === 'run' || x.st === 'todo') ? 'miss' : x.st; return `<li class="${st}"><span class="ic">${st === 'miss' ? '?' : STEP_IC[x.st] || i + 1}</span>
    <span class="tx">${esc(x.t)}${x.note ? `<span class="nt">${esc(x.note)}</span>` : ''}</span>
    <span class="du">${st === 'miss' ? '표시 안 됨' : x.ts0 ? (x.st === 'run' ? dur(x.ts0) + '째' : x.ts1 ? dur(x.ts0, x.ts1) : '') : ''}</span></li>`; }).join('')}</ol>`;
}

// Burn-up: planned total (dashed step line) against completed steps over time.
function planChart(d) {
  const el = $('#plan-chart'), plans = d.plans || [];
  if (!el || !plans.length) return;
  const p = plans[plans.length - 1], H = p.hist;
  const w = el.clientWidth || 400, h = 170, pl = 28, pr = 10, pt = 10, pb = 20, iw = w - pl - pr, ih = h - pt - pb;
  const live = !ENDED(status(d)) && p.steps.some(x => x.st === 'run');  // an ended session's chart stops at its last record
  const t0 = new Date(p.ts).getTime(), t1 = Math.max(live ? Date.now() : new Date(H[H.length - 1][0]).getTime(), t0 + 60e3);
  const max = Math.max(...H.map(r => r[2]), 1);
  const X = ts => pl + (new Date(ts).getTime() - t0) / (t1 - t0) * iw, Y = v => pt + ih - v / max * ih;
  const path = k => { let dd = `M${pl},${Y(H[0][k])}`; for (const r of H) dd += ` H${X(r[0])} V${Y(r[k])}`; return dd + ` H${pl + iw}`; };
  let g = `<svg width="${w}" height="${h}">`;
  for (let v = 0; v <= max; v += Math.ceil(max / 5)) g += `<line x1="${pl}" x2="${w - pr}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)"/><text x="${pl - 5}" y="${Y(v) + 3}" text-anchor="end">${v}</text>`;
  g += `<path d="${path(1)} V${Y(0)} H${pl} Z" fill="color-mix(in srgb, var(--done) 18%, transparent)"/>`;
  g += `<path d="${path(2)}" fill="none" stroke="var(--muted)" stroke-dasharray="4 3"/><path d="${path(1)}" fill="none" stroke="var(--done)" stroke-width="2"/>`;
  p.steps.forEach((x, i) => { if (x.ts1 && x.st !== 'fail') g += `<circle cx="${X(x.ts1)}" cy="${Y(H.find(r => r[0] >= x.ts1)?.[1] ?? 0)}" r="3.5" fill="var(--done)"><title>${i + 1}. ${esc(x.t)} · ${hhmm(x.ts1)}</title></circle>`; });
  g += `<text x="${pl}" y="${h - 4}">${hhmm(p.ts)}</text><text x="${w - pr}" y="${h - 4}" text-anchor="end">${live ? '지금' : hhmm(H[H.length - 1][0])}</text>`;
  el.innerHTML = g + `</svg><div class="legend" style="margin-top:2px"><span><i style="background:var(--done)"></i>완료 단계</span><span><i style="background:var(--muted)"></i>계획 단계 수</span></div>`;
}

// ---------- placement: project (repo) · worktree · branch · sub-path, resolved by the server from cwd ----------
const placeKey = p => p ? p.path || p.project : '?';  // a worktree is one group; sub-folders inside it are not split
const wtShort = p => !p ? '위치 미상' : p.worktree && p.worktree !== p.project ? p.worktree : p.project;
// Compact form for tree labels: the sub-folder stays visible even when the worktree name is long.
const placeTag = p => !p ? '위치 미상' : `${cutW(p.project, 18)}${p.worktree && p.worktree !== p.project ? ' · ' + cutW(p.worktree, p.sub ? 16 : 30) : ''}${p.sub ? ' / ' + cutW(p.sub.split('/').pop(), 20) : ''}`;
const wtTag = p => !p ? '위치 미상' : `${p.worktree && p.worktree !== p.project ? cutW(p.worktree, p.sub ? 14 : 30) : '저장소 루트'}${p.branch && p.branch !== p.worktree ? ` (${cutW(p.branch, 12)})` : ''}${p.sub ? ' / ' + cutW(p.sub.split('/').pop(), 13) : ''}`;
const placeLabel = p => !p ? '위치 미상' : `${p.project}${p.worktree && p.worktree !== p.project ? ' · ' + p.worktree : p.main && p.branch ? ' · 메인' : ''}${p.branch && p.branch !== p.worktree ? ` (${p.branch})` : ''}${p.sub ? ' / ' + p.sub : ''}`;
// A planned task has no worker yet: take its placement from the "배치: …" line the server extracts from the spec
// (place_hint), else assume the coordinator's worktree.
function plannedPlace(t, coordPlace) {
  if (t.place_hint) {
    const want = t.place_hint, known = state.sessions.map(x => x.place).filter(Boolean);
    const hit = known.find(p => want === p.path || want.startsWith(p.path + '/') || want === p.worktree || want.endsWith('/' + p.worktree));
    if (hit) return { ...hit, guess: false };
    if (!/^current$/i.test(want)) return { project: want.split('/').filter(Boolean).slice(-2, -1)[0] || want, worktree: want.split('/').filter(Boolean).pop(), path: want, guess: false };
  }
  return coordPlace ? { ...coordPlace, guess: true } : null;
}

// ---------- coordinator worker plan: its Runs' Tasks, planned (Task row) → spawned (worker session) → settled ----------
const WP_LABEL = { planned: '계획됨', blocked: '선행 대기', spawned: '워커 실행', done: '완료', fail: '실패' };
const WP_IC = { planned: '', blocked: '…', spawned: '●', done: '✓', fail: '✕' };
// ---------- time estimates ----------
// A task's expected run time comes from sibling tasks that already finished in the same Orca run
// (same model when available): they got the same kind of brief, so their times cluster. Measured on this
// machine, step-based estimates from a single session's own plan were too uneven to be useful.
const TASK_NAME = /^([A-Z]+\d+)(?:#(\d+))?\s*(.*)$/;
const taskName = t => t.display_name || t.task_title || '';
const roleOf = t => { const m = TASK_NAME.exec(taskName(t)); return m ? (m[3] || '').trim() : taskName(t); };
let EST = null;
const msOf = x => x ? toDate(x).getTime() : null;
const median = a => { const v = [...a].sort((x, y) => x - y); return v.length % 2 ? v[v.length >> 1] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2; };
const mins = ms => Math.max(1, Math.round(ms / 60e3)) + '분';
const SETTLED_T = ['completed', 'failed', 'cancelled'];
function estIndex() {
  if (EST && EST.v === state) return EST;
  const sess = {}, durs = {};
  // A re-engaged worker session serves several tasks in turn (e.g. 구현 then 판정); map every one of them.
  (state.all || state.sessions).forEach(x => { if (!x.parent) (x.task_ids || (x.task_id ? [x.task_id] : [])).forEach(id => (sess[id] = x)); });  // hidden siblings still count
  for (const [rid, ts] of Object.entries(state.orca.tasks || {})) for (const t of ts) {
    const w = sess[t.id];
    if (t.status !== 'completed' || !w?.started) continue;
    const ms = (msOf(t.completed_at) || msOf(w.last_ts)) - Math.max(msOf(w.started), msOf(t.created_at) || 0);  // a reused session starts the task later
    if (ms > 0) (durs[rid] ||= []).push({ ms, model: w.model, role: roleOf(t) });
  }
  return EST = { v: state, sess, durs };
}
function taskLeft(t) {
  if (SETTLED_T.includes(t.status)) return { left: 0, done: true };
  const w = estIndex().sess[t.id], ds = estIndex().durs[t.run_id] || [];
  const role = roleOf(t), byRole = ds.filter(d => d.role === role);
  const pool = byRole.length ? byRole : ds;
  const same = w?.model ? pool.filter(d => d.model === w.model) : [];
  const use = same.length ? same : pool;
  if (!use.length) return null;
  const v = use.map(d => d.ms), e = { ms: median(v), lo: Math.min(...v), hi: Math.max(...v), n: use.length, same: !!same.length, role: byRole.length ? role : null };
  if (!w) return { left: e.ms, e, planned: true };
  const el = Date.now() - Math.max(msOf(w.started), msOf(t.created_at) || 0);
  return { left: Math.max(0, e.ms - el), el, e, over: el > e.hi, paused: ['wait', 'stalled'].includes(status(w)) };
}
// Coordinator: longest chain of remaining work through task deps (a task starts when its deps finish).
function coordLeft(handle, extra = []) {
  const runs = [handle, ...extra].flatMap(h => (h && IX.runsByCoord[h]) || []);
  return tasksLeft(runs.flatMap(r => state.orca.tasks[r.id] || []));
}
function tasksLeft(tasks) {
  if (!tasks.length) return null;
  const byId = Object.fromEntries(tasks.map(t => [t.id, t]));
  const deps = t => { try { return JSON.parse(t.deps || '[]').filter(d => byId[d]); } catch { return []; } };
  const memo = {};
  let unknown = 0, paused = 0;
  const fin = id => {
    if (memo[id] !== undefined) return memo[id];
    memo[id] = 0;
    const r = taskLeft(byId[id]);
    if (!r) unknown++; else if (r.paused) paused++;
    return memo[id] = (r ? r.left : 0) + deps(byId[id]).reduce((m, d) => Math.max(m, fin(d)), 0);
  };
  const open = tasks.filter(t => !SETTLED_T.includes(t.status));
  if (!open.length) return { left: 0, done: true, n: tasks.length };
  const left = Math.max(...open.map(t => fin(t.id)));
  return { left, unknown, paused, open: open.length, n: tasks.length };
}
// Card metric: always rendered so the metric grid keeps its shape.
function estMetric(s) {
  let text = '–', title = '추정 근거 없음 (같은 Run 에 끝난 워커가 없거나 Orca 태스크가 아님)', cls = '';
  const delegated = delegatedOf(s);  // runs driven by script terminals it opened
  const c = (s.own_handle && IX.runsByCoord[s.own_handle]) || delegated.length ? coordLeft(s.own_handle, delegated) : null;
  if (c) {
    if (c.done) { text = '완료'; title = `태스크 ${c.n}개 모두 정리됨`; }
    else if (c.unknown === c.open) { title = `남은 태스크 ${c.open}개 · 끝난 형제 워커가 없어 아직 추정 불가`; }
    else {
      text = !c.unknown && c.left < 60e3 ? '곧' : (c.unknown ? '≥' : '') + durHM(c.left / 1000);
      title = `남은 태스크 ${c.open}개의 의존 경로 중 가장 긴 줄기 기준${c.unknown ? ` · ${c.unknown}개는 근거 없어 0으로 계산` : ''}${c.paused ? ` · ${c.paused}개는 입력 대기/응답 없음 (사람 응답 시간 제외)` : ''} · 예상 완료 ${new Date(Date.now() + c.left).toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit' })}`;
    }
  } else if (s.role === 'worker' && s.task_id && IX.tasks[s.task_id]) {
    const r = taskLeft(IX.tasks[s.task_id]);
    if (r?.done) { text = '완료'; title = '태스크 정리됨'; }
    else if (r) {
      const basis = `근거: 같은 Run${r.e.role ? ` · 같은 역할(${r.e.role})` : ''}${r.e.same ? ' · 같은 모델' : ''}의 끝난 워커 ${r.e.n}개 (${mins(r.e.lo)}~${mins(r.e.hi)}, 중앙 ${mins(r.e.ms)})`;
      if (r.paused) { text = '멈춤'; cls = 'est-pause'; title = `입력 대기/응답 없음 — 사람 응답 시간은 추정하지 않음 · ${basis}`; }
      else if (r.over) { text = '초과'; cls = 'est-over'; title = `경과 ${mins(r.el)} · 형제 최장 ${mins(r.e.hi)} 을 넘김 · ${basis}`; }
      else { text = r.left < 60e3 ? '곧' : durHM(r.left / 1000); title = `경과 ${mins(r.el)} · ${r.left < 60e3 ? '형제 중앙값을 지났고 최장 안쪽 · ' : ''}${basis}`; }
    }
  }
  return `<div class="m est" title="${esc(title)}"><span>남은 예상</span><b class="${cls}">${text}</b></div>`;
}

// A run's coordinator handle with no agent session behind it: usually an Orca terminal running a script
// (a deterministic driver), opened by some agent session. Name it from Orca's terminal list.
function termOwner(handle) {
  const t = (state.orca.terminals || []).find(x => x.handle === handle);
  const by = (state.all || state.sessions).find(x => (x.made_terms || []).includes(handle));
  return { t, by, title: t?.title || null };
}
const ownerName = h => { const o = termOwner(h); return o.by ? `${nameOf(o.by)} (스크립트 ${o.title || ''} 경유)` : o.title ? `${o.title} 스크립트` : '코디네이터 세션이 추적 범위 밖'; };
const ownerNote = h => {
  const o = termOwner(h);
  const what = o.title ? `에이전트 세션이 없는 Orca 터미널 (스크립트·수동 실행)${o.t.connected ? '' : ' · 연결 끊김'}` : 'Orca 터미널 목록에도 없음 (종료됨 또는 다른 기기)';
  return `${what}${o.by ? ` · 연 세션 <a href="#s=${encodeURIComponent(o.by.path)}">${esc(nameOf(o.by))}</a>` : ''}`;
};

const delegatedOf = s => (s?.made_terms || []).filter(h => IX.runsByCoord[h] && !(state.all || state.sessions).some(x => x.own_handle === h));
function workerPlan(handle, extra = []) {
  const runs = [handle, ...extra].flatMap(h => (h && IX.runsByCoord[h]) || []);
  const rows = runs.flatMap(r => (state.orca.tasks[r.id] || []).filter(t => t.plan_row?.kind !== 'driver').map(t => ({ t, r })));
  if (!rows.length) return null;
  const sess = {};
  state.sessions.forEach(x => { if (x.role === 'worker' && !x.parent) (x.task_ids || (x.task_id ? [x.task_id] : [])).forEach(id => (sess[id] = x)); });
  const coordPlace = state.sessions.find(x => x.own_handle === handle && !x.parent)?.place;
  const byId = Object.fromEntries(rows.map(x => [x.t.id, x.t]));
  const deps = t => { try { return JSON.parse(t.deps || '[]').filter(d => byId[d]); } catch { return []; } };
  const stage = {};
  const depth = id => { if (stage[id] !== undefined) return stage[id]; stage[id] = 0; return stage[id] = deps(byId[id]).reduce((m, d) => Math.max(m, depth(d) + 1), 0); };
  const items = rows.map(({ t, r }) => {
    const w = sess[t.id], open = deps(t).filter(d => byId[d].status !== 'completed').length;
    const st = t.status === 'completed' ? 'done' : ['failed', 'cancelled'].includes(t.status) ? 'fail'
      : w || t.status === 'dispatched' ? 'spawned' : open || t.status === 'blocked' ? 'blocked' : 'planned';
    return { id: t.id, name: t.display_name || t.task_title, st, label: t.plan_row && st === 'planned' ? planRowLabel(t.plan_row) : null, open, stage: depth(t.id), deps: deps(t).map(d => byId[d].display_name || byId[d].task_title), run: r, sess: w,
             place: w ? w.place : plannedPlace(t, coordPlace), live: w ? status(w) : null,
             created: t.created_at, spawned: w?.started, done: t.completed_at };
  }).sort((a, b) => a.stage - b.stage || (a.created || '').localeCompare(b.created || ''));
  // No deps at all: group by creation wave instead (tasks created within 3 minutes of each other form one batch).
  const byDeps = items.some(x => x.stage > 0);
  if (!byDeps) {
    let k = 0, prev = null;
    for (const x of items) { const t = x.created ? toDate(x.created).getTime() : 0; if (prev !== null && t - prev > 180e3) k++; x.stage = k; prev = t; }
  }
  const c = k => items.filter(x => x.st === k).length;
  return { items, byDeps, total: items.length, done: c('done'), fail: c('fail'), live: c('spawned'), waiting: c('planned') + c('blocked'),
           spawnedEver: items.filter(x => x.st === 'spawned' || x.st === 'done' || x.st === 'fail').length };
}
const wpSeg = x => x.st === 'spawned' && x.live && x.live !== 'run' && x.live !== 'bg' ? (x.live === 'stalled' ? 'fail' : 'wait') : x.st;
// Sessions a driver plan file lists that Orca has no task for yet. Under a driver that waits only for a launch
// slot they are 기동 대기; everything else not done (hold, predecessors, or inside a running driver) is 생성 예정.
// Only tickets without a run yet: once a driver starts, injectPlanTasks merges its rows into Orca's task list.
// onlyDriver limits it to the tickets one running driver terminal owns.
function planExtra(coord, onlyDriver) {
  let starting = 0, later = 0;
  for (const p of coord ? plansOf(coord) : []) for (const x of driverPlan(p).list) {
    if (onlyDriver && x.k.driver_terminal_handle !== onlyDriver) continue;
    if (x.k.run_id && state.orca.tasks[x.k.run_id]) continue;  // started tickets: injectPlanTasks already put these rows into the run's task list
    const n = (x.k.sessions || []).filter(y => y.kind !== 'driver' && y.status === 'planned' && !y.task_id).length;
    if (x.st === 'wait' && x.why?.k === 'start') starting += n; else if (x.st !== 'done') later += n;
  }
  return { starting, later };
}
// Work with no worker session yet, split by what it waits for. Same names/colours in bars, donuts and legends:
//   선행 대기  task in a running driver/run whose predecessor task is not done (yellow)
//   생성 대기  task in a running run with nothing blocking it; the next worker to launch (dashed grey)
//   기동 대기  ticket whose driver only waits for a launch slot (dashed blue)
//   드라이버 미기동  ticket whose driver has not started (hold or predecessor tickets) (faint dashed)
const PEND = [['blocked', '선행 대기'], ['planned', '생성 대기'], ['starting', '기동 대기'], ['unborn', '드라이버 미기동']];
const PEND_TIP = { blocked: '실행 중 Run 안에서 앞 단계 태스크가 끝나길 기다림', planned: '막힌 것 없이 워커 생성만 남음', starting: '선행 티켓은 끝났고 드라이버가 동시 실행 자리를 기다림', unborn: '드라이버가 아직 없음 (보류 또는 선행 티켓 대기)' };
function pendCounts(wp, ex = { starting: 0, later: 0 }) {
  const items = (wp?.items || []).filter(x => !x.sess && !['done', 'fail'].includes(x.st));
  return { blocked: items.filter(x => x.st === 'blocked').length, planned: items.filter(x => x.st !== 'blocked').length, starting: ex.starting, unborn: ex.later };
}
const swatch = k => `<i class="sw ${k}"></i>`;
const pendLine = (c, withZero) => PEND.filter(([k]) => withZero || c[k]).map(([k, l]) => `<span class="pend" title="${PEND_TIP[k]}">${swatch(k)}${l} <b${k === 'starting' && c[k] ? ' style="color:var(--accent)"' : ''}>${c[k]}</b></span>`).join('');
// Worker plan strip. Past ~100 entries one-cell-per-task stops being readable, so it becomes a proportional bar.
const WP_ORDER = ['done', 'spawned', 'wait', 'fail', 'blocked', 'planned', 'starting', 'unborn'];
const wpBar = (wp, ex = { starting: 0, later: 0 }) => {
  const steps = [...wp.items.map(wpSeg), ...Array(ex.starting).fill('starting'), ...Array(ex.later).fill('unborn')];
  const total = wp.total + ex.starting + ex.later;
  let bar;
  if (steps.length <= 100) bar = pbar({ steps });
  else {
    const c = steps.reduce((a, k) => (a[k] = (a[k] || 0) + 1, a), {});
    bar = `<div class="pbar prop">${WP_ORDER.filter(k => c[k]).map(k => `<i class="${k}" style="flex:${c[k]}" title="${({ done: '완료', spawned: '실행', wait: '대기', fail: '실패', blocked: '선행 대기', planned: '생성 대기', starting: '기동 대기', unborn: '드라이버 미기동' })[k]} ${c[k]}"></i>`).join('')}</div>`;
  }
  const pc = pendCounts(wp, ex), pend = pc.blocked + pc.planned + pc.starting + pc.unborn;
  return `<div class="wp-row">${bar}<div class="pline wp-leg"><b>워커 계획 ${wp.spawnedEver}/${total} 생성</b><span class="pend">${swatch('done')}완료 <b>${wp.done}</b></span>${wp.live ? `<span class="pend">${swatch('spawned')}실행 <b>${wp.live}</b></span>` : ''}${wp.fail ? `<span class="pend">${swatch('fail')}실패 <b>${wp.fail}</b></span>` : ''}${pend ? `<span class="pend-sep">생성 예정 ${pend} =</span>${pendLine(pc)}` : ''}</div></div>`;
};

function workerPlanBox(d) {
  const wp = workerPlan(d.own_handle, delegatedOf(d));
  if (!wp) return '';
  const stages = [];
  wp.items.forEach(x => (stages[x.stage] ||= []).push(x));
  const chip = x => {
    const body = `<span class="ic">${WP_IC[x.st]}</span><span><span class="nm">${esc(x.name)}</span><span class="meta">${x.st === 'spawned' && x.live ? '워커 ' + ST_LABEL[x.live] + (x.live === 'stalled' && x.sess.state_reason ? ' · ' + esc(x.sess.state_reason) : '') : x.label || WP_LABEL[x.st]}${x.deps.length ? ` · 선행: ${x.deps.map(esc).join(', ')}` : ''}${x.sess ? ' · ' + esc(modelName(x.sess.model)) : ''}${x.spawned && x.done ? ' · ' + dur(x.spawned, x.done) : x.spawned ? ' · ' + dur(x.spawned) + '째' : ''}</span><span class="meta wt" title="${esc(placeLabel(x.place))}">▣ ${esc(wtShort(x.place))}${x.place?.guess ? ' (예정 · 코디네이터와 같은 곳으로 가정)' : x.sess ? '' : ' (예정)'}</span></span>`;
    return x.sess ? `<a class="wchip ${x.st} ${x.st === 'spawned' ? 'lv-' + x.live : ''}" href="#s=${encodeURIComponent(x.sess.path)}">${body}</a>` : `<div class="wchip ${x.st}">${body}</div>`;
  };
  const groups = {};
  wp.items.forEach(x => { const k = placeLabel(x.place); groups[k] = (groups[k] || 0) + 1; });
  const cl = coordLeft(d.own_handle, delegatedOf(d));
  const eta = cl && !cl.done && cl.unknown < cl.open ? ` · 남은 예상 ${cl.unknown ? '≥' : ''}${durHM(cl.left / 1000)} (완료 약 ${new Date(Date.now() + cl.left).toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit' })})` : '';
  return `<div class="box"><h3>워커 생성 계획 <span class="st">Orca 태스크 ${wp.total} · 생성 ${wp.spawnedEver} · 완료 ${wp.done}${(() => { const pc = pendCounts(wp, planExtra(d)), n = pc.blocked + pc.planned + pc.starting + pc.unborn; return n ? ` · 생성 예정 ${n} = ${PEND.filter(([k]) => pc[k]).map(([k, l]) => `${l} ${pc[k]}`).join(' + ')}` : ''; })()}${eta}</span></h3>
    <div class="wt-sum">${Object.entries(groups).map(([k, n]) => `<span>▣ ${esc(k)} <b>${n}</b></span>`).join('')}</div>
    <div class="stages">${stages.map((g, i) => `<div class="stage ${stages.length < 2 ? 'wide' : ''}"><h4>${stages.length < 2 ? '태스크' : wp.byDeps ? `단계 ${i + 1}` : `생성 묶음 ${i + 1} · ${hhmm(g[0].created && toDate(g[0].created).toISOString())}`} · ${g.length}</h4>${g.map(chip).join('')}</div>`).join('')}</div>
    <div id="wp-chart" style="margin-top:10px"></div>
    <div class="st" style="margin-top:4px">태스크를 만든 시점이 계획, 워커 세션이 시작된 시점이 생성입니다. 열은 deps 가 있으면 의존 단계, 없으면 태스크를 함께 만든 묶음입니다.</div></div>`;
}

// Three step lines over time: tasks planned, workers spawned, tasks settled.
function wpChart(d) {
  const el = $('#wp-chart'), wp = el && workerPlan(d.own_handle, delegatedOf(d));
  if (!wp) return;
  const ev = k => wp.items.map(x => x[k]).filter(Boolean).map(t => toDate(t).getTime()).sort((a, b) => a - b);
  const S = [['created', 'var(--muted)', '계획', '4 3'], ['spawned', 'var(--ok)', '생성', ''], ['done', 'var(--done)', '완료', '']].map(([k, c, n, da]) => ({ c, n, da, t: ev(k) }));
  const all = S.flatMap(x => x.t);
  if (!all.length) return;
  const t0 = Math.min(...all), t1 = Math.max(wp.live || wp.waiting ? Date.now() : Math.max(...all), t0 + 60e3);
  const w = el.clientWidth || 600, h = 160, pl = 28, pr = 10, pt = 8, pb = 20, iw = w - pl - pr, ih = h - pt - pb, max = wp.total;
  const X = t => pl + (t - t0) / (t1 - t0) * iw, Y = v => pt + ih - v / max * ih;
  let g = `<svg width="${w}" height="${h}">`;
  for (let v = 0; v <= max; v += Math.max(1, Math.ceil(max / 5))) g += `<line x1="${pl}" x2="${w - pr}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)"/><text x="${pl - 5}" y="${Y(v) + 3}" text-anchor="end">${v}</text>`;
  for (const x of S) {
    if (!x.t.length) continue;
    let p = `M${pl},${Y(0)}`;
    x.t.forEach((t, i) => p += ` H${X(t)} V${Y(i + 1)}`);
    g += `<path d="${p} H${pl + iw}" fill="none" stroke="${x.c}" stroke-width="2" ${x.da ? `stroke-dasharray="${x.da}"` : ''}/>`;
  }
  g += `<text x="${pl}" y="${h - 4}">${hhmm(new Date(t0).toISOString())}</text><text x="${w - pr}" y="${h - 4}" text-anchor="end">${wp.live || wp.waiting ? '지금' : hhmm(new Date(t1).toISOString())}</text>`;
  el.innerHTML = g + `</svg><div class="legend">${S.map(x => `<span><i style="background:${x.c}"></i>${x.n} ${x.t.length}</span>`).join('')}</div>`;
}

// ---------- manual idle / hide (stored by the server, shared across devices) ----------
async function pref(action, paths, undo) {
  await api.pref(action, paths);
  await refresh();
  if (undo) toast(undo.msg, () => pref(undo.action, paths));
}
const toast = (msg, onUndo) => $('#toast').show(msg, onUndo ? { action: '되돌리기', onAction: onUndo } : {});
function actBtns(s, big) {
  const st = status(s), cls = big ? 'act big' : 'act';
  const idle = s.manual_idle ? `<button class="${cls} idle-w" data-act="unidle" data-path="${esc(s.path)}" title="수동 유휴를 풀고 자동 판정으로">자동 상태</button>`
    : st !== 'idle' && st !== 'done' ? `<button class="${cls} idle-w" data-act="idle" data-path="${esc(s.path)}" title="유휴로 표시 (새 기록이 생기면 자동으로 풀림)">유휴로</button>`
    : `<button class="${cls} idle-w slot" tabindex="-1" aria-hidden="true">유휴로</button>`;  // placeholder keeps the layout fixed
  const hide = s.hidden ? `<button class="${cls}" data-act="unhide" data-path="${esc(s.path)}">복원</button>`
    : `<button class="${cls}" data-act="hide" data-path="${esc(s.path)}" title="대시보드에서 숨김 (숨김 탭에서 복원)">숨김</button>`;
  // On a card the Orca buttons go to the bottom row (orcaBtns), so the state pill keeps its 「· n시간 전」.
  return `<span class="acts">${big ? orcaBtns(s, true) : ''}${idle}${hide}</span>`;
}
// 「Orca 에서 열기」 only where the server found the connected Orca terminal the agent runs in.
const focusBtn = (handle, big) => handle ? `<button class="${big ? 'act big' : 'act'} accent" data-act="focus" data-handle="${esc(handle)}" title="Orca 에서 이 터미널 탭으로 전환">Orca 에서 열기</button>` : '';
// 「Orca 에서 열기」 + 「닫기」 for a session. The session page's detail object comes from /api/session, which has no
// orca_focus; the snapshot row does. Closing a running agent is allowed; the confirm dialog warns about it.
function orcaBtns(s, big) {
  const focus = s.orca_focus ?? state.all?.find(x => x.path === s.path)?.orca_focus;
  if (!focus) return '';
  const cls = big ? 'act big' : 'act';
  return `${focusBtn(focus, big)}<button class="${cls} danger" data-act="close" data-handle="${esc(focus)}" data-path="${esc(s.path)}" title="Orca 에서 이 터미널을 닫음 (세션 기록은 남음)">닫기</button>`;
}
// Fold a repository group of a driver plan (agents list and session page alike).
document.addEventListener('click', e => {
  const b = e.target.closest('[data-rtoggle]');
  if (!b) return;
  e.stopPropagation();
  famMin[b.dataset.rtoggle] = b.dataset.open !== '1';  // true = open, as for the ticket rows inside
  try { localStorage.setItem('adash.min', JSON.stringify(famMin)); } catch {}
  render();
}, true);
// Capture phase: the button acts and the card under it does not open.
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  e.stopPropagation(); e.preventDefault();
  const a = b.dataset.act, p = b.dataset.path, all = state.all || state.sessions;
  const s = all.find(x => x.path === p), name = s ? nameOf(s) : '';
  if (a === 'hide') {
    const n = [...hiddenSet(all.map(x => x.path === p ? { ...x, hidden: true } : x))].filter(q => !state.hid.has(q)).length;
    pref('hide', [p], { msg: `"${cut(name, 30)}" 숨김${n > 1 ? ` (하위 ${n - 1}개 포함)` : ''}`, action: 'unhide' });
  } else if (a === 'unhide') pref('unhide', [p], { msg: `"${cut(name, 30)}" 복원`, action: 'hide' });
  else if (a === 'idle') pref('idle', [p], { msg: `"${cut(name, 30)}" 유휴로 표시`, action: 'unidle' });
  else if (a === 'unidle') pref('unidle', [p]);
  else if (a === 'unhide-all') pref('unhide', state.all.filter(x => x.hidden).map(x => x.path));
  else if (a === 'close') closeOrca(s, name, b.dataset.handle);
  else if (a === 'focus') api.focus(b.dataset.handle).then(r => toast(r.status === 200 ? 'Orca 에서 열었습니다' : r.body?.error || `Orca 전환 실패 (${r.status})`))
    .catch(() => toast('대시보드 서버에 보내지 못했습니다'));
}, true);

// 「닫기」: confirm, then close the session's Orca terminal. A coordinator also offers its tree (orca_close_tree, as the
// server mapped it: workers' terminals and the scripts it opened), checked by default; the server closes those first.
const isLive = x => status(x) === 'run' || agg(x).live;
function closeOrca(s, name, handle) {
  const below = s?.orca_close_tree || [], all = state.all || state.sessions;
  const kids = all.filter(x => x.orca_focus && below.includes(x.orca_focus));
  const busy = kids.filter(isLive).length, scripts = below.length - kids.length;
  const warn = t => `<p class="dialog-warn">⚠ ${t}</p>`;
  let d = $('#close-dlg');
  if (!d) { d = document.createElement('dialog'); d.id = 'close-dlg'; d.className = 'dialog'; document.body.appendChild(d); }
  d.innerHTML = `<form method="dialog">
    <h3>"${esc(cut(name, 40))}" 의 Orca 터미널을 닫을까요?</h3>
    ${s && isLive(s) ? warn('지금 실행 중입니다. 진행 중인 응답·도구 실행이 그 자리에서 끊깁니다.') : ''}
    <p>에이전트 프로세스가 끝납니다. 세션 기록은 남아 claude --resume 으로 이어 갈 수 있습니다.</p>
    ${below.length ? `<label class="cd-tree"><input type="checkbox" name="cascade" checked> 하위 터미널 ${below.length}개도 함께 닫기
      <span class="st">(${[kids.length && `워커 ${kids.length}`, scripts && `스크립트 ${scripts}`].filter(Boolean).join(' · ')}, 하위부터 닫음)</span></label>
      ${busy ? warn(`하위 워커 ${busy}개가 실행 중입니다.`) : ''}` : ''}
    <div class="dialog-btns"><button class="act big" value="">취소</button><button class="act big danger" value="ok">닫기</button></div></form>`;
  d.onclose = () => {
    if (d.returnValue !== 'ok') return;
    const cascade = !!d.querySelector('[name=cascade]')?.checked;
    api.close(handle, cascade).then(r => {
      if (r.status !== 202) return toast(r.body?.error || `닫기 실패 (${r.status})`);
      followClose(r.body.job, name, r.body.total);
    }).catch(() => toast('대시보드 서버에 보내지 못했습니다'));
  };
  d.returnValue = '';
  d.showModal();
}

// The server closes terminals in the background (each takes seconds; a busy Orca can take half a minute):
// show progress while it runs and the outcome once it ends.
async function followClose(job, name, total) {
  const who = `"${cut(name, 30)}"`;
  toast(total > 1 ? `${who} 와 하위 ${total - 1}개를 닫는 중…` : `${who} 터미널을 닫는 중…`);
  const t0 = Date.now();
  let j = null, shown = 0;
  while (Date.now() - t0 < 10 * 60e3) {
    await new Promise(r => setTimeout(r, 1500));
    try { j = await api.closeJob(job); } catch { continue; }
    if (!j) return toast(`${who} 닫기 결과를 찾을 수 없습니다 (대시보드 서버가 재시작됨)`);
    if (j.state === 'done') break;
    if (total > 1 && j.done !== shown && Date.now() - t0 > 4000) { shown = j.done; toast(`${who} 닫는 중… ${j.done}/${j.total}`); }
  }
  if (j?.state !== 'done') return toast(`${who} 닫기가 10분 넘게 끝나지 않았습니다`);
  const self = j.failed.find(f => f.handle === j.handle), below = j.failed.filter(f => f.handle !== j.handle);
  toast(self ? `${who} 닫기 실패: ${self.error}${below.length ? ` · 하위 ${below.length}개도 실패` : ''}`
    : `${who} 터미널을 닫았습니다${j.closed.length > 1 ? ` (하위 ${j.closed.length - 1}개 포함)` : ''}${below.length ? ` · 하위 ${below.length}개 실패: ${below[0].error}` : ''}`);
}

function renderHidden() {
  const hs = state.all.filter(s => s.hidden).sort((a, b) => (b.last_ts || '').localeCompare(a.last_ts || ''));
  const under = s => [...hiddenSet(state.all.map(x => ({ ...x, hidden: x.path === s.path, gone: false })))].length - 1;
  const gone = state.all.filter(s => s.gone && !s.parent && !s.hidden).sort((a, b) => (b.last_ts || '').localeCompare(a.last_ts || ''));
  $('#view').innerHTML = hs.length ? `<div class="sec-h"><h2>숨긴 세션 ${hs.length}</h2><span>코디네이터를 숨기면 그 아래 워커·하위 트리도 함께 숨겨집니다.</span>
      <button class="act big" data-act="unhide-all" style="margin-left:auto">모두 복원</button></div>
    <div class="grid">${hs.map(s => card(s, under(s) ? 'with-under' : '').replace('<div class="c-foot">', `${under(s) ? `<div class="st">함께 숨겨진 하위 ${under(s)}개</div>` : ''}<div class="c-foot">`)).join('')}</div>`
    : '<div class="empty">숨긴 세션이 없습니다. 카드나 세션 상세의 "숨김" 버튼으로 숨길 수 있습니다.</div>';
  // Deleted worktrees: listed for reference only; there is nothing to restore them to.
  if (gone.length) $('#view').innerHTML += `<details class="gone-sec" style="margin-top:18px" ${goneOpen ? 'open' : ''}><summary class="sec-h" style="cursor:pointer"><h2 style="display:inline">워크트리 삭제됨 ${gone.length}</h2> <span>작업 디렉터리가 디스크에서 사라진 세션은 자동으로 숨겨집니다.</span></summary>
    <div class="grid" style="margin-top:10px">${gone.map(s => card(s).replace(/<span class="acts">[\s\S]*?<\/span>/, '')).join('')}</div></details>`;
  { const el = $('#view .gone-sec'); if (el) el.ontoggle = () => goneOpen = el.open; }  // survives live re-renders
  $('#view').querySelectorAll('.card[data-path]').forEach(c => c.onclick = () => openSession(c.dataset.path));
}

const mcpName = n => n.replace(/^claude_ai_/, '').replace(/^plugin_([^_]+)_.*/, '$1').replace(/_/g, ' ');
const chipRow = (label, counts, color, nm = x => x) => {
  const e = Object.entries(counts || {}).sort((a, b) => b[1] - a[1]);
  return `<div class="chips"><b>${label}</b>${e.length ? e.map(([n, c]) => `<span class="chip" style="--c:var(${color})">${esc(nm(n))} <i>${c}</i></span>`).join('') : '<span class="st">없음</span>'}</div>`;
};

function card(s, cls) {
  const a = agg(s), win = s.ctx_window, pct = win ? Math.min(100, s.ctx_now / win * 100) : 0;
  const own = status(s), st = subBg(s, a, own), la = s.last_action;
  const t = s.role === 'worker' ? IX.tasks[s.task_id] : null;
  const role = s.role === 'coordinator' ? '<span class="badge coord">코디네이터</span>' : isSubCoord(s) ? '<span class="badge subcoord">하위 코디네이터</span>' : s.role === 'worker' ? `<span class="badge worker"${s.viaScript ? ` title="${esc(s.viaScript)} 스크립트가 띄운 워커"` : ''}>워커${s.viaScript ? ' · 스크립트' : ''}</span>` : '';
  return `<div class="card ${cls || ''} st-${st}" data-path="${esc(s.path)}">
    <div class="c-top"><span class="c-title" title="${esc(nameOf(s))}">${esc(nameOf(s))}</span>${s.decision ? '<span class="badge dec" title="카드를 열면 답할 수 있습니다">결정 대기</span>' : ''}${role}</div>
    <div class="c-top">${pill(st, s)}${actBtns(s)}</div>
    <div class="now" title="${esc(la?.text || '')}">${la ? `<b>${st === 'run' ? '지금' : '마지막'}</b>${esc(NOW_ROLE[la.role] || '')} · ${esc(la.text)}` : ''}</div>
    <div class="c-top">${modelChip(s.model)}<span class="badge">${s.kind}</span>${srvBadge(s)}${t ? `<span class="badge" style="color:${STATUS_COLOR(t.status)};border-color:currentColor">태스크 ${esc(t.status)}</span>` : ''}</div>
    <div class="c-metrics">
      <div class="m"><span>턴</span><b>${fmt(a.turns)}</b></div>
      <div class="m" title="${ctxTitle(s)}"><span>컨텍스트</span><b class="${ctxLvl(s)}">${fmt(s.ctx_now)}</b></div>
      <div class="m"><span>비용</span><b>${usd(a.cost)}</b>${a.cost != null && !a.costKnown ? '<small>+</small>' : ''}</div>
      <div class="m" title="${esc(Object.entries(a.uses.both_use).sort((x, y) => y[1] - x[1]).map(([n, c]) => `${METRICS.both.nm(n)} ${c}회`).join(', ') || '스킬·MCP 호출 없음')}"><span>스킬·MCP</span><b>${fmt(a.skills + a.mcp)}</b></div>
      ${lifeMetric(s)}${estMetric(s)}
    </div>
    <div class="ctxbar"><div class="${ctxLvl(s)}" style="width:${pct}%"></div></div>
    ${s.plan ? `<div>${pbar(missed(s.plan, ENDED(st)))}${planLine(s.plan, ENDED(st))}</div>` : ''}
    ${e2eCardHtml(s)}${testCardHtml(s)}
    <div class="c-foot"><span title="${esc(placeLabel(s.place))}">${a.subs.length ? `서브에이전트 ${a.subs.length} 포함 · ` : ''}▣ ${esc(wtShort(s.place))}</span>${s.orca_focus ? `<span class="acts">${orcaBtns(s)}</span>` : ''}</div>
  </div>`;
}

// Coordinators can collapse their worker list into a card-sized summary with a status donut.
// Default: collapsed when every agent below the coordinator is done or idle.
const BG_COLOR = 'color-mix(in srgb, var(--ok) 50%, var(--muted))';
let famMin = {};
try { famMin = JSON.parse(localStorage.getItem('adash.min') || '{}'); } catch {}
const DONUT = [['run', 'var(--ok)'], ['bg', BG_COLOR], ['stalled', 'var(--bad)'], ['wait', 'var(--warn)'], ['done', 'var(--done)'], ['idle', 'var(--idle)'], ['blocked', 'color-mix(in srgb, var(--warn) 45%, transparent)'], ['planned', 'color-mix(in srgb, var(--muted) 45%, transparent)'], ['starting', 'color-mix(in srgb, var(--accent) 45%, transparent)'], ['unborn', 'color-mix(in srgb, var(--muted) 18%, transparent)']];
// 「실행 중만」: inside a running tree keep only live sessions and the coordinators above them; finished leaves,
// pending placeholders and finished drivers drop out. Folding still works: a live tree starts open by default
// (isMin only auto-folds when everything below is done), and a manual fold is kept.
// A session that just stopped stays in the filtered view for LIVE_GRACE after its last record (subagents included):
// a driver often pauses between one worker ending and the next starting, and the tree should not flicker meanwhile.
const LIVE_GRACE = 60e3;
const liveNow = s => agg(s).live || status(s) === 'bg' || Date.now() - Math.max(...[s, ...(IX.subsOf[s.id] || [])].map(x => msOf(x.last_ts) || 0)) < LIVE_GRACE;
// A subagent runs in its parent's terminal.
const inOrca = s => !!(s.orca_focus || (s.parent && IX.byId[s.parent]?.orca_focus));
const filtering = () => onlyLive || onlyOrca;
const liveSess = w => (!onlyLive || liveNow(w)) && (!onlyOrca || inOrca(w));
const liveFam = f => !filtering() || f.members.some(liveSess) || (onlyLive && !onlyOrca && f.live);
// A script driver stays only while one of its sessions passes the filters (its own terminal does not count).
const liveDrv = d => !filtering() || d.workers.some(liveSess);
const shut = f => isMin(f);
const isMin = f => f.coord && !f.members.some(m => m.decision) && (famMin[f.key] ?? (!workerPlan(f.handle, f.extra)?.waiting && f.members.filter(m => m !== f.coord).every(m => ['done', 'idle'].includes(status(m)))));
const donut = (counts, total) => `<ds-donut segments="${DONUT.filter(([k]) => counts[k]).map(([k, c]) => `${counts[k]} ${c}`).join('; ')}" value="${counts.done || 0}/${total}" caption="완료"></ds-donut>`;
function miniFam(f) {
  const s = f.coord, below = f.members.filter(m => m !== s);
  const counts = below.reduce((a, m) => (a[status(m)] = (a[status(m)] || 0) + 1, a), {});
  // Tasks the coordinator (or its driver scripts) planned but no worker session has picked up yet.
  const pc = pendCounts(workerPlan(f.handle, f.extra), planExtra(s));
  for (const [k] of PEND) if (pc[k]) counts[k] = pc[k];
  const pend = pc.blocked + pc.planned + pc.starting + pc.unborn;
  // Sessions a driver plan lists but Orca has no task for yet: under a driver waiting only for a launch slot
  // they are 기동 대기, otherwise (hold, predecessors, or inside a running driver) 생성 예정.
  const total = below.length + pend;
  const own = status(s), sub = isSubCoord(s);
  return `<div class="card mini-fam ${sub ? '' : 'coord'} st-${f.st === 'run' ? 'run' : own}" data-path="${esc(s.path)}">
    <div class="c-top"><span class="c-title" title="${esc(nameOf(s))}">${esc(nameOf(s))}</span>${sub ? '<span class="badge subcoord">하위 코디네이터</span>' : '<span class="badge coord">코디네이터</span>'}</div>
    <div class="c-top">${pill(own, s)}${actBtns(s)}</div>
    <div class="c-top">${modelChip(s.model)}<span class="badge">${s.kind}</span>${srvBadge(s)}</div>
    <div class="mini-body">${donut(counts, total || 1)}
      <div class="mini-leg">${DONUT.filter(([k]) => counts[k]).map(([k, c]) => `<span${PEND_TIP[k] ? ` title="${PEND_TIP[k]}"` : ''}><i style="background:${c}${PEND_TIP[k] ? ';outline:1px dashed var(--muted);outline-offset:-1px' : ''}"></i>${ST_LABEL[k]} <b>${counts[k]}</b></span>`).join('') || '<span class="st">하위 에이전트 없음</span>'}</div></div>
    ${(() => { const wp = workerPlan(f.handle, f.extra); return wp ? wpBar(wp, planExtra(f.coord)) : ''; })()}
    <div class="c-metrics">
      <div class="m"${pend ? ` title="세션 ${below.length} + ${PEND.filter(([k]) => pc[k]).map(([k, l]) => l + ' ' + pc[k]).join(' + ')}"` : ""}><span>하위</span><b>${total}</b></div>
      <div class="m" title="${ctxTitle(s)}"><span>컨텍스트</span><b class="${ctxLvl(s)}">${fmt(s.ctx_now)}</b></div><div class="m"><span>합계 비용</span><b>${usd(f.cost)}${f.costKnown ? '' : '+'}</b></div><div class="m"><span>합계 턴</span><b>${fmt(f.turns)}</b></div>${lifeMetric(s)}${estMetric(s)}</div>
    ${ctxBar(s)}
    <div class="c-foot"><span>${f.runs[0] ? 'Run · ' + esc(f.runs[0].objective) : esc((s.cwd || '').split('/').pop())}</span><button class="tgl" data-toggle="${esc(f.key)}">▸ 펼치기</button></div>
  </div>`;
}

function famHtml(f) {
  const run = f.runs[0];
  const head = f.coord ? card(f.coord, 'coord') : `<div class="card coord" style="cursor:default"><div class="c-top"><span class="c-title">${esc(ownerName(f.handle))}</span><span class="badge coord">코디네이터</span></div><div class="st">${ownerNote(f.handle)} · ${esc(f.handle || '')}</div></div>`;
  const direct = [...f.workers, ...f.subs.map(x => x.coord).filter(Boolean)];
  const done = direct.filter(w => IX.tasks[w.task_id]?.status === 'completed').length;
  const all = f.members.filter(m => m !== f.coord);
  return `<div class="family ${f.depth ? 'nested' : ''} st-${f.st} ${f.live ? 'live' : ''}">${f.depth ? `<div class="nest-label">${f.viaTerm ? `스크립트 위임 · ${esc(f.viaTerm)} 터미널이 Run 을 맡음` : '하위 오케스트레이션'} · 깊이 ${f.depth + 1}</div>` : ''}${head}
    <div class="fam-sum"><span>직속 워커 <b>${f.workers.length}</b></span>${f.subs.length ? `<span>하위 코디네이터 <b>${f.subs.length}</b></span>` : ''}<span>완료 <b>${done}/${direct.length}</b></span>
      <span>실행 중 <b style="color:var(--ok)">${all.filter(w => status(w) === 'run').length}</b></span>${all.some(w => status(w) === 'bg') ? `<span>백그라운드 <b>${all.filter(w => status(w) === 'bg').length}</b></span>` : ''}<span>입력 대기 <b>${all.filter(w => status(w) === 'wait').length}</b></span>${all.some(w => status(w) === 'stalled') ? `<span>응답 없음 <b style="color:var(--bad)">${all.filter(w => status(w) === 'stalled').length}</b></span>` : ''}
      <span>${f.subs.length ? '하위 포함 ' : ''}합계 비용 <b>${usd(f.cost)}${f.costKnown ? '' : '+'}</b></span><span>합계 턴 <b>${fmt(f.turns)}</b></span><span>합계 토큰 <b>${fmt(f.tok)}</b></span>
      ${run ? `<span>Run <a href="#r=${run.id}" style="color:var(--accent)">${esc(cut(run.objective, 60))}</a>${f.runs.length > 1 ? ` 외 ${f.runs.length - 1}` : ''}</span>` : ''}
      ${f.coord ? `<button class="tgl" data-toggle="${esc(f.key)}" style="margin-left:auto">▾ 최소화</button>` : ''}</div>
    ${(() => { const wp = workerPlan(f.handle, f.extra); return wp ? wpBar(wp, planExtra(f.coord)) : ''; })()}
    ${f.coord ? plansOf(f.coord).map(p => `<div class="pline" style="padding:2px 2px 0">${drvPlanLine(driverPlan(p))}</div>${ticketStrip(driverPlan(p))}`).join('') : ''}
    ${f.workers.length || f.subs.length ? `<div class="tree">${(() => {
      // State first (attention → idle), and only within the same state do sub-coordinators lead plain workers.
      // Expanded sub-trees are full-width blocks, so they split the card grid where they fall in that order.
      const drv = new Set((f.drivers || []).map(d => d.handle));
      const kids = [...f.subs.filter(liveFam).map((x, i) => ({ r: famRank(x), sub: 1, i, fam: x })), ...f.workers.filter(w => !drv.has(w.viaHandle) && liveSess(w)).map((w, i) => ({ r: sessRank(w), sub: 0, i, w }))]
        .sort((a, b) => a.r - b.r || b.sub - a.sub || a.i - b.i);
      let out = '', cells = [];
      const flush = () => { if (cells.length) out += `<div class="grid">${cells.join('')}</div>`; cells = []; };
      for (const k of kids) {
        if (k.fam && !shut(k.fam)) { flush(); out += famHtml(k.fam); }
        else cells.push(k.fam ? miniFam(k.fam) : card(k.w));
      }
      flush();
      return out + driversHtml(f);
    })()}</div>` : ''}</div>`;
}
// Tickets inside a driver run, read from its task names ("S1#3 리뷰 codex" = ticket S1, checkbox 3, role).
// The Jira key comes from the worktree the ticket's workers ran in, else from the task specs.
// Returns '' when the run does not follow that naming, so the caller falls back to a plain worker list.
const TK_ST = { completed: 'done', failed: 'fail', cancelled: 'fail' };
const TK_IC = { done: '✓', fail: '✗', run: '●', bg: '◍', wait: '◐', stalled: '!', idle: '·', pending: '○', blocked: '◌' };
function taskState(t) {
  if (TK_ST[t.status]) return TK_ST[t.status];
  const w = estIndex().sess[t.id];
  if (w) return status(w) === 'done' ? 'done' : status(w);
  return t.status === 'blocked' ? 'blocked' : 'pending';
}
function ticketsOf(d) {
  const tasks = d.runs.flatMap(r => state.orca.tasks[r.id] || []);
  if (!tasks.length || tasks.some(t => !TASK_NAME.test(taskName(t)))) return null;
  const tks = new Map();
  for (const t of tasks) {
    const [, pkg, cb] = TASK_NAME.exec(taskName(t));
    let k = tks.get(pkg);
    if (!k) tks.set(pkg, k = { pkg, cbs: new Map(), tasks: [], keys: {} });
    k.tasks.push(t);
    const key = cb ? +cb : 0;
    if (!k.cbs.has(key)) k.cbs.set(key, []);
    k.cbs.get(key).push(t);
    const w = estIndex().sess[t.id], wk = /([A-Z]+-\d+)/.exec(w?.place?.worktree || '');
    if (wk) k.keys[wk[1]] = (k.keys[wk[1]] || 0) + 10;  // the worktree is the strongest hint
    else if (t.ticket_key) k.keys[t.ticket_key] = (k.keys[t.ticket_key] || 0) + 1;
  }
  const OPEN_ST = ['run', 'bg', 'wait', 'stalled'];
  const list = [...tks.values()].map(k => {
    k.key = Object.entries(k.keys).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    k.sts = k.tasks.map(taskState);
    k.active = k.sts.some(x => OPEN_ST.includes(x)) || k.sts.some(x => x === 'pending' || x === 'blocked');
    const nums = [...k.cbs.keys()].filter(n => n > 0);
    k.cbTotal = nums.length;
    k.cbDone = nums.filter(n => k.cbs.get(n).every(t => taskState(t) === 'done')).length;
    k.sessions = k.tasks.map(t => estIndex().sess[t.id]).filter(Boolean);
    k.cost = k.sessions.reduce((a, w) => a + (agg(w).cost || 0), 0);
    k.rank = Math.min(9, ...k.sts.map(x => RANK[x] ?? (x === 'pending' || x === 'blocked' ? 3 : x === 'fail' ? 4 : 5)));
    return k;
  });
  return list;
}
// activeOnly (「실행 중만」): just the tickets still in progress, without the finished sheet-only group.
function ticketsHtml(d, activeOnly) {
  const list = ticketsOf(d), OPEN_ST = ['run', 'bg', 'wait', 'stalled'];
  if (!list) return '';
  const natural = (a, b) => a.pkg.localeCompare(b.pkg, 'en', { numeric: true });
  const main = list.filter(k => activeOnly ? k.active : k.cbTotal || k.active).sort((a, b) => a.rank - b.rank || natural(a, b));
  const onlySheet = activeOnly ? [] : list.filter(k => !k.cbTotal && !k.active).sort(natural);
  const chip = t => {
    const st = taskState(t), w = estIndex().sess[t.id], role = roleOf(t) || '태스크';
    const lbl = `<i>${TK_IC[st] || '·'}</i>${esc(role)}`, tip = `${esc(taskName(t))} · ${esc(t.plan_row ? '계획: ' + planRowLabel(t.plan_row) : t.status)}${w ? ' · ' + esc(modelName(w.model)) : ''}`;
    return w ? `<a class="tkc ${st}" href="#s=${encodeURIComponent(w.path)}" title="${tip}">${lbl}</a>` : `<span class="tkc ${st}" title="${tip}">${lbl}</span>`;
  };
  const row = k => {
    const id = 'tk:' + d.handle + ':' + k.pkg, open = famMin[id] ?? k.sts.some(x => OPEN_ST.includes(x));
    const n = x => k.sts.filter(y => y === x).length, c = tasksLeft(k.tasks);
    const eta = !c || c.done ? '' : c.unknown === c.open ? '' : !c.unknown && c.left < 60e3 ? '남은 예상 곧' : `남은 예상 ${c.unknown ? '≥' : ''}${durHM(c.left / 1000)}`;
    const cbRows = [...k.cbs.entries()].sort((a, b) => a[0] - b[0]).map(([num, ts]) =>
      `<div class="cbr"><span class="cbn">${num ? '#' + num : '착수'}</span>${ts.sort((a, b) => (a.created_at || '~').localeCompare(b.created_at || '~')).map(chip).join('')}</div>`).join('');
    return `<div class="tk ${open ? 'open' : ''}">
      <div class="tk-h" data-ttoggle="${esc(id)}"><span class="tk-arrow">${open ? '▾' : '▸'}</span><b>${esc(k.pkg)}</b>${k.key ? `<span class="tk-key">${esc(k.key)}</span>` : ''}
        ${k.cbTotal ? `<span>체크박스 <b>${k.cbDone}/${k.cbTotal}</b></span>` : '<span>착수 단계</span>'}
        ${n('run') ? `<span>실행 중 <b style="color:var(--run)">${n('run')}</b></span>` : ''}${n('bg') ? `<span>백그라운드 <b>${n('bg')}</b></span>` : ''}${n('wait') ? `<span>입력 대기 <b style="color:var(--warn)">${n('wait')}</b></span>` : ''}${n('stalled') ? `<span>응답 없음 <b style="color:var(--bad)">${n('stalled')}</b></span>` : ''}${n('fail') ? `<span>실패 <b style="color:var(--bad)">${n('fail')}</b></span>` : ''}
        <span>워커 ${k.sessions.length}</span><span>${usd(k.cost)}</span>${eta ? `<span>${eta}</span>` : ''}
        <span class="tk-bar">${pbar({ steps: k.sts.map(x => x === 'done' ? 'done' : x === 'fail' || x === 'stalled' ? 'fail' : OPEN_ST.includes(x) ? (x === 'run' || x === 'bg' ? 'run' : 'wait') : '') })}</span></div>
      ${planTicketE2e(k.pkg)}
      ${open ? `<div class="tk-body">${cbRows}</div>` : ''}</div>`;
  };
  const sheetId = 'tksheet:' + d.handle, sheetOpen = !!famMin[sheetId];
  return `<div class="tks"><div class="tks-h">티켓 ${list.length} · 진행 ${main.filter(k => k.active).length}</div>${main.map(row).join('')}
    ${onlySheet.length ? `<div class="tk"><div class="tk-h" data-ttoggle="${esc(sheetId)}"><span class="tk-arrow">${sheetOpen ? '▾' : '▸'}</span><b>착수 시트만 끝난 티켓 ${onlySheet.length}</b><span>${onlySheet.map(k => esc(k.pkg)).join(' · ')}</span></div>
      ${sheetOpen ? `<div class="tk-body">${onlySheet.map(k => `<div class="cbr"><span class="cbn">${esc(k.pkg)}</span>${k.key ? `<span class="tk-key">${esc(k.key)}</span>` : ''}${k.tasks.map(chip).join('')}</div>`).join('')}</div>` : ''}</div>` : ''}</div>`;
}
// ---------- external driver plans: a roster written ahead of time by a driver script (server: ext_plans) ----------
const XP_KIND = { sheet: '착수 시트', impl: '구현', 'review-codex': '리뷰 codex', 'review-claude': '리뷰 claude', judge: '판정', driver: '드라이버', extra: '추가 태스크' };
const XP_TICKET = { verified: '검증 완료', closed: '1차 종결', running: '실행 중', ready: '준비됨', started: '착수', blocked: '선행 대기', planned: '계획됨',
  rebase_pending: '리베이스 대기', box_waiting: '체크박스 차례 대기', box_deferred: '체크박스 이월' };
// verified, or closed (first round wrapped up; deferred checkboxes move to a later batch)
const tkDone = k => k.status === 'verified' || k.status === 'closed';
const XP_PLAN = { planned: ['planned', '생성 예정'], created: ['planned', '생성 예정(태스크 등록됨)'], spawned: ['spawned', '워커 실행'], done: ['done', '완료'] };
const XP_CHIP = { done: 'done', fail: 'fail', spawned: 'run', planned: 'pending', blocked: 'blocked' };
function extPlanRow(x, ticket, byTitle, sess) {
  // The driver names its Orca task after the plan key; title matches count only inside the ticket's own run
  // (other runs reuse the same titles, e.g. test runs), so a ticket without a run matches by task_id alone.
  const t = (x.task_id && IX.tasks[x.task_id])
    || (ticket.run_id ? (byTitle[x.key] || []).filter(c => c.run_id === ticket.run_id).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))[0] : null);
  const w = t ? sess[t.id] : null;
  let st, label;
  if (t) {
    st = t.status === 'completed' ? 'done' : ['failed', 'cancelled'].includes(t.status) ? 'fail'
      : w || t.status === 'dispatched' ? 'spawned' : ['pending', 'blocked'].includes(t.status) ? 'blocked' : 'planned';
    label = st === 'spawned' && w ? '워커 ' + ST_LABEL[status(w)] : WP_LABEL[st];
  } else [st, label] = XP_PLAN[x.status] || ['planned', x.status || '상태 미상'];
  return { x, t, w, st, label, drv: x.kind === 'driver' };
}
// The full driver roster: one driver per ticket, ordered by repo chain then chain position.
// done = ticket verified · run = its driver terminal exists · wait = not created yet (hold / predecessors / launch slot).
function driverPlan(p) {
  const repos = [], seen = {}, verified = new Set(p.tickets.filter(tkDone).map(k => k.package));
  p.tickets.forEach(k => { if (!repos.includes(k.repo)) repos.push(k.repo); });
  const list = p.tickets.map(k => {
    const inRepo = p.tickets.filter(o => o.repo === k.repo);
    const pos = k.chain_position ?? inRepo.indexOf(k) + 1, len = k.chain_length ?? inRepo.length;
    // Only a ticket the driver reports as running is 실행. A driver also exits mid-ticket (rebase_pending: done, waiting for
    // the previous ticket in its chain; box_waiting: waiting for its next checkbox's turn), so a driver handle alone is not enough.
    const st = tkDone(k) ? 'done' : k.status === 'running' ? 'run' : 'wait';
    const open = (k.predecessors || []).filter(x => !verified.has(x));
    const why = st !== 'wait' ? null : k.hold ? { k: 'hold', t: '보류: ' + k.hold }
      : k.status === 'rebase_pending' ? { k: 'pred', t: '리베이스 대기: 구현 완료, 체인 앞 티켓 검증 뒤 재검증' }
      : k.status === 'box_waiting' ? { k: 'pred', t: '체크박스 차례 대기' }
      : k.status === 'box_deferred' ? { k: 'hold', t: '체크박스 이월' }
      : open.length ? { k: 'pred', t: '선행 대기: ' + open.join(', ') }
      : { k: 'start', t: `기동 대기(동시 상한 ${k.max_parallel ?? 4})` };
    return { k, pos, len, st, why, planned: (k.sessions || []).filter(x => x.kind !== 'driver').length };
  }).sort((a, b) => repos.indexOf(a.k.repo) - repos.indexOf(b.k.repo) || a.pos - b.pos);
  const c = x => list.filter(y => y.st === x).length, w = x => list.filter(y => y.why?.k === x).length;
  return { list, total: list.length, done: c('done'), run: c('run'), wait: c('wait'), hold: w('hold'), pred: w('pred'), start: w('start') };
}
// Every ticket of a driver plan as one chip (state, checkbox progress), always under the coordinator's plan line.
const TKP = { done: ['done', '완료'], run: ['run', '드라이버 실행'], hold: ['blocked', '보류'], pred: ['blocked', '선행 대기'], start: ['pending', '기동 대기'] };
// A driver plan's tickets grouped by repository, in the plan's repo order (driverPlan sorts by repo, then chain position).
function byRepo(items, repoOf = x => x.k.repo) {
  const groups = [];
  for (const x of items) {
    const r = repoOf(x) || '저장소 없음';
    let g = groups.find(y => y.repo === r);
    if (!g) groups.push(g = { repo: r, items: [] });
    g.items.push(x);
  }
  return groups;
}
// One repository's chain at a glance: tickets verified, running, waiting, and checkboxes done across them.
const repoLine = xs => {
  const c = st => xs.filter(x => x.st === st).length, sum = f => xs.reduce((a, x) => a + (x.k[f] ?? 0), 0);
  return `티켓 ${xs.length} · 완료 ${c('done')}${c('run') ? ` · 실행 <b style="color:var(--run)">${c('run')}</b>` : ''}${c('wait') ? ` · 대기 ${c('wait')}` : ''} · 체크박스 ${sum('boxes_done')}/${sum('boxes_total')}`;
};
// One padded tag group per repository (its name on top, its ticket chips below), so a long repo name never pushes
// the chips around; the groups flow side by side and wrap.
const ticketStrip = dp => `<div class="xp-strip">${byRepo(dp.list).map(g => `<div class="xp-grp" title="${esc(repoLine(g.items).replace(/<[^>]+>/g, ''))}"><span class="xp-repo-n">${esc(g.repo)}</span><div class="cbr">${g.items.map(x => {
  const [cls, lbl] = TKP[x.st === 'wait' ? x.why.k : x.st], k = x.k;
  const tip = `${k.package}${k.jira ? ' · ' + k.jira : ''} · ${x.why && x.st === 'wait' ? x.why.t : XP_TICKET[k.status] || lbl} · 체크박스 ${k.boxes_done ?? 0}/${k.boxes_total ?? 0}`;
  return `<span class="tkc ${cls}" title="${esc(tip)}"><i>${TK_IC[cls] || '·'}</i>${esc(k.package)} ${k.boxes_done ?? 0}/${k.boxes_total ?? 0}</span>`;
}).join('')}</div></div>`).join('')}</div>`;
const drvPlanLine = dp => `<b>드라이버 계획</b> 전체 ${dp.total} · 완료 ${dp.done} · 실행 <b style="color:var(--run)">${dp.run}</b> · 생성 예정 ${dp.wait}${dp.wait ? ` (보류 ${dp.hold} · 선행 대기 ${dp.pred} · <b style="color:var(--accent)">기동 대기 ${dp.start}</b>)` : ''}`;
const pdrvName = k => `${k.driver_terminal || k.package} 드라이버(생성 예정)`;
// Coordinator family: scheduler first, then every ticket's driver in chain order — a real terminal at its first ticket's slot
// (listing the tickets it drove), a dashed placeholder for a ticket whose driver does not exist yet.
// Finished drivers (all their tickets verified) sink to the bottom, below the 생성 예정 placeholders.
function driversHtml(f) {
  const real = (f.drivers || []).slice().sort((a, b) => drvRank(a) - drvRank(b));
  const plans = f.coord ? plansOf(f.coord) : [];
  if (filtering()) return cellsJoin(real.filter(liveDrv).map(driverHtml));  // no scheduler, placeholders or finished drivers
  if (!plans.length) return cellsJoin(real.map(driverHtml));
  const parts = [], later = [], finished = [];  // drivers not created yet come after live ones; finished drivers go last
  const placed = new Set();
  for (const p of plans) {
    if (p.scheduler_terminal) {
      const t = termOwner(p.scheduler_terminal).t;
      parts.push(`<div class="drv xp-sched"><div class="drv-h" title="${esc(p.scheduler_terminal)}"><b>⚙ ${esc(t?.title || 'scheduler')}</b><span class="badge">스케줄러(스크립트)</span>${t && !t.connected ? '<span class="badge" style="color:var(--bad)">연결 끊김</span>' : ''}<span>${drvPlanLine(driverPlan(p))}</span></div></div>`);
      placed.add(p.scheduler_terminal);
    }
    for (const x of driverPlan(p).list) {
      const h = x.k.driver_terminal_handle;
      if (h) {
        if (placed.has(h)) continue;
        placed.add(h);
        const d = real.find(r => r.handle === h);
        const drove = p.tickets.filter(o => o.driver_terminal_handle === h).map(o => o.package);
        // A driver whose every ticket is verified has finished: it sinks below the not-yet-created placeholders.
        const fin = p.tickets.filter(o => o.driver_terminal_handle === h).every(tkDone);
        if (d) { (fin ? finished : parts).push(driverHtml({ ...d, drove })); continue; }
      }
      if (h) {  // terminal exists but no worker session has started under it yet
        (p.tickets.filter(o => o.driver_terminal_handle === h).every(tkDone) ? finished : parts).push(driverHtml({ handle: h, title: termOwner(h).title || x.k.driver_terminal || h, workers: [], runs: IX.runsByCoord[h] || [], drove: [x.k.package] }));
        continue;
      }
      if (x.st === 'done') continue;
      later.push(`<div class="drv xp-pdrv"><div class="drv-h"><b>⚙ ${esc(pdrvName(x.k))}</b>${x.k.jira ? `<span class="tk-key">${esc(x.k.jira)}</span>` : ''}<span>${esc(x.k.repo)} ${x.pos}/${x.len}</span>${x.why ? `<span class="xp-why ${x.why.k}">${esc(x.why.t)}</span>` : ''}<span>세션 예정 ${x.planned}</span></div></div>`);
    }
  }
  const rest = real.filter(d => !placed.has(d.handle)), over = d => !drvBusy(d) && d.workers.length && d.workers.every(w => status(w) === 'done');
  return cellsJoin([...parts, ...rest.filter(d => !over(d)).map(driverHtml), ...later, ...finished, ...rest.filter(over).map(driverHtml)]);
}

// ---------- E2E TC progress of a ticket (plan: tc_plan + e2e_progress; server attaches the progress file as k.e2e) ----------
const E2E_PHASE = { lock_wait: '잠금 대기', rebase_wait: '리베이스 대기', image_build: '이미지 빌드', stack_up: '스택 기동', testing: '테스트 실행' };
const E2E_TEST = { queued: '대기', running: '실행 중', passed: '통과', failed: '실패', timedOut: '시간 초과', interrupted: '중단', skipped: '건너뜀' };
const E2E_BAD = ['failed', 'timedOut', 'interrupted'];
const hm = ts => { if (!ts) return ''; const d = new Date(ts); return isNaN(d) ? String(ts) : d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); };
function e2eRunLine(id, r, inCard) {
  const ph = E2E_PHASE[r.phase] || r.phase || '상태 미상', tests = r.tests || [];
  const c = s => tests.filter(t => s.includes(t.status)).length, pass = c(['passed']), fail = c(E2E_BAD), skip = c(['skipped']);
  const cur = tests.filter(t => t.status === 'running');
  const head = inCard ? '' : `<b>${esc(r.caller || '미지정')}</b>`, tag = inCard ? '<b class="e2e-tag">E2E</b>' : '', since = `${dur(r.phase_started_at || r.started_at)}${r.started_at && r.phase_started_at && r.phase_started_at !== r.started_at ? ` (전체 ${dur(r.started_at)})` : ''}`;
  const tip = `${r.run || id} · ${(r.ids || []).join(', ')} · pid ${r.pid ?? '?'}${r.log ? ' · ' + r.log : ''}`;
  if (r.phase === 'lock_wait')
    return `<div class="cbr e2e-run" title="${esc(tip)}">${tag}<span class="tkc pending"><i>${TK_IC.pending}</i>잠금 대기</span>${head}<span class="xp-why">보유: ${esc(r.detail || '?')}</span><span class="st">${since}</span></div>`;
  const prog = tests.length ? `<span>진행 <b>${pass + fail + skip}/${tests.length}</b> (통과 ${pass}${fail ? ` · <b style="color:var(--bad)">실패 ${fail}</b>` : ' · 실패 0'}${skip ? ` · 건너뜀 ${skip}` : ''})</span>` : '';
  const now = cur.length ? `<span class="e2e-now">▶ ${cur.map(t => esc(`${t.tc ? t.tc + ' ' : ''}${t.title || ''}`) + (t.retry ? ` (재시도 ${t.retry})` : '')).join(' · ')}</span>` : '';
  return `<div class="cbr e2e-run" title="${esc(tip)}">${tag}<span class="tkc run"><i>${TK_IC.run}</i>${esc(ph)}</span>${head}<span class="st">${since}</span>${prog}${r.phase !== 'testing' && r.detail ? `<span class="st">${esc(r.detail)}</span>` : ''}${now}</div>`;
}
// An active run belongs to the session whose name or task title is its caller ("X1#6 리뷰 claude"); a run without such a
// session (a driver's own verify, or 미지정) stays on the ticket.
const e2eNorm = x => String(x || '').replace(/\s+/g, ' ').trim();
const e2eRunsAll = () => { const seen = new Set(), out = [];
  for (const p of state.ext_plans || []) for (const k of p.tickets || []) {
    if (!k.e2e || seen.has(k.e2e_progress)) continue; seen.add(k.e2e_progress);
    for (const [id, r] of Object.entries(k.e2e.active || {})) out.push({ id, r, k });
  }
  return out; };
// Match order: terminal (ORCA_TERMINAL_HANDLE = the session's own_handle, or the Orca pane it runs in) → session_id (CLAUDE_CODE_SESSION_ID; codex
// workers may lack it) → caller name → 「미지정 (cwd …)」 with exactly one running worker in that worktree.
const e2eSessOf = r => {
  const top = state.sessions.filter(s => !s.parent), newest = a => a.sort((x, y) => (y.last_ts || '').localeCompare(x.last_ts || ''))[0] || null;
  if (r.terminal) { const m = newest(top.filter(s => s.own_handle === r.terminal || s.orca_focus === r.terminal)); if (m) return m; }
  if (r.session_id) { const m = top.find(s => s.id === r.session_id); if (m) return m; }
  const c = e2eNorm(r.caller); if (!c) return null;
  const ws = top.filter(s => s.role === 'worker');
  const named = ws.find(s => [nameOf(s), taskName(IX.tasks[s.task_id] || {})].some(n => n && e2eNorm(n) === c));
  if (named) return named;
  // run-tc started without a caller names only its cwd ("미지정 (cwd ABC-123-e2e)"): take the one running worker in that worktree
  const wt = /^미지정 \(cwd (.+)\)$/.exec(c)?.[1];
  const live = wt ? ws.filter(s => status(s) === 'run' && wtShort(s.place) === wt) : [];
  return live.length === 1 ? live[0] : null; };
// Per-TC chips of one run (sub-tests grouped by tc)
function e2eRunChips(r) {
  const by = {}; (r.tests || []).forEach(t => (by[t.tc || '?'] ||= []).push(t));
  return Object.entries(by).map(([tc, ts]) => {
    const c = st => ts.filter(t => st.includes(t.status)).length, done = c(['passed', 'skipped', ...E2E_BAD]);
    const cls = c(['running']) ? 'run' : c(E2E_BAD) ? 'fail' : done === ts.length ? 'done' : c(['queued']) === ts.length ? 'pending' : 'wait';
    const tip = ts.map(t => `${E2E_TEST[t.status] || t.status} · ${t.title || ''}${t.retry ? ` (재시도 ${t.retry})` : ''}${t.duration_ms ? ` · ${Math.round(t.duration_ms / 1000)}s` : ''}${t.error ? '\n  ' + t.error : ''}`).join('\n');
    return `<span class="tkc ${cls}" title="${esc(tc + '\n' + tip)}"><i>${TK_IC[cls] || '·'}</i>${esc(tc)}${ts.length > 1 ? ` ${done}/${ts.length}` : ''}</span>`;
  }).join('');
}
// The E2E block inside a session card: each active run that session started
// A driver's own runs (no worker session, e.g. "X1#3 드라이버 verify") sit in that driver's card.
function e2eDriverHtml(d) {
  const runs = e2eRunsAll().filter(x => !e2eSessOf(x.r) && (x.k.driver_terminal_handle === d.handle || (d.drove || []).includes(x.k.package)));
  if (!runs.length) return '';
  return `<div class="e2e e2e-card">${runs.map(({ id, r }) => `${e2eRunLine(id, r)}${(r.tests || []).length ? `<div class="cbr e2e-tcs">${e2eRunChips(r)}</div>` : ''}`).join('')}</div>`;
}
function e2eCardHtml(s) {
  const runs = e2eRunsAll().filter(x => e2eSessOf(x.r) === s);
  if (!runs.length) {  // not running now: the session's last finished run, if any
    const last = (state.ext_plans || []).flatMap(p => (p.tickets || []).flatMap(k => k.e2e?.history || []))
      .filter(h => e2eSessOf(h) === s).sort((a, b) => (b.finished_at || b.started_at || '').localeCompare(a.finished_at || a.started_at || ''))[0];
    if (!last) return '';
    const ok = last.outcome === 'passed', cls = ok ? 'done' : last.failed || E2E_BAD.includes(last.outcome) ? 'fail' : 'pending';
    return `<div class="e2e e2e-card"><div class="cbr e2e-run" title="${esc((last.ids || []).join(', ') + (last.log ? ' · ' + last.log : ''))}"><b class="e2e-tag">E2E</b><span class="tkc ${cls}"><i>${TK_IC[cls]}</i>마지막 ${esc(E2E_TEST[last.outcome] || last.outcome || '?')}</span><span>통과 ${last.passed ?? 0} · 실패 ${last.failed ?? 0}</span><span class="st">${ago(last.finished_at || last.started_at)}${last.started_at && last.finished_at ? ` · ${dur(last.started_at, last.finished_at)}` : ''}</span></div></div>`;
  }
  return `<div class="e2e e2e-card">${runs.map(({ id, r }) => `${e2eRunLine(id, r, true)}${(r.tests || []).length ? `<div class="cbr e2e-tcs">${e2eRunChips(r)}</div>` : ''}`).join('')}</div>`;
}
function e2eHtml(k) {
  const plan = k.tc_plan || [];
  if (!plan.length && !k.e2e_progress) return '';
  const e = k.e2e || {}, active = Object.entries(e.active || {}), latest = e.latest || {};
  // Per-TC state: running (a sub-test running in an active run) > queued in an active run > last finished result > 미실행
  const tcState = tc => {
    const live = active.flatMap(([, r]) => (r.tests || []).filter(t => t.tc === tc).map(t => ({ ...t, caller: r.caller })));
    const run = live.filter(t => t.status === 'running'), l = latest[tc];
    const sub = (a, n) => (n > 1 ? ` ${a}/${n}` : '');
    if (run.length) { const done = live.filter(t => ['passed', ...E2E_BAD, 'skipped'].includes(t.status)).length;
      return ['run', '실행 중', sub(done, live.length), `${tc} 실행 중 · ${run[0].caller || ''} · ${run.map(t => t.title).join(' / ')}`]; }
    if (live.length && live.every(t => t.status === 'queued') && !l) return ['wait', '대기', '', `${tc} 실행 대기 · ${live[0].caller || ''}`];
    if (l) { const n = (l.passed || 0) + (l.failed || 0), bad = l.status !== 'passed';
      return [bad ? 'fail' : 'done', bad ? '실패' : '통과', sub(l.passed || 0, n),
        `${tc} ${bad ? '실패' : '통과'} · ${hm(l.at)} (${ago(l.at)}) · ${l.caller || ''}${l.run ? ' · ' + l.run : ''}${bad && l.error ? '\n' + l.error : ''}`]; }
    return ['pending', '미실행', '', `${tc} 아직 실행 기록 없음`];
  };
  const chips = plan.map(p => { const [cls, lbl, sub, tip] = tcState(p.tc);
    return `<span class="tkc ${cls}" title="${esc(tip)}"><i>${TK_IC[cls] || '·'}</i>${p.box != null ? `<small class="e2e-box">#${esc(p.box)}</small>` : ''}${esc(p.tc)}${esc(sub)}</span>`; }).join('');
  const sum = plan.reduce((a, p) => (a[tcState(p.tc)[0]]++, a), { done: 0, fail: 0, run: 0, wait: 0, pending: 0 });
  // The ticket shows only each TC's state; runs belong to the session (or driver) card that started them.
  return plan.length ? `<div class="cbr e2e-tcs e2e-tk"><span class="cbn">TC</span><span class="st">통과 ${sum.done}/${plan.length}${sum.fail ? ` · <b style="color:var(--bad)">실패 ${sum.fail}</b>` : ''}</span>${chips}</div>` : '';
}
// A driver's ticket row (agents page) shows the same block when an external plan ticket of that package carries TC data.
const planTicketE2e = pkg => { const k = (state.ext_plans || []).flatMap(p => p.tickets || []).find(t => t.package === pkg && (t.tc_plan?.length || t.e2e_progress)); return k ? e2eHtml(k) : ''; };

// A plan is shown inside its coordinator session's view; only a plan whose coordinator is not tracked stays on the agents page.
const planOwner = p => p.coordinator_session && state.sessions.find(x => x.id === p.coordinator_session || x.path.endsWith('/' + p.coordinator_session + '.jsonl'));
const plansOf = d => (state.ext_plans || []).filter(p => planOwner(p) === d || (planOwner(p)?.path === d.path));
const termNote = h => { const t = h && termOwner(h).t; return !h ? '터미널 미생성' : `터미널 ${t ? esc(t.title || '') + (t.connected ? '' : ' · 연결 끊김') : 'Orca 목록에 없음'} · ${esc(h.slice(0, 13))}`; };
function extPlansHtml(plans, inSession) {
  if (!plans.length) return '';
  const byTitle = {};
  Object.values(state.orca.tasks || {}).flat().forEach(t => { if (!t.plan_row) (byTitle[t.task_title] ||= []).push(t); });
  const sess = {};
  state.sessions.forEach(x => { if (x.role === 'worker' && !x.parent) (x.task_ids || (x.task_id ? [x.task_id] : [])).forEach(id => (sess[id] = x)); });
  const tally = rows => { const r = rows.filter(y => !y.drv), c = k => r.filter(y => y.st === k).length;
    return { total: r.length, made: c('spawned') + c('done') + c('fail'), done: c('done'), live: c('spawned'), wait: c('planned') + c('blocked'), fail: c('fail') }; };
  const cnt = n => `생성됨 <b>${n.made}</b> / 전체 ${n.total} · 완료 ${n.done}${n.live ? ` · 실행 <b style="color:var(--run)">${n.live}</b>` : ''}${n.wait ? ` · 생성 예정 ${n.wait}` : ''}${n.fail ? ` · 실패 <b style="color:var(--bad)">${n.fail}</b>` : ''}`;
  const line = r => {
    const tip = esc(r.t ? 'Orca 태스크 ' + r.t.status : '계획 파일 상태 ' + r.x.status), inner = `<i>${WP_IC[r.st] || '·'}</i>${esc(r.label)}`;
    const chip = r.w ? `<a class="tkc ${XP_CHIP[r.st]}" href="#s=${encodeURIComponent(r.w.path)}" title="${tip}">${inner}</a>` : `<span class="tkc ${XP_CHIP[r.st]}" title="${tip}">${inner}</span>`;
    return `<div class="cbr xp ${r.drv ? 'xp-drv' : ''}" title="${esc(r.x.title || '')}"><span class="xp-kind">${esc(XP_KIND[r.x.kind] || r.x.kind)}</span><span class="xp-key">${esc(r.x.key)}</span>
      ${r.drv ? '<span class="st">세션 없음(드라이버)</span>' : modelChip(r.w?.model || r.x.model)}${chip}
      ${(r.x.deps || []).length ? `<span class="xp-deps">선행: ${r.x.deps.map(esc).join(', ')}</span>` : ''}</div>`;
  };
  return plans.map(p => {
    if (p.error) return `<div class="sec-h"><h2>외부 워커 계획</h2><span>${esc(p.path)}</span></div><div class="xp-err">읽기 실패: ${esc(p.error)}</div>`;
    const dp = driverPlan(p);
    const extra = k => { const keys = new Set((k.sessions || []).map(r => r.key)), ids = new Set((k.sessions || []).map(r => r.task_id).filter(Boolean));
      return ((k.run_id && state.orca.tasks[k.run_id]) || []).filter(t => !t.plan_row && !keys.has(t.task_title) && !ids.has(t.id) && TASK_NAME.exec(taskName(t))?.[1] === k.package)
        .map(t => ({ key: t.task_title, kind: 'extra', task_id: t.id, deps: [], status: '' })); };
    // Grouped by repository (each repo is one chain); inside a repo, started tickets lead the ones still waiting.
    const tickets = byRepo(dp.list).flatMap(g => [...g.items.filter(d => d.st !== 'wait'), ...g.items.filter(d => d.st === 'wait')])
      .map(d => ({ k: d.k, x: d, rows: [...(d.k.sessions || []), ...extra(d.k)].map(x => extPlanRow(x, d.k, byTitle, sess)) }));
    const all = tally(tickets.flatMap(t => t.rows));
    const ticketHtml = ({ k, x, rows }) => {
      const id = 'ext:' + p.path + ':' + k.package, open = famMin[id] ?? !tkDone(k), n = tally(rows);
      const shared = p.tickets.filter(o => o !== k && o.driver_terminal_handle && o.driver_terminal_handle === k.driver_terminal_handle).map(o => o.package);
      return `<div class="tk ${open ? 'open' : ''}">
        <div class="tk-h" data-ttoggle="${esc(id)}"><span class="tk-arrow">${open ? '▾' : '▸'}</span><b>⚙ ${x.st === 'wait' ? esc(pdrvName(k)) : `${esc(k.driver_terminal || k.package)} 드라이버(스크립트)`}</b>${k.jira ? `<span class="tk-key">${esc(k.jira)}</span>` : ''}
          <span>${esc(k.repo || '')} ${x.pos}/${x.len}</span>${x.why ? `<span class="xp-why ${x.why.k}">${esc(x.why.t)}</span>` : ''}<span title="${esc(k.driver_terminal_handle || '')}">${termNote(k.driver_terminal_handle)}${shared.length ? ` · 공유: ${shared.map(esc).join('·')}` : ''}</span>${k.run_id ? `<a href="#r=${esc(k.run_id)}" style="color:var(--accent)">Run</a>` : ''}<span>${esc(XP_TICKET[k.status] || k.status)}</span><span>체크박스 <b>${k.boxes_done ?? 0}/${k.boxes_total ?? 0}</b></span><span>${cnt(n)}</span>
          <span class="tk-bar">${pbar({ steps: rows.filter(r => !r.drv).map(r => r.st === 'spawned' && r.w && status(r.w) !== 'run' ? (status(r.w) === 'stalled' ? 'fail' : 'wait') : r.st) })}</span></div>
        ${e2eHtml(k)}
        ${open ? `<div class="tk-body">${rows.map(line).join('')}</div>` : ''}</div>`;
    };
    // A repository folds as a whole; it starts open while any of its tickets is not verified yet.
    const body = byRepo(tickets, t => t.k.repo).map(g => {
      const id = 'repo:' + p.path + ':' + g.repo, open = famMin[id] ?? g.items.some(t => !tkDone(t.k));
      return `<div class="xp-repo ${open ? 'open' : ''}"><div class="xp-repo-h" data-rtoggle="${esc(id)}" data-open="${open ? 1 : 0}"><span class="tk-arrow">${open ? '▾' : '▸'}</span><b>${esc(g.repo)}</b><span>${repoLine(g.items.map(t => t.x))}</span></div>
        ${open ? `<div class="tks">${g.items.map(ticketHtml).join('')}</div>` : ''}</div>`;
    }).join('');
    const sub = `티켓 ${tickets.length} · ${cnt(all)}${p.generated_at ? ` · 계획 갱신 ${esc(ago(p.generated_at))}` : ''}`;
    const sched = p.scheduler_terminal ? `<div class="drv-h" title="${esc(p.scheduler_terminal)}"><b>⚙ ${esc(termOwner(p.scheduler_terminal).title || 'scheduler')}</b><span class="badge">스케줄러(스크립트)</span><span>${termNote(p.scheduler_terminal)}</span><span>아래 티켓 드라이버를 순서대로 띄움</span></div>` : '';
    const title = `${esc(p.project || '')} 워커 계획 (드라이버 사전 계획)`;
    return inSession ? `<div class="box"><h3>${title} <span class="st">${sub}</span></h3><div class="pline" style="margin:-4px 0 8px">${drvPlanLine(dp)}</div>${sched}<div class="tks">${body}</div></div>`
      : `<div class="sec-h"><h2>${title}</h2><span>${sub}</span></div>${sched}<div class="tks">${body}</div>`;
  }).join('');
}

// One section per driver script: its run, progress, estimate and the workers it launched.
const drvRank = d => Math.min(9, ...d.workers.map(sessRank));
// Open by default while any worker is active or any of its tasks is unsettled (a task can run before its session shows up).
// A manual fold stays folded while the driver just moves on to its next worker in the same run (impl → review → next box).
// It reopens only for news: a run (ticket) that did not exist at fold time starting work, or a worker newly needing
// attention (failed task, 입력 대기, 응답 없음) that was not already so when folded. The fold stores what it saw then.
const foldedAt = k => { const v = famMin[k]; return v && typeof v === 'object' ? v.at : v === true ? 0 : null; };
const drvAlerts = d => [
  ...d.runs.flatMap(r => (state.orca.tasks[r.id] || []).filter(t => t.status === 'failed').map(t => 't:' + t.id)),
  ...d.workers.filter(w => ['wait', 'stalled'].includes(status(w))).map(w => 'w:' + w.id)];
const drvFoldSnap = d => ({ at: Date.now(), runs: d.runs.map(r => r.id), alerts: drvAlerts(d) });
const newWorkSince = (d, k) => {
  const v = famMin[k], at = foldedAt(k);
  const unsettled = r => (state.orca.tasks[r.id] || []).some(t => !SETTLED_T.includes(t.status));
  if (v && typeof v === 'object' && v.runs) {  // snapshot fold
    const runs = new Set(v.runs), seen = new Set(v.alerts || []);
    return d.runs.some(r => !runs.has(r.id) && unsettled(r)) || drvAlerts(d).some(a => !seen.has(a));
  }
  // older folds kept only a time: judge by timestamps instead
  return d.runs.some(r => msOf(r.created_at) > at && unsettled(r))
    || d.runs.some(r => (state.orca.tasks[r.id] || []).some(t => t.status === 'failed' && msOf(t.completed_at) > at))
    || d.workers.some(w => ['wait', 'stalled'].includes(status(w)) && msOf(w.last_ts) > at);
};
const drvBusy = d => !d.workers.every(w => ['done', 'idle'].includes(status(w))) || d.runs.some(r => (state.orca.tasks[r.id] || []).some(t => !SETTLED_T.includes(t.status)));
const drvOpen = d => {
  const k = 'drv:' + d.handle, v = famMin[k];
  if (v === undefined) return drvBusy(d);
  if (v === false) return true;
  const at = foldedAt(k);
  return at !== null && newWorkSince(d, k);  // a fold from before timestamps (true) counts as long ago
};
// A folded driver looks like a minimised coordinator: donut, legend, plan bar, metrics and an expand button.
// The CELL marker lets driversHtml gather consecutive folded drivers into one card grid.
const CELL = '<!--cell-->';
// An open driver is a tile: TILE + column span + '-->' + html. Consecutive tiles share one span grid (.drv-tiles), so
// a driver takes as many columns as it has worker cards to show (1–3) and short drivers sit side by side.
const TILE = '<!--tile:';
function driverMini(d, owner) {
  const ws = d.workers, wp = workerPlan(null, [d.handle]), c = coordLeft(null, [d.handle]), t = termOwner(d.handle).t;
  const counts = ws.reduce((a, w) => (a[status(w)] = (a[status(w)] || 0) + 1, a), {});
  const pc = pendCounts(wp, planExtra(owner, d.handle));
  for (const [k] of PEND) if (pc[k]) counts[k] = pc[k];
  const pend = pc.blocked + pc.planned + pc.starting + pc.unborn, total = ws.length + pend;
  const st = ['run', 'stalled', 'bg', 'wait'].find(k => counts[k]) || (drvBusy(d) ? 'run' : wp && wp.done === wp.total ? 'done' : 'idle');
  const last = ws.map(w => w.last_ts).filter(Boolean).sort().pop(), first = ws.map(w => w.started).filter(Boolean).sort()[0];
  const sum = ws.reduce((a, w) => { const g = agg(w); a.cost += g.cost || 0; a.turns += g.turns || 0; return a; }, { cost: 0, turns: 0 });
  const live = OPEN(st), life = first ? durHM(((live ? Date.now() : msOf(last)) - msOf(first)) / 1000) : '–';
  const eta = !c ? '–' : c.done ? '완료' : c.unknown === c.open ? '–' : !c.unknown && c.left < 60e3 ? '곧' : (c.unknown ? '≥' : '') + durHM(c.left / 1000);
  return CELL + `<div class="card mini-fam drv-mini st-${st}" style="cursor:default">
    <div class="c-top"><span class="c-title" title="${esc(d.handle)}">⚙ ${esc(d.title)}</span><span class="badge subcoord">스크립트 드라이버</span></div>
    <div class="c-top">${pill(st, { last_ts: last, state_reason: '' })}${t && !t.connected ? '<span class="badge" style="color:var(--bad)">연결 끊김</span>' : ''}</div>
    ${d.drove ? `<div class="c-top"><span class="st">맡은 티켓 <b>${d.drove.map(esc).join('·')}</b></span></div>` : ''}
    <div class="mini-body">${donut(counts, total || 1)}
      <div class="mini-leg">${DONUT.filter(([k]) => counts[k]).map(([k, col]) => `<span${PEND_TIP[k] ? ` title="${PEND_TIP[k]}"` : ''}><i style="background:${col}${PEND_TIP[k] ? ';outline:1px dashed var(--muted);outline-offset:-1px' : ''}"></i>${ST_LABEL[k]} <b>${counts[k]}</b></span>`).join('') || '<span class="st">워커 없음</span>'}</div></div>
    ${wp ? wpBar(wp, planExtra(owner, d.handle)) : ''}
    <div class="c-metrics">
      <div class="m"${pend ? ` title="세션 ${ws.length} + ${PEND.filter(([k]) => pc[k]).map(([k, l]) => l + ' ' + pc[k]).join(' + ')}"` : ''}><span>워커</span><b>${total}</b></div>
      <div class="m"><span>합계 비용</span><b>${usd(sum.cost)}</b></div><div class="m"><span>합계 턴</span><b>${fmt(sum.turns)}</b></div>
      <div class="m life${live ? ' on' : ''}"${first ? ` title="첫 워커 시작 ${esc(new Date(toDate(first)).toLocaleString('ko-KR', { hour12: false }))}"` : ''}><span>${live ? '가동 중' : '가동(종료)'}</span><b>${life}</b></div>
      <div class="m"><span>남은 예상</span><b>${eta}</b></div></div>
    <div class="c-foot"><span>${d.runs[0] ? `Run · <a href="#r=${d.runs[0].id}" style="color:var(--accent)">${esc(d.runs[0].objective)}</a>` : esc(d.handle.slice(0, 13))}</span><button class="tgl" data-dtoggle="${esc(d.handle)}">▸ 펼치기</button></div>
  </div>`;
}
const cellsJoin = parts => {
  // Open drivers (TILE) and folded ones (CELL) share one span grid: open tiles first in their order, then the folded cards
  // (one column each), so a short folded card is not stretched to the height of a tall open driver beside it.
  let out = '', tiles = [], folded = [];
  const flush = () => { if (tiles.length || folded.length) out += `<div class="drv-wrap"><div class="drv-tiles">${tiles.join('')}${folded.join('')}</div></div>`; tiles = []; folded = []; };
  for (const p of parts) {
    if (p.startsWith(CELL)) folded.push(`<div class="drv-tile s1 folded">${p.slice(CELL.length)}</div>`);
    else if (p.startsWith(TILE)) { const i = p.indexOf('-->'); tiles.push(`<div class="drv-tile s${p.slice(TILE.length, i)}">${p.slice(i + 3)}</div>`); }
    else { flush(); out += p; }
  }
  flush();
  return out;
};
function driverHtml(d) {
  const owner = families().fams.find(f => (f.drivers || []).some(x => x.handle === d.handle))?.coord;
  if (!drvOpen(d)) return driverMini(d, owner);
  const ws = byRank(d.workers, sessRank), wp = workerPlan(null, [d.handle]), c = coordLeft(null, [d.handle]);
  const n = k => ws.filter(w => status(w) === k).length, open = drvOpen(d), t = termOwner(d.handle).t;
  const eta = !c ? '' : c.done ? '완료' : c.unknown === c.open ? '남은 예상 –' : !c.unknown && c.left < 60e3 ? '남은 예상 곧' : `남은 예상 ${c.unknown ? '≥' : ''}${durHM(c.left / 1000)}`;
  // Columns = worker cards in view (the ones passing a filter, else active ones or the opened finished list), 1 to 3.
  const shown = filtering() ? ws.filter(liveSess).length
    : Math.max(ws.filter(w => !['done', 'idle'].includes(status(w))).length, famMin['drvfin:' + d.handle] && !ticketsOf(d) ? ws.filter(w => ['done', 'idle'].includes(status(w))).length : 0);
  return `${TILE}${Math.min(3, Math.max(1, shown))}--><div class="drv ${open ? '' : 'closed'}">
    <div class="drv-h"><b>⚙ ${esc(d.title)}</b><span class="badge">스크립트 드라이버</span>${t && !t.connected ? '<span class="badge" style="color:var(--bad)">연결 끊김</span>' : ''}${t?.connected ? focusBtn(d.handle) : ''}
      ${d.runs[0] ? `<span>Run <a href="#r=${d.runs[0].id}" style="color:var(--accent)">${esc(cut(d.runs[0].objective, 40))}</a></span>` : ''}
      ${d.drove ? `<span>맡은 티켓 <b>${d.drove.map(esc).join('·')}</b></span>` : ''}<span>워커 <b>${ws.length}</b></span><span>실행 중 <b style="color:var(--run)">${n('run')}</b></span>${n('bg') ? `<span>백그라운드 <b>${n('bg')}</b></span>` : ''}${n('wait') ? `<span>입력 대기 <b>${n('wait')}</b></span>` : ''}${n('stalled') ? `<span>응답 없음 <b style="color:var(--bad)">${n('stalled')}</b></span>` : ''}
      ${wp ? `<span>태스크 완료 <b>${wp.done}/${wp.total}</b></span>` : ''}${eta ? `<span>${eta}</span>` : ''}
      <button class="tgl" data-dtoggle="${esc(d.handle)}" style="margin-left:auto">▾ 최소화</button></div>
    ${wp ? wpBar(wp, planExtra(owner, d.handle)) : ''}
    ${e2eDriverHtml(d)}
    ${open ? (() => {
      // Running and attention-needing workers stay in view; finished ones fold behind a toggle.
      if (filtering()) return ticketsHtml(d, true) + `<div class="grid">${ws.filter(liveSess).map(w => card(w)).join('')}</div>`;
      const act = ws.filter(w => !['done', 'idle'].includes(status(w)));
      const tk = ticketsHtml(d);
      const showFin = !!famMin['drvfin:' + d.handle], fin = ws.filter(w => ['done', 'idle'].includes(status(w)));
      // Ticket progress always sits above the worker cards, with or without 「실행 중만」.
      return tk + (act.length ? `<div class="grid">${act.map(w => card(w)).join('')}</div>` : '<div class="st" style="margin-top:6px">이 드라이버에서 진행 중인 워커 없음</div>')
        + (tk ? '' : (fin.length ? `<button class="tgl fin-tgl" data-ftoggle="${esc(d.handle)}">${showFin ? '▾' : '▸'} 완료·유휴 워커 ${fin.length}</button>${showFin ? `<div class="grid">${fin.map(w => card(w)).join('')}</div>` : ''}` : ''));
    })() : ''}</div>`;
}

// 「모두 펼치기」/「모두 최소화」 on the agents list: every fold toggle on screen at once — coordinator families
// (data-toggle, true = minimized), script drivers (data-dtoggle; a fold stores its snapshot so only new work reopens
// it), their finished-worker lists (data-ftoggle), ticket rows (data-ttoggle) and plan repositories (data-rtoggle),
// all three of the latter with true = open. Opening reveals toggles that were hidden inside, so it repeats until a
// pass changes nothing.
function foldAll(open) {
  const drivers = () => (function all(fs) { return fs.flatMap(f => [...(f.drivers || []), ...all(f.subs)]); })(families().fams);
  const sv = saveScroll();
  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    const set = (k, v) => { if (famMin[k] !== v) { famMin[k] = v; changed = true; } };
    const v = $('#view');
    v.querySelectorAll('[data-toggle]').forEach(b => set(b.dataset.toggle, !open));
    v.querySelectorAll('[data-ttoggle]').forEach(b => set(b.dataset.ttoggle, open));
    v.querySelectorAll('[data-rtoggle]').forEach(b => set(b.dataset.rtoggle, open));
    v.querySelectorAll('[data-ftoggle]').forEach(b => set('drvfin:' + b.dataset.ftoggle, open));
    v.querySelectorAll('[data-dtoggle]').forEach(b => {
      const d = drivers().find(x => x.handle === b.dataset.dtoggle);
      if (open) set('drv:' + b.dataset.dtoggle, false);
      else if (!d || drvOpen(d)) { famMin['drv:' + b.dataset.dtoggle] = d ? drvFoldSnap(d) : { at: Date.now() }; changed = true; }
    });
    if (!changed) break;
    renderAgents();
  }
  try { localStorage.setItem('adash.min', JSON.stringify(famMin)); } catch {}
  restoreScroll(sv);
}

// ---------- 「테스트」: long test runs (state.tests — files in /private/tmp/agent-test-progress, plus run-tc progress) ----------
// One shape for both sources: {src, key, kind, label, owner sess, phase, total, done, passed, failed, pending, started_at,
// updated_at, finished_at, failures, log, detail}. run-tc's active rows and its last 24 h of history join in.
const TEST_STALE_S = 300, TEST_RECENT_S = 86400;
const TEST_PHASE = { building: '빌드', running: '실행 중', done: '통과', failed: '실패' };
const testLive = t => t.phase !== 'done' && t.phase !== 'failed';
const ageS = ts => ts ? (Date.now() - toDate(ts)) / 1000 : Infinity;
function testItems() {
  const T = state.tests || {}, out = [];
  for (const f of T.files || []) {
    const updated = f.updated_at || (f.mtime && new Date(f.mtime * 1000).toISOString());
    out.push({ ...f, src: 'file', updated_at: updated, finished_at: testLive(f) ? null : updated,
      sess: e2eSessOf({ terminal: f.terminal, session_id: f.session_id, caller: f.owner }) });
  }
  for (const [path, d] of Object.entries(T.run_tc || {})) {
    for (const [id, r] of Object.entries(d.active || {})) {
      const ts = r.tests || [], c = st => ts.filter(t => st.includes(t.status)).length;
      out.push({ src: 'run-tc', key: id, kind: 'e2e', label: `E2E ${(r.ids || []).join(', ')}`, owner: r.caller, phase: r.phase === 'testing' ? 'running' : 'building',
        detail: E2E_PHASE[r.phase] || r.phase, total: ts.length || null, done: c(['passed', 'skipped', ...E2E_BAD]), passed: c(['passed']), failed: c(E2E_BAD),
        started_at: r.started_at, updated_at: d.updated_at, log: r.log, sess: e2eSessOf(r),
        failures: ts.filter(t => E2E_BAD.includes(t.status)).map(t => ({ id: `${t.tc || ''} ${t.title || ''}`.trim(), msg: t.error || '' })) });
    }
    for (const h of d.history || []) {
      if (ageS(h.finished_at || h.started_at) > TEST_RECENT_S) continue;
      const bad = h.failed > 0 || /실패|중단/.test(h.outcome || '');
      out.push({ src: 'run-tc', key: h.run, kind: 'e2e', label: `E2E ${(h.ids || []).join(', ')}`, owner: h.caller, phase: bad ? 'failed' : 'done',
        detail: h.outcome, passed: h.passed, failed: h.failed, started_at: h.started_at, finished_at: h.finished_at, updated_at: h.finished_at, log: h.log,
        sess: e2eSessOf(h), failures: Object.entries(d.latest || {}).filter(([, l]) => l.run === h.run && l.status === 'failed').map(([tc, l]) => ({ id: tc, msg: l.error || '' })) });
    }
  }
  return out;
}
function testRow(t, inCard, allFails) {
  const live = testLive(t), stale = live && ageS(t.updated_at) > TEST_STALE_S;
  const cls = live ? (stale ? 'pending' : 'run') : t.phase === 'failed' || t.failed ? 'fail' : 'done';
  const pct = t.total ? Math.min(100, (t.done || 0) / t.total * 100) : null;
  const bar = live && pct !== null ? `<span class="tbar" title="${t.done ?? 0}/${t.total}"><i style="width:${pct.toFixed(1)}%"></i>${t.failed ? `<i class="f" style="width:${Math.min(100, t.failed / t.total * 100).toFixed(2)}%"></i>` : ''}</span><span><b>${t.done ?? 0}/${t.total}</b> ${Math.floor(pct)}%</span>` : '';
  const pf = t.passed != null || t.failed != null ? `<span>통과 ${t.passed ?? 0}${t.failed ? ` · <b style="color:var(--bad)">실패 ${t.failed}</b>` : ' · 실패 0'}${t.pending ? ` · 보류 ${t.pending}` : ''}</span>` : '';
  const when = live ? `<span class="st">경과 ${dur(t.started_at)}${t.eta_s ? ` · 남은 약 ${dur(new Date(Date.now() - t.eta_s * 1000).toISOString())}` : ''}</span>`
    : `<span class="st">${ago(t.finished_at)}${t.started_at && t.finished_at ? ` · 소요 ${dur(t.started_at, t.finished_at)}` : ''}</span>`;
  const who = inCard ? '' : t.sess ? `<a href="#s=${encodeURIComponent(t.sess.path)}">${esc(cut(nameOf(t.sess), 34))}</a>` : t.owner ? `<span class="st">${esc(cut(t.owner, 34))}</span>` : '';
  const nf = allFails ? 20 : 3;
  const fails = (t.failures || []).length ? `<details class="tfails"><summary>실패 ${t.failures.length}건${t.failures.length > nf ? ` (상위 ${nf})` : ''}</summary>${t.failures.slice(0, nf).map(f => `<div><code>${esc(cut(f.id, 90))}</code> <span class="st">${esc(cut(f.msg, 160))}</span></div>`).join('')}</details>` : '';
  const tip = `${t.src === 'file' ? 'agent-test-progress/' + t.key + '.json' : 'run-tc ' + t.key}${t.log ? '\n로그 ' + t.log : ''}${t.detail ? '\n' + t.detail : ''}`;
  return `<div class="trow"><div class="cbr" title="${esc(tip)}"><b class="e2e-tag">${esc((t.kind || 'test').toUpperCase())}</b><span class="tkc ${cls}"><i>${TK_IC[cls] || '·'}</i>${esc(live ? (t.src === 'run-tc' ? t.detail : TEST_PHASE[t.phase] || t.phase || '진행') : t.phase === 'failed' || t.failed ? '실패' : '통과')}</span>${inCard ? '' : `<b>${esc(cut(t.label || t.key, 60))}</b>`}${who}${bar}${pf}${when}${stale ? `<span class="tstale">⚠ ${dur(t.updated_at)}째 갱신 없음</span>` : ''}${live && t.detail && t.src === 'file' ? `<span class="st">${esc(cut(t.detail, 60))}</span>` : ''}</div>${fails}</div>`;
}
let testsOpen = true;
// The agents view keeps only running tests; finished ones are in the 「테스트」 tab.
function testsHtml() {
  const live = testItems().filter(testLive).sort((a, b) => (a.started_at || '').localeCompare(b.started_at || ''));
  if (!live.length) return '';
  return `<details class="tests-sec" ${testsOpen ? 'open' : ''}><summary class="sec-h"><h2>테스트</h2><span>실행 중 ${live.length}</span><a class="tests-all" href="#tests">전체 기록 →</a></summary>
    <div class="tests">${live.map(t => testRow(t)).join('')}</div></details>`;
}
// A session card's own runs from the progress directory (run-tc runs have e2eCardHtml): running ones, else the last one.
function testCardHtml(s) {
  const mine = testItems().filter(t => t.src === 'file' && t.sess === s);
  const live = mine.filter(testLive), last = mine.filter(t => !testLive(t)).sort((a, b) => (b.finished_at || '').localeCompare(a.finished_at || ''))[0];
  const rows = live.length ? live : last ? [last] : [];
  return rows.length ? `<div class="e2e e2e-card">${rows.map(t => testRow({ ...t, label: null }, true).replace('<b class="e2e-tag">', `<b class="e2e-tag" title="${esc(t.label || '')}">`)).join('')}</div>` : '';
}

// ---------- 「테스트」 tab: running tests plus every finished run the server kept (/api/tests, 30 days) ----------
const TEST_SPANS = { 1: '24시간', 7: '7일', 30: '30일' }, TEST_RESULTS = { all: '전체', failed: '실패', done: '통과' };
let tst = { span: 7, result: 'all', kind: 'all', q: '' }, testsMounted = false, testHist = { at: undefined, runs: [] };
try { Object.assign(tst, JSON.parse(localStorage.getItem('adash.tests') || '{}')); } catch {}
const testFailed = t => t.phase === 'failed' || t.failed > 0;
const testId = t => t.id || (t.src === 'file' ? `file:${t.key}:${t.started_at || t.finished_at}` : testLive(t) ? 'run-tc-live:' + t.key : 'run-tc:' + t.key);
// Current items win over their archived copy (same id); archived ones get their session back when it is still tracked.
function allTestRuns() {
  const cur = testItems(), seen = new Set(cur.map(testId));
  const old = testHist.runs.filter(r => !seen.has(r.id)).map(r => ({ ...r, sess: e2eSessOf({ terminal: r.terminal, session_id: r.session_id, caller: r.owner }) }));
  return [...cur, ...old];
}
const DOW = '일월화수목금토';
const dayKey = ts => { const d = ts ? toDate(ts) : null; return d && !isNaN(d) ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : ''; };
const dayLabel = k => { if (!k) return '날짜 미상'; const d = new Date(k + 'T00:00'); const today = dayKey(new Date().toISOString()); return `${d.getMonth() + 1}월 ${d.getDate()}일 (${DOW[d.getDay()]})${k === today ? ' · 오늘' : ''}`; };
async function renderTests() {
  const at = state.tests?.history_at ?? null;
  if (testHist.at !== at) { try { const r = await api.tests(); testHist = { at, runs: r?.runs || [] }; } catch { testHist.at = undefined; } }
  const all = allTestRuns(), kinds = [...new Set(all.map(t => t.kind || 'test'))].sort();
  if (tst.kind !== 'all' && !kinds.includes(tst.kind)) tst.kind = 'all';
  const save = () => { try { localStorage.setItem('adash.tests', JSON.stringify(tst)); } catch {} };
  if (!testsMounted || $('#tests-kind').dataset.kinds !== kinds.join(',')) {
    $('#view').innerHTML = `<div class="controls">
        <div class="seg" id="tests-span">${Object.entries(TEST_SPANS).map(([k, l]) => `<button data-k="${k}">최근 ${l}</button>`).join('')}</div>
        <div class="seg" id="tests-result">${Object.entries(TEST_RESULTS).map(([k, l]) => `<button data-k="${k}">${l}</button>`).join('')}</div>
        <div class="seg" id="tests-kind" data-kinds="${esc(kinds.join(','))}"><button data-k="all">모든 종류</button>${kinds.map(k => `<button data-k="${esc(k)}">${esc(k.toUpperCase())}</button>`).join('')}</div>
        <input type="search" id="tests-q" class="field" placeholder="이름·실행자·실패 검색" value="${esc(tst.q)}">
      </div><div id="tests-body"></div>`;
    for (const [id, key] of [['#tests-span', 'span'], ['#tests-result', 'result'], ['#tests-kind', 'kind']])
      $(id).querySelectorAll('button').forEach(b => b.onclick = () => { tst[key] = key === 'span' ? +b.dataset.k : b.dataset.k; save(); renderTests(); });
    $('#tests-q').oninput = e => { tst.q = e.target.value; save(); renderTests(); };
    testsMounted = true;
  }
  for (const [id, key] of [['#tests-span', 'span'], ['#tests-result', 'result'], ['#tests-kind', 'kind']])
    $(id).querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.k === String(tst[key])));
  const q = tst.q.trim().toLowerCase();
  const hit = t => (tst.kind === 'all' || (t.kind || 'test') === tst.kind)
    && (!q || [t.label, t.key, t.owner, t.detail, t.sess && nameOf(t.sess), ...(t.failures || []).map(f => f.id + ' ' + f.msg)].some(x => x && String(x).toLowerCase().includes(q)));
  const live = all.filter(t => testLive(t) && hit(t) && tst.result === 'all').sort((a, b) => (a.started_at || '').localeCompare(b.started_at || ''));
  const tms = ts => ts ? +toDate(ts) || 0 : 0;  // sources mix "Z" and "+09:00": compare instants, not strings
  const done = all.filter(t => !testLive(t) && ageS(t.finished_at) <= tst.span * 86400 && hit(t)).sort((a, b) => tms(b.finished_at) - tms(a.finished_at));
  const nf = done.filter(testFailed).length, shown = done.filter(t => tst.result === 'all' || (tst.result === 'failed') === testFailed(t));
  const days = {}; shown.forEach(t => (days[dayKey(t.finished_at)] ||= []).push(t));
  const sum = done.length ? `완료 ${done.length}회 · 통과 ${done.length - nf} · ${nf ? `<b style="color:var(--bad)">실패 ${nf}</b>` : '실패 0'} · 통과율 ${Math.round((done.length - nf) / done.length * 100)}%` : '완료 기록 없음';
  $('#tests-body').innerHTML = `<div class="sec-h"><h2>테스트 기록</h2><span>최근 ${TEST_SPANS[tst.span]} · ${sum}${live.length ? ` · 실행 중 ${live.length}` : ''}</span></div>
    ${live.length ? `<div class="sec-h"><h2>실행 중 ${live.length}</h2></div><div class="tests">${live.map(t => testRow(t, false, true)).join('')}</div>` : ''}
    ${Object.entries(days).map(([k, ts]) => `<div class="sec-h"><h2>${dayLabel(k)}</h2><span>${ts.length}회${ts.some(testFailed) ? ` · 실패 ${ts.filter(testFailed).length}` : ''}</span></div>
      <div class="tests tests-done">${ts.map(t => testRow(t, false, true)).join('')}</div>`).join('')}
    ${!live.length && !shown.length ? '<div class="empty">조건에 맞는 테스트 기록이 없습니다.</div>' : ''}
    <div class="st" style="margin-top:10px">완료된 실행은 서버가 30일(최대 2,000건) 보관합니다. 원본은 /private/tmp/agent-test-progress 와 run-tc 진행 파일입니다.</div>`;
}

// One block of the agents view: a header with the counts, then the families and solo sessions ordered by state.
// srv is the metric server the block belongs to in 「서버별 보기」 (null for the merged list).
function agentsHtml(fv, sv, srv) {
  const count = (f, k) => (k === 'c' ? (f.coord || !termOwner(f.handle).title ? 1 : 0) : f.workers.filter(liveSess).length) + f.subs.filter(liveFam).reduce((a, x) => a + count(x, k), 0);
  // One list ordered by state (attention first, idle last); within a state orchestrations lead solo sessions, then newest first.
  const items = [...fv.map(f => ({ started: f.started, f, r: famRank(f), o: 0 })), ...sv.map(s => ({ started: s.started || '', s, r: sessRank(s), o: 1 }))]
    .sort((a, b) => a.r - b.r || a.o - b.o || b.started.localeCompare(a.started));
  const nc = fv.reduce((a, f) => a + count(f, 'c'), 0), nw = fv.reduce((a, f) => a + count(f, 'w'), 0);
  const [cls, st] = srv ? srvState(srv) : [];
  const title = srv ? `<h2>${esc(srv.name)}</h2><span class="sp-msg ${cls}" title="${esc(srv.url)}">${esc(st)}</span><span>에이전트 ${nc + nw + sv.length}</span>` : `<h2>에이전트 ${nc + nw + sv.length}</h2>`;
  if (!items.length) return srv ? `<div class="sec-h srv-h">${title}</div><div class="empty srv-empty">표시할 에이전트가 없습니다.</div>` : '';
  let h = `<div class="sec-h${srv ? ' srv-h' : ''}">${title}<span>코디네이터 ${nc} · 워커 ${nw} · 단독 ${sv.length}</span>
    <span class="fold-all"><button class="act" data-fold="open" title="코디네이터 묶음·드라이버·티켓·저장소를 모두 펼침">모두 펼치기</button><button class="act" data-fold="min" title="모두 최소화">모두 최소화</button></span></div>`;
  let pend = [];
  const flush = () => { if (pend.length) h += `<div class="grid" style="margin-bottom:14px">${pend.join('')}</div>`; pend = []; };
  for (const it of items) {
    if (it.s) pend.push(card(it.s, 'solo'));
    else if (shut(it.f)) pend.push(miniFam(it.f));
    else { flush(); h += famHtml(it.f); }
  }
  flush();
  return h;
}
function renderAgents() {
  const { fams, solos } = families();
  const fv = fams.filter(liveFam), sv = solos.filter(liveSess);
  // 「서버별 보기」: one block per server that is on, in list order. A family belongs to its coordinator's server.
  const famSrv = f => (f.coord || f.members[0])?.server;
  const h = srvView === 'split' && multiSrv()
    ? srvOn().map(x => agentsHtml(fv.filter(f => famSrv(f) === x.id), sv.filter(s => s.server === x.id), x)).join('').replace('sec-h srv-h', 'sec-h srv-h first')
    : agentsHtml(fv, sv, null);
  $('#view').innerHTML = testsHtml() + (h || '<div class="empty">표시할 에이전트가 없습니다.</div>') + extPlansHtml((state.ext_plans || []).filter(p => !planOwner(p)));
  { const el = $('#view .tests-sec'); if (el) el.ontoggle = () => testsOpen = el.open; }  // survives live re-renders
  $('#view').querySelectorAll('.card[data-path]').forEach(c => c.onclick = () => openSession(c.dataset.path));
  $('#view').querySelectorAll('[data-fold]').forEach(b => b.onclick = e => { e.stopPropagation(); foldAll(b.dataset.fold === 'open'); });
  $('#view').querySelectorAll('[data-ttoggle]').forEach(b => b.onclick = e => {
    if (e.target.closest('a')) return;
    e.stopPropagation();
    const k = b.dataset.ttoggle, cur = b.closest('.tk').classList.contains('open') || b.querySelector('.tk-arrow')?.textContent === '▾';
    famMin[k] = !cur;
    try { localStorage.setItem('adash.min', JSON.stringify(famMin)); } catch {}
    { const sv = saveScroll(); renderAgents(); restoreScroll(sv); }
  });
  $('#view').querySelectorAll('[data-ftoggle]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    const k = 'drvfin:' + b.dataset.ftoggle;
    famMin[k] = !famMin[k];
    try { localStorage.setItem('adash.min', JSON.stringify(famMin)); } catch {}
    { const sv = saveScroll(); renderAgents(); restoreScroll(sv); }
  });
  $('#view').querySelectorAll('[data-dtoggle]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    const k = 'drv:' + b.dataset.dtoggle, d = families().fams.flatMap(f => f.drivers || []).find(x => x.handle === b.dataset.dtoggle);
    famMin[k] = (d ? drvOpen(d) : !famMin[k]) ? (d ? drvFoldSnap(d) : { at: Date.now() }) : false;  // fold remembers what it saw, so only news reopens it
    try { localStorage.setItem('adash.min', JSON.stringify(famMin)); } catch {}
    { const sv = saveScroll(); renderAgents(); restoreScroll(sv); }
  });
  $('#view').querySelectorAll('[data-toggle]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    const f = (function find(list) { for (const x of list) { if (x.key === b.dataset.toggle) return x; const r = find(x.subs); if (r) return r; } })(families().fams);
    if (!f) return;
    famMin[f.key] = !isMin(f);
    try { localStorage.setItem('adash.min', JSON.stringify(famMin)); } catch {}
    { const sv = saveScroll(); renderAgents(); restoreScroll(sv); }
  });
}

// ---------- compare (live bars, keyed so widths animate) ----------
const METRICS = {
  cost: { label: '비용', v: a => a.cost, f: usd, parts: a => a.parts, colors: ['--s-input', '--s-write', '--s-read', '--s-out'], names: ['입력', '캐시 쓰기', '캐시 읽기', '출력'] },
  ctx: { label: '현재 컨텍스트', v: a => a.ctx, f: fmt },
  turns: { label: '턴', v: a => a.turns, f: fmt },
  tokens: { label: '총 토큰', v: a => Object.values(a.tok).reduce((p, q) => p + q, 0), f: fmt, parts: a => a.tok, colors: ['--s-input', '--s-write', '--s-read', '--s-out'], names: ['입력', '캐시 쓰기', '캐시 읽기', '출력'] },
  output: { label: '출력 토큰', v: a => a.output, f: fmt },
  both: { label: '스킬 + MCP', v: a => a.both ?? (a.skills + a.mcp), f: fmt, use: 'both_use', unit: '스킬·MCP', nm: n => n.startsWith('mcp:') ? 'MCP · ' + mcpName(n.slice(4)) : n },
  useInj: { label: '스킬·MCP 주입 토큰', v: a => a.useInj ?? sumUse(a.uses?.inj_use), f: fmt, use: 'inj_use', unit: '스킬·MCP', tok: 1, nm: n => n.startsWith('mcp:') ? 'MCP · ' + mcpName(n.slice(4)) : n },
  useCarry: { label: '스킬·MCP 누적 토큰', v: a => a.useCarry ?? sumUse(a.uses?.carry_use), f: fmt, use: 'carry_use', unit: '스킬·MCP', tok: 1, nm: n => n.startsWith('mcp:') ? 'MCP · ' + mcpName(n.slice(4)) : n },
  useCost: { label: '스킬·MCP 누적 비용', v: a => a.useCost ?? sumUse(a.uses?.cost_use), f: usd, use: 'cost_use', unit: '스킬·MCP', tok: 1, nm: n => n.startsWith('mcp:') ? 'MCP · ' + mcpName(n.slice(4)) : n },
};
const GROUPS = { agent: '에이전트별', family: '코디네이터 그룹별', model: '모델별' };
// Skill / MCP metrics can also be grouped by the skill or server itself (bars stacked by the models that used it).
// 「서버별」 joins once more than one metric server is on.
const groupsAll = () => multiSrv() ? { ...GROUPS, server: '서버별' } : GROUPS;
const groupsFor = m => METRICS[m].use ? { name: METRICS[m].unit + '별', ...groupsAll() } : groupsAll();
let cmp = { metric: 'cost', group: 'agent', view: 'total', span: 24, unit: 60, tod: [0, 24] }, cmpMounted = false;
try { Object.assign(cmp, JSON.parse(localStorage.getItem('adash.cmp') || '{}')); } catch {}
// 「시간당」 view: metrics that can be split by the hour the turn happened in.
const HOURLY = { cost: h => h[4], tokens: h => h[0] + h[1] + h[2] + h[3], output: h => h[3] };
const VIEWS = { total: '합계', hourly: '시간별' }, SPANS = { 1: '1시간', 6: '6시간', 24: '24시간', 72: '72시간', 168: '7일' };
const WEEK = 168;  // the 7-day span also reads /api/history (sessions older than the live window), grouped per agent only
const UNITS = { 60: '1시간', 30: '30분', 15: '15분', 5: '5분' };  // bar width in minutes (server slots are 5 min)
if (!VIEWS[cmp.view]) cmp.view = 'total';
if (!SPANS[cmp.span]) cmp.span = 24;
if (!UNITS[cmp.unit]) cmp.unit = 60;
if (!Array.isArray(cmp.tod) || !(cmp.tod[0] < cmp.tod[1])) cmp.tod = [0, 24];
const unitOf = () => cmp.span === WEEK && cmp.unit < 15 ? 15 : cmp.unit;  // 5-minute bars over a week would be sub-pixel
const groupOf = () => cmp.view === 'hourly' && cmp.span === WEEK ? 'agent' : cmp.group;
if (cmp.view === 'hourly' && !HOURLY[cmp.metric]) cmp.metric = 'cost';
if (!METRICS[cmp.metric]) cmp.metric = 'cost';  // a saved metric may no longer exist (e.g. the old tool count)
if (!groupsFor(cmp.metric)[cmp.group]) cmp.group = 'agent';

function cmpItems(group = cmp.group) {
  const top = state.sessions.filter(s => !s.parent && liveSess(s));
  if (group === 'name') {
    // Every session counts its own calls (subagents included), keyed by skill or MCP server.
    const M = METRICS[cmp.metric], by = new Map();
    for (const s of state.sessions.filter(x => (!onlyLive || x.live || Date.now() - (msOf(x.last_ts) || 0) < LIVE_GRACE) && (!onlyOrca || inOrca(x)))) {
      for (const [k, c] of Object.entries(useOf(s, M.use) || {})) {
        let g = by.get(k);
        if (!g) by.set(k, g = { key: 'u:' + k, name: M.nm ? M.nm(k) : k, live: false, users: new Set(), models: {}, a: { skills: 0, mcp: 0, both: 0, [cmp.metric]: 0 } });
        g.a[cmp.metric] += c; g.live ||= s.live; g.users.add(s.parent || s.path);
        const mk = modelKey(s.model); g.models[mk] = (g.models[mk] || 0) + c;
      }
    }
    return [...by.values()].map(g => ({ ...g, st: g.live ? 'run' : 'idle', sub: `에이전트 ${g.users.size} · ${Object.entries(g.models).sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k} ${M.f(c)}`).join(' · ')}`,
      segs: Object.entries(g.models).sort((a, b) => b[1] - a[1]).map(([k, c]) => [c, `var(--m-${k})`, k]) }));
  }
  if (group === 'agent') return top.map(s => {
    const a = agg(s);
    return { key: s.path, id: s.id, kind: s.kind, name: nameOf(s), model: s.model, live: a.live, st: subBg(s, a, status(s)), a, sub: `${multiSrv() ? srvName(s.server) + ' · ' : ''}${ROLE[s.role]} · ${modelName(s.model)}${a.subs.length ? ' · 서브 ' + a.subs.length : ''}`, go: () => openSession(s.path) };
  });
  const groups = new Map();
  const put = (key, name, sub, s, go) => {
    const a = agg(s);
    let g = groups.get(key);
    if (!g) groups.set(key, g = { key, name, sub, model: s.model, live: false, go, n: 0, a: { cost: 0, costKnown: true, parts: { input: 0, cache_write: 0, cache_read: 0, output: 0 }, tok: { input: 0, cache_write: 0, cache_read: 0, output: 0 }, turns: 0, tools: 0, output: 0, ctx: 0, slots: {} } });
    g.n++; g.live ||= a.live;
    g.a.cost += a.cost || 0; g.a.costKnown &&= a.costKnown && a.cost != null;
    for (const k in g.a.parts) { g.a.parts[k] += a.parts[k] || 0; g.a.tok[k] += a.tok[k] || 0; }
    g.a.turns += a.turns; g.a.tools += a.tools; g.a.skills = (g.a.skills || 0) + a.skills; g.a.mcp = (g.a.mcp || 0) + a.mcp;
    g.a.uses = Object.fromEntries(Object.keys(a.uses).map(k => [k, mergeUse([g.a.uses?.[k], a.uses[k]])])); g.a.output += a.output; g.a.ctx = Math.max(g.a.ctx, a.ctx); g.a.slots = mergeSlots([g.a.slots, a.slots]);
  };
  if (group === 'model') top.forEach(s => put(modelName(s.model), modelName(s.model), '', s, null));
  else if (group === 'server') top.forEach(s => put('srv:' + s.server, srvName(s.server) || '서버 미상', '', s, null));
  else {
    const { fams, solos } = families();
    // Workers launched by a driver script form their own row under their coordinator, so drivers compare side by side.
    fams.forEach(f => {
      const cname = f.coord ? nameOf(f.coord) : '코디네이터 (범위 밖)', go = f.coord ? () => openSession(f.coord.path) : null;
      const drv = Object.fromEntries((f.drivers || []).map(d => [d.handle, d]));
      const hasDrv = Object.keys(drv).length > 0;
      f.members.forEach(s => {
        const d = s.viaHandle && drv[s.viaHandle];
        if (d) put('d:' + d.handle, `${cname} › ⚙ ${termOwner(d.handle).t?.title || d.title}`, (tk => `드라이버 · 티켓 ${tk.length > 5 ? tk.slice(0, 5).join('·') + ` 외 ${tk.length - 5}` : tk.join('·') || '–'}`)([...new Set((ticketsOf(d) || []).map(k => k.pkg))]), s, go);
        else put('f:' + f.key, cname, hasDrv ? '코디네이터 본인 · 직속' : '', s, go);
      });
    });
    solos.forEach(s => put(s.path, nameOf(s), '단독', s, () => openSession(s.path)));
  }
  for (const g of groups.values()) {
    if (group === 'model' || group === 'server') g.sub = `에이전트 ${g.n}`;
    else if (!g.sub) g.sub = `코디네이터 트리 · 에이전트 ${g.n}`;
    else if (g.key.startsWith('d:') || g.sub === '코디네이터 본인 · 직속') g.sub += ` · 에이전트 ${g.n}`;
    if (!g.a.costKnown && g.a.cost === 0) g.a.cost = null;
  }
  return [...groups.values()];
}

function renderCompare() {
  if (!groupsFor(cmp.metric)[cmp.group] && cmp.group === 'server') cmp.group = 'agent';  // back to one server
  const M = METRICS[cmp.metric];
  if (!cmpMounted) {
    const hourly = cmp.view === 'hourly';
    $('#view').innerHTML = `<div class="controls">
        <div class="seg" id="seg-v">${Object.entries(VIEWS).map(([k, l]) => `<button data-k="${k}">${l}</button>`).join('')}</div>
        <div class="seg" id="seg-m">${Object.entries(METRICS).filter(([k]) => !hourly || HOURLY[k]).map(([k, m]) => `<button data-k="${k}">${m.label}</button>`).join('')}</div>
        <div class="seg" id="seg-g">${Object.entries(hourly ? (cmp.span === WEEK ? { agent: GROUPS.agent } : groupsAll()) : groupsFor(cmp.metric)).map(([k, l]) => `<button data-k="${k}">${l}</button>`).join('')}</div>
        ${hourly ? `<div class="seg" id="seg-u" title="막대 하나의 시간 폭">${Object.entries(UNITS).map(([k, l]) => `<button data-k="${k}"${cmp.span === WEEK && +k < 15 ? ' disabled title="7일 범위에서는 15분 이상"' : ''}>${l}</button>`).join('')}</div>
        <div class="seg" id="seg-s" title="표시 범위">${Object.entries(SPANS).map(([k, l]) => `<button data-k="${k}">최근 ${l}</button>`).join('')}</div>
        <span class="tod" title="하루 중 이 시간대의 막대만 보여 줍니다">시간대
          <select id="tod-a" class="field">${Array.from({ length: 24 }, (_, i) => `<option value="${i}">${String(i).padStart(2, '0')}시</option>`).join('')}</select> –
          <select id="tod-b" class="field">${Array.from({ length: 24 }, (_, i) => `<option value="${i + 1}">${String(i + 1).padStart(2, '0')}시</option>`).join('')}</select>
          <button id="tod-all">전체</button><button id="tod-work">08–20시</button></span>` : ''}</div>
      <div class="legend" id="cmp-leg"></div>
      <div class="cmp" id="cmp"></div>
      <div class="st" id="cmp-note" style="margin-top:8px"></div>`;
    for (const [id, key] of [['#seg-v', 'view'], ['#seg-m', 'metric'], ['#seg-g', 'group'], ['#seg-u', 'unit'], ['#seg-s', 'span']])
      $(id)?.querySelectorAll('button').forEach(b => b.onclick = () => {
        cmp[key] = ['span', 'unit'].includes(key) ? +b.dataset.k : b.dataset.k;
        if (key === 'span') cmpMounted = false;  // the 7-day span narrows the group and unit buttons
        if (key === 'view') { cmpMounted = false; if (cmp.view === 'hourly') { if (!HOURLY[cmp.metric]) cmp.metric = 'cost'; if (cmp.group === 'name') cmp.group = 'agent'; } }
        if (key === 'metric') { cmpMounted = false; if (cmp.group === 'name' && !METRICS[cmp.metric].use) cmp.group = 'agent'; }  // group buttons depend on the metric
        try { localStorage.setItem('adash.cmp', JSON.stringify(cmp)); } catch {} $('#cmp').innerHTML = ''; renderCompare(); });
    const setTod = (a, b) => { cmp.tod = a < b ? [a, b] : [b, a]; if (cmp.tod[0] === cmp.tod[1]) cmp.tod = [0, 24]; try { localStorage.setItem('adash.cmp', JSON.stringify(cmp)); } catch {} renderCompare(); };
    if ($('#tod-a')) {
      $('#tod-a').onchange = $('#tod-b').onchange = () => setTod(+$('#tod-a').value, +$('#tod-b').value);
      $('#tod-all').onclick = () => setTod(0, 24);
      $('#tod-work').onclick = () => setTod(8, 20);
    }
    cmpMounted = true;
  }
  document.querySelectorAll('#seg-m button').forEach(b => b.classList.toggle('on', b.dataset.k === cmp.metric));
  document.querySelectorAll('#seg-g button').forEach(b => b.classList.toggle('on', b.dataset.k === groupOf()));
  document.querySelectorAll('#seg-v button').forEach(b => b.classList.toggle('on', b.dataset.k === cmp.view));
  document.querySelectorAll('#seg-s button').forEach(b => b.classList.toggle('on', +b.dataset.k === cmp.span));
  document.querySelectorAll('#seg-u button').forEach(b => b.classList.toggle('on', +b.dataset.k === unitOf()));
  if ($('#tod-a')) { $('#tod-a').value = cmp.tod[0]; $('#tod-b').value = cmp.tod[1]; }
  if (cmp.view === 'hourly') return renderHourly();
  $('#cmp-leg').innerHTML = M.use && cmp.group !== 'name' ? (() => {
      const tot = mergeUse(cmpItems().map(i => i.a.uses?.[M.use]));
      return Object.entries(tot).sort((a, b) => b[1] - a[1]).map(([k, c]) => `<span><i style="background:${useColor(k)}"></i>${esc(M.nm ? M.nm(k) : k)} ${M.f(c)}</span>`).join('') + `<span>막대 색 = ${M.unit}</span>`;
    })() : M.parts ? M.names.map((n, i) => `<span><i style="background:var(${M.colors[i]})"></i>${n}</span>`).join('')
    : ['opus', 'fable', 'sonnet', 'haiku', 'gpt'].map(k => `<span><i style="background:var(--m-${k})"></i>${k}</span>`).join('') + `<span>${cmp.group === 'name' ? '막대 색 = 호출한 모델 비율' : '막대 색 = 모델'}</span>`;
  const items = cmpItems().filter(i => M.v(i.a) != null && !(M.use && !M.v(i.a))).sort((a, b) => M.v(b.a) - M.v(a.a));  // usage metrics skip rows with no calls
  const unpriced = cmp.metric === 'cost' ? cmpItems().filter(i => M.v(i.a) == null).length : 0;
  const max = Math.max(1e-9, ...items.map(i => M.v(i.a)));
  const box = $('#cmp'), seen = new Set();
  const useRows = M.use && cmp.group !== 'name';
  if (useRows) useRank = Object.fromEntries(Object.entries(mergeUse(items.map(i => i.a.uses?.[M.use]))).sort((a, b) => b[1] - a[1]).map(([k], i) => [k, i]));
  if (useRows) items.forEach(it => {
    const e = Object.entries(it.a.uses?.[M.use] || {}).sort((a, b) => b[1] - a[1]);
    it.segs = e.map(([k, c]) => [c, useColor(k), M.nm ? M.nm(k) : k]);
    it.sub = e.length ? e.map(([k, c]) => `${M.nm ? M.nm(k) : k} ${M.f(c)}`).join(' · ') : `${M.unit} 호출 없음`;
  });
  items.forEach((it, idx) => {
    seen.add(it.key);
    let row = box.querySelector(`.row[data-k="${CSS.escape(it.key)}"]`);
    if (!row) {
      row = document.createElement('div'); row.className = 'row'; row.dataset.k = it.key;
      row.innerHTML = `<div class="nm"><b><span class="dot"></span><span class="n"></span></b><span class="st s"></span></div><div class="track"></div><div class="val"></div>`;
    }
    row.onclick = it.go || null;
    row.style.cursor = it.go ? 'pointer' : 'default';
    row.querySelector('.dot').className = 'dot' + (it.live ? ' live' : '');
    row.className = 'row st-' + (it.st || (it.live ? 'run' : 'idle'));
    row.querySelector('.n').textContent = it.name;
    row.querySelector('.s').textContent = it.sub;
    const v = M.v(it.a), track = row.querySelector('.track');
    const segs = it.segs || (M.parts ? Object.values(M.parts(it.a)).map((x, i) => [x, `var(${M.colors[i]})`]) : [[v, `var(--m-${modelKey(it.model)})`]]);
    while (track.children.length > segs.length) track.lastChild.remove();
    while (track.children.length < segs.length) { const d = document.createElement('div'); d.style.width = '0'; track.appendChild(d); }
    const pv = M.parts || it.segs ? segs.reduce((a, s) => a + s[0], 0) || 1 : v || 1;
    segs.forEach(([x, c], i) => { const d = track.children[i]; d.style.background = c; d.style.width = (v / max * 100 * (x / pv)) + '%'; d.title = it.segs ? `${segs[i][2]} ${M.f(x)}` : M.parts ? `${M.names[i]} ${M.f(x)}` : ''; d.textContent = useRows ? M.f(x) : ''; d.className = useRows ? 'cnt' : ''; });
    row.querySelector('.val').innerHTML = `${M.f(v)}${!it.a.costKnown && cmp.metric === 'cost' ? '+' : ''}<small>${cmp.metric === 'cost' && it.a.turns ? usd(v / it.a.turns) + '/턴' : ''}</small>`;
    if (box.children[idx] !== row) box.insertBefore(row, box.children[idx] || null);
  });
  [...box.children].forEach(r => { if (!seen.has(r.dataset.k)) r.remove(); });
  if (useRows) $('#cmp-leg').innerHTML = Object.entries(useRank).map(([k]) => `<span><i style="background:${useColor(k)}"></i>${esc(M.nm ? M.nm(k) : k)} ${M.f(mergeUse(items.map(i => i.a.uses?.[M.use]))[k])}</span>`).join('') + `<span>막대 색 = ${M.unit} · 칸 안 숫자 = ${M.tok ? M.label.replace('스킬·MCP ', '') : '호출 횟수'}</span>`;
  if (!items.length) box.innerHTML = `<div class="empty">${cmp.group === 'name' ? `호출된 ${M.unit}가 없습니다.` : '비교할 에이전트가 없습니다.'}</div>`;
  $('#cmp-note').textContent = (unpriced ? `단가가 없는 에이전트 ${unpriced}개는 비용 비교에서 빠졌습니다. pricing.json 에 단가를 넣으면 포함됩니다. ` : '') + '비용은 API 단가 환산 추정치입니다 (Claude: claude-api 기준 · GPT: OpenAI Standard 단가). '
    + (METRICS[cmp.metric].tok ? '스킬·MCP 토큰은 호출 다음 턴의 컨텍스트 증가로 근사합니다 (같은 턴의 병렬 호출은 균등 분배). 주입 = 한 번 들어간 양 · 누적 = 이후 압축 전까지 매 턴 다시 읽힌 합 · 비용 = 누적을 첫 턴 캐시 쓰기, 이후 캐시 읽기 단가로 환산. ' : '')
    + (cmp.group === 'name' ? ({ skills: '스킬 호출 = Claude Skill 도구 + Codex SKILL.md 읽기. ', mcp: 'MCP 호출 = mcp__<서버>__ 도구 호출. ', both: '스킬(Skill 도구·SKILL.md 읽기)과 MCP 서버 호출을 함께 셉니다. ' }[cmp.metric]) + '서브에이전트 호출도 포함합니다. ' : cmp.group !== 'model' ? '서브에이전트 사용량은 부모 에이전트에 합산합니다. ' : '') + '값은 실시간으로 갱신됩니다.';
}

// ---------- compare · per hour (stacked bars, one colour per group) ----------
const HR_SLOTS = 7;  // categorical slots --c1..--c7; the rest fold into 기타
// Round axis step: 1, 2 or 5 × 10^k so gridlines read $50, $100 … rather than $66.22.
const niceStep = raw => { const p = 10 ** Math.floor(Math.log10(raw)), f = raw / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; };
const hrColor = new Map();  // group key -> slot; a group keeps its colour while it stays in the top slots
// /api/history, fetched only while the 7-day span is on screen and refreshed every 5 minutes (sooner while the
// server is still building it).
let hist = null, histAt = 0, histBusy = false;
function needHist() {
  if (histBusy || Date.now() - histAt < 300e3) return;
  histBusy = true;
  api.history().then(d => { hist = d; histAt = Date.now() - (d?.scanning ? 270e3 : 0); })
    .catch(() => { histAt = Date.now() - 240e3; })
    .finally(() => { histBusy = false; if (route().v === 'compare' && cmp.view === 'hourly') renderCompare(); });
}
// Per-agent rows for the 7-day span: the live sessions' rows plus older sessions from /api/history, a subagent
// folded into its parent agent the same way agg() does for live ones.
function weekItems() {
  const items = cmpItems('agent'), byId = new Map(items.map(it => [it.kind + ':' + it.id, it]));
  if (onlyLive || onlyOrca || !hist) return items;  // past sessions are neither running nor open in Orca
  const ss = hist.sessions || [], titles = Object.fromEntries(ss.filter(x => !x.parent).map(x => [x.kind + ':' + x.id, x.title]));
  for (const x of ss) {
    const id = x.kind + ':' + (x.parent || x.id);
    let it = byId.get(id);
    if (!it) byId.set(id, it = { key: 'h:' + id, id: x.parent || x.id, kind: x.kind, name: titles[id] || (x.parent || x.id).slice(0, 8), model: x.model, a: { slots: {} } }), items.push(it);
    it.a = { ...it.a, slots: mergeSlots([it.a.slots, x.slots]) };
  }
  return items;
}
function renderHourly() {
  const week = cmp.span === WEEK, M = METRICS[cmp.metric], H = HOURLY[cmp.metric], box = $('#cmp'), U = unitOf(), per = U / 5;  // server slots per bar
  if (week) needHist();
  const now = Math.floor(Date.now() / (U * 6e4)), n = Math.max(1, cmp.span * 60 / U), lo = now - n + 1;
  const off = new Date().getTimezoneOffset(), localMin = b => b * U - off, at = b => new Date(b * U * 6e4);  // bar index -> local clock
  const [ta, tb] = cmp.tod, todOn = ta > 0 || tb < 24;
  // Bars shown: inside the span and starting within the chosen time of day; the hours between are cut out.
  const vis = [];
  for (let b = lo; b <= now; b++) { const hod = (((localMin(b) % 1440) + 1440) % 1440) / 60; if (hod >= ta && hod < tb) vis.push(b); }
  const shown = new Set(vis);
  // 5-minute slots -> bars of U minutes, keeping only the bars shown
  const rebin = ss => { const o = {}; for (const [k, v] of Object.entries(ss || {})) { const b = Math.floor(k / per); if (!shown.has(b)) continue; const t = o[b] ||= [0, 0, 0, 0, 0]; v.forEach((x, i) => t[i] += x); } return o; };
  const items = (week ? weekItems() : cmpItems(groupOf())).map(it => ({ ...it, bins: rebin(it.a.slots) }))
    .map(it => ({ ...it, tot: Object.values(it.bins).reduce((a, h) => a + H(h), 0) }))
    .filter(it => it.tot > 0).sort((a, b) => b.tot - a.tot);
  const top = items.slice(0, HR_SLOTS), rest = items.slice(HR_SLOTS), keys = new Set(top.map(i => i.key));
  for (const k of [...hrColor.keys()]) if (!keys.has(k)) hrColor.delete(k);
  const used = new Set(hrColor.values());
  for (const it of top) if (!hrColor.has(it.key)) { let c = 1; while (used.has(c)) c++; hrColor.set(it.key, c); used.add(c); }
  const series = top.map(it => ({ key: it.key, name: it.name, tot: it.tot, h: it.bins, c: `var(--c${hrColor.get(it.key)})`, go: it.go }));
  if (rest.length) series.push({ key: '~', name: `기타 ${rest.length}개`, tot: rest.reduce((a, i) => a + i.tot, 0), h: mergeSlots(rest.map(i => i.bins)), c: 'var(--m-other)' });
  const todTxt = todOn ? ` · ${String(ta).padStart(2, '0')}–${String(tb).padStart(2, '0')}시만` : '';
  $('#cmp-leg').innerHTML = series.map(x => `<span><i style="background:${x.c}"></i>${esc(x.name)} <b>${M.f(x.tot)}</b></span>`).join('') + (series.length ? `<span>최근 ${SPANS[cmp.span]}${todTxt} 합계 · 막대 = ${UNITS[U]} · 색 = ${(groupsAll()[groupOf()] || GROUPS.agent).replace('별', '')}</span>` : '');
  $('#cmp-note').textContent = `시간은 이 기기의 현지 시각입니다. 각 턴의 사용량을 그 턴이 끝난 시각의 ${UNITS[U]} 칸에 넣습니다. 상위 7개 그룹에만 색을 주고 나머지는 「기타」로 묶습니다. `
    + (todOn ? '시간대 밖의 시간은 그래프에서 잘라 내고, 날짜가 바뀌는 곳에 점선을 긋습니다. ' : '')
    + (week ? `7일 범위는 지금 대시보드가 보고 있는 세션에 지난 기록(5분마다 갱신${hist ? ', 마지막 ' + hhmm(new Date(hist.updated * 1000).toISOString()) : ''})을 더해 에이전트별로만 나눕니다${onlyLive || onlyOrca ? ` — 「${onlyLive ? '실행 중만' : 'Orca 에 열린 것만'}」이 켜져 있어 지난 기록은 빠졌습니다` : ''}. ` : '')
    + (cmp.metric === 'cost' ? '비용은 API 단가 환산 추정치이며, 단가가 없는 모델의 턴은 빠집니다. ' : '') + (groupOf() !== 'model' ? '서브에이전트 사용량은 부모 에이전트에 합산합니다. ' : '') + '값은 실시간으로 갱신됩니다.';
  if (week && !hist && !onlyLive && !onlyOrca) { box.innerHTML = '<div class="empty">지난 7일 기록을 불러오는 중입니다…</div>'; return; }
  if (!series.length) { box.innerHTML = `<div class="empty">최근 ${SPANS[cmp.span]}${todTxt} 동안 사용량이 없습니다.${week && hist?.scanning ? '<br><small>서버가 지난 기록을 아직 모으는 중입니다.</small>' : ''}</div>`; return; }
  const val = (x, b) => (x.h[b] ? H(x.h[b]) : 0);
  const col = vis.map(b => series.reduce((a, x) => a + val(x, b), 0));
  const multiDay = new Set(vis.map(b => Math.floor(localMin(b) / 1440))).size > 1;
  const w = box.clientWidth - 24 || 600, h = (window.innerWidth <= 700 ? 200 : 260) + (multiDay ? 12 : 0);
  const pl = 48, pr = 6, pt = 10, pb = multiDay ? 34 : 22, iw = w - pl - pr, ih = h - pt - pb, bw = iw / Math.max(1, vis.length);
  const top0 = Math.max(1e-9, ...col), tick = niceStep(top0 / 4), nt = Math.ceil(top0 / tick), max = tick * nt, y = v => pt + ih - v / max * ih;
  let g = `<svg width="${w}" height="${h}" class="hr-chart">`;
  for (let i = 0; i <= nt; i++) { const v = tick * i; g += `<line x1="${pl}" x2="${w - pr}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${pl - 5}" y="${y(v) + 3}" text-anchor="end">${M.f(v)}</text>`; }
  const gap = bw > 6 ? Math.min(4, bw * 0.2) : bw > 3 ? 1 : 0;
  vis.forEach((b, k) => {
    const x = pl + k * bw + gap / 2, bwid = Math.max(1, bw - gap);
    let base = 0;
    for (const s of series) {
      const v = val(s, b);
      if (v <= 0) continue;
      const y0 = y(base), y1 = y(base + v), hh = y0 - y1;
      // 2px panel-coloured gap between stacked segments, dropped when a segment is too thin to keep it
      g += `<rect x="${x}" y="${y1}" width="${bwid}" height="${hh > 3 ? hh - 2 : Math.max(hh, 0.5)}" fill="${s.c}"/>`;
      base += v;
    }
  });
  // Axis labels land on round clock times: the smallest of these minute steps that leaves ~44px per label.
  const stepMin = [5, 10, 15, 30, 60, 120, 180, 240, 360, 720, 1440].find(m => m >= U && iw / (vis.length * U / m) >= 44) || 1440;
  const hm = d => `${d.getHours()}${d.getMinutes() ? ':' + String(d.getMinutes()).padStart(2, '0') : '시'}`;
  const WD = '일월화수목금토';
  let prevDay = null, dated = multiDay;  // a single-day chart puts the date on its first tick
  vis.forEach((b, k) => {
    const x = pl + k * bw, d = at(b), day = Math.floor(localMin(b) / 1440), newDay = day !== prevDay;
    if (newDay && k > 0) g += `<line x1="${x}" x2="${x}" y1="${pt}" y2="${pt + ih}" stroke="var(--muted)" stroke-dasharray="3 3" opacity=".6"/>`;
    if (multiDay && newDay) g += `<text x="${x + 2}" y="${h - 4}" class="day">${d.getMonth() + 1}/${d.getDate()} (${WD[d.getDay()]})</text>`;
    if (!(((localMin(b) % stepMin) + stepMin) % stepMin)) { g += `<text x="${x}" y="${pt + ih + 14}" text-anchor="${k ? 'middle' : 'start'}">${dated ? '' : `${d.getMonth() + 1}/${d.getDate()} `}${hm(d)}</text>`; dated = true; }
    prevDay = day;
  });
  vis.forEach((b, k) => { g += `<rect class="hit" data-k="${k}" x="${pl + k * bw}" y="${pt}" width="${bw}" height="${ih}" fill="transparent"/>`; });
  box.innerHTML = g + '</svg>';
  const tip = $('#tip');
  box.querySelectorAll('.hit').forEach(r => {
    const k = +r.dataset.k, b = vis[k], d0 = at(b), d1 = at(b + 1);
    r.onmousemove = e => {
      const rows = series.map(s => [s, val(s, b)]).filter(([, v]) => v > 0).sort((a, c) => c[1] - a[1]);
      const t = d => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      const html = `<b>${d0.getMonth() + 1}/${d0.getDate()} (${WD[d0.getDay()]}) ${t(d0)}–${t(d1)}</b> · ${M.label} ${M.f(col[k])}`
        + (rows.length ? rows.map(([s, v]) => `<br><i class="sw" style="background:${s.c}"></i>${esc(s.name)} <b>${M.f(v)}</b>`).join('') : '<br>사용 없음');
      tip.show(html, e);
    };
    r.onmouseleave = () => tip.hide();
  });
}

// ---------- run detail (reached from links on other screens) ----------
function renderRun(id) {
  const run = state.orca.runs.find(r => r.id === id);
  if (!run) { $('#view').innerHTML = '<a class="back" href="#agents" onclick="history.length > 1 && (history.back(), event.preventDefault())">← 뒤로</a><div class="empty">Run 을 찾을 수 없습니다 (최근 Run 만 추적).</div>'; return; }
  const tasks = state.orca.tasks[run.id] || [];
  const workers = Object.fromEntries(state.orca.workers.filter(w => w.runId === run.id).map(w => [w.taskId, w]));
  const sessByTask = Object.fromEntries(state.sessions.filter(s => s.task_id).map(s => [s.task_id, s]));
  const coord = state.sessions.find(s => s.own_handle === run.coordinator_handle && !s.parent);
  const byId = Object.fromEntries(tasks.map(t => [t.id, t]));
  const depsOf = t => { try { return JSON.parse(t.deps || '[]'); } catch { return []; } };
  const depth = {};
  const lvl = (t, seen = new Set()) => {
    if (depth[t.id] !== undefined) return depth[t.id];
    if (seen.has(t.id)) return 0; seen.add(t.id);
    const ds = depsOf(t).map(i => byId[i]).filter(Boolean);
    return depth[t.id] = ds.length ? 1 + Math.max(...ds.map(x => lvl(x, seen))) : 0;
  };
  tasks.forEach(t => lvl(t));
  const stages = [];
  tasks.forEach(t => (stages[depth[t.id]] ||= []).push(t));
  const raw = Object.fromEntries((runFull?.tasks || []).map(x => [x.id, x.result]));
  const result = t => { try { return JSON.parse(raw[t.id] || 'null') || (t.outcome ? { outcome: t.outcome } : null); } catch { return null; } };
  const counts = tasks.reduce((a, t) => (a[t.status] = (a[t.status] || 0) + 1, a), {});
  const wcost = tasks.reduce((a, t) => a + (sessByTask[t.id]?.cost || 0), 0);
  const start = tasks.map(t => toDate(t.created_at)).sort((a, b) => a - b)[0];
  const end = new Date(Math.max(...tasks.map(t => t.completed_at ? new Date(t.completed_at) : new Date())));
  const span = Math.max(1, end - start);
  const gantt = tasks.map(t => {
    const s0 = toDate(t.created_at), e0 = t.completed_at ? new Date(t.completed_at) : new Date();
    return `<tr><td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.display_name || t.task_title || t.id)}</td><td style="min-width:120px">
      <div style="position:relative;height:14px;background:var(--bg);border-radius:3px">
      <div style="position:absolute;left:${(s0 - start) / span * 100}%;width:${Math.max(0.5, (e0 - s0) / span * 100)}%;top:0;bottom:0;background:${STATUS_COLOR(t.status)};border-radius:3px"></div></div></td>
      <td class="n" style="width:56px">${dur(t.created_at, t.completed_at)}</td></tr>`;
  }).join('');
  $('#view').innerHTML = `<a class="back" href="#agents" onclick="history.length > 1 && (history.back(), event.preventDefault())">← 뒤로</a>
    <h2 class="d">${esc(run.objective)}</h2>
    <div class="sub-h">${run.id} · 생성 ${ago(run.created_at)}</div>
    <div class="rel box"><b>상위 코디네이터</b>${coord ? `<a href="#s=${encodeURIComponent(coord.path)}">${esc(nameOf(coord))}</a> ${modelChip(coord.model)} <span class="st">${usd(coord.cost)} · ${coord.turns}턴</span>` : `<span>${esc(ownerName(run.coordinator_handle))}</span> <span class="st">${ownerNote(run.coordinator_handle)}</span>`}</div>
    <div class="kpis">
      <div class="kpi"><span>태스크</span><b>${tasks.length}</b></div>
      ${Object.entries(counts).map(([k, v]) => `<div class="kpi"><span>${esc(k)}</span><b style="color:${STATUS_COLOR(k)}">${v}</b></div>`).join('')}
      <div class="kpi"><span>워커 비용 합계</span><b>${usd(wcost)}</b></div>
      <div class="kpi"><span>경과</span><b>${dur(tasks[0]?.created_at, tasks.every(t => t.completed_at) ? end.toISOString() : null)}</b></div>
    </div>
    <div class="box"><h3>태스크 관계도 <span class="st">코디네이터 → deps 단계 순 · 노드를 누르면 워커 세션</span></h3><div class="gwrap" id="run-graph"></div></div>
    <div class="box"><h3>타임라인</h3><div style="overflow-x:auto"><table>${gantt}</table></div></div>`;
  runGraph(run, tasks, stages, depsOf, workers, result, sessByTask, coord);
}

function runGraph(run, tasks, stages, depsOf, workers, result, sessByTask, coord) {
  const el = $('#run-graph');
  const NW = 230, NH = 58, CG = 64, RG = 12, PAD = 14;
  const cols = [[{ id: 'coord' }], ...stages.map(st => st || [])];
  const H = Math.max(...cols.map(c => c.length)) * (NH + RG) - RG + PAD * 2;
  const W = cols.length * (NW + CG) - CG + PAD * 2;
  const pos = {};
  cols.forEach((c, ci) => { const top = (H - (c.length * (NH + RG) - RG)) / 2; c.forEach((n, ri) => pos[n.id] = { x: PAD + ci * (NW + CG), y: top + ri * (NH + RG) }); });
  const edge = (a, b, cls) => { const p = pos[a], q = pos[b]; if (!p || !q) return ''; const x1 = p.x + NW, y1 = p.y + NH / 2, x2 = q.x - 6, y2 = q.y + NH / 2, mx = (x1 + x2) / 2; return `<path class="gedge ${cls}" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" marker-end="url(#arr)"/>`; };
  let edges = '';
  for (const t of tasks) {
    const deps = depsOf(t).filter(d => pos[d]);
    if (!deps.length) edges += edge('coord', t.id, 'coord');
    for (const d of deps) edges += edge(d, t.id, 'dep');
  }
  const box = (id, x, y, color, title, l2, l3) => `<g class="rnode gnode" data-id="${esc(id)}" transform="translate(${x},${y})">
      <rect width="${NW}" height="${NH}" rx="7" fill="var(--bg)" stroke="${color}"/><rect width="5" height="${NH}" rx="2" fill="${color}"/>
      <text x="14" y="18">${esc(cut(title, 30))}</text><text class="m" x="14" y="35">${esc(cut(l2, 38))}</text><text class="m" x="14" y="50">${esc(cut(l3, 38))}</text></g>`;
  let nodes = box('coord', pos.coord.x, pos.coord.y, 'var(--coord)', '코디네이터' + (coord ? ' · ' + nameOf(coord) : ''), coord ? `${modelName(coord.model)} · ${coord.turns}턴 · ctx ${fmt(coord.ctx_now)}` : run.coordinator_handle, coord ? `비용 ${usd(coord.cost)} · 태스크 ${tasks.length}` : `태스크 ${tasks.length}`);
  for (const t of tasks) {
    const r = result(t), w = workers[t.id], s = sessByTask[t.id];
    const model = s?.model || w?.model || '';
    nodes += box(t.id, pos[t.id].x, pos[t.id].y, STATUS_COLOR(t.status), t.display_name || t.task_title || t.id,
      `${t.status}${r?.outcome ? ' · ' + r.outcome : ''} · ${dur(t.created_at, t.completed_at)}`,
      s ? `${modelName(model)} · ${s.turns}턴 · ${usd(s.cost)}` : modelName(model));
  }
  el.style.overflow = 'auto';
  el.innerHTML = `<svg width="${W}" height="${H}" style="width:${W}px;cursor:default"><defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--muted)"/></marker></defs>${edges}${nodes}</svg>`;
  const tip = $('#tip'), byId = Object.fromEntries(tasks.map(t => [t.id, t]));
  el.querySelectorAll('.rnode').forEach(g => {
    const t = byId[g.dataset.id];
    g.onclick = () => { const s = t ? sessByTask[t.id] : coord; if (s) openSession(s.path); };
    if (!t) return;
    g.onmousemove = e => {
      const r = result(t);
      tip.show(`<b>${esc(t.display_name || t.task_title)}</b><br>${esc(t.status)} · ${dur(t.created_at, t.completed_at)}${r?.body ? '<br>' + esc(r.body.replace(/\/private\/tmp\S+\//g, '…/')).replace(/\n/g, '<br>') : ''}`, e);
    };
    g.onmouseleave = () => tip.hide();
  });
}

// ---------- session detail ----------
function renderSession(navigated) {
  const d = detail, a = agg(d), tk = d.tokens, totalIn = tk.input + tk.cache_read + tk.cache_write;
  const tools = Object.entries(d.by_tool).sort((x, y) => y[1].ctx_growth - x[1].ctx_growth);
  const scroll = $('.log')?.scrollTop;
  const task = d.role === 'worker' ? IX.tasks[d.task_id] : null, run = task ? IX.runOf[d.task_id] : null;
  const coord = d.role === 'worker' ? state.sessions.find(s => s.own_handle === d.coord_handle && !s.parent) : null;
  const kids = d.own_handle ? byRank(state.sessions.filter(s => s.role === 'worker' && s.coord_handle === d.own_handle && !s.parent), sessRank) : [];
  const parent = d.parent ? IX.byId[d.parent] : null;
  const cp = d.cost_parts;
  let rel = '';
  if (coord || (d.role === 'worker')) rel += `<div class="rel"><b>코디네이터</b>${coord ? `<a href="#s=${encodeURIComponent(coord.path)}">${esc(nameOf(coord))}</a> ${modelChip(coord.model)}` : (d.coord_handle ? `<span>${esc(ownerName(d.coord_handle))}</span> <span class="st">${ownerNote(d.coord_handle)}</span>` : '<span class="st">추적 범위 밖</span>')}${run ? ` · Run <a href="#r=${run.id}">${esc(cut(run.objective, 50))}</a>` : ''}${task ? ` · 태스크 <span style="color:${STATUS_COLOR(task.status)}">${esc(task.status)}</span>` : ''}</div>`;
  if (parent) rel += `<div class="rel"><b>부모 세션</b><a href="#s=${encodeURIComponent(parent.path)}">${esc(nameOf(parent))}</a></div>`;
  let kidsHtml = '';
  if (kids.length) {
    const kc = kids.reduce((x, k) => x + (agg(k).cost || 0), 0);
    kidsHtml += `<details class="box" id="d-kids" ${(openState.kids ?? kids.length <= 6) ? 'open' : ''}><summary><b>워커 ${kids.length}</b> <span class="st">실행 중 ${kids.filter(k => agg(k).live).length} · 합계 비용 ${usd(kc)} · 합계 턴 ${fmt(kids.reduce((x, k) => x + agg(k).turns, 0))}</span></summary><div class="tree" style="margin-top:10px"><div class="grid">${kids.map(k => card(k)).join('')}</div></div></details>`;
  }
  if (a.subs.length) kidsHtml += `<details class="box" id="d-subs" ${openState.subs ? 'open' : ''}><summary><b>서브에이전트 ${a.subs.length}</b> <span class="st">합계 비용 ${usd(a.subs.reduce((x, k) => x + (k.cost || 0), 0))}</span></summary><div class="grid" style="margin-top:10px">${a.subs.map(k => card(k)).join('')}</div></details>`;
  $('#view').innerHTML = `<a class="back" href="#agents">← 에이전트</a>
    <h2 class="d">${esc(nameOf(d))}</h2>${d.hidden || state.hid.has(d.path) ? `<div class="box st" style="border-color:var(--warn)">이 세션은 대시보드에서 숨겨져 있습니다${d.hidden ? '' : ' (상위 코디네이터가 숨겨짐)'}. ${d.hidden ? '"복원"을 누르면 다시 보입니다.' : '<a href="#hidden">숨김 탭</a>에서 복원하세요.'}</div>` : ''}
    <div class="sub-h">${d.role !== 'solo' ? `<span class="badge ${d.role === 'coordinator' ? 'coord' : isSubCoord(d) ? 'subcoord' : 'worker'}">${isSubCoord(d) ? '하위 코디네이터' : ROLE[d.role]}</span> ` : ''}${modelChip(d.model)} · ${d.kind}${srvBadge(d) ? ' · ' + srvBadge(d) : ''} · <b title="${esc(d.cwd || '')}">▣ ${esc(placeLabel(d.place))}</b><br>${esc(d.id)} · 시작 ${d.started ? esc(new Date(toDate(d.started)).toLocaleString('ko-KR', { hour12: false })) : '–'} · ${OPEN(status(d)) ? '가동' : '가동(종료)'} ${lifetime(d)}</div>
    <div class="c-top" style="margin:-4px 0 12px">${pill(status(d), d)}${actBtns(d, true)}${d.last_action ? `<span class="now" style="flex:1"><b>${status(d) === 'run' ? '지금' : '마지막'}</b>${esc(NOW_ROLE[d.last_action.role] || '')} · ${esc(d.last_action.text)}</span>` : ''}</div>
    ${rel ? `<div class="box">${rel}</div>` : ''}
    ${workerPlanBox(d)}
    ${extPlansHtml(plansOf(d), true)}
    ${planBox(d)}
    <div class="kpis">
      <div class="kpi"><span>턴</span><b>${d.turns}</b></div>
      <div class="kpi" title="${ctxTitle(d)}"><span>현재 컨텍스트</span><b class="${ctxLvl(d)}">${fmt(d.ctx_now)}</b>${d.ctx_window ? `<small> / ${fmt(d.ctx_window)}</small>` : ''}</div>
      <div class="kpi"><span>피크 · 평균</span><b>${fmt(d.ctx_peak)}</b><small> · ${fmt(d.ctx_avg)}</small></div>
      <div class="kpi"><span>비용</span><b>${usd(d.cost)}</b>${d.cost != null && d.turns ? `<small> · ${usd(d.cost / d.turns)}/턴</small>` : ''}</div>
      <div class="kpi"><span>스킬 호출</span><b>${d.skills}</b><small> · ${d.skill_kinds}종</small></div>
      <div class="kpi"><span>압축</span><b>${d.compactions}</b></div>
      <div class="kpi"><span>총 입력</span><b>${fmt(totalIn)}</b><small> · 캐시 ${totalIn ? Math.round(tk.cache_read / totalIn * 100) : 0}%</small></div>
      <div class="kpi"><span>총 출력</span><b>${fmt(tk.output)}</b></div>
    </div>
    ${cp ? `<div class="box"><h3>비용 구성 <span class="st">${usd(d.cost)}${a.subs.length ? ` · 서브에이전트 포함 ${usd(a.cost)}` : ''}</span></h3>
      <div class="track" style="height:22px">${[['input', '--s-input'], ['cache_write', '--s-write'], ['cache_read', '--s-read'], ['output', '--s-out']].map(([k, c]) => `<div style="width:${cp[k] / (d.cost || 1) * 100}%;background:var(${c})" title="${k} ${usd(cp[k])}"></div>`).join('')}</div>
      <div class="legend" style="margin-top:6px">${[['input', '입력', '--s-input'], ['cache_write', '캐시 쓰기', '--s-write'], ['cache_read', '캐시 읽기', '--s-read'], ['output', '출력', '--s-out']].map(([k, n, c]) => `<span><i style="background:var(${c})"></i>${n} ${usd(cp[k])}</span>`).join('')}</div></div>` : `<div class="box st">이 모델(${esc(modelName(d.model))})은 단가가 없어 비용을 계산하지 않았습니다. pricing.json 에 단가를 넣으면 표시됩니다.</div>`}
    ${kidsHtml}
    <div class="box"><h3>턴별 컨텍스트 <span class="legend" style="margin:0"><span><i style="background:var(--s-read)"></i>캐시 읽기</span><span><i style="background:var(--s-write)"></i>캐시 쓰기</span><span><i style="background:var(--s-input)"></i>새 입력</span><span><i style="background:var(--warn)"></i>압축</span></span></h3><div id="ctx-chart"></div></div>
    <div class="grid2">
      <div class="box"><h3>작업 분류 <span class="st">도구 호출 ${d.tool_calls}회 · 무엇에 썼는지 기준</span></h3>
        ${chipRow('스킬', d.skill_use, '--s-write')}${chipRow('MCP', d.mcp_use, '--accent', mcpName)}
        ${(() => {
          const calls = bothUse(d), rows = Object.entries(d.use_tok || {}).sort((a, b) => b[1][2] - a[1][2] || b[1][1] - a[1][1]);
          if (!rows.length) return '';
          const nm = METRICS.both.nm;
          return `<div style="overflow-x:auto;margin:8px 0"><table><tr><th>스킬·MCP</th><th class="n">호출</th><th class="n" title="호출 결과가 컨텍스트에 한 번 들어간 토큰">주입</th><th class="n">호출당</th><th class="n" title="압축 전까지 이후 매 턴 다시 읽힌 토큰 합">누적</th><th class="n" title="누적을 첫 턴 캐시 쓰기, 이후 캐시 읽기 단가로 환산">누적 비용</th></tr>
          ${rows.map(([k, [inj, carry, cost]]) => `<tr><td>${esc(nm(k))}</td><td class="n">${calls[k] || 0}</td><td class="n">${fmt(inj)}</td><td class="n">${fmt(inj / (calls[k] || 1))}</td><td class="n">${fmt(carry)}</td><td class="n">${usd(cost)}</td></tr>`).join('')}</table></div>`;
        })()}
        <div style="overflow-x:auto;margin-top:8px"><table><tr><th>분류</th><th class="n">호출</th><th class="n">컨텍스트 증가</th><th class="n">호출당</th></tr>
        ${tools.map(([n, b]) => `<tr><td>${esc(n)}</td><td class="n">${b.calls}</td><td class="n">${fmt(b.ctx_growth)}</td><td class="n">${fmt(b.ctx_growth / b.calls)}</td></tr>`).join('') || '<tr><td colspan=4 class="st">도구 호출 없음</td></tr>'}</table></div>
        <div class="st" style="margin-top:6px">스킬은 Skill 도구 호출과 SKILL.md 읽기(Codex)를 셉니다. 컨텍스트 증가는 도구 결과가 다음 턴을 얼마나 키웠는지로 근사합니다. 누적은 그 토큰이 압축 전까지 매 턴 다시 읽힌 합입니다.</div></div>
      <div class="box"><h3>로그 <span class="st">최근 ${d.log.length}건</span></h3>
        <div class="log">${d.log.map(l => `<div class="${l.role} ${hlTurn !== null && l.turn === hlTurn ? 'hl' : ''}"><span class="st">${hhmm(l.ts)}</span><span class="r">${l.role}${l.turn >= 0 ? ' #' + (l.turn + 1) : ''}</span>
          <span class="${l.error ? 'err' : ''}"><b class="r">${window.innerWidth <= 700 ? esc(l.role) + ' ' : ''}</b>${esc(l.text)}${l.detail ? ' <span class="st">' + esc(l.detail) + '</span>' : ''}${l.size ? ' <span class="st">(' + fmt(l.size) + '자)</span>' : ''}</span></div>`).join('')}</div></div>
    </div>`;
  $('#view').querySelectorAll('.card[data-path]').forEach(c => c.onclick = () => openSession(c.dataset.path));
  for (const k of ['kids', 'subs', 'prevplans']) { const el = $('#d-' + k); if (el) el.ontoggle = () => openState[k] = el.open; }
  $('#view').querySelectorAll('[data-ttoggle]').forEach(b => b.onclick = e => {
    if (e.target.closest('a')) return;
    famMin[b.dataset.ttoggle] = !b.closest('.tk').classList.contains('open');
    try { localStorage.setItem('adash.min', JSON.stringify(famMin)); } catch {}
    { const sv = saveScroll(); renderSession(); restoreScroll(sv); }
  });
  ctxChart(d);
  planChart(d);
  wpChart(d);
  const log = $('.log');
  if (hlTurn !== null) log.querySelector('.hl')?.scrollIntoView({ block: 'center' });
  else if (navigated || scroll === undefined || d.live) log.scrollTop = log.scrollHeight;
  else log.scrollTop = scroll;
}

function ctxChart(d) {
  const el = $('#ctx-chart'), T = d.turn_list, w = el.clientWidth || 600, h = window.innerWidth <= 700 ? 170 : 210;
  if (!T.length) { el.innerHTML = '<div class="st">아직 턴이 없습니다.</div>'; return; }
  const pl = 40, pr = 6, pt = 8, pb = 18, iw = w - pl - pr, ih = h - pt - pb, bw = iw / T.length;
  const max = Math.max(d.ctx_window && d.ctx_peak > d.ctx_window * 0.5 ? d.ctx_window : 0, ...T.map(t => t.ctx)) * 1.05;
  const y = v => pt + ih - v / max * ih, comp = new Set(d.compaction_turns);
  let s = `<svg width="${w}" height="${h}">`;
  for (let i = 0; i <= 4; i++) { const v = max / 4 * i; s += `<line x1="${pl}" x2="${w - pr}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${pl - 5}" y="${y(v) + 3}" text-anchor="end">${fmt(v)}</text>`; }
  if (d.ctx_window && d.ctx_window <= max) s += `<line x1="${pl}" x2="${w - pr}" y1="${y(d.ctx_window)}" y2="${y(d.ctx_window)}" stroke="var(--bad)" stroke-dasharray="4 3"/>`;
  T.forEach((t, i) => {
    const x = pl + i * bw, bwid = Math.max(1, bw - (bw > 4 ? 1 : 0));
    let base = 0;
    for (const [v, c] of [[t.cache_read, '--s-read'], [t.cache_write, '--s-write'], [t.input, '--s-input']]) { if (v > 0) s += `<rect x="${x}" y="${y(base + v)}" width="${bwid}" height="${y(base) - y(base + v)}" fill="var(${c})"/>`; base += v; }
    if (comp.has(i)) s += `<rect x="${x}" y="${pt}" width="${Math.max(2, bwid)}" height="${ih}" fill="var(--warn)" opacity=".35"/>`;
    s += `<rect class="hit" data-i="${i}" x="${x}" y="${pt}" width="${Math.max(bw, 1)}" height="${ih}" fill="transparent"/>`;
  });
  const step = Math.ceil(T.length / (w < 500 ? 5 : 10));
  for (let i = 0; i < T.length; i += step) s += `<text x="${pl + i * bw + bw / 2}" y="${h - 4}" text-anchor="middle">${i + 1}</text>`;
  el.innerHTML = s + '</svg>';
  const tip = $('#tip');
  el.querySelectorAll('.hit').forEach(r => {
    const show = e => { const t = T[+r.dataset.i]; tip.show(`<b>턴 #${+r.dataset.i + 1}</b> · ${hhmm(t.ts)}<br>컨텍스트 ${fmt(t.ctx)} · 출력 ${fmt(t.output)}${t.tools.length ? '<br>도구: ' + esc(t.tools.join(', ')) : ''}`, e); };
    r.onmousemove = show; r.onmouseleave = () => tip.hide();
    r.onclick = e => { hlTurn = +r.dataset.i; tip.hide(); renderSession(); };
  });
}

// Cut by display width: Hangul and other wide glyphs count ~1.8 Latin characters.
const cutW = (t, units) => { t = String(t ?? ''); let w = 0, i = 0; for (; i < t.length; i++) { w += /[\u1100-\uffdc]/.test(t[i]) ? 1.8 : 1; if (w > units) return t.slice(0, i) + '…'; } return t; };

// Attention first: stalled → waiting for input → running → planned → done → idle.
const RANK = { stalled: 0, wait: 1, run: 2, bg: 2, planned: 3, blocked: 3, done: 4, idle: 5 };
const famRank = f => Math.min(...f.members.map(m => m.decision ? -1 : RANK[status(m)] ?? 5), workerPlan(f.handle, f.extra)?.waiting ? 3 : 9);

// ---------- 상호작용 (messages between sessions, from Orca's orchestration inbox) ----------
const TALK_TYPES = { question: ['질문', 'var(--warn)'], escalation: ['에스컬레이션', 'var(--bad)'], worker_done: ['완료 보고', 'var(--done)'], status: ['상태·답', 'var(--accent)'], heartbeat: ['heartbeat', 'var(--idle)'] };
const talk = { types: new Set(['question', 'escalation', 'worker_done', 'status']), who: '', q: '', threads: true, limit: 1500, view: localStorage.getItem('talkView') || 'list', hours: 24, pair: null, sel: null, pos: {}, open: new Set(), data: null, key: null, at: 0, busy: false, err: null };
let talkMounted = false;

// One end of a message -> {name, path, note}. A session that owns the terminal wins; otherwise the Orca terminal
// title, otherwise what the address itself says (a Run's coordinator, a task's worker).
function talkEnd(term, kind, raw, m) {
  const s = term && (state.all || state.sessions).find(x => x.own_handle === term && !x.parent);
  if (s) return { key: term, name: nameOf(s), path: s.path, model: s.model, st: status(s), coord: s.role === 'coordinator' || isSubCoord(s) };
  const t = term && (state.orca.terminals || []).find(x => x.handle === term);
  const run = m.run_id && state.orca.runs.find(r => r.id === m.run_id);
  if (kind === 'run') return { key: term || raw, name: t?.title ? `${t.title} (코디네이터)` : `Run 코디네이터${run ? ' · ' + cut(run.objective, 30) : ''}`, note: '세션 추적 범위 밖' };
  if (kind === 'dispatch') return { key: term || raw, name: IX.tasks[m.task_id]?.display_name || t?.title || '워커 ' + raw.slice(9, 21), note: '세션 추적 범위 밖' };
  return { key: term || raw, name: t?.title || (term ? '터미널 ' + term.slice(5, 13) : raw), note: t ? 'Orca 터미널' : '종료된 터미널' };
}

async function loadTalk(force) {
  const key = talk.limit + '|' + talk.types.has('heartbeat');
  if (talk.busy || (!force && talk.key === key && Date.now() - talk.at < 5000)) return;
  talk.busy = true;
  try { const d = await api.interactions(talk.limit, talk.types.has('heartbeat')); talk.data = d; talk.err = d?.error || null; talk.key = key; }
  catch (e) { talk.err = String(e?.message || e); }
  finally { talk.at = Date.now(); talk.busy = false; }
}

function setTalkView(v) {
  talk.view = v; localStorage.setItem('talkView', v);
  $('#view').querySelectorAll('[data-tv]').forEach(b => b.classList.toggle('on', b.dataset.tv === v));
  $('#talk-th').closest('label').style.display = v === 'graph' ? 'none' : '';
  drawTalk();
}

// Graph: one node per session (or terminal) that sent or received, one arrow per direction between two of them.
// Positions come from a small force layout and are kept across refreshes, so the picture holds still while
// new messages arrive; a node can be dragged where it reads best.
function talkLayout(nodes, edges, W, H) {
  const P = talk.pos, fresh = nodes.filter(n => !P[n.key]);
  if (!fresh.length && nodes.every(n => !P[n.key].dirty)) return;
  const hash = k => [...k].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const nb = {};
  edges.forEach(e => { (nb[e.a] ||= []).push(e.b); (nb[e.b] ||= []).push(e.a); });
  fresh.forEach(n => {  // start next to a placed neighbour, else on a circle
    const k = (nb[n.key] || []).find(x => P[x]), h = hash(n.key), ang = (h % 360) * Math.PI / 180;
    P[n.key] = k ? { x: P[k].x + Math.cos(ang) * 60, y: P[k].y + Math.sin(ang) * 60 } : { x: W / 2 + Math.cos(ang) * W * .35, y: H / 2 + Math.sin(ang) * H * .35 };
  });
  const iters = fresh.length === nodes.length ? 420 : 160, K = Math.sqrt(W * H / Math.max(1, nodes.length)) * .55;
  for (let it = 0; it < iters; it++) {
    const t = 1 - it / iters, F = {};
    nodes.forEach(n => F[n.key] = { x: 0, y: 0 });
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = P[nodes[i].key], b = P[nodes[j].key];
      let dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy || .01;
      if (d2 > 9 * K * K) continue;
      const f = K * K / d2;
      F[nodes[i].key].x += dx * f; F[nodes[i].key].y += dy * f; F[nodes[j].key].x -= dx * f; F[nodes[j].key].y -= dy * f;
    }
    edges.forEach(e => {
      const a = P[e.a], b = P[e.b], dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || .01, f = d / K * (1 + Math.log2(e.n) * .15);
      F[e.a].x += dx / d * f * d * .02; F[e.a].y += dy / d * f * d * .02; F[e.b].x -= dx / d * f * d * .02; F[e.b].y -= dy / d * f * d * .02;
    });
    nodes.forEach(n => {
      const p = P[n.key], f = F[n.key];
      if (p.pin) return;
      f.x += (W / 2 - p.x) * .012; f.y += (H / 2 - p.y) * .012;  // gravity keeps separate groups on screen
      const m = Math.hypot(f.x, f.y) || 1, step = Math.min(m, 18 * t + 1);
      p.x = Math.max(60, Math.min(W - 60, p.x + f.x / m * step)); p.y = Math.max(30, Math.min(H - 40, p.y + f.y / m * step));
    });
  }
  nodes.forEach(n => delete P[n.key].dirty);
}

function drawTalkGraph(msgs) {
  const nodes = {}, edges = {};
  msgs.forEach(m => {
    [m.f, m.t].forEach(e => { nodes[e.key] ||= { ...e, sent: 0, recv: 0, last: '' }; });
    nodes[m.f.key].sent++; nodes[m.t.key].recv++;
    [m.f.key, m.t.key].forEach(k => { if (m.created_at > nodes[k].last) nodes[k].last = m.created_at; });
    if (m.f.key === m.t.key) return;
    const e = edges[m.f.key + '>' + m.t.key] ||= { a: m.f.key, b: m.t.key, n: 0, types: {}, last: '' };
    e.n++; e.types[m.type] = (e.types[m.type] || 0) + 1; if (m.created_at > e.last) e.last = m.created_at;
  });
  const NL = Object.values(nodes), EL = Object.values(edges), box = $('#talk-list');
  if (!NL.length) { box.innerHTML = `<div class="empty">${talk.data ? '조건에 맞는 메시지가 없습니다.' : '불러오는 중…'}</div>`; return; }
  const W = Math.max(720, box.clientWidth - 2), H = Math.max(520, Math.round(Math.sqrt(NL.length) * 110));
  talkLayout(NL, EL, W, H);
  const P = talk.pos, r = n => 7 + Math.min(16, Math.sqrt(n.sent + n.recv) * 1.6);
  const sel = talk.sel && nodes[talk.sel] ? talk.sel : null;
  const near = sel ? new Set([sel, ...EL.filter(e => e.a === sel || e.b === sel).flatMap(e => [e.a, e.b])]) : null;
  const top = e => Object.entries(e.types).sort((x, y) => y[1] - x[1])[0][0];
  const edgeSvg = EL.map(e => {
    const a = P[e.a], b = P[e.b], A = nodes[e.a], B = nodes[e.b], both = edges[e.b + '>' + e.a];
    const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d;
    const bend = both ? 22 : 0, mx = (a.x + b.x) / 2 - uy * bend, my = (a.y + b.y) / 2 + ux * bend;  // two directions curve apart
    const sx = a.x + ux * r(A), sy = a.y + uy * r(A), ex = b.x - ux * (r(B) + 4), ey = b.y - uy * (r(B) + 4);
    const ty = top(e), w = 1.2 + Math.log2(e.n) * 1.1, dim = near && !(e.a === sel || e.b === sel);
    const tip = `${A.name} → ${B.name}\n${Object.entries(e.types).map(([k, v]) => `${TALK_TYPES[k]?.[0] || k} ${v}`).join(' · ')}\n마지막 ${hm(e.last)} · ${ago(e.last)}\n누르면 이 둘 사이 메시지를 리스트로`;
    return `<g class="tg-e ${dim ? 'dim' : ''}" data-a="${esc(e.a)}" data-b="${esc(e.b)}"><path d="M${sx},${sy} Q${mx},${my} ${ex},${ey}" stroke="${TALK_TYPES[ty]?.[1] || 'var(--muted)'}" stroke-width="${w}" marker-end="url(#tg-${ty})"/>
      <path class="tg-hit" d="M${sx},${sy} Q${mx},${my} ${ex},${ey}"/>${e.n > 1 ? `<text x="${(sx + 2 * mx + ex) / 4}" y="${(sy + 2 * my + ey) / 4 - 3}" class="tg-n">${e.n}</text>` : ''}<title>${esc(tip)}</title></g>`;
  }).join('');
  const nodeSvg = NL.map(n => {
    const p = P[n.key], R = r(n), dim = near && !near.has(n.key);
    const fill = n.st ? (n.st === 'run' ? 'color-mix(in srgb, var(--ok) 22%, var(--panel))' : n.st === 'wait' ? 'color-mix(in srgb, var(--warn) 22%, var(--panel))' : 'var(--panel)') : 'var(--panel2)';
    const tip = `${n.name}${n.note ? ' · ' + n.note : ''}\n보냄 ${n.sent} · 받음 ${n.recv} · 마지막 ${ago(n.last)}\n누르면 연결만 강조 · 두 번 누르면 세션 상세`;
    return `<g class="tg-v ${dim ? 'dim' : ''} ${n.key === sel ? 'sel' : ''}" data-k="${esc(n.key)}" transform="translate(${p.x},${p.y})">
      <circle r="${R}" fill="${fill}" stroke="${n.coord ? 'var(--coord)' : n.path ? 'var(--accent)' : 'var(--muted)'}" stroke-width="${n.coord ? 2.6 : 1.6}" ${n.path ? '' : 'stroke-dasharray="3 2"'}/>
      ${n.model ? `<circle r="3.5" fill="var(--m-${modelKey(n.model)})"/>` : ''}
      <text y="${R + 13}" text-anchor="middle" class="tg-l">${esc(cutW(n.name, 26))}</text><title>${esc(tip)}</title></g>`;
  }).join('');
  const xs = NL.map(n => P[n.key].x), ys = NL.map(n => P[n.key].y);
  const vx = Math.max(0, Math.min(...xs) - 90), vy = Math.max(0, Math.min(...ys) - 30), vw = Math.max(...xs) + 90 - vx, vh = Math.max(...ys) + 40 - vy;
  const markers = Object.entries(TALK_TYPES).map(([k, [, c]]) => `<marker id="tg-${k}" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="${c}"/></marker>`).join('');
  const info = sel ? (() => {
    const n = nodes[sel], outE = EL.filter(e => e.a === sel), inE = EL.filter(e => e.b === sel);
    return `<div class="tg-info"><b>${n.path ? `<a href="#s=${encodeURIComponent(n.path)}">${esc(n.name)}</a>` : esc(n.name)}</b> <span class="st">보냄 ${n.sent} · 받음 ${n.recv} · 상대 ${new Set([...outE.map(e => e.b), ...inE.map(e => e.a)]).size}</span>
      <button class="act" id="tg-list">이 세션 메시지를 리스트로</button> <button class="act" id="tg-clear">강조 해제</button></div>`;
  })() : '';
  box.innerHTML = `<div class="gwrap tg-wrap">${info}<svg id="tg-svg" width="${vw}" height="${vh}" viewBox="${vx} ${vy} ${vw} ${vh}"><defs>${markers}</defs>${edgeSvg}${nodeSvg}</svg>
    <div class="st">원 = 세션(테두리 보라 = 코디네이터, 점선 = 세션 추적 범위 밖) · 원 크기 = 주고받은 메시지 수 · 화살표 = 보낸 쪽 → 받는 쪽, 굵기 = 건수, 색 = 가장 많은 종류. 노드를 끌어 옮길 수 있고, 화살표를 누르면 그 둘 사이 메시지가 리스트로 열립니다.</div></div>`;
  if (sel) {
    $('#tg-list').onclick = () => { talk.who = sel; talk.sel = null; $('#talk-who').value = sel; setTalkView('list'); };
    $('#tg-clear').onclick = () => { talk.sel = null; drawTalk(); };
  }
  const svg = $('#tg-svg');
  svg.querySelectorAll('.tg-e').forEach(g => g.onclick = () => {
    talk.pair = [g.dataset.a, g.dataset.b]; talk.pair.names = [nodes[g.dataset.a].name, nodes[g.dataset.b].name]; setTalkView('list');
  });
  svg.querySelectorAll('.tg-v').forEach(g => {
    const k = g.dataset.k;
    g.ondblclick = () => { if (nodes[k].path) openSession(nodes[k].path); };
    g.onpointerdown = e => {
      e.preventDefault();
      const pt = svg.createSVGPoint(), at = ev => { pt.x = ev.clientX; pt.y = ev.clientY; return pt.matrixTransform(svg.getScreenCTM().inverse()); };
      const s0 = at(e), p = P[k], o = { x: p.x - s0.x, y: p.y - s0.y };
      let moved = false;
      const mv = ev => { const q = at(ev); if (!moved && Math.hypot(q.x - s0.x, q.y - s0.y) < 4) return; moved = true; p.x = q.x + o.x; p.y = q.y + o.y; p.pin = true; g.setAttribute('transform', `translate(${p.x},${p.y})`); };
      const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); if (moved) drawTalk(); else { talk.sel = talk.sel === k ? null : k; drawTalk(); } };
      addEventListener('pointermove', mv); addEventListener('pointerup', up);
    };
  });
}

async function renderTalk() {
  if (!talkMounted) {
    $('#view').innerHTML = `<div class="controls">
        <span class="seg" id="talk-view">${[['list', '리스트'], ['graph', '그래프']].map(([k, l]) => `<button data-tv="${k}" class="${talk.view === k ? 'on' : ''}">${l}</button>`).join('')}</span>
        <span class="talk-types">${Object.entries(TALK_TYPES).map(([k, [l, c]]) => `<label class="chk talk-t" style="--c:${c}"><input type="checkbox" data-tt="${k}" ${talk.types.has(k) ? 'checked' : ''}> ${l} <b id="tc-${k}"></b></label>`).join('')}</span>
        <label>세션 <select id="talk-who"><option value="">전체</option></select></label>
        <input id="talk-q" class="field talk-q" type="search" placeholder="제목·본문 검색" value="${esc(talk.q)}">
        <label class="chk"><input type="checkbox" id="talk-th" ${talk.threads ? 'checked' : ''}> 질문·답을 스레드로 묶기</label>
        <label>기간 <select id="talk-hours">${[[1, '1시간'], [6, '6시간'], [24, '24시간'], [72, '3일'], [0, '전체']].map(([h, l]) => `<option value="${h}" ${h === talk.hours ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label>최근 <select id="talk-lim">${[500, 1500, 5000].map(n => `<option ${n === talk.limit ? 'selected' : ''}>${n}</option>`).join('')}</select>건</label>
        <span id="talk-pair"></span><span class="st" id="talk-sub"></span></div>
      <div id="talk-list"><div class="empty">불러오는 중…</div></div>`;
    $('#view').querySelectorAll('[data-tt]').forEach(c => c.onchange = () => { c.checked ? talk.types.add(c.dataset.tt) : talk.types.delete(c.dataset.tt); renderTalk(); });
    $('#talk-who').onchange = e => { talk.who = e.target.value; drawTalk(); };
    $('#talk-q').oninput = e => { talk.q = e.target.value; drawTalk(); };
    $('#talk-th').onchange = e => { talk.threads = e.target.checked; drawTalk(); };
    $('#talk-hours').onchange = e => { talk.hours = +e.target.value; drawTalk(); };
    $('#talk-lim').onchange = e => { talk.limit = +e.target.value; renderTalk(); };
    $('#view').querySelectorAll('[data-tv]').forEach(b => b.onclick = () => setTalkView(b.dataset.tv));
    $('#talk-th').closest('label').style.display = talk.view === 'graph' ? 'none' : '';
    talkMounted = true;
  }
  if (talk.data) drawTalk();
  await loadTalk();
  if (route().v === 'talk') { const sv = saveScroll(); drawTalk(); restoreScroll(sv); }
}

function drawTalk() {
  if (!talkMounted || !$('#talk-list')) return;
  if (talk.err && !talk.data) { $('#talk-list').innerHTML = `<div class="empty">Orca 메시지 조회 실패<br><small>${esc(talk.err)}</small></div>`; return; }
  const since = talk.hours ? new Date(Date.now() - talk.hours * 3600e3).toISOString().slice(0, 19) : '';
  const all = (talk.data?.messages || []).filter(m => !since || (m.created_at || '') >= since).map(m => ({ ...m, f: talkEnd(m.from_term, m.from_kind, m.from, m), t: talkEnd(m.to_term, m.to_kind, m.to, m) }));
  // Participant list: everyone who sent or received, busiest first.
  const ppl = {};
  all.forEach(m => [m.f, m.t].forEach(e => { (ppl[e.key] ||= { name: e.name, n: 0 }).n++; }));
  const who = $('#talk-who'), opts = '<option value="">전체</option>' + Object.entries(ppl).sort((a, b) => b[1].n - a[1].n).map(([k, v]) => `<option value="${esc(k)}" ${k === talk.who ? 'selected' : ''}>${esc(cutW(v.name, 40))} (${v.n})</option>`).join('');
  if (who.dataset.opts !== opts) { who.innerHTML = opts; who.dataset.opts = opts; }
  Object.keys(TALK_TYPES).forEach(k => { const el = $('#tc-' + k); if (el) el.textContent = k === 'heartbeat' && !talk.types.has(k) ? '' : all.filter(m => m.type === k).length; });
  const q = talk.q.trim().toLowerCase();
  const pk = talk.pair, hit = m => talk.types.has(m.type) && (!talk.who || m.f.key === talk.who || m.t.key === talk.who)
    && (!pk || (m.f.key === pk[0] && m.t.key === pk[1]) || (m.f.key === pk[1] && m.t.key === pk[0]))
    && (!q || [m.subject, m.body, m.question, m.f.name, m.t.name].some(x => String(x || '').toLowerCase().includes(q)));
  $('#talk-pair').innerHTML = pk ? `<span class="talk-pchip">${esc(cutW(pk.names[0], 24))} ↔ ${esc(cutW(pk.names[1], 24))} 사이만 <button class="act" id="talk-pair-x">✕</button></span>` : '';
  if (pk) $('#talk-pair-x').onclick = () => { talk.pair = null; drawTalk(); };
  if (talk.view === 'graph') {
    const sel = all.filter(hit);
    $('#talk-sub').textContent = `메시지 ${sel.length} · Orca 에서 ${talk.data?.fetched ?? 0}건 읽음${talk.err ? ' · 갱신 실패: ' + talk.err : ''}`;
    return drawTalkGraph(sel);
  }
  // Threads: a reply carries the root's id in thread_id; the root keeps the newest activity of the thread.
  let rows;
  if (talk.threads) {
    const byId = Object.fromEntries(all.map(m => [m.id, m])), groups = {};
    all.forEach(m => { const root = m.thread_id && byId[m.thread_id] ? m.thread_id : m.thread_id || m.id; (groups[root] ||= []).push(m); });
    rows = Object.entries(groups).filter(([, g]) => g.some(hit)).map(([root, g]) => {
      g.sort((a, b) => a.created_at.localeCompare(b.created_at));
      const head = byId[root] || g[0];
      return { head, replies: g.filter(m => m !== head), last: g[g.length - 1].created_at };
    }).sort((a, b) => b.last.localeCompare(a.last));
  } else rows = all.filter(hit).map(m => ({ head: m, replies: [], last: m.created_at }));
  const shown = rows.length, total = rows.reduce((a, r) => a + 1 + r.replies.length, 0);
  $('#talk-sub').textContent = `${talk.threads ? `스레드 ${shown} · ` : ''}메시지 ${total} · Orca 에서 ${talk.data?.fetched ?? 0}건 읽음${talk.err ? ' · 갱신 실패: ' + talk.err : ''}`;
  const end = e => e.path ? `<a href="#s=${encodeURIComponent(e.path)}">${esc(cutW(e.name, 44))}</a>${e.model ? ' ' + modelChip(e.model) : ''}` : `<span title="${esc(e.note || '')}">${esc(cutW(e.name, 44))}</span>`;
  const one = (m, reply) => {
    const [label, color] = TALK_TYPES[m.type] || [m.type, 'var(--muted)'], isOpen = talk.open.has(m.id);
    const extra = [m.outcome && `결과 ${m.outcome}`, m.phase && `단계 ${m.phase}`, m.priority && m.priority !== 'normal' && `우선순위 ${m.priority}`, !m.read && '안 읽음'].filter(Boolean).join(' · ');
    const text = m.question || m.body || '';
    return `<div class="talk-m ${reply ? 'reply' : ''} ${isOpen ? 'open' : ''}" data-mid="${esc(m.id)}" style="--c:${color}">
      <div class="talk-h"><span class="talk-ty">${esc(label)}</span><span class="talk-ends">${end(m.f)} <span class="talk-arrow">→</span> ${end(m.t)}</span>
        <span class="st talk-when" title="${esc(m.created_at)}">${hm(m.created_at)} · ${ago(m.created_at)}</span></div>
      <div class="talk-s">${esc(m.subject || '(제목 없음)')}${extra ? ` <span class="st">· ${esc(extra)}</span>` : ''}</div>
      ${text ? `<div class="talk-b">${esc(isOpen ? text : cut(text.replace(/\s+/g, ' '), 220))}${isOpen && m.cut ? '<span class="st"> … (잘림)</span>' : ''}</div>` : ''}
      ${isOpen && m.files.length ? `<div class="st talk-f">수정한 파일 ${m.files.length}: ${m.files.map(f => esc(f.split('/').pop())).join(', ')}</div>` : ''}</div>`;
  };
  $('#talk-list').innerHTML = rows.length ? rows.slice(0, 600).map(r => `<div class="talk-g">${one(r.head)}${r.replies.map(m => one(m, true)).join('')}</div>`).join('')
    + (rows.length > 600 ? `<div class="empty">최근 600개만 표시 (필터로 좁혀 보세요)</div>` : '')
    : `<div class="empty">${talk.data ? '조건에 맞는 메시지가 없습니다.' : '불러오는 중…'}</div>`;
  $('#talk-list').querySelectorAll('.talk-m').forEach(el => el.onclick = e => {
    if (e.target.closest('a') || getSelection().toString()) return;
    const id = el.dataset.mid; talk.open.has(id) ? talk.open.delete(id) : talk.open.add(id); drawTalk();
  });
}

// ---------- live updates ----------
// The version ticks almost every second while agents write logs, and each refresh refetches ~2MB and rebuilds
// the view, so coalesce bursts into at most one refresh per MIN_GAP and skip work while the tab is hidden.
const MIN_GAP = 4000;
let pending = false, again = false, lastRun = 0, gapT = null, stale = false;
// now: the user changed what to show (e.g. a metric server turned off), so skip the gap.
async function pump(now) {
  if (document.hidden) { stale = true; return; }
  if (pending) { again = true; return; }
  const wait = now ? 0 : lastRun + MIN_GAP - Date.now();
  if (wait > 0) { if (!gapT) gapT = setTimeout(() => { gapT = null; pump(); }, wait); return; }
  pending = true;
  // A failed fetch or a render that throws on unexpected data keeps the last screen and says so, instead of an
  // unhandled rejection that leaves the view half-drawn with no sign anything went wrong.
  try { again = false; lastRun = Date.now(); refreshError = null; await refresh(); }
  catch (e) { refreshError = String(e?.message || e); console.error(e); if (state) renderHealth(); }
  finally { pending = false; }
  if (again) pump();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && stale) { stale = false; pump(); } });
// A tab opened before a new deployment keeps old logic (e.g. no hidden filter): reload once build.json changes.
let pageBuild;
async function checkBuild() {
  const b = await api.build();
  if (pageBuild === undefined) pageBuild = b;
  else if (b && b !== pageBuild) location.reload();
}
checkBuild();
setInterval(() => { if (!document.hidden) checkBuild(); }, 5 * 60000);
// 「메트릭 서버」 panel, opened from the connection badge: the servers this device reads (each tried before it is
// added), which of them are on, and whether the agents view merges them or splits them per server. It also opens by
// itself when no server has connected after a few seconds (a new device, the server down), since an empty dashboard
// alone does not say why.
const srvState = x => !x.on ? ['', '꺼짐'] : x.live ? ['ok', '연결됨'] : x.error ? ['bad', x.error] : ['bad', '연결 안 됨'];
function serverPanel() {
  const el = $('#server-panel'), list = api.servers();
  el.innerHTML = `<div class="pop-h"><b>메트릭 서버</b><span class="st">이 기기에만 저장 · 체크한 서버만 보입니다</span><button class="act" data-sp="close">닫기</button></div>
    <div class="sp-row"><span>보기</span><span class="seg" id="sp-view"><button data-k="merged">합쳐 보기</button><button data-k="split">서버별 보기</button></span></div>
    ${list.map(x => `<div class="sp-srv" data-id="${x.id}">
      <div class="sp-row"><input type="checkbox" data-on${x.on ? ' checked' : ''} title="이 서버를 화면에 포함">
        <input class="sp-name" data-name value="${esc(x.name)}" title="이름 (바꾸면 바로 저장)">
        <button class="act" data-sp="test">시험</button><button class="act" data-sp="del">삭제</button></div>
      <div class="sp-row sp-sub"><code>${esc(x.url)}</code><span class="sp-msg ${srvState(x)[0]}" data-st>${esc(srvState(x)[1])}</span></div>
    </div>`).join('') || '<div class="sp-msg bad">등록된 서버가 없습니다.</div>'}
    <div class="sp-row sp-add"><input id="sp-new-name" placeholder="이름 (선택)" spellcheck="false">
      <input id="sp-url" type="url" spellcheck="false" autocomplete="url" placeholder="${esc(api.DEFAULT)}"><button class="act big" data-sp="add">추가</button></div>
    <div class="sp-msg" id="sp-msg"></div>
    <ul class="sp-help">
      <li>이 Mac 에서: <code>${esc(api.DEFAULT)}</code></li>
      <li>다른 기기(tailnet)에서: 그 Mac 에서 <code>tailscale serve --bg 8787</code> 후 <code>https://&lt;mac&gt;.&lt;tailnet&gt;.ts.net</code></li>
      <li>서버는 이 페이지 주소를 허용해야 합니다: <code>--origin ${esc(location.origin)}</code></li>
      <li>Chrome 이 「로컬 네트워크의 기기에 접근」 권한을 물으면 허용해야 합니다 (주소창 왼쪽 사이트 설정에서 바꿀 수 있음)</li>
    </ul>`;
  const msg = $('#sp-msg'), say = (text, cls = '') => { msg.className = 'sp-msg ' + cls; msg.textContent = text; };
  const verdict = r => !r.ok ? [r.error, 'bad'] : r.api !== api.API_VERSION ? [`연결은 되지만 서버 API v${r.api} 가 페이지 v${api.API_VERSION} 와 다릅니다`, 'bad'] : ['연결됩니다', 'ok'];
  // Every change goes through setServers, which reconnects; the snapshot is refetched at once.
  const apply = list => { api.setServers(list); pump(true); serverPanel(); };
  el.querySelectorAll('#sp-view button').forEach(b => {
    b.classList.toggle('on', b.dataset.k === srvView);
    b.onclick = () => { srvView = b.dataset.k; try { localStorage.setItem('adash.srvview', srvView); } catch {} serverPanel(); render(); };
  });
  el.querySelectorAll('.sp-srv').forEach(row => {
    const id = row.dataset.id, cur = () => api.servers().map(x => ({ ...x }));
    row.querySelector('[data-on]').onchange = e => apply(cur().map(x => x.id === id ? { ...x, on: e.target.checked } : x));
    row.querySelector('[data-name]').onchange = e => { api.setServers(cur().map(x => x.id === id ? { ...x, name: e.target.value } : x)); render(); };
    row.querySelector('[data-sp=del]').onclick = () => { if (confirm(`${api.server(id).name} 을(를) 목록에서 지울까요?`)) apply(cur().filter(x => x.id !== id)); };
    row.querySelector('[data-sp=test]').onclick = async () => {
      const st = row.querySelector('[data-st]');
      st.className = 'sp-msg'; st.textContent = '시험 중…';
      const [text, cls] = verdict(await api.probe(api.server(id).url));
      st.className = 'sp-msg ' + cls; st.textContent = text;
    };
  });
  const add = async () => {
    const url = $('#sp-url').value.trim().replace(/\/+$/, '');
    if (!url) return say('주소를 입력하세요', 'bad');
    if (api.servers().some(x => x.url === url)) return say('이미 등록된 주소입니다', 'bad');
    say('시험 중…');
    const r = await api.probe(url), [text, cls] = verdict(r);
    say(text, cls);
    if (cls === 'ok' || confirm(`${text}\n그래도 추가할까요?`)) apply([...api.servers(), { name: $('#sp-new-name').value, url, on: true }]);
  };
  el.querySelector('[data-sp=add]').onclick = add;
  $('#sp-url').onkeydown = e => { if (e.key === 'Enter') add(); };
  el.querySelector('[data-sp=close]').onclick = () => { el.hidden = true; };
  el.hidden = false;
}
// Connection badge: 실시간 when every server that is on streams, n/m when some do; the panel's status lines follow.
function renderConn() {
  const on = srvOn(), live = on.filter(x => x.live).length;
  $('#conn').className = live ? 'conn on' + (live < on.length ? ' part' : '') : 'conn';
  $('#conn span').textContent = !on.length ? '서버 없음' : live === on.length ? '실시간' + (on.length > 1 ? ` ${live}` : '') : live ? `실시간 ${live}/${on.length}` : '재연결 중';
  $('#conn').title = on.map(x => `${x.name} (${x.url}): ${srvState(x)[1]}`).join('\n') + '\n눌러서 메트릭 서버 설정';
  $('#srv-btn').className = 'dock-btn ' + $('#conn').className.replace('conn', '').trim();
  $('#srv-btn').dataset.tip = '메트릭 서버 · ' + $('#conn span').textContent;
  const el = $('#server-panel');
  if (!el.hidden) for (const x of api.servers()) {
    const st = el.querySelector(`.sp-srv[data-id="${x.id}"] [data-st]`), [cls, text] = srvState(x);
    if (st && st.textContent !== '시험 중…') { st.className = 'sp-msg ' + cls; st.textContent = text; }
  }
}
// The badge and the bar's server button both toggle the panel. It is a .dock-pop: opening it closes any other one.
$('#conn').onclick = $('#srv-btn').onclick = () => { if ($('#server-panel').hidden) serverPanel(); else $('#server-panel').hidden = true; };
setTimeout(() => { if (!srvOn().some(x => x.live) && $('#server-panel').hidden) serverPanel(); }, 4000);
// ---------- projects ----------
// Project progress from the metric servers started with --projects-dir (one progress.json per project; the servers
// derive every figure, this only lays it out). Two views of the same list:
// - 프로젝트별: one straight line of stages per project, always in stage order. A project folds open (accordion) into
//   its stages and steps.
// - 전체 시계열: one trunk with a branch per project, git-graph style (pjTimeline). Picking a project focuses its
//   branch and opens the same detail below the graph (가로) or beside it (세로).
// Picking a step splits the detail: the stages and steps on one side, the step's Obsidian note on the other. The
// documents themselves open in Obsidian: a step's 「Obsidian」 button, the note's title, its 「Obsidian 에서 열기」, and
// the [[links]] in it (obsidian://open?path=, or a search for a link outside the project folder).
const PJ_ST = { done: '완료', failed: '실패', active: '진행 중', pending: '예정', scheduling: '일정 미정', empty: '작업 없음' };
const PJ_C = { done: 'var(--done)', failed: 'var(--bad)', active: 'var(--run)', pending: 'var(--muted)', scheduling: 'var(--idle)', empty: 'var(--idle)' };
const pjFin = st => st.status === 'done' || st.status === 'failed';
// A note in Obsidian: by its absolute path, which the project's progress.json path (absolute) gives the folder of.
const pjObsidian = abs => 'obsidian://open?path=' + encodeURIComponent(abs);
const pjAbs = (p, rel) => p.path.replace(/[^/]*$/, '') + rel;
const pjPct = x => x.total ? Math.round(x.counts.done / x.total * 100) : 0;
const pjPeriod = (a, b) => a ? (b && b !== a ? `${a} ~ ${b}` : a) : '날짜 미정';
const pjChip = s => `<span class="chip" style="--c: ${PJ_C[s]}">${PJ_ST[s] || s}</span>`;
// A project is named by its server and folder name; server ids carry no ':'.
const pjKeyOf = p => `${p.server}:${p.name}`;
const pjSplitKey = k => { const i = k.indexOf(':'); return [k.slice(0, i), k.slice(i + 1)]; };
// A stage node: its number in a circle; an active one's ring is a gauge of its finished steps (--pct).
const pjNode = st => `<i class="pj-dot" style="--pct: ${pjPct(st)}">${st.no}</i>`;

let pj = { view: 'flow', orient: 'auto' };  // adash.proj: which view, and the timeline's orientation (auto|h|v)
try { Object.assign(pj, JSON.parse(localStorage.getItem('adash.proj') || '{}')); } catch {}
const pjSave = () => { try { localStorage.setItem('adash.proj', JSON.stringify(pj)); } catch {} };
let pjData = null;         // api.projects(); dropped when a server says its projects changed
let pjFull = {};           // key -> api.project() (with steps); dropped with pjData
const pjNotes = {};        // key + '\n' + path -> api.note()
let pjOpen = null;         // 프로젝트별: the project folded open
let pjFocus = null;        // 전체 시계열: the focused project
let pjNote = null;         // the note in the split: {key, path}, or null
let pjScrollTo = null;     // a stage number to bring into view once the detail is drawn
let pjSrcKey = '';         // the servers on and their connection, as of the last projects fetch (connect() watches it)
const pjVertical = () => pj.orient === 'v' || (pj.orient === 'auto' && innerWidth < innerHeight);

async function renderProjects() {
  if (!pjData) { try { pjData = await api.projects(); } catch { pjData = { enabled: false, dirs: [], projects: [] }; } }
  if (route().v !== 'projects') return;
  const d = pjData, tl = pj.view === 'timeline', vert = tl && pjVertical();
  const seg = (key, opts) => `<span class="seg" data-pj-seg="${key}">${opts.map(([k, l]) => `<button type="button" data-k="${k}" class="${pj[key] === k ? 'on' : ''}">${l}</button>`).join('')}</span>`;
  const broken = [...d.dirs.filter(x => x.error).map(x => `${srvName(x.server)} ${x.dir}: ${x.error}`),
    ...(tl ? d.projects.filter(p => p.error).map(p => `${p.name}: ${p.error}`) : [])];
  $('#view').innerHTML = `<div class="controls">
      ${seg('view', [['flow', '프로젝트별'], ['timeline', '전체 시계열']])}
      ${tl ? seg('orient', [['auto', '자동'], ['h', '가로'], ['v', '세로']]) : ''}
      <div class="legend pj-leg">${['done', 'active', 'scheduling', 'failed'].map(s => `<span><i style="background:${PJ_C[s]}"></i>${PJ_ST[s]}</span>`).join('')}
        ${tl ? '<span>날짜 간격은 일정 비율이 아님 · 막대 = 진행 중 (시작일 → 오늘)</span>' : ''}</div>
    </div>
    ${!d.enabled ? pjNoSource(d)
      : !d.projects.length ? '<div class="empty">progress.json 이 있는 프로젝트 폴더가 없습니다.</div>'
      : tl ? `<div class="pj-tlwrap${vert ? ' side' : ''}${pjFocus ? ' focused' : ''}"><div class="box pj-tl hscroll" id="pj-tl"></div><div class="pj-focus" id="pj-focus"></div></div>`
      : `<div class="pj-list">${d.projects.map(pjRow).join('')}</div>`}
    ${broken.map(e => `<div class="pj-err">${esc(e)}</div>`).join('')}`;
  if (!d.enabled || !d.projects.length) return;
  if (tl) {
    pjTimeline($('#pj-tl'), d, vert);
    if (pjFocus && d.projects.some(p => pjKeyOf(p) === pjFocus)) pjDetail($('#pj-focus'), pjFocus); else pjFocus = null;
  } else if (pjOpen) {
    const box = [...document.querySelectorAll('[data-pj-detail]')].find(x => x.dataset.pjDetail === pjOpen);
    if (box) pjDetail(box, pjOpen); else pjOpen = null;
  }
}

// No server that is on sends projects: say, per server, why not, and offer the server panel (to add or turn one on).
const PJ_SRC = { off: '--projects-dir 없이 떠 있음', old: '프로젝트 기능이 없는 서버 버전 (새 코드로 다시 띄워야 함)', error: '연결할 수 없음' };
function pjNoSource(d) {
  const rows = (d.sources || []).map(x => `<li><b>${esc(srvName(x.server))}</b> <span class="st">${esc(api.server(x.server)?.url || '')}</span> — ${PJ_SRC[x.state] || x.state}</li>`).join('');
  return `<div class="empty">프로젝트 진행을 보내는 메트릭 서버가 없습니다.
    ${rows ? `<ul class="pj-src">${rows}</ul>` : '<br><small>켜진 메트릭 서버가 없습니다.</small>'}
    <small><code>--projects-dir</code> 로 띄운 서버를 「메트릭 서버」에서 추가하거나 켜세요.</small><br>
    <button type="button" class="act big accent" data-pj-servers>메트릭 서버 열기</button></div>`;
}

// 프로젝트별: a project is a <details class="box"> whose summary is its line of stages; opening it shows the detail.
function pjRow(p) {
  if (p.error) return `<div class="box pj-row"><div class="pj-head"><b>${esc(p.name)}</b>${srvBadge(p)}</div><div class="pj-err">${esc(p.error)}</div></div>`;
  const k = pjKeyOf(p), pct = Math.round((p.ratio || 0) * 100);
  const line = p.stages.map((st, i) => {
    const link = pjFin(st) && p.stages[i + 1] && pjFin(p.stages[i + 1]);  // green only between two finished stages
    const tip = `${st.no}. ${st.name} — ${PJ_ST[st.status]}${st.total ? ` · ${st.counts.done}/${st.total}` : ''}${pjFin(st) && st.end ? ` · 완료 ${st.end}` : ''}`;
    return `<span class="pj-st ${st.status}${link ? ' link' : ''}${p.current?.no === st.no ? ' cur' : ''}" data-st="${st.no}" title="${esc(tip)}">${pjNode(st)}<span>${esc(st.name)}</span></span>`;
  }).join('');
  return `<details class="box pj-row" data-pj="${esc(k)}"${pjOpen === k ? ' open' : ''}><summary>
      <span class="pj-head"><b>${esc(p.name)}</b>${srvBadge(p)}${pjChip(p.status)}
        <span class="st">${p.counts.done}/${p.total} · ${pct}% · 현재 ${p.current ? esc(`${p.current.no}. ${p.current.name}`) : '-'}</span></span>
      <span class="pj-flow hscroll">${line}</span></summary>
    <div class="pj-detail" data-pj-detail="${esc(k)}"></div></details>`;
}

// The detail of one project into box: figures, then the stages with their steps, split with the open note.
async function pjDetail(box, key) {
  let p = pjFull[key];
  if (!p) {
    box.innerHTML = '<div class="st pj-wait">불러오는 중…</div>';
    try { p = pjFull[key] = await api.project(...pjSplitKey(key)); } catch { p = null; }
    if (!box.isConnected) return;
  }
  if (!p || p.error) { box.innerHTML = `<div class="empty">${esc(p?.error || '프로젝트를 불러오지 못했습니다.')}</div>`; return; }
  const pct = Math.round((p.ratio || 0) * 100), split = pjNote?.key === key;
  box.innerHTML = `<div class="kpis pj-kpis">
      <div class="kpi"><span>완료 스텝</span><b>${p.counts.done}/${p.total}</b><small> · ${pct}%</small></div>
      <div class="kpi"><span>현재 단계</span><b>${p.current ? esc(`${p.current.no}. ${p.current.name}`) : '-'}</b></div>
      <div class="kpi"><span>기간</span><b class="pj-sm">${pjPeriod(p.start, p.end)}</b></div>
      ${p.template ? `<div class="kpi"><span>템플릿</span><b class="pj-sm">${esc(p.template)}</b></div>` : ''}
    </div>
    <div class="prog pj-prog"><div style="width: ${pct}%; background: var(--done)"></div></div>
    <div class="pj-split${split ? ' on' : ''}">
      <div class="pj-stages">${p.stages.map(st => `<section class="pj-stage" data-st-sec="${st.no}">
        <h4><span class="pj-st ${st.status}${p.current?.no === st.no ? ' cur' : ''}">${pjNode(st)}</span>${esc(st.name)} ${pjChip(st.status)}
          <span class="st">${st.total ? `${st.counts.done}/${st.total}` : ''}${st.start ? ` · ${pjPeriod(st.start, st.end)}` : ''}</span></h4>
        ${st.steps.length ? `<ul class="pj-steps">${st.steps.map(sp => `<li><button type="button" class="pj-step${split && pjNote.path === sp.path ? ' on' : ''}" data-pj-step="${esc(sp.path)}">
            <i class="pj-sdot ${sp.status}"></i><span class="pj-stitle">${esc(sp.title)}</span><span class="st">${sp.date ? pjPeriod(sp.date, sp.endDate) : PJ_ST.scheduling}</span></button>
            <a class="act pj-obs" href="${pjObsidian(pjAbs(p, sp.path))}" aria-label="${esc(sp.title)} — Obsidian 에서 열기" data-tip="Obsidian 에서 열기">Obsidian</a></li>`).join('')}</ul>`
          : '<div class="st pj-none">스텝 없음</div>'}
      </section>`).join('')}</div>
      <div class="pj-note" data-pj-note></div>
    </div>`;
  if (split) pjShowNote(box, p);
  if (pjScrollTo) { box.querySelector(`[data-st-sec="${pjScrollTo}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); pjScrollTo = null; }
}

// The note half of the split: the step's facts when the note is a step, then the note itself.
async function pjShowNote(box, p) {
  const pane = box.querySelector('[data-pj-note]'), { key, path } = pjNote, ck = key + '\n' + path;
  box.querySelectorAll('.pj-step').forEach(b => b.classList.toggle('on', b.dataset.pjStep === path));
  let n = pjNotes[ck];
  if (!n) {
    pane.innerHTML = '<div class="st pj-wait">불러오는 중…</div>';
    try { n = pjNotes[ck] = await api.note(p.server, p.name, path); } catch (e) { n = { error: String(e.message || e) }; }
    if (!pane.isConnected || pjNote?.path !== path) return;
  }
  const bar = `<div class="pj-nbar"><span class="st">${esc(path)}</span><button type="button" class="act" data-pj-nclose aria-label="노트 닫기">닫기 ✕</button></div>`;
  if (!n || n.error) { pane.innerHTML = bar + `<div class="empty">${esc(n?.error || '노트를 찾을 수 없습니다.')}</div>`; return; }
  const st = p.stages.find(s => s.steps.some(x => x.path === path)), sp = st?.steps.find(x => x.path === path);
  let md = n.content, fm = [];
  const m = md.match(/^---\n([\s\S]*?)\n---\n?/);
  if (m) { md = md.slice(m[0].length); fm = m[1].split('\n').map(l => l.match(/^([\w-]+):\s*(.*)$/)).filter(Boolean); }
  const title = fm.find(x => x[1] === 'title')?.[2] || path.split('/').pop().replace(/\.md$/, '');
  const links = Object.fromEntries((n.links || []).map(l => [l.target, l.path]));
  pane.innerHTML = bar + `<h3 class="pj-ntitle"><a href="${pjObsidian(n.abs)}" title="Obsidian 에서 열기">${esc(title)}</a> ${sp ? pjChip(sp.status) : ''}</h3>
    ${sp ? `<div class="kpis pj-kpis"><div class="kpi"><span>${sp.status === 'active' ? '시작 ~ 마지막 작업일' : sp.status === 'pending' ? '계획' : '날짜'}</span><b class="pj-sm">${pjPeriod(sp.date, sp.endDate)}</b></div>
      <div class="kpi"><span>단계</span><b class="pj-sm">${st.no}. ${esc(st.name)}</b><small> · ${PJ_ST[st.status]}</small></div></div>` : ''}
    <div class="pj-acts"><a class="act big accent" href="${pjObsidian(n.abs)}">Obsidian 에서 열기</a>
      <span class="st">수정 ${new Date(n.mtime * 1000).toLocaleString('ko-KR', { hour12: false })}</span></div>
    ${fm.length ? `<table class="pj-fm">${fm.filter(x => x[1] !== 'title').map(([, k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>` : ''}
    <article class="pj-md">${pjMarkdown(md, links, rel => pjAbs(p, rel))}</article>`;
}

// A small Markdown renderer for notes: headings, paragraphs, lists, quotes, code, tables, rules; inline code, bold,
// italic, links and [[wikilinks]] (a link the server resolved inside the project folder opens that note in Obsidian,
// any other one searches Obsidian for it). Everything is escaped first, so a note cannot inject markup.
function pjMarkdown(md, links, absOf) {
  const inline = t => {
    const code = [];
    t = esc(t).replace(/`([^`]+)`/g, (_, c) => `\u0000${code.push(c) - 1}\u0000`);
    t = t.replace(/!?\[\[([^\]|#\n]+)(#[^\]|\n]*)?(?:\|([^\]\n]*))?\]\]/g, (_, target, h, alias) => {
      const to = target.trim(), label = alias || to.split('/').pop() + (h || ''), path = links[to.replace(/&amp;/g, '&')];
      return path ? `<a class="pj-wl" href="${pjObsidian(absOf(path))}" title="Obsidian 에서 열기">${label}</a>`
        : `<a class="pj-wl out" href="obsidian://search?query=${encodeURIComponent(to)}" title="프로젝트 폴더 밖 노트 — Obsidian 에서 검색">${label}</a>`;
    });
    t = t.replace(/\[([^\]]+)\]\(((?:https?|obsidian):\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>');
    return t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${code[i]}</code>`);
  };
  const out = [], L = md.split('\n');
  for (let i = 0; i < L.length;) {
    const l = L[i];
    if (/^```/.test(l)) {
      const body = []; for (i++; i < L.length && !/^```/.test(L[i]); i++) body.push(L[i]);
      out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`); i++; continue;
    }
    let m;
    if ((m = l.match(/^(#{1,6})\s+(.*)$/))) { out.push(`<h${Math.min(6, m[1].length + 3)}>${inline(m[2])}</h${Math.min(6, m[1].length + 3)}>`); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
    if (/^>/.test(l)) { const q = []; for (; i < L.length && /^>/.test(L[i]); i++) q.push(L[i].replace(/^>\s?/, '')); out.push(`<blockquote>${q.map(inline).join('<br>')}</blockquote>`); continue; }
    if (/^\s*\|/.test(l)) {
      const rows = []; for (; i < L.length && /^\s*\|/.test(L[i]); i++) if (!/^\s*\|[\s:|-]+\|\s*$/.test(L[i])) rows.push(L[i].trim().replace(/^\||\|$/g, '').split(/\|(?![^[]*\]\])/));  // a [[target|alias]] keeps its |
      out.push(`<table>${rows.map((r, j) => `<tr>${r.map(c => j ? `<td>${inline(c.trim())}</td>` : `<th>${inline(c.trim())}</th>`).join('')}</tr>`).join('')}</table>`); continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
      const ol = /^\s*\d/.test(l), items = [];
      for (; i < L.length && /^\s*([-*+]|\d+[.)])\s+/.test(L[i]); i++) {
        const depth = Math.floor(L[i].match(/^\s*/)[0].length / 2);
        items.push(`<li style="margin-left: ${depth * 16}px">${inline(L[i].replace(/^\s*([-*+]|\d+[.)])\s+/, '').replace(/^\[([ xX])\]\s*/, (_, c) => c === ' ' ? '☐ ' : '☑ '))}</li>`);
      }
      out.push(ol ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`); continue;
    }
    if (!l.trim()) { i++; continue; }
    const para = []; for (; i < L.length && L[i].trim() && !/^(#{1,6}\s|>|```|\s*\||\s*([-*+]|\d+[.)])\s+)/.test(L[i]); i++) para.push(L[i]);
    if (!para.length) para.push(L[i++]);  // never stall on a line no rule above took
    out.push(`<p>${para.map(inline).join('<br>')}</p>`);
  }
  return out.join('');
}

// 전체 시계열 into box. The time axis is ordinal: every date something happens (a fork, a stage finishing, a stage
// starting, today) gets a slot and slots sit at an even step, so nodes are evenly spaced however far apart their dates
// are. A project forks off the trunk the day its first step starts and runs in its own lane: a finished stage sits at
// the slot it finished, stages finishing the same day run side by side on parallel tracks, a stage in progress runs as
// a bar from its start to today, and a project whose stages are all finished merges back. Time runs left -> right
// (가로) or top -> bottom (세로); everything is laid out as (t, c) = (time, across) and P() maps it to x/y.
function pjTimeline(box, d, vert) {
  const ps = d.projects.filter(p => !p.error)
    .sort((a, b) => (a.start || "9999").localeCompare(b.start || "9999") || a.name.localeCompare(b.name));
  const now = new Date(), todayS = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const isDone = p => p.status === "done" || p.status === "failed";

  // slots: every distinct event date, evenly spaced
  const dates = new Set([todayS]);
  ps.forEach(p => {
    if (p.start) dates.add(p.start);
    p.stages.forEach(st => { if (pjFin(st) && st.end) dates.add(st.end); if (st.status === "active" && st.start) dates.add(st.start); });
  });
  const slots = [...dates].sort(), slotOf = d => slots.indexOf(d), last = slots.length - 1, todaySlot = slotOf(todayS);
  // each node carries its stage name on the side away from the trunk, so steps and tracks leave room for it
  const STEP = vert ? 54 : 84, R = 11, TRACK = vert ? 70 : 46, INNER = 36, LANEGAP = 38, NAME = vert ? 0 : R + 16;
  const T0 = vert ? STEP + 90 : STEP + 30, TAIL = vert ? 30 : 60, CPAD = vert ? 60 : 20;
  const T = s => T0 + s * STEP, tEnd = T(todaySlot) + STEP * 0.45;
  const P = (t, c) => vert ? [c, t] : [t, c];
  const pt = (t, c) => P(t, c).join(",");

  // per project: track allocation. Track 0 is the branch line itself; it carries the finished stages from the fork on.
  const lanes = ps.map(p => {
    const fork = p.start ? slotOf(p.start) : todaySlot;
    const items = [], busy = [];  // busy[track] = [[from, to], ...] in slot units
    const take = (from, to, min = 0) => {
      for (let j = min; ; j++) {
        busy[j] = busy[j] || [];
        if (busy[j].every(([a, b]) => to <= a || from >= b)) { busy[j].push([from, to]); return j; }
      }
    };
    const byDay = {};
    p.stages.filter(st => pjFin(st) && st.end).forEach(st => (byDay[st.end] = byDay[st.end] || []).push(st));
    const finSlots = Object.keys(byDay).map(slotOf).sort((a, b) => a - b);
    busy[0] = finSlots.length ? [[fork - 0.5, finSlots[finSlots.length - 1] + 0.5]] : [];  // nothing finished: free for a bar
    finSlots.forEach(s => {
      const sts = byDay[slots[s]].sort((a, b) => a.no - b.no);
      items.push({kind: "fin", s, st: sts[0], track: 0});
      sts.slice(1).forEach(st => items.push({kind: "fin", s, st, track: take(s - 0.5, s + 0.5, 1)}));
    });
    p.stages.filter(st => st.status === "active").sort((a, b) => (a.start || "").localeCompare(b.start || "") || a.no - b.no)
      .forEach(st => { const s = st.start ? slotOf(st.start) : todaySlot; items.push({kind: "active", s, st, track: take(s - 0.5, last + 1)}); });
    return {p, fork, items, tracks: Math.max(1, busy.length)};
  });
  // each branch's extent in time: fork, how far its line runs (own items, and every point a parallel track leaves
  // or rejoins it), merge, and its label
  const measure = document.createElement("canvas").getContext("2d"), FONT = getComputedStyle(document.body).fontFamily;
  lanes.forEach(L => {
    const {p, fork, items} = L;
    // fork between slots (never on an earlier date's line), leaving the branch line a short run before its first slot
    L.forkT = T(fork) - STEP * 0.7; L.laneStart = T(fork) - STEP * 0.4;
    L.mainEnd = L.laneStart + STEP * 0.3;
    items.forEach(it => {
      if (it.track === 0) L.mainEnd = Math.max(L.mainEnd, it.kind === "active" ? tEnd : T(it.s));
      else L.mainEnd = Math.max(L.mainEnd, T(it.s) + (it.kind === "fin" ? STEP / 2 : -STEP / 2));
    });
    L.mergeT = isDone(p) ? L.mainEnd + STEP / 2 : null;
    L.todo = p.stages.filter(st => !pjFin(st) && st.status !== "active");
    L.stat = `${p.counts.done}/${p.total} · ${Math.round((p.ratio || 0) * 100)}%` + (vert || !L.todo.length ? "" : ` · 시작 전 ${L.todo.map(st => st.no).join("·")}`);
    measure.font = `600 12px ${FONT}`; const wName = measure.measureText(p.name).width;
    measure.font = `11px ${FONT}`; const wStat = measure.measureText(L.stat).width;
    const end = Math.max(L.mergeT ?? 0, items.some(it => it.kind === "active") ? tEnd + 10 : 0, L.mainEnd + 14);
    // 가로: the label runs along the trunk side of the line; 세로: it stands above the fork, centered on the lane
    L.t0 = vert ? L.forkT - 52 : L.forkT;
    L.t1 = vert ? end : Math.max(end, L.laneStart + 6 + wName + 8 + wStat + 10);
    L.half = vert ? Math.max(wName, wStat, 90) / 2 + 6 : 0;
  });
  // placement: each branch (in fork order) takes the spot nearest the trunk, on either side, where neither its body
  // (label band to outermost track) nor its fork path from the trunk overlaps a branch already placed during the
  // time they share. A branch that has ended frees its space for later forks.
  const boxes = [];  // {t0, t1, c0, c1} relative to the trunk (c = 0)
  const hit = b => boxes.some(o => b.t0 < o.t1 && o.t0 < b.t1 && b.c0 < o.c1 && o.c0 < b.c1);
  lanes.forEach(L => {
    const outer = (L.tracks - 1) * TRACK, band = INNER - 6;  // band: the label strip on the trunk side (가로)
    const reach = vert ? L.half : band;  // how far this branch reaches toward the trunk from its line (label)
    const cands = [];
    [1, -1].forEach(side => {
      cands.push(side * Math.max(INNER, reach + 14));  // 세로 labels stand centered on the lane: keep them off the trunk
      boxes.forEach(o => { if (side > 0 ? o.c1 > 0 : o.c0 < 0) cands.push(side > 0 ? o.c1 + reach + 12 : o.c0 - reach - 12); });
    });
    cands.sort((a, b) => Math.abs(a) - Math.abs(b) || b - a);
    // when every spot's fork path would cross a branch alive at that moment, accept the crossing rather than drift
    // further out
    for (const strict of [true, false]) { if (L.c0 != null) break; for (const c of cands) {
      const side = c > 0 ? 1 : -1;
      const inner = vert ? c - side * L.half : c - side * band, far = vert ? c + side * Math.max(outer + 36, L.half) : c + side * (outer + NAME);
      const body = {t0: L.t0, t1: L.t1, c0: Math.min(inner, far) - 8, c1: Math.max(inner, far) + 8};
      const path = {t0: L.forkT - 2, t1: L.laneStart + 2, c0: Math.min(0, c) + (c > 0 ? 3 : 0), c1: Math.max(0, c) - (c < 0 ? 3 : 0)};
      if (hit(body) || (strict && hit(path))) continue;
      L.side = side; L.c0 = c; boxes.push(body, path); break;
    } }
    if (L.c0 == null) {  // cannot happen with the outermost candidates above; never leave a branch unplaced
      L.side = 1; L.c0 = Math.max(0, ...boxes.map(o => o.c1)) + reach + 12;
    }
  });
  const reachOut = L => L.c0 + L.side * ((L.tracks - 1) * TRACK + NAME);  // outermost track, with its stage names
  const cMin = Math.min(0, ...lanes.map(reachOut)) - CPAD - (vert ? 0 : 20);
  const cMax = Math.max(0, ...lanes.map(reachOut)) + CPAD;
  const trunk = -cMin + (vert ? 30 : 0), CLEN = trunk + cMax;
  lanes.forEach(L => { L.c0 += trunk; });  // lane offsets were relative to the trunk
  const [W, H] = P(T(last) + TAIL, CLEN);
  const o = [`<svg width="${W}" height="${H}">`];
  const line = (ta, ca, tb, cb, attrs) => { const [x1, y1] = P(ta, ca), [x2, y2] = P(tb, cb); return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ${attrs}/>`; };
  const text = (t, c, s, attrs = "") => { const [x, y] = P(t, c); return `<text x="${x}" y="${y}" ${attrs}>${s}</text>`; };
  const curve = (ta, ca, tb, cb) => { const m = (ta + tb) / 2; return `M${pt(ta, ca)} C${pt(m, ca)} ${pt(m, cb)} ${pt(tb, cb)}`; };

  slots.forEach((d, s) => {
    const lbl = (s === todaySlot ? "오늘 " : "") + `${+d.slice(5, 7)}/${+d.slice(8)}`;
    o.push(line(T(s), vert ? 0 : 24, T(s), CLEN, `stroke="color-mix(in srgb, var(--muted) 16%, transparent)"`),
           vert ? text(T(s) + 4, 6, lbl, `class="pj-m" dominant-baseline="middle"${s === todaySlot ? ' style="fill:var(--run)"' : ""}`)
                : text(T(s), 16, lbl, `class="pj-m" text-anchor="middle"${s === todaySlot ? ' style="fill:var(--run)"' : ""}`));
  });
  const tTrunkEnd = T(todaySlot) + STEP * 0.6;
  o.push(line(T0 - STEP * 0.85, trunk, tTrunkEnd, trunk, `stroke="var(--muted)" stroke-width="5" stroke-linecap="round" opacity=".55"`),
         `<path d="M${pt(tTrunkEnd + 9, trunk)} L${pt(tTrunkEnd, trunk - 7)} L${pt(tTrunkEnd, trunk + 7)}z" fill="var(--muted)" opacity=".55"/>`);

  // the stage's name beside its node: 가로 on the outer side (below a lower lane, above an upper one), 세로 under it
  const stageName = (t, c, side, st) => {
    const name = st.name.length > 8 ? st.name.slice(0, 7) + "…" : st.name;
    const [x, y] = vert ? P(t + R + 13, c) : P(t, c + side * (R + 13) + (side > 0 ? 4 : 0));
    return `<text class="pj-sname ${st.status}" x="${x}" y="${y}" text-anchor="middle">${esc(name)}</text>`;
  };
  const node = (p, t, c, st) => {
    const [x, y] = P(t, c), active = st.status === "active";
    const fill = active ? "var(--panel)" : st.status === "failed" ? "var(--bad)" : "var(--done)";
    const stroke = active ? "var(--run)" : fill, color = active ? "var(--run)" : "var(--on-accent)";
    const tip = `${p.name}\n${st.no}. ${st.name} — ${active ? `진행 중 (${st.start} 시작)` : `${st.status} ${st.end}`} · ${st.counts.done}/${st.total}`;
    const cur = p.current && p.current.no === st.no;
    const halo = cur ? `<circle cx="${x}" cy="${y}" r="${R + 3}" fill="none" stroke="var(--run)" stroke-width="2" class="pj-halo"/>` : "";
    // a surface-colored ring keeps touching nodes and the lines under them apart
    const base = `<circle cx="${x}" cy="${y}" r="${R + 2.5}" fill="var(--panel)"/>`;
    let body;
    if (active) {
      // the ring is a gauge of the stage's finished steps, clockwise from the top
      const C = 2 * Math.PI * (R - 1.5), f = st.total ? st.counts.done / st.total : 0;
      body = `<circle cx="${x}" cy="${y}" r="${R - 1.5}" fill="color-mix(in srgb, var(--run) 12%, var(--panel))" stroke="color-mix(in srgb, var(--run) 38%, var(--panel))" stroke-width="3.5"/>` +
        `<circle cx="${x}" cy="${y}" r="${R - 1.5}" fill="none" stroke="var(--run)" stroke-width="3.5" stroke-linecap="round"
                 stroke-dasharray="${(C * f).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 ${x} ${y})"/>`;
    } else body = `<circle cx="${x}" cy="${y}" r="${R}" fill="${fill}" stroke="var(--chart-rim)" stroke-width="1.5"/>`;
    return `<g class="pj-nd" data-st="${st.no}">${halo}${base}${body}<circle cx="${x}" cy="${y}" r="${R + 3}" fill="transparent"><title>${esc(tip)}</title></circle>` +
      `<text x="${x}" y="${y + 4}" text-anchor="middle" style="font-size:11px;font-weight:700;fill:${color};pointer-events:none">${st.no}</text></g>`;
  };
  lanes.forEach(L => {
    const {p, items, side, c0, forkT, laneStart, mainEnd, mergeT, todo, stat} = L, cOf = j => c0 + side * j * TRACK, done = isDone(p);
    const k = pjKeyOf(p), on = pjFocus === k;
    o.push(`<g class="pj-br${on ? ' on' : pjFocus ? ' dim' : ''}" data-pj="${esc(k)}" role="button" tabindex="0" aria-label="${esc(p.name)} 상세" aria-expanded="${on}">`,
           `<path d="${curve(forkT, trunk, laneStart, c0)} L${pt(mainEnd, c0)}${done ? " " + curve(mainEnd, c0, mergeT, trunk).replace("M", "L") : ""}" fill="none" stroke="var(--idle)" stroke-width="2.5"/>`,
           `<circle cx="${P(forkT, trunk)[0]}" cy="${P(forkT, trunk)[1]}" r="5" fill="var(--panel)" stroke="var(--muted)" stroke-width="2"/>`);
    if (done) o.push(`<circle cx="${P(mergeT, trunk)[0]}" cy="${P(mergeT, trunk)[1]}" r="5" fill="var(--done)"/>`);
    const fins0 = items.filter(it => it.kind === "fin" && it.track === 0);
    if (fins0.length > 1) o.push(line(T(fins0[0].s), c0, T(fins0[fins0.length - 1].s), c0, `stroke="var(--done)" stroke-width="2.5"`));
    items.forEach(it => {
      const c = cOf(it.track), t = T(it.s);
      // where a parallel track splits off: half a slot back on the branch line, or, in the fork's own slot, where the
      // line has just begun
      const split = curve(Math.max(t - STEP / 2, laneStart), c0, t, c);
      if (it.kind === "fin" && it.track > 0)  // a parallel finish: leaves the branch, then rejoins it
        o.push(`<path d="${split} ${curve(t, c, t + STEP / 2, c0).replace("M", "L")}" fill="none" stroke="var(--done)" stroke-width="2"/>`);
      if (it.kind === "active") {
        if (it.track > 0) o.push(`<path d="${split}" fill="none" stroke="var(--run)" stroke-width="2"/>`);
        o.push(line(t, c, tEnd, c, `stroke="var(--run)" stroke-width="6" stroke-linecap="round" opacity=".35"`),
               line(t, c, tEnd, c, `stroke="var(--run)" stroke-width="2"`),
               `<path d="M${pt(tEnd + 8, c)} L${pt(tEnd, c - 5)} L${pt(tEnd, c + 5)}z" fill="var(--run)"/>`);
      }
    });
    items.forEach(it => o.push(node(p, T(it.s), cOf(it.track), it.st), stageName(T(it.s), cOf(it.track), side, it.st)));
    if (vert) {
      // above the fork, where the lane has not begun; 시작 전 goes here too (lanes are too close at the bottom)
      const [x, y] = P(forkT - (todo.length ? 44 : 30), c0);
      o.push(`<text class="pj-lblv" x="${x}" y="${y}" text-anchor="middle" style="font-weight:600">${esc(p.name)}<tspan class="pj-m" x="${x}" dy="15" style="font-weight:400">${stat}</tspan>` +
             (todo.length ? `<tspan class="pj-m" x="${x}" dy="14" style="font-weight:400">시작 전 ${todo.map(st => st.no).join("·")}</tspan>` : "") + `</text>`);
    } else {
      // on the trunk side of the branch line, just past the fork
      o.push(text(laneStart + 6, c0 + (side > 0 ? -16 : 26), `${esc(p.name)}<tspan class="pj-m" dx="8" style="font-weight:400">${stat}</tspan>`, `style="font-weight:600"`));
    }
    o.push(`</g>`);
  });
  o.push(`</svg>`);
  box.innerHTML = o.join("");
  // a label running off either edge (outer lanes in 세로) is pulled back inside
  box.querySelectorAll(".pj-lblv").forEach(t => {
    const b = t.getBBox(), dx = Math.max(6 - b.x, 0) || Math.min(W - 6 - (b.x + b.width), 0);
    if (dx) t.querySelectorAll("tspan").forEach(s => s.setAttribute("x", +s.getAttribute("x") + dx)), t.setAttribute("x", +t.getAttribute("x") + dx);
  });
}

// Opening a project (프로젝트별): one at a time, like an accordion. Fires for the open attribute a redraw sets too.
document.addEventListener('toggle', e => {
  const row = e.target;
  if (!row.matches?.('details.pj-row')) return;
  const k = row.dataset.pj, box = row.querySelector('[data-pj-detail]');
  if (row.open) {
    document.querySelectorAll('details.pj-row[open]').forEach(x => { if (x !== row) x.open = false; });
    if (pjOpen !== k) { pjOpen = k; if (pjNote?.key !== k) pjNote = null; }
    if (!box.firstChild) pjDetail(box, k);
  } else if (pjOpen === k) { pjOpen = null; pjNote = null; box.innerHTML = ''; }
}, true);

function pjSelect(k, stage) {
  // 전체 시계열: a branch (or one of its stages) focuses that project; the same branch again lets it go.
  pjFocus = pjFocus === k && !stage ? null : k;
  if (pjNote && pjNote.key !== pjFocus) pjNote = null;
  pjScrollTo = stage || null;
  renderProjects().then(() => {
    const g = pjFocus && [...document.querySelectorAll('.pj-br')].find(x => x.dataset.pj === pjFocus), tl = $('#pj-tl');
    if (!g || !tl) return;
    // bring the branch into view in the graph, and the detail into the window
    const b = g.getBBox();
    if (tl.scrollWidth > tl.clientWidth) tl.scrollTo({ left: Math.max(0, b.x - 40), behavior: 'smooth' });
    if (tl.scrollHeight > tl.clientHeight) tl.scrollTo({ top: Math.max(0, b.y - 40), behavior: 'smooth' });
    if (!pjVertical()) $('#pj-focus').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
}

document.addEventListener('click', e => {
  if (route().v !== 'projects') return;
  const t = e.target, seg = t.closest('[data-pj-seg] button');
  if (t.closest('[data-pj-servers]')) return serverPanel();
  if (seg) {
    const key = seg.closest('[data-pj-seg]').dataset.pjSeg;
    pj[key] = seg.dataset.k; pjSave(); if (key === 'view') pjNote = null;
    return renderProjects();
  }
  // a stage on a project's line: open the project there (an open one stays open)
  const node = t.closest('details.pj-row > summary .pj-st');
  if (node) {
    const row = node.closest('details.pj-row');
    pjScrollTo = +node.dataset.st;
    if (row.open) { e.preventDefault(); row.querySelector(`[data-st-sec="${pjScrollTo}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); pjScrollTo = null; }
    return;
  }
  const br = t.closest('.pj-br');
  if (br) return pjSelect(br.dataset.pj, +t.closest('.pj-nd')?.dataset.st || 0);
  const box = t.closest('[data-pj-detail], #pj-focus'), key = box && (box.dataset.pjDetail || pjFocus);
  if (!box || !key || !pjFull[key]) return;
  const step = t.closest('[data-pj-step]');
  if (step) {
    if (pjNote?.key === key && pjNote.path === step.dataset.pjStep) pjNote = null;  // the open step again closes the split
    else pjNote = { key, path: step.dataset.pjStep };
    box.querySelector('.pj-split').classList.toggle('on', !!pjNote);
    if (pjNote) pjShowNote(box, pjFull[key]); else box.querySelectorAll('.pj-step.on').forEach(b => b.classList.remove('on'));
  } else if (t.closest('[data-pj-nclose]')) {
    pjNote = null; box.querySelector('.pj-split').classList.remove('on'); box.querySelectorAll('.pj-step.on').forEach(b => b.classList.remove('on'));
  }
});
// the graph's branches are role="button": Enter or Space picks one, as a click does
document.addEventListener('keydown', e => {
  const br = (e.key === 'Enter' || e.key === ' ') && e.target.closest?.('.pj-br');
  if (br) { e.preventDefault(); pjSelect(br.dataset.pj, 0); }
});

// A vertical wheel over something that only scrolls sideways (.hscroll: the 가로 timeline, a project's line of
// stages) scrolls it sideways. At either end the wheel falls through to the page, so it never traps the page scroll;
// a sideways trackpad swipe, Shift+wheel and Ctrl+wheel (zoom) are left to the browser.
addEventListener('wheel', e => {
  if (e.shiftKey || e.ctrlKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
  const el = e.target.closest?.('.hscroll');
  if (!el || el.scrollWidth <= el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) return;
  const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientWidth : 1), max = el.scrollWidth - el.clientWidth;
  if ((dy < 0 && el.scrollLeft <= 0) || (dy > 0 && el.scrollLeft >= max - 1)) return;
  e.preventDefault();
  el.scrollLeft = Math.max(0, Math.min(max, el.scrollLeft + dy));
}, { passive: false });

function connect() {
  const last = {};
  let wasLive = false;
  api.events({
    version: v => { const i = v.indexOf(':'), id = v.slice(0, i); if (last[id] !== v) { last[id] = v; pump(); } },
    // a server's projects changed: drop what was fetched and redraw the projects view (an open note stays as it is)
    projects: () => { pjData = null; pjFull = {}; if (route().v === 'projects') render(); },
    change: () => {
      renderConn();
      // which servers are on and connected decides where projects come from: refetch them when that changes
      const srcKey = srvOn().map(x => `${x.id}${x.live ? '+' : '-'}`).join(',');
      if (srcKey !== pjSrcKey) { pjSrcKey = srcKey; pjData = null; pjFull = {}; if (route().v === 'projects') render(); }
      const live = srvOn().some(x => x.live);
      if (live && !wasLive) checkBuild();
      wasLive = live;
    },
  });
}
connect();
setInterval(() => { if (state && !document.hidden && (['agents', 'talk', 'tests'].includes(route().v) || onlyLive && route().v === 'compare')) render(); }, 15000); // keep "n분 전" fresh; let the 「실행 중만」 grace expire
let rz; addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => {
  if (route().v === 'session' && detail) renderSession();
  if (route().v === 'projects' && pj.view === 'timeline') render();  // 자동 orientation follows the window's shape
}, 200); });
