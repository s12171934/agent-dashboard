// Data layer: every request the page makes to the metrics servers goes through here.
// The JSON contract (fields, sizes, which screen uses what) is documented in the Obsidian vault:
// 30_Areas/자동화/에이전트 대시보드 데이터 명세.md and its session / Orca / plan notes.
// Views (app.js) never call fetch or EventSource directly, so the server can move (another host,
// /api/v1, a bearer token) by changing this file alone.
// The page is served from Cloudflare Pages and the metrics servers run on the user's machines, so the server list is
// per device (localStorage adash.servers: [{id, name, url, on}]); ?server=<url> adds one and turns it on. Every server
// that is on is read at once and merged into one snapshot: each session, run, plan, test file and question carries
// `server` (its id), and a request about one of them (detail, hide, answer, focus, close) goes to the server that
// sent it. Session paths, run ids and terminal handles are UUID-based, so they stay unique across machines.
// Other devices on the tailnet need the HTTPS address `tailscale serve` gives a Mac: an https page may not call http.
const api = (() => {
  const KEY = 'adash.servers', OLD_KEY = 'adash.server', DEFAULT = 'http://127.0.0.1:8787', API_VERSION = 1;
  const clean = u => (u || '').trim().replace(/\/+$/, '');
  const hostOf = u => { try { return new URL(u).host; } catch { return u; } };
  const newId = () => Math.random().toString(36).slice(2, 8);
  const read = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };

  let servers;
  try { servers = JSON.parse(read(KEY, 'null')); } catch {}
  if (!Array.isArray(servers) || !servers.length) {  // first visit, or a device that kept one address (adash.server)
    const url = clean(read(OLD_KEY, '')) || DEFAULT;
    servers = [{ id: newId(), name: url === DEFAULT ? '이 Mac' : hostOf(url), url, on: true }];
  }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(servers)); localStorage.removeItem(OLD_KEY); } catch {} };
  const fromUrl = clean(new URLSearchParams(location.search).get('server'));
  if (fromUrl) {
    const s = servers.find(x => x.url === fromUrl);
    if (s) s.on = true; else servers.push({ id: newId(), name: hostOf(fromUrl), url: fromUrl, on: true });
    history.replaceState(null, '', location.pathname + location.hash);
  }
  save();

  const enabled = () => servers.filter(s => s.on);
  const byId = id => servers.find(s => s.id === id);
  // Per server: {live: SSE open, error: last failure or null}. app.js reads it for the badge and the panel.
  const status = {};
  const setStatus = (id, patch) => { status[id] = { ...status[id], ...patch }; };

  // Which server sent what, rebuilt from every merged snapshot: requests about it go back there.
  let owner = { path: {}, run: {}, handle: {}, decision: {} };
  const jobOwner = {};
  const ownerOf = (kind, key) => byId(owner[kind][key]) || enabled()[0];

  const getJson = async (srv, path) => {
    const res = await fetch(srv.url + path);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${path} → ${res.status}`);
    return res.json();
  };
  const post = async (srv, path, body) => {
    if (!srv) return { status: 404, body: { error: '켜진 메트릭 서버가 없습니다' } };
    try {
      const res = await fetch(srv.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    } catch (e) {
      return { status: 502, body: { error: `${srv.name} 에 연결할 수 없습니다` } };
    }
  };
  // GET from every server that is on; failures are left out (and noted in status), never thrown.
  const fromAll = async path => (await Promise.all(enabled().map(async srv => {
    try { return [srv, await getJson(srv, path)]; } catch (e) {
      setStatus(srv.id, { error: e instanceof TypeError ? '연결할 수 없습니다' : String(e.message || e) });  // fetch's network failure is a TypeError
      return [srv, null];
    }
  }))).filter(([, d]) => d);
  const tag = (list, id) => (list || []).map(x => ({ ...x, server: id }));

  // Collector loop health in this page's clock (servers' clocks may differ): per loop, the worst server wins.
  function mergeHealth(parts) {
    const now = Date.now() / 1000, loops = {};
    for (const [srv, h] of parts) {
      const shift = now - (h?.now || now);
      for (const [k, l] of Object.entries(h?.loops || {})) {
        const x = { ok: l.ok && l.ok + shift, at: l.at && l.at + shift, error: l.error && (parts.length > 1 ? `[${srv.name}] ${l.error}` : l.error) };
        const cur = loops[k];
        if (!cur) { loops[k] = x; continue; }
        if (!x.ok || (cur.ok && x.ok < cur.ok)) cur.ok = x.ok;
        if (x.error && (!cur.error || x.at > cur.at)) { cur.error = x.error; cur.at = x.at; }
      }
    }
    return { now, loops };
  }

  function merge(parts) {
    const out = { version: parts.map(([s, d]) => `${s.id}:${d.version}`).join(','), api: API_VERSION, sessions: [],
      orca: { runs: [], tasks: {}, workers: [], terminals: [], error: null, updated: null }, ext_plans: [],
      tests: { files: [], run_tc: {}, history_n: 0, history_at: null }, decisions: { available: false, pending: [] } };
    const errors = [], next = { path: {}, run: {}, handle: {}, decision: {} };
    for (const [srv, d] of parts) {
      const id = srv.id, o = d.orca || {}, t = d.tests || {};
      out.sessions.push(...tag(d.sessions, id));
      out.orca.runs.push(...tag(o.runs, id));
      Object.assign(out.orca.tasks, o.tasks);
      out.orca.workers.push(...tag(o.workers, id));
      out.orca.terminals.push(...tag(o.terminals, id));
      if (o.error) errors.push(parts.length > 1 ? `[${srv.name}] ${o.error}` : o.error);
      if (o.updated && (!out.orca.updated || o.updated > out.orca.updated)) out.orca.updated = o.updated;
      out.ext_plans.push(...tag(d.ext_plans, id));
      out.tests.files.push(...tag(t.files, id));
      // run-tc progress is keyed by its file path, which two machines can share: keep them apart.
      for (const [p, v] of Object.entries(t.run_tc || {})) out.tests.run_tc[`${id}:${p}`] = { ...v, server: id };
      out.tests.history_n += t.history_n || 0;
      out.decisions.available ||= !!d.decisions?.available;
      out.decisions.pending.push(...tag(d.decisions?.pending, id));
      for (const s of d.sessions || []) { next.path[s.path] = id; if (s.orca_focus) next.handle[s.orca_focus] = id; if (s.decision) next.decision[s.decision.id] = id; }
      for (const r of o.runs || []) next.run[r.id] = id;
      for (const x of o.terminals || []) next.handle[x.handle] = id;
      for (const q of d.decisions?.pending || []) next.decision[q.id] = id;
    }
    out.tests.history_at = parts.map(([s, d]) => `${s.id}:${d.tests?.history_at ?? ''}`).join(',') || null;
    out.orca.error = errors.join(' · ') || null;
    out.health = mergeHealth(parts.map(([s, d]) => [s, d.health]));
    owner = next;
    return out;
  }

  // EventSources for the servers that are on; reconnect() swaps them after the list changes.
  // Shared across tabs: Chrome keeps at most 6 connections per host, so a stream per tab would leave the sixth tab of
  // this page with no data. One tab (whoever holds the Web Lock) opens the streams and relays them over a
  // BroadcastChannel; the rest listen, and the next tab takes over when it closes. Without locks, every tab streams.
  const shared = 'locks' in navigator && 'BroadcastChannel' in window;
  let sources = [], handlers = null, leader = !shared, bc = null;
  const lastVer = {};
  const relay = m => { if (leader && bc) bc.postMessage(m); };
  const onVersion = (id, v) => { lastVer[id] = v; handlers.version(`${id}:${v}`); };
  const setLive = (id, live) => { setStatus(id, live ? { live, error: null } : { live }); handlers.change(); };
  function openSources() {
    sources.forEach(es => es.close());
    sources = enabled().map(srv => {
      const es = new EventSource(srv.url + '/events');
      es.onopen = () => { setLive(srv.id, true); relay({ t: 'live', id: srv.id, live: true }); };
      es.onmessage = e => { onVersion(srv.id, e.data); relay({ t: 'v', id: srv.id, v: e.data }); };
      es.onerror = () => { if (status[srv.id]?.live !== false) { setLive(srv.id, false); relay({ t: 'live', id: srv.id, live: false }); } };
      return es;
    });
    for (const id of Object.keys(status)) if (!enabled().some(s => s.id === id)) delete status[id];
    handlers.change();
  }
  // After the server list changes here or in another tab: the streaming tab reopens, the others just redraw.
  const listChanged = () => { if (!handlers) return; if (leader) openSources(); else handlers.change(); };
  addEventListener('storage', e => {
    if (e.key !== KEY) return;
    try { const list = JSON.parse(e.newValue); if (Array.isArray(list)) { servers = list; listChanged(); } } catch {}
  });
  function startEvents() {
    if (!shared) return openSources();
    bc = new BroadcastChannel('adash.events');
    bc.onmessage = ({ data: m }) => {
      if (leader) {  // a tab that just opened asks where things stand
        if (m.t === 'hello') {
          for (const srv of enabled()) bc.postMessage({ t: 'live', id: srv.id, live: !!status[srv.id]?.live });
          for (const [id, v] of Object.entries(lastVer)) bc.postMessage({ t: 'v', id, v });
        }
        return;
      }
      if (m.t === 'v') onVersion(m.id, m.v);
      if (m.t === 'live') setLive(m.id, m.live);
    };
    bc.postMessage({ t: 'hello' });
    handlers.change();
    // Held until this tab closes; then the next waiting tab gets it and opens the streams.
    navigator.locks.request('adash.events', () => new Promise(() => { leader = true; openSources(); }));
  }

  return {
    API_VERSION,
    DEFAULT,
    // The server list (copies) and each one's connection status.
    servers: () => servers.map(s => ({ ...s, ...status[s.id] })),
    server: id => byId(id),
    // Replace the list (add, rename, remove, turn on/off) and reconnect to the servers now on.
    setServers: list => {
      servers = list.map(s => ({ id: s.id || newId(), name: (s.name || '').trim() || hostOf(clean(s.url)), url: clean(s.url), on: !!s.on }));
      save();
      listChanged();
    },
    // Try a server before adding it: {ok, api} from its root, or {ok: false, error} saying why not.
    probe: async url => {
      url = clean(url);
      if (!/^https?:\/\/[^/]+$/.test(url)) return { ok: false, error: 'http(s)://호스트[:포트] 형식이어야 합니다 (경로 없이)' };
      if (location.protocol === 'https:' && url.startsWith('http:') && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(url))
        return { ok: false, error: 'https 페이지는 http 주소를 부를 수 없습니다 (혼합 콘텐츠). tailscale serve 의 https 주소를 쓰세요' };
      try {
        const res = await fetch(url + '/', { signal: AbortSignal.timeout(5000) });
        const body = await res.json().catch(() => ({}));
        if (res.status === 403) return { ok: false, error: `서버가 거부했습니다: ${body.error || 403}. 서버를 --origin ${location.origin} 으로 띄웠는지 확인하세요` };
        if (!res.ok || body.name !== 'agent-dashboard') return { ok: false, error: `에이전트 대시보드 서버가 아닙니다 (${res.status})` };
        return { ok: true, api: body.api };
      } catch (e) {
        return { ok: false, error: e.name === 'TimeoutError' ? '5초 안에 응답이 없습니다'
          : '연결할 수 없습니다. 서버가 꺼져 있거나, 이 페이지 주소가 서버 --origin 에 없거나, 브라우저가 로컬 네트워크 접근을 막았습니다' };
      }
    },
    // This deployment's id from build.json (written by deploy.sh); null when served without one (a local copy).
    build: async () => {
      try { const r = await fetch('build.json', { cache: 'no-store' }); return r.ok ? (await r.json()).build : null; } catch { return null; }
    },
    // Full snapshot, merged over the servers that are on: {version, api, sessions[], orca{runs, tasks, workers,
    // terminals, error, updated}, ext_plans[], tests, health{now, loops}, decisions{available, pending[]}}; each session
    // carries `decision` (its pending question or null). A server that fails or speaks another API version is left out
    // and named in server_errors.
    state: async () => {
      const parts = [], server_errors = [];
      for (const [srv, d] of await fromAll('/api/state')) {
        if (d.api !== API_VERSION) {
          const error = `서버 API v${d.api ?? '?'} 와 페이지 v${API_VERSION} 가 맞지 않습니다`;
          setStatus(srv.id, { error });
          server_errors.push(`${srv.name}: ${error}`);
        } else { setStatus(srv.id, { error: null }); parts.push([srv, d]); }
      }
      for (const srv of enabled()) if (status[srv.id]?.error && !server_errors.some(e => e.startsWith(srv.name + ':'))) server_errors.push(`${srv.name}: ${status[srv.id].error}`);
      return { ...merge(parts), server_errors };
    },
    // One session: the summary fields plus turn_list, compaction_turns, by_tool, log, cats, plans. null when unknown.
    session: async path => {
      const srv = ownerOf('path', path);
      const d = srv && await getJson(srv, '/api/session?path=' + encodeURIComponent(path));
      return d && { ...d, server: srv.id };
    },
    // Sessions older than the live window, usage only: {updated, scanning, days, sessions[{id, kind, path, title,
    // model, parent, started, last_ts, slots{5-minute slot: [input, cache_write, cache_read, output, cost]}}]}
    history: async () => {
      const parts = await fromAll('/api/history');
      if (!parts.length) return null;
      return { updated: Math.min(...parts.map(([, d]) => d.updated || 0)), scanning: parts.some(([, d]) => d.scanning),
        days: Math.max(...parts.map(([, d]) => d.days || 0)), sessions: parts.flatMap(([s, d]) => tag(d.sessions, s.id)) };
    },
    // Finished test runs the servers kept (last 30 days, at most 2,000 each), newest first: {runs[{id, src file|run-tc,
    // key, kind, label, owner, phase done|failed, detail, total, done, passed, failed, pending, started_at, finished_at,
    // log, terminal, session_id, failures[{id, msg}], archived_at}], at}.
    tests: async () => {
      const runs = (await fromAll('/api/tests')).flatMap(([s, d]) => tag(d.runs, s.id));
      return { runs: runs.sort((a, b) => (b.finished_at || '').localeCompare(a.finished_at || '')) };
    },
    // One run with the raw task fields the snapshot leaves out (spec, result) and full worker rows. null when not tracked.
    run: async id => { const srv = ownerOf('run', id); return srv && getJson(srv, '/api/run?id=' + encodeURIComponent(id)); },
    // Messages between sessions from Orca's orchestration inbox, newest first: {messages[{id, run_id, type, subject,
    // body, cut, thread_id, from, from_term, from_kind, to, to_term, to_kind, task_id, outcome, phase, question, files,
    // read, created_at}], fetched}. limit counts messages after the heartbeat filter; hb includes heartbeats.
    interactions: async (limit, hb) => {
      const parts = await fromAll(`/api/interactions?limit=${limit}&hb=${hb ? 1 : 0}`);
      if (!parts.length) return { messages: [], error: '메시지를 가져온 서버가 없습니다' };
      const messages = parts.flatMap(([s, d]) => tag(d.messages, s.id)).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
      return { messages: messages.slice(0, limit), fetched: Math.max(...parts.map(([, d]) => d.fetched || 0)) };
    },
    // action: idle | unidle | hide | unhide; paths: session log paths (sent to the servers that own them).
    pref: async (action, paths) => {
      const by = {};
      for (const p of paths) (by[owner.path[p] || enabled()[0]?.id] ||= []).push(p);
      await Promise.all(Object.entries(by).map(([id, ps]) => post(byId(id), '/api/pref', { action, paths: ps })));
    },
    // 결정 버튼 answer: answers in question order (a label or typed text, a label list for multiSelect); the server
    // hands them to the waiting decision-hook. Resolves to {status, body}: 200 settled, 400 an answer missing,
    // 409 already answered or closed.
    decide: (id, answers) => post(ownerOf('decision', id), '/api/decision/answer', { id, answers }),
    // Let the question go to the terminal picker instead (the hook stops waiting). {status, body} as above.
    release: id => post(ownerOf('decision', id), '/api/decision/release', { id }),
    // Bring an Orca terminal's tab (and the Orca window) forward: handle is a session's `orca_focus` or a driver
    // terminal. Resolves to {status, body}: 200 ok, 404 not a connected terminal, 502 Orca failed.
    focus: handle => post(ownerOf('handle', handle), '/api/orca/focus', { handle }),
    // Close a session's Orca terminal (ends the agent process; the transcript stays); cascade also closes the
    // terminals the server mapped under it, first. Resolves to {status, body}: 202 started ({job, total}; follow it
    // with closeJob), 404 not a session's connected terminal.
    close: async (handle, cascade = false) => {
      const srv = ownerOf('handle', handle), r = await post(srv, '/api/orca/close', { handle, cascade });
      if (r.body?.job) jobOwner[r.body.job] = srv.id;
      return r;
    },
    // Progress of a close: {id, handle, total, done, closed[handle], failed[{handle, error}], state running|done}.
    closeJob: id => { const srv = byId(jobOwner[id]) || enabled()[0]; return srv ? getJson(srv, '/api/orca/job?id=' + encodeURIComponent(id)) : null; },
    // Version streams: each server sends its state version whenever it changes (version gets "<server>:<version>"),
    // and the page refetches state(). change fires when a server's connection opens or drops.
    events: ({ version, change }) => { handlers = { version, change }; startEvents(); },
  };
})();
