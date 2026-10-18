// Data layer: every request the page makes to the metrics server goes through here.
// The JSON contract (fields, sizes, which screen uses what) is documented in the Obsidian vault:
// 30_Areas/자동화/에이전트 대시보드 데이터 명세.md and its session / Orca / plan notes.
// Views (app.js) never call fetch or EventSource directly, so the server can move (another host,
// /api/v1, a bearer token) by changing this file alone.
// The page is served from Cloudflare Pages and the metrics server runs on the user's Mac, so the server address is
// per device: ?server=<url> sets it (kept in localStorage as adash.server), else http://127.0.0.1:8787. Other
// devices on the tailnet need the HTTPS address `tailscale serve` gives the Mac: an https page may not call http.
const api = (() => {
  const KEY = 'adash.server', DEFAULT = 'http://127.0.0.1:8787';
  const clean = u => (u || '').trim().replace(/\/+$/, '');
  const fromUrl = clean(new URLSearchParams(location.search).get('server'));
  if (fromUrl) {
    try { localStorage.setItem(KEY, fromUrl); } catch {}
    history.replaceState(null, '', location.pathname + location.hash);
  }
  let stored = '';
  try { stored = clean(localStorage.getItem(KEY)); } catch {}
  const BASE = fromUrl || stored || DEFAULT;
  const getJson = async path => {
    const res = await fetch(BASE + path);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${path} → ${res.status}`);
    return res.json();
  };
  return {
    // The metrics server this page talks to, and the API shape it was written for (the server's API_VERSION).
    base: BASE,
    API_VERSION: 1,
    DEFAULT,
    // Point this device at another server (an empty url goes back to the default); the caller reloads.
    setBase: url => { try { url = clean(url); url ? localStorage.setItem(KEY, url) : localStorage.removeItem(KEY); } catch {} },
    // Try a server before switching to it: {ok, api} from its root, or {ok: false, error} saying why not.
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
    // Full snapshot: {version, api, sessions[], orca{runs, tasks, workers, terminals, error, updated}, ext_plans[],
    // health{now, loops}, decisions{available, pending[]}}; each session carries `decision` (its pending question or null)
    state: () => getJson('/api/state'),
    // One session: the summary fields plus turn_list, compaction_turns, by_tool, log, cats, plans. null when unknown.
    session: path => getJson('/api/session?path=' + encodeURIComponent(path)),
    // Sessions older than the live window, usage only: {updated, scanning, days, sessions[{id, kind, path, title,
    // model, parent, started, last_ts, slots{5-minute slot: [input, cache_write, cache_read, output, cost]}}]}
    history: () => getJson('/api/history'),
    // Finished test runs the server kept (last 30 days, at most 2,000), newest first: {runs[{id, src file|run-tc, key,
    // kind, label, owner, phase done|failed, detail, total, done, passed, failed, pending, started_at, finished_at, log,
    // terminal, session_id, failures[{id, msg}], archived_at}], at}. at matches state.tests.history_at.
    tests: () => getJson('/api/tests'),
    // One run with the raw task fields the snapshot leaves out (spec, result) and full worker rows. null when not tracked.
    run: id => getJson('/api/run?id=' + encodeURIComponent(id)),
    // Messages between sessions from Orca's orchestration inbox, newest first: {messages[{id, run_id, type, subject,
    // body, cut, thread_id, from, from_term, from_kind, to, to_term, to_kind, task_id, outcome, phase, question, files,
    // read, created_at}], fetched}. limit counts messages after the heartbeat filter; hb includes heartbeats.
    interactions: (limit, hb) => getJson(`/api/interactions?limit=${limit}&hb=${hb ? 1 : 0}`),
    // action: idle | unidle | hide | unhide; paths: session log paths.
    pref: (action, paths) => fetch(BASE + '/api/pref', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, paths }),
    }),
    // 결정 버튼 answer, relayed to the 8799 server: answers in question order (a label or typed text, a label list
    // for multiSelect). Resolves to {status, body}: 200 settled, 202 being typed into the terminal, 400 an answer
    // missing, 409 already answered, 502 the 8799 server is unreachable.
    decide: async (id, answers) => {
      const res = await fetch(BASE + '/api/decision/answer', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, answers }),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    },
    // Bring an Orca terminal's tab (and the Orca window) forward: handle is a session's `orca_focus` or a driver
    // terminal. Resolves to {status, body}: 200 ok, 404 not a connected terminal, 502 Orca failed.
    focus: async handle => {
      const res = await fetch(BASE + '/api/orca/focus', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle }),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    },
    // Close a session's Orca terminal (ends the agent process; the transcript stays); cascade also closes the
    // terminals the server mapped under it, first. Resolves to {status, body}: 202 started ({job, total}; follow it
    // with closeJob), 404 not a session's connected terminal.
    close: async (handle, cascade = false) => {
      const res = await fetch(BASE + '/api/orca/close', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle, cascade }),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    },
    // Progress of a close: {id, handle, total, done, closed[handle], failed[{handle, error}], state running|done}.
    closeJob: id => getJson('/api/orca/job?id=' + encodeURIComponent(id)),
    // Version stream: the server sends its state version whenever it changes; the page refetches state().
    events: ({ open, version, error }) => {
      const es = new EventSource(BASE + '/events');
      es.onopen = open;
      es.onmessage = e => version(e.data);
      es.onerror = error;
      return es;
    },
  };
})();
