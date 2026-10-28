// Data layer: every request the page makes to the metrics servers goes through here.
// The JSON contract (fields, sizes, which screen uses what) is documented in the Obsidian vault:
// 30_Areas/자동화/에이전트 대시보드 데이터 명세.md and its session / Orca / plan notes.
// Views (app.js) never call fetch or EventSource directly, so the server can move (another host,
// /api/v1, a bearer token) by changing this file alone.
// The page is served from Cloudflare Pages and the metrics servers run on the user's machines, so the server list is
// per device (localStorage adash.servers: [{id, name, url, on}]); ?server=<url> adds one and turns it on. Every server
// that is on is read at once and merged into one snapshot: each session, run, plan, test file and question carries
// `server` (its id), and a request about one of them (detail, answer, focus, close) goes to the server that
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
  // Sessions the 「설계문서」 tab lists may be outside every server's live window (not in any snapshot): their server
  // is remembered from the document that listed them.
  const refOwner = {};
  const ownerOf = (kind, key) => byId(owner[kind][key]) || (kind === 'path' && byId(refOwner[key])) || enabled()[0];

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
      tests: { files: [], run_tc: {}, history_n: 0, history_at: null }, decisions: { available: false, pending: [], inbox: [], inbox_mode: {} },
      flow: { contracts: null, items: [], ok: 0, rules: {}, errors: [], from: [], missing: [] } };
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
      // 메일함: a server older than it sends no inbox_mode and is left out of the switch.
      if (typeof d.decisions?.inbox_mode === 'boolean') out.decisions.inbox_mode[id] = d.decisions.inbox_mode;
      out.decisions.inbox.push(...tag(d.decisions?.inbox, id));
      // Flow deviations (server flow_check): each item goes back to its server for 「정상으로 표시」. Contracts are the
      // first server's; a server older than the check sends no flow and adds nothing.
      if (!d.flow) out.flow.missing.push(srv.name);
      else {
        out.flow.from.push(id);
        out.flow.items.push(...tag(d.flow.items, id));
        out.flow.ok += d.flow.ok || 0;
        out.flow.contracts ||= d.flow.contracts;
        Object.assign(out.flow.rules, d.flow.rules);
        if (d.flow.error) out.flow.errors.push(parts.length > 1 ? `[${srv.name}] ${d.flow.error}` : d.flow.error);
      }
      for (const s of d.sessions || []) { next.path[s.path] = id; if (s.orca_focus) next.handle[s.orca_focus] = id; if (s.decision) next.decision[s.decision.id] = id; }
      for (const r of o.runs || []) next.run[r.id] = id;
      for (const x of o.terminals || []) next.handle[x.handle] = id;
      for (const q of [...d.decisions?.pending || [], ...d.decisions?.inbox || []]) next.decision[q.id] = id;
    }
    out.decisions.inbox.sort((a, b) => b.created_at - a.created_at);
    // Plan usage: one card per subscription account; an account two servers both read is shown once, freshest read wins.
    const accts = {};
    for (const [s, d] of parts) for (const a of d.plan_usage?.accounts || [])
      if (!accts[a.key] || (a.at || 0) > (accts[a.key].at || 0)) accts[a.key] = { ...a, server: s.id, server_name: s.name };
    out.plan_usage = Object.values(accts);
    out.tests.history_at = parts.map(([s, d]) => `${s.id}:${d.tests?.history_at ?? ''}`).join(',') || null;
    out.reviews_at = parts.map(([s, d]) => `${s.id}:${d.reviews_at ?? ''}`).join(',') || null;
    out.orca.error = errors.join(' · ') || null;
    out.health = mergeHealth(parts.map(([s, d]) => [s, d.health]));
    // design documents: whether any server indexes them, and a version string that changes when a server's index does
    out.design = { enabled: parts.some(([, d]) => d.design?.enabled), version: parts.map(([s, d]) => `${s.id}:${d.design?.version ?? ''}`).join(',') };
    // each server's vault root, for the Obsidian links (app.js obsLink); a server older than it sends none
    out.vaults = [...new Set(parts.map(([, d]) => d.vault).filter(Boolean))];
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
  // Project progress changes come as a named event of their own (`event: projects`), apart from the state version.
  const lastProj = {};
  const onProjects = (id, v) => { lastProj[id] = v; handlers.projects?.(`${id}:${v}`); };
  const setLive = (id, live) => { setStatus(id, live ? { live, error: null } : { live }); handlers.change(); };
  function openSources() {
    sources.forEach(es => es.close());
    sources = enabled().map(srv => {
      const es = new EventSource(srv.url + '/events');
      es.onopen = () => { setLive(srv.id, true); relay({ t: 'live', id: srv.id, live: true }); };
      es.onmessage = e => { onVersion(srv.id, e.data); relay({ t: 'v', id: srv.id, v: e.data }); };
      es.addEventListener('projects', e => { onProjects(srv.id, e.data); relay({ t: 'p', id: srv.id, v: e.data }); });
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
          for (const [id, v] of Object.entries(lastProj)) bc.postMessage({ t: 'p', id, v });
        }
        return;
      }
      if (m.t === 'v') onVersion(m.id, m.v);
      if (m.t === 'p') onProjects(m.id, m.v);
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
    // terminals, error, updated}, ext_plans[], tests, health{now, loops}, decisions{available, pending[], inbox[] (newest
    // first), inbox_mode{server id: on}}}; each session
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
    // One session's conversation, prompts and replies as said (each up to 4,000 characters): [{ts, role user|assistant,
    // text}], oldest first. A server without /api/chat gives the short lines of the session's log instead. null when unknown.
    chat: async path => {
      const srv = ownerOf('path', path);
      if (!srv) return null;
      const d = await getJson(srv, '/api/chat?path=' + encodeURIComponent(path));
      if (d) return d.chat;
      const s = await getJson(srv, '/api/session?path=' + encodeURIComponent(path));
      return s && s.log.filter(l => l.role === 'user' || l.role === 'assistant').map(({ ts, role, text }) => ({ ts, role, text }));
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
    // QA sets for the 워크트리 tab, over the servers that are on: {sets[{server, local, epic, summary, project, error,
    // stray[], tickets[{key, summary, status, cat, assignee, review none|pending|done|changed|reopened, review_at,
    // review_round, review_sha{repo: sha}, step, step_status, notes[], test, repos[{repo, path, branch, name, comment, head, base,
    // base_ref, base_src PR|설정|기본, pr, dirty, ahead, behind, files, ins, dels}]}]}], jira}. local: the server is this
    // device's loopback, the only place 「VS Code 로 열기」 can work. state.reviews_at changes when any server's sets do.
    reviews: async () => {
      const parts = await fromAll('/api/reviews'), loop = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/;
      return { sets: parts.flatMap(([s, d]) => (d.sets || []).map(x => ({ ...x, server: s.id, local: loop.test(s.url) }))),
               jira: parts.map(([, d]) => d.jira).find(Boolean) || '' };
    },
    // Open every worktree of a ticket in one VS Code window on that server's Mac, or record / clear its review in the
    // vault step note. Resolve to {status, body}: 403 open from anywhere but that Mac's loopback, 409 no worktree / note.
    reviewOpen: (server, key) => post(byId(server), '/api/review/open', { key }),
    // The ticket's worktrees in that server's web VS Code (read-only, started on first use): body.repos[{repo, path,
    // url}], url absolute (the server's address + its secret path). Same loopback-only terms as reviewOpen.
    reviewWeb: async (server, key) => {
      const srv = byId(server), r = await post(srv, '/api/review/web', { key });
      (r.body.repos || []).forEach(x => { x.url = srv.url + x.url; });
      return r;
    },
    reviewMark: (server, key, done) => post(byId(server), '/api/review/mark', { key, done }),
    // Every git worktree on each server's Mac, for the 워크트리 tab: {servers[{server, name, local, error, repos[{name,
    // path, error, worktrees[{path, name, comment, branch, head, main, orca, detached, locked, prunable, bare, missing,
    // dirty, committed, subject}]}]}]}. local: the server is this device's loopback, where VS Code can be opened.
    worktrees: async fresh => {
      const loop = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/;
      return { servers: await Promise.all(enabled().map(async srv => {
        try { const d = await getJson(srv, '/api/worktrees' + (fresh ? '?fresh=1' : ''));
          return { server: srv.id, name: srv.name, local: loop.test(srv.url), error: d?.error || (d ? null : '이 서버에는 워크트리 목록이 없습니다'), repos: d?.repos || [] };
        } catch (e) { return { server: srv.id, name: srv.name, local: false, error: e instanceof TypeError ? '연결할 수 없습니다' : String(e.message || e), repos: [] }; }
      })) };
    },
    // One listed worktree in a desktop VS Code window on that server's Mac, or {url} (absolute) of the web VS Code on
    // it. Same loopback-only terms as reviewOpen.
    worktreeOpen: (server, path) => post(byId(server), '/api/worktrees/open', { path }),
    worktreeWeb: async (server, path) => {
      const srv = byId(server), r = await post(srv, '/api/worktrees/web', { path });
      if (r.body.url) r.body.url = srv.url + r.body.url;
      return r;
    },
    reviewShip: (server, key) => post(byId(server), '/api/review/ship', { key }),
    // QA driver control on the set's server. automation: action enable | disable | run on an Orca automation the set
    // lists. ticket: action approve (push/PR approval → the coordinator) | cleanup_check (dry run; body.code 3 = it would
    // stop) | cleanup. Resolve to {status, body{ok, code, output}}.
    qaAutomation: (server, epic, id, action) => post(byId(server), '/api/qa/automation', { epic, id, action }),
    qaTicket: (server, epic, key, action, extra) => post(byId(server), '/api/qa/ticket', { epic, key, action, ...extra }),
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
    // action: idle | unidle | char (extra: { who, boss, pick }); paths: session log paths (sent to the servers that own them).
    pref: async (action, paths, extra) => {
      const by = {};
      for (const p of paths) (by[owner.path[p] || enabled()[0]?.id] ||= []).push(p);
      await Promise.all(Object.entries(by).map(([id, ps]) => post(byId(id), '/api/pref', { action, paths: ps, ...extra })));
    },
    // 「정상으로 표시」 on a flow deviation (ok=false undoes it), sent to the server that judged it.
    flowOk: (server, id, ok, item) => post(byId(server), '/api/flow/ok', { id, ok, item }),
    // aplan plans with step times for the 진행 타임라인, asked of each path's own server: {path: [{ts, prompt, steps}]}.
    plans: async paths => {
      const by = {};
      for (const p of paths) (by[owner.path[p] || enabled()[0]?.id] ||= []).push(p);
      const parts = await Promise.all(Object.entries(by).map(async ([id, ps]) => {
        const srv = byId(id);
        try { return srv ? (await getJson(srv, '/api/plans?' + ps.map(p => 'p=' + encodeURIComponent(p)).join('&')))?.plans || {} : {}; } catch { return {}; }
      }));
      return Object.assign({}, ...parts);
    },
    // 결정 버튼 answer: answers in question order (a label or typed text, a label list for multiSelect); the server
    // hands them to the waiting decision-hook. Resolves to {status, body}: 200 settled, 400 an answer missing,
    // 409 already answered or closed.
    decide: (id, answers) => post(ownerOf('decision', id), '/api/decision/answer', { id, answers }),
    // Let the question go to the terminal picker instead (the hook stops waiting). {status, body} as above.
    release: id => post(ownerOf('decision', id), '/api/decision/release', { id }),
    // Take a card off the page after an error (the terminal picker stays). {status, body}: 200, 409 already closed.
    dismiss: id => post(ownerOf('decision', id), '/api/decision/dismiss', { id }),
    // A 메일함 item: action read | unread | delete, or answer (answers in question order, null for one left as the
    // agent went; the server sends the session a follow-up message and drops the item). {status, body}: 200 done,
    // 400 nothing picked or the same answer, 404 gone, 409 no Orca terminal for the session, 502 Orca failed.
    inbox: (id, action, answers) => post(ownerOf('decision', id), '/api/decision/inbox', { id, action, answers }),
    // 메일함 mode on or off on every server that is on and has it ({status, body} of the first failure, or 200).
    inboxMode: async (on, ids) => {
      const rs = await Promise.all(ids.map(id => post(byId(id), '/api/decision/mode', { inbox: on })));
      return rs.find(r => r.status !== 200) || { status: 200, body: { ok: true } };
    },
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
    // Where 「새 에이전트」 can launch on a server: {repos[{id, name, path}], worktrees[{id, repo, name, path, branch,
    // main}]} as Orca lists them, or {error}.
    places: async (server, fresh) => {
      const srv = byId(server);
      try { return srv ? await getJson(srv, '/api/orca/places' + (fresh ? '?fresh=1' : '')) : { error: '켜진 메트릭 서버가 없습니다' }; }
      catch (e) { return { error: String(e.message || e) }; }
    },
    // Start an agent on a server: body {kind worktree|agent, repo | worktree, name, agent, model, effort, prompt, title}.
    // Resolves to {status, body}: 202 started ({job, label}; follow it with closeJob, whose handle is the agent's
    // terminal), 400 what is wrong with the form.
    launch: async (server, body) => {
      const r = await post(byId(server), '/api/orca/launch', body);
      if (r.body?.job) jobOwner[r.body.job] = server;
      return r;
    },
    // Type a prompt into an agent's Orca terminal and press Enter. {status, body}: 200 {started: the agent's turn
    // began (false: typed in, read after its current turn)}, 404 not an agent's connected terminal, 504 Orca did not
    // answer (it may have gone in).
    send: (handle, text) => post(ownerOf('handle', handle), '/api/orca/send', { handle, text }),
    // Progress of a close or a launch: {id, handle, total, done, closed[handle], failed[{handle, error}], state
    // running|done}; a launch adds kind, label, where, note.
    closeJob: id => { const srv = byId(jobOwner[id]) || enabled()[0]; return srv ? getJson(srv, '/api/orca/job?id=' + encodeURIComponent(id)) : null; },
    // Project progress from the servers started with --projects-dir (a server without it, or an older one, is left out):
    // {enabled, dirs[{dir, error, server}], projects[...], sources[{server, state}]}; each project carries `server` and,
    // per stage, status, counts, ratio, start, end (no steps). The server derives everything from the progress.json
    // files. sources says, per server that is on, why it did or did not send projects: ok | off (no --projects-dir) |
    // old (a server version without the API) | error.
    projects: async () => {
      const sources = [], parts = [];
      await Promise.all(enabled().map(async srv => {
        try {
          const d = await getJson(srv, '/api/projects');
          sources.push({ server: srv.id, state: !d ? 'old' : d.enabled ? 'ok' : 'off' });
          if (d?.enabled) parts.push([srv, d]);
        } catch { sources.push({ server: srv.id, state: 'error' }); }
      }));
      return { enabled: parts.length > 0, sources, dirs: parts.flatMap(([s, d]) => tag(d.dirs, s.id)),
        projects: parts.flatMap(([s, d]) => tag(d.projects, s.id)) };
    },
    // One project with its stages' steps ({path, title, date, endDate, status}). null when unknown.
    project: async (server, name) => {
      const srv = byId(server), d = srv && await getJson(srv, '/api/project?name=' + encodeURIComponent(name));
      return d && { ...d, server };
    },
    // A note inside a project's folder (a step's path, or a note it links to): {path, abs, mtime, content,
    // links[{target, path|null}]}. null when not found.
    note: async (server, name, path) => {
      const srv = byId(server);
      return srv && getJson(srv, `/api/project/note?name=${encodeURIComponent(name)}&path=${encodeURIComponent(path)}`);
    },
    // Design documents from the servers that index them (prefs design_dirs or --design-dir): {enabled, sources[{server,
    // state ok|off|old|error}], dirs[{server, dir, configured, repo, worktree, branch, head, main}], docs[{server, key,
    // kind md|image|pdf, src (index into that server's dirs), copies, mtime, size, sessions, reads, searches}],
    // plans[{server, project, path, design_root, design_commit}], refs (references kept)}.
    designs: async () => {
      const sources = [], parts = [];
      await Promise.all(enabled().map(async srv => {
        try {
          const d = await getJson(srv, '/api/designs');
          sources.push({ server: srv.id, state: !d ? 'old' : d.enabled ? 'ok' : 'off' });
          if (d?.enabled) parts.push([srv, d]);
        } catch { sources.push({ server: srv.id, state: 'error' }); }
      }));
      return { enabled: parts.length > 0, sources, dirs: parts.flatMap(([s, d]) => tag(d.sources, s.id)),
        docs: parts.flatMap(([s, d]) => tag(d.docs, s.id)), plans: parts.flatMap(([s, d]) => tag(d.plans, s.id)),
        refs: parts.reduce((n, [, d]) => n + (d.refs || 0), 0) };
    },
    // Notes agent sessions made in the vault, newest first over the servers that are on: {on, old (a server without
    // the API), notes[{server, path, abs, title, mtime, agent, session (log path or null), session_title}]}.
    vaultRecent: async limit => {
      let on = false, old = false;
      const notes = (await Promise.all(enabled().map(async srv => {
        try {
          const d = await getJson(srv, '/api/vault/recent?limit=' + limit);
          if (!d) { old = true; return []; }
          on ||= d.on;
          return tag(d.notes, srv.id);
        } catch { return []; }
      }))).flat().sort((a, b) => b.mtime - a.mtime).slice(0, limit);
      return { on, old, notes };
    },
    // One document: {key, kind, mtime, size, source{dir, repo, worktree, branch, head}, copies[], content (Markdown),
    // toc[{id, title, no, start, end}], refs[{section, session, title, path, kind, parent, reads, searches, lines,
    // cover, first, last, exact, commits, ticket}], plans[{project, design_commit, head, same, same_file}]}. null when unknown.
    design: async (server, key) => {
      const srv = byId(server), d = srv && await getJson(srv, '/api/design?path=' + encodeURIComponent(key));
      for (const r of d?.refs || []) if (r.path) refOwner[r.path] = server;
      return d && { ...d, server };
    },
    // The address of a picture or PDF in a design folder (for <img>, <iframe>).
    designFile: (server, key) => (byId(server)?.url || '') + '/api/design/file?path=' + encodeURIComponent(key),
    // Characters made from an uploaded picture (an Orca agent draws and publishes them): every server's jobs, newest
    // first, each with server — {id, who, name, look, boss, driver, notes, agent, created, updated, handle,
    // done[desc|full|bust|sd|published], sheets[ref|full|bust|sd], state running|published|failed, error}. A server
    // without the API is left out.
    // With them each server's redraws (charRedraw): {who, kind, set, state running|done|failed, step draw|publish, error,
    // started, ended, server}.
    charState: async () => {
      const r = await fromAll('/api/chars/jobs');
      return { jobs: r.flatMap(([srv, d]) => tag(d.jobs, srv.id)).sort((a, b) => b.created - a.created),
        redraws: r.flatMap(([srv, d]) => tag(d.redraws, srv.id)) };
    },
    // Start one: body {who, name, look, boss, driver, notes, agent, model, image (base64)}. {status, body}: 202 {job},
    // 400 what is wrong with the form.
    charCreate: (server, body) => post(byId(server), '/api/chars/create', body),
    charRemove: (server, id) => post(byId(server), '/api/chars/remove', { id }),
    // Delete a character for good (every page drops it on its next read). {status, body}: 200, 502 why not.
    charUnpublish: (server, who) => post(byId(server), '/api/chars/unpublish', { who }),
    // A person's name, look and role (boss, driver) everywhere. {status, body}: 200, 400/502 why not.
    charMeta: (server, body) => post(byId(server), '/api/chars/meta', body),
    // Redraw one sheet {who, kind full|bust|sd, set a-d, name, look, boss, driver} and put the person up again, in the
    // background (charState follows it). {status, body}: 202 {redraw}, 400 why not.
    charRedraw: (server, body) => post(byId(server), '/api/chars/redraw', body),
    // A job's uploaded picture (f=ref) or a sheet the agent drew (full, bust, sd); t busts the browser cache.
    charFile: (server, id, f, t) => `${byId(server)?.url || ''}/api/chars/file?job=${encodeURIComponent(id)}&f=${f}&t=${t || 0}`,
    // Version streams: each server sends its state version whenever it changes (version gets "<server>:<version>"),
    // and the page refetches state(). change fires when a server's connection opens or drops; projects when a server's
    // project progress changes ("<server>:<version>").
    events: ({ version, change, projects }) => { handlers = { version, change, projects }; startEvents(); },
  };
})();
