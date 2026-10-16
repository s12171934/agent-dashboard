// Data layer: every request the page makes to the metrics server goes through here.
// The JSON contract (fields, sizes, which screen uses what) is documented in the Obsidian vault:
// 30_Areas/자동화/에이전트 대시보드 데이터 명세.md and its session / Orca / plan notes.
// Views (app.js) never call fetch or EventSource directly, so the server can move (another host,
// /api/v1, a bearer token) by changing this file alone.
const api = (() => {
  const BASE = '';  // same origin today; a split-off UI would point this at the metrics server
  const getJson = async path => {
    const res = await fetch(BASE + path);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${path} → ${res.status}`);
    return res.json();
  };
  return {
    // Full snapshot: {version, build, sessions[], orca{runs, tasks, workers, terminals, error, updated}, ext_plans[],
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
