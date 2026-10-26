const $ = s => document.querySelector(s);
const fmt = n => n == null ? '–' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n));
const usd = n => n == null ? '—' : n >= 100 ? '$' + n.toFixed(0) : '$' + n.toFixed(2);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cut = (t, n) => { t = String(t ?? ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
// The fold layout (ds --fold): an unfolded foldable in two panes. narrow() is the narrow layout (max-width 700px) without it.
const isFold = () => getComputedStyle(document.documentElement).getPropertyValue('--fold').trim() === '1';
const narrow = () => innerWidth <= 700 && !isFold();
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
let agView = 'tree';  // tree | wt | map | tl: coordinator trees, one section per worktree (「워크트리별」), 「관계 지도」, 「타임라인」
try { agView = ['wt', 'map', 'tl'].find(v => v === localStorage.getItem('adash.agview')) || 'tree'; } catch {}
let state = null, view = 'agents', detail = null, runFull = null, hlTurn = null, openState = {};
let onlyLive = false;
try { onlyLive = localStorage.getItem('adash.live') === '1'; } catch {}
$('#only-live').checked = onlyLive;
$('#only-live').onchange = e => { onlyLive = e.target.checked; try { localStorage.setItem('adash.live', onlyLive ? '1' : '0'); } catch {} gKey = ''; render(); };
// Theme and material: the 테마 button (<ds-theme-toggle>) and the 「색 편집」 panel (<ds-theme-editor>) are design
// system components; SVG charts read the CSS variables, so switching needs no re-render.
$('#theme-edit').onclick = () => { $('#theme-panel').hidden = !$('#theme-panel').hidden; };
// 「앱 아이콘」 panel: the PWA icon, 5 concepts × 4 colours (icon-boot.js lists them and swaps the links). This
// device only, like the theme.
function iconPanel() {
  const el = $('#icon-panel'), cur = appIcon(), ios = /iP(hone|ad|od)/.test(navigator.userAgent);
  el.innerHTML = `<div class="pop-h"><b>앱 아이콘</b><span class="st">이 기기에만 저장</span><button class="act" data-ip="close">닫기</button></div>
    <div class="ip-grid">${APP_ICONS.map(x => `<button class="ip-icon${x.id === cur ? ' on' : ''}" data-id="${x.id}" title="${x.concept} · ${x.colour}" aria-label="${x.concept} · ${x.colour}" aria-pressed="${x.id === cur}"><img src="${appIconSrc(x.id)}" alt="" loading="lazy"></button>`).join('')}</div>
    <div class="ip-name">${(x => `${x.concept} · ${x.colour}`)(APP_ICONS.find(x => x.id === cur))}</div>
    <p class="ip-help">${ios ? '홈 화면 아이콘은 추가할 때 정해집니다. 바꾸려면 홈 화면에서 지우고 Safari 공유 → 홈 화면에 추가로 다시 넣으세요.'
      : '탭 아이콘은 바로 바뀝니다. 설치한 앱 아이콘은 브라우저가 다음에 앱을 확인할 때 바뀌며, 바꿀지 물어볼 수 있습니다.'}</p>`;
  el.querySelectorAll('.ip-icon').forEach(b => b.onclick = () => { setAppIcon(b.dataset.id); el.hidden = true; });
  el.querySelector('[data-ip=close]').onclick = () => { el.hidden = true; };
  el.hidden = false;
}
// A popover closes once its action is done (a pick, a switch, an add) or on a click outside (ds-dock.js); it stays open
// for what is shown in it (a test result, an error) and for steps of a form.
$('#icon-btn').onclick = () => { if ($('#icon-panel').hidden) iconPanel(); else $('#icon-panel').hidden = true; };
// 「Orca 에 열린 것만」: only agents whose connected Orca terminal the server found (session.orca_focus), the same set
// that gets the 「Orca 에서 열기」 button. Combines with 「실행 중만」 (both must hold).
let onlyOrca = false;
try { onlyOrca = localStorage.getItem('adash.orca') === '1'; } catch {}
$('#only-orca').checked = onlyOrca;
$('#only-orca').onchange = e => { onlyOrca = e.target.checked; try { localStorage.setItem('adash.orca', onlyOrca ? '1' : '0'); } catch {} gKey = ''; render(); };
// 「캐릭터 모드」: the agents tab and 홈 drawn as an office of characters (renderOffice) instead of cards and the widget
// board. This device only.
let charMode = false;
try { charMode = localStorage.getItem('adash.charmode') === '1'; } catch {}
$('#char-mode').checked = charMode;
$('#char-mode').onchange = e => { charMode = e.target.checked; try { localStorage.setItem('adash.charmode', charMode ? '1' : '0'); } catch {} render(); };
// 「캐릭터 설정」 panel (the bar's ⋯ menu; 캐릭터 모드 itself is a toggle on the bar): how the characters are drawn
// (charStyle) and framed (charFrame), and the way to the 「캐릭터」 tab. This device only.
function charPanel() {
  const el = $('#char-panel');
  const seg = (k, cur, opts) => `<span class="seg" data-cp="${k}">${opts.map(([v, l]) => `<button data-k="${v}"${v === cur ? ' class="on"' : ''} aria-pressed="${v === cur}">${l}</button>`).join('')}</span>`;
  el.innerHTML = `<div class="pop-h"><b>캐릭터 설정</b><span class="st">이 기기에만 저장</span><button class="act" data-cp="close">닫기</button></div>
    <div class="cp-row"><span>그림체</span>${seg('style', charStyle, [['ai', 'AI 생성 (SD 픽셀)'], ['l2d', 'Live2D']])}</div>
    <div class="cp-row"><span>보기</span>${seg('frame', charFrame, [['bust', '상반신'], ['full', '전신']])}</div>
    <a class="act cp-link" href="#chars">캐릭터 그림 관리 →</a>`;
  const set = { style: k => { charStyle = k; try { localStorage.setItem('adash.charstyle', k); } catch {} },
    frame: k => { charFrame = k; try { localStorage.setItem('adash.charframe', k); } catch {} } };
  el.querySelectorAll('[data-cp=style] button, [data-cp=frame] button').forEach(b => b.onclick = () => { set[b.parentElement.dataset.cp](b.dataset.k); el.hidden = true; render(); });
  el.querySelector('[data-cp=close]').onclick = () => { el.hidden = true; };
  el.querySelector('.cp-link').onclick = () => { el.hidden = true; };
  el.hidden = false;
}
$('#char-btn').onclick = () => { if ($('#char-panel').hidden) charPanel(); else $('#char-panel').hidden = true; };

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
  // Boxes a driver added after start (fix_source): task id -> plan row, so the worker's card can say why it was made.
  // Matched like extPlanRow: task_id, else the newest task of that title in the ticket's own run.
  const addedBy = {};
  for (const p of state.ext_plans || []) for (const k of p.tickets || []) for (const x of k.sessions || []) {
    if (!x.fix_source) continue;
    const t = (x.task_id && tasks[x.task_id]) || (k.run_id ? (o.tasks[k.run_id] || []).filter(c => !c.plan_row && c.task_title === x.key)
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))[0] : null);
    if (t) addedBy[t.id] = x;
  }
  return { tasks, runOf, runsByCoord, byId, subsOf, addedBy };
}
let IX = null;
// Values derived from the whole snapshot (test items, which session started which E2E run) that every card asks for:
// computed once per refresh instead of once per card, which was quadratic in the session count. Keyed by IX, which
// refresh() rebuilds with every new snapshot.
let snapMemo = null;
const memo = () => (snapMemo?.ix === IX ? snapMemo : (snapMemo = { ix: IX, sessOf: new WeakMap() }));
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
// The tree depends only on the snapshot (not on folds or filters), and driver blocks look up their owner in it, so it is
// built once per refresh.
const families = () => memo().fams ||= buildFamilies();
function buildFamilies() {
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
  const h = decodeURIComponent(location.hash.slice(1) || 'home');
  if (h === 'projects') return { v: 'projects' };
  if (h === 'designs') return { v: 'designs' };
  if (h.startsWith('dz=')) { const p = h.slice(3).split('|'), sec = p.length > 2 ? p.pop() : ''; return { v: 'designs', server: p[0], key: p.slice(1).join('|'), sec }; }
  if (h.startsWith('s=')) return { v: 'session', id: h.slice(2) };
  if (h.startsWith('r=')) return { v: 'run', id: h.slice(2) };
  return { v: ['home', 'agents', 'compare', 'talk', 'tests', 'worktrees', 'decide', 'chars', 'usage'].includes(h) ? h : 'home' };
}
// 결정 대기 (#decide) with nothing waiting (no pending question, no unread 메일함 item) is not opened: a toast says so
// and the screen stays as it was. Opened, it remembers the screen it came from (decFrom), and goes back there once
// the last pending question is answered and nothing is left.
let decFrom = 'home';
const decLeft = () => { const d = state?.decisions; return d ? d.pending.length + (d.inbox || []).filter(r => !r.read).length : 0; };
addEventListener('hashchange', e => {
  const from = new URL(e.oldURL).hash.slice(1) || 'home';
  if (route().v === 'decide' && from !== 'decide') {
    if (state?.decisions?.available && !decLeft()) { history.replaceState(null, '', e.oldURL); return toast('결정 대기 중인 질문이 없습니다'); }
    decFrom = from;
  }
  hlTurn = null; detail = null; openState = {}; render(true); window.scrollTo(0, 0);
});
const openSession = path => location.hash = 's=' + encodeURIComponent(path);
const openRun = id => location.hash = 'r=' + id;

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
  const hadDec = state?.decisions?.pending?.length || 0;
  state = await api.state();
  if (hadDec && !decLeft() && route().v === 'decide') location.hash = decFrom;  // the render below draws that screen
  state.all = state.sessions;
  chPin(state.all);
  injectPlanTasks();
  IX = index();
  renderHeader();
  notifyDecisions();
  await render();
  chatSync();
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
  $('#view').querySelectorAll('*').forEach(el => { if ((el.scrollTop || el.scrollLeft) && !el.classList.contains('log') && !el.classList.contains('chat-log')) inner.push([scrollKey(el), el.scrollLeft, el.scrollTop]); });
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
  document.querySelectorAll('#dock a, .dock-more a').forEach(a =>  // a data-more tab sits in the ⋯ menu
    a.classList.toggle('on', a.dataset.v === tab));
  if (r.v !== 'talk') talkMounted = false;
  if (r.v !== 'compare') cmpMounted = false;
  if (r.v !== 'tests') testsMounted = false;
  if (r.v !== 'worktrees') wtMounted = false;
  if (r.v !== 'chars') chxMounted = false;
  if (r.v !== 'designs') dzMounted = null;
  $('#dz-pane-btn').hidden = r.v !== 'designs';
  $('#dz-pane-chk').checked = dz.pane;
  const office = (r.v === 'agents' || r.v === 'home') && charMode;
  document.querySelectorAll('.ch-dock').forEach(b => { b.hidden = !office; });  // the office canvas's zoom figure (맞춤), on the bar
  if (!office) document.documentElement.classList.remove('ch-full');
  if (r.v === 'home') { if (charMode) renderOffice(); else renderHome(); }
  else if (r.v === 'agents') renderAgents();
  else if (r.v === 'compare') renderCompare();
  else if (r.v === 'talk') await renderTalk();
  else if (r.v === 'tests') await renderTests();
  else if (r.v === 'worktrees') await renderWorktrees();
  else if (r.v === 'decide') renderDecide();
  else if (r.v === 'usage') renderUsage();
  else if (r.v === 'chars') renderChars();
  else if (r.v === 'projects') await renderProjects();
  else if (r.v === 'designs') await renderDesigns();
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
  { const dec = state.decisions?.pending?.length || 0;  // 입력 대기 is not the user's to do; a pending 결정 is
    $('#dock').setAttribute('summary', `실행 ${ss.filter(s => status(s) === 'run').length}${dec ? ` · 결정 ${dec}` : ''}`); }
  const bg = ss.filter(s => status(s) === 'bg').length;
  $('#k-bg').textContent = bg;
  $('#k-bg-wrap').hidden = !bg;
  $('#k-agents').textContent = ss.length;
  const priced = ss.filter(s => s.cost != null);
  $('#k-cost').textContent = usd(priced.reduce((a, s) => a + s.cost, 0)) + (priced.length < ss.length ? '+' : '');
  $('#k-tokens').textContent = fmt(ss.reduce((a, s) => a + total(s), 0));
  $('#k-turns').textContent = fmt(ss.reduce((a, s) => a + s.turns, 0));
  { const n = testItems().filter(testLive).length; $('#k-tests').textContent = n; $('#k-tests').hidden = !n; }
  { const n = hmMine().length; $('#k-home').textContent = n; $('#k-home').hidden = !n; }
  $('#k-runs').textContent = state.orca.error ? '오류' : state.orca.runs.filter(r => (state.orca.tasks[r.id] || []).some(t => !['completed', 'failed', 'cancelled'].includes(t.status))).length;
  renderHealth();
  usageBadge();
  const dec = state.decisions || { available: false, pending: [] }, unread = (dec.inbox || []).filter(r => !r.read).length;
  $('#k-dec-wrap').hidden = !dec.available;
  $('#k-dec').textContent = dec.pending.length;
  $('#k-mail').textContent = ` · ${unread}`;  // unread 메일함 items, a value of its own beside the pending count
  $('#k-mail').hidden = !unread;
  $('#k-dec-l').textContent = '결정 대기' + (unread ? ' · 메일' : '');
  $('#k-dec-wrap').classList.toggle('on', dec.pending.length > 0 || unread > 0);
  $('#k-dec-n').textContent = dec.pending.length + unread;  // the bar's 「결정 대기」 tab: what is waiting on the user
  $('#k-dec-n').hidden = !(dec.pending.length + unread);
  document.title = (dec.pending.length ? `(${dec.pending.length}) 결정 대기 · ` : '') + 'Agent Dashboard';
  $('#k-dec-wrap').classList.toggle('away', inboxMode().on);
  $('#k-dec-wrap').title = inboxMode().on ? '메일함 모드 켜짐: 질문은 메일함에 쌓이고 에이전트는 권장안으로 진행합니다' : '';
  $('#inbox-mode-btn').hidden = !inboxMode().ids.length;
  $('#inbox-mode').checked = inboxMode().on;
}
// 「현황」 (the bar's figures popover, there is no page header); its 「결정 대기」 opens the screen with every pending
// question and the 메일함.
$('#stat-btn').onclick = () => { $('#stat-panel').hidden = !$('#stat-panel').hidden; };
$('#k-dec-wrap').onclick = () => { $('#stat-panel').hidden = true; location.hash = 'decide'; };

// 메일함 mode, one switch over every server that is on and has it: on only when each of them is on.
function inboxMode() {
  const m = state?.decisions?.inbox_mode || {}, ids = Object.keys(m);
  return { ids, on: ids.length > 0 && ids.every(id => m[id]), some: ids.some(id => m[id]) };
}
async function setInboxMode(on) {
  const r = await api.inboxMode(on, inboxMode().ids);
  if (r.status !== 200) toast(r.body?.error || `메일함 모드를 바꾸지 못했습니다 (${r.status})`);
  refresh();
}
$('#inbox-mode').onchange = e => setInboxMode(e.target.checked);

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
// whose session is not listed (one with no session at all is closed by the server soon), so none is out of sight;
// on the 결정 대기 screen (#decide) every one, then the 메일함.
function showDecisions() {
  const pending = state.decisions?.pending || [], r = route();
  const sessOf = q => state.all.find(s => s.decision?.id === q.id) || (q.session_id && state.all.find(s => s.kind === 'claude' && s.id === q.session_id));
  let items = [];
  if (r.v === 'session') {
    const s = state.all.find(x => x.path === r.id);
    items = s ? pending.filter(q => q.session_id && q.session_id === s.id) : [];
  } else if (r.v === 'agents') items = pending.filter(q => !state.sessions.some(s => s.decision?.id === q.id));
  else if (r.v === 'decide') items = pending;
  const owner = q => {
    const s = sessOf(q);
    return { ...s ? { name: nameOf(s), href: r.v === 'session' ? null : '#s=' + encodeURIComponent(s.path) } : { name: (q.agent || '에이전트') + ' · 세션 목록에 없음' }, badge: srvBadge(q) };
  };
  decisions.show(items, pending, owner);
  decAlert(r.v === 'decide' || r.v === 'session' && items.length ? [] : pending, sessOf);
  if (r.v === 'decide') { decideHead(); inbox.show(state.decisions?.inbox || [], owner); }
  else { $('#decide-head').hidden = true; inbox.hide(); }
}

// A strip over every other screen while questions wait: the oldest one (whose session, what it asks, how long) and
// how many more, all of it a link to #decide, so a question never waits unseen behind a tab or a closed popover.
function decAlert(pending, sessOf) {
  const el = $('#dec-alert');
  el.hidden = !pending.length;
  if (!pending.length) return void (el.innerHTML = '');
  const q = pending[0], s = sessOf(q), q0 = q.questions?.[0] || {}, sec = Math.max(0, Date.now() / 1000 - q.created_at);
  const wait = sec < 60 ? '방금' : sec < 3600 ? `${Math.round(sec / 60)}분째` : `${Math.round(sec / 3600)}시간째`;
  el.innerHTML = `<a class="dec-alert" href="#decide"><ds-icon name="help"></ds-icon><b>결정 대기 ${pending.length}</b>
    <span class="da-who">${esc(cut(s ? nameOf(s) : q.agent || '에이전트', 40))}</span>
    <span class="da-q" title="${esc(q0.question || '')}">${esc(q0.question || '')}</span>
    <span class="da-meta">${wait}${pending.length > 1 ? ` · 외 ${pending.length - 1}건` : ''}</span><span class="da-go">답하기 →</span></a>`;
}

// #decide: a heading (the 메일함 switch is in 「현황」) above the cards (#decide-head, outside #view like the cards, and
// rebuilt on every refresh: it holds nothing being typed), and the 메일함 (#inbox) below them.
function decideHead() {
  const dec = state.decisions, m = inboxMode(), el = $('#decide-head');
  el.hidden = false;
  el.innerHTML = `<a class="back" href="#agents">← 에이전트</a>
    <div class="sec-h"><h2>결정 대기 ${dec.pending.length}</h2>
      <span>${m.on ? '메일함 모드: 새 질문은 메일함에 쌓이고, 에이전트는 권장안으로 진행합니다.' : '터미널 선택기와 같은 질문입니다. 여기서 답하면 터미널에 대신 입력합니다.'}</span></div>`;
}
function renderDecide() {
  const dec = state.decisions;
  $('#view').innerHTML = dec.pending.length || dec.inbox?.length ? ''
    : `<div class="empty">${dec.available ? '결정을 기다리는 질문도, 메일함에 남은 질문도 없습니다.' : '결정 버튼을 쓰는 메트릭 서버가 없습니다.'}</div>`;
}

// Server collector loops (state.health.loops: name -> {ok, error, at}). SSE pings keep 「실시간」 on even when a
// collector has stopped, so a loop whose last clean pass is older than its limit is called out here, as is a
// failure in the last 10 minutes. A refresh that failed in the page itself is shown the same way.
const LOOPS = { plan_usage: ['플랜 사용량', 1800], scan: ['세션 로그', 60], orca: ['Orca', 300], ext_plan: ['외부 계획', 60], history: ['지난 기록', 1800], decision: ['결정 버튼', 30],
  design: ['설계문서', 60], design_backfill: ['설계문서 지난 로그', 3600] };
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
  $('#stat-btn').classList.toggle('bad', !el.hidden);
  $('#stat-btn').dataset.tip = el.hidden ? '현황' : '현황 · ' + el.textContent;
}

// ---------- plan usage (#usage) ----------
// One card per subscription account (state.plan_usage, read by each server every 5 minutes from the provider's usage
// API with the token its CLI or Orca keeps): every limit window as a bar with its reset, the one holding the account
// back marked, and the extra credits. An account whose token is not valid keeps its last figures, greyed, with why.
// The bar's tab carries the fullest window of an account in use, coloured once it nears its limit.
const PROVIDERS = { claude: 'Claude', codex: 'Codex' };
const usageTone = p => p >= 90 ? 'var(--bad)' : p >= 70 ? 'var(--warn)' : 'var(--accent)';
function usageBadge() {
  const live = (state.plan_usage || []).filter(a => !a.stale && !a.note), top = Math.max(-1, ...live.flatMap(a => (a.limits || []).map(b => b.percent ?? -1)));
  const el = $('#k-usage');
  el.hidden = top < 70;
  el.textContent = top + '%';
  el.style.background = top >= 70 ? usageTone(top) : '';
}
function untilText(t) {
  if (!t) return '';
  const m = Math.max(0, Math.round((t - Date.now() / 1000) / 60)), d = new Date(t * 1000);
  const at = m < 1440 ? d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short' });
  return `${at} 리셋 · ${m < 60 ? m + '분' : m < 1440 ? Math.floor(m / 60) + '시간 ' + m % 60 + '분' : Math.floor(m / 1440) + '일 ' + Math.floor(m % 1440 / 60) + '시간'} 남음`;
}
function renderUsage() {
  const list = state.plan_usage || [], multi = new Set(list.map(a => a.server)).size > 1;
  const when = t => t ? `${new Date(t * 1000).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 기준 (${ago(new Date(t * 1000).toISOString())})` : '아직 읽지 못함';
  const extra = a => a.extra ? `<div class="pu-x">초과 사용 크레딧 ${a.extra.limit_usd ? `<b>${usd(a.extra.used_usd)}</b> / ${usd(a.extra.limit_usd)}${a.extra.reached ? ' · <em>한도 도달</em>' : ''}` : '<b>꺼짐</b> (월 한도 $0)'}</div>`
    : a.credits ? `<div class="pu-x">크레딧 ${a.credits.unlimited ? '<b>무제한</b>' : a.credits.balance != null ? `<b>${esc(a.credits.balance)}</b>` : a.credits.has ? '<b>있음</b>' : '<b>없음</b>'}${a.credits.reached ? ' · <em>한도 도달</em>' : ''}</div>` : '';
  const card = a => `<section class="box pu-card${a.stale || a.note ? ' stale' : ''}">
    <div class="pu-h"><span class="badge">${PROVIDERS[a.provider] || esc(a.provider)}</span><b>${esc(a.email || '?')}</b>${a.plan ? `<span class="st">${esc(a.plan)}</span>` : ''}
      ${multi ? `<span class="st">${esc(a.server_name)}</span>` : ''}</div>
    <div class="pu-when" title="${esc(a.source ? '토큰: ' + a.source : '')}">${when(a.at)}</div>
    ${a.note ? `<div class="pu-note">${esc(a.note)}</div>` : ''}${a.error ? `<div class="pu-err">⚠ 갱신 실패: ${esc(a.error)}</div>` : ''}
    ${(a.limits || []).map(b => `<div class="pu-row${b.active ? ' on' : ''}">
      <span class="pu-n">${esc(b.name)}${b.active ? ` <em>${a.provider === 'claude' ? '현재 한도' : '한도 도달'}</em>` : ''}</span><b>${b.percent ?? '–'}%</b>
      <div class="ctxbar"><div style="width:${Math.min(100, b.percent || 0)}%;background:${usageTone(b.percent || 0)}"></div></div>
      <span class="pu-r">${untilText(b.resets_at)}</span></div>`).join('')}
    ${extra(a)}</section>`;
  $('#view').innerHTML = `<div class="sec-h"><h2>플랜 사용량</h2><span>구독 계정마다 사용량 API 를 5분에 한 번 읽습니다. 토큰이 없거나 만료된 계정은 마지막 값을 흐리게 보여 줍니다.</span></div>
    ${list.length ? `<div class="pu-grid">${list.map(card).join('')}</div>` : '<div class="empty">사용량을 읽는 메트릭 서버가 없습니다.</div>'}`;
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

// The vault notes this session created (their `agent/<tool>-<session id>` tag), newest first. Each opens in Obsidian;
// a note a project step links to (or that is a step) names that step, and the step opens in the 프로젝트 tab.
function vaultBox(d) {
  const ns = d.vault_notes;
  if (!d.vault_on || !ns) return '';
  if (!ns.length) return `<div class="box"><h3>볼트 문서</h3><div class="st">이 세션이 만든 볼트 노트가 없습니다. 노트 프론트매터의 <code>agent/${esc(d.kind)}-${esc(d.id)}</code> 태그로 찾습니다.</div></div>`;
  const linked = ns.filter(n => n.steps.length).length;
  return `<details class="box" id="d-vault" ${(openState.vault ?? ns.length <= 8) ? 'open' : ''}><summary><b>볼트 문서 ${ns.length}</b> <span class="st">이 세션이 만든 노트${linked ? ` · 프로젝트 스텝에 연결 ${linked}` : ''}</span></summary>
    <ul class="vn-list">${ns.map(n => `<li><a class="vn-title" href="${pjObsidian(n.abs)}" title="Obsidian 에서 열기">${esc(n.title)}</a>
      <span class="st vn-path">${esc(n.path)} · 수정 ${esc(new Date(n.mtime * 1000).toLocaleString('ko-KR', { hour12: false }))}${n.created ? ` · 생성 ${esc(n.created)}` : ''}</span>
      ${n.steps.length ? `<span class="vn-steps">${n.steps.map(x => `<button type="button" class="vn-step" data-vstep="${esc(JSON.stringify([d.server, x.project, x.path, x.no]))}" title="프로젝트 탭에서 이 스텝 열기"><i class="pj-sdot ${x.status}"></i>${esc(x.project)} · ${esc(x.no + '. ' + x.stage)} · ${esc(x.title)}</button>`).join('')}</span>` : ''}</li>`).join('')}</ul></details>`;
}

// The 프로젝트 tab, 프로젝트별, with the project folded open and the step's note in the split.
function openStep(server, name, path, no) {
  const k = `${server}:${name}`;
  pj.view = 'flow'; pjSave(); pjOpen = k; pjNote = { key: k, path }; pjScrollTo = no;
  location.hash = 'projects';
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

// ---------- coordinator detail: checkbox flow graph, its side panel and the worker table ----------
// Tasks named 「<ticket>#<checkbox> <role>」 (TASK_NAME) make one node per checkbox, and ticket-level tasks (착수 시트,
// 통합 리뷰 …) one node per role and predecessors, in one lane per ticket. Any other naming: one node per task in a single
// lane. Edges are task deps between different nodes. In a lane the nodes flow in dependency order and wrap with the
// width; arrows are drawn over the laid-out boxes. A lane's leading run of finished nodes folds into one 「완료 N」 node.
const FLOW_ROLE = ['구현', '리뷰 codex', '리뷰 claude', '판정'];
const FLOW_ST = { skip: '취소', fail: '실패', stalled: '응답 없음', wait: '입력 대기', run: '실행 중', blocked: '선행 대기', planned: '생성 대기', done: '완료' };
// A cancelled task (a reviewer the driver dropped) is 취소, not 실패: it does not hold the node back.
const flowItemSt = x => IX.tasks[x.id]?.status === 'cancelled' ? 'skip' : x.st === 'spawned' ? (x.live === 'stalled' ? 'stalled' : x.live === 'wait' ? 'wait' : 'run') : x.st;
const flowSel = {};  // coordinator path -> selected node key; survives live re-renders
function flowOf(wp) {
  const named = wp.items.every(x => TASK_NAME.test(x.name || ''));
  const nodes = new Map(), nodeOf = {}, byId = Object.fromEntries(wp.items.map(x => [x.id, x]));
  const depIds = x => { try { return JSON.parse(IX.tasks[x.id]?.deps || '[]').filter(d => byId[d]); } catch { return []; } };
  for (const x of wp.items) {
    const m = named && TASK_NAME.exec(x.name), role = m ? m[3].trim() : x.name;
    const base = role.replace(/\s+(codex|claude)$/, '');
    const key = !m ? x.id : m[2] ? `${m[1]}#${m[2]}` : `${m[1]} ${base} ${depIds(x).sort().join(',')}`;
    let n = nodes.get(key);
    if (!n) nodes.set(key, n = { key, lane: m ? m[1] : '태스크', label: !m ? x.name : m[2] ? '#' + m[2] : base, items: [], deps: new Set() });
    n.items.push({ ...x, role, ist: flowItemSt(x) });
    nodeOf[x.id] = n;
  }
  for (const x of wp.items) for (const d of depIds(x)) if (nodeOf[d] !== nodeOf[x.id]) nodeOf[x.id].deps.add(nodeOf[d].key);
  const lv = new Map(), level = k => { if (lv.has(k)) return lv.get(k); lv.set(k, 0); const v = Math.max(-1, ...[...nodes.get(k).deps].map(level)) + 1; lv.set(k, v); return v; };
  const ord = r => { const i = FLOW_ROLE.indexOf(r); return i < 0 ? FLOW_ROLE.length : i; };
  for (const n of nodes.values()) {
    // Dots in creation order (one round = 구현 · 리뷰 · 리뷰 · 판정); the state reads only each role's latest task, so a
    // failed round that a retry already passed does not keep the node red.
    n.items.sort((a, b) => (a.created || '\uffff').localeCompare(b.created || '\uffff') || ord(a.role) - ord(b.role));  // planned rows (no task yet) come last
    const latest = n.latest = Object.values(Object.fromEntries(n.items.map(i => [i.role, i])));
    const has = k => latest.some(i => i.ist === k);
    n.st = ['fail', 'stalled', 'wait', 'run'].find(has) || (latest.every(i => i.ist === 'done' || i.ist === 'skip') ? 'done' : has('blocked') ? 'blocked' : 'planned');
    n.level = level(n.key);
    n.created = n.items.map(i => i.created || '').filter(Boolean).sort()[0] || '';
  }
  const lanes = [];
  for (const n of [...nodes.values()].sort((a, b) => a.level - b.level || a.created.localeCompare(b.created))) {
    let l = lanes.find(y => y.key === n.lane);
    if (!l) lanes.push(l = { key: n.lane, nodes: [] });
    l.nodes.push(n);
  }
  lanes.sort((a, b) => a.nodes[0].created.localeCompare(b.nodes[0].created));
  return { nodes, lanes, named };
}
const ATTN = ['fail', 'stalled', 'wait'];
const flowDots = n => n.items.map(i => `<i class="${i.ist}" title="${esc(i.role)} · ${FLOW_ST[i.ist]}"></i>`).join('');
// What a node is doing now, in a few words: the first step that is not done, else how long the whole node took.
const flowNow = n => { const i = n.latest.find(x => x.ist !== 'done' && x.ist !== 'skip');
  if (!i) { const t0 = n.items.map(x => x.spawned).filter(Boolean).sort()[0], t1 = n.items.map(x => x.done).filter(Boolean).sort().pop(); return t0 && t1 ? '완료 · ' + dur(t0, t1) : '완료'; }
  return `${n.items.length > 1 ? i.role + ' ' : ''}${FLOW_ST[i.ist]}${i.spawned && !i.done ? ' · ' + dur(i.spawned) : ''}`; };
function flowBox(d, wp) {
  const f = flowOf(wp), id = 'flow:' + d.path, sel = f.nodes.get(flowSel[d.path]) ? flowSel[d.path] : null;
  const edges = [], vis = {};  // node key -> the key drawn for it (a folded node points at its fold box)
  const laneHtml = l => {
    const lid = id + ':' + l.key, attn = l.nodes.some(n => ATTN.includes(n.st)) || l.nodes.some(n => n.key === sel);
    // famMin[lid] = the lane is open (default: while not all done); attention or the picked node keeps it open.
    const allDone = l.nodes.every(n => n.st === 'done'), open = attn || (famMin[lid] ?? !allDone);
    let lead = 0;
    while (lead < l.nodes.length && l.nodes[lead].st === 'done' && l.nodes[lead].key !== sel) lead++;
    const fold = lead >= 2 && !famMin[lid + ':done'] ? lead : 0;  // famMin[...:done] = the user unfolded them
    const c = k => l.nodes.filter(n => n.st === k).length;
    const sum = `${l.nodes.length > 1 ? `완료 ${c('done')}/${l.nodes.length}` : FLOW_ST[l.nodes[0].st]}${c('run') ? ` · 실행 <b style="color:var(--run)">${c('run')}</b>` : ''}${l.nodes.filter(n => ATTN.includes(n.st)).length ? ` · 주의 <b style="color:var(--bad)">${l.nodes.filter(n => ATTN.includes(n.st)).length}</b>` : ''}`;
    const box = n => { vis[n.key] = n.key;
      return `<button class="fl-n ${n.st}${n.key === sel ? ' sel' : ''}" data-k="${esc(n.key)}" title="${esc(n.items.map(i => `${i.role} · ${FLOW_ST[i.ist]}`).join('\n'))}">
        <span class="fl-k">${esc(cutW(n.label, 22))}</span><span class="fl-dots">${flowDots(n)}</span><span class="fl-s">${esc(flowNow(n))}</span></button>`; };
    let body = '';
    if (open) {
      if (fold) { const fk = 'fold:' + l.key; l.nodes.slice(0, fold).forEach(n => (vis[n.key] = fk));
        body += `<button class="fl-n fl-fold done" data-k="${esc(fk)}" data-fold="${esc(lid + ':done')}" title="눌러서 펼치기">✓ 완료 ${fold}<span class="fl-s">${esc(l.nodes[0].label)} … ${esc(l.nodes[fold - 1].label)}</span></button>`; }
      body += l.nodes.slice(fold).map(box).join('');
      if (lead >= 2 && !fold) body += `<button class="act" data-fold="${esc(lid + ':done')}" data-unfold="1">완료 ${lead}개 접기</button>`;
    } else l.nodes.forEach(n => (vis[n.key] = 'lane:' + l.key));
    return `<div class="fl-lane${open ? ' open' : ''}"${open ? '' : ` data-k="${esc('lane:' + l.key)}"`}>
      ${f.named || f.lanes.length > 1 ? `<button class="fl-lh" data-flane="${esc(lid)}" data-open="${open ? 1 : 0}" aria-expanded="${open}"><span class="tk-arrow">${open ? '▾' : '▸'}</span><b>${esc(l.key)}</b><span>${sum}</span></button>` : ''}
      ${open ? `<div class="fl-ns">${body}</div>` : ''}</div>`;
  };
  const lanes = f.lanes.map(laneHtml).join('');
  for (const n of f.nodes.values()) for (const k of n.deps) { const a = vis[k], b = vis[n.key];
    if (a && b && a !== b && !edges.some(e => e.a === a && e.b === b)) edges.push({ a, b }); }
  const pick = sel && f.nodes.get(sel);
  const attn = [...f.nodes.values()].filter(n => ATTN.includes(n.st));
  const row = i => { const w = i.sess, name = `<span class="ic ${i.ist}">${WP_IC[i.st] || ''}</span>${esc(i.role)}`;
    return `<div class="fl-row">${w ? `<a href="#s=${encodeURIComponent(w.path)}">${name}</a>` : `<span>${name}</span>`}<span class="fl-rs">${FLOW_ST[i.ist]}${w ? ' · ' + esc(modelName(w.model)) : ''}${i.spawned ? ' · ' + (i.done ? dur(i.spawned, i.done) : dur(i.spawned) + '째') : ''}${w ? ' · ' + usd(agg(w).cost) : ''}</span></div>`; };
  const panel = pick ? `<div class="fl-ph"><b>${esc(pick.lane === '태스크' ? '' : pick.lane + ' ')}${esc(pick.label)}</b><span class="st">${FLOW_ST[pick.st]}</span><button class="act" data-fsel="">닫기</button></div>
      ${pick.items.map(row).join('')}${pick.deps.size ? `<div class="st fl-dep">선행: ${[...pick.deps].map(k => esc(f.nodes.get(k)?.lane === pick.lane ? f.nodes.get(k).label : k)).join(', ')}</div>` : ''}
      <div class="st fl-dep">아래 워커 표가 이 노드의 워커로 걸러집니다.</div>`
    : `<div class="fl-ph"><b>노드를 누르면 여기에 단계별 워커</b></div>${attn.length ? `<div class="st" style="margin:6px 0 4px">주의가 필요한 노드</div>${attn.map(n => `<button class="fl-n ${n.st} fl-mini" data-k="${esc(n.key)}"><span class="fl-k">${esc(n.lane === '태스크' ? '' : n.lane + ' ')}${esc(n.label)}</span><span class="fl-s">${esc(flowNow(n))}</span></button>`).join('')}` : '<div class="st" style="margin-top:6px">주의가 필요한 노드 없음</div>'}`;
  return `<div class="fl"><div class="fl-wrap"><div class="fl-lanes">${lanes}</div><svg class="fl-edges" data-edges="${esc(JSON.stringify(edges))}"></svg></div>
    <div class="fl-panel">${panel}</div></div>
    <div class="legend fl-leg">${['done', 'run', 'wait', 'stalled', 'fail', 'blocked', 'planned', 'skip'].map(k => `<span><i class="fl-sw ${k}"></i>${FLOW_ST[k]}</span>`).join('')}<span class="st">점 하나 = 태스크 하나, 만든 순서 (${f.named ? '구현 · 리뷰 codex · 리뷰 claude · 판정' : '태스크'}), 화살표 = deps</span></div>`;
}
let flRO = null;
function flowBind(d) {
  flRO?.disconnect();
  const wrap = $('#view .fl-wrap');
  if (!wrap) return;
  const svg = wrap.querySelector('.fl-edges'), edges = JSON.parse(svg.dataset.edges || '[]');
  const draw = () => {
    const o = wrap.getBoundingClientRect(), at = k => wrap.querySelector(`[data-k="${CSS.escape(k)}"]`);
    svg.setAttribute('width', wrap.scrollWidth); svg.setAttribute('height', wrap.scrollHeight);
    svg.innerHTML = `<defs><marker id="fl-arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z"/></marker></defs>`
      + edges.map(e => { const A = at(e.a), B = at(e.b); if (!A || !B) return '';
        const a = A.getBoundingClientRect(), b = B.getBoundingClientRect(), x = r => r.left - o.left, y = r => r.top - o.top;
        let p;
        if (Math.abs(a.top - b.top) < a.height / 2 && b.left >= a.right) {  // same row, left to right
          const x1 = x(a) + a.width, y1 = y(a) + a.height / 2, x2 = x(b) - 2, y2 = y(b) + b.height / 2, c = Math.max(8, (x2 - x1) / 2);
          p = `M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2} ${x2},${y2}`;
        } else {  // wrapped to a later row (or another lane): bottom to top
          const x1 = x(a) + a.width / 2, y1 = y(a) + a.height, x2 = x(b) + b.width / 2, y2 = y(b) - 2, c = Math.max(10, (y2 - y1) / 2);
          p = `M${x1},${y1} C${x1},${y1 + c} ${x2},${y2 - c} ${x2},${y2}`;
        }
        return `<path class="fl-e${e.a === flowSel[d.path] || e.b === flowSel[d.path] ? ' on' : ''}" d="${p}" marker-end="url(#fl-arr)"/>`; }).join('');
  };
  draw();
  flRO = new ResizeObserver(draw); flRO.observe(wrap);
  const rerender = () => { const sv = saveScroll(); renderSession(); restoreScroll(sv); };
  $('#view').querySelectorAll('.fl [data-k]:not([data-fold])').forEach(b => b.onclick = () => {
    const k = b.dataset.k; if (k.startsWith('lane:')) return;
    flowSel[d.path] = flowSel[d.path] === k ? null : k; rerender(); });
  $('#view').querySelectorAll('.fl [data-fold]').forEach(b => b.onclick = () => {
    famMin[b.dataset.fold] = !b.dataset.unfold;
    try { localStorage.setItem('adash.min', JSON.stringify(famMin)); } catch {}
    rerender(); });
  $('#view').querySelectorAll('.fl [data-flane]').forEach(b => b.onclick = () => {
    famMin[b.dataset.flane] = b.dataset.open !== '1';
    try { localStorage.setItem('adash.min', JSON.stringify(famMin)); } catch {}
    rerender(); });
  $('#view').querySelectorAll('.fl [data-fsel]').forEach(b => b.onclick = () => { flowSel[d.path] = null; rerender(); });
}

// The coordinator's workers as one row each. State filter (진행 중 · 주의 · 완료 · 전체) and a name search; a node picked
// in the flow graph narrows the table to that node's workers instead.
const wtab = { f: null, q: '' };
const WT_F = { open: ['진행 중', s => OPEN(status(s)) || s.decision], attn: ['주의', s => ['stalled', 'wait'].includes(status(s)) || s.decision], done: ['완료', s => ['done', 'idle'].includes(status(s))], all: ['전체', () => true] };
function workerTable(d, kids, wp) {
  const node = flowSel[d.path] && wp && flowOf(wp).nodes.get(flowSel[d.path]);
  // A picked node lists its own sessions: a driver script may have launched them, so they need not be direct workers.
  const only = node && [...new Map(node.items.filter(i => i.sess).map(i => [i.sess.path, i.sess])).values()];
  const fk = wtab.f || 'open';  // finished workers stay folded until asked for
  const q = wtab.q.trim().toLowerCase();
  const rows = (only || kids.filter(WT_F[fk][1])).filter(s => !q || nameOf(s).toLowerCase().includes(q));
  const tr = s => { const a = agg(s), st = status(s);
    return `<tr class="wt-r${ATTN.includes(st) || s.decision ? ' attn' : ''}"><td><a href="#s=${encodeURIComponent(s.path)}">${esc(nameOf(s))}</a>${s.decision ? ' <span class="badge dec">결정 대기</span>' : ''}</td><td>${pill(st, s)}</td><td>${modelChip(s.model)}</td>
      <td class="n">${s.started ? dur(s.started, OPEN(st) ? null : s.last_ts) : '–'}</td><td class="n">${fmt(a.turns)}</td><td class="n">${usd(a.cost)}</td></tr>`; };
  const ctl = only ? `<span class="chip" style="--c:var(--accent)">${esc(node.lane === '태스크' ? '' : node.lane + ' ')}${esc(node.label)} 의 워커 <i>${rows.length}</i></span><button class="act" data-fsel="">전체 보기</button>`
    : `<span class="seg" id="wt-f">${Object.entries(WT_F).map(([k, [l, fn]]) => `<button data-k="${k}" class="${k === fk ? 'on' : ''}">${l} ${kids.filter(fn).length}</button>`).join('')}</span>`;
  return `<div class="wt-h">${ctl}<input class="field" id="wt-q" type="search" placeholder="이름 검색" value="${esc(wtab.q)}" aria-label="워커 이름 검색"></div>
    ${rows.length ? `<div class="tscroll"><table class="wt-t"><tr><th>워커</th><th>상태</th><th>모델</th><th class="n">소요</th><th class="n">턴</th><th class="n">비용</th></tr>${byRank(rows, sessRank).map(tr).join('')}</table></div>` : `<div class="st" style="margin:8px 0">${fk === 'open' && !only && !q ? '진행 중인 워커가 없습니다. 끝난 워커는 「완료」에서 봅니다.' : '해당하는 워커가 없습니다.'}</div>`}`;
}
function workerTableBind(d) {
  const rerender = () => { const sv = saveScroll(); renderSession(); restoreScroll(sv); };
  $('#view').querySelectorAll('#wt-f button').forEach(b => b.onclick = () => { wtab.f = b.dataset.k; rerender(); });
  $('#view').querySelectorAll('.wt-h [data-fsel]').forEach(b => b.onclick = () => { flowSel[d.path] = null; rerender(); });
  const q = $('#wt-q');
  if (q) q.oninput = () => { wtab.q = q.value; const pos = q.selectionStart; rerender(); const n = $('#wt-q'); n.focus(); n.setSelectionRange(pos, pos); };
}

// Coordinator detail sections (오케스트레이션 · 이 세션 지표 · 로그): open state per session in adash.dsec. The
// orchestration section opens by itself while a worker needs attention.
let dsec = {};
try { dsec = JSON.parse(localStorage.getItem('adash.dsec') || '{}'); } catch {}
const secOpen = (d, k, dflt) => dsec[d.path]?.[k] ?? dflt;
function secSave(d, k, v) {
  (dsec[d.path] ||= {})[k] = v;
  try { localStorage.setItem('adash.dsec', JSON.stringify(dsec)); } catch {}
}
function coordEta(d) {
  const cl = coordLeft(d.own_handle, delegatedOf(d));
  return cl && !cl.done && cl.unknown < cl.open ? `남은 예상 ${cl.unknown ? '≥' : ''}${durHM(cl.left / 1000)} (완료 약 ${new Date(Date.now() + cl.left).toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit' })})` : '';
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

// ---------- manual idle (stored by the server, shared across devices) ----------
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
  // On a card the Orca buttons go to the bottom row (orcaBtns), so the state pill keeps its 「· n시간 전」.
  return `<span class="acts">${big ? orcaBtns(s, true) : ''}${idle}</span>`;
}
// 「Orca 에서 열기」 only where the server found the connected Orca terminal the agent runs in.
const focusBtn = (handle, big) => handle ? `<button class="${big ? 'act big' : 'act'} accent" data-act="focus" data-handle="${esc(handle)}" title="Orca 에서 이 터미널 탭으로 전환">Orca 에서 열기</button>` : '';
// 「Orca 에서 열기」 + 「닫기」 for a session (prompts go through the chat: the session page's box, a card's sheet). The
// session page's detail object comes from /api/session, which has no orca_focus; the snapshot row does. Closing a running agent is allowed; the confirm dialog warns about it.
// A terminal being closed (closing) shows no buttons from the click on, as once it is gone; a failed close puts them back.
function orcaBtns(s, big) {
  const focus = s.orca_focus ?? state.all?.find(x => x.path === s.path)?.orca_focus;
  if (!focus || closing.has(focus)) return '';
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
  if (a === 'idle') pref('idle', [p], { msg: `"${cut(name, 30)}" 유휴로 표시`, action: 'unidle' });
  else if (a === 'unidle') pref('unidle', [p]);
  else if (a === 'close') closeOrca(s, name, b.dataset.handle);
  else if (a === 'focus') api.focus(b.dataset.handle).then(r => toast(r.status === 200 ? 'Orca 에서 열었습니다' : r.body?.error || `Orca 전환 실패 (${r.status})`))
    .catch(() => toast('대시보드 서버에 보내지 못했습니다'));
}, true);

// 「닫기」: confirm, then close the session's Orca terminal. A coordinator also offers its tree (orca_close_tree, as the
// server mapped it: workers' terminals and the scripts it opened), checked by default; the server closes those first.
// On a phone the dialog drops the Orca/CLI detail (the terminal is not in reach there) and says only what happens.
const isLive = x => status(x) === 'run' || agg(x).live;
const PHONE = matchMedia('(max-width: 500px)');
const closing = new Set();

// In-page replacements for alert / confirm / prompt: Aside's browser (and some embedded webviews) block the native
// dialogs, so a confirm came back false and the action silently did nothing. One <dialog>, one question at a time.
let uiQueue = Promise.resolve();
function uiDialog(msg, { ok = '확인', cancel = '취소', input = null, danger = false } = {}) {
  const run = () => new Promise(res => {
    let d = $('#ui-dlg');
    if (!d) { d = document.createElement('dialog'); d.id = 'ui-dlg'; d.className = 'dialog'; document.body.appendChild(d); }
    d.innerHTML = `<form method="dialog"><p class="ui-msg">${esc(msg)}</p>
      ${input != null ? `<input class="field" name="v" value="${esc(input)}" style="width:100%">` : ''}
      <div class="dialog-btns">${cancel ? `<button class="act big" value="">${esc(cancel)}</button>` : ''}<button class="act big ${danger ? 'danger' : 'accent'}" value="ok">${esc(ok)}</button></div></form>`;
    const v = d.querySelector('[name=v]');
    d.onclose = () => res(d.returnValue === 'ok' ? (v ? v.value : true) : (v ? null : false));
    d.returnValue = '';
    d.showModal();
    (v || d.querySelector('button[value=ok]')).focus();
  });
  return (uiQueue = uiQueue.then(run, run));
}
const uiAlert = msg => uiDialog(msg, { cancel: '' });
const uiConfirm = (msg, opt) => uiDialog(msg, opt);
const uiPrompt = (msg, def = '') => uiDialog(msg, { input: def });
function closeOrca(s, name, handle) {
  const below = s?.orca_close_tree || [], all = state.all || state.sessions;
  const kids = all.filter(x => x.orca_focus && below.includes(x.orca_focus));
  const busy = kids.filter(isLive).length, scripts = below.length - kids.length;
  const warn = t => `<p class="dialog-warn">⚠ ${t}</p>`, phone = PHONE.matches;
  let d = $('#close-dlg');
  if (!d) { d = document.createElement('dialog'); d.id = 'close-dlg'; d.className = 'dialog'; document.body.appendChild(d); }
  d.innerHTML = phone ? `<form method="dialog">
    <h3>"${esc(cut(name, 24))}" 닫을까요?</h3>
    ${s && isLive(s) ? warn('실행 중인 작업이 바로 끊깁니다.') : ''}
    <p>에이전트가 종료됩니다. 기록은 남아 나중에 이어 갈 수 있어요.</p>
    ${below.length ? `<label class="cd-tree"><input type="checkbox" name="cascade" checked> 하위 ${below.length}개도 함께 닫기</label>
      ${busy ? warn(`하위 ${busy}개가 실행 중입니다.`) : ''}` : ''}
    <div class="dialog-btns"><button class="act big" value="">취소</button><button class="act big danger" value="ok">닫기</button></div></form>`
  : `<form method="dialog">
    <h3>"${esc(cut(name, 40))}" 의 Orca 터미널을 닫을까요?</h3>
    ${s && isLive(s) ? warn('지금 실행 중입니다. 진행 중인 응답·도구 실행이 그 자리에서 끊깁니다.') : ''}
    <p>에이전트 프로세스가 끝납니다. 세션 기록은 남아 claude --resume 으로 이어 갈 수 있습니다.</p>
    ${below.length ? `<label class="cd-tree"><input type="checkbox" name="cascade" checked> 하위 터미널 ${below.length}개도 함께 닫기
      <span class="st">(${[kids.length && `워커 ${kids.length}`, scripts && `스크립트 ${scripts}`].filter(Boolean).join(' · ')}, 하위부터 닫음)</span></label>
      ${busy ? warn(`하위 워커 ${busy}개가 실행 중입니다.`) : ''}` : ''}
    <div class="dialog-btns"><button class="act big" value="">취소</button><button class="act big danger" value="ok">닫기</button></div></form>`;
  d.onclose = () => {
    if (d.returnValue !== 'ok') return;
    const cascade = !!d.querySelector('[name=cascade]')?.checked, hs = [handle, ...(cascade ? below : [])];
    hs.forEach(h => closing.add(h));
    render();
    const fail = msg => { hs.forEach(h => closing.delete(h)); render(); toast(msg); };
    api.close(handle, cascade).then(r => {
      if (r.status !== 202) return fail(r.body?.error || `닫기 실패 (${r.status})`);
      followClose(r.body.job, name, hs, fail);
    }).catch(() => fail('대시보드 서버에 보내지 못했습니다'));
  };
  d.returnValue = '';
  d.showModal();
}

// The server closes terminals in the background (each takes seconds; a busy Orca can take half a minute). The buttons
// are already gone, so a clean close says nothing; a failure puts back the terminals still open and says why.
async function followClose(job, name, hs, fail) {
  const who = `"${cut(name, 30)}"`, t0 = Date.now();
  let j = null;
  while (Date.now() - t0 < 10 * 60e3) {
    await new Promise(r => setTimeout(r, 1500));
    try { j = await api.closeJob(job); } catch { continue; }
    if (!j) return fail(`${who} 닫기 결과를 찾을 수 없습니다 (대시보드 서버가 재시작됨)`);
    if (j.state === 'done') break;
  }
  if (j?.state !== 'done') return fail(`${who} 닫기가 10분 넘게 끝나지 않았습니다`);
  const self = j.failed.find(f => f.handle === j.handle), below = j.failed.filter(f => f.handle !== j.handle);
  // Refresh first so the closed terminals' buttons do not flash back from a snapshot that still lists them.
  await refresh().catch(() => {});
  hs.filter(h => !j.failed.some(f => f.handle === h)).forEach(h => closing.delete(h));
  if (!j.failed.length) return render();
  fail(self ? `${who} 닫기 실패: ${self.error}${below.length ? ` · 하위 ${below.length}개도 실패` : ''}`
    : `${who} 하위 ${below.length}개 닫기 실패: ${below[0].error}`);
}

const mcpName = n => n.replace(/^claude_ai_/, '').replace(/^plugin_([^_]+)_.*/, '$1').replace(/_/g, ' ');
const chipRow = (label, counts, color, nm = x => x) => {
  const e = Object.entries(counts || {}).sort((a, b) => b[1] - a[1]);
  return `<div class="chips"><b>${label}</b>${e.length ? e.map(([n, c]) => `<span class="chip" style="--c:var(${color})">${esc(nm(n))} <i>${c}</i></span>`).join('') : '<span class="st">없음</span>'}</div>`;
};

// A worker made for a box the driver added after start: what added it and why (same as its 외부 워커 계획 row).
const addedHtml = s => { const x = s.role === 'worker' && (s.task_ids || [s.task_id]).map(id => IX.addedBy[id]).find(Boolean);
  if (!x) return '';
  const why = xpReason(x) || '기록 없음';
  return `<div class="c-top c-added" title="추가 사유: ${esc(why)}"><span class="badge">추가: ${esc(XP_FIX[x.fix_source] || x.fix_source)}${xpRound(x) ? ` ${xpRound(x)}차` : ''}</span><span class="xp-why">사유: ${esc(why)}</span></div>`; };
function card(s, cls) {
  const a = agg(s), win = s.ctx_window, pct = win ? Math.min(100, s.ctx_now / win * 100) : 0;
  const own = status(s), st = subBg(s, a, own), la = s.last_action;
  const t = s.role === 'worker' ? IX.tasks[s.task_id] : null;
  const role = s.role === 'coordinator' ? '<span class="badge coord">코디네이터</span>' : isSubCoord(s) ? '<span class="badge subcoord">하위 코디네이터</span>' : s.role === 'worker' ? `<span class="badge worker"${s.viaScript ? ` title="${esc(s.viaScript)} 스크립트가 띄운 워커"` : ''}>워커${s.viaScript ? ' · 스크립트' : ''}</span>` : '';
  const dq = s.decision?.questions?.[0]?.question;
  return `<div class="card ${cls || ''} st-${st}${s.decision ? ' dec' : ''}" data-path="${esc(s.path)}">
    <div class="c-top"><span class="c-title" title="${esc(nameOf(s))}">${esc(nameOf(s))}</span>${s.decision ? '<span class="badge dec" title="카드를 열면 답할 수 있습니다">결정 대기</span>' : ''}${role}</div>
    <div class="c-top">${pill(st, s)}${actBtns(s)}</div>
    ${dq ? `<div class="now dq" title="${esc(dq)}"><b>질문</b> ${esc(dq)}</div>` : `<div class="now" title="${esc(la?.text || '')}">${la ? `<b>${st === 'run' ? '지금' : '마지막'}</b>${esc(NOW_ROLE[la.role] || '')} · ${esc(la.text)}` : ''}</div>`}
    <div class="c-top">${modelChip(s.model)}<span class="badge">${s.kind}</span>${srvBadge(s)}${t ? `<span class="badge" style="color:${STATUS_COLOR(t.status)};border-color:currentColor">태스크 ${esc(t.status)}</span>` : ''}</div>
    ${addedHtml(s)}
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

// wk: in 「워크트리별」, the worktree being drawn. Workers and sub-trees running elsewhere then show as small stand-ins
// at the end of the tree (their cards are in their own worktree).
function famHtml(f, wk) {
  const run = f.runs[0], here = x => !wk || wtKey(x) === wk;
  const head = f.coord ? card(f.coord, 'coord') : `<div class="card coord" style="cursor:default"><div class="c-top"><span class="c-title">${esc(ownerName(f.handle))}</span><span class="badge coord">코디네이터</span></div><div class="st">${ownerNote(f.handle)} · ${esc(f.handle || '')}</div></div>`;
  const direct = [...f.workers, ...f.subs.map(x => x.coord).filter(Boolean)];
  const done = direct.filter(w => IX.tasks[w.task_id]?.status === 'completed').length;
  const all = f.members.filter(m => m !== f.coord);
  return `<div class="family ${f.depth ? 'nested' : ''} st-${f.st} ${f.live ? 'live' : ''}">${f.depth ? `<div class="nest-label">${f.viaTerm ? `스크립트 위임 · ${esc(f.viaTerm)} 터미널이 Run 을 맡음` : '하위 오케스트레이션'} · 깊이 ${f.depth + 1}</div>` : ''}${head}
    <div class="fam-sum"><span>직속 워커 <b>${f.workers.length}</b></span>${f.subs.length ? `<span>하위 코디네이터 <b>${f.subs.length}</b></span>` : ''}<span>완료 <b>${done}/${direct.length}</b></span>
      <span>실행 중 <b style="color:var(--ok)">${all.filter(w => status(w) === 'run').length}</b></span>${all.some(w => status(w) === 'bg') ? `<span>백그라운드 <b>${all.filter(w => status(w) === 'bg').length}</b></span>` : ''}<span>입력 대기 <b>${all.filter(w => status(w) === 'wait').length}</b></span>${all.some(w => status(w) === 'stalled') ? `<span>응답 없음 <b style="color:var(--bad)">${all.filter(w => status(w) === 'stalled').length}</b></span>` : ''}
      <span>${f.subs.length ? '하위 포함 ' : ''}합계 비용 <b>${usd(f.cost)}${f.costKnown ? '' : '+'}</b></span><span>합계 턴 <b>${fmt(f.turns)}</b></span><span>합계 토큰 <b>${fmt(f.tok)}</b></span>
      ${run ? `<span>Run <a href="#r=${run.id}" style="color:var(--accent)">${esc(cut(run.objective, 60))}</a>${f.runs.length > 1 ? ` 외 ${f.runs.length - 1}` : ''}</span>` : ''}
      ${wk && direct.some(x => !here(x)) ? `<span title="이 코디네이터가 다른 워크트리에서 돌리는 직속 워커·하위 코디네이터">다른 워크트리 <b>${direct.filter(x => !here(x)).length}</b></span>` : ''}
      ${f.coord ? `<button class="tgl" data-toggle="${esc(f.key)}" style="margin-left:auto">▾ 최소화</button>` : ''}</div>
    ${(() => { const wp = workerPlan(f.handle, f.extra); return wp ? wpBar(wp, planExtra(f.coord)) : ''; })()}
    ${f.coord ? plansOf(f.coord).map(p => `<div class="pline" style="padding:2px 2px 0">${drvPlanLine(driverPlan(p))}</div>${ticketStrip(driverPlan(p))}`).join('') : ''}
    ${f.workers.length || f.subs.length ? `<div class="tree">${(() => {
      // Workers that belong to a group come first: sub-coordinator trees, then script drivers, then the coordinator's own
      // workers. Each group by state (attention → idle), folded sub-trees after expanded ones; an expanded sub-tree is a
      // full-width block, folded ones share a grid.
      const drv = new Set((f.drivers || []).map(d => d.handle));
      const subs = byRank(f.subs.filter(liveFam), x => famRank(x) + (shut(x) ? 20 : 0)), own = byRank(f.workers.filter(w => !drv.has(w.viaHandle) && liveSess(w)), sessRank);
      let out = '', cells = [];
      const flush = () => { if (cells.length) out += `<div class="grid">${cells.join('')}</div>`; cells = []; };
      const away = [];
      for (const x of subs) {
        if (!here(x.coord)) away.push(x.coord);
        else if (!shut(x)) { flush(); out += famHtml(x, wk); }
        else cells.push(miniFam(x));
      }
      flush();
      out += driversHtml(f, wk);
      for (const w of own) if (!here(w)) away.push(w); else cells.push(card(w));
      flush();
      if (away.length) out += `<div class="grid wt-away-grid">${away.map(wtProxy).join('')}</div>`;
      return out;
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
    // A box added after start gets an 「추가」 mark; its source, round and reason go in the tooltip.
    const x = IX.addedBy[t.id], add = x && `추가: ${XP_FIX[x.fix_source] || x.fix_source}${xpRound(x) ? ` ${xpRound(x)}차` : ''}\n사유: ${xpReason(x) || '기록 없음'}`;
    const lbl = `<i>${TK_IC[st] || '·'}</i>${x ? '<small class="tk-add">추가</small>' : ''}${esc(role)}`, tip = `${esc(taskName(t))} · ${esc(t.plan_row ? '계획: ' + planRowLabel(t.plan_row) : t.status)}${w ? ' · ' + esc(modelName(w.model)) : ''}${add ? '\n' + esc(add) : ''}`;
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
const XP_KIND = { sheet: '착수 시트', impl: '구현', 'review-codex': '리뷰 codex', 'review-claude': '리뷰 claude', judge: '판정', driver: '드라이버', extra: '추가 태스크',
  'contract-check': '실서버 대조', 'integration-review': '통합 리뷰', 'pr-review': 'PR 리뷰', 'completion-review': '구현 완료 리뷰', audit: '감사' };
// Per-session tags: how an impl's verify box is checked, why a box was added after start (and which round of the check
// added it), a review's round, whose server a contract check reads. The server fills reason_auto / round_auto from the
// ticket state and launch sheet when the driver does not write fix_reason / round itself.
const XP_SCENE = { storybook: '스토리북', 'real-screen': '실화면' }, XP_FIX = { 'integration-review': '통합 리뷰 지적', scene: '화면 불일치' };
const xpRound = x => x.round ?? x.round_auto, xpReason = x => x.fix_reason || x.reason_auto;
const xpTags = x => [x.verify_scene && `<span class="badge" title="verify 확인 방식">verify ${esc(XP_SCENE[x.verify_scene] || x.verify_scene)}</span>`,
  x.fix_source && `<span class="badge" title="착수 뒤 검증이 더한 체크박스">수정: ${esc(XP_FIX[x.fix_source] || x.fix_source)}${xpRound(x) ? ` ${xpRound(x)}차` : ''}</span>`,
  !x.fix_source && xpRound(x) && `<span class="badge" title="리뷰 차수">${xpRound(x)}차</span>`,
  x.producer && `<span class="badge" title="대조할 생산자 티켓">생산자 ${esc(x.producer)}</span>`,
  x.fix_source && `<span class="xp-why" title="추가 사유">사유: ${esc(xpReason(x) || '기록 없음')}</span>`].filter(Boolean).join('');
// Worktrees the driver will make (ticket.worktree, filled before start) and its auxiliary ones (plan.extra_worktrees).
const XP_WT = { planned: ['pending', '생성 예정'], created: ['done', '생성됨'], removed: ['blocked', '제거됨'], undecided: ['blocked', '미정'] };
const wtChip = st => { const [cls, lbl] = XP_WT[st] || ['pending', st || '상태 미상']; return `<span class="tkc ${cls}"><i>${TK_IC[cls] || '·'}</i>${esc(lbl)}</span>`; };
function tkWtHtml(k) {
  const w = k.worktree;
  if (!w) return '';
  const tr = w.trigger || {}, pre = tr.predecessors || [];
  const trig = [tr.chain_previous ? `체인 앞 ${tr.chain_previous}` : '체인 첫 워크트리', pre.length ? `선행 ${pre.join('·')} 검증` : ''].filter(Boolean).join(' · ');
  return `<div class="cbr xp xp-wt" title="${esc([tr.rule, w.path, w.orca_worktree_id].filter(Boolean).join('\n'))}"><span class="xp-kind">워크트리</span>${wtChip(w.status)}<b>${esc(w.branch || '')}</b>
    <span class="xp-deps">← ${esc(w.base_ref || '')} · 트리거: ${esc(trig)}${w.path ? ' · ' + esc(w.path) : ''}</span></div>`;
}
const XP_XWT = { 'e2e-sibling-link': 'E2E 형제 링크', 'ta-verify-branch': 'TA 검증 브랜치', 'contract-check-stack': '대조 스택', 'scene-stack': '화면 스택' };
function xwtHtml(p) {
  const xs = p.extra_worktrees || [];
  if (!xs.length) return '';
  const id = 'xwt:' + p.path, open = famMin[id] ?? false;
  const detail = x => [x.target && '대상 ' + x.target, x.links && Object.entries(x.links).map(([r, pk]) => `${r}→${pk}`).join(', '),
    x.compose_project, x.ports && Object.entries(x.ports).map(([n, v]) => `${n} ${v}`).join(' '),
    x.repo && x.repo + (x.base_ref ? ' ← ' + x.base_ref : ' (베이스 미정)'), x.path].filter(Boolean).join(' · ');
  const rows = xs.map(x => `<div class="cbr xp xp-wt" title="${esc([x.purpose, x.note].filter(Boolean).join('\n'))}"><span class="xp-kind">${esc(XP_XWT[x.kind] || x.kind)}</span><span class="xp-key">${esc(x.owner || '')}</span>${wtChip(x.status)}
    <span class="xp-deps">${esc(x.purpose || '')}${detail(x) ? ' · ' + esc(detail(x)) : ''}</span></div>`).join('');
  const c = st => xs.filter(x => x.status === st).length;
  return `<div class="xp-repo ${open ? 'open' : ''}"><div class="xp-repo-h" data-rtoggle="${esc(id)}" data-open="${open ? 1 : 0}"><span class="tk-arrow">${open ? '▾' : '▸'}</span><b>보조 워크트리</b><span>${xs.length}개 · 생성 예정 ${c('planned')} · 생성됨 ${c('created')}${c('undecided') ? ` · <span class="xp-why hold">미정 ${c('undecided')}</span>` : ''}</span></div>
    ${open ? `<div class="tks">${rows}</div>` : ''}</div>`;
}
// One repository's worktree chain in creation order (chain_position), created ones in bold.
const wtChain = items => { const ks = items.map(t => t.k).filter(k => k.worktree).sort((a, b) => (a.chain_position ?? 0) - (b.chain_position ?? 0));
  return ks.length ? ` · 워크트리 체인 ${ks.map(k => k.worktree.status === 'created' ? `<b>${esc(k.package)}</b>` : esc(k.package)).join(' → ')}` : ''; };
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
function driversHtml(f, wk) {
  // In 「워크트리별」 (wk), a driver whose ticket runs in another worktree is drawn there; here it leaves a stand-in.
  const moved = wk ? famDrivers(f).filter(d => { const k = drvWtKey(d, f); return k && k !== wk; }) : [];
  const gone = new Set(moved.map(d => d.handle)), shown = moved.filter(liveDrv);
  const away = shown.length ? `<div class="grid wt-away-grid">${shown.map(d => drvProxy(d, f)).join('')}</div>` : '';
  const real = (f.drivers || []).filter(d => !gone.has(d.handle)).sort((a, b) => drvRank(a) - drvRank(b));
  const plans = f.coord ? plansOf(f.coord) : [], dh = d => driverHtml(d, wk);
  if (filtering()) return cellsJoin(real.filter(liveDrv).map(dh)) + away;  // no scheduler, placeholders or finished drivers
  if (!plans.length) return cellsJoin(real.map(dh)) + away;
  const parts = [], later = [], finished = [];  // drivers not created yet come after live ones; finished drivers go last
  const placed = new Set(gone);
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
        if (d) { (fin ? finished : parts).push(dh({ ...d, drove })); continue; }
      }
      if (h) {  // terminal exists but no worker session has started under it yet
        (p.tickets.filter(o => o.driver_terminal_handle === h).every(tkDone) ? finished : parts).push(dh({ handle: h, title: termOwner(h).title || x.k.driver_terminal || h, workers: [], runs: IX.runsByCoord[h] || [], drove: [x.k.package] }));
        continue;
      }
      if (x.st === 'done') continue;
      later.push(`<div class="drv xp-pdrv"><div class="drv-h"><b>⚙ ${esc(pdrvName(x.k))}</b>${x.k.jira ? `<span class="tk-key">${esc(x.k.jira)}</span>` : ''}<span>${esc(x.k.repo)} ${x.pos}/${x.len}</span>${x.why ? `<span class="xp-why ${x.why.k}">${esc(x.why.t)}</span>` : ''}<span>세션 예정 ${x.planned}</span></div></div>`);
    }
  }
  const rest = real.filter(d => !placed.has(d.handle)), over = d => !drvBusy(d) && d.workers.length && d.workers.every(w => status(w) === 'done');
  return cellsJoin([...parts, ...rest.filter(d => !over(d)).map(dh), ...later, ...finished, ...rest.filter(over).map(dh)]) + away;
}
// Every script driver of a family with the plan tickets it drove, including a ticket's driver terminal no worker session
// has started under yet (driversHtml draws that one from the plan alone).
function famDrivers(f) {
  const plans = f.coord ? plansOf(f.coord) : [], drove = h => plans.flatMap(p => p.tickets.filter(k => k.driver_terminal_handle === h).map(k => k.package));
  const out = (f.drivers || []).map(d => ({ ...d, drove: drove(d.handle) }));
  for (const p of plans) for (const k of p.tickets) {
    const h = k.driver_terminal_handle;
    if (h && !out.some(d => d.handle === h)) out.push({ handle: h, title: termOwner(h).title || k.driver_terminal || h, workers: [], runs: IX.runsByCoord[h] || [], drove: drove(h) });
  }
  return out.map(d => d.drove.length ? d : { ...d, drove: undefined });
}
// A script driver's worktree: that of the plan ticket it is driving (its first unverified one, else its last), else the one
// its Orca terminal runs in. Ticket drivers used to open as panes of one tab in the plan's own worktree, so the plan wins.
function drvPlace(h) {
  const at = path => state.sessions.find(s => s.place?.path === path)?.place;
  for (const p of state.ext_plans || []) {
    const ks = (p.tickets || []).filter(k => k.driver_terminal_handle === h && k.worktree?.path);
    if (!ks.length) continue;
    const k = ks.find(o => !tkDone(o)) || ks[ks.length - 1], w = k.worktree;
    return at(w.path) || { project: w.repo || k.repo, worktree: w.path.split('/').pop(), branch: w.branch, path: w.path };
  }
  const wp = termOwner(h).t?.worktreePath;
  return wp ? at(wp) || { project: wp.split('/').slice(-2)[0], worktree: wp.split('/').pop(), branch: null, path: wp } : null;
}
// Its worktree key (wtKey for a session); with no known place it stays with the family's coordinator.
const drvWtKey = (d, f) => { const p = drvPlace(d.handle), c = f.coord || f.members[0]; return p ? (multiSrv() ? (c?.server || '') + '|' : '') + placeKey(p) : c && wtKey(c); };
const drvSt = d => ['stalled', 'wait', 'run', 'bg'].find(k => d.workers.some(w => status(w) === k)) || (drvBusy(d) ? 'run' : d.workers.length && d.workers.every(w => status(w) === 'done') ? 'done' : 'idle');
// Stand-in for a driver drawn in its ticket's worktree; it scrolls to that section.
function drvProxy(d, f) {
  const p = drvPlace(d.handle);
  return `<a class="wt-proxy wt-px-drv" href="#" data-wtgo="${esc(drvWtKey(d, f))}" title="${esc(placeLabel(p))} 구획으로 이동"><span class="badge subcoord">스크립트 드라이버</span><b class="wt-px-nm">⚙ ${esc(d.title)}</b>${d.drove ? `<span>맡은 티켓 <b>${d.drove.map(esc).join('·')}</b></span>` : ''}<ds-pill state="${drvSt(d)}">${ST_LABEL[drvSt(d)]}</ds-pill><span class="wt-px-wt">▣ ${esc(wtShort(p))}</span><span class="wt-px-go">구획으로 이동 ↗</span></a>`;
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
const e2eRunsAll = () => { const m = memo(); if (m.e2eRuns) return m.e2eRuns; const seen = new Set(), out = m.e2eRuns = [];
  for (const p of state.ext_plans || []) for (const k of p.tickets || []) {
    if (!k.e2e || seen.has(k.e2e_progress)) continue; seen.add(k.e2e_progress);
    for (const [id, r] of Object.entries(k.e2e.active || {})) out.push({ id, r, k });
  }
  return out; };
// Match order: terminal (ORCA_TERMINAL_HANDLE = the session's own_handle, or the Orca pane it runs in) → session_id (CLAUDE_CODE_SESSION_ID; codex
// workers may lack it) → caller name → 「미지정 (cwd …)」 with exactly one running worker in that worktree.
const e2eSessOf = r => { const m = memo().sessOf; if (!m.has(r)) m.set(r, e2eSessFind(r)); return m.get(r); };
const e2eSessFind = r => {
  const top = memo().top ||= state.sessions.filter(s => !s.parent), newest = a => a.sort((x, y) => (y.last_ts || '').localeCompare(x.last_ts || ''))[0] || null;
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
// Per snapshot: session -> its active runs, and session -> its last finished run.
function e2eBySess() {
  const m = memo();
  if (m.e2eBy) return m.e2eBy;
  const runs = new Map(), last = new Map(), at = h => h.finished_at || h.started_at || '';
  for (const x of e2eRunsAll()) { const s = e2eSessOf(x.r); if (s) (runs.get(s) || runs.set(s, []).get(s)).push(x); }
  for (const p of state.ext_plans || []) for (const k of p.tickets || []) for (const h of k.e2e?.history || []) {
    const s = e2eSessOf(h);
    if (s && (!last.has(s) || at(h).localeCompare(at(last.get(s))) > 0)) last.set(s, h);
  }
  return (m.e2eBy = { runs, last });
}
function e2eCardHtml(s) {
  const by = e2eBySess(), runs = by.runs.get(s) || [];
  if (!runs.length) {  // not running now: the session's last finished run, if any
    const last = by.last.get(s);
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
    return `<div class="cbr xp ${r.drv ? 'xp-drv' : ''}" title="${esc(r.x.title || '')}"><span class="xp-kind">${esc(XP_KIND[r.x.kind] || r.x.kind)}</span><span class="xp-key">${esc(r.x.key)}</span>${xpTags(r.x)}
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
        ${tkWtHtml(k)}${e2eHtml(k)}
        ${open ? `<div class="tk-body">${rows.map(line).join('')}</div>` : ''}</div>`;
    };
    // A repository folds as a whole; it starts open while any of its tickets is not verified yet.
    const body = byRepo(tickets, t => t.k.repo).map(g => {
      const id = 'repo:' + p.path + ':' + g.repo, open = famMin[id] ?? g.items.some(t => !tkDone(t.k));
      return `<div class="xp-repo ${open ? 'open' : ''}"><div class="xp-repo-h" data-rtoggle="${esc(id)}" data-open="${open ? 1 : 0}"><span class="tk-arrow">${open ? '▾' : '▸'}</span><b>${esc(g.repo)}</b><span>${repoLine(g.items.map(t => t.x))}${wtChain(g.items)}</span></div>
        ${open ? `<div class="tks">${g.items.map(ticketHtml).join('')}</div>` : ''}</div>`;
    }).join('');
    const sub = `티켓 ${tickets.length} · ${cnt(all)}${p.generated_at ? ` · 계획 갱신 ${esc(ago(p.generated_at))}` : ''}${p.design_commit ? ` · <span title="${esc(p.design_root || '')}">설계 ${esc(p.design_commit.slice(0, 7))}</span>` : ''}`;
    const sched = p.scheduler_terminal ? `<div class="drv-h" title="${esc(p.scheduler_terminal)}"><b>⚙ ${esc(termOwner(p.scheduler_terminal).title || 'scheduler')}</b><span class="badge">스케줄러(스크립트)</span><span>${termNote(p.scheduler_terminal)}</span><span>아래 티켓 드라이버를 순서대로 띄움</span></div>` : '';
    const title = `${esc(p.project || '')} 워커 계획 (${p.driver ? esc(p.driver) + ' ' : ''}드라이버 사전 계획)`;
    return inSession ? `<div class="box"><h3>${title} <span class="st">${sub}</span></h3><div class="pline" style="margin:-4px 0 8px">${drvPlanLine(dp)}</div>${ticketGraph(p)}${sched}<div class="tks">${body}${xwtHtml(p)}</div></div>`
      : `<div class="sec-h"><h2>${title}</h2><span>${sub}</span></div>${p.owner_problem ? `<div class="pline"><span class="tstale" title="${esc(p.path || '')}">⚠ 코디네이터 밑에 묶지 못함 — ${esc(p.owner_problem)}</span></div>` : ''}${sched}<div class="tks">${body}${xwtHtml(p)}</div>`;
  }).join('');
}

// Ticket dependency graph of a driver plan (coordinator detail). An HTML grid, so it follows the width: columns are
// dependency stages (longest chain of predecessors), rows are repositories; arrows are drawn over it from the laid-out
// boxes (and redrawn when it resizes). Edges: a ticket's predecessors and its repo chain's previous ticket, minus any
// implied by a longer path. Each box carries its checkbox progress and each stage how many of its tickets are done.
// Narrow: stages stack as rows and each box names its predecessors instead of arrows.
// Hover lights a ticket's whole upstream and downstream; a click opens its row in the plan below.
function ticketGraph(p) {
  const dp = driverPlan(p), by = new Map(dp.list.map(x => [x.k.package, x]));
  if (by.size < 2) return '';
  const chainOf = x => x.k.worktree?.trigger?.chain_previous;
  const preds = n => { const x = by.get(n); return [...new Set([...(x.k.predecessors || []), chainOf(x)])].filter(m => m && m !== n && by.has(m)); };
  const lv = new Map(), level = n => { if (lv.has(n)) return lv.get(n); lv.set(n, 0); const v = Math.max(-1, ...preds(n).map(level)) + 1; lv.set(n, v); return v; };
  by.forEach((x, n) => level(n));
  // Is there a path a ⇝ b other than the direct edge a → b?
  const longer = (a, b) => { const st = [b], seen = new Set();
    while (st.length) { const n = st.pop(); for (const m of preds(n)) { if (n === b && m === a) continue; if (m === a) return true; if (!seen.has(m)) { seen.add(m); st.push(m); } } }
    return false; };
  const edges = [];
  by.forEach((x, n) => preds(n).forEach(m => { const chain = chainOf(x) === m; if (chain || !longer(m, n)) edges.push({ a: m, b: n, chain }); }));
  const cols = Math.max(...lv.values()) + 1, stages = [...Array(cols)].map((_, c) => [...by.values()].filter(x => lv.get(x.k.package) === c));
  // Grid rows: 1 = stage headers, then one band per repository (taller when two of its tickets share a stage).
  let row = 2;
  const lanes = byRepo(dp.list).map(g => { const used = {}, cells = g.items.map(x => { const c = lv.get(x.k.package); return { x, c, r: used[c] = (used[c] ?? -1) + 1 }; });
    const l = { repo: g.repo, row, rows: Math.max(...cells.map(o => o.r)) + 1, cells }; row += l.rows; return l; });
  const sum = (xs, f) => xs.reduce((a, x) => a + (x.k[f] ?? 0), 0), all = [...by.values()];
  const head = stages.map((xs, c) => { const d = xs.filter(x => x.st === 'done').length, run = xs.some(x => x.st === 'run');
    return `<div class="tg-st ${d === xs.length ? 'done' : run ? 'run' : ''}" style="grid-column:${c + 2};--o:${c * 2}">${c + 1}단계 <b>${d}/${xs.length}</b></div>`; }).join('');
  const box = ({ x, c, r }, l) => { const n = x.k.package, k = x.k, [cls, lbl] = TKP[x.st === 'wait' ? x.why.k : x.st], bt = k.boxes_total ?? 0, bd = k.boxes_done ?? 0;
    const tip = `${n}${k.jira ? ' · ' + k.jira : ''} · ${x.st === 'wait' ? x.why.t : XP_TICKET[k.status] || lbl} · 체크박스 ${bd}/${bt}\n선행: ${preds(n).join(', ') || '없음'}`;
    return `<div class="tg-n ${cls}" style="grid-column:${c + 2};grid-row:${l.row + r};--o:${c * 2 + 1}" data-n="${esc(n)}" data-id="${esc('ext:' + p.path + ':' + n)}" data-repo="${esc('repo:' + p.path + ':' + l.repo)}" title="${esc(tip)}">
      <div class="tg-k"><i>${TK_IC[cls] || '·'}</i>${esc(n)}<span>${bd}/${bt}</span></div><div class="tg-bar"><i style="width:${bt ? Math.round(bd / bt * 100) : x.st === 'done' ? 100 : 0}%"></i></div>
      <div class="tg-s">${esc(k.jira || '')} · ${esc(x.st === 'wait' ? TKP[x.why.k][1] : lbl)}</div>${ticketDesignBadge(p, n)}${preds(n).length ? `<div class="tg-p">← ${preds(n).map(esc).join(', ')}</div>` : ''}</div>`; };
  const c = k => all.filter(x => x.st === k).length;
  return `<div class="tg-box"><div class="tg-leg"><b>티켓 의존 그래프</b><span>완료 <b>${c('done')}/${all.length}</b> · 실행 <b style="color:var(--run)">${c('run')}</b> · 대기 ${c('wait')} · 체크박스 ${sum(all, 'boxes_done')}/${sum(all, 'boxes_total')}</span>
      <span><i class="tg-l chain"></i>같은 저장소 체인</span><span><i class="tg-l pred"></i>다른 티켓 선행</span><span class="st">간접 선행은 생략 · 올리면 앞뒤 의존 강조, 누르면 아래 행으로</span></div>
    <div class="tg-wrap"><div class="tg-grid" style="--cols:${cols}">${head}
      ${lanes.map((l, i) => `<div class="tg-lane ${i % 2 ? 'odd' : ''}" style="grid-row:${l.row} / span ${l.rows}"></div><div class="tg-repo" style="grid-row:${l.row} / span ${l.rows}">${esc(l.repo)}</div>${l.cells.map(o => box(o, l)).join('')}`).join('')}</div>
      <svg class="tg-edges" data-edges="${esc(JSON.stringify(edges))}"></svg></div></div>`;
}
let tgRO = null, tgHover = null;  // the hovered ticket survives a live re-render
function ticketGraphBind() {
  tgRO?.disconnect();
  $('#view').querySelectorAll('.tg-wrap').forEach(wrap => {
    const svg = wrap.querySelector('.tg-edges'), grid = wrap.querySelector('.tg-grid'), edges = JSON.parse(svg.dataset.edges || '[]');
    const ns = [...grid.querySelectorAll('.tg-n')], at = new Map(ns.map(g => [g.dataset.n, g]));
    const walk = (n, from, to, s = new Set()) => { edges.forEach(e => { if (e[from] === n && !s.has(e[to])) { s.add(e[to]); walk(e[to], from, to, s); } }); return s; };
    const light = n => { const on = new Set([n, ...walk(n, 'b', 'a'), ...walk(n, 'a', 'b')]);
        wrap.classList.add('hl'); ns.forEach(x => x.classList.toggle('on', on.has(x.dataset.n)));
        svg.querySelectorAll('.tg-e').forEach(e => e.classList.toggle('on', on.has(e.dataset.a) && on.has(e.dataset.b))); };
    const draw = () => {
      const o = grid.getBoundingClientRect(), W = grid.scrollWidth, H = grid.scrollHeight;
      svg.setAttribute('width', W); svg.setAttribute('height', H);
      // Stacked (narrow) layout: boxes list their predecessors, no arrows.
      if (getComputedStyle(grid).display !== 'grid') return (svg.innerHTML = '');
      const pt = (g, side) => { const r = g.getBoundingClientRect(); return [(side ? r.left : r.right) - o.left, r.top - o.top + r.height / 2]; };
      svg.innerHTML = `<defs><marker id="tg-arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z"/></marker></defs>`
        + edges.filter(e => at.has(e.a) && at.has(e.b)).map(e => { const [x1, y1] = pt(at.get(e.a), 0), [x2, y2] = pt(at.get(e.b), 1), c = Math.max(16, (x2 - x1) / 2);
          return `<path class="tg-e ${e.chain ? 'chain' : 'pred'}" data-a="${esc(e.a)}" data-b="${esc(e.b)}" d="M${x1},${y1} C${x1 + c},${y1} ${x2 - 3 - c},${y2} ${x2 - 3},${y2}" marker-end="url(#tg-arr)"/>`; }).join('');
      if (tgHover && at.has(tgHover)) light(tgHover);
    };
    draw();
    tgRO ||= new ResizeObserver(es => es.forEach(e => e.target._tgDraw?.()));
    grid._tgDraw = draw; tgRO.observe(grid);
    ns.forEach(g => {
      g.onmouseenter = () => light(tgHover = g.dataset.n);
      g.onmouseleave = () => { tgHover = null; wrap.classList.remove('hl'); };
      g.onclick = () => {
        tgHover = null;
        famMin[g.dataset.id] = true; famMin[g.dataset.repo] = true;
        try { localStorage.setItem('adash.min', JSON.stringify(famMin)); } catch {}
        renderSession();
        $('#view').querySelector(`[data-ttoggle="${CSS.escape(g.dataset.id)}"]`)?.scrollIntoView({ block: 'center' });
      };
    });
  });
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
// An open driver is a tile: TILE + column span + '-->' + html. Consecutive tiles share one wrapping row (.drv-tiles), so
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
  // Open drivers (TILE) and folded ones (CELL) share one wrapping tile row: open tiles first in their order, then the folded cards
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
// wk (「워크트리별」): its checkbox plan (ticketsHtml) sits right under the worktree header instead of inside the block.
function driverHtml(d, wk) {
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
      if (filtering()) return (wk ? '' : ticketsHtml(d, true)) + `<div class="grid">${ws.filter(liveSess).map(w => card(w)).join('')}</div>`;
      const act = ws.filter(w => !['done', 'idle'].includes(status(w)));
      const tk = wk ? '' : ticketsHtml(d), hasTk = wk ? !!ticketsOf(d) : !!tk;
      const showFin = !!famMin['drvfin:' + d.handle], fin = ws.filter(w => ['done', 'idle'].includes(status(w)));
      // Ticket progress always sits above the worker cards, with or without 「실행 중만」.
      return tk + (act.length ? `<div class="grid">${act.map(w => card(w)).join('')}</div>` : '<div class="st" style="margin-top:6px">이 드라이버에서 진행 중인 워커 없음</div>')
        + (hasTk ? '' : (fin.length ? `<button class="tgl fin-tgl" data-ftoggle="${esc(d.handle)}">${showFin ? '▾' : '▸'} 완료·유휴 워커 ${fin.length}</button>${showFin ? `<div class="grid">${fin.map(w => card(w)).join('')}</div>` : ''}` : ''));
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
    v.querySelectorAll('[data-wtoggle]').forEach(b => set('wt:' + b.dataset.wtoggle, !open));  // 「워크트리별」 sections
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
  const m = memo();
  if (m.tests) return m.tests;
  const T = state.tests || {}, out = m.tests = [];
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
  // Minimised coordinators sink below every expanded one.
  const items = [...fv.map(f => ({ started: f.started, f, r: famRank(f), o: 0, m: +shut(f) })), ...sv.map(s => ({ started: s.started || '', s, r: sessRank(s), o: 1, m: 0 }))]
    .sort((a, b) => a.m - b.m || a.r - b.r || a.o - b.o || b.started.localeCompare(a.started));
  const nc = fv.reduce((a, f) => a + count(f, 'c'), 0), nw = fv.reduce((a, f) => a + count(f, 'w'), 0);
  const title = srv ? `${srvTitle(srv)}<span>에이전트 ${nc + nw + sv.length}</span>` : `<h2>에이전트 ${nc + nw + sv.length}</h2>`;
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
const srvTitle = srv => { const [cls, st] = srvState(srv); return `<h2>${esc(srv.name)}</h2><span class="sp-msg ${cls}" title="${esc(srv.url)}">${esc(st)}</span>`; };
// ---------- 워크트리: a QA set's tickets with their worktrees, reviewed ticket by ticket in VS Code ----------
// Each server joins its QA sets' Jira children, Orca worktrees, vault step notes and test runs (/api/reviews). A review
// is recorded in the step note's frontmatter; the server moves its shas along with the worktrees' HEADs (rebases), and it
// reads 「재오픈」 once the driver starts a later round than the one the review saw. Opening VS Code
// goes to the set's server and works only when that server is this device's loopback (set.local); elsewhere (a phone,
// another machine) the button is not drawn.
let wtData = { at: undefined, sets: [], jira: '' }, wtMounted = false, wtBodyHtml = '';
// f: review / Jira filter, q: search, qa: QA driver stage ('' all, a stage key, or 'blocked') — the home 「QA 파이프라인」 sets it.
const wtf = (() => { try { return { f: 'all', q: '', qa: '', ...JSON.parse(localStorage.getItem('adash.wt') || '{}') }; } catch { return { f: 'all', q: '', qa: '' }; } })();
const wtQaHit = t => !wtf.qa || (wtf.qa === 'blocked' ? !!t.qa?.blocked : t.qa?.stage === wtf.qa);
// The tab's three filters together; the home 「QA 파이프라인」 counts and lists only the tickets they let through.
const wtHit = t => { const q = wtf.q.trim().toLowerCase();
  return (wtf.f === 'all' || t.review === wtf.f || 'j:' + jiraStage(t) === wtf.f) && wtQaHit(t)
    && (!q || [t.key, t.summary, ...t.repos.map(r => r.branch)].some(x => x && x.toLowerCase().includes(q))); };
// The filters in force, named for the home widget's note ([] when none).
const wtFilterNames = () => [wtf.f !== 'all' && (WT_FILTERS[wtf.f] || WT_JIRA[wtf.f.slice(2)]),
  wtf.qa && (wtf.qa === 'blocked' ? 'QA 막힘' : 'QA ' + qaName(wtf.qa)), wtf.q.trim() && `「${wtf.q.trim()}」`].filter(Boolean);
const WT_REVIEW = { changed: ['fail', '리뷰 후 변경'], reopened: ['fail', '재오픈 후 리뷰 대기'], pending: ['wait', '리뷰 대기'], done: ['done', '리뷰 완료'], none: ['pending', '워크트리 없음'] };
const WT_ORDER = ['changed', 'reopened', 'pending', 'done', 'none'];
const WT_FILTERS = { all: '전체', reopened: '재오픈', pending: '리뷰 대기', done: '리뷰 완료', none: '워크트리 없음' };
// Jira status → stage. 보류(Holding), 개발 완료 and QA 준비 완료 share Jira's 'indeterminate' category with 진행 중, so they
// go by name; an unknown name falls back to its category.
const WT_JIRA = { todo: '시작 전', prog: '진행 중', hold: '보류', dev: '개발 완료', ready: 'QA 준비 완료', qa: 'QA 완료' };
const jiraStage = t => {
  const n = (t.status || '').replace(/\s/g, '');
  return /hold|홀딩|보류/i.test(n) ? 'hold' : /QA준비/.test(n) ? 'ready' : /개발완료/.test(n) ? 'dev' : /QA완료/.test(n) || t.cat === 'done' ? 'qa' : t.cat === 'new' ? 'todo' : 'prog';
};
const obsLink = p => 'obsidian://open?path=' + encodeURIComponent(p);
const BASE_SRC = { PR: 'PR 의 base', 설정: 'prefs.json review_bases', 기본: '설정 없음 → main' };
function wtTest(x) {
  if (!x) return '';
  const live = x.phase !== 'done' && x.phase !== 'failed', bad = x.phase === 'failed' || x.failed > 0 || /[1-9]\d* failures?/.test(x.detail || '');
  const cls = live ? 'run' : bad ? 'fail' : 'done';
  return `<span class="tkc ${cls}" title="${esc([x.label, x.detail].filter(Boolean).join(' · '))}"><i>${TK_IC[cls]}</i>${esc((x.kind || '테스트').toUpperCase())} ${live ? '실행 중' : bad ? '실패' : '통과'} · ${ago(x.finished_at || x.updated_at || x.started_at)}</span>`;
}
// 「PR 후 머지」: the server hands a 진행 중 ticket to a supervised Orca worker (Task title "<key> 반출").
const WT_SHIP = { launching: ['run', '반출 시작 중'], pending: ['run', '반출 대기'], dispatched: ['run', '반출 중'], blocked: ['wait', '반출 막힘'],
  completed: ['done', '반출 완료'], failed: ['fail', '반출 실패'], cancelled: ['pending', '반출 취소'], launch_failed: ['fail', '반출 시작 실패'] };
const shipOpen = t => t.ship && !['completed', 'failed', 'cancelled', 'launch_failed'].includes(t.ship.status);
function wtShip(t) {
  if (!t.ship) return '';
  const [cls, lbl] = WT_SHIP[t.ship.status] || ['pending', '반출 ' + t.ship.status];
  const tip = [t.ship.error, t.ship.task_id && `태스크 ${t.ship.task_id}`, t.ship.at && hhmm(t.ship.at)].filter(Boolean).join(' · ');
  return `<span class="tkc ${cls}" title="${esc(tip)}"><i>${TK_IC[cls] || '·'}</i>${lbl}</span>`;
}
// QA driver progress: the stage track of a ticket (exports/state-contract.md of qa-ticket-driver), the set's automations.
const QA_ST = { selected: '선별', worktree: '워크트리', analysis: '분석', implementing: '구현', reviewing: '검토', committed: '커밋 완료',
  approved: '반출 승인', delivered: '반출', cleaned: '정리' };
// What each stage means, and who moves the ticket on to the next one (user: the driver waits for a person).
const QA_DESC = {
  selected: ['드라이버가 QA 에픽에서 이 티켓을 처리 대상으로 골랐다 (신규·재오픈)', '드라이버가 워크트리를 만든다'],
  worktree: ['이 티켓 전용 Orca 워크트리를 만들었다', '드라이버가 코디네이터를 띄운다'],
  analysis: ['코디네이터가 원인을 코드로 짚어 기록하는 중', '코디네이터가 저장소별 워커에게 구현을 넘긴다'],
  implementing: ['저장소별 워커가 구현하는 중', '워커가 모두 끝내면 검토로 넘어간다'],
  reviewing: ['워커가 모두 끝냈고 코디네이터가 결과를 검토하는 중', '검토를 통과하면 커밋한다'],
  committed: ['검토를 통과해 커밋까지 끝났다 — 반출 승인을 기다린다', '사용자가 반출을 승인한다', true],
  approved: ['사용자가 반출을 승인했다', '코디네이터가 PR 을 올려 넘긴다'],
  delivered: ['PR 을 올려 넘겼다', '사용자가 머지를 지시하면 코디네이터가 머지하고, 머지되면 드라이버가 정리한다', true],
  cleaned: ['워크트리와 브랜치를 정리했다 — 끝', ''],
};
// The worktree review tab's track stops at 반출: 정리 removes the worktree, so the tab never has a ticket to show in it.
const WT_QA = Object.keys(QA_ST).filter(k => k !== 'cleaned');
const qaTip = (k, i, at) => `${i + 1}. ${QA_ST[k]} — ${QA_DESC[k][0]}${at ? '\n들어간 시각 ' + clockAt(at) : ''}`;
function qaLegend() {
  const open = (() => { try { return localStorage.getItem('adash.qalegend') === '1'; } catch { return false; } })();
  return `<details class="qa-legend"${open ? ' open' : ''}><summary>QA 드라이버 ${WT_QA.length}단계란?</summary><ol>${WT_QA.map(k =>
    `<li><b>${QA_ST[k]}</b> — ${esc(QA_DESC[k][0])}${QA_DESC[k][1] ? `<span class="st"> → 다음: ${esc(QA_DESC[k][1])}</span>` : ''}</li>`).join('')}</ol>
    <div class="st">막힘: 그 단계에서 멈춰 사람의 판단을 기다린다 (빨간 번호, 사유는 마우스). N회차: 재오픈으로 다시 기동한 횟수. 제외: 드라이버가 처리하지 않는 티켓.</div></details>`;
}
function qaTrack(q) {
  if (!q) return '';
  // A cleaned ticket went through every stage the track shows.
  const keys = WT_QA, cur = q.stage === 'cleaned' ? keys.length : keys.indexOf(q.stage);
  let [, next, user] = QA_DESC[q.stage] || [];
  if (q.stage === 'delivered' && q.merge_at) [next, user] = ['코디네이터가 머지하고, 머지되면 드라이버가 정리한다', false];
  const nodes = keys.map((k, i) => `<span class="qa-step${i < cur ? ' done' : i === cur ? (q.blocked ? ' bad' : ' cur') : ''}" title="${esc(qaTip(k, i, q.at?.[k]))}"><i class="qa-n">${i + 1}</i><small>${QA_ST[k]}</small></span>`).join('<b></b>');
  const nextTxt = q.blocked ? '막힘 — 사람이 판단해야 다음으로 간다' : next ? '다음: ' + next : '';
  return `<div class="qa-track"><span class="qa-steps">${nodes}</span><span class="qa-lbl">${Math.min(cur + 1, keys.length)}/${keys.length} ${QA_ST[q.stage]}${q.driver && q.handoffs ? ` · 워커 ${q.done}/${q.handoffs}` : ''}${nextTxt ? `<span class="qa-next${user && !q.blocked ? ' user' : ''}">${esc(nextTxt)}</span>` : ''}</span>
    ${q.round > 1 ? `<span class="rv-flag warn" title="재오픈으로 다시 기동">${q.round}회차</span>` : ''}
    ${q.blocked ? `<span class="rv-flag bad" title="${esc(q.blocked_reason || '')}">막힘${q.blocked_reason ? ' · ' + esc(cut(q.blocked_reason, 40)) : ''}</span>` : ''}
    ${q.ignored ? '<span class="rv-flag">제외</span>' : ''}
    ${q.prs.map((u, i) => `<a href="${esc(u)}" target="_blank" rel="noopener">PR ${i + 1}</a>`).join(' ')}</div>`;
}
const clockAt = ts => { if (!ts) return ''; const d = new Date(ts); return isNaN(d) ? String(ts) : d.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }); };
// Coordinator and workers: the session whose Orca terminal is that handle, else the bare handle (terminal closed).
function qaAgents(q) {
  if (!q) return '';
  const chip = (h, lbl) => { const s = h && state.all?.find(x => x.orca_focus === h);
    return s ? `<a class="tkc ${OPEN(status(s)) ? 'run' : 'pending'}" href="#s=${encodeURIComponent(s.path)}" title="${esc(nameOf(s))}"><i>${OPEN(status(s)) ? '●' : '○'}</i>${lbl}</a>`
      : h ? `<span class="tkc pending" title="터미널이 닫혔거나 세션을 찾지 못함 (${esc(h)})"><i>○</i>${lbl}</span>` : ''; };
  return chip(q.coordinator, '코디네이터') + (q.workers || []).map(w => chip(w.handle, '워커 ' + w.name)).join('');
}
function qaAutoHtml(s) {
  const autos = s.automations || [];
  const RUN = { completed: ['done', '실행'], skipped_precheck: ['pending', '건너뜀'], failed: ['fail', '실패'], running: ['run', '실행 중'] };
  const box = autos.map(a => `<div class="qa-auto">
      <span class="tkc ${a.enabled ? 'run' : 'pending'}"><i>${a.enabled ? '●' : '○'}</i>${a.enabled ? '켜짐' : '꺼짐'}</span>
      <b>${esc(a.name || a.id)}</b><span class="st">${esc(a.rrule || '')}${a.next && a.enabled ? ' · 다음 ' + esc(clockAt(a.next)) : ''}${a.last ? ' · 마지막 ' + esc(clockAt(a.last)) : ''}</span>
      <span class="qa-runs">${(a.runs || []).slice(0, 8).map(r => { const [c, l] = RUN[r.status] || ['pending', r.status]; return `<i class="qa-run ${c}" title="${esc(l)} · ${esc(clockAt(r.at))}${r.error ? ' · ' + esc(r.error) : ''}"></i>`; }).join('')}</span>
      <span class="rv-acts"><button class="act big" data-qa-auto="${a.enabled ? 'disable' : 'enable'}" data-id="${esc(a.id)}" data-epic="${esc(s.epic)}" data-srv="${esc(s.server)}">${a.enabled ? '끄기' : '켜기'}</button>
        <button class="act big" data-qa-auto="run" data-id="${esc(a.id)}" data-epic="${esc(s.epic)}" data-srv="${esc(s.server)}" title="스케줄을 기다리지 않고 한 회차 실행 (precheck 가 할 일이 없으면 건너뜀)">지금 실행</button></span>
    </div>`).join('');
  const qs = s.tickets.map(t => t.qa).filter(Boolean);
  const counts = WT_QA.map(k => [k, qs.filter(q => q.stage === k).length]).filter(([, n]) => n);
  const sum = qs.length ? `<div class="rv-jsum">진행 ${WT_QA.length}단계 ${counts.map(([k, n]) => `<span class="rv-js">${QA_ST[k]} ${n}</span>`).join('')}${qs.some(q => q.blocked) ? `<span class="rv-js j-todo">막힘 ${qs.filter(q => q.blocked).length}</span>` : ''}</div>` : '';
  return (qs.length ? qaLegend() : '') + (autos.length ? `<div class="qa-autos">${box}</div>` : s.watch ? '<div class="st" style="margin-bottom:6px">이 묶음의 에픽을 부르는 Orca 자동화가 없습니다.</div>' : '') + sum;
}
// 「QA 통계」 of a set, all from /api/reviews: a summary, rounds started and finished per day, and the change size.
function qaStatsHtml(s) {
  const T = s.tickets, n = T.length;
  if (!n) return '';
  const open = (() => { try { return localStorage.getItem('adash.qastats') === '1'; } catch { return false; } })();
  const qs = T.map(t => t.qa).filter(Boolean), fin = T.filter(t => jiraStage(t) === 'qa').length, pct = Math.round(fin / n * 100);
  const re = qs.filter(q => q.round > 1).length, rounds = qs.reduce((a, q) => a + (q.round || 0), 0);
  const tile = (v, l, tip, extra = '') => `<div class="qs-tile"${tip ? ` title="${esc(tip)}"` : ''}><b>${v}</b><span>${l}</span>${extra}</div>`;
  const tiles = [
    tile(`${fin}/${n}`, `QA 완료 ${pct}%`, 'Jira 가 QA 완료인 티켓 / 에픽의 하위 티켓', `<i class="qs-bar"><i style="width:${pct}%"></i></i>`),
    qs.length ? tile(re, `재오픈 티켓 ${Math.round(re / qs.length * 100)}%`, '2회차 이상 기동한 티켓 / 드라이버가 잡은 티켓') : '',
    qs.length ? tile((rounds / qs.length).toFixed(1), '평균 회차', `드라이버가 잡은 티켓의 회차 합 ${rounds}`) : '',
    tile(`${qs.length}/${n}`, '드라이버 기동', '드라이버가 한 번이라도 잡은 티켓'),
    qs.length ? tile(qs.filter(q => q.blocked).length, '막힘') : ''].join('');
  // Rounds started (1회차 = 신규, later = 재오픈) and tickets committed, per local day over the last 14 days.
  const now = new Date(), days = [];
  for (let i = 13; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i); days.push({ d, k: dayKey(d.toISOString()), neu: [], re: [], fin: [] }); }
  const byDay = Object.fromEntries(days.map(x => [x.k, x]));
  for (const t of T) {
    const q = t.qa; if (!q) continue;
    (q.rounds || []).forEach((r, i) => byDay[dayKey(r)]?.[i ? 're' : 'neu'].push(t.key));
    const f = q.at?.committed;
    if (f) byDay[dayKey(f)]?.fin.push(t.key);
  }
  while (days.length > 7 && !days[0].neu.length && !days[0].re.length && !days[0].fin.length) days.shift();
  const tot = k => days.reduce((a, x) => a + x[k].length, 0);
  const max = Math.max(1, ...days.map(x => Math.max(x.neu.length + x.re.length, x.fin.length)));
  const seg = (v, c) => v ? `<i style="height:${v / max * 100}%;background:${c}"></i>` : '';
  const lbl = v => v ? `<em>${v}</em>` : '';
  const WD = '일월화수목금토';
  const cols = days.map((x, i) => `<div class="qs-day" data-qs="${i}"><div class="qs-bars"><span class="qs-b">${lbl(x.neu.length + x.re.length)}${seg(x.re.length, 'var(--c2)')}${seg(x.neu.length, 'var(--c1)')}</span><span class="qs-b">${lbl(x.fin.length)}${seg(x.fin.length, 'var(--c3)')}</span></div><small>${x.d.getMonth() + 1}/${x.d.getDate()}</small></div>`).join('');
  qaStatsDays[s.epic + '|' + s.server] = days.map(x => `<b>${x.d.getMonth() + 1}/${x.d.getDate()} (${WD[x.d.getDay()]})</b>`
    + [['neu', '신규 기동', 'var(--c1)'], ['re', '재오픈 기동', 'var(--c2)'], ['fin', '커밋 완료', 'var(--c3)']].map(([k, l, c]) =>
      `<br><i class="sw" style="background:${c}"></i>${l} <b>${x[k].length}</b>${x[k].length ? ' · ' + esc(x[k].join(', ')) : ''}`).join(''));
  const leg = [['var(--c1)', '신규 기동', tot('neu')], ['var(--c2)', '재오픈 기동', tot('re')], ['var(--c3)', '커밋 완료', tot('fin')]]
    .map(([c, l, v]) => `<span><i style="background:${c}"></i>${l} <b>${v}</b></span>`).join('');
  // Change size: worktrees still on disk only (cleaned tickets drop out), summed per repo.
  const rp = {}, prs = new Set();
  let wt = 0;
  for (const t of T) {
    if (t.repos.length) wt++;
    for (const r of t.repos) {
      const a = rp[r.repo] ||= { t: 0, files: 0, ins: 0, dels: 0 };
      a.t++; a.files += r.files || 0; a.ins += r.ins || 0; a.dels += r.dels || 0;
      if (r.pr?.url) prs.add(r.pr.url);
    }
    (t.qa?.prs || []).forEach(u => prs.add(u));
  }
  const rows = Object.entries(rp).sort((a, b) => b[1].ins + b[1].dels - a[1].ins - a[1].dels);
  const sum = rows.reduce((a, [, x]) => ({ t: a.t + x.t, files: a.files + x.files, ins: a.ins + x.ins, dels: a.dels + x.dels }), { t: 0, files: 0, ins: 0, dels: 0 });
  const tr = (name, x, cls = '') => `<tr${cls}><td>${name}</td><td>${x.t}</td><td>${x.files}</td><td class="ins">+${x.ins}</td><td class="dels">−${x.dels}</td></tr>`;
  const code = rows.length ? `<table class="qs-tbl"><thead><tr><th>저장소</th><th>티켓</th><th>파일</th><th>추가</th><th>삭제</th></tr></thead><tbody>${rows.map(([k, x]) => tr(esc(k), x)).join('')}${rows.length > 1 ? tr('합계', sum, ' class="tot"') : ''}</tbody></table>`
    : '<div class="st">워크트리가 남은 티켓이 없습니다.</div>';
  return `<details class="qa-legend qa-stats" data-set="${esc(s.epic + '|' + s.server)}"${open ? ' open' : ''}><summary>QA 통계</summary>
    <div class="qs-tiles">${tiles}</div>
    ${qs.length ? `<div class="qs-h">일별 추이 <span class="st">최근 ${days.length}일 · 왼쪽 막대 = 기동한 회차, 오른쪽 = 커밋 완료</span></div>
    <div class="qs-chart">${cols}</div><div class="qs-leg">${leg}</div>` : ''}
    <div class="qs-h">코드 변경 규모 <span class="st">워크트리가 남은 티켓 ${wt}개 · PR ${prs.size}개 · 베이스 대비</span></div>${code}
    <div class="st">완료는 티켓의 마지막 회차 시각만 남아 앞 회차의 완료는 세지 않습니다. 정리된 티켓의 코드 변경은 빠집니다.</div></details>`;
}
const qaStatsDays = {};
// The set's watcher itself: an older watcher (not qa-driver) can hand its automation to qa-driver; coordinators of
// tickets that are past 진행 중 can be closed together; once every ticket is QA 완료 the QA can be ended (retire).
const qaFinished = (t, set) => { const q = t.qa; if (!q?.live?.length || !['dev', 'ready', 'qa'].includes(jiraStage(t)) && !['delivered', 'cleaned'].includes(q.stage)) return false;
  return !q.live.some(h => { const s = state.all?.find(x => x.orca_focus === h); return s && OPEN(status(s)); }); };
function qaLegacyHtml(s) {
  if (!s.watch) return '';
  const d = `data-epic="${esc(s.epic)}" data-srv="${esc(s.server)}"`;
  if (s.retired) return `<div class="qa-legacy end"><span class="tkc done"><i>✓</i>QA 종료됨</span><span class="st">자동화를 끄고 공용 코디네이션 워크트리를 지웠습니다. 상태 디렉터리는 남아 있습니다.</span></div>`;
  const fin = s.tickets.filter(t => qaFinished(t, s)), live = s.tickets.reduce((n, t) => n + (t.qa?.live?.length || 0), 0);
  const old = !s.adopted && (s.automations || []).length;
  const parts = [
    old ? `<span class="rv-flag warn" title="이 묶음의 자동화가 qa-driver 가 아닌 옛 워처를 부릅니다">옛 워처</span>` : '',
    s.coord_worktree ? `<span class="st" title="${esc(s.coord_worktree)}">공용 코디네이션 워크트리 ${esc(s.coord_worktree.split('/').pop())}</span>` : '',
    `<span class="st">열린 에이전트 터미널 ${live}</span>`,
    `<span class="rv-acts">${fin.length ? `<button class="act big" data-qa-set="close_finished" data-keys="${esc(fin.map(t => t.key).join(','))}" ${d} title="${esc(fin.map(t => t.key).join(', '))}\nJira 가 개발 완료 이후이거나 반출이 끝났고, 터미널의 세션이 쉬고 있는 티켓">끝난 코디네이터 닫기 (${fin.length})</button>` : ''}
      ${old ? `<button class="act big" data-qa-set="adopt_check" ${d} title="자동화의 precheck·prompt 를 qa-driver 로 바꿉니다. 남은 티켓부터 새 흐름(티켓마다 워크트리·코디네이터)으로 처리합니다">드라이버로 이관</button>` : ''}
      ${s.finished ? `<button class="act big accent" data-qa-set="retire_check" ${d} title="자동화를 끄고, 공용 코디네이션 워크트리의 터미널을 닫고 워크트리를 지웁니다">QA 종료 처리</button>` : ''}</span>`];
  return `<div class="qa-legacy${s.finished ? ' end' : ''}">${s.finished ? '<b>모든 티켓이 QA 완료입니다.</b>' : ''}${parts.join('')}</div>`;
}
function qaMore(t, set) {
  const q = t.qa; if (!q) return '';
  const d = `data-key="${esc(t.key)}" data-epic="${esc(set.epic)}" data-srv="${esc(set.server)}"`, live = q.live?.length;
  const items = [
    !live && !q.ignored && !['delivered', 'cleaned'].includes(q.stage) ? `<button class="act big" data-qa-tk="restart" ${d} title="기록된 브리프로 코디네이터를 새 터미널에 다시 띄웁니다">코디네이터 재기동</button>` : ''].join('');
  return items ? `<details class="qa-more"><summary class="act big" title="코디네이터 제어">⋯</summary><div>${items}</div></details>` : '';
}
function wtRepo(t, r) {
  const rs = t.review_sha[r.repo], moved = t.review !== 'pending' && rs && r.head && !r.head.startsWith(rs);
  const pr = r.pr ? ` <a href="${esc(r.pr.url)}" target="_blank" rel="noopener" title="PR ${esc(r.pr.state || '')}">#${r.pr.number}</a>` : '';
  const diff = r.ahead != null ? `<span><b>+${r.ahead}</b> 커밋 · <b>${r.files}</b> 파일 <span class="rv-ins">+${r.ins}</span> <span class="rv-del">−${r.dels}</span></span>` : '<span class="st">비교 불가 (베이스 없음)</span>';
  return `<div class="rv-repo">
    <span class="rv-rn" title="${esc(r.path)}">${esc(r.repo)}</span>
    <span class="st" title="${esc(r.name || '')}${r.comment ? ' · ' + esc(r.comment) : ''}">${esc(cut(r.branch, 44))}</span>
    <span class="st" title="베이스: ${esc(BASE_SRC[r.base_src] || r.base_src)}${r.base_ref ? '' : ' · 로컬에 브랜치 없음'}">vs ${esc(r.base_ref || r.base)}${pr}</span>
    ${diff}${r.behind ? `<span class="st" title="베이스에 있고 이 브랜치에 없는 커밋">뒤처짐 ${r.behind}</span>` : ''}
    ${r.dirty ? `<span class="rv-flag warn" title="커밋하지 않은 변경 (git status)">미커밋 ${r.dirty}</span>` : ''}
    ${moved ? `<span class="rv-flag bad" title="리뷰 때 ${esc(rs)} → 지금 ${esc(r.head.slice(0, 9))}">리뷰 후 변경</span>` : ''}
  </div>`;
}
// A ticket's action buttons, by its stage — the 워크트리 tab's rows and the home 「QA 파이프라인」 both use them; clicks go
// through wtClick.
function wtActs(t, set) {
  // On a driver ticket the coordinator has finished reviewing (ready/ written), a review is also the push·PR approval.
  // Before that (stage under committed) the coordinator is still changing the worktree, so a review cannot be recorded yet.
  const ship = set.driver && t.qa?.stage === 'committed';
  const early = set.driver && t.qa && t.qa.stage_no < set.stages.indexOf('committed') + 1 && t.review !== 'done';
  const markLbl = ship ? '리뷰 완료 · 반출 승인' : t.review === 'done' ? '리뷰 취소' : t.review === 'changed' || t.review === 'reopened' ? '다시 리뷰 완료' : '리뷰 완료';
  return t.repos.length ? `<span class="rv-acts">
        ${set.driver && t.qa?.stage === 'delivered' && !t.qa.merge_at ? `<button class="act big accent" data-qa-tk="merge" data-key="${esc(t.key)}" data-epic="${esc(set.epic)}" data-srv="${esc(set.server)}" title="코디네이터에게 올린 PR 을 의존 저장소부터 머지하라고 지시합니다 (merge 파일을 남김)">PR 머지</button>` : ''}
        ${set.driver && t.qa?.stage === 'delivered' && t.qa.merge_at ? `<button class="act big" disabled title="${esc(clockAt(t.qa.merge_at))} 에 지시. PR 이 모두 머지되면 드라이버 회차가 정리합니다">머지 지시됨</button>` : ''}
        ${t.qa && ['delivered', 'committed', 'approved'].includes(t.qa.stage) ? `<button class="act big" data-qa-tk="cleanup_check" data-key="${esc(t.key)}" data-epic="${esc(set.epic)}" data-srv="${esc(set.server)}" title="서브모듈 deinit 뒤 워크트리를 지웁니다. 미커밋·미푸시가 있으면 멈춥니다">워크트리 정리</button>` : ''}
        ${qaMore(t, set)}
        ${!set.driver && jiraStage(t) === 'prog' ? `<button class="act big" data-wt-ship="${esc(t.key)}" data-srv="${esc(set.server)}"${shipOpen(t) ? ' disabled title="반출 워커가 이미 돌고 있습니다"' : ' title="Orca 워커가 저장소마다 PR → 머지 → Jira 개발 완료 → 스텝 노트 기록 → 워크트리 정리까지 합니다"'}>PR 후 머지</button>` : ''}
        ${set.local ? `<button class="act big" data-wt-web="${esc(t.key)}" data-srv="${esc(set.server)}" aria-expanded="${wtWeb.has(t.key)}" title="이 티켓 아래에 웹 VS Code(읽기 전용)를 펼칩니다. 데스크톱 창은 펼친 곳에서 엽니다">${wtWeb.has(t.key) ? 'VS Code 접기' : 'VS Code 로 보기'}</button>` : ''}
        <button class="act big accent" data-wt-mark="${esc(t.key)}" data-srv="${esc(set.server)}" data-done="${t.review === 'done' && !ship ? 0 : 1}"${ship ? ' data-ship="1"' : ''}${!t.step ? ' disabled title="볼트에 스텝 노트가 없어 기록할 곳이 없습니다"' : early ? ' disabled title="코디네이터가 검토를 끝내고 커밋(ready/)하기 전이라 아직 리뷰할 수 없습니다"' : ship ? ' title="리뷰를 기록하고 코디네이터에게 push·PR 을 승인한다고 알립니다 (approved 파일을 남김)"' : ''}>${markLbl}</button></span>` : t.qa ? `<span class="rv-acts">${qaMore(t, set)}</span>` : '';
}
function wtTicket(t, set) {
  const [cls, lbl] = WT_REVIEW[t.review];
  const live = state.sessions.filter(s => OPEN(status(s)) && t.repos.some(r => s.place?.path === r.path));
  const notes = t.notes.map(p => `<a href="${obsLink(p)}" title="${esc(p.split('/').pop())}">${esc(cut(p.split('/').pop().replace(/\.md$/, '').replace(/^.*\b[A-Z]+-\d+\s*/, ''), 30) || '노트')}</a>`).join(' · ');
  return `<div class="rv-tk ${t.review}" data-wt-tk="${esc(t.key)}">
    <div class="rv-head">
      <span class="tkc ${cls}"><i>${TK_IC[cls]}</i>${lbl}${t.review_at && t.review !== 'pending' ? ' · ' + esc(t.review_at) : ''}${t.review === 'reopened' ? `<span title="리뷰 뒤 드라이버가 재오픈으로 ${t.qa?.round}회차를 기동했습니다"> (${t.review_round ? esc(t.review_round) + '회차' : '이전 회차'} 리뷰)</span>` : ''}</span>
      <a href="${esc(wtData.jira)}/browse/${esc(t.key)}" target="_blank" rel="noopener"><b>${esc(t.key)}</b></a>
      <span class="rv-js j-${jiraStage(t)}" title="Jira 상태">${esc(t.status || '?')}</span>
      <span class="rv-sum" title="${esc(t.summary || '')}">${esc(t.summary || '')}</span>${t.assignee ? `<span class="st">${esc(t.assignee)}</span>` : ''}
    </div>
    <div class="rv-meta">
      ${t.step ? `<a href="${obsLink(t.step)}" title="${esc(t.step.split('/').pop())}">스텝 ${esc(t.step_status || '')}</a>` : '<span class="st">스텝 노트 없음</span>'}${notes ? ' · ' + notes : ''}
      ${wtTest(t.test)}${wtShip(t)}${qaAgents(t.qa)}
      ${live.length ? `<span class="tkc run" title="${esc(live.map(nameOf).join('\n'))}"><i>●</i>에이전트 ${live.length}</span>` : ''}
      ${wtActs(t, set)}
    </div>
    ${qaTrack(t.qa)}
    ${t.repos.map(r => wtRepo(t, r)).join('')}
  </div>`;
}
async function renderWorktrees() {
  if (wtData.at !== state.reviews_at) { try { const r = await api.reviews(); wtData = { at: state.reviews_at, sets: r?.sets || [], jira: r?.jira || '' }; } catch { wtData.at = undefined; } }
  const save = () => { try { localStorage.setItem('adash.wt', JSON.stringify(wtf)); } catch {} };
  if (!wtMounted) {
    $('#view').innerHTML = `<div class="controls">
        <div class="seg" id="wt-f">${Object.entries(WT_FILTERS).map(([k, l]) => `<button data-k="${k}">${l}</button>`).join('')}<span class="seg-sep"></span>${Object.entries(WT_JIRA).map(([k, l]) => `<button data-k="j:${k}" title="Jira 상태">${l}</button>`).join('')}</div>
        <select id="wt-qa" class="field" title="QA 드라이버 단계"></select>
        <input type="search" id="wt-q" class="field" placeholder="키·제목·브랜치 검색" value="${esc(wtf.q)}">
      </div><div id="wt-body"></div>`;
    $('#wt-qa').onchange = e => { wtf.qa = e.target.value; save(); renderWorktrees(); };
    $('#wt-f').querySelectorAll('button').forEach(b => b.onclick = () => { wtf.f = b.dataset.k; save(); renderWorktrees(); });
    $('#wt-q').oninput = e => { wtf.q = e.target.value; save(); renderWorktrees(); };
    $('#wt-body').onclick = wtClick;
    wtMounted = true;
    wtBodyHtml = '';
  }
  $('#wt-f').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.k === wtf.f));
  $('#wt-qa').innerHTML = [['', 'QA 단계 전체'], ...qaStages().filter(x => WT_QA.includes(x.key)).map(x => [x.key, 'QA ' + x.label]), ['blocked', 'QA 막힘']].map(([k, l]) => `<option value="${k}"${k === wtf.qa ? ' selected' : ''}>${esc(l)}</option>`).join('');
  if (!(wtf.f in WT_FILTERS || wtf.f.slice(2) in WT_JIRA)) wtf.f = 'all';
  if (wtf.qa && wtf.qa !== 'blocked' && !WT_QA.includes(wtf.qa)) wtf.qa = '';
  const num = k => +k.split('-').pop();
  const body = wtData.sets.map(s => {
    const n = k => s.tickets.filter(t => t.review === k).length, nj = k => s.tickets.filter(t => jiraStage(t) === k).length;
    const ts = s.tickets.filter(wtHit).sort((a, b) => WT_ORDER.indexOf(a.review) - WT_ORDER.indexOf(b.review) || num(b.key) - num(a.key));
    return `<div class="sec-h"><h2>${esc(s.epic)} ${esc(s.summary || '')}</h2><span>티켓 ${s.tickets.length} · 재오픈 ${n('reopened')} · 리뷰 대기 ${n('pending')} · 리뷰 완료 ${n('done')} · 워크트리 없음 ${n('none')}</span></div>
      <div class="rv-jsum">Jira ${Object.entries(WT_JIRA).filter(([k]) => nj(k)).map(([k, l]) => `<span class="rv-js j-${k}">${l} ${nj(k)}</span>`).join('')}</div>
      ${s.error ? `<div class="rv-err">${esc(s.error)}</div>` : ''}
      ${qaStatsHtml(s)}${qaAutoHtml(s)}${qaLegacyHtml(s)}
      ${s.stray.length ? `<div class="st" style="margin-bottom:8px">에픽 하위에 없는 워크트리 키: ${s.stray.map(esc).join(', ')}</div>` : ''}
      <div class="rv-list">${ts.map(t => wtTicket(t, s)).join('') || '<div class="empty">조건에 맞는 티켓이 없습니다.</div>'}</div>`;
  }).join('');
  // Unchanged markup is left alone: a web VS Code open under a ticket survives a redraw only where moveBefore exists.
  const html = body || `<div class="empty">${wtData.at ? 'QA 묶음이 없습니다.' : '불러오는 중… (서버 prefs.json 의 qa_sets 가 비어 있으면 아무것도 모으지 않습니다)'}</div>`;
  if (html === wtBodyHtml && $('#wt-body').childElementCount) return;
  wtBodyHtml = html;
  wtWebStash();
  $('#wt-body').innerHTML = html;
  wtWebPlace($('#wt-body'));
  $('#wt-body').querySelectorAll('.qa-legend').forEach(d => d.ontoggle = () => { try { localStorage.setItem(d.classList.contains('qa-stats') ? 'adash.qastats' : 'adash.qalegend', d.open ? '1' : '0'); } catch {} });
  const tip = $('#tip');
  $('#wt-body').querySelectorAll('.qa-stats').forEach(d => { const days = qaStatsDays[d.dataset.set] || [];
    d.querySelectorAll('[data-qs]').forEach(c => { c.onmousemove = e => tip.show(days[+c.dataset.qs], e); c.onmouseleave = () => tip.hide(); }); });
  if (wtData.at) $('#wt-body').insertAdjacentHTML('beforeend', `<div class="st" style="margin-top:10px">갱신 ${hhmm(wtData.at)} · 워크트리·git 30초, Jira 5분, PR 10분마다. 베이스는 로컬에 받아 둔 origin 브랜치 기준입니다 (fetch 하지 않음).</div>`);
}
async function qaClick(b) {
  const { qaAuto, qaTk, qaSet, epic, srv, id, key } = b.dataset, txt = b.textContent;
  if (qaSet) return qaSetClick(b);
  if (qaTk === 'merge' && !await uiConfirm(`${key} 의 PR 머지를 코디네이터에게 지시합니다.\n의존 저장소부터 머지하고, 머지할 수 없으면 막힘으로 남깁니다. 진행할까요?`)) return;
  if (qaTk === 'restart' && !await uiConfirm(`${key} 코디네이터를 기록된 브리프로 새 터미널에 다시 띄웁니다. 진행할까요?`)) return;
  b.disabled = true; b.textContent = '처리 중…';
  let r = qaAuto ? await api.qaAutomation(srv, epic, id, qaAuto) : await api.qaTicket(srv, epic, key, qaTk);
  if (qaTk === 'cleanup_check' && r.status === 200) {
    const out = r.body.output || '';
    if (r.body.code === 3) uiAlert(`정리를 멈춥니다:\n\n${out}`);
    else if (await uiConfirm(`${key} 워크트리를 정리합니다:\n\n${out}\n\n진행할까요?`)) { b.textContent = '정리 중…'; r = await api.qaTicket(srv, epic, key, 'cleanup'); }
  }
  if (r.status !== 200) uiAlert(r.body.error || r.body.output || `실패 (${r.status})`);
  else if (qaTk && qaTk !== 'cleanup_check') toast(cut(r.body.output || '처리했습니다', 200));
  b.disabled = false; b.textContent = txt;
}
async function qaSetClick(b) {
  const { qaSet, epic, srv, keys } = b.dataset, txt = b.textContent, call = (a, extra) => api.qaTicket(srv, epic, undefined, a, extra);
  const done = r => { if (r.status !== 200 || r.body.ok === false) uiAlert(r.body.error || r.body.output || `실패 (${r.status})`); else toast(cut(r.body.output || '처리했습니다', 200)); };
  const busy = l => { b.disabled = true; b.textContent = l; }, idle = () => { b.disabled = false; b.textContent = txt; };
  if (qaSet === 'close_finished') {
    const ks = keys.split(',');
    if (!await uiConfirm(`끝난 티켓 ${ks.length}개의 코디네이터·워커 터미널을 닫습니다:\n\n${ks.join(', ')}\n\n진행할까요?`)) return;
    busy('닫는 중…'); done(await call('close_finished', { keys: ks })); return idle();
  }
  if (qaSet === 'retire_check') {
    busy('확인 중…'); const r = await call('retire_check');
    if (r.status !== 200) { done(r); return idle(); }
    const out = r.body.output || '';
    if (r.body.code === 3) { uiAlert(`QA 종료를 멈춥니다:\n\n${out}`); return idle(); }
    if (await uiConfirm(`${epic} QA 를 종료합니다:\n\n${out}\n\n진행할까요?`)) { busy('종료 중…'); done(await call('retire')); }
    return idle();
  }
  if (qaSet === 'adopt_check') {
    busy('확인 중…'); const r = await call('adopt_check');
    let info; try { info = JSON.parse(r.body.output || ''); } catch { info = null; }
    if (r.status !== 200 || !info) { done(r); return idle(); }
    const set = {}, hint = { JIRA_SITE: wtData.jira, ...info.hints };
    for (const k of info.missing || []) {
      const v = await uiPrompt(`${epic} 상태 디렉터리 config.env 에 없는 값: ${k}${hint[k] ? `\n(추정값: ${hint[k]})` : ''}`, hint[k] || '');
      if (v == null) return idle();
      if (v.trim()) set[k] = v.trim();
    }
    const auto = (info.automations || []).filter(a => !a.adopted);
    if (!auto.length) { uiAlert('이관할 자동화가 없습니다'); return idle(); }
    if (!await uiConfirm(`자동화 ${auto.map(a => `「${a.name}」`).join(', ')} 의 precheck·prompt 를 qa-driver 로 바꿉니다.\n${Object.keys(set).length ? `config.env 에 추가: ${Object.entries(set).map(([k, v]) => `${k}=${v}`).join(', ')}\n` : ''}이미 처리 중인 티켓은 그대로 두고, 이후 회차부터 티켓마다 워크트리·코디네이터를 띄웁니다. 진행할까요?`)) return idle();
    busy('이관 중…');
    for (const [i, a] of auto.entries()) done(await call('adopt', { set: i ? {} : set, automation: a.id }));
    return idle();
  }
}
// 웹 VS Code: 「VS Code 로 보기」 opens the ticket's worktrees, read-only, in the server's web VS Code (serve-web, relayed
// by the server) in a panel at the bottom of the ticket row — a tab per repo, the desktop window one button away. The
// panels live outside the rendered markup (wtWeb) and go back under their row after each redraw: moveBefore keeps the
// iframe loaded where the browser has it, plain append reloads it.
const wtWeb = new Map();  // ticket key → panel
let wtWebPark;
const wtWebMove = (parent, el) => parent.moveBefore && el.isConnected ? parent.moveBefore(el, null) : parent.append(el);
function wtWebStash() {
  if (!wtWeb.size) return;
  if (!wtWebPark) { wtWebPark = document.body.appendChild(document.createElement('div')); wtWebPark.hidden = true; }
  for (const el of wtWeb.values()) if (el.isConnected && el.parentNode !== wtWebPark) wtWebMove(wtWebPark, el);
}
function wtWebPlace(root) {
  for (const [key, el] of wtWeb) {
    const row = root.querySelector(`[data-wt-tk="${CSS.escape(key)}"]`);
    if (row && el.parentNode !== row) wtWebMove(row, el);
  }
}
// The page follows the dashboard's light / dark: the server sets it as the page's default colour theme (?theme=), so a
// theme change reopens the shown pages with the new one (VS Code restores their open editors) and retargets the rest.
const wtWebUrl = u => { const x = new URL(u, location.href); x.searchParams.set('theme', document.documentElement.dataset.theme || 'light'); return x.href; };
document.addEventListener('ds:theme', () => {
  for (const el of wtWeb.values()) el.querySelectorAll('.rv-web-f').forEach(f => {
    if (f.dataset.src) f.dataset.src = wtWebUrl(f.dataset.src);
    else if (new URL(f.src).searchParams.get('theme') !== document.documentElement.dataset.theme) f.src = wtWebUrl(f.src);
  });
});
async function wtWebToggle(b) {
  const key = b.dataset.wtWeb, srv = b.dataset.srv, label = on => document.querySelectorAll(`button[data-wt-web="${CSS.escape(key)}"]`)
    .forEach(x => { x.textContent = on ? 'VS Code 접기' : 'VS Code 로 보기'; x.setAttribute('aria-expanded', on); });
  if (wtWeb.has(key)) { wtWeb.get(key).remove(); wtWeb.delete(key); return label(false); }
  b.disabled = true; b.textContent = '띄우는 중…';
  const { status: st, body } = await api.reviewWeb(srv, key);
  b.disabled = false;
  if (st !== 200) { label(false); return uiAlert(body.error || `실패 (${st})`); }
  const rs = body.repos, el = document.createElement('div');
  el.className = 'rv-web';
  el.innerHTML = `<div class="rv-web-h">
      ${rs.length > 1 ? `<div class="seg">${rs.map((r, i) => `<button type="button" data-wt-web-tab="${i}" class="${i ? '' : 'on'}" title="${esc(r.path)}">${esc(r.repo)}</button>`).join('')}</div>` : `<b title="${esc(rs[0].path)}">${esc(rs[0].repo)}</b>`}
      <span class="st">웹 VS Code · 읽기 전용</span>
      <span class="rv-acts"><button class="act big" data-wt-open="${esc(key)}" data-srv="${esc(srv)}" title="저장소마다 데스크톱 VS Code 창을 엽니다">데스크톱 VS Code 로 열기</button></span>
    </div>
    ${rs.map((r, i) => `<iframe class="rv-web-f" ${i ? 'data-src' : 'src'}="${esc(wtWebUrl(r.url))}" title="${esc(r.repo)} — 웹 VS Code"${i ? ' hidden' : ''}></iframe>`).join('')}`;
  wtWeb.set(key, el);
  document.querySelector(`#view [data-wt-tk="${CSS.escape(key)}"]`)?.append(el);
  label(true);
}
// A repo tab: its iframe loads on first show, so a ticket with several repos starts one VS Code window, not all of them.
function wtWebTab(b) {
  const el = b.closest('.rv-web'), i = +b.dataset.wtWebTab;
  el.querySelectorAll('[data-wt-web-tab]').forEach(x => x.classList.toggle('on', x === b));
  el.querySelectorAll('.rv-web-f').forEach((f, j) => {
    f.hidden = j !== i;
    if (j === i && f.dataset.src) { f.src = f.dataset.src; delete f.dataset.src; }
  });
}
async function wtClick(e) {
  const q = e.target.closest('button[data-qa-auto], button[data-qa-tk], button[data-qa-set]');
  if (q && !q.disabled) return qaClick(q);
  const w = e.target.closest('button[data-wt-web], button[data-wt-web-tab]');
  if (w && !w.disabled) return w.dataset.wtWeb ? wtWebToggle(w) : wtWebTab(w);
  const b = e.target.closest('button[data-wt-open], button[data-wt-mark], button[data-wt-ship]');
  if (!b || b.disabled) return;
  if (b.dataset.ship && !await uiConfirm(`${b.dataset.wtMark} 리뷰를 기록하고 반출(push·PR)을 승인합니다.\n코디네이터가 리베이스·검증 뒤 PR 을 엽니다 (머지는 하지 않음). 진행할까요?`)) return;
  if (b.dataset.wtShip && !await uiConfirm(`${b.dataset.wtShip} 을(를) PR 로 올리고 머지합니다.\nOrca 워커가 머지 뒤 Jira 「개발 완료」 전이, 스텝 노트 기록, 워크트리·브랜치 정리까지 합니다. 진행할까요?`)) return;
  const txt = b.textContent;
  b.disabled = true; b.textContent = b.dataset.wtOpen ? '여는 중…' : b.dataset.wtShip ? '시작 중…' : '기록 중…';
  const { status: st, body } = b.dataset.wtOpen ? await api.reviewOpen(b.dataset.srv, b.dataset.wtOpen)
    : b.dataset.wtShip ? await api.reviewShip(b.dataset.srv, b.dataset.wtShip) : await api.reviewMark(b.dataset.srv, b.dataset.wtMark, b.dataset.done === '1');
  if (st !== 200 && st !== 202) uiAlert(body.error || `실패 (${st})`);
  else if (body.approved) toast(body.output || '승인을 전달했습니다');
  b.disabled = false; b.textContent = txt;  // a mark re-renders the list once the server's next pass lands
}

// ---------- 관계 지도 · 진행 타임라인: the agents tab's flow views ----------
// Both draw the same model: per coordinator family a band of nodes (coordinator → its workers → its reviews and verdicts)
// built from the tree (families) and the worker plan (workerPlan), QA driver sets on the left when the coordinator works a
// QA ticket. Whether each node follows its contract is the server's flow check (state.flow): deviations per session,
// task, checkbox or ticket, and the contracts they were judged against (QA stages from the driver's state contract,
// checkbox roles). The page never judges; it places the server's verdicts on nodes and rows.
const NODE_ST = { ...ST_LABEL, ...FLOW_ST };
const SEV_RANK = { bad: 2, warn: 1 };
const flowContract = () => state.flow?.contracts || {};
const cbFlow = () => flowContract().checkbox || { roles: FLOW_ROLE, work: FLOW_ROLE.slice(0, 1), review: FLOW_ROLE.slice(1, 3), verdict: FLOW_ROLE.slice(3) };
const qaStages = () => flowContract().qa?.stages || Object.keys(QA_ST).map(key => ({ key, label: QA_ST[key] }));
const qaName = k => QA_ST[k] || qaStages().find(s => s.key === k)?.label || k;
// Reviews and verdicts of the checkbox contract (and any other role named as a review) go in the last column.
const isReview = role => [...(cbFlow().review || []), ...(cbFlow().verdict || [])].includes(role) || /리뷰|review/i.test(role || '');
const sevOf = xs => xs.reduce((m, x) => Math.max(m, SEV_RANK[x.severity] || 0), 0);
const ATTN_ST = ['stalled', 'wait', 'fail'];
let mapSel = null, mapMore = 40;
const MAP_BANDS = 12, MAP_COL = 8;
try { mapSel = localStorage.getItem('adash.mapsel') || null; } catch {}

// QA driver sets (from /api/reviews, as the 워크트리 tab reads them), loaded once per server pass.
let rvLoad = null, rvFailed = null;
function needReviews() {
  if (wtData.at === state.reviews_at || rvLoad || rvFailed === state.reviews_at) return;
  const want = state.reviews_at;
  rvLoad = api.reviews().then(r => { wtData = { at: want, sets: r?.sets || [], jira: r?.jira || '' }; })
    .catch(() => { rvFailed = want; })
    .finally(() => { rvLoad = null; if (route().v === 'home' || route().v === 'agents' && ['map', 'tl'].includes(agView)) render(); });
}
// The QA ticket (and its set) a session works on: a terminal handle the driver recorded for the ticket (coordinator,
// workers), else the ticket key in the session's title or worktree name — a closed terminal leaves only those.
function qaHandles() {
  const m = new Map(), keys = new Map();
  for (const s of wtData.sets || []) if (s.driver) for (const t of s.tickets) {
    if (t.qa) keys.set(t.key, { set: s, t });
    for (const h of t.qa?.handles || []) if (!m.has(h)) m.set(h, { set: s, t });
  }
  m.keys_ = keys;
  return m;
}
const qaOf = (s, qh) => {
  for (const h of [s.orca_focus, s.own_handle]) if (h && qh.has(h)) return qh.get(h);
  for (const k of `${s.title || ''} ${s.place?.worktree || ''}`.match(/[A-Z][A-Z0-9]+-\d+/g) || []) if (qh.keys_.has(k)) return qh.keys_.get(k);
  return null;
};
const famQa = (f, qh) => f.coord ? qaOf(f.coord, qh) : qh.get(f.handle) || null;

// A task's node state: the task's own outcome first (a failed task is 실패, never 완료), then its worker session.
function taskNodeSt(x) {
  const t = IX.tasks[x.id];
  if (t?.status === 'completed') return 'done';
  if (t?.status === 'failed') return 'fail';
  if (t?.status === 'cancelled') return 'skip';
  if (x.sess) return status(x.sess);
  return x.st === 'blocked' ? 'blocked' : 'planned';
}
const ENDED_ST = st => ['done', 'idle', 'skip', 'fail'].includes(st);
// One band per coordinator family (sub-families get their own band, joined to their parent's coordinator).
function famBands(f, qh, depth = 0, parent = null) {
  const c = f.coord;
  const coord = { id: c ? 's:' + c.path : 'h:' + f.handle, kind: 'coord', sess: c, name: c ? nameOf(c) : ownerName(f.handle), st: c ? status(c) : f.st, qa: famQa(f, qh), sub: depth > 0, parent };
  const band = { key: f.key, coord, work: [], review: [], depth, fam: f };
  const wp = workerPlan(f.handle, f.extra), seen = new Set();
  for (const x of wp?.items || []) {
    if (x.sess && isSubCoord(x.sess) && f.subs.some(y => y.coord === x.sess)) { seen.add(x.sess.path); continue; }
    const t = IX.tasks[x.id], role = t ? roleOf(t) : '';
    if (filtering() && !(x.sess && liveSess(x.sess))) continue;
    if (x.sess) seen.add(x.sess.path);
    (isReview(role) ? band.review : band.work).push({ id: 't:' + x.id, kind: 'task', taskId: x.id, sess: x.sess, name: x.name, role, st: taskNodeSt(x), item: x });
  }
  for (const w of f.workers) if (!seen.has(w.path) && liveSess(w)) band.work.push({ id: 's:' + w.path, kind: 'sess', sess: w, name: nameOf(w), st: status(w) });
  return [band, ...f.subs.filter(liveFam).flatMap(x => famBands(x, qh, depth + 1, coord.id))];
}
const bandNodes = b => [b.coord, ...b.work, ...b.review];
// The server's deviations onto nodes: by task first, then by session (a session serving several tasks gives its own
// deviations to the node of its current task), then a ticket's to the node standing for that ticket's coordinator.
function placeDevs(nodes) {
  const by = new Map(nodes.map(n => [n.id, n]));
  nodes.forEach(n => { n.devs = []; n.involved = 0; });
  const byTask = new Map(), bySess = new Map();
  for (const n of nodes) {
    if (n.taskId) byTask.set(n.taskId, n);
    if (n.sess && (!bySess.has(n.sess.path) || n.taskId === n.sess.task_id || n.kind !== 'task')) bySess.set(n.sess.path, n);
  }
  const byTicket = new Map(nodes.filter(n => n.qa && (n.kind === 'coord' || n.kind === 'ticket')).map(n => [n.qa.t.key, n]));
  for (const x of state.flow?.items || []) {
    const n = (x.task_id && byTask.get(x.task_id)) || (x.session && bySess.get(x.session)) || (x.ticket && byTicket.get(x.ticket));
    if (n) n.devs.push(x);
    for (const id of x.task_ids || []) { const m = byTask.get(id); if (m && m !== n) m.involved = Math.max(m.involved, SEV_RANK[x.severity] || 0); }
  }
  return by;
}
const nodeSev = n => Math.max(sevOf(n.devs || []), n.involved || 0);

// Groups of the map: a QA driver with the bands of its tickets, else one coordinator family; solo sessions only when
// they deviate or need attention. Ordered by worst deviation, then attention, then live, then newest.
function mapModel() {
  const { fams, solos } = families(), qh = qaHandles();
  const groups = [], byEpic = new Map();
  for (const f of fams.filter(liveFam)) {
    const bands = famBands(f, qh), q = bands[0].coord.qa;
    if (q) {
      const k = q.set.epic + '|' + q.set.server;
      let g = byEpic.get(k);
      if (!g) {
        const autos = q.set.automations || [], on = autos.some(a => a.enabled);
        const qs = q.set.tickets.filter(t => t.qa), act = qs.filter(t => !['delivered', 'cleaned'].includes(t.qa.stage) && !t.qa.ignored).length;
        g = { key: 'qa:' + k, kind: 'qa', title: `QA 드라이버 · ${q.set.epic}`, bands: [], set: q.set,
          driver: { id: 'd:' + k, kind: 'driver', name: `⚙ QA 드라이버 · ${q.set.epic}`, st: on ? 'run' : 'idle', meta: `티켓 ${qs.length} · 진행 ${act} · 자동화 ${on ? '켜짐' : autos.length ? '꺼짐' : '없음'}` } };
        byEpic.set(k, g); groups.push(g);
      }
      g.bands.push(...bands);
    } else groups.push({ key: 'f:' + f.key, kind: 'fam', title: bands[0].coord.name, bands });
  }
  // Solo sessions of a QA ticket (its coordinator and workers run as plain terminals) join that ticket's band: the
  // first one started in the ticket's latest round is its coordinator, the rest its workers.
  const qaSolo = new Map(), rest = [];
  for (const s of solos.filter(liveSess)) { const q = qaOf(s, qh); if (q) (qaSolo.get(q.t.key) || qaSolo.set(q.t.key, { q, ss: [] }).get(q.t.key)).ss.push(s); else rest.push(s); }
  for (const { q, ss } of qaSolo.values()) {
    const k = q.set.epic + '|' + q.set.server, round = (q.t.qa.rounds || []).slice(-1)[0] || '';
    let g = byEpic.get(k);
    if (!g) { g = { key: 'qa:' + k, kind: 'qa', title: `QA 드라이버 · ${q.set.epic}`, bands: [], set: q.set, driver: { id: 'd:' + k, kind: 'driver', name: `⚙ QA 드라이버 · ${q.set.epic}`, st: (q.set.automations || []).some(a => a.enabled) ? 'run' : 'idle', meta: `티켓 ${q.set.tickets.filter(t => t.qa).length} · 자동화 ${(q.set.automations || []).some(a => a.enabled) ? '켜짐' : '꺼짐'}` } }; byEpic.set(k, g); groups.push(g); }
    const node = s => ({ id: 's:' + s.path, kind: 'sess', sess: s, name: nameOf(s), st: status(s) });
    const band = g.bands.find(b => !b.depth && b.coord.qa?.t.key === q.t.key);
    if (band) { band.work.push(...ss.map(node)); continue; }
    ss.sort(byStart);
    const head = ss.find(s => !round || (s.started || '') >= new Date(new Date(round).getTime() - 60e3).toISOString()) || ss[0];
    g.bands.push({ key: 'tk:' + q.t.key, depth: 0, review: [], work: ss.filter(s => s !== head).map(node), coord: { ...node(head), kind: 'coord', qa: q } });
  }
  // A QA ticket whose coordinator session is gone from the window but still deviates keeps a stand-in band.
  const shown = new Set(groups.flatMap(g => g.bands.flatMap(b => b.coord.qa ? [b.coord.qa.t.key] : [])));
  for (const x of state.flow?.items || []) {
    if (!x.ticket || shown.has(x.ticket) || (x.session && state.sessions.some(s => s.path === x.session))) continue;
    const hit = (wtData.sets || []).flatMap(s => s.tickets.map(t => ({ set: s, t }))).find(y => y.t.key === x.ticket);
    if (!hit) continue;
    shown.add(x.ticket);
    const k = hit.set.epic + '|' + hit.set.server;
    let g = byEpic.get(k);
    if (!g) { g = { key: 'qa:' + k, kind: 'qa', title: `QA 드라이버 · ${hit.set.epic}`, bands: [], set: hit.set, driver: { id: 'd:' + k, kind: 'driver', name: `⚙ QA 드라이버 · ${hit.set.epic}`, st: 'idle', meta: '' } }; byEpic.set(k, g); groups.push(g); }
    g.bands.push({ key: 'tk:' + x.ticket, depth: 0, work: [], review: [], coord: { id: 'k:' + x.ticket, kind: 'ticket', name: `${x.ticket} 코디네이터`, st: hit.t.qa.stage === 'cleaned' ? 'done' : 'idle', qa: hit, note: '세션이 추적 범위 밖' } });
  }
  const odd = rest.filter(s => ATTN_ST.includes(status(s)) || s.decision || (state.flow?.items || []).some(x => x.session === s.path));
  if (odd.length) groups.push({ key: 'solo', kind: 'solo', title: '단독 세션 — 이탈·주의만', bands: odd.map(s => ({ key: 'solo:' + s.path, depth: 0, work: [], review: [], coord: { id: 's:' + s.path, kind: 'solo', sess: s, name: nameOf(s), st: status(s) } })), hidden: solos.length - odd.length });
  const nodes = groups.flatMap(g => [...(g.driver ? [g.driver] : []), ...g.bands.flatMap(bandNodes)]);
  const by = placeDevs(nodes);
  for (const g of groups) {
    const ns = [...(g.driver ? [g.driver] : []), ...g.bands.flatMap(bandNodes)];
    g.devs = ns.reduce((a, n) => a + n.devs.length, 0);
    g.sev = Math.max(0, ...ns.map(nodeSev));
    g.attn = ns.some(n => ATTN_ST.includes(n.st) || n.sess?.decision);
    g.live = ns.some(n => n.sess && OPEN(status(n.sess)));
    g.open = ns.some(n => !ENDED_ST(n.st));
    g.started = g.bands.map(b => b.coord.sess?.started || '').sort().pop() || '';
    for (const b of g.bands) {
      const bn = bandNodes(b);
      b.sev = Math.max(0, ...bn.map(nodeSev)); b.devs = bn.reduce((a, n) => a + n.devs.length, 0);
      b.attn = bn.some(n => ATTN_ST.includes(n.st) || n.sess?.decision); b.open = bn.some(n => !ENDED_ST(n.st));
    }
    g.bands = byRank(g.bands, b => b.depth ? 0 : -(b.sev * 4 + (b.attn ? 2 : 0) + (b.open ? 1 : 0)));  // sub-bands stay after their parent
    if (g.kind === 'qa') g.bands = (() => { const out = [], put = b => { out.push(b); g.bands.filter(y => y.coord.parent === b.coord.id).forEach(put); }; g.bands.filter(b => !b.depth).forEach(put); g.bands.filter(b => !out.includes(b)).forEach(b => out.push(b)); return out; })();
  }
  // Relations first: the solo group (no relations to draw) always goes last.
  groups.sort((a, b) => (a.kind === 'solo') - (b.kind === 'solo') || b.sev - a.sev || b.attn - a.attn || b.live - a.live || b.open - a.open || b.started.localeCompare(a.started));
  return { groups, by };
}

// What a node is measured by, with the unit named: QA contract stage, else the session's aplan plan, else the task.
function nodeProgress(n) {
  const q = n.qa?.t?.qa;
  if (q) {
    const ks = qaStages().map(s => s.key), cur = ks.indexOf(q.stage);
    return `<span class="mp-r"><span class="mp-steps" aria-hidden="true">${ks.map((k, i) => `<i class="${i < cur ? 'done' : i === cur ? (n.devs.some(x => x.rule === 'order') ? 'fail' : q.stage === 'cleaned' ? 'done' : 'run') : ''}"></i>`).join('')}</span>QA 단계 ${cur + 1}/${ks.length} ${esc(qaName(q.stage))}</span>`;
  }
  const s = n.sess, out = [];
  if (s?.plan) {
    const p = s.plan, ended = ENDED(status(s));
    out.push(`<span class="mp-r"><span class="mp-steps" aria-hidden="true">${missed(p, ended).steps.map(x => `<i class="${x === 'miss' ? 'fail' : x}"></i>`).join('')}</span>계획 ${p.done}/${p.total}${p.cur_text && !ended ? ' · ▶ ' + esc(cutW(p.cur_text, 18)) : ''}</span>`);
  }
  if (n.kind === 'task' && n.st !== 'done' && n.st !== 'skip' && n.st !== 'fail') {
    const t = IX.tasks[n.taskId], r = t && taskLeft(t);
    if (!n.sess) out.push(`<span class="mp-r">${n.item?.open ? `선행 대기: ${esc(cut(n.item.deps.join(', '), 30))}` : esc(NODE_ST[n.st])}</span>`);
    else if (r?.e && r.el != null) out.push(`<span class="mp-r${r.el > 2 * r.e.ms ? ' mp-over' : ''}">${mins(r.el)}째 (기대 ${mins(r.e.ms)})</span>`);
  }
  return out.join('');
}
// 「✓ 흐름 정상」 only where a server judged: a node from a server without the flow check says nothing.
const judged = n => (state.flow?.from || []).includes(n.sess ? n.sess.server : n.qa?.set?.server);
const devBadge = n => n.devs.length ? `<span class="mp-dev ${sevOf(n.devs) === 2 ? 'bad' : 'warn'}">⚠ 이탈 ${n.devs.length} · ${esc(cutW(n.devs[0].reason, 22))}</span>`
  : (n.sess || n.kind === 'ticket') && judged(n) ? '<span class="mp-ok">✓ 흐름 정상</span>' : '';
function nodeHtml(n) {
  const st = n.st, role = n.kind === 'coord' && n.sub ? '하위 코디네이터' : n.kind === 'task' && n.sess?.viaScript ? '스크립트 경유' : '';
  // One state line: a task's own state (with how long it took once settled), a session's state and last record.
  const meta = n.kind === 'driver' ? n.meta : n.note || (n.kind === 'task' ? (n.sess ? `${NODE_ST[st]}${n.item?.spawned && n.item?.done ? ' · ' + dur(n.item.spawned, n.item.done) : ''}${n.sess.decision ? ' · 결정 대기' : ''}` : '')
    : n.sess ? `${NODE_ST[status(n.sess)] || ''}${n.sess.decision ? ' · 결정 대기' : ''} · ${ago(n.sess.last_ts)}` : NODE_ST[st] || '');
  return `<button type="button" class="mp-n st-${st}${nodeSev(n) === 2 ? ' dev-bad' : nodeSev(n) === 1 ? ' dev-warn' : ''}${mapSel === n.id ? ' sel' : ''}" data-n="${esc(n.id)}" aria-pressed="${mapSel === n.id}">
    <b class="mp-t" title="${esc(n.name)}">${esc(cutW(n.name, 30))}</b>${role ? `<span class="mp-r mp-role">${role}</span>` : ''}
    ${nodeProgress(n)}${meta ? `<span class="mp-r">${esc(meta)}</span>` : ''}${devBadge(n)}</button>`;
}

// Edges of one group: spawn (solid, parent → child), deps (arrow, predecessor → task), messages (dotted, sender → receiver),
// and red when the target deviates. A folded run of finished nodes stands in for each node it hides.
function groupEdges(g, vis, msgs) {
  const out = [], add = (a, b, k) => { const A = vis[a], B = vis[b]; if (A && B && A !== B && !out.some(e => e.a === A && e.b === B && e.k === k)) out.push({ a: A, b: B, k }); };
  const nodes = new Map([...(g.driver ? [g.driver] : []), ...g.bands.flatMap(bandNodes)].map(n => [n.id, n]));
  const bad = id => nodeSev(nodes.get(id) || {}) === 2;
  const byTask = new Map([...nodes.values()].filter(n => n.taskId).map(n => [n.taskId, n]));
  for (const b of g.bands) {
    if (g.driver && !b.depth) add(g.driver.id, b.coord.id, bad(b.coord.id) ? 'bad' : 'spawn');
    if (b.coord.parent) add(b.coord.parent, b.coord.id, bad(b.coord.id) ? 'bad' : 'spawn');
    for (const n of [...b.work, ...b.review]) {
      const deps = n.taskId ? (() => { try { return JSON.parse(IX.tasks[n.taskId]?.deps || '[]'); } catch { return []; } })().map(d => byTask.get(d)).filter(Boolean) : [];
      deps.forEach(d => add(d.id, n.id, bad(n.id) ? 'bad' : 'dep'));
      if (!deps.length || !b.review.includes(n)) add(b.coord.id, n.id, bad(n.id) ? 'bad' : 'spawn');
    }
  }
  const at = new Map();
  for (const n of nodes.values()) for (const h of n.sess ? [n.sess.own_handle, n.sess.orca_focus] : []) if (h && !at.has(h)) at.set(h, n.id);
  // Workers report to their run (run:<id>), which Orca resolves to the run's coordinator terminal: a script driver the
  // coordinator opened stands for that coordinator.
  for (const b of g.bands) for (const h of [b.fam?.handle, ...(b.fam?.extra || [])]) if (h && !at.has(h)) at.set(h, b.coord.id);
  for (const m of msgs) { const a = at.get(m.from_term), b = at.get(m.to_term); if (a && b) add(a, b, 'msg'); }
  return out;
}
// One shared load of the 상호작용 tab's messages for both views; every caller waits for the same request.
let talkLoad = null;
const talkOnce = () => talkLoad ||= loadTalk().finally(() => { talkLoad = null; });
// Messages of the last 6 hours (the 상호작용 tab's cache), heartbeats left out.
const MSG_WINDOW = 6 * 3600e3;
const recentMsgs = () => { const since = Date.now() - MSG_WINDOW; return (talk.data?.messages || []).filter(m => m.type !== 'heartbeat' && m.created_at && toDate(m.created_at).getTime() >= since); };

function mapHtml() {
  needReviews();
  if (!talk.data) talkOnce().then(() => { if (talk.data && route().v === 'agents' && agView === 'map') mapEdges(); });
  const model = mapLast = mapModel(), { groups, by } = model, msgs = recentMsgs();
  mapNodes = by;
  if (!groups.length) return '<div class="empty">표시할 코디네이터·에이전트가 없습니다.</div>';
  const fl = state.flow, nDev = (fl?.items || []).length;
  const head = `<div class="mp-head"><span><b>흐름 이탈 ${nDev}</b>${nDev ? ` (${Object.entries((fl.items || []).reduce((a, x) => (a[x.rule_name] = (a[x.rule_name] || 0) + 1, a), {})).map(([k, v]) => `${esc(k)} ${v}`).join(' · ')})` : ''}${fl?.ok ? ` · 정상으로 표시 ${fl.ok}` : ''}</span>
    ${fl?.errors?.length ? `<span class="mp-err">판정 오류: ${esc(fl.errors.join(' · '))}</span>` : ''}${fl?.missing?.length ? `<span class="mp-err">흐름 판정을 보내지 않는 메트릭 서버: ${esc(fl.missing.join(', '))} — 서버를 갱신해야 이탈이 보입니다</span>` : ''}</div>`;
  const legend = `<div class="legend mp-leg"><span><i class="mp-lk spawn"></i>실선 = 띄움(부모 → 자식)</span><span><i class="mp-lk dep"></i>화살표 = 선행(deps)</span><span><i class="mp-lk msg"></i>점선 = 메시지(최근 6시간)</span><span><i class="mp-lk bad"></i>빨강 = 이탈 경로</span><span class="st">왼쪽 띠 = 상태 색 · 진행 칸은 「QA 단계」(계약 ${qaStages().length}단계) 또는 「계획」(aplan 단계)</span></div>`;
  const gHtml = g => {
    const gk = 'mapg:' + g.key, hasSel = mapSel && [...(g.driver ? [g.driver] : []), ...g.bands.flatMap(bandNodes)].some(n => n.id === mapSel);
    const open = hasSel || (famMin[gk] ?? (g.kind !== 'solo' && (g.sev > 0 || g.attn || g.open)));
    const ns = g.bands.flatMap(bandNodes), c = k => ns.filter(n => n.st === k).length;
    const sum = [`에이전트 ${ns.filter(n => n.sess).length}`, c('run') && `실행 중 <b style="color:var(--run)">${c('run')}</b>`, c('wait') && `입력 대기 ${c('wait')}`, c('stalled') && `응답 없음 <b style="color:var(--bad)">${c('stalled')}</b>`,
      `완료 ${c('done')}`, c('fail') && `실패 <b style="color:var(--bad)">${c('fail')}</b>`, (c('planned') + c('blocked')) && `생성 예정 ${c('planned') + c('blocked')}`].filter(Boolean).join(' · ');
    const hdr = `<button type="button" class="mp-gh" data-mpg="${esc(gk)}" data-open="${open ? 1 : 0}" aria-expanded="${open}"><span class="tk-arrow">${open ? '▾' : '▸'}</span><b>${esc(g.title)}</b><span class="st">${sum}</span>${g.devs ? `<span class="mp-dev ${g.sev === 2 ? 'bad' : 'warn'}">⚠ 이탈 ${g.devs}</span>` : ns.some(judged) ? '<span class="mp-ok">✓ 이탈 없음</span>' : ''}${g.hidden ? `<span class="st">그 밖의 단독 세션 ${g.hidden}개는 관계가 없어 뺐습니다</span>` : ''}</button>`;
    if (!open) return `<section class="box mp-g">${hdr}</section>`;
    if (g.kind === 'solo') return `<section class="box mp-g">${hdr}<div class="mp-solo">${g.bands.map(b => nodeHtml(b.coord)).join('')}</div></section>`;
    const vis = {};
    // A column keeps what needs a look (deviations, open work, the picked node); finished nodes fold into 「✓ 완료 N」,
    // and past MAP_COL nodes the rest wait behind 「외 N」, worst first.
    const col = (b, list, which) => {
      const fk = `mapd:${b.key}:${which}`, xk = `mapx:${b.key}:${which}`, keep = n => n.devs.length || n.involved || !ENDED_ST(n.st) || n.id === mapSel;
      const done = list.filter(n => !keep(n)), fold = done.length > 2 && !famMin[fk];
      let shown = fold ? list.filter(keep) : list, extra = [];
      const fid = 'fold:' + fk, xid = 'more:' + xk;
      if (shown.length > MAP_COL && !famMin[xk]) {
        const rank = n => -(nodeSev(n) * 8 + (ATTN_ST.includes(n.st) ? 4 : 0) + (n.st === 'run' || n.st === 'bg' ? 2 : 0) + (n.id === mapSel ? 99 : 0));
        const top = new Set(byRank(shown, rank).slice(0, MAP_COL));
        extra = shown.filter(n => !top.has(n)); shown = shown.filter(n => top.has(n));
      }
      shown.forEach(n => (vis[n.id] = n.id));
      if (fold) done.forEach(n => (vis[n.id] = fid));
      extra.forEach(n => (vis[n.id] = xid));
      const xd = extra.reduce((a, n) => a + n.devs.length, 0);
      return shown.map(nodeHtml).join('')
        + (extra.length ? `<button type="button" class="mp-n mp-fold mp-more-n" data-n="${esc(xid)}" data-mpd="${esc(xk)}">외 ${extra.length}개${xd ? ` · 이탈 ${xd}` : ''}<span class="mp-r">눌러서 모두 보기</span></button>`
          : famMin[xk] ? `<button type="button" class="act" data-mpd="${esc(xk)}" data-unfold="1">${MAP_COL}개만 보기</button>` : '')
        + (fold ? `<button type="button" class="mp-n mp-fold st-done" data-n="${esc(fid)}" data-mpd="${esc(fk)}">✓ 완료 ${done.length}<span class="mp-r">눌러서 펼치기</span></button>`
          : done.length > 2 ? `<button type="button" class="act" data-mpd="${esc(fk)}" data-unfold="1">완료 ${done.length}개 접기</button>` : '');
    };
    // Long groups (a QA driver with dozens of tickets) show their first bands; the rest come on request.
    const bk0 = 'mapbm:' + g.key, nb = Math.max(MAP_BANDS, famMin[bk0] || 0), selAt = g.bands.findIndex(b => bandNodes(b).some(n => n.id === mapSel));
    const bands = g.bands.slice(0, Math.max(nb, selAt + 1));
    let rows = '';
    bands.forEach((b, i) => {
      const bk = 'mapb:' + b.key, bopen = famMin[bk] ?? (b.sev > 0 || b.attn || b.open || bandNodes(b).some(n => n.id === mapSel));
      vis[b.coord.id] = b.coord.id;
      const kids = b.work.length + b.review.length;
      if (!bopen) [...b.work, ...b.review].forEach(n => (vis[n.id] = b.coord.id));
      rows += `<div class="mp-c2" style="grid-row:${i + 2}">${b.depth ? `<span class="mp-sub">↳ 하위 ${b.depth}</span>` : ''}${nodeHtml(b.coord)}${kids ? `<button type="button" class="tgl mp-bt" data-mpb="${esc(bk)}" data-open="${bopen ? 1 : 0}" aria-expanded="${bopen}">${bopen ? '▾ 하위 접기' : `▸ 하위 ${kids} 펼치기`}</button>` : ''}</div>
        <div class="mp-c3" style="grid-row:${i + 2}">${bopen ? col(b, b.work, 'w') : ''}</div><div class="mp-c4" style="grid-row:${i + 2}">${bopen ? col(b, b.review, 'r') : ''}</div>`;
    });
    if (g.driver) vis[g.driver.id] = g.driver.id;
    const edges = groupEdges(g, vis, msgs);
    return `<section class="box mp-g">${hdr}<div class="mp-scroll"><div class="mp-grid" data-edges="${esc(JSON.stringify(edges))}" data-g="${esc(g.key)}" data-msgs="${msgs.length ? 1 : ''}">
      <span class="mp-ch" style="grid-column:1">드라이버 (스크립트)</span><span class="mp-ch" style="grid-column:2">코디네이터 (티켓)</span><span class="mp-ch" style="grid-column:3">워커 (구현)</span><span class="mp-ch" style="grid-column:4">리뷰·판정</span>
      <div class="mp-c1" style="grid-row:2 / span ${bands.length}">${g.driver ? nodeHtml(g.driver) : '<span class="st mp-none">—</span>'}</div>${rows}
      <svg class="mp-edges" aria-hidden="true"></svg></div></div>
      ${g.bands.length > bands.length ? `<button type="button" class="act big mp-bm" data-mpbm="${esc(bk0)}" data-n0="${bands.length}">${g.kind === 'qa' ? '티켓' : '묶음'} ${g.bands.length - bands.length}개 더 보기 (이탈·주의 먼저 정렬됨)</button>` : ''}</section>`;
  };
  const shown = groups.slice(0, mapMore);
  return `${head}${legend}<div class="mp-wrap"><div class="mp-main">${shown.map(gHtml).join('')}
    ${groups.length > shown.length ? `<button type="button" class="act big" id="mp-more">묶음 ${groups.length - shown.length}개 더 보기</button>` : ''}</div>
    <aside class="box mp-side" aria-live="polite">${mapPanel(by.get(mapSel))}</aside></div>`;
}
let mapNodes = new Map(), mapLast = null;

// The selected node beside the map: its contract against what happened, its deviations, and what to do about them.
function mapPanel(n) {
  if (!n) {
    const top = [...mapNodes.values()].filter(x => x.devs?.length).sort((a, b) => nodeSev(b) - nodeSev(a)).slice(0, 8);
    return `<h3>노드를 고르면 여기에 계약 대비 실제</h3>${top.length ? `<div class="st">이탈한 노드</div>${top.map(x => `<button type="button" class="mp-pick" data-n="${esc(x.id)}"><span class="mp-dev ${nodeSev(x) === 2 ? 'bad' : 'warn'}">⚠ ${x.devs.length}</span>${esc(cutW(x.name, 34))}<span class="st">${esc(x.devs[0].reason)}</span></button>`).join('')}` : '<div class="st">이탈한 노드가 없습니다.</div>'}`;
  }
  const s = n.sess, t = n.taskId && IX.tasks[n.taskId];
  let contract = '';
  const q = n.qa?.t?.qa;
  if (q) {
    const ks = qaStages(), cur = ks.findIndex(x => x.key === q.stage), gate = new Set(n.devs.filter(x => x.rule === 'order').map(x => x.id.split('|')[2]));
    contract = `<div class="mp-sec">계약: QA 단계 ${ks.length}칸 <span class="st">(${esc(flowContract().qa?.source ? '드라이버 상태 계약' : '대시보드 기본값')})</span></div><ol class="mp-ct">${ks.map((x, i) => {
      const missing = gate.has(x.key), cls = missing ? 'bad' : i < cur || (i === cur && q.stage === 'cleaned') ? 'done' : i === cur ? 'run' : '';
      return `<li class="${cls}"><span class="ic">${missing ? '✕' : cls === 'done' ? '✓' : cls === 'run' ? '▶' : '·'}</span>${esc(qaName(x.key))}${x.user ? ' <span class="st">(사용자 차례)</span>' : ''}<span class="st">${missing ? ' 신호 없음' : q.at?.[x.key] && i <= cur ? ' ' + clockAt(q.at[x.key]) : ''}</span></li>`; }).join('')}</ol>`;
  }
  const m = t && TASK_NAME.exec(taskName(t));
  if (m && m[2]) {
    const box = `${m[1]}#${m[2]}`, same = (state.orca.tasks[t.run_id] || []).filter(x => { const y = TASK_NAME.exec(taskName(x)); return y && `${y[1]}#${y[2]}` === box; });
    const cf = cbFlow(), lacking = new Set(n.devs.filter(x => x.rule === 'missing').flatMap(x => x.task_ids.slice(1)));
    const rounds = same.filter(x => (cf.work || []).includes(roleOf(x))).length;
    // The round this node belongs to: for a verdict, each role's latest task made before it (what it judged); else the latest.
    const upto = (cf.verdict || []).includes(roleOf(t)) && t.created_at ? t.created_at : '~';
    contract = `<div class="mp-sec">계약: ${esc(cf.roles.join(' → '))} <span class="st">· ${esc(box)}${rounds > 1 ? ` · ${rounds}라운드` : ''}${upto !== '~' ? ' · 이 판정의 회차' : ''}</span></div><ol class="mp-ct">${cf.roles.map(role => {
      const ts = same.filter(x => roleOf(x) === role && (x === t || (x.created_at || '~') <= upto)).sort((a, b) => (a.created_at || '~').localeCompare(b.created_at || '~'));
      const x = ts.find(y => lacking.has(y.id)) || ts[ts.length - 1];
      const w = x && estIndex().sess[x.id];
      const [cls, ic, txt] = !x ? ['', '·', '아직 없음'] : lacking.has(x.id) ? ['bad', '✕', '취소되지 않았는데 결과 없음'] : x.status === 'completed' ? ['done', '✓', w?.started ? dur(w.started, x.completed_at ? toDate(x.completed_at).toISOString() : w.last_ts) : '완료']
        : x.status === 'cancelled' ? ['', '–', '취소'] : x.status === 'failed' ? ['bad', '✕', '실패'] : ['run', '▶', w ? NODE_ST[status(w)] : NODE_ST[x.status === 'blocked' ? 'blocked' : 'planned']];
      return `<li class="${cls}"><span class="ic">${ic}</span>${w ? `<a href="#s=${encodeURIComponent(w.path)}">${esc(role)}</a>` : esc(role)}<span class="st"> · ${esc(txt)}</span></li>`; }).join('')}</ol>`;
  }
  const devs = n.devs.map(x => `<div class="mp-dv ${x.severity}"><b>⚠ ${esc(x.rule_name)}</b> · ${esc(x.reason)}<ul>${x.evidence.map(e => `<li>${esc(e)}</li>`).join('')}</ul>
    <button type="button" class="act" data-flow-ok="${esc(x.id)}" data-srv="${esc(x.server || '')}">정상으로 표시</button></div>`).join('');
  const links = [s && `<a class="act big" href="#s=${encodeURIComponent(s.path)}">세션 열기</a>`, s?.orca_focus && focusBtn(s.orca_focus, true),
    ...n.devs.filter(x => x.rule === 'missing').flatMap(x => x.task_ids.slice(1)).map(id => { const w = estIndex().sess[id]; return w && `<a class="act big" href="#s=${encodeURIComponent(w.path)}">${esc(roleOf(IX.tasks[id] || {}) || '리뷰')} 열기</a>`; }),
    n.qa && `<a class="act big" href="#worktrees">워크트리 탭에서 ${esc(n.qa.t.key)}</a>`].filter(Boolean).join('');
  return `<div class="fl-ph"><b>${esc(n.name)}</b>${s ? pill(status(s), s) : `<span class="st">${esc(NODE_ST[n.st] || '')}</span>`}<button type="button" class="act" data-n="">닫기</button></div>
    ${n.devs.length ? `<div class="mp-sec bad">흐름 이탈 ${n.devs.length}</div>${devs}` : n.sess && judged(n) ? '<div class="mp-sec ok">✓ 흐름 정상 — 판정 규칙에 걸린 것 없음</div>' : n.sess ? '<div class="mp-sec">이 세션의 서버는 흐름 판정을 보내지 않습니다</div>' : ''}
    ${contract}
    ${s?.plan ? `<div class="mp-sec">계획 (aplan) ${s.plan.done}/${s.plan.total}</div><div id="mp-plan" class="st">불러오는 중…</div>` : s ? '<div class="st mp-sec">이 세션은 aplan 계획을 남기지 않았습니다.</div>' : ''}
    ${links ? `<div class="mp-acts">${links}</div>` : ''}`;
}
// aplan steps for the panel and the timeline, fetched per path and kept while the session's plan summary is unchanged.
const planCache = new Map();
const planSig = s => `${s.last_ts}|${s.plan?.done}|${s.plan?.total}|${s.plan?.cur}|${s.plan?.count}`;
async function plansFor(list) {
  const need = list.filter(s => planCache.get(s.path)?.sig !== planSig(s));
  if (need.length) {
    const got = await api.plans(need.map(s => s.path));
    for (const s of need) planCache.set(s.path, { sig: planSig(s), plans: got[s.path] || [] });
  }
  return Object.fromEntries(list.map(s => [s.path, planCache.get(s.path)?.plans || []]));
}
async function mapPlan() {
  const n = mapNodes.get(mapSel), s = n?.sess;
  if (!s?.plan || !$('#mp-plan')) return;
  const ps = (await plansFor([s]))[s.path], p = ps[ps.length - 1], el = $('#mp-plan');
  if (el) { el.className = p ? '' : 'st'; el.innerHTML = p ? stepList(p, ENDED(status(s))) : '단계 시각을 가져오지 못했습니다 (서버에 /api/plans 가 없으면 갱신 필요)'; }
}

// Edges over the laid-out nodes of every open group, redrawn when the layout changes.
let mpRO = null;
function mapEdges() {
  const grids = [...$('#view').querySelectorAll('.mp-grid')];
  if (!grids.length) return;
  const msgs = recentMsgs();
  for (const grid of grids) {
    const svg = grid.querySelector('.mp-edges');
    let edges = JSON.parse(grid.dataset.edges || '[]');
    if (msgs.length && !grid.dataset.msgs) {  // messages arrive after the first draw: merge them in once
      const g = mapGroupOf(grid.dataset.g);
      if (g) { const vis = {}; grid.querySelectorAll('[data-n]').forEach(b => (vis[b.dataset.n] = b.dataset.n)); edges = edges.concat(groupEdges(g, vis, msgs).filter(e => e.k === 'msg' && !edges.some(f => f.a === e.a && f.b === e.b && f.k === 'msg'))); }
      grid.dataset.msgs = '1'; grid.dataset.edges = JSON.stringify(edges);
    }
    const o = grid.getBoundingClientRect(), at = k => grid.querySelector(`[data-n="${CSS.escape(k)}"]`);
    svg.setAttribute('width', grid.scrollWidth); svg.setAttribute('height', grid.scrollHeight);
    svg.innerHTML = `<defs>${['spawn', 'dep', 'msg', 'bad'].map(k => `<marker id="mp-a-${k}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path class="mp-m ${k}" d="M0,0 L8,4 L0,8 z"/></marker>`).join('')}</defs>`
      + edges.map(e => {
        const A = at(e.a), B = at(e.b); if (!A || !B) return '';
        const a = A.getBoundingClientRect(), b = B.getBoundingClientRect(), L = r => r.left - o.left, T = r => r.top - o.top;
        let d;
        if ((e.k === 'spawn' || e.k === 'bad') && b.left >= a.right - 4) {  // parent → children: one trunk down the gap, a branch into each
          const x1 = L(a) + a.width, y1 = T(a) + Math.min(a.height / 2, 18), xt = x1 + 18, x2 = L(b) - 2, y2 = T(b) + b.height / 2;
          return `<path class="mp-e spawn" d="M${x1},${y1} H${xt} V${y2}"/><path class="mp-e ${e.k}" d="M${xt},${y2} H${x2}" marker-end="url(#mp-a-${e.k})"/>`;
        }
        if (b.left >= a.right - 4) { const x1 = L(a) + a.width, y1 = T(a) + a.height / 2, x2 = L(b) - 2, y2 = T(b) + b.height / 2, c = Math.max(12, (x2 - x1) / 2); d = `M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2} ${x2},${y2}`; }
        else if (a.left >= b.right - 4) { const x1 = L(a), y1 = T(a) + a.height / 2, x2 = L(b) + b.width + 2, y2 = T(b) + b.height / 2, c = Math.max(12, (x1 - x2) / 2); d = `M${x1},${y1} C${x1 - c},${y1} ${x2 + c},${y2} ${x2},${y2}`; }
        else { const x1 = L(a) + 14, y1 = b.top > a.top ? T(a) + a.height : T(a), x2 = L(b) + 14, y2 = b.top > a.top ? T(b) - 2 : T(b) + b.height + 2, c = (y2 - y1) / 2; d = `M${x1},${y1} C${x1 - 16},${y1 + c} ${x2 - 16},${y2 - c} ${x2},${y2}`; }
        return `<path class="mp-e ${e.k}" d="${d}" marker-end="url(#mp-a-${e.k})"/>`;
      }).join('');
  }
}
const mapGroupOf = key => mapLast?.groups.find(g => g.key === key);
function mapBind() {
  mpRO?.disconnect();
  const wrap = $('#view .mp-main');
  if (!wrap) return;
  mapEdges();
  mpRO = new ResizeObserver(() => mapEdges()); mpRO.observe(wrap);
  const rerender = () => { const sv = saveScroll(); renderAgents(); restoreScroll(sv); };
  const save = () => { try { localStorage.setItem('adash.min', JSON.stringify(famMin)); } catch {} };
  $('#view').querySelectorAll('[data-n]').forEach(b => b.onclick = () => {
    if (b.dataset.mpd) { famMin[b.dataset.mpd] = true; save(); return rerender(); }
    const k = b.dataset.n; mapSel = k && mapSel !== k ? k : null;
    try { mapSel ? localStorage.setItem('adash.mapsel', mapSel) : localStorage.removeItem('adash.mapsel'); } catch {}
    rerender();
    if (mapSel && PHONE.matches) $('#view .mp-side')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
  $('#view').querySelectorAll('[data-mpd][data-unfold]').forEach(b => b.onclick = () => { famMin[b.dataset.mpd] = false; save(); rerender(); });
  $('#view').querySelectorAll('[data-mpg], [data-mpb]').forEach(b => b.onclick = () => { famMin[b.dataset.mpg || b.dataset.mpb] = b.dataset.open !== '1'; save(); rerender(); });
  const more = $('#mp-more'); if (more) more.onclick = () => { mapMore += 40; rerender(); };
  $('#view').querySelectorAll('[data-mpbm]').forEach(b => b.onclick = () => { famMin[b.dataset.mpbm] = +b.dataset.n0 + 24; save(); rerender(); });
  flowOkBind();
  mapPlan();
}
// 「정상으로 표시」: the server stores it and leaves the deviation out from then on; the toast can take it back.
function flowOkBind() {
  $('#view').querySelectorAll('[data-flow-ok]').forEach(b => b.onclick = async () => {
    const x = (state.flow?.items || []).find(y => y.id === b.dataset.flowOk && (y.server || '') === b.dataset.srv);
    if (!x) return;
    b.disabled = true; b.textContent = '저장 중…';
    const r = await api.flowOk(x.server, x.id, true, { rule: x.rule, reason: x.reason });
    if (r.status !== 200) { b.disabled = false; b.textContent = '정상으로 표시'; return uiAlert(r.body?.error || `저장 실패 (${r.status})`); }
    await refresh();
    toast(`「${cut(x.reason, 30)}」 정상으로 표시`, async () => { await api.flowOk(x.server, x.id, false); await refresh(); });
  });
}

// ---------- 진행 타임라인: one coordinator and the agents below it on one time axis ----------
let tlSel = null;
try { tlSel = localStorage.getItem('adash.tlcoord') || null; } catch {}
let tlToken = 0, tlWin = null;  // hours shown (0 = all); null = all for a small tree, the last 6 hours for a big one
try { const v = localStorage.getItem('adash.tlwin'); tlWin = v === null ? null : +v; } catch {}
const TL_WIN = [[2, '2시간'], [6, '6시간'], [24, '24시간'], [0, '전체']], TL_MAX = 80;
function tlChoices() {
  const { groups } = mapModel();
  return groups.flatMap(g => g.bands.filter(b => b.coord.sess && (b.work.length || b.review.length || b.coord.sess.role === 'coordinator')).map(b => ({ b, g })));
}
function tlHtml() {
  needReviews();
  const ch = tlChoices();
  if (!ch.length) return '<div class="empty">시간축에 놓을 코디네이터가 없습니다.</div>';
  const pick = ch.find(x => x.b.coord.id === tlSel) || ch[0];
  const opt = x => { const n = x.b.coord, d = bandNodes(x.b).reduce((a, y) => a + y.devs.length, 0);
    return `<option value="${esc(n.id)}"${x === pick ? ' selected' : ''}>${d ? `⚠${d} ` : ''}${esc(cutW(n.name, 50))} · ${esc(NODE_ST[n.st] || '')} · 하위 ${x.b.work.length + x.b.review.length}</option>`; };
  return `<div class="controls tl-ctl"><label>코디네이터 <select id="tl-pick" class="field">${ch.map(opt).join('')}</select></label>
      <span class="seg" id="tl-win" role="group" aria-label="기간">${TL_WIN.map(([h, l]) => `<button type="button" data-h="${h}">${h ? '최근 ' + l : l}</button>`).join('')}</span></div>
    <div class="legend tl-leg"><span><i class="tl-k bar"></i>막대 = aplan 계획 단계(시작~끝)</span><span><i class="tl-k act"></i>회색 막대 = 계획 없음(첫 기록~마지막 기록)</span><span><i class="tl-k ghost"></i>점선 틀 = 기대 시간(같은 Run 의 끝난 형제 중앙값)</span><span><i class="tl-k hatch"></i>빗금 = 결과 없음 · 응답 없음</span><span><i class="tl-k msg"></i>보라 점선 = 메시지</span><span><i class="tl-k now"></i>파란 선 = 지금</span></div>
    <div id="tl-body" data-pick="${esc(pick.b.coord.id)}"><div class="empty">계획을 불러오는 중…</div></div>`;
}
const TL_ROW = 34, TL_LABEL = 190;
const STEP_WORD = { done: '완료', skip: '건너뜀', fail: '실패', run: '진행 중' };
async function tlFill() {
  const el = $('#tl-body'), id = el?.dataset.pick;
  if (!el) return;
  const pick = tlChoices().find(x => x.b.coord.id === id);
  if (!pick) return;
  const my = ++tlToken;
  const { b, g } = pick, rows = [];
  const push = (n, depth) => rows.push({ n, depth });
  push(b.coord, 0);
  const bands = g.bands.filter(x => x === b || (() => { for (let p = x.coord.parent; p;) { if (p === b.coord.id) return true; p = g.bands.find(y => y.coord.id === p)?.coord.parent; } return false; })());
  for (const x of bands) { if (x !== b) push(x.coord, x.depth - b.depth); [...x.work, ...x.review].sort((p, q) => (taskT0(p) || Infinity) - (taskT0(q) || Infinity)).forEach(n => push(n, x.depth - b.depth + 1)); }
  // The window and the row cap come before fetching plans: a tree of hundreds of workers draws its recent part.
  const win = tlWin ?? (rows.length > 40 ? 6 : 0), from = win ? Date.now() - win * 3600e3 : 0;
  $('#tl-win')?.querySelectorAll('button').forEach(x => { x.classList.toggle('on', +x.dataset.h === win); x.setAttribute('aria-pressed', +x.dataset.h === win); });
  const planned = rows.filter((r, i) => i && !r.n.sess).length;
  let shown = rows.filter((r, i) => !i || (r.n.sess && taskT0(r.n) && (!from || (taskT1(r.n) ?? Date.now()) >= from)));
  if (shown.length > TL_MAX) { const keep = new Set([shown[0], ...shown.slice(1).sort((p, q) => (taskT1(q.n) || 0) - (taskT1(p.n) || 0)).slice(0, TL_MAX - 1)]); shown = shown.filter(r => keep.has(r)); }
  const meta = { from, planned, out: rows.length - planned - shown.length, win, handles: bands.flatMap(x => [x.fam?.handle, ...(x.fam?.extra || [])].filter(Boolean).map(h => [h, x.coord.id])) };
  const sess = [...new Set(shown.map(r => r.n.sess).filter(Boolean))];
  const draw = plans => { if (my === tlToken && $('#tl-body') === el) { el.innerHTML = tlBody(shown, plans, meta); tlBind(); } };
  if (sess.every(s => planCache.get(s.path)?.sig === planSig(s))) draw(Object.fromEntries(sess.map(s => [s.path, planCache.get(s.path).plans])));
  else { if (!el.querySelector('.tl')) draw(Object.fromEntries(sess.map(s => [s.path, planCache.get(s.path)?.plans || []]))); draw(await plansFor(sess)); }
  if (!talk.data) { await talkOnce(); if (talk.data && my === tlToken) tlFill(); }
}
// When a row's work started: its task's start (a reused session takes the task later), else the session's.
const taskT0 = n => { const t = n.taskId && IX.tasks[n.taskId], s = n.sess; const a = s?.started && toDate(s.started).getTime(), c = t?.created_at && toDate(t.created_at).getTime(); return a ? Math.max(a, c || 0) : c || null; };
const taskT1 = n => { const t = n.taskId && IX.tasks[n.taskId], s = n.sess;
  if (t?.completed_at) return toDate(t.completed_at).getTime();
  if (s) return OPEN(status(s)) ? Date.now() : toDate(s.last_ts).getTime();
  return null; };
function tlBody(rows, plans, meta = {}) {
  const now = Date.now(), live = rows.some(r => r.n.sess && OPEN(status(r.n.sess)));
  const t0s = rows.map(r => taskT0(r.n)).filter(Boolean), t1s = rows.map(r => taskT1(r.n)).filter(Boolean);
  if (!t0s.length) return '<div class="empty">시작한 에이전트가 없습니다.</div>';
  const T0 = Math.max(Math.min(...t0s), meta.from || 0), T1 = Math.max(live ? now : Math.max(...t1s), T0 + 10 * 60e3);
  const W = Math.max(560, ($('#tl-body')?.clientWidth || 900) - TL_LABEL - 24), X = t => (t - T0) / (T1 - T0) * W;
  const span = (T1 - T0) / 60e3, steps = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440], step = steps.find(s => W / (span / s) >= 70) || 1440;
  const ticks = []; for (let m = 0; m <= span; m += step) ticks.push(`<span style="left:${X(T0 + m * 60e3)}px">${m < 60 ? m + '분' : Math.floor(m / 60) + '시간' + (m % 60 ? ' ' + m % 60 + '분' : '')}</span>`);
  const missingOf = new Map();  // reviewer task -> the verdict that passed without it
  for (const x of state.flow?.items || []) if (x.rule === 'missing') for (const id of x.task_ids.slice(1)) missingOf.set(id, x);
  const rowOf = new Map();
  rows.forEach((r, i) => { for (const h of r.n.sess ? [r.n.sess.own_handle, r.n.sess.orca_focus] : []) if (h && !rowOf.has(h)) rowOf.set(h, i); });
  for (const [h, id] of meta.handles || []) { const i = rows.findIndex(r => r.n.id === id); if (i >= 0 && !rowOf.has(h)) rowOf.set(h, i); }  // a coordinator's script drivers
  const bar = (a, b, cls, label, tip) => { const l = X(Math.max(a, T0)), w = Math.max(3, X(Math.min(b, T1)) - l); return `<div class="tl-b ${cls}" style="left:${l}px;width:${w}px" title="${esc(tip)}">${w > 34 ? esc(label) : ''}</div>`; };
  const track = r => {
    const n = r.n, s = n.sess, a = taskT0(n), z = taskT1(n);
    if (!s || !a) return `<span class="st tl-none">${esc(NODE_ST[n.st] || '')}${n.item?.open ? ' · 선행 ' + esc(cut(n.item.deps.join(', '), 40)) : ''}</span>`;
    let h = '';
    const t = n.taskId && IX.tasks[n.taskId], e = t && taskLeft(t)?.e;
    if (e && a + e.ms > T0) { const g1 = a + e.ms; h += `<div class="tl-ghost${g1 > T1 ? ' open' : ''}" style="left:${X(Math.max(a, T0))}px;width:${X(Math.min(g1, T1)) - X(Math.max(a, T0))}px" title="기대 ${mins(e.ms)} · 같은 Run${e.role ? ` · 같은 역할(${esc(e.role)})` : ''}의 끝난 형제 ${e.n}개 중앙값${g1 > T1 ? ' · 기대 끝은 아직 오지 않음' : ''}"></div>`; }
    const ended = ENDED(status(s)), stalled = status(s) === 'stalled', last = toDate(s.last_ts).getTime();
    const steps = (plans[s.path] || []).flatMap(p => p.steps.map((x, i) => ({ ...x, i, n: p.steps.length })))
      .filter(x => x.ts0 && x.st !== 'todo').map(x => ({ ...x, a: new Date(x.ts0).getTime(), b: x.ts1 ? new Date(x.ts1).getTime() : x.st === 'run' && !ended && !stalled ? Math.min(now, z || now) : last }))
      .filter(x => x.b > a - 60e3 && x.a < (z || now) + 60e3);  // a reused session: only the steps inside this task's own window
    if (steps.length) for (const x of steps) { const st = ended && x.st === 'run' ? 'miss' : x.st;
      h += bar(Math.max(x.a, a), Math.min(x.b, z || x.b), 'st-' + st, x.t, `계획 단계 ${x.i + 1}/${x.n} · ${x.t} · ${st === 'miss' ? '표시 안 됨(세션 종료)' : STEP_WORD[x.st] || ''} · ${hhmm(new Date(x.a).toISOString())}~${x.ts1 ? hhmm(x.ts1) : st === 'run' ? '지금' : hhmm(s.last_ts)} (${mins(Math.max(0, Math.min(x.b, z || x.b) - x.a))})`); }
    else { const why = s.plan && !(plans[s.path] || []).length ? '계획 시각 없음' : '계획 없음';  // a plan the server could not send times for is not 「계획 없음」
      h += bar(a, z || last, 'act', why, `${why} · 첫 기록 ${hhmm(new Date(a).toISOString())} ~ ${OPEN(status(s)) ? '지금' : '마지막 기록 ' + hhmm(s.last_ts)}`); }
    if (stalled) h += bar(last, now, 'hatch bad', `응답 없음 ${human((now - last) / 1000)}`, `응답 없음 — 마지막 기록 ${hhmm(s.last_ts)} 이후 ${human((now - last) / 1000)}`);
    const miss = n.taskId && missingOf.get(n.taskId);
    if (miss) { const v = IX.tasks[miss.task_id], vd = v?.completed_at ? toDate(v.completed_at).getTime() : now; h += bar(a, Math.max(vd, a + 60e3), 'hatch', '결과 없음', `결과 없음 — 판정이 ${v?.completed_at ? hhmm(toDate(v.completed_at).toISOString()) : ''}에 이 리뷰 없이 통과`); }
    return h;
  };
  const msgs = (talk.data?.messages || []).filter(m => m.type !== 'heartbeat' && m.created_at && rowOf.has(m.from_term) && rowOf.has(m.to_term) && m.from_term !== m.to_term)
    .map(m => ({ m, t: toDate(m.created_at).getTime(), a: rowOf.get(m.from_term), b: rowOf.get(m.to_term) })).filter(x => x.t >= T0 && x.t <= T1);
  const lines = msgs.map(x => { const top = Math.min(x.a, x.b) * TL_ROW + TL_ROW / 2, hgt = Math.abs(x.a - x.b) * TL_ROW;
    return `<div class="tl-msg" style="left:${X(x.t)}px;top:${top}px;height:${hgt}px" title="${esc(`${TALK_TYPES[x.m.type]?.[0] || x.m.type} · ${hhmm(toDate(x.m.created_at).toISOString())} · ${rows[x.a].n.name} → ${rows[x.b].n.name}\n${x.m.subject || ''}`)}"><i style="top:${x.b > x.a ? hgt - 4 : -2}px"></i></div>`; }).join('');
  const label = r => { const n = r.n, d = n.devs?.length; const nm = `${r.depth ? '└ '.padStart(r.depth * 2 + 1, ' ') : ''}${cutW(n.name, 26)}`;
    return `<span class="tl-l" title="${esc(n.name)}">${n.sess ? `<a href="#s=${encodeURIComponent(n.sess.path)}">${esc(nm)}</a>` : esc(nm)}${d ? ` <span class="mp-dev ${sevOf(n.devs) === 2 ? 'bad' : 'warn'}">⚠${d}</span>` : ''}</span>`; };
  const devRows = rows.filter(r => r.n.devs?.length), okRows = rows.filter(r => r.n.sess && judged(r.n) && !r.n.devs?.length && ENDED_ST(r.n.st) && r.n.st !== 'fail');
  const okCards = okRows.slice(0, 3).map(r => { const s = r.n.sess, pl = (plans[s.path] || []).slice(-1)[0], t = r.n.taskId && IX.tasks[r.n.taskId];
    const inOrder = pl && pl.steps.every((x, i, xs) => x.st === 'done' && (!i || (xs[i - 1].ts1 || '') <= (x.ts1 || '')));
    const took = taskT0(r.n) && taskT1(r.n) ? taskT1(r.n) - taskT0(r.n) : null, med = t && estIndex().durs[t.run_id]?.length ? (() => { const ds = estIndex().durs[t.run_id].filter(d => d.role === roleOf(t)); return ds.length ? median(ds.map(d => d.ms)) : null; })() : null;
    return `<div class="box tl-card ok"><b>✓ ${esc(cutW(r.n.name, 34))} — 정상</b><div class="st">${pl ? `aplan ${pl.steps.length}단계를 ${[inOrder && '순서대로', pl.steps.every(x => x.st === 'done' || x.st === 'skip') ? '모두 끝냄' : '일부 남김'].filter(Boolean).join(' ')}` : '계획 없이 끝남'}${took && med ? ` · ${mins(took)} (형제 중앙값 ${mins(med)})` : took ? ` · ${mins(took)}` : ''}</div></div>`; }).join('');
  const devCards = devRows.flatMap(r => r.n.devs.map(x => `<div class="box tl-card ${x.severity}"><b>⚠ ${esc(cutW(r.n.name, 30))} — ${esc(x.rule_name)}</b><div>${esc(x.reason)}</div><ul class="st">${x.evidence.map(e => `<li>${esc(e)}</li>`).join('')}</ul>
    <button type="button" class="act" data-flow-ok="${esc(x.id)}" data-srv="${esc(x.server || '')}">정상으로 표시</button></div>`)).join('');
  return `<div class="tscroll tl-scroll"><div class="tl" style="width:${TL_LABEL + W + 16}px">
      <div class="tl-ax" style="padding-left:${TL_LABEL}px"><div style="width:${W}px">${ticks.join('')}</div></div>
      <div class="tl-rows" style="--tl-w:${W}px">${rows.map(r => `<div class="tl-row st-${r.n.st}">${label(r)}<div class="tl-tr">${track(r)}</div></div>`).join('')}
        <div class="tl-over" style="left:${TL_LABEL}px;width:${W}px">${lines}${live ? `<div class="tl-now" style="left:${X(now)}px" title="지금 ${hhmm(new Date(now).toISOString())}"></div>` : ''}</div></div>
      <div class="st tl-foot">시작 ${esc(new Date(T0).toLocaleString('ko-KR', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }))} 기준 경과 · ${live ? '지금까지' : '마지막 기록까지'} · 에이전트 ${rows.filter(r => r.n.sess).length}${meta.out ? ` · 기간 밖·상한(${TL_MAX}줄)으로 뺀 에이전트 ${meta.out}` : ''}${meta.planned ? ` · 생성 예정 ${meta.planned}(시작 전이라 그리지 않음)` : ''} · 메시지 ${msgs.length}${talk.data ? '' : ' (메시지 불러오는 중)'}</div></div></div>
    <div class="tl-cards">${devCards || (rows.some(r => judged(r.n)) ? '<div class="box tl-card ok"><b>✓ 이 코디네이터 아래 흐름 이탈 없음</b></div>' : '<div class="box tl-card"><b>이 에이전트들의 메트릭 서버는 흐름 판정을 보내지 않습니다</b></div>')}${okCards}</div>`;
}
function tlBind() {
  flowOkBind();
  $('#tl-win')?.querySelectorAll('button').forEach(b => b.onclick = () => { tlWin = +b.dataset.h; try { localStorage.setItem('adash.tlwin', tlWin); } catch {} tlFill(); });
  const sel = $('#tl-pick');
  if (sel) sel.onchange = () => { tlSel = sel.value; try { localStorage.setItem('adash.tlcoord', tlSel); } catch {} renderAgents(); };
}

function agViewBind() {
  $('#ag-view').querySelectorAll('button').forEach(b => {
    b.classList.toggle('on', b.dataset.k === agView);
    b.setAttribute('aria-pressed', b.dataset.k === agView);
    b.onclick = () => { agView = b.dataset.k; try { localStorage.setItem('adash.agview', agView); } catch {} renderAgents(); };
  });
}
// ---------- 캐릭터 모드: the agents tab as an office ----------
// Same sessions and filters as the tree. A worktree is one room (coordinators first, then by state), and rooms one
// family spans are linked person to person by a line in the family's colour (officeRooms, chLinks). A room is one scene (wall with decorations, floor); each agent is one of six original
// anime-style characters (frontend/chars, made by scripts/char-sprites.py), framed whole or from the waist up
// (charFrame) and drawn in one of two styles (charStyle), both set in the bar's 「캐릭터 설정」 panel (charPanel): 「AI 생성」
// shows the generated pose for the state as an SD chibi in pixel art, 「Live2D」 deforms the illustration live
// (breathing, head tilt, hair on a spring, blinking — L2D). The pose and speech bubble carry the state (a sign and words, not motion alone — A3). A person is a button: a click opens the session like a card. People
// stand on the room's grid in order (chLayout) and are not moved by hand.
let charStyle = 'ai';  // ai | l2d
try { charStyle = localStorage.getItem('adash.charstyle') === 'l2d' ? 'l2d' : 'ai'; } catch {}
let charFrame = 'bust';  // bust | full
try { charFrame = localStorage.getItem('adash.charframe') === 'full' ? 'full' : 'bust'; } catch {}
const CH_SIGN = { bg: '◍', stalled: '!', idle: 'z', done: '✓' };
const isBoss = s => s.role === 'coordinator' || isSubCoord(s);
const chHash = t => { let h = 0; for (const c of String(t)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
// A sheet is 8 frames in a row (w × h each, top = where the head starts as a share of h), one pose per frame. full and
// bust are anime illustrations (Live2D); sd and sdb are the same character as an SD chibi in pixel art, whole and from
// the waist up (AI 생성, pw × ph):
// 0 standing, 1 typing on a laptop, 2 coffee, 3 worried, 4 dozing, 5 peace sign, 6 hand up, 7 frame 0 with eyes shut.
// The coordinators (kaede, yuki) wear a headset; a session's hash picks the person, so they keep theirs across refreshes.
const CH_ART = {
  aoi: {full:{w:157,h:320,top:[0.016,0.025,0.019,0.016,0.031,0.016,0.038,0.019]},bust:{w:189,h:240,top:[0.096,0.096,0.096,0.096,0.092,0.096,0.096,0.096]},sd:{pw:60,ph:83,top:[0.024,0.024,0.024,0.024,0.036,0.012,0.036,0.012]},sdb:{pw:81,ph:83,top:[0.036,0.036,0.036,0.036,0.06,0.024,0.048,0.024]}},
  ren: {full:{w:151,h:320,top:[0.022,0.028,0.022,0.025,0.031,0.028,0.031,0.031]},bust:{w:189,h:240,top:[0.058,0.058,0.058,0.058,0.054,0.058,0.058,0.058]},sd:{pw:58,ph:81,top:[0.037,0.037,0.037,0.025,0.037,0.037,0.037,0.037]},sdb:{pw:77,ph:81,top:[0.049,0.049,0.049,0.037,0.049,0.049,0.049,0.037]}},
  hina: {full:{w:138,h:320,top:[0.025,0.016,0.022,0.019,0.009,0.031,0.05,0.019]},bust:{w:182,h:240,top:[0.021,0.021,0.021,0.021,0.021,0.017,0.021,0.021]},sd:{pw:58,ph:81,top:[0.012,0.012,0.012,0.012,0.037,0.037,0.025,0.025]},sdb:{pw:77,ph:81,top:[0.025,0.025,0.025,0.025,0.049,0.049,0.049,0.049]}},
  sora: {full:{w:147,h:320,top:[0.025,0.028,0.028,0.025,0.053,0.038,0.066,0.031]},bust:{w:174,h:240,top:[0.125,0.125,0.121,0.121,0.129,0.121,0.121,0.125]},sd:{pw:57,ph:82,top:[0.049,0.037,0.024,0.037,0.061,0.061,0.073,0.049]},sdb:{pw:77,ph:81,top:[0.037,0.049,0.037,0.037,0.074,0.086,0.086,0.062]}},
  kaede: {full:{w:175,h:320,top:[0.025,0.025,0.019,0.034,0.022,0.019,0.031,0.038]},bust:{w:180,h:240,top:[0.108,0.108,0.112,0.108,0.108,0.108,0.112,0.108]},sd:{pw:61,ph:82,top:[0.024,0.012,0.024,0.012,0.024,0.012,0.024,0.012]},sdb:{pw:81,ph:82,top:[0.024,0.024,0.024,0.024,0.037,0.024,0.037,0.024]}},
  yuki: {full:{w:157,h:320,top:[0.028,0.031,0.031,0.034,0.031,0.031,0.034,0.028]},bust:{w:184,h:240,top:[0.067,0.067,0.067,0.067,0.067,0.067,0.067,0.088]},sd:{pw:60,ph:84,top:[0.048,0.012,0.012,0.036,0.048,0.024,0.012,0.024]},sdb:{pw:80,ph:85,top:[0.059,0.024,0.012,0.035,0.071,0.024,0.024,0.035]}},
};
const CH_BOSS = ['kaede', 'yuki'], CH_CREW = ['aoi', 'ren', 'hina', 'sora'];
// More people without a deploy: chars/chars.json (the R2 bucket behind functions/chars, written by
// scripts/char-publish.py) is { chars: { <who>: { name, look, boss, v, art: { full, bust, sd, sdb } } } }, the strips
// beside it. Read on load and again with every build check (each minute, and when the page comes back), so a person
// put up — from the 「캐릭터」 tab's 「새 캐릭터」 or by hand — shows without a reload; v goes on their picture URLs, so a
// redrawn one shows too. Each read starts again from the built-in six, so a person taken down leaves. Added people
// join the lists after the six, so a session already drawn may change hands once. hidden: [<who>] lists built-in people
// taken down from the tab (char-publish.py --remove); they leave the lists, but never the last one of a list.
let chSeen = '', chBase = null;
const chVer = {}, chR2 = new Set(), chHidden = new Set();  // chR2: everyone chars.json lists; chHidden: built-ins taken down
async function chLoad() {
  let t, j;
  try { const r = await fetch('chars/chars.json', { cache: 'no-cache' }); t = r.ok ? await r.text() : '{}'; j = JSON.parse(t); } catch { return; }
  if (t === chSeen) return;
  chSeen = t;
  chBase ||= { art: { ...CH_ART }, info: { ...CH_INFO }, boss: [...CH_BOSS], crew: [...CH_CREW] };
  for (const k of Object.keys(CH_ART)) if (!(k in chBase.art)) { delete CH_ART[k]; delete CH_INFO[k]; }
  Object.assign(CH_ART, chBase.art); Object.assign(CH_INFO, chBase.info);
  CH_BOSS.splice(0, Infinity, ...chBase.boss); CH_CREW.splice(0, Infinity, ...chBase.crew);
  for (const k of Object.keys(chVer)) delete chVer[k];
  chR2.clear();
  for (const [who, c] of Object.entries(j?.chars || {})) {
    if (!/^[a-z0-9-]+$/.test(who) || !['full', 'bust', 'sd', 'sdb'].every(k => c?.art?.[k]?.top?.length === 8)) continue;
    CH_ART[who] = c.art;
    CH_INFO[who] = [String(c.name || who), String(c.look || '')];
    if (c.v) chVer[who] = String(c.v);
    chR2.add(who);
    if (!CH_BOSS.includes(who) && !CH_CREW.includes(who)) (c.boss ? CH_BOSS : CH_CREW).push(who);
  }
  chHidden.clear();
  for (const who of Array.isArray(j?.hidden) ? j.hidden : []) {
    const l = who in chBase.art && !chR2.has(who) && [CH_BOSS, CH_CREW].find(x => x.includes(who));
    if (!l || l.length < 2) continue;
    l.splice(l.indexOf(who), 1);
    delete CH_ART[who]; delete CH_INFO[who];
    chHidden.add(who);
  }
  chReady = true;
  if (state) { chPin(state.all); chxMounted = false; render(); }
}
// 「캐릭터」 tab: a person switched off (false) is left out of the office; a list with everyone off keeps them all.
let chPool = {};
try { chPool = JSON.parse(localStorage.getItem('adash.chpool') || '{}'); } catch {}
const chIn = l => { const k = l.filter(w => chPool[w] !== false); return k.length ? k : l; };
// A session's person is kept in its server's metadata (prefs.json chars → s.char: { who, boss, pick }), so the office,
// the detail, the chat and every device draw the same one whichever copy of the session they hold. chPin runs over
// the snapshot after each refresh: a session without one is given the hash's pick (from the list for its role, boss),
// and a kept one is picked again only when it was the hash's and the role has changed, or its person is gone or
// switched off here (the 「캐릭터」 tab). Before chars.json is read nothing is kept (a person put up there would look
// gone), and a session nothing is kept for yet (a pending terminal, a moment before the reply) shows the hash's pick.
// A person picked in a session's detail is kept the same way with pick, which no role change or switch undoes.
// adash.chpick: picks this device kept before; sent up once, and the server's wins.
let chPick = {}, chReady = false;
try { chPick = JSON.parse(localStorage.getItem('adash.chpick') || '{}'); } catch {}
const chAuto = s => { const l = chIn(isBoss(s) ? CH_BOSS : CH_CREW); return l[chHash(s.id || s.path) % l.length]; };
// A copy without char (the detail read before the snapshot kept one) goes by the snapshot's copy of the session.
const chSnap = s => s.char ? s : state?.all?.find(x => x.path === s.path) || s;
const chWho = s => { const t = chSnap(s); return CH_ART[t.char?.who] ? t.char.who : chAuto(t); };
const chSent = new Set();
function chPin(list) {
  if (!chReady) return;
  const want = {};
  for (const s of list) {
    if (!s.path || s.path.startsWith('orca-terminal:')) continue;
    const c = s.char, old = chPick[s.id || s.path], boss = isBoss(s);
    let n = null;
    if (old && CH_ART[old] && !c?.pick) n = { who: old, boss, pick: true };
    else if (!c || !CH_ART[c.who] || !c.pick && (c.boss !== boss || !chIn(boss ? CH_BOSS : CH_CREW).includes(c.who))) n = { who: chAuto(s), boss, pick: false };
    if (old) { delete chPick[s.id || s.path]; try { localStorage.setItem('adash.chpick', JSON.stringify(chPick)); } catch {} }
    if (!n || c && n.who === c.who && n.boss === c.boss && n.pick === c.pick) continue;
    s.char = n;
    const key = JSON.stringify(n);
    if (chSent.has(s.path + key)) continue;
    chSent.add(s.path + key);
    (want[key] ||= []).push(s.path);
  }
  for (const [key, ps] of Object.entries(want)) api.pref('char', ps, JSON.parse(key)).catch(() => {});
}
// Keep a person for one session by hand (who) or hand it back to the hash (null), on this page at once.
function chSet(d, who) {
  const t = state?.all?.find(x => x.path === d.path) || d, boss = isBoss(t);
  const n = { who: who || chAuto(t), boss, pick: !!who };
  for (const s of new Set([d, t])) s.char = n;
  chSent.add(d.path + JSON.stringify(n));
  api.pref('char', [d.path], n).catch(() => {});
}
const chMove = (st, s) => s.decision ? 'dec' : st;
const CH_POSE = { run: 1, bg: 2, wait: 0, stalled: 3, idle: 4, done: 5, dec: 6 };
const chV = who => chVer[who] ? '?v=' + chVer[who] : '';
const chSrc = (who, fr) => `chars/${who}-${fr}.webp${chV(who)}`;
const chSd = fr => fr === 'bust' ? 'sdb' : 'sd', chSdSrc = (who, fr) => `chars/${who}-sd${fr === 'bust' ? '-bust' : ''}.png${chV(who)}`;
const CH_H = { bust: 132, full: 196 };
function chFig(st, s, small) {  // small: the session detail's header (1.5× pixels on a 2× screen, a shorter canvas)
  const who = chWho(s), a = CH_ART[who][charFrame], mv = chMove(st, s), f = CH_POSE[mv] ?? 0;
  const H = Math.round(CH_H[charFrame] * (small ? .72 : 1)), W = Math.round(a.w * H / a.h), x = small ? (devicePixelRatio >= 2 ? 1.5 : 1) : 2;
  if (charStyle === 'l2d') return `<canvas class="ch-fig fig-l2d ${charFrame}" width="${W * 2}" height="${H * 2}" style="width:${W}px;height:${H}px" data-who="${who}" data-mv="${mv}" aria-hidden="true"></canvas>`;
  // AI 생성: the SD pixel sprite at a whole 2× (in the detail 1.5×, a whole 3 device pixels on a 2× screen), so every
  // sprite pixel is a crisp block
  const sd = CH_ART[who][chSd(charFrame)], pw = sd.pw * x, ph = sd.ph * x;
  return `<span class="ch-fig fig-ai" style="width:${pw}px;height:${ph}px;background-image:url(${chSdSrc(who, charFrame)});background-size:${pw * 8}px ${ph}px;background-position:${-f * pw}px 0" aria-hidden="true"></span>`;
}

// Live2D: one shared WebGL canvas (a page may hold only ~16 contexts) renders each visible person's frame as a mesh the
// vertex shader bends — the head turns about the neck, the upper body rises with each breath, hair beside the face
// swings behind the head on a damped spring, the whole figure sways — and each person's own 2D canvas copies it. While
// standing still the face blinks by crossfading to frame 7. Without WebGL the frame is drawn flat with the same bob.
const L2D_MOVE = {  // t in seconds → tilt (rad), breath, sway, bob (shares of the frame), blink allowed
  wait: t => [.03 * Math.sin(t * .9), .006 * Math.sin(t * 2.1), .004 * Math.sin(t * .7), 0, true],
  run: t => [.04 + .025 * Math.sin(t * 4.2), .007 * Math.sin(t * 3.4), .002 * Math.sin(t * 1.3), .004 * Math.abs(Math.sin(t * 4.2)), false],
  bg: t => [.04 * Math.sin(t * .8), .007 * Math.sin(t * 1.8), .006 * Math.sin(t * .8), 0, false],
  stalled: t => [.012 * Math.sin(t * 23), .004 * Math.sin(t * 5), .003 * Math.sin(t * 31), 0, false],
  idle: t => [.06 + .03 * Math.sin(t * .6), .011 * Math.sin(t * 1.2), .003 * Math.sin(t * .6), .004 * (1 + Math.sin(t * 1.2)), false],
  done: t => [.05 * Math.sin(t * 1.6), .006 * Math.sin(t * 3), .006 * Math.sin(t * 1.6), .022 * Math.abs(Math.sin(t * 3.2)), false],
  dec: t => [.06 * Math.sin(t * 2), .006 * Math.sin(t * 2.6), .01 * Math.sin(t * 2.4), .006 * Math.abs(Math.sin(t * 2)), false],
};
const L2D = (() => {
  const VS = `attribute vec2 a; uniform vec4 m; uniform vec4 p; uniform vec2 h; varying vec2 q;
    void main() {
      float ny = p.x, k = p.y, hs = p.z;  // neck y, frame aspect w/h, head size (share of h)
      vec2 o = a;
      float head = smoothstep(ny + .04 * hs, ny - .06 * hs, a.y);
      vec2 d = (a - vec2(.5, ny)) * vec2(k, 1.); float an = m.x * head;
      d = vec2(d.x * cos(an) - d.y * sin(an), d.x * sin(an) + d.y * cos(an));
      o = vec2(.5, ny) + d / vec2(k, 1.);
      float side = smoothstep(.1, .3, abs(a.x - .5)), band = smoothstep(ny - .8 * hs, ny - .3 * hs, a.y) * (1. - smoothstep(ny + .3 * hs, ny + 1.1 * hs, a.y));
      o.x += (h.x + h.y * sin(p.w * 2.3 - a.y * 9.)) * side * band * (a.y - ny + hs) / hs;
      float up = clamp((1. - a.y) / (1. - ny), 0., 1.);
      o.y -= m.y * up + m.w;
      o.x += m.z * (1. - a.y);
      o = .04 + o * .92;
      gl_Position = vec4(o.x * 2. - 1., 1. - o.y * 2., 0., 1.);
      q = a;
    }`;
  const FS = `precision mediump float; uniform sampler2D t; uniform vec3 f; uniform vec4 e; varying vec2 q;
    void main() {  // f: frame, blink amount, -; e: eye band centre x,y and radii
      vec4 c = texture2D(t, vec2((f.x + q.x) / 8., q.y));
      if (f.y > 0.) { vec2 r = (q - e.xy) / e.zw; float w = f.y * (1. - smoothstep(.7, 1., length(r)));
        c = mix(c, texture2D(t, vec2((7. + q.x) / 8., q.y)), w); }
      gl_FragColor = c;
    }`;
  let gl = null, cv = null, u = {}, tex = new Map(), raf = 0, last = 0, io = null;
  const shown = new Set(), spring = new Map(), imgs = new Map();
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  function init() {
    cv = document.createElement('canvas');
    gl = cv.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true, alpha: true });
    if (!gl) return;
    const sh = (type, src) => { const x = gl.createShader(type); gl.shaderSource(x, src); gl.compileShader(x); return x; };
    const pr = gl.createProgram();
    gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) { gl = null; return; }
    gl.useProgram(pr);
    const N = 24, v = [], ix = [];  // an N × N grid of the frame
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) v.push(i / N, j / N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const k = j * (N + 1) + i; ix.push(k, k + 1, k + N + 1, k + 1, k + N + 2, k + N + 1); }
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(ix), gl.STATIC_DRAW);
    const al = gl.getAttribLocation(pr, 'a'); gl.enableVertexAttribArray(al); gl.vertexAttribPointer(al, 2, gl.FLOAT, false, 0, 0);
    u.n = ix.length; ['m', 'p', 'h', 'f', 'e'].forEach(k => u[k] = gl.getUniformLocation(pr, k));
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }
  const img = src => { if (!imgs.has(src)) { const im = new Image(); im.src = src; im.onload = () => kick(); imgs.set(src, im); } return imgs.get(src); };
  function texOf(src) {
    if (tex.has(src)) return tex.get(src);
    const im = img(src);
    if (!im.complete || !im.naturalWidth) return null;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, im);
    [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T].forEach(k => gl.texParameteri(gl.TEXTURE_2D, k, gl.CLAMP_TO_EDGE));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    tex.set(src, t);
    return t;
  }
  function draw(c, t, dt) {
    const who = c.dataset.who, mv = c.dataset.mv, fr = c.dataset.fr, a = CH_ART[who][fr], f = CH_POSE[mv] ?? 0, src = chSrc(who, fr);
    const id = c.closest('.ch')?.dataset.id || who, ph = (chHash(id) % 1000) / 160, T = t + ph;
    const [tilt, br, sway, bob, blinks] = (L2D_MOVE[mv] || L2D_MOVE.wait)(T);
    // hair: a damped spring pulled by the head's tilt and the body's sway, so it lags and overshoots
    const sp = spring.get(id) || { x: 0, v: 0 }; spring.set(id, sp);
    const pull = -(tilt * .05 + sway * 2.5);
    sp.v += ((pull - sp.x) * 60 - sp.v * 7) * dt; sp.x += sp.v * dt;
    const blink = blinks && T % 4.2 < .16 ? Math.sin(T % 4.2 / .16 * Math.PI) : 0;
    const ctx = c.getContext('2d'), W = c.width, H = c.height;
    ctx.clearRect(0, 0, W, H);
    if (!gl) {  // flat fallback
      const im = img(src);
      if (im.complete && im.naturalWidth) ctx.drawImage(im, f * a.w, 0, a.w, a.h, W * .04, H * (.04 - br - bob), W * .92, H * .92);
      return;
    }
    const tx = texOf(src);
    if (!tx) return;
    if (cv.width < W || cv.height < H) { cv.width = Math.max(cv.width, W); cv.height = Math.max(cv.height, H); }
    const top = a.top[f], full = fr === 'full', hs = full ? .11 : .34, ny = top + (full ? .12 : .36);
    gl.viewport(0, cv.height - H, W, H);  // the top-left corner, read back below
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindTexture(gl.TEXTURE_2D, tx);
    gl.uniform4f(u.m, tilt, br, full ? sway : sway * .4, bob);
    gl.uniform4f(u.p, ny, a.w / a.h, hs, T);
    gl.uniform2f(u.h, sp.x, .004);
    gl.uniform3f(u.f, f, blink, 0);
    gl.uniform4f(u.e, .5, top + (full ? .06 : .18), full ? .1 : .2, full ? .022 : .055);
    gl.drawElements(gl.TRIANGLES, u.n, gl.UNSIGNED_SHORT, 0);
    ctx.drawImage(cv, 0, 0, W, H, 0, 0, W, H);
  }
  function frame(now) {
    raf = 0;
    if (!shown.size) return;
    const dt = Math.min(.1, (now - (last || now)) / 1000);
    if (now - last < 32 && last) { raf = requestAnimationFrame(frame); return; }  // ~30fps is plenty
    last = now;
    const t = reduce.matches ? 0 : now / 1000;
    shown.forEach(c => c.isConnected ? draw(c, t, dt) : shown.delete(c));
    if (!reduce.matches) raf = requestAnimationFrame(frame);
  }
  const kick = () => { if (!raf) raf = requestAnimationFrame(frame); };
  // after each render: watch the new canvases, draw only those on screen
  // A canvas rebuilt for the same person starts with the old one's picture, so it is never blank until its first frame.
  let prev = new Map();
  const key = c => `${c.closest('.ch')?.dataset.id || ''}|${c.dataset.who}|${c.width}x${c.height}`;
  function mount(root) {
    if (!cv) init();
    io?.disconnect(); shown.clear();
    const cs = root.querySelectorAll('canvas.fig-l2d');
    const old = prev; prev = new Map();
    cs.forEach(c => { const k = key(c), o = old.get(k); if (o && o !== c) c.getContext('2d').drawImage(o, 0, 0); prev.set(k, c); });
    if (!cs.length) return;
    io = new IntersectionObserver(es => { es.forEach(e => e.isIntersecting ? shown.add(e.target) : shown.delete(e.target)); kick(); });
    cs.forEach(c => { c.dataset.fr ||= charFrame; io.observe(c); });  // the 캐릭터 tab names its own frame
  }
  return { mount };
})();

// The room's wall: shaded decorations in a row (hidden past what the width holds — chLayout).
const WALL = {
  window: () => `<svg viewBox="0 0 60 52" width="60" height="52"><rect class="w3-frame" x="2" y="2" width="56" height="42" rx="3"/><rect class="w3-sky" x="6" y="6" width="22" height="34"/><rect class="w3-sky" x="32" y="6" width="22" height="34"/>
    <ellipse class="w3-cloud" cx="16" cy="16" rx="7" ry="3"/><ellipse class="w3-cloud" cx="21" cy="14" rx="4.6" ry="3.4"/><ellipse class="w3-cloud" cx="44" cy="26" rx="6" ry="2.4"/><path class="w3-glint" d="M10 36L22 10M36 36L44 18"/><rect class="w3-sill" x="0" y="44" width="60" height="5" rx="1.6"/></svg>`,
  shelf: () => `<svg viewBox="0 0 70 52" width="70" height="52"><path class="w3-board" d="M2 22h66v4H2zM2 46h66v4H2z"/><path class="w3-book a" d="M6 6h6v16H6zM40 32h6v14h-6z"/><path class="w3-book b" d="M13 9h5v13h-5zM47 30h5v16h-5z"/>
    <path class="w3-book c" d="M19 4h7v18h-7zM8 34h7v12H8z"/><path class="w3-book d" d="M27 12l5-1 3 11h-5zM16 36h6v10h-6z"/><path class="w3-pot" d="M54 14h10l-1.4 8h-7.2z"/><path class="w3-leaf" d="M59 14C55 12 54 7 56 4C58 6 59 9 59 14zM59 14C60 9 62 6 66 5C66 9 63 13 59 14z"/></svg>`,
  clock: () => { const d = new Date(), hr = (d.getHours() % 12 + d.getMinutes() / 60) * 30, mn = d.getMinutes() * 6;
    return `<svg viewBox="0 0 34 52" width="34" height="52"><circle class="w3-rim" cx="17" cy="20" r="14"/><circle class="w3-face" cx="17" cy="20" r="11.4"/><path class="w3-tick" d="M17 10.6v2M17 27.4v2M7.6 20h2M24.4 20h2"/>
      <path class="w3-hand" d="M17 20v-6" transform="rotate(${hr} 17 20)"/><path class="w3-hand thin" d="M17 20v-8.4" transform="rotate(${mn} 17 20)"/><circle class="w3-pin" cx="17" cy="20" r="1.4"/></svg>`; },
  poster: () => `<svg viewBox="0 0 42 52" width="42" height="52"><rect class="w3-frame dark" x="2" y="3" width="38" height="44" rx="1.6"/><rect class="w3-art" x="5" y="6" width="32" height="38"/><circle class="w3-sun" cx="28" cy="16" r="4.4"/>
    <path class="w3-hill" d="M5 44V33l9-10 7 7 6-5 10 10v9z"/><path class="w3-hill2" d="M5 44v-5l10-7 10 7 12-4v9z"/></svg>`,
  board: () => `<svg viewBox="0 0 74 52" width="74" height="52"><rect class="w3-frame" x="1" y="3" width="72" height="42" rx="2"/><rect class="w3-white" x="4" y="6" width="66" height="36"/><path class="w3-pen a" d="M9 13h22M9 19h16M9 25h20"/>
    <path class="w3-pen b" d="M36 30l6-8 6 5 7-11"/><rect class="w3-note a" x="54" y="9" width="11" height="10" transform="rotate(4 59 14)"/><rect class="w3-note b" x="12" y="31" width="10" height="9" transform="rotate(-5 17 35)"/><rect class="w3-tray" x="20" y="44" width="34" height="3" rx="1"/></svg>`,
};
const WALL_ORDER = ['window', 'shelf', 'window', 'clock', 'poster', 'window', 'board', 'shelf', 'window', 'poster', 'clock', 'window'];
const wallHtml = key => { const k = chHash(key) % WALL_ORDER.length;
  return `<div class="room-wall" aria-hidden="true">${[...WALL_ORDER.slice(k), ...WALL_ORDER.slice(0, k)].map(w => `<span class="wall-item">${WALL[w]()}</span>`).join('')}</div>`; };

// A bubble's text: home and long paths cut to their last two parts (~/…/a/b), a break allowed after each slash, at most
// 60 characters.
const sayWrap = t => esc(cut(t.replace(/(^|[\s'"=])(\/Users\/[^/\s]+|~)?((?:\/[^/\s]+){3,})/g, (m, pre, home, rest) => `${pre}${home ? '~' : ''}/…${rest.split('/').slice(-2).map(x => '/' + x).join('')}`), 60)).replace(/\//g, '/<wbr>');
function charHtml(s) {
  const a = agg(s), st = subBg(s, a, status(s)), la = s.last_action, subs = a.subs.filter(x => x.live).length, m = `var(--m-${modelKey(s.model)})`;
  // 입력 대기 is not the user's to do: no bubble (it would read as a call for attention)
  const say = s.decision ? '결정을 기다려요' : st === 'wait' ? '' : st === 'run' && la ? la.text : ST_LABEL[st] + (st === 'run' ? '' : ' · ' + ago(s.last_ts));
  // 「유휴 · 8시간 전」 breaks only at its dot; an action's text gets short paths that break at their slashes
  const sayHtml = !say ? '' : st !== 'run' || s.decision || !la ? say.split(' · ').map(x => `<span class="nw">${esc(x)}</span>`).join(' · ') : sayWrap(say);
  const sign = s.decision ? '?' : CH_SIGN[st];
  const role = s.role === 'coordinator' ? '코디네이터' : isSubCoord(s) ? '하위 코디네이터' : ROLE[s.role] || '단독';
  const fam = chFam.get(s.path);
  return `<button type="button" class="ch st-${st}${s.decision ? ' dec' : ''}" data-path="${esc(s.path)}" data-id="${esc(s.id || s.path)}"${fam ? ` data-fam="${esc(fam.keys.join(' '))}"` : ''}
      style="--c:${st === 'stalled' ? `color-mix(in srgb, ${m} 35%, var(--muted))` : m}"
      title="${esc(`${nameOf(s)} · ${ST_LABEL[st]}${la ? '\n' + la.text : ''}\n끌어서 옮기기`)}" aria-label="${esc(`${nameOf(s)}: ${ST_LABEL[st]}${s.decision ? ', 결정 대기' : ''}. 방향키로 옮김`)}">
    <span class="ch-say"${say ? '' : ' hidden'}><span>${sign ? `<b>${sign}</b>` : ''}${sayHtml}</span></span>
    ${chFig(st, s)}
    <span class="ch-tag"><span class="ch-name"><i class="ch-dot" title="${ST_LABEL[st]}"></i><span class="ch-nm">${esc(nameOf(s))}</span></span>
      <span class="ch-meta">${role} · ${esc(modelName(s.model))}${subs ? ` · 서브 ${subs}` : ''}</span>${famChips(s)}</span>${srvBadge(s)}
  </button>`;
}
// Session detail: the same person as in the office, in the same pose, beside the title — continuity from the office.
// A click opens the picker (chPicker): any person, coordinator or worker, or back to the hash (자동).
const chShown = () => charMode;
let chPickOpen = false;
const chName = w => CH_INFO[w]?.[0] || w;
function chHero(d) {
  const st = subBg(d, agg(d), status(d)), who = chWho(d), k = d.id || d.path, pick = d.char?.pick;
  return `<button type="button" class="ch d-ch st-${st}${d.decision ? ' dec' : ''}" id="d-ch" data-id="${esc(k)}" aria-expanded="${chPickOpen}" aria-controls="d-chpick"
      title="${esc(chName(who))} · 눌러서 캐릭터 바꾸기" aria-label="${esc(`캐릭터 ${chName(who)}${pick ? ' (직접 고름)' : ''}. 눌러서 바꾸기`)}">
    ${chFig(st, d, true)}<span class="ch-name">${esc(chName(who))}${pick ? ' ✎' : ''}</span></button>`;
}
function chPicker(d) {
  const cur = chWho(d), auto = !d.char?.pick;
  const one = w => { const a = CH_ART[w].sdb;
    return `<button type="button" class="d-chopt${w === cur ? ' on' : ''}" data-pick="${w}" aria-pressed="${w === cur}" title="${esc(CH_INFO[w]?.[1] || '')}">
      <span class="d-chspr" style="width:${a.pw}px;height:${a.ph}px;background-image:url(${chSdSrc(w, 'bust')});background-size:${a.pw * 8}px ${a.ph}px"></span>${esc(chName(w))}</button>`; };
  return `<div class="box d-chpick" id="d-chpick"><div class="d-chpick-h"><b>캐릭터 고르기</b><span class="st">사무실·대화·다른 기기에서도 이 사람으로 보입니다</span>
      <button type="button" class="act" data-pick=""${auto ? ' disabled' : ''}>${auto ? '자동 배정 중' : '자동으로 되돌리기'}</button></div>
    <div class="d-chgrp" role="group" aria-label="코디네이터"><span class="st">코디네이터</span>${CH_BOSS.map(one).join('')}</div>
    <div class="d-chgrp" role="group" aria-label="워커"><span class="st">워커</span>${CH_CREW.map(one).join('')}</div></div>`;
}
const roomCount = ms => { const n = k => ms.filter(m => k.includes(subBg(m, agg(m), status(m)))).length;
  return [['일하는 중', n(['run', 'bg'])], ['결정', ms.filter(m => m.decision).length], ['응답 없음', n(['stalled'])]].filter(([, c]) => c).map(([l, c]) => `${l} <b>${c}</b>`).concat(`전체 <b>${ms.length}</b>`).join(' · '); };
const roomBox = (title, key, ms, extra = '') => `<section class="box room" data-room="${esc(key)}"><div class="room-h"><b>${title}</b>${extra}<span class="room-n">${roomCount(ms)}</span></div>
    <div class="room-floor">${wallHtml(key)}${ms.map(charHtml).join('')}</div></section>`;
// One room per worktree (wtKey): everyone on show sits where they run, so a coordinator and the workers it sent to other
// worktrees sit in different rooms. Each coordinator with workers on show leads a team with its own colour and name
// (chFam, FAM_TEAM): its people wear a chip in that colour — the coordinator 「★ 파도팀 팀장 · N명」, a worker 「◆ 파도팀」,
// the coordinator's title and room in the tooltip — and chLinks draws a line in that colour from the coordinator to
// each worker in another room. Rooms a family spans are laid out together, the room with a top
// coordinator first.
// A family is a team: its colour and a name that goes with it, so a chip reads 「파도팀」 rather than a long session title.
const FAM_TEAM = [[212, '파도'], [24, '노을'], [148, '숲'], [282, '라벤더'], [350, '장미'], [48, '햇살'], [186, '호수'], [318, '벚꽃'], [96, '새싹'], [252, '밤하늘']];
let chFam = new Map(), chLinkList = [];
const roomName = p => !p ? '위치 미상' : p.worktree && p.worktree !== p.project ? p.worktree : p.main && p.branch ? '메인' : p.project;
function officeRooms(people) {
  const up = coordOf(families().fams), by = new Map(), on = new Set(people.map(s => s.path)), fams = new Map(), pairs = [];
  for (const s of people) { const k = wtKey(s); (by.get(k) || by.set(k, []).get(k)).push(s); }
  for (const s of people) {
    const c = up.get(s.path)?.coord;
    if (!c || !on.has(c.path)) continue;
    (fams.get(c.path) || fams.set(c.path, { c, ws: [] }).get(c.path)).ws.push(s);
    if (wtKey(c) !== wtKey(s)) pairs.push([wtKey(c), wtKey(s)]);
  }
  // colours in order of start, so a family keeps its colour while newer ones come and go
  chFam = new Map(); chLinkList = [];
  [...fams.values()].sort((x, y) => byStart(x.c, y.c)).forEach((f, i) => {
    const [hue, tn] = FAM_TEAM[i % FAM_TEAM.length], team = tn + '팀' + (i >= FAM_TEAM.length ? ' ' + (Math.floor(i / FAM_TEAM.length) + 1) : ''), k = wtKey(f.c), away = f.ws.filter(w => wtKey(w) !== k);
    const cm = chFam.get(f.c.path) || {};
    chFam.set(f.c.path, { ...cm, hue: cm.hue ?? hue, keys: [...(cm.keys || []), f.c.path], boss: { hue, team, n: f.ws.length, away: away.length } });
    for (const w of f.ws) {
      const wm = chFam.get(w.path) || {};
      chFam.set(w.path, { ...wm, hue, keys: [f.c.path, ...(wm.keys || [])], of: { c: f.c, hue, team, room: wtKey(w) !== k ? roomName(f.c.place) : '' } });
    }
    away.forEach(w => chLinkList.push({ from: f.c.path, to: w.path, hue, fam: f.c.path, team, name: nameOf(f.c) }));
  });
  // linked rooms form groups (union-find); groups by their most urgent person, a lone room after the linked ones
  const root = new Map([...by.keys()].map(k => [k, k])), find = k => root.get(k) === k ? k : find(root.get(k));
  for (const [x, y] of pairs) root.set(find(x), find(y));
  const rank = k => Math.min(...by.get(k).map(sessRank)), lead = k => by.get(k).some(m => m.role === 'coordinator');
  const late = k => by.get(k).map(m => m.started || '').sort().pop() || '';
  const groups = new Map();
  for (const k of by.keys()) (groups.get(find(k)) || groups.set(find(k), []).get(find(k))).push(k);
  const order = [...groups.values()].map(ks => ks.sort((x, y) => lead(y) - lead(x) || rank(x) - rank(y) || late(y).localeCompare(late(x))))
    .sort((x, y) => (y.length > 1) - (x.length > 1) || Math.min(...x.map(rank)) - Math.min(...y.map(rank)) || late(y[0]).localeCompare(late(x[0]))).flat();
  // the server goes with each room, so renderOffice can put each server's rooms in its own company
  return order.map(k => {
    const ms = by.get(k).sort((x, y) => isBoss(y) - isBoss(x) || sessRank(x) - sessRank(y) || byStart(x, y)), p = ms.find(m => m.place)?.place, name = roomName(p);
    return { srv: ms[0].server || '', ms, html: roomBox(`▣ ${esc(name)}`, k, ms, `${p?.project && p.project !== name ? `<span class="st">${esc(p.project)}</span>` : ''}${p?.branch && p.branch !== name ? `<span class="st">⎇ ${esc(cut(p.branch, 40))}</span>` : ''}`) };
  });
}
// A person's family chips (charHtml): as a coordinator, then as a worker (a sub-coordinator wears both).
function famChips(s) {
  const m = chFam.get(s.path);
  if (!m) return '';
  const chip = (hue, txt, tip) => `<span class="ch-fam" style="--fh:${hue}" title="${esc(tip)}">${txt}</span>`;
  return (m.boss ? chip(m.boss.hue, `★ ${m.boss.team}<span class="ch-far-x"> 팀장 · ${m.boss.n}명</span>`, `${m.boss.team} 팀장 — 이 코디네이터의 워커 ${m.boss.n}명${m.boss.away ? `, 그중 ${m.boss.away}명은 다른 워크트리 방 (선으로 이어짐)` : ''}`) : '')
    + (m.of ? chip(m.of.hue, `◆ ${m.of.team}`, `${m.of.team} 팀원 — 팀장(코디네이터) ${nameOf(m.of.c)}${m.of.room ? `, ▣ ${m.of.room} 방` : ', 같은 방'}`) : '');
}
// The family lines, over the plane: a dotted thread in the family's colour from the coordinator's side to the side of
// each of its workers in another room (the sides facing each other, at the waist, clear of bubbles and name tags),
// sagging a little across the corridor, a dot at each end and, at the bottom of the first thread of each family, the
// team's name. It is redrawn after each layout.
function chLinks() {
  const w = $('#view .ch-world');
  if (!w) return;
  w.querySelectorAll('.ch-links, .ch-link-tag').forEach(x => x.remove());
  if (!chLinkList.length) return;
  const wr = w.getBoundingClientRect(), z = wr.width / w.offsetWidth || 1;
  const fig = path => { const f = w.querySelector(`.ch[data-path="${CSS.escape(path)}"] .ch-fig`); if (!f) return null; const r = f.getBoundingClientRect();
    return { x: (r.left + r.width / 2 - wr.left) / z, y: (r.top + r.height * .62 - wr.top) / z, hw: r.width / z * .36 }; };
  const side = (p, toward) => ({ x: p.x + Math.sign(toward - p.x || 1) * p.hw, y: p.y });
  let svg = '', tags = '';
  const named = new Set();
  for (const l of chLinkList) {
    const a = fig(l.from), b = fig(l.to);
    if (!a || !b) continue;
    const A = side(a, b.x), B = side(b, a.x);
    const sag = Math.min(60, 16 + Math.hypot(B.x - A.x, B.y - A.y) * .06), low = Math.max(A.y, B.y) + sag;
    const d = `M${A.x} ${A.y}C${A.x + (B.x - A.x) * .3} ${low} ${B.x - (B.x - A.x) * .3} ${low} ${B.x} ${B.y}`;
    svg += `<g class="ch-link" data-fam="${esc(l.fam)}" style="--fh:${l.hue}"><path d="${d}"/><circle class="boss" cx="${A.x}" cy="${A.y}" r="4"/><circle cx="${B.x}" cy="${B.y}" r="4"/></g>`;
    if (!named.has(l.fam)) {
      named.add(l.fam);
      tags += `<span class="ch-link-tag" data-fam="${esc(l.fam)}" style="--fh:${l.hue};left:${(A.x + B.x) / 2}px;top:${(A.y + B.y) / 8 + low * .75}px" title="${esc(`${l.team} — 팀장 ${l.name}`)}">${esc(l.team)}</span>`;
    }
  }
  if (svg) w.insertAdjacentHTML('beforeend', `<svg class="ch-links" width="${w.offsetWidth}" height="${w.offsetHeight}" aria-hidden="true">${svg}</svg>${tags}`);
  chHot(w.dataset.hot);
}
// Pointing at (or focusing) a person shows their team's lines — hidden otherwise — and fades everyone else.
function chHot(fam) {
  const w = $('#view .ch-world');
  if (!w) return;
  if (fam) w.dataset.hot = fam; else delete w.dataset.hot;
  w.classList.toggle('fam-hot', !!fam);
  w.querySelectorAll('.ch-link, .ch-link-tag, .ch[data-fam]').forEach(x => x.classList.toggle('fam-on', !!fam && x.dataset.fam.split(' ').includes(fam)));
}

// Places: everyone sits on the room's grid, in order. Places once moved by hand (adash.chpos) are dropped.
try { localStorage.removeItem('adash.chpos'); } catch {}
let chStale = false;  // a live update during a pan waits for the release
const CH_GAP = 6;
function chLayout() {
  $('#view').querySelectorAll('.room-floor').forEach(fl => {
    const us = [...fl.querySelectorAll('.ch')], W = fl.clientWidth;
    fl.querySelectorAll('.wall-item').forEach((it, i) => it.hidden = i >= Math.max(2, Math.floor(W / 130)));
    if (!us.length) return;
    // the first row's bubbles sit on the lower wall, below its decorations
    // grown labels (chApply's --lz) reach past a person's box: the bubble up, the name plate down. A row is as tall as
    // its tallest person (one with two family chips stands taller than one with none), so no name plate runs under
    // the row below.
    const hOf = u => u.offsetHeight + (chLz - 1) * ((u.querySelector('.ch-tag')?.offsetHeight || 0) + (u.querySelector('.ch-say')?.offsetHeight || 0));
    const uw = us[0].offsetWidth, cols = Math.max(1, Math.floor(W / uw)), slot = W / cols, top = parseFloat(getComputedStyle(fl).getPropertyValue('--wall-h')) - 54;
    const rowY = [top];
    us.forEach((u, i) => { const r = Math.floor(i / cols); rowY[r + 1] = Math.max(rowY[r + 1] || 0, rowY[r] + hOf(u) + CH_GAP); });
    us.forEach((u, i) => chPlace(u, slot * (i % cols) + (slot - uw) / 2, rowY[Math.floor(i / cols)]));
    fl.style.height = rowY[rowY.length - 1] + CH_GAP + 'px';
  });
  chLinks();
}
const chPlace = (u, x, y) => { u.style.left = x + 'px'; u.style.top = y + 'px'; u.style.zIndex = 10 + Math.round(y); };
function chBind(us = $('#view').querySelectorAll('.ch')) {  // us: the people put in anew by chPatch
  us.forEach(u => {
    u.onclick = () => {
      if (Date.now() - chPanAt < 400) return;
      if (u.dataset.staff) { location.hash = '#' + u.dataset.staff; return; }
      openSession(u.dataset.path);
    };
    if (u.dataset.fam) { u.onpointerenter = u.onfocus = () => chHot(u.dataset.fam.split(' ').pop()); u.onpointerleave = u.onblur = () => chHot(null); }
  });
}
addEventListener('resize', () => { if ($('#view .office')) { chLayout(); chApply(); } });

// The office is a canvas: the rooms are laid out on one plane (.ch-world) inside a box that fills the screen below the
// header (.ch-canvas, no page scroll), moved by dragging the floor (one finger on touch), the wheel or trackpad, and
// zoomed with Ctrl/⌘ + wheel, a pinch or the − / + buttons. 「맞춤」 fits every room in view and keeps fitting as the
// office changes, until the view is moved by hand. The view is kept on this device (adash.chview).
let chView = { x: 0, y: 0, z: 1, fit: true };
let chLz = 1;  // the label growth chLayout last spaced the rows for
try { chView = { ...chView, ...JSON.parse(localStorage.getItem('adash.chview') || '{}') }; } catch {}
let chPanAt = 0, chSaveT;
const chViewSave = () => { clearTimeout(chSaveT); chSaveT = setTimeout(() => { try { localStorage.setItem('adash.chview', JSON.stringify(chView)); } catch {} }, 300); };
function chApply() {
  const cv = $('#ch-canvas'), w = cv?.querySelector('.ch-world');
  if (!w) return;
  const cw = cv.clientWidth, ch = cv.clientHeight, ww = w.offsetWidth, wh = w.offsetHeight;
  if (chView.fit) {  // beside an open staff panel and clear of the bar floating on the bottom (or top) of the canvas
    const dt = document.documentElement.dataset.dock === 'top' && $('ds-dock:not([open])')?.getBoundingClientRect();
    const top = dt ? Math.max(14, dt.bottom - cv.getBoundingClientRect().top + 8) : 14;
    const dk = document.documentElement.dataset.dock === 'bottom' && $('ds-dock:not([open])')?.getBoundingClientRect();
    const room = ch - top - (dk ? Math.max(8, cv.getBoundingClientRect().bottom - dk.top + 8) : 8);
    const pn = cv.querySelector('.ch-panel'), side = pn && cw > 700 ? pn.offsetWidth + 20 : 0, fw = cw - side;
    let z = Math.min(1, (fw - 24) / ww, room / wh);
    if (z < .5) z = Math.min(1, (fw - 24) / ww);  // too small to read: fit the width and pan down instead
    chView.z = z;
    chView.x = (fw - ww * z) / 2;
    chView.y = top + (wh * z < room ? (room - wh * z) / 2 : 0);
  }
  // keep at least 80px of the office on screen, so it can never be lost
  chView.x = Math.min(cw - 80, Math.max(80 - ww * chView.z, chView.x));
  chView.y = Math.min(ch - 80, Math.max(80 - wh * chView.z, chView.y));
  w.style.transform = `translate(${chView.x}px, ${chView.y}px) scale(${chView.z})`;
  // the corridor floor moves and scales with the plane (the backdrop in app.css)
  cv.style.setProperty('--bx', chView.x + 'px'); cv.style.setProperty('--by', chView.y + 'px'); cv.style.setProperty('--bz', chView.z);
  // labels grow back as the view shrinks, so names and bubbles stay readable when zoomed out (up to 1.5×; .ch-far hides
  // the role line and the chips' counts). Rows open up to make room, so the layout is redone when the growth changes noticeably.
  const lz = Math.min(1.5, Math.max(1, .9 / chView.z));
  cv.style.setProperty('--lz', lz);
  cv.classList.toggle('ch-far', lz > 1.25);
  if (Math.abs(lz - chLz) > .1) { chLz = lz; chLayout(); }
  $('#k-zoom').textContent = Math.round(chView.z * 100) + '%';
  $('#zoom-btn').setAttribute('aria-pressed', chView.fit);
}
// zoom by k around a point of the canvas (px from its top left)
function chZoom(k, px, py) {
  const z = Math.min(2, Math.max(.25, chView.z * k)), f = z / chView.z;
  chView.x = px - (px - chView.x) * f; chView.y = py - (py - chView.y) * f; chView.z = z; chView.fit = false;
  chApply(); chViewSave();
}
// the canvas takes the screen below its top (to the very bottom on a phone or half folded, down to the bar's sheet
// when that is the lower half); the page itself does not scroll. It keeps to the viewport: when iOS lays an installed
// PWA out shorter than its screen (iPhone Duo sideways, now and then: 867×587 of 951×669), a box reaching past it is
// cut (#109), and a page taller than the viewport makes iOS change the viewport back and forth — the office and the
// bar blinked (#113, #114). The strip left below takes the corridor's colour (chTint).
function chSize() {
  const cv = $('#ch-canvas');
  if (!cv) return;
  // the canvas is fixed (app.css): it takes the view's place across and from the view's top to the viewport's bottom
  // (down to the bar's sheet when that is the lower half)
  const posture = document.documentElement.dataset.posture, sheet = posture === 'laptop' && $('ds-dock[open]');
  const v = $('#view').getBoundingClientRect(), bottom = sheet ? sheet.getBoundingClientRect().top - 7 : innerHeight;
  Object.assign(cv.style, { left: v.left + 'px', top: v.top + 'px', width: v.width + 'px', height: Math.max(240, bottom - v.top) + 'px' });
  chApply();
}
// the bar's zoom figure: pressed, 맞춤 (the view is zoomed by a pinch, Ctrl/⌘ + wheel or the trackpad; no buttons)
$('#zoom-btn').onclick = () => { if (!$('#ch-canvas')) return; chView.fit = true; chApply(); chViewSave(); };
const chPts = new Map();
document.addEventListener('pointerdown', e => {
  if (!e.target.closest?.('#ch-canvas') || e.target.closest('.ch-panel')) return;
  if (e.pointerType === 'mouse' && e.button) return;
  chPts.set(e.pointerId, [e.clientX, e.clientY]);
});
addEventListener('pointermove', e => {
  const p = chPts.get(e.pointerId);
  if (!p) return;
  const r = $('#ch-canvas')?.getBoundingClientRect();
  if (!r) return;
  if (chPts.size === 1) {
    const dx = e.clientX - p[0], dy = e.clientY - p[1];
    if (Math.abs(dx) + Math.abs(dy) > 2) chPanAt = Date.now();
    chView.x += dx; chView.y += dy; chView.fit = false;
    chApply();
  } else if (chPts.size === 2) {  // pinch: zoom by the change of the fingers' distance, around their middle
    const [q] = [...chPts].filter(([id]) => id !== e.pointerId).map(([, v]) => v);
    const d0 = Math.hypot(p[0] - q[0], p[1] - q[1]), d1 = Math.hypot(e.clientX - q[0], e.clientY - q[1]);
    chPanAt = Date.now();
    if (d0 > 0) chZoom(d1 / d0, (e.clientX + q[0]) / 2 - r.left, (e.clientY + q[1]) / 2 - r.top);
  }
  p[0] = e.clientX; p[1] = e.clientY;
});
const chUp = e => {
  if (!chPts.delete(e.pointerId) || chPts.size) return;
  chViewSave();
  if (chStale) { chStale = false; renderOffice(); }
};
addEventListener('pointerup', chUp); addEventListener('pointercancel', chUp);
document.addEventListener('wheel', e => {
  const cv = e.target.closest?.('#ch-canvas');
  if (!cv || e.target.closest('.ch-panel')) return;  // the staff panel scrolls itself
  e.preventDefault();
  const r = cv.getBoundingClientRect(), u = e.deltaMode === 1 ? 16 : 1;
  if (e.ctrlKey || e.metaKey) return chZoom(Math.exp(-Math.max(-60, Math.min(60, e.deltaY * u)) * .006), e.clientX - r.left, e.clientY - r.top);
  chView.x -= e.deltaX * u; chView.y -= e.deltaY * u; chView.fit = false;
  chApply(); chViewSave();
}, { passive: false });
addEventListener('resize', () => chSize());
// iOS can lay an installed PWA out shorter than its screen (app.css :root.ch-full). The strip below is not painted from
// the html background but takes the page's theme-color (#0f1215 in dark), so while the office fills the screen the
// theme-color is the corridor floor's colour and the office reaches the edge to the eye. theme.js sets it back to --bg
// on a theme change; this runs after it (a mutation callback) and puts the office's colour back.
const chTintCtx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
const chTint = () => {
  const m = document.querySelector('meta[name=theme-color]'), root = document.documentElement;
  if (!m || !chTintCtx) return;
  const cs = getComputedStyle(root), c = root.classList.contains('ch-full') ? cs.backgroundColor : cs.getPropertyValue('--bg').trim();
  // as #rrggbb: the meta tag may not take color-mix() or color(srgb …)
  chTintCtx.clearRect(0, 0, 1, 1); chTintCtx.fillStyle = '#000'; chTintCtx.fillStyle = c; chTintCtx.fillRect(0, 0, 1, 1);
  const hex = '#' + [...chTintCtx.getImageData(0, 0, 1, 1).data.slice(0, 3)].map(v => v.toString(16).padStart(2, '0')).join('');
  if (m.content !== hex) m.content = hex;
};
new MutationObserver(chTint).observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
// half folded or opened again: the office's width changed, so its rooms are laid out anew (after the bar's sheet has moved)
addEventListener('ds-posture', () => requestAnimationFrame(() => { if ($('#view .office')) renderOffice(); }));
// iOS: the on-screen keyboard pans the page up to the field, and closing it can leave the page there — the floating bar
// and the office then sit too high, and the office (its page cannot scroll) has no way back. Once the keyboard is gone,
// put the office back at the top and re-anchor the fixed layer elsewhere.
window.visualViewport?.addEventListener('resize', () => {
  if (document.activeElement?.matches('input, textarea, [contenteditable="true"]')) return;  // still typing
  if (document.documentElement.classList.contains('ch-full')) { if (scrollY || visualViewport.offsetTop) scrollTo(0, 0); chSize(); }
  else if (visualViewport.offsetTop) scrollTo(scrollX, scrollY);
});

// 운영실: on 홈 each screen of HUB is a staff member in a room of their own, furnished for the job — a name plate, the
// wall in the room's colour (--sh, a hue) with two decorations of the trade (STAFF_WALL, or the office's WALL) and a
// piece of furniture on the floor (STAFF_PROP). The bubble is the tile's rough figure, the state its tone (hot: busy,
// bad: stalled, else standing by); pressing them goes to that screen.
const calDots = () => [0, 1, 2, 3].flatMap(r => [0, 1, 2, 3, 4].map(c => `<rect x="${7 + c * 6.4}" y="${20 + r * 6.6}" width="3.6" height="3"/>`)).join('');
const STAFF_WALL = {
  calendar: () => `<svg viewBox="0 0 44 52" width="44" height="52"><rect class="w3-white w3-edge" x="3" y="7" width="38" height="41" rx="2.5"/><path class="w3-bad" d="M3 9.5A2.5 2.5 0 0 1 5.5 7h33A2.5 2.5 0 0 1 41 9.5V16H3z"/>
    <path class="w3-ring" d="M13 3v8M31 3v8"/><g class="w3-dim">${calDots()}</g><circle class="w3-circ" cx="22.6" cy="34.7" r="4.4"/></svg>`,
  mail: () => `<svg viewBox="0 0 56 52" width="56" height="52"><rect class="w3-frame dark" x="3" y="6" width="50" height="42" rx="2"/>
    <rect class="w3-white" x="8" y="11" width="18" height="13"/><path class="w3-env" d="M8 11l9 7 9-7"/><rect class="w3-white" x="30" y="11" width="18" height="13"/><path class="w3-env" d="M30 11l9 7 9-7"/>
    <rect class="w3-white" x="8" y="30" width="18" height="13"/><path class="w3-env" d="M8 30l9 7 9-7"/><rect class="w3-note a" x="30" y="30" width="18" height="13" transform="rotate(-4 39 36)"/></svg>`,
  monitors: () => `<svg viewBox="0 0 64 52" width="64" height="52">${[[2, 3], [34, 3], [2, 27], [34, 27]].map(([x, y]) => `<rect class="w3-dark" x="${x}" y="${y}" width="28" height="21" rx="2"/><rect class="w3-scr" x="${x + 2}" y="${y + 2}" width="24" height="17"/>`).join('')}
    <path class="w3-pen ok" d="M6 19l5-5 4 3 5-7 5 4"/><circle class="w3-bad" cx="48" cy="13.5" r="4"/><path class="w3-pen b" d="M6 33h12M6 37h16M6 41h9"/><path class="w3-pen ok" d="M38 44l6-8 4 4 8-8"/></svg>`,
  warning: () => `<svg viewBox="0 0 42 52" width="42" height="52"><path class="w3-warnf" d="M21 8l18 34H3z"/><path class="w3-inkf" d="M19.4 19h3.2l-.6 12h-2zM19.5 34h3v3h-3z"/></svg>`,
  checklist: () => `<svg viewBox="0 0 40 52" width="40" height="52"><rect class="w3-frame dark" x="4" y="5" width="32" height="45" rx="3"/><rect class="w3-white" x="7" y="10" width="26" height="37"/><rect class="w3-alu" x="13" y="2" width="14" height="7" rx="2"/>
    ${[15, 23, 31].map(y => `<path class="w3-chk" d="M10 ${y}l2 2 3.5-4"/><path class="w3-line" d="M19 ${y + 1}h11"/>`).join('')}<path class="w3-x" d="M10.5 38.5l4 4M14.5 38.5l-4 4"/><path class="w3-line" d="M19 41h11"/></svg>`,
  flasks: () => `<svg viewBox="0 0 64 52" width="64" height="52"><path class="w3-board" d="M2 44h60v4H2z"/>
    <path class="w3-glass" d="M10 18h7v8l7 18H3l7-18z"/><path class="w3-f2" d="M6 36h15l3 8H3z"/>
    ${[[30, 'w3-f4'], [37, 'w3-f5'], [44, 'w3-f1']].map(([x, c]) => `<rect class="w3-glass" x="${x}" y="18" width="5" height="26" rx="2.5"/><rect class="${c}" x="${x}" y="31" width="5" height="13" rx="2.5"/>`).join('')}
    <circle class="w3-glass" cx="56" cy="37" r="6.5"/><path class="w3-f3" d="M49.6 38h12.8a6.5 6.5 0 0 1-12.8 0z"/><rect class="w3-glass" x="54" y="22" width="4" height="10"/></svg>`,
  coins: () => `<svg viewBox="0 0 60 52" width="60" height="52"><rect class="w3-frame" x="2" y="4" width="56" height="42" rx="2"/><rect class="w3-white" x="5" y="7" width="50" height="36"/>
    <rect class="w3-f3" x="9" y="31" width="6" height="9"/><rect class="w3-f3" x="18" y="26" width="6" height="14"/><rect class="w3-f3" x="27" y="20" width="6" height="20"/><rect class="w3-okf" x="36" y="13" width="6" height="27"/>
    <circle class="w3-coin" cx="48.5" cy="16" r="5.6"/><text class="w3-coin-t" x="48.5" y="19" text-anchor="middle">$</text></svg>`,
  kanban: () => `<svg viewBox="0 0 74 52" width="74" height="52"><rect class="w3-frame" x="1" y="3" width="72" height="42" rx="2"/><rect class="w3-white" x="4" y="6" width="66" height="36"/><path class="w3-line" d="M26 9v30M48 9v30"/>
    <rect class="w3-note a" x="8" y="10" width="14" height="9"/><rect class="w3-note b" x="8" y="22" width="14" height="9"/><rect class="w3-note a" x="30" y="10" width="14" height="9" transform="rotate(3 37 14)"/>
    <rect class="w3-f3" x="52" y="10" width="14" height="9"/><rect class="w3-f3" x="52" y="22" width="14" height="9"/><rect class="w3-f3" x="52" y="31" width="14" height="8" transform="rotate(-3 59 35)"/><rect class="w3-tray" x="20" y="44" width="34" height="3" rx="1"/></svg>`,
  pipeline: () => `<svg viewBox="0 0 74 52" width="74" height="52"><rect class="w3-frame" x="1" y="3" width="72" height="42" rx="2"/><rect class="w3-white" x="4" y="6" width="66" height="36"/><path class="w3-line thick" d="M12 21h50"/>
    ${[[12, 'w3-okf'], [24.5, 'w3-okf'], [37, 'w3-okf'], [49.5, 'w3-warnf'], [62, 'w3-alu']].map(([x, c]) => `<circle class="${c}" cx="${x}" cy="21" r="4.6"/><path class="w3-line" d="M${x - 4} 33h8"/>`).join('')}</svg>`,
  timeline: () => `<svg viewBox="0 0 60 52" width="60" height="52"><rect class="w3-white w3-edge" x="8" y="6" width="44" height="40"/><rect class="w3-rim" x="4" y="3" width="52" height="6" rx="3"/><rect class="w3-rim" x="4" y="43" width="52" height="6" rx="3"/>
    <path class="w3-line" d="M17 13v27"/><circle class="w3-f1" cx="17" cy="16" r="2.6"/><circle class="w3-f2" cx="17" cy="25" r="2.6"/><circle class="w3-f3" cx="17" cy="34" r="2.6"/><path class="w3-line" d="M23 16h22M23 25h16M23 34h20"/></svg>`,
  gantt: () => `<svg viewBox="0 0 74 52" width="74" height="52"><rect class="w3-frame" x="1" y="3" width="72" height="42" rx="2"/><rect class="w3-white" x="4" y="6" width="66" height="36"/>
    <rect class="w3-f1" x="8" y="10" width="22" height="5" rx="1"/><rect class="w3-f2" x="22" y="18" width="24" height="5" rx="1"/><rect class="w3-f3" x="38" y="26" width="18" height="5" rx="1"/><rect class="w3-f4" x="50" y="34" width="16" height="5" rx="1"/><path class="w3-x" d="M44 8v32"/></svg>`,
  blueprint: () => `<svg viewBox="0 0 66 52" width="66" height="52"><rect class="w3-bp" x="3" y="5" width="60" height="42" rx="1"/><path class="w3-bpl" d="M10 12h46v28H10zM30 12v14h26M10 26h12M40 26v14"/><path class="w3-bpl thin" d="M22 26a8 8 0 0 1 8-8"/><circle class="w3-pin" cx="6" cy="8" r="1.6"/><circle class="w3-pin" cx="60" cy="8" r="1.6"/></svg>`,
  status: () => `<svg viewBox="0 0 56 52" width="56" height="52"><rect class="w3-dark" x="4" y="4" width="48" height="44" rx="3"/>
    ${[9, 19, 29, 39].map((y, i) => `<rect class="w3-scr" x="9" y="${y}" width="27" height="6" rx="1"/><rect class="w3-okf" x="10" y="${y + 1.5}" width="${[20, 12, 24, 8][i]}" height="3" rx="1"/><circle class="${i === 2 ? 'w3-warnf' : 'w3-okf'} w3-led" cx="44" cy="${y + 3}" r="2"/>`).join('')}</svg>`,
};
const STAFF_PROP = {
  cabinet: `<svg viewBox="0 0 40 62" width="40" height="62"><ellipse class="w3-shadow" cx="20" cy="59" rx="17" ry="2.6"/><rect class="w3-alu" x="4" y="8" width="32" height="50" rx="2"/><path class="w3-seam" d="M4 24.5h32M4 41h32"/>
    <rect class="w3-dark" x="15" y="14" width="10" height="3" rx="1"/><rect class="w3-dark" x="15" y="30" width="10" height="3" rx="1"/><rect class="w3-dark" x="15" y="47" width="10" height="3" rx="1"/><rect class="w3-white" x="11" y="2" width="17" height="7" transform="rotate(-6 20 5)"/></svg>`,
  plant: `<svg viewBox="0 0 44 66" width="44" height="66"><ellipse class="w3-shadow" cx="22" cy="63" rx="14" ry="2.6"/><path class="w3-leaf" d="M22 40C11 36 5 24 9 12C16 20 21 28 22 40zM22 40C23 26 29 16 39 10C41 24 33 36 22 40zM22 40C19 26 20 12 24 2C30 14 28 30 22 40z"/>
    <path class="w3-pot" d="M11 42h22l-3 20H14z"/><rect class="w3-pot" x="9" y="39" width="26" height="5" rx="2"/></svg>`,
  easel: `<svg viewBox="0 0 46 66" width="46" height="66"><ellipse class="w3-shadow" cx="23" cy="63" rx="16" ry="2.4"/><path class="w3-board" d="M10 63L21 6h4l11 57h-3L23 16 13 63z"/>
    <rect class="w3-white w3-edge" x="5" y="9" width="36" height="28" rx="1"/><path class="w3-pen a" d="M10 31l7-8 6 4 9-11"/><rect class="w3-note a" x="30" y="12" width="8" height="7"/><rect class="w3-board" x="4" y="37" width="38" height="3"/></svg>`,
  lab: `<svg viewBox="0 0 66 60" width="66" height="60"><ellipse class="w3-shadow" cx="33" cy="57" rx="30" ry="2.6"/><rect class="w3-board" x="2" y="32" width="62" height="5" rx="1"/><path class="w3-board" d="M6 37h4v19H6zM56 37h4v19h-4z"/>
    <path class="w3-glass" d="M12 12h6v7l6 13H6l6-13z"/><path class="w3-f4" d="M8 27h14l2 5H6z"/><rect class="w3-alu" x="32" y="27" width="22" height="3"/>
    ${[[35, 'w3-f1'], [41, 'w3-f5'], [47, 'w3-f2']].map(([x, c]) => `<rect class="w3-glass" x="${x}" y="13" width="4" height="19" rx="2"/><rect class="${c}" x="${x}" y="22" width="4" height="10" rx="2"/>`).join('')}</svg>`,
  safe: `<svg viewBox="0 0 46 60" width="46" height="60"><ellipse class="w3-shadow" cx="23" cy="57" rx="20" ry="2.6"/><rect class="w3-dark" x="3" y="10" width="40" height="46" rx="3"/><rect class="w3-safe" x="7" y="14" width="32" height="38" rx="2"/>
    <circle class="w3-alu" cx="23" cy="33" r="8"/><circle class="w3-dark" cx="23" cy="33" r="2.4"/><path class="w3-seam" d="M23 25.5v3M23 37.5v3M15.5 33h3M27.5 33h3"/><rect class="w3-alu" x="34" y="30" width="3" height="7" rx="1"/>
    <ellipse class="w3-coin" cx="13" cy="8.5" rx="6" ry="2"/><ellipse class="w3-coin" cx="13" cy="6" rx="6" ry="2"/><ellipse class="w3-coin" cx="13" cy="3.5" rx="6" ry="2"/></svg>`,
  boxes: `<svg viewBox="0 0 58 54" width="58" height="54"><ellipse class="w3-shadow" cx="29" cy="51" rx="27" ry="2.6"/><rect class="w3-box" x="4" y="26" width="26" height="24"/><rect class="w3-box2" x="3" y="24" width="28" height="5"/><rect class="w3-white" x="11" y="34" width="12" height="7"/>
    <rect class="w3-box" x="31" y="30" width="23" height="20"/><rect class="w3-box2" x="30" y="28" width="25" height="5"/><rect class="w3-white" x="37" y="37" width="11" height="6"/>
    <rect class="w3-box" x="9" y="8" width="20" height="16"/><rect class="w3-box2" x="8" y="6" width="22" height="4"/><rect class="w3-white" x="14" y="13" width="10" height="5"/></svg>`,
  rack: `<svg viewBox="0 0 40 68" width="40" height="68"><ellipse class="w3-shadow" cx="20" cy="65" rx="17" ry="2.6"/><rect class="w3-dark" x="4" y="4" width="32" height="60" rx="2"/>
    ${[9, 20, 31, 42, 53].map((y, i) => `<rect class="w3-scr" x="8" y="${y}" width="24" height="8" rx="1"/><circle class="w3-okf w3-led" cx="28" cy="${y + 4}" r="1.5" style="animation-delay:${i * .3}s"/><path class="w3-line light" d="M11 ${y + 4}h10"/>`).join('')}</svg>`,
};
const hubSt = r => r.tone === 'bad' ? 'stalled' : r.tone === 'hot' ? 'run' : 'wait';
function staffHtml(h, r = hubVal(h)) {
  // the staff take the six people in turn, so the rooms next to each other have different faces
  const who = [...CH_CREW, ...CH_BOSS][HUB.indexOf(h) % 6], st = hubSt(r), me = { id: 'staff-' + h.id, path: 'staff-' + h.id, role: 'staff', char: { who } }, say = r.sub ? `${r.v} · ${r.sub}` : r.v;
  return `<button type="button" class="ch staff st-${st}${h.id === 'decide' && r.tone ? ' dec' : ''}" data-staff="${h.id}" data-id="staff-${h.id}" style="--c:var(--accent)"
      title="${esc(`${h.staff} · ${h.name}\n${say}\n누르면 ${h.name} 화면으로`)}" aria-label="${esc(`${h.staff}: ${h.name}. ${say}`)}">
    <span class="ch-say"><span><b>${esc(r.v)}</b>${r.sub ? ' ' + esc(cut(r.sub, 40)) : ''}</span></span>
    ${chFig(st, me)}
    <span class="ch-tag"><span class="ch-name"><i class="ch-dot"></i><span class="ch-nm">${h.staff}</span></span>
      <span class="ch-meta">${h.name} →</span></span>
  </button>`;
}
// The rooms stand like a floor plan rather than a grid: each as wide as its screen weighs (a stuck one widest), a step up
// or down from its neighbours (STAFF_DY), in the list's own order so nobody changes rooms; and in the corridor between
// some of them a plant, a bench or a water cooler (STAFF_HALL).
const STAFF_W = [200, 230, 270, 320], STAFF_DY = [0, 22, 8, 30, 4, 18, 26, 10, 14];
const STAFF_HALL = { 2: 'plant', 4: 'bench', 6: 'cooler' };
const HALL_SVG = {
  plant: () => STAFF_PROP.plant,
  bench: () => `<svg viewBox="0 0 70 40" width="70" height="40"><ellipse class="w3-shadow" cx="35" cy="37" rx="32" ry="2.6"/><rect class="w3-board" x="4" y="16" width="62" height="6" rx="2"/><rect class="w3-board" x="4" y="6" width="62" height="5" rx="2"/>
    <path class="w3-dark" d="M9 22h4v14H9zM57 22h4v14h-4zM9 9h3v8H9zM58 9h3v8h-3z"/></svg>`,
  cooler: () => `<svg viewBox="0 0 34 80" width="34" height="80"><ellipse class="w3-shadow" cx="17" cy="77" rx="14" ry="3"/><rect class="w3-glass" x="5" y="3" width="24" height="30" rx="9"/><rect class="w3-alu" x="3" y="33" width="28" height="44" rx="4"/>
    <rect class="w3-dark" x="10" y="44" width="14" height="9" rx="2"/><circle class="w3-bad" cx="14" cy="48.5" r="1.5"/><circle class="w3-f1" cx="20" cy="48.5" r="1.5"/></svg>`,
};
const staffCell = (h, i) => { const r = hubVal(h), w = hubWeight(r);
  return `<div class="room-floor staff-cell w${w}" data-room="staff-${h.id}" style="--sh:${h.hue};--cw:${STAFF_W[w]}px;--dy:${STAFF_DY[i % STAFF_DY.length]}px">
    <div class="room-wall" aria-hidden="true">${h.wall.map(k => `<span class="wall-item">${(STAFF_WALL[k] || WALL[k])()}</span>`).join('')}</div>
    <span class="staff-plate" aria-hidden="true">${h.room}</span><span class="staff-prop" aria-hidden="true">${STAFF_PROP[h.prop] || ''}</span>${staffHtml(h, r)}</div>`
    + (STAFF_HALL[i] ? `<span class="staff-hall" aria-hidden="true">${HALL_SVG[STAFF_HALL[i]]()}</span>` : ''); };
function staffRoom() {
  needReviews();  // the QA room's figure needs the 워크트리 리뷰 data
  const todo = hmMine().length;
  return `<section class="box room staff-room"><div class="room-h"><b>운영실</b><span class="st">화면마다 맡은 사람 · 누르면 그 화면</span><span class="room-n">${todo ? `내 차례 <b>${todo}</b> · ` : ''}전체 <b>${HUB.length}</b></span></div>
    <div class="staff-rooms">${HUB.map(staffCell).join('')}</div></section>`;
}

// The time of day for the office's light and window sky
const todOf = (h = new Date().getHours()) => h >= 6 && h < 10 ? 'morning' : h >= 10 && h < 17 ? 'day' : h >= 17 && h < 20 ? 'evening' : 'night';
const TOD_NAME = { morning: '아침', day: '낮', evening: '저녁', night: '밤' };
// The lobby: a glass wall onto the city (its sky follows the time of day), and in front of it a reception desk with a
// lamp, the office sign, a lounge (sofa, rug), a coffee machine and a water cooler
function lobbyHtml(people) {
  const d = new Date(), tod = todOf(d.getHours()), busy = people.filter(s => ['run', 'bg'].includes(subBg(s, agg(s), status(s)))).length;
  const desk = `<svg class="lb-wide" viewBox="0 0 150 96" width="240" height="154"><rect class="lb-wood2" x="6" y="44" width="138" height="50" rx="6"/><rect class="lb-wood" x="2" y="38" width="146" height="12" rx="4"/>
    <rect class="lb-dark" x="88" y="20" width="34" height="20" rx="2"/><rect class="lb-metal" x="100" y="38" width="10" height="3"/><path class="lb-dark" d="M24 38v-22h3v22z"/><path class="lb-lamp" d="M14 14h24l-6-10h-12z"/>
    <rect class="lb-metal" x="44" y="30" width="26" height="8" rx="2"/><rect class="lb-pot" x="128" y="24" width="12" height="14" rx="2"/><path class="lb-leaf" d="M134 24c-8-4-8-14-3-18c3 5 4 11 3 18zM134 24c2-9 7-14 12-14c0 7-5 12-12 14z"/></svg>`;
  const lounge = `<svg class="lb-wide" viewBox="0 0 210 96" width="320" height="146"><ellipse class="lb-rug" cx="105" cy="86" rx="100" ry="10"/><rect class="lb-sofa" x="10" y="34" width="120" height="30" rx="12"/>
    <rect class="lb-sofa2" x="18" y="52" width="104" height="24" rx="8"/><rect class="lb-sofa" x="4" y="46" width="18" height="32" rx="8"/><rect class="lb-sofa" x="118" y="46" width="18" height="32" rx="8"/>
    <rect class="lb-dark" x="154" y="20" width="26" height="58" rx="4"/><rect class="lb-metal" x="158" y="26" width="18" height="12" rx="2"/><rect class="lb-lamp" x="163" y="44" width="8" height="4" rx="1"/><rect class="lb-metal" x="160" y="58" width="14" height="10"/>
    <rect class="lb-metal" x="186" y="46" width="20" height="32" rx="3"/><rect class="lb-water" x="188" y="16" width="16" height="30" rx="6"/></svg>`;
  return `<div class="ch-lobby" aria-hidden="true"><i class="lb-city"></i>${desk}<div class="lobby-sign"><b>AGENT OFFICE</b>
      <span>${d.getMonth() + 1}월 ${d.getDate()}일 (${'일월화수목금토'[d.getDay()]}) · ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} · ${TOD_NAME[tod]}</span>
      <small>출근 ${people.length}명 · 일하는 중 ${busy}</small></div>${lounge}</div>`;
}
// A company's sign (one per metrics server, once two or more are on): across the plane above its rooms, with the
// server's name, its rooms and people, and the server's address in the tooltip.
function coSign(x, rs) {
  const ms = rs.flatMap(r => r.ms), busy = ms.filter(s => ['run', 'bg'].includes(subBg(s, agg(s), status(s)))).length, dec = ms.filter(s => s.decision).length;
  return `<div class="ch-co" title="${esc(`메트릭 서버 ${x.url}`)}"><b class="co-name">${esc(x.name)}</b>
    <span class="co-n">방 <b>${rs.length}</b> · 출근 <b>${ms.length}</b>명 · 일하는 중 <b>${busy}</b>${dec ? ` · 결정 <b>${dec}</b>` : ''}</span></div>`;
}

let chLast = {};  // the office last built (renderOffice): its element, its HTML and that HTML parsed (tree)
// Live updates change mostly words: 「n분 전」, the lobby's clock, an action in a tooltip, a count. They are written into
// the office on screen instead of rebuilding it: a rebuild restarts every sprite's animation (the 완료 hop, a 결정's
// pulse) and Live2D canvas, which showed as the characters blinking every few seconds. chPatch walks the last tree (a),
// the new one (b) and the office on screen (l) together and gathers the changes (ctx.ops), or returns false to rebuild:
// a changed part inside CH_SOFT is put in whole, a changed tooltip or label is set, and the rooms on the plane and the
// people in a room (CH_KEYED) are matched by key (chKey) — one that changed in shape (a person in another state) is
// put in anew (ctx.fresh), the rest are patched and stay, moved only when the order changed. Anything else rebuilds.
// The office's own additions (chLinks' lines and team tags, after everything) are not in the trees and are left alone.
const CH_SOFT = '.ch-say, .ch-meta, .room-n, .lobby-sign, .wall-item, .co-n', CH_KEYED = '.ch-world, .room-floor';
const chKey = n => n.dataset.room || n.dataset.id || n.className + '|' + (n.title || '');
function chPatch(l, a, b, ctx) {
  if (!l || a.nodeType !== b.nodeType || l.nodeType !== a.nodeType) return false;
  if (a.nodeType !== 1) { if (a.data !== b.data) ctx.ops.push(() => { l.data = b.data; }); return true; }
  if (a.tagName !== b.tagName) return false;
  if (a.matches(CH_SOFT)) {
    if (a.outerHTML !== b.outerHTML) ctx.ops.push(() => {
      for (const { name } of a.attributes) if (!b.hasAttribute(name)) l.removeAttribute(name);
      for (const { name, value } of b.attributes) l.setAttribute(name, value);
      l.innerHTML = b.innerHTML;
    });
    return true;
  }
  for (const n of new Set([...a.getAttributeNames(), ...b.getAttributeNames()])) {
    const v = b.getAttribute(n);
    if (a.getAttribute(n) === v) continue;
    if (n === 'style' && a.matches('.ch-world')) {  // the grid's columns and room width; the live style keeps the view
      ctx.ops.push(() => ['--cols', '--room-w'].forEach(k => l.style.setProperty(k, b.style.getPropertyValue(k))));
      continue;
    }
    if (n !== 'title' && n !== 'aria-label') return false;
    ctx.ops.push(() => v === null ? l.removeAttribute(n) : l.setAttribute(n, v));
  }
  if (a.matches(CH_KEYED)) return chPatchKeyed(l, a, b, ctx);
  if (a.childNodes.length !== b.childNodes.length) return false;
  for (let i = 0; i < a.childNodes.length; i++) if (!chPatch(l.childNodes[i], a.childNodes[i], b.childNodes[i], ctx)) return false;
  return true;
}
// The elements of l stand in the order of a's (text between them is only spacing and is left as it is).
function chPatchKeyed(l, a, b, ctx) {
  const old = new Map([...a.children].map((x, i) => [chKey(x), [x, l.children[i]]]));
  const plan = [...b.children].map(y => {
    const [x, n] = old.get(chKey(y)) || [];
    if (n && chPatch(n, x, y, ctx)) { old.delete(chKey(y)); return n; }
    return y;
  });
  if (plan.every((n, i) => n === l.children[i]) && plan.length === a.children.length) return true;
  ctx.ops.push(() => {
    // what is not kept leaves; then each in its place, a new one cloned from b (which stays the tree for next time)
    [...old.values()].forEach(([, n]) => n?.remove());
    let at = l.firstElementChild;
    for (const p of plan) {
      const n = p.isConnected ? p : document.importNode(p, true);
      if (n !== at) {
        l.insertBefore(n, at);
        // a moved or new element's animations start again: on the clock's phase like the rest, and a new 완료 hops
        // from the start while a moved one does not hop again
        n.style.setProperty('--ph', `${-(Date.now() % 12000) / 1000}s`);
        n.style.setProperty('--ph-once', n === p ? '-9s' : '0s');
        if (n !== p) ctx.fresh.push(n);
      } else at = at.nextElementSibling;
    }
  });
  return true;
}
function renderOffice() {
  if (chPts.size) { chStale = true; return; }  // a live update during a pan waits for the release
  const { fams, solos } = families();
  const fv = fams.filter(liveFam).sort((a, b) => famRank(a) - famRank(b) || b.started.localeCompare(a.started));
  const sv = byRank(solos.filter(liveSess), sessRank);
  const home = route().v === 'home';
  const people = [...fv.flatMap(f => f.members.filter(m => !filtering() || liveSess(m))), ...sv];
  // 홈 seats only the 운영실; the agents' rooms are the agents tab's
  if (home) chLinkList = [];
  const placed = home ? [] : officeRooms(people);
  // Two or more servers on: each server is a company of its own — a sign across the plane, then that server's rooms —
  // in the order of the server list. Team lines still cross companies.
  const cos = multiSrv() ? srvOn().map(x => ({ x, rs: placed.filter(r => r.srv === x.id) })).filter(c => c.rs.length) : [];
  const rooms = [home ? staffRoom() : ''].concat(cos.length ? cos.flatMap(c => [coSign(c.x, c.rs), ...c.rs.map(r => r.html)]) : placed.map(r => r.html)).filter(Boolean);
  // rooms in a grid as square as it goes (the biggest company's rooms), one column on a narrow screen; together as wide as the canvas at 100%
  const most = cos.length ? Math.max(...cos.map(c => c.rs.length)) : rooms.length;
  const narrow = $('#view').clientWidth <= 700, cols = narrow ? 1 : Math.ceil(Math.sqrt(most));
  const roomW = Math.max(narrow ? 300 : 680, Math.floor(($('#view').clientWidth - 2 - (narrow ? 24 : 56) - 28 * (cols - 1)) / cols));
  document.documentElement.classList.add('ch-full');
  if (scrollY) scrollTo(0, 0);
  // A live update that keeps the office's shape is written into it (chPatch). Otherwise a phase taken from the clock
  // (a multiple of every loop's length) keeps the characters' motion from restarting.
  const html = `<div class="ch-canvas ch-${charStyle} tod-${todOf()}" id="ch-canvas" aria-label="사무실: 바닥을 끌어 이동, Ctrl·⌘ + 휠이나 두 손가락으로 확대">
      ${rooms.length ? `<div class="ch-world office ch-${charStyle}" style="--cols:${cols};--room-w:${roomW}px;--ph:@PH@">${lobbyHtml(people)}${rooms.join('')}</div>` : '<div class="empty">표시할 에이전트가 없습니다.</div>'}
    </div>`;
  const now = $('#ch-canvas');
  if (now && now === chLast.el) {
    if (html === chLast.html) { chLayout(); chSize(); return; }  // the width may have changed
    const t = document.createElement('template');
    t.innerHTML = html;
    const ctx = { ops: [], fresh: [] };
    if (chPatch(now, chLast.tree, t.content.firstElementChild, ctx)) {
      ctx.ops.forEach(f => f());
      chLast = { el: now, html, tree: t.content.firstElementChild };
      chLayout();  // a bubble or a label may be taller or shorter, a person new
      if (ctx.fresh.length) { chBind(ctx.fresh.flatMap(n => n.matches('.ch') ? [n] : [...n.querySelectorAll('.ch')])); L2D.mount($('#view')); }
      chSize();
      return;
    }
  }
  $('#view').innerHTML = html.replace('@PH@', `${-(Date.now() % 12000) / 1000}s;--ph-once:${-(Date.now() % 2400) / 1000}s`);
  const t = document.createElement('template');
  t.innerHTML = html;
  chLast = { el: $('#ch-canvas'), html, tree: t.content.firstElementChild };
  chLayout();
  chBind();
  chSize();
  L2D.mount($('#view'));
}

// ---------- 「캐릭터」 tab: each person's pictures, from the generated base through the SD sprite to Live2D ----------
// One pose at a time in all three stages, so the chain reads left to right: 베이스 (frontend/chars/<who>-<fr>.webp, cut
// from the AI sheet by char-sprites.py) → SD 픽셀 (<who>-sd[-bust].png, an SD chibi pixel sheet drawn from the full base,
// 「AI 생성」 in the office) → Live2D (the base deformed live by L2D). A person can be left out of the office (chPool, this device only);
// the counts are the sessions on show (liveSess) drawn as that person now. Live updates leave the page alone (chxMounted).
const CH_INFO = {
  aoi: ['아오이', '청록 단발 · 크림색 후드'], ren: ['렌', '검은 머리 · 둥근 안경 · 남색 카디건'],
  hina: ['히나', '분홍빛 포니테일 · 니트 조끼'], sora: ['소라', '주황 머리 · 올리브 항공 점퍼'],
  kaede: ['카에데', '검은 긴 머리 · 헤드셋 · 차콜 재킷'], yuki: ['유키', '은발 · 헤드셋 · 하늘색 셔츠'],
};
const CH_POSE_L = ['서 있기 · 입력 대기', '타이핑 · 실행 중', '커피 · 백그라운드', '걱정 · 응답 없음', '졸음 · 유휴', '브이 · 완료', '손 들기 · 결정 대기', '눈 감기 · 깜빡임'];
const CH_POSE_MV = ['wait', 'run', 'bg', 'stalled', 'idle', 'done', 'dec', 'wait'];
let chx = { fr: 'bust', pose: 1 }, chxMounted = false;
try { Object.assign(chx, JSON.parse(localStorage.getItem('adash.chars') || '{}')); } catch {}
function chxStages(who) {
  const fr = chx.fr, a = CH_ART[who][fr], sd = CH_ART[who][chSd(fr)], f = chx.pose, H = 180, W = Math.round(a.w * H / a.h), pw = sd.pw * 2, ph = sd.ph * 2;
  const spr = (src, w, h, cls) => `<span class="cx-spr ${cls}" style="width:${w}px;height:${h}px;background-image:url(${src});background-size:${w * 8}px ${h}px;background-position:${-f * w}px 0"></span>`;
  const st = (name, sub, pic) => `<figure class="cx-st"><div class="cx-pic">${pic}</div><figcaption><b>${name}</b><span>${sub}</span></figcaption></figure>`;
  const arr = (l, t) => `<div class="cx-arr" title="${esc(t)}"><span>${l}</span><i aria-hidden="true"></i></div>`;
  return st('베이스', `AI 생성 원본 · ${a.w}×${a.h}`, spr(chSrc(who, fr), W, H, 'cx-base'))
    + arr('SD화', `전신 베이스를 참조로 AI 가 2등신 SD 픽셀 시트를 그리고(aoi 외는 aoi 의 SD 를 비율 템플릿으로), char-sprites.py 가 ${sd.ph}행 격자에 블록마다 가장 많은 색으로 정리`)
    + st('SD 픽셀', `「AI 생성」 · ${sd.pw}×${sd.ph} · 2배`, spr(chSdSrc(who, fr), pw, ph, 'cx-px'))
    + arr('Live2D', '베이스 그림을 숨쉬기·고개 기울임·머리카락 흔들림·깜빡임으로 실시간 변형')
    + st('Live2D', '베이스를 실시간 변형', `<canvas class="fig-l2d ${fr}" width="${W * 2}" height="${H * 2}" style="width:${W}px;height:${H}px" data-who="${who}" data-mv="${CH_POSE_MV[f]}" data-fr="${fr}" aria-hidden="true"></canvas>`);
}
function chxCard(who, boss, n) {
  const [name, look] = CH_INFO[who].map(esc), on = chPool[who] !== false, a = CH_ART[who][chSd(chx.fr)];
  const thumbs = [...Array(8).keys()].map(i => `<button type="button" class="cx-pose${i === chx.pose ? ' on' : ''}" data-pose="${i}" aria-pressed="${i === chx.pose}" data-tip="${esc(CH_POSE_L[i])}" aria-label="${esc(CH_POSE_L[i])}">
      <span style="width:${a.pw}px;height:${a.ph}px;background-image:url(${chSdSrc(who, chx.fr)});background-size:${a.pw * 8}px ${a.ph}px;background-position:${-i * a.pw}px 0"></span></button>`).join('');
  return `<section class="cx surface${on ? '' : ' off'}" data-who="${who}">
    <div class="cx-h"><h3>${name}<span class="badge">${boss ? '코디네이터' : '워커'}</span></h3><span class="cx-look">${look}</span>
      <span class="cx-n">${on ? `맡은 세션 <b>${n}</b>` : '배치 안 함'}</span>
      <label class="cx-on"><input type="checkbox" data-pool="${who}"${on ? ' checked' : ''}> 사무실에 배치</label></div>
    <div class="cx-flow">${chxStages(who)}</div>
    <div class="cx-poses" role="group" aria-label="포즈">${thumbs}</div>
    <div class="cx-files"><code>chars/${who}-${chx.fr}.webp</code><code>chars/${who}-sd${chx.fr === 'bust' ? '-bust' : ''}.png</code>
      ${chR2.has(who) ? `<span class="badge" title="배포 없이 R2 에 올린 캐릭터 (scripts/char-publish.py)">R2</span>
      <button type="button" class="act danger" data-cx-del="${who}" title="R2 에서 내려 모든 기기의 사무실에서 뺌">삭제</button>` : `<button type="button" class="act" data-copy="scripts/char-gen.sh ${who} ${chx.fr}" title="이 그림을 다시 만드는 명령을 복사 (전신을 먼저 만들어야 상반신이 그 모습을 따름)">재생성 명령 복사</button>
      <button type="button" class="act" data-copy="scripts/char-gen.sh ${who} sd" title="SD 픽셀 시트를 다시 만드는 명령을 복사 (전신 베이스를 참조함)">SD 재생성 명령 복사</button>
      ${(boss ? CH_BOSS : CH_CREW).length > 1 ? `<button type="button" class="act danger" data-cx-del="${who}" title="기본 캐릭터를 모든 기기의 사무실에서 뺌 (아래에서 되살릴 수 있음)">삭제</button>` : ''}`}</div>
  </section>`;
}
// 「새 캐릭터」: one picture (and a name) from this device goes to a metric server, which hands it with a brief to an Orca
// agent in the agent-dashboard repo: the agent writes the description, draws the full sheet from the picture, then bust
// and the SD sheet from that (scripts/char-gen.sh), and puts them up (scripts/char-publish.py). The job list below the
// form reads how far each got from the files the agent leaves (/api/chars/jobs), every few seconds while one runs; a
// job turning 「게시됨」 reloads chars.json, so the new person joins without a reload. The form survives re-renders (cn).
const cn = { img: '', fname: '', who: '', name: '', look: '', boss: false, notes: '', agent: 'claude', server: null, busy: false, msg: '', cls: '' };
let cnJobs = null, cnSeen = '', cnTimer = 0;
const CN_STEPS = [['ref', '원본'], ['desc', '설명'], ['full', '전신'], ['bust', '상반신'], ['sd', 'SD'], ['published', '게시']];
const CN_WHO = /^[a-z][a-z0-9-]{1,23}$/;
const cnCan = () => !cn.busy && cn.img && CN_WHO.test(cn.who) && cn.name.trim() && !/'/.test(cn.name + cn.look) && cn.server;
function cnHtml() {
  const on = srvOn();
  if (!on.some(x => x.id === cn.server)) cn.server = on[0]?.id || null;
  const opt = (v, label, cur) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
  return `<section class="cn surface" id="cn" aria-labelledby="cn-h">
    <div class="cx-h"><h3 id="cn-h">새 캐릭터</h3><span class="cx-look">원본 그림 한 장 → Orca 에이전트가 설명을 쓰고 전신·상반신(Live2D)·SD 픽셀을 그려 배포 없이 올립니다 · 20~40분</span></div>
    <div class="cn-body">
      <label class="cn-drop${cn.img ? ' has' : ''}" title="PNG·JPEG·WebP, 10MB 까지 — 사람 사진이면 얼굴은 닮게 그리지 않고 머리·옷·색만 가져옵니다">
        ${cn.img ? `<img src="${cn.img}" alt="고른 원본 그림">` : '<span>원본 그림 고르기<br><small>또는 여기에 끌어 놓기</small></span>'}
        <input type="file" accept="image/png,image/jpeg,image/webp" data-cn-file hidden></label>
      <div class="cn-form">
        <label class="lp-row"><span>표시 이름</span><input class="field" data-cn="name" value="${esc(cn.name)}" placeholder="미오" maxlength="20" autocomplete="off"></label>
        <label class="lp-row"><span>영문 이름</span><input class="field" data-cn="who" value="${esc(cn.who)}" placeholder="mio" maxlength="24" spellcheck="false" autocomplete="off" pattern="[a-z][a-z0-9\\-]{1,23}"></label>
        <div class="lp-row"><span>역할</span><span class="seg" data-cn-seg="boss"><button type="button" data-k="">워커</button><button type="button" data-k="1">코디네이터 (헤드셋)</button></span></div>
        <label class="lp-row"><span>생김새</span><input class="field" data-cn="look" value="${esc(cn.look)}" placeholder="비우면 에이전트가 원본을 보고 씀 (예: 빨간 단발 · 노란 우비)" maxlength="80" autocomplete="off"></label>
        <textarea class="field" data-cn="notes" rows="2" maxlength="1000" placeholder="요청 (선택) — 예: 안경은 빼고, 머리는 더 길게" aria-label="요청">${esc(cn.notes)}</textarea>
        <div class="lp-row"><span>에이전트</span><span class="seg" data-cn-seg="agent"><button type="button" data-k="claude">Claude</button><button type="button" data-k="codex">Codex</button></span>
          ${on.length > 1 ? `<select class="field" data-cn="server" aria-label="서버">${on.map(x => opt(x.id, x.name, cn.server)).join('')}</select>` : ''}</div>
        <p class="lp-help">영문 이름은 파일 이름이 됩니다(소문자·숫자·<code>-</code>). 그림은 그 서버의 Mac 에서 Codex 이미지 생성으로 그리고, 에이전트는 Orca 의 agent-dashboard 탭에 뜹니다.</p>
        <div class="lp-foot"><span class="sp-msg ${cn.cls}">${esc(cn.msg)}</span>
          <button class="act big accent" data-cn-go${cnCan() ? '' : ' disabled'}>${cn.busy ? '맡기는 중…' : 'Orca 에 맡기기'}</button></div>
      </div>
    </div>
    <div id="cn-jobs">${cnJobsHtml()}</div>
  </section>`;
}
function cnJobsHtml() {
  if (!cnJobs?.length) return '';
  const ago = t => { const m = Math.round((Date.now() / 1000 - t) / 60); return m < 1 ? '방금' : m < 60 ? `${m}분 전` : `${Math.round(m / 60)}시간 전`; };
  return `<div class="cn-jobs">${cnJobs.map(j => {
    const st = j.state === 'published' ? ['ok', '게시됨'] : j.state === 'removed' ? ['', '삭제됨'] : j.state === 'failed' ? ['bad', '실패'] : ['run', '만드는 중'];
    const steps = CN_STEPS.map(([k, l], i) => {
      const d = k === 'ref' || j.done.includes(k), next = !d && j.state === 'running' && CN_STEPS.slice(0, i).every(([x]) => x === 'ref' || j.done.includes(x));
      return `<li class="${d ? 'on' : next ? 'now' : ''}">${l}</li>`;
    }).join('');
    const pic = (f, l) => `<a href="${api.charFile(j.server, j.id, f, j.updated)}" target="_blank" rel="noopener" title="${l} — 새 탭에서 크게"><img src="${api.charFile(j.server, j.id, f, j.updated)}" alt="${l}" loading="lazy"></a>`;
    return `<article class="cn-job" data-job="${esc(j.id)}">
      <div class="cn-pics">${pic('ref', '원본')}${['full', 'bust', 'sd'].filter(f => j.sheets.includes(f)).map(f => pic(f, CN_STEPS.find(x => x[0] === f)[1] + ' 시트')).join('')}</div>
      <div class="cn-meta"><div class="cx-h"><h3>${esc(j.name)}<span class="badge">${j.boss ? '코디네이터' : '워커'}</span></h3><code>${esc(j.who)}</code>
        <span class="cn-st ${st[0]}">${st[1]}</span><span class="cx-n">${esc(j.agent)} · ${ago(j.created)} 시작</span></div>
        <ol class="cn-steps" aria-label="진행">${steps}</ol>
        ${j.error ? `<p class="sp-msg bad">${esc(j.error)}</p>` : ''}
        <div class="cx-files">${j.handle && j.state === 'running' ? `<button type="button" class="act" data-cn-focus="${esc(j.handle)}">Orca 에서 보기</button>` : ''}
          ${j.state !== 'running' ? `<button type="button" class="act" data-cn-rm="${esc(j.id)}" data-srv="${esc(j.server)}" title="작업 폴더를 지움 (올린 캐릭터는 그대로 — 내리려면 char-publish.py --remove)">목록에서 지우기</button>` : ''}</div>
      </div></article>`;
  }).join('')}</div>`;
}
function cnBind() {
  const el = $('#cn');
  if (!el) return;
  const redraw = () => { el.outerHTML = cnHtml(); cnBind(); };
  const pick = f => {
    if (!f) return;
    if (!/^image\/(png|jpeg|webp)$/.test(f.type)) { cn.msg = 'PNG·JPEG·WebP 만 됩니다'; cn.cls = 'bad'; return redraw(); }
    if (f.size > 10 << 20) { cn.msg = '10MB 까지입니다'; cn.cls = 'bad'; return redraw(); }
    const r = new FileReader();
    r.onload = () => { cn.img = r.result; cn.fname = f.name; cn.msg = ''; redraw(); };
    r.readAsDataURL(f);
  };
  const drop = el.querySelector('.cn-drop');
  el.querySelector('[data-cn-file]').onchange = e => pick(e.target.files[0]);
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); pick(e.dataTransfer.files[0]); };
  el.querySelectorAll('[data-cn-seg] button').forEach(b => {
    const k = b.closest('[data-cn-seg]').dataset.cnSeg, v = k === 'boss' ? !!b.dataset.k : b.dataset.k;
    b.classList.toggle('on', cn[k] === v); b.setAttribute('aria-pressed', cn[k] === v);
    b.onclick = () => { cn[k] = v; redraw(); };
  });
  el.querySelectorAll('[data-cn]').forEach(f => f.oninput = f.onchange = () => {
    cn[f.dataset.cn] = f.value;
    el.querySelector('[data-cn-go]').disabled = !cnCan();
  });
  el.querySelector('[data-cn-go]').onclick = cnCreate;
  cnJobsBind();
}
function cnJobsBind() {
  $('#cn-jobs')?.querySelectorAll('[data-cn-focus]').forEach(b => b.onclick = () => api.focus(b.dataset.cnFocus)
    .then(x => x.status !== 200 && toast(x.body?.error || 'Orca 전환 실패')));
  $('#cn-jobs')?.querySelectorAll('[data-cn-rm]').forEach(b => b.onclick = async () => {
    const r = await api.charRemove(b.dataset.srv, b.dataset.cnRm);
    if (r.status !== 200) return toast(r.body?.error || '지우지 못했습니다');
    cnPoll();
  });
}
async function cnCreate() {
  if (!cnCan()) return;
  const say = (msg, cls = '') => { cn.msg = msg; cn.cls = cls; const el = $('#cn'); if (el) { el.outerHTML = cnHtml(); cnBind(); } };
  cn.busy = true; say('원본을 보내고 에이전트를 띄우는 중…');
  const r = await api.charCreate(cn.server, { who: cn.who, name: cn.name.trim(), look: cn.look.trim(), boss: cn.boss, notes: cn.notes.trim(),
    agent: cn.agent, image: cn.img.slice(cn.img.indexOf(',') + 1) });
  cn.busy = false;
  if (r.status !== 202) return say(r.body?.error || `맡기지 못했습니다 (${r.status})`, 'bad');
  const name = cn.name.trim();
  Object.assign(cn, { img: '', fname: '', who: '', name: '', look: '', notes: '' });
  say(`「${name}」 을(를) Orca 에 맡겼습니다 — 아래에서 진행을 봅니다`, 'ok');
  toast(`「${cut(name, 20)}」 캐릭터 생성을 Orca 에 맡겼습니다`);
  cnPoll();
}
// The job list, refreshed in place (the form keeps its focus): every 5 s while a job runs and this tab is shown.
async function cnPoll() {
  clearTimeout(cnTimer);
  if (route().v !== 'chars') return;
  if (document.hidden) { cnTimer = setTimeout(cnPoll, 5000); return; }
  let jobs;
  try { jobs = await api.charJobs(); } catch { jobs = cnJobs || []; }
  const before = new Set((cnJobs || []).filter(j => j.state === 'published').map(j => j.id));
  const key = JSON.stringify(jobs);
  if (key !== cnSeen) {
    cnSeen = key;
    const first = cnJobs === null;
    cnJobs = jobs;
    const el = $('#cn-jobs');
    if (el) { el.innerHTML = cnJobsHtml(); cnJobsBind(); }
    if (!first && jobs.some(j => j.state === 'published' && !before.has(j.id))) chLoad();
  }
  if (jobs.some(j => j.state === 'running')) cnTimer = setTimeout(cnPoll, 5000);
}
// 「삭제」: a metric server runs char-publish.py --remove, then this page reads chars.json again at once (other pages
// within a minute). A person put up without a deploy (R2) loses their pictures there; a built-in one (in the deploy) is
// listed as hidden instead and can be brought back below the lists (chRestore). The last of a list stays.
async function chDelete(who, b) {
  const name = CH_INFO[who]?.[0] || who, srv = srvOn().find(x => x.live)?.id, r2 = chR2.has(who) && !(who in chBase?.art);
  if (!srv) return toast('연결된 메트릭 서버가 없습니다');
  if (!await uiConfirm(r2 ? `「${name}」(${who}) 캐릭터를 삭제할까요?\n\nR2 에서 그림과 목록 항목을 지워 모든 기기의 사무실에서 빠지고, 맡던 세션은 다른 캐릭터가 이어받습니다. 작업 폴더의 원본·시트는 남습니다.`
    : `기본 캐릭터 「${name}」(${who}) 을(를) 삭제할까요?\n\n모든 기기의 사무실과 캐릭터 목록에서 빠지고, 맡던 세션은 다른 캐릭터가 이어받습니다. 그림은 배포본에 남아 이 탭 아래 「삭제한 기본 캐릭터」에서 되살릴 수 있습니다.`, { ok: '삭제', danger: true })) return;
  b.disabled = true; b.textContent = '삭제 중…';
  const r = await api.charUnpublish(srv, who);
  if (r.status !== 200) { b.disabled = false; b.textContent = '삭제'; return toast(r.body?.error || `삭제하지 못했습니다 (${r.status})`); }
  delete chPool[who];
  try { localStorage.setItem('adash.chpool', JSON.stringify(chPool)); } catch {}
  chSeen = '';
  await chLoad();
  cnPoll();
  toast(`「${cut(name, 20)}」 캐릭터를 삭제했습니다`);
}
async function chRestore(who, b) {
  const name = chBase?.info[who]?.[0] || who, srv = srvOn().find(x => x.live)?.id;
  if (!srv) return toast('연결된 메트릭 서버가 없습니다');
  b.disabled = true; b.textContent = '되살리는 중…';
  const r = await api.charRestore(srv, who);
  if (r.status !== 200) { b.disabled = false; b.textContent = '되살리기'; return toast(r.body?.error || `되살리지 못했습니다 (${r.status})`); }
  chSeen = '';
  await chLoad();
  toast(`「${cut(name, 20)}」 캐릭터를 되살렸습니다`);
}
function renderChars() {
  if (chxMounted) return;  // nothing here follows the live data closely enough to rebuild under the pointer
  const save = () => { try { localStorage.setItem('adash.chars', JSON.stringify(chx)); } catch {} };
  const cnt = {}; state.sessions.filter(liveSess).forEach(s => { const w = chWho(s); cnt[w] = (cnt[w] || 0) + 1; });
  const group = (title, l, boss) => `<div class="sec-h"><h2>${title}</h2><span>${l.filter(w => chPool[w] !== false).length}/${l.length}명 배치</span></div>
    <div class="cx-list">${l.map(w => chxCard(w, boss, cnt[w] || 0)).join('')}</div>`;
  $('#view').innerHTML = `<div class="controls">
      <span class="seg" id="cx-fr"><button data-k="bust">상반신</button><button data-k="full">전신</button></span>
      <span class="st">${esc(CH_POSE_L[chx.pose])} — 아래 포즈를 누르면 세 단계가 함께 바뀝니다. 배치는 이 기기에만 저장됩니다.</span>
    </div>
    ${cnHtml()}
    ${group('코디네이터', CH_BOSS, true)}${group('워커', CH_CREW, false)}
    ${chHidden.size ? `<div class="sec-h"><h2>삭제한 기본 캐릭터</h2><span>${chHidden.size}명</span></div>
    <div class="cx-gone">${[...chHidden].map(w => `<span class="cx-gone-1 surface"><b>${esc(chBase.info[w][0])}</b><code>${w}</code>
      <button type="button" class="act" data-cx-back="${w}" title="모든 기기의 사무실과 목록에 다시 넣음">되살리기</button></span>`).join('')}</div>` : ''}
    <div class="st" style="margin-top:10px">한 목록에서 모두 끄면 그 목록 전원이 배치됩니다. 기본 캐릭터 그림은 <code>scripts/char-gen.sh</code> 로 만듭니다. 새 캐릭터는 위 「새 캐릭터」나 <code>scripts/char-publish.py</code> 로 올리면 배포 없이 더해집니다.</div>`;
  $('#cx-fr').querySelectorAll('button').forEach(b => {
    b.classList.toggle('on', b.dataset.k === chx.fr); b.setAttribute('aria-pressed', b.dataset.k === chx.fr);
    b.onclick = () => { chx.fr = b.dataset.k; save(); chxMounted = false; renderChars(); };
  });
  $('#view').querySelectorAll('.cx-pose').forEach(b => b.onclick = () => { chx.pose = +b.dataset.pose; save(); chxMounted = false; renderChars(); });
  $('#view').querySelectorAll('[data-pool]').forEach(c => c.onchange = () => {
    if (c.checked) delete chPool[c.dataset.pool]; else chPool[c.dataset.pool] = false;
    try { localStorage.setItem('adash.chpool', JSON.stringify(chPool)); } catch {}
    chxMounted = false; renderChars();
  });
  $('#view').querySelectorAll('[data-cx-del]').forEach(b => b.onclick = () => chDelete(b.dataset.cxDel, b));
  $('#view').querySelectorAll('[data-cx-back]').forEach(b => b.onclick = () => chRestore(b.dataset.cxBack, b));
  $('#view').querySelectorAll('[data-copy]').forEach(b => b.onclick = () => navigator.clipboard?.writeText(b.dataset.copy)
    .then(() => toast('명령을 복사했습니다'), () => toast('복사하지 못했습니다')));
  cnBind();
  chxMounted = true;
  L2D.mount($('#view'));
  cnPoll();
}

function renderAgents() {
  if (charMode) return renderOffice();
  const { fams, solos } = families();
  const fv = fams.filter(liveFam), sv = solos.filter(liveSess);
  // 「서버별 보기」: one block per server that is on, in list order. A family belongs to its coordinator's server.
  const famSrv = f => (f.coord || f.members[0])?.server;
  const top = state.sessions.filter(s => !s.parent), up = agView === 'wt' ? coordOf(fams) : null;
  const one = x => agView === 'wt' ? wtHtml(top, fams, up, x)
    : agentsHtml(fv.filter(f => !x || famSrv(f) === x.id), sv.filter(s => !x || s.server === x.id), x);
  const seg = `<div class="controls ag-controls"><span class="seg" id="ag-view"><button data-k="tree">코디네이터 트리</button><button data-k="wt">워크트리별</button><button data-k="map">관계 지도</button><button data-k="tl">타임라인</button></span></div>`;
  if (agView === 'map' || agView === 'tl') {  // the flow views: one picture over every server that is on
    $('#view').innerHTML = seg + (agView === 'map' ? mapHtml() : tlHtml());
    agViewBind();
    if (agView === 'map') mapBind(); else { tlBind(); tlFill(); }
    return;
  }
  const h = srvView === 'split' && multiSrv() ? srvOn().map(one).join('').replace('sec-h srv-h', 'sec-h srv-h first') : one(null);
  $('#view').innerHTML = seg + testsHtml() + (h || '<div class="empty">표시할 에이전트가 없습니다.</div>') + extPlansHtml((state.ext_plans || []).filter(p => !planOwner(p)));
  agViewBind();
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
  $('#view').querySelectorAll('[data-wtoggle]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    const k = 'wt:' + b.dataset.wtoggle;
    famMin[k] = !famMin[k];
    try { localStorage.setItem('adash.min', JSON.stringify(famMin)); } catch {}
    { const sv = saveScroll(); renderAgents(); restoreScroll(sv); }
  });
  $('#view').querySelectorAll('[data-jump]').forEach(a => a.onclick = e => { e.preventDefault(); e.stopPropagation(); wtJump(a.dataset.jump); });
  $('#view').querySelectorAll('[data-wtgo]').forEach(a => a.onclick = e => {
    e.preventDefault(); e.stopPropagation();
    const k = a.dataset.wtgo;
    if (famMin['wt:' + k]) { famMin['wt:' + k] = false; try { localStorage.setItem('adash.min', JSON.stringify(famMin)); } catch {} renderAgents(); }
    document.getElementById(wtId(k))?.scrollIntoView({ block: 'start' });
  });
  wtMark();
}

// 「워크트리별」 보기: top-level sessions grouped by the worktree they run in (placeKey; per server too once more than
// one is on, since the same path on two Macs is two worktrees). Subagents stay folded into their parent's card.
// Inside a worktree the coordinator → worker relation is kept as a small tree. A worker whose coordinator runs in
// another worktree gets a one-line link up to it, and that coordinator lists those workers per worktree.
const wtKey = s => (multiSrv() ? (s.server || '') + '|' : '') + placeKey(s.place);
const wtId = k => 'wt-' + [...k].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36);
// The family each worker sits under in the coordinator tree, so script-driven workers resolve to the session that
// opened the script, as they do there.
function coordOf(fams) {
  const m = new Map();
  m.head = new Map();  // coordinator path -> the family it heads, for folding its block like the tree view does
  const walk = f => { if (f.coord) m.head.set(f.coord.path, f); f.workers.forEach(w => m.set(w.path, f)); f.subs.forEach(x => { if (x.coord) m.set(x.coord.path, f); walk(x); }); };
  fams.forEach(walk);
  return m;
}
// A small stand-in for a session drawn in another worktree: role, name, state and that worktree; it links to the card.
function wtProxy(x) {
  const st = status(x), r = x.role === 'coordinator' ? ['coord', '코디네이터'] : isSubCoord(x) ? ['subcoord', '하위 코디네이터'] : ['worker', '워커'];
  return `<a class="wt-proxy wt-px-${r[0]}" href="#s=${encodeURIComponent(x.path)}" data-jump="${esc(x.path)}" title="${esc(placeLabel(x.place))} 의 카드로 이동"><span class="badge ${r[0]}">${r[1]}</span><b class="wt-px-nm">${esc(nameOf(x))}</b>${pill(st, x)}<span class="wt-px-wt">▣ ${esc(wtShort(x.place))}</span><span class="wt-px-go">카드로 이동 ↗</span></a>`;
}
// Each worktree holds, ordered by state like the tree view: the families whose coordinator runs there (drawn by
// famHtml, folding included), its solo sessions, and per coordinator elsewhere a block headed by that coordinator's
// stand-in with its workers (and sub-trees) that run here.
function wtHtml(top, fams, up, srv) {
  const inSrv = x => !srv || x.server === srv.id;
  const all = [], flat = f => { all.push(f); f.subs.forEach(flat); };
  fams.forEach(flat);
  const secs = new Map(), sec = k => secs.get(k) || secs.set(k, { key: k, items: [], ext: new Map() }).get(k);
  const addExt = (k, pf, it) => {
    const S = sec(k);
    let g = S.ext.get(pf.key);
    if (!g) { S.ext.set(pf.key, g = { pf, list: [], r: 9, started: '' }); S.items.push(g); }
    g.list.push(it); g.r = Math.min(g.r, it.r); if (it.started > g.started) g.started = it.started;
  };
  for (const f of all) {
    if (!f.coord || !inSrv(f.coord) || !liveFam(f)) continue;
    const k = wtKey(f.coord), pf = up.get(f.coord.path), it = { f, r: famRank(f), started: f.started };
    if (!pf) sec(k).items.push(it);
    else if (!pf.coord || wtKey(pf.coord) !== k) addExt(k, pf, it);  // a sub-tree whose parent runs elsewhere
  }
  // Script drivers move to their ticket's worktree, under a stand-in of the coordinator that opened them; their workers
  // there are drawn inside the driver block.
  const drvAt = new Map();  // moved driver handle -> its worktree key
  const tkAt = new Map();  // worktree key -> every driver drawn there, for the checkbox plan under its header
  for (const f of all) {
    if (!f.coord || !inSrv(f.coord) || !liveFam(f)) continue;
    for (const d of famDrivers(f)) {
      const k = drvWtKey(d, f);
      if (k && liveDrv(d)) (tkAt.get(k) || tkAt.set(k, []).get(k)).push(d);
      if (!k || k === wtKey(f.coord) || !liveDrv(d)) continue;
      drvAt.set(d.handle, k);
      addExt(k, f, { d, place: drvPlace(d.handle), r: drvRank(d), started: d.workers.map(w => w.started || '').sort().pop() || '' });
    }
  }
  // Coordinator-less families (their coordinator is outside the window) count as "elsewhere" for every worker.
  for (const s of top) {
    if (!inSrv(s) || up.head.has(s.path) || !liveSess(s)) continue;
    if (s.viaHandle && drvAt.get(s.viaHandle) === wtKey(s)) continue;  // drawn in its driver's block
    const pf = up.get(s.path), k = wtKey(s), it = { s, r: sessRank(s), started: s.started || '' };
    if (!pf) sec(k).items.push(it);
    else if (!pf.coord || wtKey(pf.coord) !== k) addExt(k, pf, it);
  }
  // Worktrees under a coordinator come first, grouped by their top coordinator: its own worktree, then the ones its
  // workers and drivers run in. Worktrees with only solo sessions follow. Inside a group (and among the solo ones) by state.
  const rootOf = f => { for (let n = 0; f.coord && up.get(f.coord.path) && n < 8; n++) f = up.get(f.coord.path); return f.key; };
  const byState = (a, b) => a.r - b.r || b.started.localeCompare(a.started);
  const list = [...secs.values()].map(x => {
    const own = x.items.find(it => it.f && !up.get(it.f.coord.path)), ext = x.items.find(it => it.list);
    return { ...wtSec(x, tkAt.get(x.key)), root: own ? rootOf(own.f) : ext ? rootOf(ext.pf) : null, head: !!own };
  }).filter(x => x.html);
  const groups = new Map();
  for (const x of list) if (x.root) (groups.get(x.root) || groups.set(x.root, []).get(x.root)).push(x);
  const lead = xs => xs.find(x => x.head) || xs.slice().sort(byState)[0];
  const ordered = [...groups.values()].sort((a, b) => byState(lead(a), lead(b)))
    .flatMap(xs => xs.sort((a, b) => b.head - a.head || byState(a, b)));
  list.splice(0, list.length, ...ordered, ...list.filter(x => !x.root).sort(byState));
  const n = list.reduce((a, x) => a + x.n, 0);
  const fold = `<span class="fold-all"><button class="act" data-fold="open" title="코디네이터 묶음·드라이버·티켓·저장소를 모두 펼침">모두 펼치기</button><button class="act" data-fold="min" title="모두 최소화">모두 최소화</button></span>`;
  const head = srv ? `<div class="sec-h srv-h">${srvTitle(srv)}<span>에이전트 ${n} · 워크트리 ${list.length}</span>${fold}</div>` : `<div class="sec-h"><h2>에이전트 ${n}</h2><span>워크트리 ${list.length}</span>${fold}</div>`;
  if (!list.length) return srv ? head + '<div class="empty srv-empty">표시할 에이전트가 없습니다.</div>' : '';
  // Sections wrap in sort order and share each line equally (two on a line take half each, a lone one the full width);
  // the span (1–3) sets how narrow a section may get, so a wide one starts a new line rather than squeeze.
  return head + `<div class="wt-wrap"><div class="wt-tiles">${list.map(x => `<div class="wt-tile s${x.span}">${x.html}</div>`).join('')}</div></div>`;
}
const WT_ST = ['stalled', 'wait', 'run', 'bg', 'idle', 'done'];
function wtSec({ key, items }, drivers = []) {
  // Sessions drawn here, for the header: family members in this worktree that pass the filters, plus their coordinators.
  const ss = new Set();
  for (const it of items) for (const x of it.list || [it]) {
    if (x.s) ss.add(x.s);
    else if (x.d) x.d.workers.filter(m => wtKey(m) === key && liveSess(m)).forEach(m => ss.add(m));
    else x.f.members.filter(m => wtKey(m) === key && (m === x.f.coord || liveSess(m))).forEach(m => ss.add(m));
  }
  const arr = [...ss], min = famMin['wt:' + key], drvs = items.flatMap(it => it.list || [it]).filter(x => x.d);
  if (!arr.length && !drvs.length) return { n: 0 };
  const folded = it => +!!(it.f && shut(it.f));  // minimised coordinators after expanded ones
  items.sort((a, b) => folded(a) - folded(b) || a.r - b.r || b.started.localeCompare(a.started));
  // span: columns (1–3) the section takes in the worktree tile grid, from its widest row — a card row's length, an open
  // driver's own tile span, 3 for an expanded coordinator family.
  let span = 1;
  const want = n => { span = Math.max(span, Math.min(3, n)); };
  const grp = x => x.f ? 0 : x.d ? 1 : 2;  // under a coordinator: sub-trees, then drivers, then plain workers (as in famHtml)
  const grid = (its, solo) => {
    let out = '', cells = [];
    const flush = () => { if (cells.length) { want(cells.length); out += `<div class="grid">${cells.join('')}</div>`; } cells = []; };
    for (const it of its) {
      if (it.list) { flush(); out += `<div class="family nested wt-ext st-${famStatus(it.list.map(x => ({ st: x.f ? x.f.st : x.d ? drvSt(x.d) : status(x.s) })))}"><div class="wt-px-row"><div class="grid">${it.pf.coord ? wtProxy(it.pf.coord)
        : `<div class="wt-proxy off"><span class="badge coord">코디네이터</span><b class="wt-px-nm">${esc(ownerName(it.pf.handle))}</b><span class="wt-px-wt">추적 범위 밖</span></div>`}</div></div><div class="tree">${grid(it.list.sort((a, b) => grp(a) - grp(b) || a.r - b.r || b.started.localeCompare(a.started)))}</div></div>`; }
      else if (it.d) { flush(); const h = driverHtml(it.d, true); want(h.startsWith(TILE) ? +h.slice(TILE.length, h.indexOf('-->')) : 1); out += cellsJoin([h]); }
      else if (it.f) { if (shut(it.f)) cells.push(miniFam(it.f)); else { flush(); want(3); out += famHtml(it.f, key); } }
      else cells.push(card(it.s, solo && it.s.role === 'solo' ? 'solo' : ''));
    }
    flush();
    return out;
  };
  const p = arr.find(s => s.place)?.place || drvs[0]?.place;
  const cnt = {}; arr.forEach(s => { const st = status(s); cnt[st] = (cnt[st] || 0) + 1; });
  const nc = arr.filter(s => s.role === 'coordinator').length, nw = arr.filter(s => s.role === 'worker').length, ns = arr.length - nc - nw;
  const cross = items.filter(it => it.list).reduce((a, it) => a + it.list.filter(x => !x.d).length, 0);
  const name = !p ? '위치 미상' : p.worktree && p.worktree !== p.project ? p.worktree : p.main && p.branch ? '메인' : p.project;
  const body = min ? '' : drivers.map(d => ticketsHtml(d, filtering())).join('') + grid(items, true);
  const html = `<section class="wt-sec st-${famStatus(arr.map(m => ({ st: status(m) })))}" id="${wtId(key)}" data-wtkey="${esc(key)}">
    <div class="wt-h" title="${esc(p?.path || '')}"><span class="wt-proj">${esc(p?.project || '')}</span><h3>▣ ${esc(name)}</h3>${p?.branch && p.branch !== name ? `<span class="wt-br">⎇ ${esc(p.branch)}</span>` : ''}${srvBadge(arr[0])}
      <span class="wt-cnt"><span>에이전트 <b>${arr.length}</b></span>${nc ? `<span>코디네이터 <b>${nc}</b></span>` : ''}${nw ? `<span>워커 <b>${nw}</b></span>` : ''}${ns ? `<span>단독 <b>${ns}</b></span>` : ''}${drvs.length ? `<span title="이 워크트리의 티켓을 맡은 스크립트 드라이버">드라이버 <b>${drvs.length}</b></span>` : ''}${cross ? `<span title="코디네이터가 다른 워크트리에 있는 워커">다른 워크트리 코디네이터 소속 <b>${cross}</b></span>` : ''}</span>
      <span class="wt-pills">${WT_ST.filter(k => cnt[k]).map(k => `<ds-pill state="${k}">${ST_LABEL[k]} ${cnt[k]}</ds-pill>`).join('')}</span>
      <button class="tgl" data-wtoggle="${esc(key)}">${min ? '▸ 펼치기' : '▾ 최소화'}</button></div>
    ${body}</section>`;
  return { n: arr.length, html, span: min ? 1 : span, r: Math.min(...items.map(it => it.r)), started: items.map(it => it.started).sort().pop() || '' };
}
// A relation link scrolls to its target card and marks it for a moment; a folded worktree is opened first, and a
// target that is not on screen (filtered out, another tab) opens the session instead.
let wtFlash = null;
function wtJump(path) {
  const s = state.sessions.find(x => x.path === path), k = s && wtKey(s);
  // Open what hides the target: its worktree, and every folded family above it.
  let changed = false;
  if (k && famMin['wt:' + k]) { famMin['wt:' + k] = false; changed = true; }
  const up = coordOf(families().fams);
  for (let f = up.get(path), n = 0; f && n < 8; f = f.coord && up.get(f.coord.path), n++) if (isMin(f)) { famMin[f.key] = false; changed = true; }
  if (changed) { try { localStorage.setItem('adash.min', JSON.stringify(famMin)); } catch {} renderAgents(); }
  const sel = `.card[data-path="${CSS.escape(path)}"]`, el = $('#view').querySelector(sel);
  if (!el) return openSession(path);
  el.scrollIntoView({ block: 'center' });  // not smooth: a live re-render restores the scroll it saved and would cut a smooth one short
  wtFlash = { sel, until: Date.now() + 1800 };
  wtMark();
}
function wtMark() {
  if (!wtFlash || Date.now() > wtFlash.until) return (wtFlash = null);
  const el = $('#view').querySelector(wtFlash.sel);
  if (!el) return;
  el.classList.add('wt-flash');
  setTimeout(() => el.classList.remove('wt-flash'), wtFlash.until - Date.now());
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
  const w = box.clientWidth - 24 || 600, h = (narrow() ? 200 : 260) + (multiDay ? 12 : 0);
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
    <div class="box"><h3>타임라인</h3><div class="tscroll"><table>${gantt}</table></div></div>`;
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
  if (navigated) chPickOpen = false;
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
  // A worker's checkbox mates (구현 · 리뷰 × 2 · 판정 of the same 「<ticket>#<n>」), so siblings are one click away.
  const tm = task && TASK_NAME.exec(taskName(task));
  if (tm?.[2] && run) {
    const pre = `${tm[1]}#${tm[2]} `, mates = (state.orca.tasks[run.id] || []).filter(t => t.id !== task.id && taskName(t).startsWith(pre));
    if (mates.length) rel += `<div class="rel"><b>같은 체크박스</b>${mates.map(t => { const w = estIndex().sess[t.id], nm = esc(taskName(t).slice(pre.length));
      return w ? `<a href="#s=${encodeURIComponent(w.path)}">${nm}</a> <span class="st">${ST_LABEL[status(w)]}</span>` : `<span class="st">${nm} · ${esc(t.status)}</span>`; }).join(' · ')}</div>`;
  }
  if (parent) rel += `<div class="rel"><b>부모 세션</b><a href="#s=${encodeURIComponent(parent.path)}">${esc(nameOf(parent))}</a></div>`;
  const subsHtml = a.subs.length ? `<details class="box" id="d-subs" ${openState.subs ? 'open' : ''}><summary><b>서브에이전트 ${a.subs.length}</b> <span class="st">합계 비용 ${usd(a.subs.reduce((x, k) => x + (k.cost || 0), 0))}</span></summary><div class="grid" style="margin-top:10px">${a.subs.map(k => card(k)).join('')}</div></details>` : '';
  const kpisHtml = `
    <div class="kpis">
      <div class="kpi"><span>턴</span><b>${d.turns}</b></div>
      <div class="kpi" title="${ctxTitle(d)}"><span>현재 컨텍스트</span><b class="${ctxLvl(d)}">${fmt(d.ctx_now)}</b>${d.ctx_window ? `<small> / ${fmt(d.ctx_window)}</small>` : ''}</div>
      <div class="kpi"><span>피크 · 평균</span><b>${fmt(d.ctx_peak)}</b><small> · ${fmt(d.ctx_avg)}</small></div>
      <div class="kpi"><span>비용</span><b>${usd(d.cost)}</b>${d.cost != null && d.turns ? `<small> · ${usd(d.cost / d.turns)}/턴</small>` : ''}</div>
      <div class="kpi"><span>스킬 호출</span><b>${d.skills}</b><small> · ${d.skill_kinds}종</small></div>
      <div class="kpi"><span>압축</span><b>${d.compactions}</b></div>
      <div class="kpi"><span>총 입력</span><b>${fmt(totalIn)}</b><small> · 캐시 ${totalIn ? Math.round(tk.cache_read / totalIn * 100) : 0}%</small></div>
      <div class="kpi"><span>총 출력</span><b>${fmt(tk.output)}</b></div>
    </div>`;
  const costHtml = `
    ${cp ? `<div class="box"><h3>비용 구성 <span class="st">${usd(d.cost)}${a.subs.length ? ` · 서브에이전트 포함 ${usd(a.cost)}` : ''}</span></h3>
      <div class="track" style="height:22px">${[['input', '--s-input'], ['cache_write', '--s-write'], ['cache_read', '--s-read'], ['output', '--s-out']].map(([k, c]) => `<div style="width:${cp[k] / (d.cost || 1) * 100}%;background:var(${c})" title="${k} ${usd(cp[k])}"></div>`).join('')}</div>
      <div class="legend" style="margin-top:6px">${[['input', '입력', '--s-input'], ['cache_write', '캐시 쓰기', '--s-write'], ['cache_read', '캐시 읽기', '--s-read'], ['output', '출력', '--s-out']].map(([k, n, c]) => `<span><i style="background:var(${c})"></i>${n} ${usd(cp[k])}</span>`).join('')}</div></div>` : `<div class="box st">이 모델(${esc(modelName(d.model))})은 단가가 없어 비용을 계산하지 않았습니다. pricing.json 에 단가를 넣으면 표시됩니다.</div>`}`;
  const ctxHtml = `
    <div class="box"><h3>턴별 컨텍스트 <span class="legend" style="margin:0"><span><i style="background:var(--s-read)"></i>캐시 읽기</span><span><i style="background:var(--s-write)"></i>캐시 쓰기</span><span><i style="background:var(--s-input)"></i>새 입력</span><span><i style="background:var(--warn)"></i>압축</span></span></h3><div id="ctx-chart"></div></div>`;
  const useHtml = `
      <div class="box"><h3>작업 분류 <span class="st">도구 호출 ${d.tool_calls}회 · 무엇에 썼는지 기준</span></h3>
        ${chipRow('스킬', d.skill_use, '--s-write')}${chipRow('MCP', d.mcp_use, '--accent', mcpName)}
        ${(() => {
          const calls = bothUse(d), rows = Object.entries(d.use_tok || {}).sort((a, b) => b[1][2] - a[1][2] || b[1][1] - a[1][1]);
          if (!rows.length) return '';
          const nm = METRICS.both.nm;
          return `<div class="tscroll" style="margin:8px 0"><table><tr><th>스킬·MCP</th><th class="n">호출</th><th class="n" title="호출 결과가 컨텍스트에 한 번 들어간 토큰">주입</th><th class="n">호출당</th><th class="n" title="압축 전까지 이후 매 턴 다시 읽힌 토큰 합">누적</th><th class="n" title="누적을 첫 턴 캐시 쓰기, 이후 캐시 읽기 단가로 환산">누적 비용</th></tr>
          ${rows.map(([k, [inj, carry, cost]]) => `<tr><td>${esc(nm(k))}</td><td class="n">${calls[k] || 0}</td><td class="n">${fmt(inj)}</td><td class="n">${fmt(inj / (calls[k] || 1))}</td><td class="n">${fmt(carry)}</td><td class="n">${usd(cost)}</td></tr>`).join('')}</table></div>`;
        })()}
        <div class="tscroll" style="margin-top:8px"><table><tr><th>분류</th><th class="n">호출</th><th class="n">컨텍스트 증가</th><th class="n">호출당</th></tr>
        ${tools.map(([n, b]) => `<tr><td>${esc(n)}</td><td class="n">${b.calls}</td><td class="n">${fmt(b.ctx_growth)}</td><td class="n">${fmt(b.ctx_growth / b.calls)}</td></tr>`).join('') || '<tr><td colspan=4 class="st">도구 호출 없음</td></tr>'}</table></div>
        <div class="st" style="margin-top:6px">스킬은 Skill 도구 호출과 SKILL.md 읽기(Codex)를 셉니다. 컨텍스트 증가는 도구 결과가 다음 턴을 얼마나 키웠는지로 근사합니다. 누적은 그 토큰이 압축 전까지 매 턴 다시 읽힌 합입니다.</div></div>`;
  const logHtml = `
      <div class="box"><h3>로그 <span class="st">최근 ${d.log.length}건</span></h3>
        <div class="log">${d.log.map(l => `<div class="${l.role} ${hlTurn !== null && l.turn === hlTurn ? 'hl' : ''}"><span class="st">${hhmm(l.ts)}</span><span class="r">${l.role}${l.turn >= 0 ? ' #' + (l.turn + 1) : ''}</span>
          <span class="${l.error ? 'err' : ''}"><b class="r">${window.innerWidth <= 700 || isFold() ? esc(l.role) + ' ' : ''}</b>${esc(l.text)}${l.detail ? ' <span class="st">' + esc(l.detail) + '</span>' : ''}${l.size ? ' <span class="st">(' + fmt(l.size) + '자)</span>' : ''}</span></div>`).join('')}</div></div>`;
  // A coordinator (it has workers, a worker plan or a driver plan) reads orchestration first: a summary line that is
  // always there, then 오케스트레이션 (flow graph + panel, driver plans, worker table), the session's own plan and notes,
  // and its own metrics and log folded below. Everyone else keeps the plain layout.
  const wp = d.own_handle ? workerPlan(d.own_handle, delegatedOf(d)) : null, plans = plansOf(d);
  const orch = !!(wp || kids.length || plans.length);
  let body;
  if (orch) {
    const kc = kids.reduce((x, k) => x + (agg(k).cost || 0), 0), eta = coordEta(d);
    const attn = kids.some(k => ['stalled', 'wait'].includes(status(k)) || k.decision) || wp?.fail;
    const openOrch = attn || secOpen(d, 'orch', true), openSelf = secOpen(d, 'self', false), openLog = secOpen(d, 'log', false);
    const sec = (k, open, title, sub, inner) => `<details class="dsec" id="d-${k}" ${open ? 'open' : ''}><summary class="sec-h"><h2>${title}</h2><span>${sub}</span></summary>${inner}</details>`;
    body = `<div class="box o-sum">${wp ? wpBar(wp, planExtra(d)) : ''}<div class="pline">${kids.length ? `<span>워커 <b>${kids.length}</b></span><span>실행 중 <b style="color:var(--run)">${kids.filter(k => agg(k).live).length}</b></span><span>워커 합계 비용 <b>${usd(kc)}</b></span>` : ''}${eta ? `<span>${eta}</span>` : ''}</div></div>
    ${sec('orch', openOrch, '오케스트레이션', [wp && `Orca 태스크 ${wp.total}`, kids.length && `워커 ${kids.length}`, plans.length && `드라이버 계획 ${plans.length}`].filter(Boolean).join(' · '),
      `${wp ? `<div class="box"><h3>체크박스 흐름 <span class="st">${wp.byDeps ? 'deps 순서' : 'deps 없음 · 만든 순서'}</span></h3>${flowBox(d, wp)}
        <details id="d-wpchart" ${openState.wpchart ? 'open' : ''}><summary class="st">시간 추이 (계획 · 생성 · 완료)</summary><div id="wp-chart" style="margin-top:8px"></div></details></div>` : ''}
      ${extPlansHtml(plans, true)}
      ${kids.length ? `<div class="box"><h3>워커 <span class="st">실행 중 ${kids.filter(k => agg(k).live).length} · 합계 비용 ${usd(kc)} · 합계 턴 ${fmt(kids.reduce((x, k) => x + agg(k).turns, 0))}</span></h3>${workerTable(d, kids, wp)}</div>` : ''}`)}
    ${planBox(d)}
    ${designRefsBox(d)}
    ${vaultBox(d)}
    ${sec('self', openSelf, '이 세션 지표', `턴 ${d.turns} · 컨텍스트 ${fmt(d.ctx_now)} · 비용 ${usd(d.cost)} · 압축 ${d.compactions}`, kpisHtml + costHtml + subsHtml + ctxHtml + useHtml)}
    ${sec('log', openLog, '로그', `최근 ${d.log.length}건${d.log.length ? ' · 마지막 ' + hhmm(d.log[d.log.length - 1].ts) : ''}`, logHtml)}`;
  } else {
    body = `${planBox(d)}
    ${designRefsBox(d)}
    ${vaultBox(d)}
    ${kpisHtml}
    ${costHtml}
    ${subsHtml}
    ${ctxHtml}
    <div class="panes">${useHtml}${logHtml}
    </div>`;
  }
  const ch = chShown(), who = chName(chWho(d));
  const html = `<a class="back" href="#agents">← 에이전트</a>
    ${ch ? `<div class="d-hero">${chHero(d)}<div class="d-head">` : ''}
    <h2 class="d">${esc(nameOf(d))}</h2>
    <div class="sub-h">${d.role !== 'solo' ? `<span class="badge ${d.role === 'coordinator' ? 'coord' : isSubCoord(d) ? 'subcoord' : 'worker'}">${isSubCoord(d) ? '하위 코디네이터' : ROLE[d.role]}</span> ` : ''}${modelChip(d.model)} · ${d.kind}${srvBadge(d) ? ' · ' + srvBadge(d) : ''} · <b title="${esc(d.cwd || '')}">▣ ${esc(placeLabel(d.place))}</b><br>${esc(d.id)} · 시작 ${d.started ? esc(new Date(toDate(d.started)).toLocaleString('ko-KR', { hour12: false })) : '–'} · ${OPEN(status(d)) ? '가동' : '가동(종료)'} ${lifetime(d)}</div>${ch ? '</div>' : ''}
    <div class="c-top" style="margin:-4px 0 12px">${pill(status(d), d)}${actBtns(d, true)}${d.last_action ? `<span class="now" style="flex:1"><b>${status(d) === 'run' ? '지금' : '마지막'}</b>${esc(NOW_ROLE[d.last_action.role] || '')} · ${esc(d.last_action.text)}</span>` : ''}</div>
    ${ch ? `</div>${chPickOpen ? chPicker(d) : ''}` : ''}
    <section class="box chat-box" data-chat-box="${esc(d.path)}"><h3>${esc(who)} 와 대화 <span class="st">Orca 터미널에 입력합니다 · Enter 보내기, Shift+Enter 줄바꿈</span></h3>${chatHtml(d)}</section>
    ${rel ? `<div class="box">${rel}</div>` : ''}
    ${body}`;
  // A live update keeps the chat box itself (what is being typed, the focus, an IME composition) and replaces the rest.
  const keep = $('#view > .chat-box');
  if (keep?.dataset.chatBox === d.path) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const slot = [...tpl.content.children].find(x => x.classList.contains('chat-box')), nodes = [...tpl.content.childNodes], i = nodes.indexOf(slot);
    keep.querySelector('h3').replaceWith(slot.querySelector('h3'));
    [...$('#view').childNodes].forEach(x => x !== keep && x.remove());
    keep.before(...nodes.slice(0, i)); keep.after(...nodes.slice(i + 1));
  } else $('#view').innerHTML = html;
  chatPaint(d.path);
  $('#view').querySelectorAll('.card[data-path]').forEach(c => c.onclick = () => openSession(c.dataset.path));
  for (const k of ['subs', 'prevplans', 'design', 'vault', 'wpchart']) { const el = $('#d-' + k); if (el) el.ontoggle = () => { openState[k] = el.open; if (k === 'wpchart' && el.open) wpChart(d); }; }
  for (const k of ['orch', 'self', 'log']) { const el = $('#d-' + k); if (el) el.ontoggle = () => { secSave(d, k, el.open); if (el.open && k === 'self') ctxChart(d); if (el.open && k === 'orch') flowBind(d); if (el.open && k === 'log') $('.log').scrollTop = $('.log').scrollHeight; }; }
  $('#view').querySelectorAll('[data-vstep]').forEach(b => b.onclick = () => openStep(...JSON.parse(b.dataset.vstep)));
  $('#view').querySelectorAll('[data-ttoggle]').forEach(b => b.onclick = e => {
    if (e.target.closest('a')) return;
    famMin[b.dataset.ttoggle] = !b.closest('.tk').classList.contains('open');
    try { localStorage.setItem('adash.min', JSON.stringify(famMin)); } catch {}
    { const sv = saveScroll(); renderSession(); restoreScroll(sv); }
  });
  const reSess = () => { const sv = saveScroll(); renderSession(); restoreScroll(sv); };
  if ($('#d-ch')) $('#d-ch').onclick = () => { chPickOpen = !chPickOpen; reSess(); };
  $('#view').querySelectorAll('[data-pick]').forEach(b => b.onclick = () => {
    chSet(d, b.dataset.pick || null);
    reSess();
  });
  if (ch) L2D.mount($('#view'));
  ticketGraphBind();
  flowBind(d);
  workerTableBind(d);
  ctxChart(d);
  planChart(d);
  if (openState.wpchart) wpChart(d);
  const log = $('.log');
  if (hlTurn !== null) log.querySelector('.hl')?.scrollIntoView({ block: 'center' });
  else if (navigated || scroll === undefined || d.live) log.scrollTop = log.scrollHeight;
  else log.scrollTop = scroll;
}

function ctxChart(d) {
  const el = $('#ctx-chart'), T = d.turn_list, w = el.clientWidth || 600, h = narrow() ? 170 : 210;
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
        <label>세션 <select id="talk-who" class="field"><option value="">전체</option></select></label>
        <input id="talk-q" class="field talk-q" type="search" placeholder="제목·본문 검색" value="${esc(talk.q)}">
        <label class="chk"><input type="checkbox" id="talk-th" ${talk.threads ? 'checked' : ''}> 질문·답을 스레드로 묶기</label>
        <label>기간 <select id="talk-hours" class="field">${[[1, '1시간'], [6, '6시간'], [24, '24시간'], [72, '3일'], [0, '전체']].map(([h, l]) => `<option value="${h}" ${h === talk.hours ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label>최근 <select id="talk-lim" class="field">${[500, 1500, 5000].map(n => `<option ${n === talk.limit ? 'selected' : ''}>${n}</option>`).join('')}</select>건</label>
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
// An installed PWA is mostly resumed, not reopened, so the check also runs when the page comes back (shown,
// focused, back online), at most every 10 s; before the reload the service worker updates too.
let pageBuild, buildChecked = 0;
async function checkBuild() {
  buildChecked = Date.now();
  chLoad();  // characters put up since: no deploy, so no reload either
  const b = await api.build();
  if (pageBuild === undefined) pageBuild = b;
  else if (b && b !== pageBuild) {
    await navigator.serviceWorker?.getRegistration().then(r => r?.update()).catch(() => {});
    location.reload();
  }
}
const checkBuildSoon = () => { if (!document.hidden && Date.now() - buildChecked > 10000) checkBuild(); };
checkBuild();
setInterval(checkBuildSoon, 60000);
document.addEventListener('visibilitychange', checkBuildSoon);
addEventListener('focus', checkBuildSoon);
addEventListener('online', checkBuildSoon);
addEventListener('pageshow', e => { if (e.persisted) checkBuildSoon(); });
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
  const apply = list => { api.setServers(list); pump(true); el.hidden = true; };
  el.querySelectorAll('#sp-view button').forEach(b => {
    b.classList.toggle('on', b.dataset.k === srvView);
    b.onclick = () => { srvView = b.dataset.k; try { localStorage.setItem('adash.srvview', srvView); } catch {} el.hidden = true; render(); };
  });
  el.querySelectorAll('.sp-srv').forEach(row => {
    const id = row.dataset.id, cur = () => api.servers().map(x => ({ ...x }));
    row.querySelector('[data-on]').onchange = e => apply(cur().map(x => x.id === id ? { ...x, on: e.target.checked } : x));
    row.querySelector('[data-name]').onchange = e => { api.setServers(cur().map(x => x.id === id ? { ...x, name: e.target.value } : x)); render(); };
    row.querySelector('[data-sp=del]').onclick = async () => { if (await uiConfirm(`${api.server(id).name} 을(를) 목록에서 지울까요?`)) apply(cur().filter(x => x.id !== id)); };
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
    if (cls === 'ok' || await uiConfirm(`${text}\n그래도 추가할까요?`)) apply([...api.servers(), { name: $('#sp-new-name').value, url, on: true }]);
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
// 「새 에이전트」 panel: start an agent through Orca on a metric server's Mac — in a new worktree (its own branch off
// the repo default, setup hook run) or in a worktree that exists — or type a prompt into a running agent's terminal.
// The form survives re-renders in lp; places (Orca's repos and worktrees) are asked of the chosen server.
const lp = { mode: 'worktree', server: null, places: null, placesOf: null, repo: '', worktree: '', name: '', agent: 'claude',
  model: '', effort: '', title: '', prompt: '', handle: '', text: '', busy: false, msg: '', cls: '' };
const lpTargets = () => (state?.all || state?.sessions || []).filter(s => s.orca_focus && !s.parent && !closing.has(s.orca_focus))
  .sort((a, b) => (OPEN(status(b)) - OPEN(status(a))) || String(b.last_ts || '').localeCompare(String(a.last_ts || '')));
async function lpLoad(fresh) {
  const srv = lp.server;
  lp.places = null; lp.placesOf = srv;
  const p = await api.places(srv, fresh);
  if (lp.server !== srv) return;
  lp.places = p || { error: '이 서버는 「새 에이전트」를 지원하지 않습니다 (서버를 새 버전으로 재시작)' };
  if (!lp.places.error) {
    if (!lp.places.repos.some(r => r.id === lp.repo)) lp.repo = lp.places.repos[0]?.id || '';
    if (!lp.places.worktrees.some(w => w.id === lp.worktree)) lp.worktree = '';
  }
  if (!$('#launch-panel').hidden) launchPanel();
}
function launchPanel(mode, handle) {
  const el = $('#launch-panel'), on = srvOn();
  if (mode) lp.mode = mode;
  if (handle) { lp.handle = handle; lp.msg = ''; }
  if (!on.some(x => x.id === lp.server)) lp.server = on[0]?.id || null;
  if (lp.mode !== 'send' && lp.server && lp.placesOf !== lp.server) lpLoad();
  const opt = (v, label, cur) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
  const p = lp.places, wts = p?.worktrees || [], repoName = id => p?.repos.find(r => r.id === id)?.name || '';
  const where = lp.mode === 'send' ? '' : !p ? '<div class="sp-msg">Orca 목록을 읽는 중…</div>' : p.error ? `<div class="sp-msg bad">${esc(p.error)}</div>`
    : lp.mode === 'worktree' ? `<label class="lp-row"><span>저장소</span><select class="field" data-lp="repo">${p.repos.map(r => opt(r.id, r.name, lp.repo)).join('')}</select></label>
      <label class="lp-row"><span>이름</span><input class="field" data-lp="name" value="${esc(lp.name)}" placeholder="fix-login-500" spellcheck="false" autocomplete="off" pattern="[A-Za-z0-9][A-Za-z0-9._\\-]*" maxlength="60"></label>
      <p class="lp-help">기본 브랜치에서 새 브랜치를 따고 setup 훅을 돌린 뒤 에이전트를 띄웁니다. 이름은 영문·숫자·<code>.-_</code> (브랜치 이름이 됨).</p>`
    : `<label class="lp-row"><span>워크트리</span><select class="field" data-lp="worktree">${opt('', '고르세요', lp.worktree)}${p.repos.map(r => {
        const ws = wts.filter(w => w.repo === r.id);
        return ws.length ? `<optgroup label="${esc(r.name)}">${ws.map(w => opt(w.id, `${w.name}${w.main ? ' (메인)' : ''}${w.branch && w.branch !== w.name ? ' · ' + w.branch : ''}`, lp.worktree)).join('')}</optgroup>` : '';
      }).join('')}</select></label>
      <p class="lp-help">고른 워크트리에 에이전트 탭을 하나 더 띄웁니다 (워커). 같은 체크아웃을 쓰므로 다른 에이전트와 같은 파일을 고치지 않게 나눠 주세요.</p>`;
  const targets = lpTargets();
  if (lp.mode === 'send' && !targets.some(s => s.orca_focus === lp.handle)) lp.handle = targets[0]?.orca_focus || '';
  const body = lp.mode === 'send' ? (targets.length ? `<label class="lp-row"><span>에이전트</span><select class="field" data-lp="handle">${targets.map(s =>
      opt(s.orca_focus, `${cut(nameOf(s), 40)} · ${wtShort(s.place)} · ${ST_LABEL[status(s)]}`, lp.handle)).join('')}</select></label>
      <textarea class="field" data-lp="text" rows="5" placeholder="에이전트에게 보낼 말 (Enter 까지 눌러 보냄)" aria-label="보낼 프롬프트">${esc(lp.text)}</textarea>
      <p class="lp-help">Orca 터미널에 그대로 입력하고 Enter 를 누릅니다. 에이전트가 응답 중이면 지금 턴이 끝난 뒤 읽습니다.</p>`
      : '<div class="sp-msg">Orca 터미널에 연결된 에이전트가 없습니다.</div>')
    : `${where}
      <div class="lp-row"><span>에이전트</span><span class="seg" data-lp-seg="agent">${['claude', 'codex'].map(a => `<button type="button" data-k="${a}"${lp.agent === a ? ' class="on"' : ''}>${a === 'claude' ? 'Claude' : 'Codex'}</button>`).join('')}</span></div>
      <label class="lp-row"><span>모델</span><input class="field" data-lp="model" value="${esc(lp.model)}" placeholder="기본 (${lp.agent === 'claude' ? '예: opus, sonnet' : '예: gpt-5.5'})" spellcheck="false" autocomplete="off">
        <select class="field" data-lp="effort" aria-label="effort"${lp.model ? '' : ' disabled'}>${opt('', 'effort 기본', lp.effort)}${['low', 'medium', 'high', 'xhigh', 'max'].map(x => opt(x, x, lp.effort)).join('')}</select></label>
      <label class="lp-row"><span>탭 이름</span><input class="field" data-lp="title" value="${esc(lp.title)}" placeholder="${esc(lp.mode === 'worktree' ? lp.name || '워크트리 이름' : wts.find(w => w.id === lp.worktree)?.name || '하는 일 (예: 로그인 500 원인 추적)')}" maxlength="60"></label>
      <textarea class="field" data-lp="prompt" rows="5" placeholder="첫 프롬프트 (비우면 에이전트만 띄움)" aria-label="첫 프롬프트">${esc(lp.prompt)}</textarea>`;
  const can = !lp.busy && (lp.mode === 'send' ? lp.handle && lp.text.trim()
    : p && !p.error && (lp.mode === 'worktree' ? lp.repo && /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/.test(lp.name) : lp.worktree));
  el.innerHTML = `<div class="pop-h"><b>새 에이전트</b><span class="st">Orca 로 띄움</span><button class="act" data-lp-close>닫기</button></div>
    <div class="lp-row"><span class="seg" data-lp-seg="mode"><button type="button" data-k="worktree">새 워크트리</button><button type="button" data-k="agent">기존 워크트리</button><button type="button" data-k="send">프롬프트 보내기</button></span></div>
    ${on.length > 1 && lp.mode !== 'send' ? `<label class="lp-row"><span>서버</span><select class="field" data-lp="server">${on.map(x => opt(x.id, x.name, lp.server)).join('')}</select></label>` : ''}
    ${body}
    <div class="lp-foot"><span class="sp-msg ${lp.cls}">${esc(lp.msg)}</span>
      ${lp.mode === 'send' ? '' : '<button class="act" data-lp-reload title="Orca 의 저장소·워크트리 목록을 다시 읽음">새로고침</button>'}
      <button class="act big accent" data-lp-go${can ? '' : ' disabled'}>${lp.busy ? (lp.mode === 'send' ? '보내는 중…' : '띄우는 중…') : lp.mode === 'send' ? '보내기' : '띄우기'}</button></div>`;
  el.querySelectorAll('[data-lp-seg] button').forEach(b => {
    const k = b.closest('[data-lp-seg]').dataset.lpSeg;
    b.classList.toggle('on', lp[k] === b.dataset.k);
    b.onclick = () => { lp[k] = b.dataset.k; lp.msg = ''; launchPanel(); };
  });
  el.querySelectorAll('[data-lp]').forEach(f => {
    const k = f.dataset.lp;
    f.oninput = f.onchange = e => {
      lp[k] = f.value;
      if (k === 'model' && !f.value) lp.effort = '';
      // selects and the model box change what else is shown; typing elsewhere only re-checks the button
      if (f.tagName === 'SELECT' || (k === 'model' && e.type === 'change')) { if (k === 'server') lp.placesOf = null; launchPanel(); }
      else el.querySelector('[data-lp-go]').disabled = lp.busy || (lp.mode === 'send' ? !(lp.handle && lp.text.trim())
        : !(p && !p.error && (lp.mode === 'worktree' ? lp.repo && /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/.test(lp.name) : lp.worktree)));
    };
  });
  el.querySelector('[data-lp-reload]')?.addEventListener('click', () => lpLoad(true));
  el.querySelector('[data-lp-close]').onclick = () => { el.hidden = true; };
  el.querySelector('[data-lp-go]').onclick = () => lp.mode === 'send' ? lpSend() : lpLaunch();
  el.hidden = false;
}
const lpSay = (msg, cls = '') => { lp.msg = msg; lp.cls = cls; if (!$('#launch-panel').hidden) launchPanel(); };
async function lpSend() {
  const s = lpTargets().find(x => x.orca_focus === lp.handle), who = s ? `「${cut(nameOf(s), 30)}」` : '에이전트';
  lp.busy = true; lpSay('');
  const r = await api.send(lp.handle, lp.text.trim()).catch(() => ({ status: 502, body: { error: '대시보드 서버에 보내지 못했습니다' } }));
  lp.busy = false;
  if (r.status !== 200) return lpSay(r.body?.error || `보내지 못했습니다 (${r.status})`, 'bad');
  lp.text = '';
  const said = r.body.started ? `${who} 에 보냈습니다` : `${who} 터미널에 넣었습니다 — 지금 턴이 끝나면 읽습니다`;
  lpDone();
  toast(said);
}
async function lpLaunch() {
  const body = { kind: lp.mode, agent: lp.agent, model: lp.model.trim(), effort: lp.model.trim() ? lp.effort : '', title: lp.title.trim(), prompt: lp.prompt.trim(),
    ...(lp.mode === 'worktree' ? { repo: lp.repo, name: lp.name.trim() } : { worktree: lp.worktree }) };
  lp.busy = true; lpSay(lp.mode === 'worktree' ? '워크트리를 만들고 setup 을 돌리는 중… (수십 초 걸릴 수 있음)' : '에이전트를 띄우는 중…');
  const r = await api.launch(lp.server, body).catch(() => ({ status: 502, body: { error: '대시보드 서버에 보내지 못했습니다' } }));
  if (r.status !== 202) { lp.busy = false; return lpSay(r.body?.error || `띄우지 못했습니다 (${r.status})`, 'bad'); }
  const label = r.body.label, t0 = Date.now();
  let j = null;
  while (Date.now() - t0 < 6 * 60e3) {
    await new Promise(res => setTimeout(res, 1500));
    try { j = await api.closeJob(r.body.job); } catch { continue; }
    if (!j || j.state === 'done') break;
  }
  lp.busy = false;
  const err = !j ? '결과를 찾을 수 없습니다 (대시보드 서버가 재시작됨) — Orca 에서 확인하세요'
    : j.state !== 'done' ? '6분 안에 끝나지 않았습니다 — Orca 에서 확인하세요' : j.failed?.[0]?.error;
  if (err) return lpSay(err, 'bad');
  Object.assign(lp, { name: '', title: '', prompt: '', placesOf: null });
  lpDone();
  $('#toast').show(`「${cut(label, 30)}」 에이전트를 띄웠습니다${j.note ? ' · ' + j.note : ''}`, j.handle ? { action: 'Orca 에서 열기', onAction: () => api.focus(j.handle)
    .then(x => x.status !== 200 && toast(x.body?.error || 'Orca 전환 실패')) } : {});
}
$('#launch-btn').onclick = () => { if ($('#launch-panel').hidden) launchPanel(); else $('#launch-panel').hidden = true; };
// ---------- chat ----------
// The conversation with an agent as a chat with its person (chWho): its replies on the left beside its face, the
// prompts on the right, and a box that types into the agent's Orca terminal (api.send, as 「프롬프트 보내기」). Two
// done: the toast says so, and the panel closes (it opens next time without the old message)
const lpDone = () => { lp.msg = ''; lp.cls = ''; $('#launch-panel').hidden = true; };
// places: the session page (a box under the header) and a sheet over the agents list or the office, opened by a right
// click or a long press on a card or a person. The conversation is /api/chat, read again when the session's last_ts
// moves; a live update repaints only the log, so the box keeps what is being typed (and an IME composition).
const chat = { cache: {}, draft: {}, sent: {}, busy: {}, note: {}, stick: {}, top: {} };
const chatSess = p => (state?.all || state?.sessions || []).find(x => x.path === p) || (detail?.path === p ? detail : null);
const chatHandle = s => s && (s.orca_focus ?? state?.all?.find(x => x.path === s.path)?.orca_focus) || '';
const chatTime = ts => ts ? new Date(toDate(ts)).toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '';
// A message as said: escaped, with its **bold** and `code` drawn (the rest of the markdown stays as typed).
const chatText = t => esc(t).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
const chatNorm = t => String(t || '').replace(/\s+/g, ' ').trim();
function chatGet(s) {
  const c = chat.cache[s.path] ||= { msgs: null, ts: undefined, busy: false };
  if (c.ts !== s.last_ts && !c.busy) {
    const ts = s.last_ts;
    c.busy = true;
    api.chat(s.path).then(m => { c.msgs = m || []; c.err = false; }).catch(() => { c.msgs ||= []; c.err = true; })
      .finally(() => { c.ts = ts; c.busy = false; chatPaint(s.path); });
  }
  return c.msgs;
}
// A person's face: the top of their SD bust sprite (pose 0), scaled to fill a circle of size px.
function chFace(s, size = 32) {
  const a = CH_ART[chWho(s)].sdb, k = size * 1.5 / a.pw, w = a.pw * k;
  return `<span class="chat-face" style="width:${size}px;height:${size}px;background-image:url(${chSdSrc(chWho(s), 'bust')});background-size:${a.pw * 8 * k}px ${a.ph * k}px;background-position:${-(w - size) / 2}px ${-a.top[0] * a.ph * k}px" aria-hidden="true"></span>`;
}
function chatLogHtml(s) {
  const msgs = chatGet(s), c = chat.cache[s.path], face = chFace(s);
  if (!msgs) return '<div class="chat-empty st">대화를 읽는 중…</div>';
  // Sent from here and not yet in the log: shown as pending until the prompt turns up there.
  const sent = chat.sent[s.path] = (chat.sent[s.path] || []).filter(x => !msgs.some(m => m.role === 'user' && msOf(m.ts) >= x.at - 60e3
    && chatNorm(m.text).startsWith(chatNorm(x.text).slice(0, 40))));
  const them = (m, first) => `<div class="chat-b them${first ? '' : ' cont'}">${first ? face : '<span class="chat-face"></span>'}<div class="chat-t">${chatText(m.text)}</div><span class="chat-ts">${chatTime(m.ts)}</span></div>`;
  const me = (m, pend) => `<div class="chat-b me${pend ? ' pend' : ''}"><span class="chat-ts">${pend ? (m.queued ? '대기 · 턴이 끝나면 읽음' : '보냄') : chatTime(m.ts)}</span><div class="chat-t">${chatText(m.text)}</div></div>`;
  const st = status(s), la = s.last_action;
  const rows = msgs.map((m, i) => m.role === 'user' ? me(m) : them(m, msgs[i - 1]?.role !== 'assistant'));
  rows.push(...sent.map(x => me(x, true)));
  if (s.decision) rows.push(`<div class="chat-b them note">${face}<div class="chat-t"><b>결정을 기다려요</b> · ${esc(cut(s.decision.question || s.decision.questions?.[0]?.question || '', 120))}</div></div>`);
  else if (st === 'run') rows.push(`<div class="chat-b them note">${face}<div class="chat-t"><span class="chat-dots" aria-label="작업 중"><i></i><i></i><i></i></span>${la ? ` <span class="st">${esc(cut(la.text, 80))}</span>` : ''}</div></div>`);
  if (!rows.length) return `<div class="chat-empty st">${c?.err ? '대화를 읽지 못했습니다' : '아직 대화가 없습니다'}</div>`;
  return (msgs.length >= 200 ? '<div class="chat-empty st">최근 200개만 보입니다</div>' : '') + rows.join('');
}
function chatHtml(s) {
  const p = s.path, h = chatHandle(s), busy = chat.busy[p], [msg, cls] = chat.note[p] || ['', ''];
  return `<div class="chat" data-chat="${esc(p)}">
    <div class="chat-log" role="log" aria-label="${esc(nameOf(s))} 와의 대화">${chatLogHtml(s)}</div>
    <form class="chat-form"><textarea class="field chat-in" rows="1" aria-label="${esc(chName(chWho(s)))} 에게 보낼 말"
        placeholder="${h ? `${esc(chName(chWho(s)))} 에게 말하기` : 'Orca 터미널에 연결되지 않아 보낼 수 없습니다'}" title="Enter 보내기 · Shift+Enter 줄바꿈"${h ? '' : ' disabled'}>${esc(chat.draft[p] || '')}</textarea>
      <button class="act big accent" type="submit"${h && !busy && (chat.draft[p] || '').trim() ? '' : ' disabled'}>${busy ? '보내는 중…' : '보내기'}</button></form>
    <div class="chat-note sp-msg ${cls}"${msg ? '' : ' hidden'}>${esc(msg)}</div></div>`;
}
// Repaint every chat on show for a session: the log, and the form's state, leaving the text box itself alone.
function chatPaint(p) {
  const s = chatSess(p);
  document.querySelectorAll('.chat[data-chat]').forEach(el => {
    if (el.dataset.chat !== p || !s) return;
    const log = el.querySelector('.chat-log'), h = chatHandle(s), busy = chat.busy[p], [msg, cls] = chat.note[p] || ['', ''];
    const html = chatLogHtml(s);
    if (log.dataset.html !== html) { log.innerHTML = html; log.dataset.html = html; }
    log.scrollTop = chat.stick[p] !== false ? log.scrollHeight : chat.top[p] || 0;
    const ta = el.querySelector('.chat-in'), b = el.querySelector('.chat-form button'), n = el.querySelector('.chat-note');
    ta.disabled = !h;
    chatGrow(ta);
    b.disabled = !h || busy || !(chat.draft[p] || '').trim();
    b.textContent = busy ? '보내는 중…' : '보내기';
    n.hidden = !msg; n.textContent = msg; n.className = `chat-note sp-msg ${cls}`;
  });
  const dlg = $('#chat-dlg');
  if (dlg?.open && dlg.dataset.path === p && s) dlg.querySelector('.chat-dlg-s').textContent = `${chName(chWho(s))} · ${ST_LABEL[status(s)]}`;
}
const chatSync = () => new Set([...document.querySelectorAll('.chat[data-chat]')].map(el => el.dataset.chat)).forEach(chatPaint);
async function chatSend(p) {
  const s = chatSess(p), h = chatHandle(s), text = (chat.draft[p] || '').trim();
  if (!h || !text || chat.busy[p]) return;
  chat.busy[p] = true; chat.note[p] = null; chatPaint(p);
  const r = await api.send(h, text).catch(() => ({ status: 502, body: { error: '대시보드 서버에 보내지 못했습니다' } }));
  chat.busy[p] = false;
  if (r.status === 200) {
    (chat.sent[p] ||= []).push({ text, at: Date.now(), queued: !r.body.started });
    chat.draft[p] = ''; chat.stick[p] = true;
    document.querySelectorAll('.chat[data-chat]').forEach(el => { if (el.dataset.chat === p) { const ta = el.querySelector('.chat-in'); ta.value = ''; chatGrow(ta); } });
  } else chat.note[p] = [r.body?.error || `보내지 못했습니다 (${r.status})`, 'bad'];
  chatPaint(p);
}
const chatGrow = ta => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight + 2, 160) + 'px'; };
const COARSE = matchMedia('(pointer: coarse)');
document.addEventListener('input', e => {
  const ta = e.target.closest?.('.chat-in');
  if (!ta) return;
  const p = ta.closest('.chat').dataset.chat;
  chat.draft[p] = ta.value;
  chatGrow(ta);
  ta.form.querySelector('button').disabled = !chatHandle(chatSess(p)) || chat.busy[p] || !ta.value.trim();
});
// Enter sends (not mid-composition: Korean input ends a syllable with Enter); on a touch keyboard Enter is a new line.
document.addEventListener('keydown', e => {
  const ta = e.target.closest?.('.chat-in');
  if (!ta || e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229 || COARSE.matches) return;
  e.preventDefault();
  chatSend(ta.closest('.chat').dataset.chat);
});
document.addEventListener('submit', e => {
  const f = e.target.closest('.chat-form');
  if (!f) return;
  e.preventDefault();
  chatSend(f.closest('.chat').dataset.chat);
});
document.addEventListener('scroll', e => {
  const log = e.target.classList?.contains('chat-log') && e.target;
  if (!log) return;
  const p = log.closest('.chat').dataset.chat;
  chat.stick[p] = log.scrollTop + log.clientHeight >= log.scrollHeight - 24;
  chat.top[p] = log.scrollTop;
}, true);

// The sheet: a modal over the page, the person and their state on top, 「상세」 to the session page.
function chatOpen(p) {
  const s = chatSess(p);
  if (!s) return;
  let d = $('#chat-dlg');
  if (!d) {
    d = document.createElement('dialog'); d.id = 'chat-dlg'; d.className = 'dialog chat-dlg';
    d.addEventListener('click', e => { if (e.target === d || e.target.closest('[data-chat-close], [data-chat-detail]')) d.close(); });
    document.body.appendChild(d);
  }
  if (d.open && d.dataset.path === p) return;
  d.dataset.path = p;
  d.innerHTML = `<div class="chat-dlg-in"><div class="chat-dlg-h">${chFace(s, 44)}<div class="chat-dlg-t"><b>${esc(nameOf(s))}</b><span class="st chat-dlg-s"></span></div>
      <a class="act" href="#s=${encodeURIComponent(p)}" data-chat-detail>상세</a><button type="button" class="act" data-chat-close>닫기</button></div>${chatHtml(s)}</div>`;
  chat.stick[p] = true;
  if (!d.open) d.showModal();
  chatPaint(p);
  const ta = d.querySelector('.chat-in');
  chatGrow(ta);
  if (!COARSE.matches && !ta.disabled) ta.focus(); else d.querySelector('[data-chat-close]').focus();
}
// Right click, or a still press of half a second (finger or pen), on an agent card or a person in the office. The
// click that ends a long press does not also open the session; a pan under it is let go.
const chatTarget = el => el.closest?.('.card[data-path], .ch[data-path]');
const chatSkip = el => el.closest('[data-act], a, input, textarea, select, .acts');
document.addEventListener('contextmenu', e => {
  const t = chatTarget(e.target);
  if (!t || chatSkip(e.target)) return;
  e.preventDefault();
  chatOpen(t.dataset.path);
});
let chatHold = null, chatHeld = false;
document.addEventListener('pointerdown', e => {
  clearTimeout(chatHold?.t); chatHold = null;
  const t = e.pointerType !== 'mouse' && chatTarget(e.target);
  if (!t || chatSkip(e.target)) return;
  chatHold = { x: e.clientX, y: e.clientY, t: setTimeout(() => {
    chatHold = null; chatHeld = true;
    dispatchEvent(new PointerEvent('pointercancel'));  // ends a pan before the sheet covers it
    navigator.vibrate?.(10);
    chatOpen(t.dataset.path);
  }, 500) };
});
addEventListener('pointermove', e => { if (chatHold && Math.hypot(e.clientX - chatHold.x, e.clientY - chatHold.y) > 10) { clearTimeout(chatHold.t); chatHold = null; } });
addEventListener('pointerup', () => { clearTimeout(chatHold?.t); chatHold = null; });
addEventListener('pointercancel', e => { if (e.isTrusted) { clearTimeout(chatHold?.t); chatHold = null; } });
document.addEventListener('click', e => { if (chatHeld) { chatHeld = false; e.stopPropagation(); e.preventDefault(); } }, true);
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
      out.push(`<div class="tscroll"><table>${rows.map((r, j) => `<tr>${r.map(c => j ? `<td>${inline(c.trim())}</td>` : `<th>${inline(c.trim())}</th>`).join('')}</tr>`).join('')}</table></div>`); continue;
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

// ---------- 설계문서 ----------
// Design documents from the metric servers that index a design folder (server: prefs design_dirs / --design-dir), and
// which `## ` sections the sessions read (the servers take that from the session logs). Left: the documents by feature
// folder with how many sessions read each. Middle: the document, rendered with marked and mermaid (pinned on a CDN,
// loaded the first time the tab opens), a 「세션 N · M회」 badge on every section. Right: the sessions that read the
// picked section (on narrow screens the same list opens under the heading). A session opens its detail.
// #dz=<server>|<document key>|<section> names what is open; the section is changed in place (no history entry).
const DZ_LIBS = {
  marked: ['https://cdn.jsdelivr.net/npm/marked@15.0.7/marked.min.js', 'sha384-H+hy9ULve6xfxRkWIh/YOtvDdpXgV2fmAGQkIDTxIgZwNoaoBal14Di2YTMR6MzR'],
  mermaid: ['https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js', 'sha384-rbtjAdnIQE/aQJGEgXrVUlMibdfTSa4PQju4HDhN3sR2PmaKFzhEafuePsl9H/9I'],
};
const dzLibs = {};
const dzLib = name => dzLibs[name] ||= new Promise((ok, fail) => {
  const s = document.createElement('script');
  [s.src, s.integrity] = DZ_LIBS[name];
  s.crossOrigin = 'anonymous';
  s.onload = () => ok(window[name]);
  s.onerror = () => { delete dzLibs[name]; fail(new Error(name + ' 을 불러오지 못했습니다')); };
  document.head.append(s);
});
let dz = { pane: true, q: '', last: null, lastIn: {}, fold: {} };  // adash.design: the toggles, the last document (overall and per project), the sidebar boxes left open or closed
try { Object.assign(dz, JSON.parse(localStorage.getItem('adash.design') || '{}')); } catch {}
const dzSave = () => { try { localStorage.setItem('adash.design', JSON.stringify(dz)); } catch {} };
let dzList = null, dzListV = null;  // api.designs(), dropped when a server's index or references change
const dzDocs = {};                  // server + '\n' + key -> api.design()
let dzMounted = null;               // what the view was built for; live updates then redraw only the counts
let dzScroll = null;                // a section to bring into view once the document is drawn
let dzPanel = null;                 // narrow screens: the sidebar box or the readers shown in the page ('proj'|'docs'|'readers')
const dzHash = (server, key, sec) => '#dz=' + encodeURIComponent([server, key, sec || ''].join('|'));
const dzName = key => key.split('/').slice(2).join('/') || key;  // without "feature-designs/<slug>/"
// a document as its folder's index.html names it: the H1 without its path prefix, under "01 챕터" when the page lists it
const dzTitle = (key, title) => title || dzName(key);
const dzChap = (ch, chapter) => ch ? `${String(ch).padStart(2, '0')} ${chapter || ''}`.trim() : '';
const dzSlug = key => key.split('/').length > 2 ? key.split('/')[1] : '(폴더 바로 아래)';
const dzNo = r => r.no ? '§' + r.no : cut(r.section || '문서 전체', 12);
// a section's readers (sessions that read it; a search hit alone does not count): the server's per-session rows
function dzReaders(doc, sec) {
  return (doc.refs || []).filter(r => (sec === undefined || r.section === sec) && r.reads);
}
const dzCount = rows => ({ s: new Set(rows.map(r => r.session)).size, n: rows.reduce((a, r) => a + r.reads, 0) });

async function renderDesigns() {
  const r = route(), ver = state.design?.version ?? '';
  if (!dzList || dzListV !== ver) {
    dzListV = ver;
    try { dzList = await api.designs(); } catch { dzList = null; }
    dzList ||= { enabled: false, sources: [], dirs: [], docs: [], plans: [] };
    for (const k of Object.keys(dzDocs)) delete dzDocs[k];
    if (route().v !== 'designs') return;
  }
  let { server, key, sec } = r;
  if (!key && dz.last) [server, key] = dz.last;
  const meta = key && dzList.docs.find(x => x.server === server && x.key === key);
  if (meta && (dz.last?.[0] !== server || dz.last?.[1] !== key || dz.lastIn[server + '|' + dzSlug(key)] !== key)) {
    dz.last = [server, key]; dz.lastIn[server + '|' + dzSlug(key)] = key; dzSave();
  }
  const ck = meta ? server + '\n' + key : '';
  let doc = ck && dzDocs[ck];
  if (meta && !doc) {
    try { doc = dzDocs[ck] = await api.design(server, key); } catch (e) { doc = { error: String(e.message || e) }; }
    doc ||= { error: '문서를 찾을 수 없습니다.' };
    if (route().v !== 'designs') return;
  }
  const mk = [ck, doc?.mtime, multiSrv(), dz.pane].join('\n');
  if (dzMounted !== mk || !$('#dz-side')) {
    // the sidebar boxes: as they were for the same document (edited, a server added); else as last left on a wide
    // screen, and on a phone closed once a document is open (the document is the page there)
    const same = dzMounted?.split('\n')[0] === ck, wide = innerWidth > 900;
    // the project box closes once a project (a document in it) is picked; its summary names the one picked
    const fold = k => { const el = same && $(`[data-fold="${k}"]`); return el ? el.open : k === 'proj' ? !meta : wide ? dz.fold[k] ?? true : !meta; };
    if (sec && !same) dzScroll = sec;
    if (!same && dz.tocShut) { dz.tocShut = false; dzSave(); }
    dzMounted = mk;
    $('#view').innerHTML = `<div class="controls dz-ctl">
        <span class="st" id="dz-sum"></span></div>
      ${!dzList.enabled ? dzNoSource() : `<div class="dz${meta ? dz.pane ? '' : ' no-pane' : ' empty-doc'}">
        <div class="dz-side" id="dz-side">
          <details class="box dz-box dz-projbox" data-fold="proj"${fold('proj') ? ' open' : ''}><summary><b>설계 프로젝트</b> <span class="st">${meta ? esc(dzSlug(key)) : ''}</span></summary>
            <div id="dz-projs"></div></details>
          <details class="box dz-box" data-fold="docs"${fold('docs') ? ' open' : ''}><summary><b>문서</b> <span class="st">${meta ? esc(dzTitle(key, meta.title)) : ''}</span></summary>
            <input class="field dz-q" type="search" placeholder="제목·챕터·파일 이름으로 거르기" value="${esc(dz.q)}" aria-label="문서 거르기">
            <div id="dz-list"></div></details></div>
        <div class="dz-main">${meta ? `<div class="box dz-head" id="dz-head"></div><article class="box dz-doc" id="dz-doc"></article>`
          : '<div class="empty">왼쪽에서 설계 프로젝트와 문서를 고르세요. 숫자는 그 문서를 읽거나 검색한 세션 수입니다.</div>'}</div>
        ${meta && dz.pane ? '<aside class="box dz-pane" id="dz-pane"></aside>' : ''}
        <div class="dz-fab" id="dz-fab">
          <div class="dz-fab-menu" id="dz-fab-menu" role="menu" hidden>
            <button type="button" class="dz-fb" role="menuitem" data-dz-panel="docs"><ds-icon name="book"></ds-icon><span>문서 선택</span></button>
            ${meta && dz.pane ? '<button type="button" class="dz-fb" role="menuitem" data-dz-panel="readers"><ds-icon name="users"></ds-icon><span>읽은 세션</span></button>' : ''}</div>
          <button type="button" class="dz-fab-btn" data-dz-fab aria-haspopup="menu" aria-expanded="false" aria-controls="dz-fab-menu" aria-label="문서 선택 · 읽은 세션"><ds-icon name="book"></ds-icon></button></div>
        <dialog class="dialog dz-modal" id="dz-modal" aria-label="설계문서">
          <div class="dz-mh" id="dz-mh"></div>
          <div class="dz-mb" id="dz-mb"></div></dialog></div>`}`;
    if (meta) await dzArticle(doc);
    if (route().v !== 'designs' || dzMounted !== mk) return;
  }
  if (!dzList.enabled) return;
  dzFit(); dzPanelSet(dzPanel);
  const fresh = !$('#dz-list')?.children.length;
  dzFill(server, key, sec, meta, doc);
  const on = fresh && $('#dz-list .dz-d.on'), list = $('#dz-list');  // a newly drawn list shows the open document
  if (on && list.scrollHeight > list.clientHeight) list.scrollTop = on.offsetTop - 40;
}

// On a wide screen the grid fills the window below the header and controls (see .dz in app.css).
function dzFit() {
  const g = $('.dz');
  if (g) g.style.setProperty('--dz-top', Math.round(g.getBoundingClientRect().top + scrollY) + 'px');
}
addEventListener('resize', () => { if (route().v === 'designs') { dzFit(); dzPanelSet(dzPanel); } });

// Narrow screens (≤900px) keep only the document on the page, and only the page scrolls. A small button right of the
// floating bar offers 「문서 선택」 and 「읽은 세션」; each opens a modal. 「문서 선택」 shows the open project's documents
// with their table of contents, and its head switches to the project list (picking a project comes back to its
// documents). The sidebar and the readers box move into the modal while it is open and back into the grid after.
function dzPanelSet(name) {
  const g = $('.dz'), fab = $('#dz-fab'), dlg = $('#dz-modal');
  if (!g || !fab || !dlg) return;
  dzPanel = innerWidth <= 900 && name && g.querySelector(name === 'readers' ? '#dz-pane' : `[data-fold="${name}"]`) ? name : null;
  const side = $('#dz-side'), pane = $('#dz-pane'), body = $('#dz-mb');
  if (dzPanel) {
    const fresh = !dlg.open || dlg.dataset.panel !== dzPanel;
    dlg.dataset.panel = dzPanel;
    if (side.parentNode !== body) body.append(side);
    if (pane && pane.parentNode !== body) body.append(pane);
    if (dzPanel !== 'readers') g.querySelector(`[data-fold="${dzPanel}"]`).open = true;
    const slug = dz.last ? dzSlug(dz.last[1]) : '';
    $('#dz-mh').innerHTML = (dzPanel === 'docs' ? `<button type="button" class="act dz-mp" data-dz-panel="proj" aria-label="설계 프로젝트 바꾸기"><ds-icon name="layers"></ds-icon><span>${esc(slug || '설계 프로젝트')}</span><i aria-hidden="true">▾</i></button>`
      : dzPanel === 'proj' ? `<b>설계 프로젝트</b>${slug ? '<button type="button" class="tgl" data-dz-panel="docs">문서로</button>' : ''}`
      : '<span></span>') + '<button type="button" class="tgl dz-mx" data-dz-close>닫기</button>';
    if (!dlg.open) { dlg.showModal(); dlg.querySelector('.dz-mx').focus({ focusVisible: false }); }
    if (fresh) {  // a tab opens at the picked project or document
      const on = dzPanel === 'proj' ? $('#dz-projs .dz-d.on') : dzPanel === 'docs' ? $('#dz-list .dz-d.on') : null;
      body.scrollTop = on ? on.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - 60 : 0;
    }
  } else {
    if (side.parentNode !== g) g.prepend(side);
    if (pane && pane.parentNode !== g) $('.dz-main').after(pane);
    if (dlg.open) dlg.close();
  }
  fab.querySelector('.dz-fab-btn').classList.toggle('on', !!dzPanel);
  // the button: right of the floating bar, level with it; over the bar's right end when there is no room beside it
  const d = document.querySelector('ds-dock')?.getBoundingClientRect(), w = fab.offsetWidth, h = fab.offsetHeight;
  if (d?.width) {
    const beside = innerWidth - d.right >= w + 14;
    fab.style.cssText = beside ? `left:${Math.round(d.right + 8)}px; top:${Math.round(d.top + (d.height - h) / 2)}px`
      : `left:${Math.round(Math.min(d.right, innerWidth - 8) - w)}px; top:${Math.round(d.top > innerHeight / 2 ? d.top - h - 8 : d.bottom + 8)}px`;
    fab.classList.toggle('down', d.top < innerHeight / 2);  // the popover opens towards the middle of the screen
  } else fab.style.cssText = '';
}

// No server that is on indexes design documents: say, per server, why not.
const DZ_SRC = { off: '설계 폴더 없이 떠 있음 (prefs.json 의 design_dirs 나 --design-dir)', old: '설계문서 기능이 없는 서버 버전 (새 코드로 다시 띄워야 함)', error: '연결할 수 없음' };
function dzNoSource() {
  const rows = (dzList.sources || []).map(x => `<li><b>${esc(srvName(x.server))}</b> <span class="st">${esc(api.server(x.server)?.url || '')}</span> — ${DZ_SRC[x.state] || x.state}</li>`).join('');
  return `<div class="empty">설계문서를 색인하는 메트릭 서버가 없습니다.${rows ? `<ul class="pj-src">${rows}</ul>` : '<br><small>켜진 메트릭 서버가 없습니다.</small>'}</div>`;
}

// The document body into #dz-doc: Markdown (raw HTML shown as text, links and pictures resolved inside the design
// folder), a picture, or a PDF.
async function dzArticle(doc) {
  const art = $('#dz-doc');
  if (doc.error) { art.innerHTML = `<div class="empty">${esc(doc.error)}</div>`; return; }
  const file = k => api.designFile(doc.server, k);
  if (doc.kind === 'image') { art.innerHTML = `<img class="dz-img" src="${esc(file(doc.key))}" alt="${esc(dzName(doc.key))}">`; return; }
  if (doc.kind === 'pdf') { art.innerHTML = `<iframe class="dz-pdf" src="${esc(file(doc.key))}" title="${esc(dzName(doc.key))}"></iframe>`; return; }
  art.innerHTML = '<div class="st pj-wait">불러오는 중…</div>';
  let marked;
  try { marked = await dzLib('marked'); } catch (e) { art.innerHTML = `<div class="empty">${esc(e.message)}</div><pre class="dz-raw">${esc(doc.content)}</pre>`; return; }
  if (!art.isConnected) return;
  const dir = doc.key.replace(/[^/]*$/, ''), keys = new Set(dzList.docs.filter(x => x.server === doc.server).map(x => x.key));
  const resolve = href => {  // a relative link inside the design folder -> its document key
    const parts = (dir + href.split(/[?#]/)[0]).split('/'), out = [];
    for (const p of parts) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); }
    try { return decodeURIComponent(out.join('/')); } catch { return out.join('/'); }
  };
  const ext = h => /^(https?:|mailto:)/i.test(h);
  const renderer = {
    html: ({ text }) => esc(text),
    code: ({ text, lang }) => lang === 'mermaid' ? `<pre class="mermaid">${esc(text)}</pre>` : `<pre><code>${esc(text)}</code></pre>`,
    link({ href, title, tokens }) {
      const label = this.parser.parseInline(tokens), t = title ? ` title="${esc(title)}"` : '';
      if (ext(href)) return `<a href="${esc(href)}"${t} target="_blank" rel="noreferrer">${label}</a>`;
      if (/^#/.test(href)) return `<span${t}>${label}</span>`;
      const k = resolve(href);
      if (keys.has(k)) return k.endsWith('.md') ? `<a href="${esc(dzHash(doc.server, k))}"${t}>${label}</a>` : `<a href="${esc(file(k))}"${t} target="_blank" rel="noreferrer">${label}</a>`;
      return `<span class="dz-dead" title="${esc(href)} — 설계 폴더 밖이거나 없음">${label}</span>`;
    },
    image({ href, text }) {
      const k = ext(href) ? null : resolve(href);
      return ext(href) || keys.has(k) ? `<img src="${esc(ext(href) ? href : file(k))}" alt="${esc(text)}" loading="lazy">` : `<span class="dz-dead">[그림: ${esc(text || href)}]</span>`;
    },
  };
  art.innerHTML = new marked.Marked({ gfm: true, renderer }).parse(doc.content.replace(/^---\n[\s\S]*?\n---\n/, ''));
  dzHeadings(art, doc);
  const charts = art.querySelectorAll('pre.mermaid');
  if (!charts.length) return;
  try {
    const mermaid = await dzLib('mermaid');
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'default' });
    await mermaid.run({ nodes: charts, suppressErrors: true });
  } catch (e) { charts.forEach(c => c.classList.add('dz-raw')); }
}

// Tie the rendered <h2>s to the server's table of contents (same order; titles compared without Markdown marks), and
// put the preamble's place at the top.
const dzNorm = t => String(t).replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_~]/g, '').replace(/\s+/g, ' ').trim();
function dzHeadings(art, doc) {
  const toc = doc.toc || [], hs = [...art.querySelectorAll('h2')];
  let i = 0;
  for (const h of hs) {
    const t = dzNorm(h.textContent), j = toc.findIndex((s, k) => k >= i && dzNorm(s.title) === t);
    if (j < 0) continue;
    h.dataset.sec = toc[j].id; i = j + 1;
  }
  const pre = toc.find(s => s.start === 1 && !s.no && (s.id === '머리말' || s.id === '본문'));
  if (pre) art.insertAdjacentHTML('afterbegin', `<div class="dz-pre" data-sec="${esc(pre.id)}"><span class="st">${pre.id === '본문' ? '본문 (## 제목 없음)' : '머리말 (첫 ## 앞)'}</span></div>`);
}

// A folder's documents in its index.html's reading order, one group per chapter; a folder without such a page is one
// group with no heading (chapter null).
function dzChapters(xs) {
  if (!xs.some(x => x.ch)) return [[null, xs]];
  const groups = new Map();
  [...xs].sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || a.key.localeCompare(b.key))
    .forEach(x => { const c = dzChap(x.ch, x.chapter); groups.has(c) || groups.set(c, []); groups.get(c).push(x); });
  return [...groups];
}

// Everything that moves with new references: the sidebar's counts, the header, the badges, the readers.
function dzFill(server, key, sec, meta, doc) {
  $('#dz-sum').textContent = `문서 ${dzList.docs.filter(x => x.kind === 'md').length} · 그림·PDF ${dzList.docs.filter(x => x.kind !== 'md').length} · 참조 ${dzList.refs}건`;
  // projects: server (when several) -> feature folder, recently changed first; one opens its last (else first) document
  const bySrv = {};
  for (const x of dzList.docs) ((bySrv[x.server] ||= {})[dzSlug(x.key)] ||= []).push(x);
  // a folder with an index.html shows only what its viewer lists (captures, raw notes and the like stay out)
  for (const slugs of Object.values(bySrv)) for (const [slug, xs] of Object.entries(slugs)) if (xs.some(x => x.ch)) slugs[slug] = xs.filter(x => x.ch);
  const cur = key ? server + '|' + dzSlug(key) : '';
  const first = (srv, xs) => xs.find(x => x.key === dz.lastIn[srv + '|' + dzSlug(x.key)])
    || [...xs].sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || (b.kind === 'md') - (a.kind === 'md') || a.key.localeCompare(b.key))[0];
  $('#dz-projs').innerHTML = Object.entries(bySrv).map(([srv, slugs]) => `${multiSrv() ? `<div class="dz-srv">${esc(srvName(srv))}</div>` : ''}<ul class="dz-ul">${Object.entries(slugs)
    .sort((a, b) => Math.max(...b[1].map(x => x.mtime)) - Math.max(...a[1].map(x => x.mtime)))
    .map(([slug, xs]) => {
      const n = xs.filter(x => x.sessions).length, src = dzList.dirs.filter(d => d.server === srv)[xs[0].src];
      return `<li><a class="dz-d${srv + '|' + slug === cur ? ' on' : ''}${n ? '' : ' zero'}" href="${esc(dzHash(srv, first(srv, xs).key))}" title="${esc(src ? `${src.dir}${src.branch ? ` (${src.branch})` : ''}` : '')}">
        <span>${esc(slug)}</span>${src && !src.configured ? '<span class="dz-wt" aria-label="워크트리 사본">▣</span>' : ''}<span class="badge${n ? ' dz-n' : ''}" title="읽힌 문서 ${n} / 전체 ${xs.length}">${n}/${xs.length}</span></a></li>`;
    }).join('')}</ul>`).join('');
  // documents: the open project's, by chapter; a filter searches every project
  const q = dz.q.toLowerCase(), hit = x => !q || [x.key, x.title, x.chapter].some(t => t && t.toLowerCase().includes(q));
  // the open document unfolds its table of contents under it (accordion); pressing it again folds it
  const toc = doc && !doc.error && doc.kind === 'md' ? doc.toc || [] : [];
  const docLink = x => { const on = x.server === server && x.key === key, unfold = on && toc.length && !dz.tocShut;
    return `<li><a class="dz-d${on ? ' on' : ''}${x.sessions ? '' : ' zero'}" href="${esc(dzHash(x.server, x.key))}"${on && toc.length ? ` data-dz-fold aria-expanded="${unfold ? 'true' : 'false'}"` : ''} title="${esc(`${dzName(x.key)}\n읽기 ${x.reads} · 검색 ${x.searches} · 세션 ${x.sessions}`)}">
    <span>${on && toc.length ? (unfold ? '▾ ' : '▸ ') : x.kind === 'md' ? '' : x.kind === 'pdf' ? '▤ ' : '▧ '}${esc(dzTitle(x.key, x.title))}</span><span class="badge${x.sessions ? ' dz-n' : ''}">${x.sessions}</span></a>${unfold ? `<ul class="dz-toc">${toc.map(t => {
      const c = dzCount(dzReaders(doc, t.id));
      return `<li><button type="button" class="dz-t${t.id === sec ? ' on' : ''}${c.s ? '' : ' zero'}" data-dz-sec="${esc(t.id)}" data-dz-toc title="${esc(`${t.title}\n${t.start}–${t.end}행 · 세션 ${c.s} · ${c.n}회`)}"><span>${esc(t.title)}</span><span class="badge${c.s ? ' dz-n' : ''}">${c.s}</span></button></li>`;
    }).join('')}</ul>` : ''}</li>`; };
  const chapters = xs => dzChapters(xs).map(([chap, ys]) => `${chap === null ? '' : `<div class="dz-ch">${esc(chap)}</div>`}<ul class="dz-ul">${ys.map(docLink).join('')}</ul>`).join('');
  const mine = cur ? bySrv[server]?.[dzSlug(key)] || [] : [];
  $('#dz-list').innerHTML = q
    ? Object.entries(bySrv).flatMap(([srv, slugs]) => Object.entries(slugs).map(([slug, xs]) => [srv, slug, xs.filter(hit)]))
      .filter(([, , xs]) => xs.length).map(([srv, slug, xs]) => `<div class="dz-srv">${esc((multiSrv() ? srvName(srv) + ' · ' : '') + slug)}</div>${chapters(xs)}`).join('') || '<div class="st">맞는 문서가 없습니다.</div>'
    : mine.length ? chapters(mine) : '<div class="st">설계 프로젝트를 고르세요.</div>';
  if (!meta || !doc || doc.error) return;
  // header: where the copy comes from, and the plans' design_commit against its HEAD
  const s = doc.source || {}, head = s.head ? s.head.slice(0, 7) : '';
  const chap = dzChap(doc.ch, doc.chapter);
  $('#dz-head').innerHTML = `<div class="dz-title"><b title="${esc(dzName(key))}">${esc(dzTitle(key, doc.title))}</b>${srvBadge(doc)} <span class="st">${esc((chap ? chap + ' · ' : '') + dzSlug(key))}</span></div>
    <div class="dz-ver"><span title="${esc(s.dir || '')}">▣ ${esc(s.repo || '')}${s.worktree && s.worktree !== s.repo ? ' · ' + esc(s.worktree) : ''}${s.branch ? ` (${esc(s.branch)})` : ''}${head ? ` · HEAD <code>${head}</code>` : ''}</span>
      ${doc.copies?.length > 1 ? `<span class="st" title="${esc(doc.copies.map(c => `${c.worktree || c.dir} ${c.branch || ''}`).join('\n'))}">사본 ${doc.copies.length}곳 (설정 폴더 → 최근 수정 순으로 이것)</span>` : ''}
      ${(doc.plans || []).map(p => `<span class="dz-cm ${p.same ? 'ok' : 'diff'}">문서 버전 <code>design_commit ${esc((p.design_commit || '').slice(0, 7))}</code> · ${p.same ? '현재 HEAD 와 같음' : `HEAD 와 다름${p.same_file === true ? ' (이 문서는 같음)' : p.same_file === false ? ' (이 문서도 바뀜)' : ''}`}${p.project ? ` <span class="st">${esc(p.project)}</span>` : ''}</span>`).join('')}
      <span class="st">수정 ${esc(new Date(doc.mtime * 1000).toLocaleString('ko-KR', { hour12: false }))}</span></div>`;
  // badges on every section
  const art = $('#dz-doc');
  art.querySelectorAll('.dz-b, .dz-inline').forEach(x => x.remove());
  art.querySelectorAll('[data-sec]').forEach(h => {
    const c = dzCount(dzReaders(doc, h.dataset.sec));
    h.classList.toggle('on', h.dataset.sec === sec);
    h.insertAdjacentHTML('beforeend', ` <button type="button" class="badge dz-b${c.s ? '' : ' zero'}" data-dz-sec="${esc(h.dataset.sec)}" aria-label="${esc(h.dataset.sec)} 섹션을 읽은 세션 보기">세션 ${c.s} · ${c.n}회</button>`);
  });
  const pane = dz.pane ? dzPane(doc, sec, doc.toc || []) : '';
  if ($('#dz-pane')) $('#dz-pane').innerHTML = pane;
  const at = sec && [...art.querySelectorAll('[data-sec]')].find(h => h.dataset.sec === sec);
  // two frames on, after render() has put the old scroll position back
  if (dzScroll !== null) { const to = dzScroll && at || art; dzScroll = null; requestAnimationFrame(() => requestAnimationFrame(() => to.scrollIntoView({ block: 'start' }))); }
}

// The readers of a section (or of the whole document) as session rows; the sections a session read that the current
// table of contents no longer has are listed at the end of the document view.
const DZ_ROWS = 40;  // readers listed at most, newest first
function dzPane(doc, sec, toc) {
  const one = sec !== undefined && sec !== '' && (toc.some(s => s.id === sec) || (doc.refs || []).some(r => r.section === sec));
  const rows = one ? dzReaders(doc, sec) : Object.values(dzReaders(doc).reduce((o, r) => {
    const x = o[r.session] ||= { ...r, reads: 0, searches: 0, cover: null, secs: new Set() };
    x.reads += r.reads; x.searches += r.searches; x.secs.add(r.section);
    if (r.last > x.last) x.last = r.last;
    return o;
  }, {}));
  rows.sort((a, b) => (b.last || '').localeCompare(a.last || ''));
  const live = new Map(state.sessions.map(s => [s.path, s]));
  const item = r => {
    const s = live.get(r.path), tk = r.ticket ? `<span class="badge">티켓 ${esc(r.ticket)}</span>` : '';
    const kinds = [r.reads ? `<span class="chip" style="--c: var(--accent)">read${r.cover != null ? ' ' + Math.round(r.cover * 100) + '%' : ''}</span>` : '',
      r.searches ? `<span class="chip" style="--c: var(--s-write)">search ${r.searches}</span>` : ''].join('');
    return `<li><a class="dz-s" href="${r.path ? '#s=' + encodeURIComponent(r.path) : '#'}" title="${esc(`${r.session}${r.lines?.length ? '\n읽은 줄 ' + r.lines.map(([a, b]) => a === b ? a : a + '–' + b).join(', ') : ''}${r.exact ? '' : '\n(셸 명령에서 근사)'}`)}">
      <span class="dz-st"><b>${esc(r.title || r.session.slice(0, 8))}</b>${tk}${s ? pill(status(s), s) : ''}${r.parent ? '<span class="badge">서브에이전트</span>' : ''}</span>
      <span class="dz-k">${kinds}<span class="st">${r.reads + r.searches}회${r.secs ? ` · 섹션 ${r.secs.size}` : ''} · ${esc(ago(r.last))}</span></span></a></li>`;
  };
  const gone = [...new Set((doc.refs || []).map(r => r.section))].filter(x => x && !toc.some(s => s.id === x));
  return `<h3 class="dz-ph"><span>${one ? `「${esc(sec)}」 섹션을 읽은 세션` : '이 문서를 읽은 세션'} <span class="st">${rows.length}</span></span><button type="button" class="tgl" data-dz-hide aria-label="읽은 세션 숨기기">숨기기</button></h3>
    ${rows.length ? `<ul class="dz-ss">${rows.slice(0, DZ_ROWS).map(item).join('')}</ul>${rows.length > DZ_ROWS ? `<div class="st">최근 ${DZ_ROWS}개만 보입니다 (전체 ${rows.length})</div>` : ''}` : '<div class="st">읽은 세션이 없습니다.</div>'}
    ${one ? `<button type="button" class="act" data-dz-sec="">문서 전체 보기</button>` : `<div class="st dz-hint">섹션 제목의 배지를 누르면 그 섹션을 읽은 세션만 봅니다. 누르면 세션 상세로 갑니다.</div>`}
    ${!one && gone.length ? `<h3>현재 목차에 없는 섹션</h3><ul class="dz-gone">${gone.map(g => `<li><button type="button" class="tgl" data-dz-sec="${esc(g)}">${esc(g)}</button></li>`).join('')}</ul>` : ''}`;
}

document.addEventListener('click', e => {
  if (route().v !== 'designs') return;
  if (e.target.closest('[data-dz-fab]')) { dzMenu($('#dz-fab-menu').hidden); return; }
  const pb = e.target.closest('[data-dz-panel]');
  if (pb) { dzMenu(false); dzPanelSet(pb.dataset.dzPanel); return; }
  dzMenu(false);
  if (e.target.closest('[data-dz-close]') || e.target.id === 'dz-modal') { dzPanelSet(null); return; }  // 닫기, or the backdrop
  if (dzPanel && e.target.closest('.dz [data-fold] > summary')) { e.preventDefault(); return; }  // a tab's box stays open
  // picking a document closes the modal; picking a project opens it and comes back to its documents
  const pick = dzPanel && e.target.closest('.dz a[href^="#"]:not([data-dz-fold])');
  if (pick) dzPanel = pick.closest('#dz-projs') ? 'docs' : null;
  const f = e.target.closest('[data-dz-fold]');
  if (f) { e.preventDefault(); dz.tocShut = !dz.tocShut; dzSave(); render(); return; }
  if (e.target.closest('[data-dz-hide]')) { dz.pane = false; dzSave(); render(); return; }
  const b = e.target.closest('[data-dz-sec]');
  if (!b) return;
  if (!b.hasAttribute('data-dz-toc') && !dz.pane) { dz.pane = true; dzSave(); }  // a section badge brings the readers back
  const r = route(), key = r.key || dz.last?.[1], server = r.server || dz.last?.[0], cur = r.sec || '';
  const toc = b.hasAttribute('data-dz-toc');  // the table of contents picks and goes there; a badge toggles
  const sec = !toc && b.dataset.dzSec === cur ? '' : b.dataset.dzSec;  // the open section again lets it go
  if (toc) { dzScroll = sec; dzPanel = null; }
  else if (innerWidth <= 900 && sec && dz.pane) dzPanel = 'readers';  // a badge on a phone shows its readers
  history.replaceState(null, '', dzHash(server, key, sec));
  render();
});
// the button's popover: 「문서 선택」 · 「읽은 세션」
function dzMenu(open) {
  const m = $('#dz-fab-menu');
  if (!m || m.hidden === !open) return;
  m.hidden = !open;
  $('#dz-fab .dz-fab-btn').setAttribute('aria-expanded', open);
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') dzMenu(false); });
// Esc closes the modal natively; put the boxes back
document.addEventListener('close', e => { if (e.target.id === 'dz-modal' && dzPanel) dzPanelSet(null); }, true);
// 「읽은 세션 보기」 lives in the floating bar's filters, shown on this tab on a wide screen only
$('#dz-pane-chk').onchange = e => { dz.pane = e.target.checked; dzSave(); render(); };
document.addEventListener('input', e => {
  if (!e.target.classList?.contains('dz-q')) return;
  dz.q = e.target.value; dzSave();
  const r = route();
  dzFill(r.server || dz.last?.[0], r.key || dz.last?.[1], r.sec, null, null);
});

// A sidebar box opened or closed by hand on a wide screen stays so through reloads (redraws leave the boxes alone).
document.addEventListener('toggle', e => {
  const f = e.target;
  if (!f.matches?.('details[data-fold]') || f.dataset.fold === 'proj' || innerWidth <= 900 || dz.fold[f.dataset.fold] === f.open) return;
  dz.fold[f.dataset.fold] = f.open; dzSave();
}, true);

// Session detail: the design sections the session (and its subagents) read, per document.
function designRefsBox(d) {
  const rows = d.design_refs || [];
  if (!rows.length) return '';
  const docs = {};
  rows.forEach(x => (docs[x.doc] ||= []).push(x));
  const part = x => [x.reads ? `read${x.cover != null ? ' ' + Math.round(x.cover * 100) + '%' : ''}` : '', x.searches ? `search ${x.searches}` : '', `${x.reads + x.searches}회`].filter(Boolean).join(' · ');
  return `<details class="box" id="d-design" ${openState.design ?? true ? 'open' : ''}><summary><b>참고한 설계 섹션</b> <span class="st">문서 ${Object.keys(docs).length} · 섹션 ${rows.length}${rows.some(x => x.sub) ? ' · 서브에이전트 포함' : ''}</span></summary>
    <div class="dz-rd">${Object.entries(docs).map(([doc, xs]) => `<div><a href="${esc(dzHash(d.server, doc))}" title="${esc(dzName(doc))}"><b>${esc(dzTitle(doc, xs[0].doc_title))}</b></a> <span class="st">${esc([dzChap(xs[0].doc_ch, xs[0].doc_chapter), dzSlug(doc)].filter(Boolean).join(' · '))}</span>
      <ul>${xs.map(x => `<li><a href="${esc(dzHash(d.server, doc, x.section))}">${esc(x.section || '문서 전체')}</a> <span class="st">— ${esc(part(x))}${x.sub ? ' · 서브에이전트' : ''}</span></li>`).join('')}</ul></div>`).join('')}</div></details>`;
}

// Ticket graph node: the sections its sessions read, most read first ("§5 · §9"); the documents are in the tooltip, since a
// box is too narrow for them.
function ticketDesignBadge(p, n) {
  const rows = p.design_refs?.[n] || [];
  if (!rows.length) return '';
  const tip = rows.map(x => `${dzTitle(x.doc, x.doc_title)} — ${x.section} (세션 ${x.sessions} · ${x.count}회)`).join('\n');
  // the same number from two documents gets the document's title in front (cut short), so "§2 · §2" never shows
  const top = rows.slice(0, 3), twice = top.filter(x => top.some(y => y !== x && dzNo(y) === dzNo(x)));
  const lbl = x => (twice.includes(x) ? cut(dzTitle(x.doc, x.doc_title), 8) : '') + dzNo(x);
  return `<div class="tg-d" title="${esc('읽은 설계 섹션\n' + tip)}">${top.map(x => esc(lbl(x))).join(' · ')}${rows.length > 3 ? ` <span>+${rows.length - 3}</span>` : ''}</div>`;
}

// ---------- 홈 helpers ----------

// Data the snapshot does not carry, fetched once per change and kept: 「최근 볼트 문서」.
const hmFetch = {};
function hmData(key, fn, sig) {
  const c = hmFetch[key];
  if (c && c.sig === sig) return c.data;
  if (!c?.loading) {
    hmFetch[key] = { ...c, loading: true };
    fn().then(d => { hmFetch[key] = { sig, data: d }; }, () => { hmFetch[key] = { sig, data: null }; })
      .finally(() => { if (route().v === 'home') render(); });
  }
  return c?.data;
}

// 내 차례: what waits for a person — a 결정 버튼 question, a QA ticket at a user gate (반출 승인 with its worktree still
// there: without one there is nothing to approve, only a driver state left behind; 막힘), and an agent at an approval or
// report step of its plan (보고 ask). A 막힘 older than HM_STALE is a leftover, not today's work: it leaves the list (the
// 워크트리 tab still has it). Questions first, then the rest; the longest wait first within each.
const HM_STALE = 24 * 3600e3;
// A plan step that hands the turn to the person: the agent stops there for a go-ahead, not for its next instruction.
const HM_ASK = /승인|보고|컨펌|확인 요청|검토 요청|결정|피드백|선택/;
function hmMine() {
  const out = [], dec = state.decisions;
  const sessOf = q => state.all.find(s => s.decision?.id === q.id) || (q.session_id && state.all.find(s => s.kind === 'claude' && s.id === q.session_id));
  for (const q of dec?.pending || []) out.push({ kind: 'dec', at: q.created_at * 1000, q, s: sessOf(q) });
  for (const set of wtData.sets || []) for (const t of set.tickets) {
    const qa = t.qa;
    if (!qa || qa.ignored) continue;
    const at = qa.at?.[qa.stage] ? new Date(qa.at[qa.stage]).getTime() : null;
    if (qa.blocked) { if (at && Date.now() - at < HM_STALE) out.push({ kind: 'blocked', at, t, set }); }
    else if (qa.stage === 'committed' && t.repos.length) out.push({ kind: 'approve', at: qa.at?.committed ? new Date(qa.at.committed).getTime() : null, t, set });
  }
  // an agent waiting for its next instruction (입력 대기) is not the user's to do, unless its plan stopped at a step that
  // asks for the person (HM_ASK)
  for (const s of state.sessions) if (!s.parent && !s.decision && status(s) === 'wait' && s.plan?.cur_text && s.plan.done < s.plan.total && HM_ASK.test(s.plan.cur_text))
    out.push({ kind: 'ask', at: toDate(s.last_ts).getTime(), s });
  const order = { dec: 0, ask: 1, blocked: 2, approve: 3 };
  return out.sort((a, b) => order[a.kind] - order[b.kind] || (a.at || Infinity) - (b.at || Infinity));
}
// On the board: running, background or waiting, a pending question, a record in the last hour, or 응답 없음 for under
// six hours (a session stalled since yesterday is a leftover, not work in progress).
const hmRecent = s => { const st = status(s); return ['run', 'bg', 'wait'].includes(st) || s.decision || ageS(s.last_ts) < (st === 'stalled' ? 6 * 3600 : 3600); };

// An agent at a step of its plan that hands the turn to the person (보고 확인).
const hmAsk = s => !s.decision && status(s) === 'wait' && s.plan?.cur_text && s.plan.done < s.plan.total && HM_ASK.test(s.plan.cur_text);

// ---------- 「홈」: one tile per screen — the office's 운영실 staff ----------
// Every screen on the bar has a tile on 홈 with a rough figure of what is there now, a small chart of it, and a click
// goes to it. In 캐릭터 모드 the same list (HUB) is the 운영실: each tile a staff member in a room furnished for the job
// (staffRoom), the figure in their bubble. A figure's tone: hot (something to look at) or bad (something stuck).
// A tile's size and place follow its weight (hubWeight): stuck first and largest, then what to look at, then the
// quiet ones, and a screen with nothing to show last and smallest.
// Charts, in the page's bar vocabulary: columns (hw-spark) with each column's value in its tooltip, a proportional
// state bar (pbar prop) with a legend, and meters (ctxbar). n: how many marks the tile's size holds.
const hubCols = (xs, cls = '') => xs.length ? `<div class="hw-spark hub-cols ${cls}">${xs.map(x => `<i class="${x.c || ''}" style="height:${Math.max(4, x.f * 100).toFixed(1)}%" title="${esc(x.t)}"></i>`).join('')}</div>` : '';
const hubSeg = parts => { const on = parts.filter(p => p.n);
  return on.length ? `<div class="pbar prop hub-seg">${on.map(p => `<i class="${p.c}" style="flex:${p.n}" title="${esc(`${p.l} ${p.n}`)}"></i>`).join('')}</div>
    <div class="wp-leg hub-leg">${on.map(p => `<span><i class="sw ${p.c}"></i> ${p.l} ${p.n}</span>`).join('')}</div>` : ''; };
const hubMeters = xs => xs.map(x => `<div class="hub-meter" title="${esc(x.t || '')}"><span class="hub-ml">${esc(x.l)}</span><span class="ctxbar"><div class="${x.c || ''}" style="width:${Math.min(100, Math.max(1, x.f * 100)).toFixed(1)}%"></div></span><span class="hub-mv">${esc(x.v)}</span></div>`).join('');
const HUB_N = { S: 6, M: 12, L: 18 };
const HUB_ROWS = { S: 2, M: 3, L: 6 };
// Today's cost from midnight per hour, over every session's 5-minute slots.
function hubCostHours() {
  const day0 = new Date().setHours(0, 0, 0, 0), hours = new Array(new Date().getHours() + 1).fill(0);
  for (const s of state.sessions) for (const [k, v] of Object.entries(s.slots || {})) { const t = +k * 300e3; if (t >= day0) hours[Math.floor((t - day0) / 3600e3)] += v[4]; }
  return hours;
}
// Sessions with a record in each hour since midnight, as columns.
function hubActiveHours() {
  const day0 = new Date().setHours(0, 0, 0, 0), hours = new Array(new Date().getHours() + 1).fill(0).map(() => new Set());
  for (const s of state.sessions) if (!s.parent) for (const k of Object.keys(s.slots || {})) { const t = +k * 300e3; if (t >= day0) hours[Math.floor((t - day0) / 3600e3)].add(s.path); }
  const max = Math.max(...hours.map(h => h.size), 1);
  return hubCols(hours.map((h, i) => ({ f: h.size / max, c: i === hours.length - 1 ? 'cur' : '', t: `${i}시 세션 ${h.size}` }))) + '<div class="hub-axis"><span>0시</span><span>시간대별 활동 세션</span><span>지금</span></div>';
}
let hubPjLoad = null;
const HUB = [
  { id: 'decide', name: '결정 대기', staff: '비서', room: '비서실', hue: 200, wall: ['calendar', 'mail'], prop: 'cabinet', val: () => {
    const qs = state.decisions?.pending || [], n = qs.length, unread = (state.decisions?.inbox || []).filter(r => !r.read).length, ask = state.sessions.filter(s => !s.parent && hmAsk(s)).length;
    const ages = qs.map(q => ({ q, a: Date.now() / 1000 - q.created_at })), max = Math.max(...ages.map(x => x.a), 1);
    return { v: n ? `결정 ${n}` : '없음', sub: [n && `가장 오래 ${human(max)}`, ask && `보고 확인 ${ask}`, unread && `메일함 ${unread}`].filter(Boolean).join(' · ') || '기다리는 질문 없음', tone: n ? 'hot' : '', live: n + ask + unread > 0,
      chart: z => hubCols(ages.slice(0, HUB_N[z]).map(x => ({ f: x.a / max, c: 'cur', t: `${cut(x.q.questions?.[0]?.question || x.q.questions?.[0]?.header || '', 60)} · ${human(x.a)} 기다림` }))) }; } },
  { id: 'agents', name: '에이전트', staff: '매니저', room: '관리실', hue: 220, wall: ['kanban', 'monitors'], prop: 'plant', val: () => {
    const ss = state.sessions.filter(s => !s.parent && hmRecent(s)), c = k => ss.filter(s => k.includes(status(s))).length, dev = state.flow?.items?.length || 0;
    return { v: `실행 ${c(['run', 'bg'])}`, sub: [`입력 대기 ${c(['wait'])}`, c(['stalled']) && `응답 없음 ${c(['stalled'])}`, dev && `흐름 이탈 ${dev}`].filter(Boolean).join(' · '), tone: c(['stalled']) ? 'bad' : '', live: ss.length > 0,
      chart: z => (z === 'L' ? hubActiveHours() : '') + hubSeg(['run', 'bg', 'wait', 'stalled'].map(k => ({ c: 'k-' + k, l: ST_LABEL[k], n: c([k]) })).concat({ c: 'k-idle', l: '그 밖', n: c(['idle', 'done']) })) }; } },
  { id: 'worktrees', name: '워크트리 리뷰', staff: 'QA 담당', room: 'QA실', hue: 280, wall: ['pipeline', 'checklist'], prop: 'easel', val: () => {
    if (!wtData.sets?.length) return { v: '—', sub: 'QA 묶음 없음' };
    // a ticket left at 커밋 완료 with no worktree is a driver state left behind, not one waiting for approval (as on 내 차례)
    const ts = wtData.sets.flatMap(x => x.tickets).filter(t => t.qa && !t.qa.ignored && t.qa.stage !== 'cleaned' && !(t.qa.stage === 'committed' && !t.repos.length)), mine = hmMine();
    const stuck = t => t.qa.blocked && Date.now() - new Date(t.qa.at?.[t.qa.stage] || 0).getTime() < HM_STALE;  // a 막힘 over a day old counts at its stage
    const ok = mine.filter(x => x.kind === 'approve').length;
    // the tickets still in the pipeline (정리 left out) by where they stand, a ring of them with its legend
    const g = [['막힘', 'var(--bad)', stuck], ['승인 대기', 'var(--warn)', t => t.qa.stage === 'committed'], ['작업 중', 'var(--ok)', t => ['analysis', 'implementing', 'reviewing', 'approved'].includes(t.qa.stage)],
      ['대기', 'var(--idle)', t => ['selected', 'worktree'].includes(t.qa.stage)], ['반출됨', 'var(--done)', t => t.qa.stage === 'delivered']];
    const left = new Set(ts), cnt = g.map(([l, c, f]) => { const xs = [...left].filter(f); xs.forEach(t => left.delete(t)); return { l, c, n: xs.length }; });
    const bl = cnt[0].n, work = cnt[2].n;
    return { v: ok ? `반출 승인 ${ok}` : `작업 중 ${work}`, sub: [`진행 티켓 ${ts.length}`, bl && `막힘 ${bl}`].filter(Boolean).join(' · '), tone: bl ? 'bad' : ok ? 'hot' : '', live: work + ok + bl > 0,
      chart: () => `<div class="hub-donut"><ds-donut segments="${cnt.map(x => `${x.n} ${x.c}`).join('; ')}" value="${ts.length}" caption="티켓"></ds-donut>
        <div class="hub-leg">${cnt.filter(x => x.n).map(x => `<span><i class="sw" style="background:${x.c}"></i> ${x.l} ${x.n}</span>`).join('')}</div></div>` }; } },
  { id: 'tests', name: '테스트', staff: '테스터', room: '시험실', hue: 160, wall: ['flasks', 'checklist'], prop: 'lab', val: () => {
    const all = testItems(), live = all.filter(testLive).length, fin = all.filter(t => !testLive(t)).sort((a, b) => (a.finished_at || '').localeCompare(b.finished_at || ''));
    const bad = fin.filter(t => t.phase === 'failed' || t.failed).length;
    return { v: live ? `실행 중 ${live}` : `실패 ${bad}`, sub: `24시간 실행 ${fin.length}${live ? ` · 실패 ${bad}` : ''}`, tone: bad ? 'bad' : live ? 'hot' : '', live: all.length > 0,
      chart: z => hubCols(fin.slice(-HUB_N[z]).map(t => { const f = t.phase === 'failed' || t.failed; return { f: f ? 1 : .55, c: f ? 'bad' : 'ok', t: `${cut(t.label || t.key, 40)} · ${f ? `실패 ${t.failed || ''}` : '통과'} · ${ago(t.finished_at)}` }; })) }; } },
  { id: 'compare', name: '비교 · 비용', staff: '회계', room: '회계실', hue: 45, wall: ['coins', 'clock'], prop: 'safe', val: () => {
    const hs = hubCostHours(), sum = hs.reduce((a, x) => a + x, 0), max = Math.max(...hs, 1e-9);
    return { v: usd(sum), sub: '오늘 0시부터', live: sum > 0,
      chart: () => hubCols(hs.map((x, i) => ({ f: x / max, c: i === hs.length - 1 ? 'cur' : '', t: `${i}시 ${usd(x)}` }))) }; } },
  { id: 'usage', name: '플랜 사용량', staff: '관리인', room: '계기실', hue: 190, wall: ['status', 'warning'], prop: 'rack', val: () => {
    const live = (state.plan_usage || []).filter(a => !a.stale && !a.note), lim = live.flatMap(a => (a.limits || []).filter(b => b.percent != null).map(b => ({ a, b })));
    const top = Math.max(-1, ...lim.map(x => x.b.percent));
    if (top < 0) return { v: '—', sub: '사용량 정보 없음' };
    return { v: `${top}%`, sub: `가장 높은 한도 · 계정 ${live.length}`, tone: top >= 90 ? 'bad' : top >= 70 ? 'hot' : '', live: true,
      chart: z => hubMeters(lim.sort((x, y) => y.b.percent - x.b.percent).slice(0, HUB_ROWS[z]).map(({ a, b }) => ({ l: `${(a.email || '').split('@')[0]} · ${b.name || ''}`, f: b.percent / 100, v: `${b.percent}%`, c: b.percent >= 90 ? 'ctx-bad' : b.percent >= 70 ? 'ctx-warn' : '' }))) }; } },
  { id: 'talk', name: '상호작용', staff: '기록원', room: '기록실', hue: 30, wall: ['timeline', 'clock'], prop: 'boxes', val: () => {
    const on = families().fams.filter(f => f.members.some(hmRecent)), ws = f => f.members.filter(m => m !== f.coord);
    return { v: `묶음 ${on.length}`, sub: `워커 ${on.reduce((a, f) => a + ws(f).length, 0)}명 · 최근 1시간`, live: on.length > 0,
      // in words: who leads each team and how its workers stand
      chart: z => on.slice(0, HUB_ROWS[z]).map(f => { const c = k => ws(f).filter(m => k.includes(status(m))).length;
        return `<div class="hub-sum"><b>${esc(cut(f.coord ? nameOf(f.coord) : '묶음', 40))}</b><span>워커 ${ws(f).length}${[['실행', ['run', 'bg']], ['대기', ['wait']], ['응답 없음', ['stalled']], ['완료', ['done']]].map(([l, k]) => c(k) ? ` · ${l} ${c(k)}` : '').join('')}</span></div>`; }).join('') }; } },
  { id: 'projects', name: '프로젝트', staff: 'PM', room: 'PM실', hue: 260, wall: ['gantt', 'calendar'], prop: 'easel', val: () => {
    if (!pjData) { hubPjLoad ||= api.projects().then(d => { pjData = d; }, () => { pjData = { enabled: false, projects: [] }; }).finally(() => { hubPjLoad = null; if (route().v === 'home') render(); }); return { v: '…', sub: '불러오는 중' }; }
    if (!pjData.enabled) return { v: '—', sub: '프로젝트 폴더 없음' };
    const ps = (pjData.projects || []).filter(p => !p.error && (p.ratio || 0) < 1);  // a finished project is not shown
    if (!ps.length) return { v: '없음', sub: '진행 중인 프로젝트 없음' };
    return { v: `${ps.length}개`, sub: `진행 중 · 평균 ${Math.round(ps.reduce((a, p) => a + (p.ratio || 0), 0) / ps.length * 100)}%`, live: true,
      chart: z => hubMeters(ps.slice(0, HUB_ROWS[z]).map(p => ({ l: p.name, f: p.ratio || 0, v: `${Math.round((p.ratio || 0) * 100)}%`, t: p.current?.name || '' }))) }; } },
  { id: 'designs', name: '설계문서', staff: '설계자', room: '설계실', hue: 210, wall: ['blueprint', 'poster'], prop: 'easel', val: () => {
    const d = hmData('design', () => api.designs(), state.design?.version ?? '');
    if (d === undefined) return { v: '…', sub: '불러오는 중' };
    if (!d?.enabled) return { v: '—', sub: '설계 폴더 없음' };
    const top = [...d.docs].filter(x => x.sessions).sort((a, b) => b.sessions - a.sessions);
    return { v: `${d.docs.length}개`, sub: `세션이 읽은 문서 ${top.length}`,
      // the most read documents, each a link straight to it on 설계문서
      chart: z => top.slice(0, { S: 3, M: 4, L: 7 }[z]).map(x => `<a class="hub-doc" href="#dz=${encodeURIComponent(x.server + '|' + x.key)}"><span>${esc(cut(x.title || x.key.split('/').pop(), 44))}<small>${esc(x.key.split('/').slice(-2, -1)[0] || '')}</small></span><em>세션 ${x.sessions}</em></a>`).join('') }; } },
];
const hubVal = h => { try { return h.val() || { v: '—', sub: '' }; } catch (e) { return { v: '—', sub: e.message }; } };
// stuck 3, something to look at 2, something going on 1, nothing 0; the size follows
const hubWeight = r => r.tone === 'bad' ? 3 : r.tone === 'hot' ? 2 : r.live ? 1 : 0;
const HUB_SIZE = ['S', 'S', 'M', 'L'];
const hubTile = ({ h, r, w }) => { const z = HUB_SIZE[w];
  let g = '';
  try { g = r.chart?.(z) || ''; } catch {}
  return `<section class="hw ${z} hub${w ? '' : ' quiet'}" data-go="#${h.id}"><h3><span class="hw-name">${h.name}</span><span class="hw-note">${h.staff}</span><a class="hw-more" href="#${h.id}" aria-label="${h.name} 화면으로">→</a></h3>
    <div class="hw-body"><div class="hw-big${r.tone ? ' ' + r.tone : ''}">${esc(r.v)}</div><div class="st">${esc(r.sub)}</div>${g ? `<div class="hub-chart">${g}</div>` : ''}</div></section>`; };
// the tiles in weight order (the list's own order within a weight)
const hubOrder = () => HUB.map((h, i) => { const r = hubVal(h); return { h, r, w: hubWeight(r), i }; }).sort((a, b) => b.w - a.w || a.i - b.i);

function renderHome() {
  needReviews();
  $('#view').innerHTML = `<div class="sec-h hm-h"><h2>홈</h2><span>${srvOn().length > 1 ? `서버 ${srvOn().length} · ` : ''}${hhmm(new Date().toISOString())} 갱신</span></div>
    <div class="hm-grid hub-grid">${hubOrder().map(hubTile).join('')}</div>`;
  $('#view').querySelectorAll('[data-go]').forEach(t => t.onclick = e => { if (!e.target.closest('a')) location.hash = t.dataset.go; });
}

function connect() {
  const last = {};
  let wasLive = false;
  api.events({
    version: v => { const i = v.indexOf(':'), id = v.slice(0, i); if (last[id] !== v) { last[id] = v; pump(); } },
    // a server's projects changed: drop what was fetched and redraw the projects view (an open note stays as it is)
    projects: () => { pjData = null; pjFull = {}; if (['projects', 'home'].includes(route().v)) render(); },
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
setInterval(() => { if (state && !document.hidden && (['agents', 'talk', 'tests', 'usage'].includes(route().v) || onlyLive && route().v === 'compare')) render(); }, 15000); // keep "n분 전" fresh; let the 「실행 중만」 grace expire
let rz; addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => {
  if (route().v === 'session' && detail) renderSession();
  if (route().v === 'projects' && pj.view === 'timeline') render();  // 자동 orientation follows the window's shape
}, 200); });
