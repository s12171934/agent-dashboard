use crate::{core::*, projects, sessions::Session, test_runs};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::{Arc, Mutex, RwLock},
    time::Duration,
};
#[derive(Clone)]
pub struct App {
    pub config: Arc<Config>,
    pub state: Arc<RwLock<State>>,
    pub health: Health,
    pub events: tokio::sync::broadcast::Sender<String>,
    scanner: Arc<Mutex<Scanner>>,
    pub(crate) persistence: Arc<Mutex<()>>,
}
pub struct State {
    pub sessions: HashMap<String, Arc<Session>>,
    pub summaries: Vec<Value>,
    pub prefs: Value,
    pub hooks: Value,
    pub orca: Value,
    pub tests: Value,
    pub test_history: Value,
    pub plans: Value,
    pub projects: Value,
    pub decisions: Value,
    pub pending: Value,
    pub inbox: Value,
    pub canvas: Value,
    pub design: Value,
    pub design_refs: Value,
    pub reviews: Value,
    pub plan_usage: Value,
    pub vault: Value,
    pub version: u64,
    pub snapshot: Value,
    pub snapshots: Vec<Value>,
    pub places: HashMap<String, Value>,
    pub pricing: Value,
    pub history: Value,
    pub history_at: f64,
    pub scan_ready: bool,
    pub jobs: Value,
    pub redraws: Value,
    pub ship_jobs: Value,
    pub launched: HashSet<String>,
}
#[derive(Default)]
struct Scanner {
    at: f64,
    paths: Vec<(String, String)>,
    offsets: HashMap<std::path::PathBuf, u64>,
    retry: Vec<(Value, f64)>,
}
impl App {
    pub fn new(config: Config) -> Self {
        let (events, _) = tokio::sync::broadcast::channel(32);
        let pending = read_json(config.data.join("pending.json"));
        let inbox = read_json(config.data.join("inbox.json"));
        let state = State {
            sessions: HashMap::new(),
            summaries: vec![],
            prefs: prefs(&config),
            hooks: obj(),
            orca: json!({"runs":[],"tasks":{},"workers":[],"terminals":[],"error":null,"updated":0}),
            tests: json!({"files":[],"run_tc":{},"history_n":0,"history_at":null}),
            test_history: read_json(config.data.join("test-history.json")),
            plans: json!([]),
            projects: json!({"enabled":!config.projects.is_empty(),"version":0,"dirs":[],"list":[]}),
            decisions: json!({"available":true,"pending":[],"inbox":[],"inbox_mode":false}),
            pending,
            inbox,
            canvas: json!([]),
            design: json!({"enabled":false,"version":"0.0","sources":[],"docs":[]}),
            design_refs: read_json(config.data.join("design-refs.json")),
            reviews: json!({"sets":[],"updated":0}),
            plan_usage: json!({"available":false,"accounts":[]}),
            vault: json!({"on":false,"notes":[]}),
            version: 0,
            snapshot: obj(),
            snapshots: vec![],
            places: HashMap::new(),
            pricing: read_json(config.data.join("pricing.json")),
            history: read_json(config.data.join("history-cache.json")),
            history_at: 0.,
            scan_ready: false,
            jobs: obj(),
            redraws: obj(),
            ship_jobs: obj(),
            launched: HashSet::new(),
        };
        Self {
            config: Arc::new(config),
            state: Arc::new(RwLock::new(state)),
            health: Health::default(),
            events,
            scanner: Arc::new(Mutex::new(Scanner::default())),
            persistence: Arc::new(Mutex::new(())),
        }
    }
    pub fn save_prefs(&self) -> Result<()> {
        let _guard = self.persistence.lock().unwrap();
        let p = self.state.read().unwrap().prefs.clone();
        save_json(self.config.data.join("prefs.json"), &p)
    }
    pub fn start(&self) {
        self.worker("scan", 1, |a| a.scan());
        self.worker("orca", 4, |a| a.collect_orca());
        self.worker("ext_plan", 2, |a| a.collect_files());
        self.worker("projects", 5, |a| {
            let old = a.state.read().unwrap().projects.clone();
            let version = old["version"].as_u64().unwrap_or(0) + 1;
            let p = projects::collect(&a.config, version);
            if p["list"] != old["list"] || p["dirs"] != old["dirs"] {
                a.state.write().unwrap().projects = p;
                let _ = a.events.send(format!("projects:{version}"));
            }
            Ok(())
        });
        self.worker("designs", 5, crate::designs::collect);
        self.worker("review", 30, crate::review::collect);
        self.worker("history", 300, crate::archive::history);
        self.worker("vault", 5, crate::archive::vault);
        self.worker("plan_usage", 60, crate::plan_usage::collect);
        self.worker("decision", 2, crate::decisions::sweep);
        self.worker("snapshot", 2, |a| a.build_snapshot());
    }
    pub fn worker(&self, name: &'static str, seconds: u64, f: fn(&App) -> Result<()>) {
        let a = self.clone();
        std::thread::Builder::new()
            .name(name.into())
            .spawn(move || {
                let mut backoff = 0;
                loop {
                    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(&a)));
                    match r {
                        Ok(Ok(())) => {
                            a.health.ok(name);
                            backoff = 0;
                        }
                        Ok(Err(e)) => {
                            a.health.fail(name, &e);
                            if name == "orca" {
                                a.state.write().unwrap().orca["error"] = json!(e);
                                backoff = (backoff * 2).clamp(8, 30);
                            }
                        }
                        Err(_) => a.health.fail(name, "collector panicked"),
                    };
                    std::thread::sleep(Duration::from_secs(seconds.max(backoff)));
                }
            })
            .expect("collector thread");
    }
    pub fn transcript_paths(&self, hours: f64) -> Vec<(String, String)> {
        let mut found = HashSet::new();
        let mut out = vec![];
        for (root, kind) in [
            (home().join(".claude/projects"), "claude"),
            (home().join(".codex/sessions"), "codex"),
            (home().join("Library/Application Support/orca"), "codex"),
        ] {
            for p in files(root, "jsonl") {
                let s = p.to_string_lossy();
                if kind == "codex"
                    && (!s.contains("/sessions/")
                        || !p
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .starts_with("rollout-"))
                {
                    continue;
                }
                if mtime(&p) < now() - hours * 3600. {
                    continue;
                }
                let p = real(p).to_string_lossy().into_owned();
                if found.insert(p.clone()) {
                    out.push((p, kind.into()));
                }
            }
        }
        out
    }
    fn scan(&self) -> Result<()> {
        let mut scanner = self.scanner.lock().unwrap();
        let horizon = {
            let s = self.state.read().unwrap();
            s.sessions
                .values()
                .filter(|s| {
                    s.data["coordinates"] == true
                        && s.data["role"] != "worker"
                        && s.data["parent"].is_null()
                        && epoch(text(&s.data["last_ts"])).is_some_and(|t| now() - t < 1800.)
                })
                .filter_map(|s| epoch(text(&s.data["started"])))
                .fold(now() - self.config.hours * 3600., f64::min)
                .max(now() - self.config.hours.max(72.) * 3600.)
        };
        if now() - scanner.at > 10. {
            scanner.paths = self.transcript_paths((now() - horizon) / 3600.);
            scanner.at = now();
        }
        let paths = scanner.paths.clone();
        let mut changed = false;
        for (p, k) in paths {
            let mut session = self
                .state
                .write()
                .unwrap()
                .sessions
                .remove(&p)
                .unwrap_or_else(|| Arc::new(Session::new(&p, &k)));
            match Arc::make_mut(&mut session).poll() {
                Ok(c) => changed |= c,
                Err(e) => self.health.fail("scan", &format!("{p}: {e}")),
            };
            self.state.write().unwrap().sessions.insert(p, session);
        }
        let mut hooks = obj();
        let raw =
            read_json(home().join("Library/Application Support/orca/agent-hooks/last-status.json"));
        if let Some(entries) = raw["entries"].as_object() {
            for e in entries.values() {
                let id = text(&e["providerSession"]["id"]);
                if !id.is_empty() && e["payload"]["state"].is_string() {
                    hooks[id] = json!({"state":e["payload"]["state"],"mode":e["payload"]["workingMode"],"at":number(&e["receivedAt"])/1000.,"pane":e["paneKey"]});
                }
            }
        }
        let mut s = self.state.write().unwrap();
        s.hooks = hooks;
        let held: HashSet<String> = array(&s.inbox["items"])
            .iter()
            .filter_map(|d| d["card"]["session_id"].as_str().map(str::to_owned))
            .collect();
        let before = s.sessions.len();
        s.sessions
            .retain(|p, s| mtime(p) >= horizon || held.contains(s.id()));
        if s.sessions.len() != before {
            scanner.offsets.clear();
        }
        let mut records = scanner
            .retry
            .drain(..)
            .filter(|(_, t)| now() - t < 600.)
            .collect::<Vec<_>>();
        for root in [home().join(".agent-plans"), "/tmp/agent-plans".into()] {
            for p in files(root, "jsonl") {
                let offset = scanner.offsets.entry(p.clone()).or_default();
                records.extend(read_new_json(&p, offset).into_iter().map(|r| (r, now())));
            }
        }
        let by_id = s
            .sessions
            .iter()
            .map(|(p, x)| (x.id().to_owned(), p.clone()))
            .collect::<HashMap<_, _>>();
        let by_term = s
            .sessions
            .iter()
            .filter(|(_, x)| x.data["own_handle"].is_string() && x.data["parent"].is_null())
            .map(|(p, x)| (text(&x.data["own_handle"]).to_owned(), p.clone()))
            .collect::<HashMap<_, _>>();
        for (r, at) in records {
            let path = by_id
                .get(text(&r["session"]))
                .or_else(|| by_term.get(text(&r["terminal"])));
            if let Some(p) = path {
                if r["event"].is_object() {
                    if let Some(sess) = s.sessions.get_mut(p) {
                        Arc::make_mut(sess).apply_plan(&r["event"], text(&r["event"]["ts"]));
                    }
                }
            } else {
                scanner.retry.push((r, at));
            }
        }
        let _ = changed;
        s.scan_ready = true;
        Ok(())
    }
    fn collect_orca(&self) -> Result<()> {
        type RunCache = (
            f64,
            Vec<Value>,
            HashMap<String, (f64, Vec<Value>, Vec<Value>)>,
        );
        static CACHE: std::sync::OnceLock<Mutex<RunCache>> = std::sync::OnceLock::new();
        let mut cache = CACHE.get_or_init(Default::default).lock().unwrap();
        let mut runs = if now() - cache.0 > 60. || cache.1.is_empty() {
            let runs = orca_all("runs", &["orchestration", "run-list"])?;
            cache.0 = now();
            cache.1 = runs.clone();
            runs
        } else {
            let newest = orca(&["orchestration", "run-list"])?;
            let mut runs = array(&newest["runs"]).to_vec();
            let ids = runs
                .iter()
                .map(|r| text(&r["id"]).to_owned())
                .collect::<HashSet<_>>();
            runs.extend(
                cache
                    .1
                    .iter()
                    .filter(|r| !ids.contains(text(&r["id"])))
                    .cloned(),
            );
            cache.1 = runs.clone();
            runs
        };
        let latest_workers =
            orca(&["orchestration", "worker-list", "--limit", "100"]).unwrap_or(Value::Null);
        runs.sort_by(|a, b| text(&b["created_at"]).cmp(text(&a["created_at"])));
        let n = self.config.runs.max(
            runs.iter()
                .filter(|r| {
                    epoch(text(&r["created_at"]))
                        .is_some_and(|t| t > now() - self.config.hours * 3600.)
                })
                .count(),
        );
        runs.truncate(n);
        let mut tasks = obj();
        let mut workers = vec![];
        for r in &runs {
            let id = text(&r["id"]);
            let hit = cache.2.get(id).cloned();
            let changed = hit.as_ref().is_none_or(|(_, _, ws)| {
                array(&latest_workers["workers"])
                    .iter()
                    .filter(|w| w["runId"] == id)
                    .any(|w| {
                        !ws.iter().any(|old| {
                            old["dispatchId"] == w["dispatchId"]
                                && old["dispatchStatus"] == w["dispatchStatus"]
                        })
                    })
            });
            let fetch = hit.as_ref().is_none_or(|(at, ts, _)| {
                now() - at > 300.
                    || ts.iter().any(|t| {
                        !matches!(text(&t["status"]), "completed" | "failed" | "cancelled")
                    })
            }) || changed;
            let (_, ts, ws) = if fetch {
                let mut ts = orca_all("tasks", &["orchestration", "task-list", "--run", id])?;
                for t in &mut ts {
                    if t["status"] == "failed"
                        && text(&t["result"]).trim_start().starts_with("취소")
                    {
                        t["status"] = json!("cancelled");
                        t["orca_status"] = json!("failed");
                    }
                }
                let ws = orca_all("workers", &["orchestration", "worker-list", "--run", id])?;
                let hit = (now(), ts, ws);
                cache.2.insert(id.into(), hit.clone());
                hit
            } else {
                hit.unwrap()
            };
            tasks[id] = json!(ts);
            workers.extend(ws);
        }
        let terms = orca(&["terminal", "list"])?;
        let repos = orca(&["repo", "list"])?;
        let worktrees = orca(&["worktree", "list", "--limit", "10000"])?;
        let terminals: Vec<_> = array(&terms["terminals"])
            .iter()
            .map(|t| {
                let mut out = obj();
                for k in [
                    "handle",
                    "title",
                    "worktreePath",
                    "branch",
                    "connected",
                    "tabId",
                    "leafId",
                    "recordedPaneKey",
                    "agentIdentity",
                ] {
                    out[k] = t[k].clone();
                }
                out
            })
            .collect();
        let mut next = json!({"runs":runs,"tasks":tasks,"workers":workers,"terminals":terminals,"repos":repos["repos"],"worktrees":worktrees["worktrees"],"error":null});
        let mut state = self.state.write().unwrap();
        let mut old = state.orca.clone();
        let updated = old
            .as_object_mut()
            .unwrap()
            .remove("updated")
            .unwrap_or(json!(0));
        next["updated"] = if old == next { updated } else { json!(now()) };
        state.orca = next;
        Ok(())
    }
    fn collect_files(&self) -> Result<()> {
        let (prefs, mut history) = {
            let s = self.state.read().unwrap();
            (s.prefs.clone(), s.test_history.clone())
        };
        let mut plans = vec![];
        let plan_guard = self.persistence.lock().unwrap();
        let mut plan_history = read_json(self.config.data.join("plan-history.json"));
        if !plan_history.is_object() {
            plan_history = obj();
        }
        let history_before = plan_history.clone();
        for p in array(&prefs["external_plans"]) {
            let path = expand(text(p));
            let mut d = read_json(&path);
            if !d.is_object() {
                d = json!({"tickets":[],"error":"파일 없음 또는 JSON 오류"});
            }
            d["path"] = json!(path);
            for k in ["tickets", "extra_worktrees", "run_ids", "driver_history"] {
                if !d[k].is_array() {
                    d[k] = json!([]);
                }
            }
            let path_key = path.to_string_lossy().into_owned();
            let prev = &plan_history[&path_key];
            let mut drivers = if prev["coordinator_session"] == d["coordinator_session"] {
                array(&prev["driver_history"]).to_vec()
            } else {
                vec![]
            };
            for t in array(&d["tickets"]) {
                let h = &t["driver_terminal_handle"];
                if h.is_string() && !drivers.contains(h) {
                    drivers.push(h.clone());
                }
            }
            d["driver_history"] = json!(drivers);
            let parent = path.parent().unwrap_or(Path::new("."));
            if let Ok(es) = std::fs::read_dir(parent) {
                let mut es = es.flatten().collect::<Vec<_>>();
                es.sort_by_key(|e| e.file_name());
                for e in es {
                    let name = e.file_name().to_string_lossy().into_owned();
                    if name.starts_with("run-") && name.ends_with(".json") {
                        let named = crate::sessions::rx(r"-(run_[0-9a-f]+)\.superseded\.json$")
                            .captures(&name)
                            .map(|m| json!(&m[1]));
                        let r = read_json(e.path());
                        for id in named
                            .into_iter()
                            .chain(r["run_id"].as_str().map(|s| json!(s)))
                        {
                            if !array(&d["run_ids"]).contains(&id) {
                                d["run_ids"].as_array_mut().unwrap().push(id);
                            }
                        }
                    }
                }
            }
            if !plan_history[&path_key].is_object() {
                plan_history[&path_key] = obj();
            }
            merge(
                &mut plan_history[&path_key],
                &json!({"coordinator_session":d["coordinator_session"],"driver_history":d["driver_history"]}),
            );
            let side = read_json(
                path.parent()
                    .unwrap_or(Path::new("."))
                    .join("e2e-tc-plan.json"),
            );
            for t in d["tickets"].as_array_mut().unwrap() {
                for k in ["tc_plan", "e2e_progress"] {
                    if t[k].is_null() {
                        t[k] = side[text(&t["package"])][k].clone();
                    }
                }
                if t["e2e_progress"].is_string() {
                    t["e2e"] = read_json(text(&t["e2e_progress"]));
                }
            }
            crate::plans::attach_box_notes(&mut d);
            plans.push(d);
        }
        if history_before != plan_history {
            save_json(self.config.data.join("plan-history.json"), &plan_history)?;
        }
        drop(plan_guard);
        let plans = json!(plans);
        let mut tests = test_runs::collect(&self.config, &prefs, &plans, &mut history);
        let mut s = self.state.write().unwrap();
        if history == s.test_history {
            tests["history_at"] = s.tests["history_at"].clone();
        }
        s.plans = plans;
        s.tests = tests;
        s.test_history = history;
        Ok(())
    }
    pub fn build_snapshot(&self) -> Result<()> {
        let (sessions, hooks, orca, prefs, pricing, mut places) = {
            let s = self.state.read().unwrap();
            (
                s.sessions.values().cloned().collect::<Vec<_>>(),
                s.hooks.clone(),
                s.orca.clone(),
                s.prefs.clone(),
                s.pricing.clone(),
                s.places.clone(),
            )
        };
        let mut by: HashMap<(String, String), Arc<Session>> = HashMap::new();
        for s in sessions {
            let key = (s.kind.clone(), s.id().to_owned());
            if by.get(&key).is_none_or(|old| old.offset < s.offset) {
                by.insert(key, s);
            }
        }
        let mut summaries = vec![];
        for sess in by.values() {
            let cwd = text(&sess.data["launch_cwd"]);
            let place = snapshot_place(cwd, &self.config, &orca, &mut places);
            summaries.push(sess.summary(&hooks, &orca, &prefs, &pricing, &place));
        }
        let connected: HashMap<String, &Value> = array(&orca["terminals"])
            .iter()
            .filter(|t| t["connected"] == true)
            .map(|t| (text(&t["handle"]).to_owned(), t))
            .collect();
        let mut claimed = HashSet::new();
        for sm in &mut summaries {
            let pane = text(&hooks[text(&sm["id"])]["pane"]);
            let term = connected
                .iter()
                .find(|(_, t)| {
                    t["recordedPaneKey"] == pane && !pane.is_empty()
                        || format!("{}:{}", text(&t["tabId"]), text(&t["leafId"])) == pane
                })
                .map(|(h, _)| h.clone())
                .or_else(|| {
                    connected
                        .contains_key(text(&sm["own_handle"]))
                        .then(|| text(&sm["own_handle"]).to_owned())
                });
            let term = term.filter(|h| sm["parent"].is_null() && !claimed.contains(h));
            if let Some(h) = &term {
                claimed.insert(h.clone());
            }
            sm["orca_focus"] = json!(term);
            sm["orca_close_tree"] = json!([]);
            sm["decision"] = Value::Null;
        }
        for (h, t) in connected.iter().filter(|(h, _)| !claimed.contains(*h)) {
            let a = &t["agentIdentity"];
            if !a.is_null() {
                let path = format!("orca-terminal:{h}");
                let place =
                    snapshot_place(text(&t["worktreePath"]), &self.config, &orca, &mut places);
                summaries.push(json!({"id":h,"path":path,"kind":a.as_str().unwrap_or("claude"),"title":t["title"],"cwd":t["worktreePath"],"place":place,"role":"solo","parent":null,"state":"wait","state_reason":"프롬프트 입력 대기","live":false,"pending":true,"orca_focus":h,"orca_close_tree":[],"last_ts":null,"started":null,"tokens":{"input":0,"cache_read":0,"cache_write":0,"output":0},"turns":0,"tool_calls":0,"ctx_now":0,"ctx_peak":0,"slots":{},"skill_use":{},"mcp_use":{},"use_tok":{},"cost":null,"char":prefs["chars"][&path],"pinned":false,"plan":null,"task_ids":[],"made_terms":[]}));
            }
        }
        let mut plans = self.state.read().unwrap().plans.clone();
        crate::relations::apply(self, &mut summaries, &mut plans, &orca)?;
        let copy = summaries.clone();
        for sm in &mut summaries {
            sm["orca_close_tree"] = json!(crate::relations::close_tree(sm, &copy, &orca));
        }
        summaries.sort_by(|a, b| text(&b["last_ts"]).cmp(text(&a["last_ts"])));
        let mut s = self.state.write().unwrap();
        for sm in &mut summaries {
            sm["decision"] = array(&s.decisions["pending"])
                .iter()
                .find(|c| c["session_id"] == sm["id"])
                .cloned()
                .unwrap_or(Value::Null);
        }
        let mut tests = s.tests.clone();
        tests["files"] = json!(
            array(&tests["files"])
                .iter()
                .cloned()
                .map(test_runs::lite)
                .collect::<Vec<_>>()
        );
        let latest_plans = by
            .values()
            .filter_map(|sess| sess.plans().last().cloned().map(|p| (sess.path.clone(), p)))
            .collect::<HashMap<_, _>>();
        let flow = crate::flow::check(
            &summaries,
            &orca["tasks"],
            &latest_plans,
            &s.reviews["sets"],
            &prefs,
            number(&orca["updated"]) > 0. && orca["error"].is_null(),
        );
        let mut snap = json!({"version":s.version,"api":crate::http::API_VERSION,"sessions":summaries,"orca":lite_orca(&orca),"ext_plans":plans,"design":{"enabled":s.design["enabled"],"version":s.design["version"]},"tests":tests,"reviews_at":s.reviews["updated"],"health":self.health.value(),"decisions":s.decisions,"flow":flow,"plan_usage":s.plan_usage,"vault":if self.config.vault.is_dir(){json!(self.config.vault)}else{Value::Null}});
        let mut old = s.snapshot.clone();
        for v in [&mut snap, &mut old] {
            v.as_object_mut().unwrap().remove("health");
            v.as_object_mut().unwrap().remove("version");
        }
        let changed = old != snap;
        if changed {
            s.version += 1;
        }
        snap["version"] = json!(s.version);
        snap["health"] = self.health.value();
        s.summaries = summaries;
        s.places = places;
        s.snapshot = snap.clone();
        let version = s.version;
        if changed {
            s.snapshots.push(snap);
            if s.snapshots.len() > 12 {
                s.snapshots.remove(0);
            }
            let _ = self.events.send(version.to_string());
        }
        Ok(())
    }
}
pub fn orca_all(field: &str, args: &[&str]) -> Result<Vec<Value>> {
    let mut out = vec![];
    let mut cursor = String::new();
    for _ in 0..100 {
        let mut a = args.to_vec();
        if !cursor.is_empty() {
            a.extend(["--cursor", &cursor]);
        }
        let d = orca(&a)?;
        out.extend(array(&d[field]).to_vec());
        let next = d["page"]["nextCursor"]
            .as_str()
            .or(d["nextCursor"].as_str())
            .or(d["next_cursor"].as_str())
            .unwrap_or("");
        if next.is_empty() || next == cursor {
            break;
        }
        cursor = next.into();
    }
    Ok(out)
}
fn snapshot_place(
    cwd: &str,
    config: &Config,
    orca: &Value,
    places: &mut HashMap<String, Value>,
) -> Value {
    if cwd.is_empty() {
        return Value::Null;
    }
    // Resolve names afresh from Orca so renames and newly registered worktrees do not
    // get stuck in the Git fallback cache. The longest enclosing workspace wins.
    managed_place(cwd, orca).unwrap_or_else(|| {
        places
            .entry(cwd.into())
            .or_insert_with(|| place_of(cwd, config))
            .clone()
    })
}
pub fn managed_place(cwd: &str, orca: &Value) -> Option<Value> {
    if cwd.is_empty() {
        return None;
    }
    let cwd = real(cwd);
    let (w, top, repo) = array(&orca["worktrees"])
        .iter()
        .filter(|w| w["isArchived"] != true && !text(&w["path"]).is_empty())
        .filter_map(|w| {
            let top = real(text(&w["path"]));
            let repo = array(&orca["repos"])
                .iter()
                .find(|r| r["id"] == w["repoId"])?;
            cwd.starts_with(&top).then_some((w, top, repo))
        })
        .max_by_key(|(_, top, _)| top.components().count())?;
    let name = |v: &Value, path: &Path| {
        v["displayName"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| {
                path.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned()
            })
    };
    Some(json!({
        "project":name(repo, Path::new(text(&repo["path"]))),
        "project_id":repo["id"],
        "worktree":name(w, &top),
        "worktree_id":w["id"],
        "main":w["isMainWorktree"] == true,
        "branch":w["branch"].as_str().map(|s|s.trim_start_matches("refs/heads/")).filter(|s|!s.is_empty()),
        "sub":cwd.strip_prefix(&top).ok().filter(|s|!s.as_os_str().is_empty()),
        "path":top
    }))
}
pub fn place_of(cwd: &str, config: &Config) -> Value {
    let p = Path::new(cwd);
    if let Ok(top) = git(p, &["rev-parse", "--show-toplevel"]) {
        let common = git(
            p,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )
        .unwrap_or_else(|_| format!("{top}/.git"));
        let main = Path::new(&common).parent().unwrap_or(p);
        json!({"project":main.file_name().unwrap_or_default().to_string_lossy(),"worktree":Path::new(&top).file_name().unwrap_or_default().to_string_lossy(),"main":main==Path::new(&top),"branch":git(p,&["branch","--show-current"]).ok().filter(|s|!s.is_empty()),"sub":p.strip_prefix(&top).ok().filter(|s|!s.as_os_str().is_empty()),"path":top})
    } else {
        json!({"project":if p.starts_with(&config.vault){"Obsidian 볼트".into()}else{p.file_name().unwrap_or_default().to_string_lossy().into_owned()},"worktree":null,"main":true,"branch":null,"sub":null,"path":cwd})
    }
}
fn lite_orca(o: &Value) -> Value {
    let mut o = o.clone();
    // Placement metadata has already been resolved into each session's place.
    for key in ["repos", "worktrees"] {
        o.as_object_mut().unwrap().remove(key);
    }
    for r in o["runs"].as_array_mut().unwrap() {
        r.as_object_mut().unwrap().retain(|k, _| {
            ["id", "objective", "coordinator_handle", "created_at"].contains(&k.as_str())
        });
    }
    if let Some(ts) = o["tasks"].as_object_mut() {
        for v in ts.values_mut() {
            for t in v.as_array_mut().unwrap() {
                let spec = text(&t["spec"]);
                let ticket = crate::sessions::rx(r"\b([A-Z]{2,}-\d+)\b")
                    .captures(spec)
                    .map(|m| m[1].to_owned());
                let hint = crate::sessions::rx(
                    r"(?im)(?:^|\n)\s*(?:배치|워크트리|worktree|placement)\s*[:：]\s*([^\n]+)",
                )
                .captures(spec)
                .map(|m| m[1].trim().to_owned());
                let result =
                    serde_json::from_str::<Value>(text(&t["result"])).unwrap_or(Value::Null);
                t.as_object_mut().unwrap().retain(|k, _| {
                    [
                        "id",
                        "run_id",
                        "task_title",
                        "display_name",
                        "status",
                        "orca_status",
                        "deps",
                        "created_at",
                        "completed_at",
                    ]
                    .contains(&k.as_str())
                });
                merge(
                    t,
                    &json!({"ticket_key":ticket,"place_hint":hint,"outcome":result["outcome"]}),
                );
            }
        }
    }
    for w in o["workers"].as_array_mut().unwrap() {
        *w = json!({"taskId":w["taskId"],"runId":w["runId"],"dispatchStatus":w["dispatchStatus"],"model":w["projection"]["provider"]["model"].as_str().or(w["projection"]["provider"]["id"].as_str())});
    }
    o
}
