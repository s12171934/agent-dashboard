//! Incremental Claude/Codex transcript parsing. File offsets stop before incomplete JSONL records.
use crate::{core::*, plans};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs,
    io::{Read, Seek, SeekFrom},
    path::Path,
    sync::{Arc, OnceLock, RwLock},
};

pub fn rx(p: &str) -> Arc<regex::Regex> {
    static CACHE: OnceLock<RwLock<HashMap<String, Arc<regex::Regex>>>> = OnceLock::new();
    let c = CACHE.get_or_init(Default::default);
    if let Some(r) = c.read().unwrap().get(p) {
        return r.clone();
    }
    let r = Arc::new(regex::Regex::new(p).unwrap());
    c.write().unwrap().insert(p.into(), r.clone());
    r
}
const HANDLE: &str = r"term_(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{32})";
pub fn handles(s: &str) -> Vec<String> {
    rx(HANDLE).find_iter(s).map(|m| m.as_str().into()).collect()
}
pub fn valid_handle(s: &str) -> bool {
    rx(&format!("^{HANDLE}$")).is_match(s)
}
pub fn closes_own(cmd: &str, own: &[String]) -> bool {
    rx(r"(?:^|[;&|\n(]\s*)(?:\S*/orca|orca|\$\{?\w+\}?) terminal close\b([^;&|\n]*)")
        .captures_iter(cmd)
        .any(|c| {
            let rest = &c[1];
            if rest.contains("--help") {
                return false;
            }
            if !rest.contains("--terminal") {
                return true;
            }
            rx(r#"--terminal[ =]+["']?(\$\{?ORCA_TERMINAL_HANDLE\b|term_[0-9a-f-]+)"#)
                .captures(rest)
                .is_some_and(|m| m[1].starts_with('$') || own.iter().any(|h| h == &m[1]))
        })
}
fn inc(v: &mut Value, k: &str) {
    let n = v[k].as_u64().unwrap_or(0) + 1;
    v[k] = json!(n);
}
fn trim(v: &mut Vec<Value>, max: usize) {
    if v.len() > max {
        v.drain(..v.len() - max);
    }
}
fn content(v: &Value) -> String {
    if let Some(s) = v.as_str() {
        s.into()
    } else {
        array(v)
            .iter()
            .map(|x| text(&x["text"]))
            .collect::<Vec<_>>()
            .join(" ")
    }
}
pub fn classify(name: &str, input: &Value) -> (String, Vec<String>, Option<String>) {
    let s = input
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| input.to_string());
    if name == "Skill" {
        return ("스킬".into(), vec![text(&input["skill"]).to_owned()], None);
    }
    if name.starts_with("mcp__") {
        return (
            "MCP".into(),
            vec![],
            name.split("__").nth(1).map(str::to_owned),
        );
    }
    let skills: BTreeSet<_> = rx(r"skills/([A-Za-z0-9_.-]+)/SKILL\.md")
        .captures_iter(&s)
        .map(|m| m[1].to_owned())
        .collect();
    if !skills.is_empty() {
        return ("스킬".into(), skills.into_iter().collect(), None);
    }
    let name = name.rsplit('.').next().unwrap_or(name);
    let cat = if [
        "Agent",
        "Task",
        "TaskStop",
        "SendMessage",
        "spawn_agent",
        "followup_task",
        "wait_agent",
        "send_message",
        "list_agents",
        "interrupt_agent",
    ]
    .contains(&name)
    {
        "서브에이전트"
    } else if [
        "Bash",
        "exec",
        "exec_command",
        "local_shell_call",
        "shell",
        "Monitor",
        "BashOutput",
        "KillShell",
        "js",
    ]
    .contains(&name)
    {
        if rx(r"\borca\s+(?:orchestration|terminal|worktree|skills)\b").is_match(&s) {
            "오케스트레이션"
        } else {
            "셸"
        }
    } else if [
        "Read",
        "Write",
        "Edit",
        "MultiEdit",
        "Grep",
        "Glob",
        "LS",
        "NotebookEdit",
        "apply_patch",
    ]
    .contains(&name)
    {
        "파일"
    } else if ["WebFetch", "WebSearch"].contains(&name) {
        "웹"
    } else {
        "기타"
    };
    (cat.into(), vec![], None)
}
fn prices(model: &str, ctx: f64, overrides: &Value) -> Option<[f64; 5]> {
    if let Some(a) = overrides[model].as_array().filter(|a| a.len() == 5) {
        return Some(std::array::from_fn(|i| number(&a[i])));
    }
    let models = [
        ("gpt-6.1-sol", [2., 2.5, 2.5, 0.1, 10.]),
        ("gpt-6-astra", [10., 12.5, 12.5, 1., 50.]),
        ("claude-opus-5-5", [4., 5., 8., 0.2, 20.]),
        ("claude-opus-5", [5., 6.25, 10., 0.5, 25.]),
        ("claude-opus-4-8", [5., 6.25, 10., 0.5, 25.]),
        ("claude-fable-5-1", [10., 12.5, 20., 0.25, 50.]),
        ("claude-fable-5", [10., 12.5, 20., 1., 50.]),
        ("claude-sonnet-5-5", [2., 2.5, 4., 0.2, 10.]),
        ("claude-sonnet-5", [2., 2.5, 4., 0.2, 10.]),
        ("claude-haiku-4-5", [1., 1.25, 2., 0.1, 5.]),
    ];
    if ctx > 272000. {
        if model == "gpt-6.1-sol" {
            return Some([4., 5., 5., 0.2, 15.]);
        }
        if model == "gpt-6-astra" {
            return Some([20., 25., 25., 2., 75.]);
        }
    }
    models
        .iter()
        .find(|(m, _)| model.starts_with(m))
        .map(|(_, p)| *p)
}
pub fn turn_cost(t: &Value, model: &str, overrides: &Value) -> Option<[f64; 4]> {
    let model = t["model"].as_str().unwrap_or(model);
    let p = prices(model, number(&t["ctx"]), overrides)?;
    Some([
        number(&t["input"]) * p[0] / 1e6,
        ((number(&t["cache_write"]) - number(&t["cw_1h"])) * p[1] + number(&t["cw_1h"]) * p[2])
            / 1e6,
        number(&t["cache_read"]) * p[3] / 1e6,
        number(&t["output"]) * p[4] / 1e6,
    ])
}
fn round(v: f64) -> f64 {
    (v * 10000.).round() / 10000.
}

#[derive(Clone)]
pub struct Session {
    pub path: String,
    pub kind: String,
    pub offset: u64,
    pub data: Value,
    pub turns: Vec<Value>,
    pub log: Vec<Value>,
    pub chat: Vec<Value>,
    pub compactions: Vec<usize>,
    pub events: BTreeMap<String, (String, Value)>,
    pub prompts: Vec<(String, String)>,
    pub asks: HashMap<String, Value>,
    pub inbox_picks: HashMap<String, String>,
    pub reads: Vec<Value>,
    keys: HashMap<String, usize>,
    read_calls: HashMap<String, Value>,
    pending: Vec<(String, Vec<String>)>,
    busy: bool,
    error: Option<String>,
    self_close: Option<String>,
    own_calls: BTreeSet<String>,
    self_binds: BTreeSet<String>,
    create_calls: BTreeSet<String>,
    term_calls: HashMap<String, String>,
    plan_calls: BTreeSet<String>,
    bg_calls: HashMap<String, String>,
    stop_calls: HashMap<String, String>,
    bg: HashMap<String, (String, String)>,
    votes: BTreeMap<String, u64>,
    runs: BTreeMap<String, u64>,
}
impl Session {
    pub fn new(path: &str, kind: &str) -> Self {
        let id = Path::new(path)
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        let parent = path
            .split_once("/subagents/")
            .and_then(|(p, _)| Path::new(p).file_name())
            .map(|s| s.to_string_lossy().into_owned());
        Self {
            path: path.into(),
            kind: kind.into(),
            offset: 0,
            data: json!({"id":id,"title":null,"custom_title":null,"cwd":null,"launch_cwd":null,"model":null,"started":null,"last_ts":null,"ctx_window":if kind=="claude"{json!(200000)}else{Value::Null},"parent":parent,"role":"solo","coord_handle":null,"own_handle":null,"task_id":null,"prior_tasks":[],"prior_handles":[],"self_handles":[],"made_terms":[],"coordinates":false,"awaits":[],"skill_use":{},"mcp_use":{},"cats":{}}),
            turns: vec![],
            log: vec![],
            chat: vec![],
            compactions: vec![],
            events: BTreeMap::new(),
            prompts: vec![],
            asks: HashMap::new(),
            inbox_picks: HashMap::new(),
            reads: vec![],
            keys: HashMap::new(),
            read_calls: HashMap::new(),
            pending: vec![],
            busy: false,
            error: None,
            self_close: None,
            own_calls: BTreeSet::new(),
            self_binds: BTreeSet::new(),
            create_calls: BTreeSet::new(),
            term_calls: HashMap::new(),
            plan_calls: BTreeSet::new(),
            bg_calls: HashMap::new(),
            stop_calls: HashMap::new(),
            bg: HashMap::new(),
            votes: BTreeMap::new(),
            runs: BTreeMap::new(),
        }
    }
    pub fn id(&self) -> &str {
        text(&self.data["id"])
    }
    pub fn poll(&mut self) -> Result<bool> {
        let size = fs::metadata(&self.path).map_err(|e| e.to_string())?.len();
        if size < self.offset {
            *self = Self::new(&self.path, &self.kind);
        }
        if size == self.offset {
            return Ok(false);
        }
        let mut f = fs::File::open(&self.path).map_err(|e| e.to_string())?;
        f.seek(SeekFrom::Start(self.offset))
            .map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        f.take(size - self.offset)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        let Some(end) = bytes.iter().rposition(|b| *b == b'\n') else {
            return Ok(false);
        };
        self.offset += (end + 1) as u64;
        for raw in bytes[..=end].split(|b| *b == b'\n') {
            if let Ok(rec) = serde_json::from_slice::<Value>(raw) {
                self.feed(&rec);
            }
        }
        Ok(true)
    }
    fn set(&mut self, k: &str, v: &Value) {
        if !v.is_null() && v != "" {
            self.data[k] = v.clone();
        }
    }
    fn add_log(
        &mut self,
        ts: &str,
        role: &str,
        s: &str,
        instruction: bool,
        full: bool,
        extra: Value,
    ) {
        if role == "user"
            && instruction
            && !rx(r"^\s*(?:<|\[Image: |You have \d+ orchestration messages?\b)").is_match(s)
        {
            self.prompts.push((ts.into(), s.into()));
        }
        if full && (role == "assistant" || role == "user" && instruction) && !s.trim().is_empty() {
            let raw = s.trim();
            let t = if raw.chars().count() > 4000 {
                format!("{}…", raw.chars().take(3999).collect::<String>())
            } else {
                raw.into()
            };
            self.chat.push(json!({"ts":ts,"role":role,"text":t}));
            trim(&mut self.chat, 200);
        }
        let mut l = json!({"ts":ts,"role":role,"text":short(s,if role=="result"{200}else{300}),"turn":self.turns.len() as i64-1});
        merge(&mut l, &extra);
        self.log.push(l);
        trim(&mut self.log, 600);
    }
    #[allow(clippy::too_many_arguments)]
    fn turn(
        &mut self,
        key: &str,
        ts: &str,
        ctx: f64,
        inp: f64,
        cr: f64,
        cw: f64,
        out: f64,
        cw1: f64,
    ) -> usize {
        if let Some(&i) = self.keys.get(key) {
            self.turns[i]["output"] = json!(number(&self.turns[i]["output"]).max(out));
            return i;
        }
        let i = self.turns.len();
        if self
            .turns
            .last()
            .is_some_and(|t| number(&t["ctx"]) > 0. && ctx < number(&t["ctx"]) * 0.6)
        {
            self.compactions.push(i);
        }
        self.turns.push(json!({"ts":if ts.is_empty(){None}else{Some(ts)},"ctx":ctx,"input":inp,"cache_read":cr,"cache_write":cw,"cw_1h":cw1.min(cw),"output":out,"tools":[],"uses":[],"model":self.data["model"],"slot":epoch(ts).map(|t|(t/300.).floor()as i64)}));
        self.keys.insert(key.into(), i);
        i
    }
    fn brief(&mut self, s: &str) {
        if self.data["role"] != "worker"
            && self.turns.len() > 2
            && !s.contains("You are a dispatched worker.")
        {
            return;
        }
        let c = rx(&format!(
            r"Your coordinator's terminal handle is:\s*({HANDLE})"
        ))
        .captures(s);
        let t = rx(r"Your task ID is:\s*(task_[0-9a-f]{12})").captures(s);
        if let (Some(c), Some(t)) = (c, t) {
            if self.data["task_id"] == t[1] {
                return;
            }
            for (key, old) in [("prior_tasks", "task_id"), ("prior_handles", "own_handle")] {
                let v = self.data[old].clone();
                if v.is_string() {
                    self.data[key].as_array_mut().unwrap().push(v);
                }
            }
            self.data["role"] = json!("worker");
            self.data["coord_handle"] = json!(&c[1]);
            self.data["task_id"] = json!(&t[1]);
            let mut votes = BTreeMap::new();
            for h in handles(s).into_iter().filter(|h| h != &c[1]) {
                *votes.entry(h).or_insert(0) += 1;
            }
            if let Some((h, _)) = votes.into_iter().max_by_key(|(_, v)| *v) {
                self.data["own_handle"] = json!(h);
            }
        }
    }
    fn call(&mut self, id: &str, cmd: &str) {
        let own: Vec<String> = array(&self.data["self_handles"])
            .iter()
            .map(|v| text(v).into())
            .chain(self.data["own_handle"].as_str().map(str::to_owned))
            .collect();
        self.self_close = closes_own(cmd, &own).then(|| id.into());
        if cmd.contains("aplan set")
            || rx(r"\borca orchestration (?:ask\b|check[^;&|\n]*--wait)").is_match(cmd)
        {
            self.data["awaits"] = json!([]);
        }
        if rx(
            r"\borca (?:terminal send|orchestration (?:send|dispatch|task-create|worker-start))\b",
        )
        .is_match(cmd)
        {
            for h in handles(cmd) {
                if self.data["own_handle"] != h && !array(&self.data["awaits"]).contains(&json!(h))
                {
                    self.data["awaits"].as_array_mut().unwrap().push(json!(h));
                }
            }
        }
        for c in rx(r#"(?:^|[;&|\n("'/]\s*)orca orchestration (?:run-create|run-use|dispatch|worker-start)\b"#).find_iter(cmd){let rest=cmd[c.end()..].split([';','&','|','\n']).next().unwrap_or("");if !rx(r"(?:^|\s)(?:--help|-h)(?:\s|$)").is_match(rest){self.data["coordinates"]=json!(true);}}
        if !cmd.contains("--help")
            && (cmd.contains("orchestration run-create")
                || cmd.contains("orchestration run-use")
                || (!cmd.contains("--from")
                    && (cmd.contains("orchestration worker-start")
                        || cmd.contains("orchestration dispatch"))))
        {
            self.own_calls.insert(id.into());
            if !cmd.contains("--from") {
                self.self_binds.insert(id.into());
            }
            if cmd.contains("run-create") || !cmd.contains("run-use") {
                self.create_calls.insert(id.into());
            }
        }
        if cmd.contains("terminal create") && !cmd.contains("--help") {
            self.term_calls.insert(id.into(), cmd.into());
        }
        if rx(r"\baplan\b").is_match(cmd) {
            self.plan_calls.insert(id.into());
        }
    }
    pub fn apply_plan(&mut self, ev: &Value, ts: &str) {
        let k = ev["id"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| format!("echo-{}", self.events.len()));
        let ts = ev["ts"].as_str().unwrap_or(ts).into();
        self.events.entry(k).or_insert((ts, ev.clone()));
    }
    fn result(&mut self, id: &str, s: &str, ts: &str) {
        if self.self_close.as_deref() == Some(id) {
            self.self_close = None;
        }
        if let Some(t) = self.stop_calls.remove(id) {
            self.bg.remove(&t);
        }
        if let Some(name) = self.bg_calls.remove(id) {
            let p = match name.as_str() {
                "Bash" => {
                    r"^(?:Command running in background with ID: |Command did not complete within its \d+s timeout and was moved to the background \(ID: )(\w+)\)?\. Output is being written to: "
                }
                "Monitor" => r"Monitor started \(task (\w+)",
                _ => r"(?s)Async agent launched.*?agentId: (\w+)",
            };
            if let Some(m) = rx(p).captures(s) {
                self.bg.insert(
                    m[1].into(),
                    (
                        if name == "Agent" {
                            "에이전트".into()
                        } else {
                            name
                        },
                        ts.into(),
                    ),
                );
            }
        }
        if let Some(cmd) = self.term_calls.get(id) {
            for h in handles(s) {
                if !cmd.contains(&h)
                    && self.data["own_handle"] != h
                    && !array(&self.data["made_terms"]).contains(&json!(h))
                {
                    self.data["made_terms"]
                        .as_array_mut()
                        .unwrap()
                        .push(json!(h));
                }
            }
        }
        if self.own_calls.contains(id) {
            for m in rx(&format!(r#"coordinator_handle\\*"\s*:\s*\\*"({HANDLE})"#)).captures_iter(s)
            {
                *self.votes.entry(m[1].into()).or_default() += 1;
                if self.self_binds.contains(id)
                    && !array(&self.data["self_handles"]).contains(&json!(&m[1]))
                {
                    self.data["self_handles"]
                        .as_array_mut()
                        .unwrap()
                        .push(json!(&m[1]));
                }
            }
            if self.create_calls.contains(id) {
                for m in rx(r"\brun_[0-9a-f]{12}\b").find_iter(s) {
                    *self.runs.entry(m.as_str().into()).or_default() += 1;
                }
            }
        }
        if self.plan_calls.contains(id) {
            for m in rx(r"APLAN:([A-Za-z0-9_=-]+)").captures_iter(s) {
                if let Ok(b) = URL_SAFE_NO_PAD.decode(m[1].trim_end_matches('=')) {
                    if let Ok(ev) = serde_json::from_slice(&b) {
                        self.apply_plan(&ev, ts);
                    }
                }
            }
        }
        if let Some(q) = self.asks.get_mut(id) {
            q[2] = json!(true);
        }
    }
    fn tool(&mut self, name: &str, input: &Value) -> (String, Vec<String>) {
        let (cat, skills, server) = classify(name, input);
        inc(&mut self.data["cats"], &cat);
        for s in &skills {
            inc(&mut self.data["skill_use"], s);
        }
        let mut keys = skills;
        if let Some(server) = server {
            inc(&mut self.data["mcp_use"], &server);
            keys.push(format!("mcp:{server}"));
        }
        (cat, keys)
    }
    pub fn feed(&mut self, r: &Value) {
        let ts = text(&r["timestamp"]);
        if !ts.is_empty() {
            if self.data["started"].is_null() {
                self.data["started"] = json!(ts);
            }
            self.data["last_ts"] = json!(ts);
        }
        if self.kind == "claude" {
            self.claude(r, ts);
        } else {
            self.codex(r, ts);
        }
        self.read_feed(r, ts);
    }
    fn read_feed(&mut self, r: &Value, ts: &str) {
        let mut calls = vec![];
        let mut results = vec![];
        if self.kind == "claude" {
            for b in array(&r["message"]["content"]) {
                if b["type"] == "tool_use" {
                    calls.push((text(&b["id"]), text(&b["name"]), b["input"].clone()));
                }
                if b["type"] == "tool_result" && b["is_error"] != true {
                    results.push((text(&b["tool_use_id"]), content(&b["content"])));
                }
            }
        } else {
            let p = &r["payload"];
            if r["type"] == "response_item" {
                if matches!(
                    text(&p["type"]),
                    "function_call" | "custom_tool_call" | "local_shell_call"
                ) {
                    calls.push((
                        text(&p["call_id"]),
                        text(&p["name"]),
                        p.get("arguments")
                            .or(p.get("input"))
                            .cloned()
                            .unwrap_or(Value::Null),
                    ));
                } else if matches!(
                    text(&p["type"]),
                    "function_call_output" | "custom_tool_call_output"
                ) {
                    results.push((
                        text(&p["call_id"]),
                        p["output"]
                            .as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| p["output"].to_string()),
                    ));
                }
            }
        }
        for (id, name, input) in calls {
            self.read_calls.insert(
                id.into(),
                json!({"name":name,"input":input,"cwd":self.data["cwd"],"ts":ts}),
            );
        }
        for (id, body) in results {
            if let Some(c) = self.read_calls.remove(id) {
                for mut r in
                    crate::reads::tool(text(&c["name"]), &c["input"], text(&c["cwd"]), &body)
                {
                    r["tool"] = c["name"].clone();
                    r["call"] = json!(id);
                    r["ts"] = c["ts"].clone();
                    self.reads.push(r);
                }
            }
        }
    }
    fn claude(&mut self, r: &Value, ts: &str) {
        self.set("cwd", &r["cwd"]);
        if self.data["launch_cwd"].is_null() {
            self.data["launch_cwd"] = self.data["cwd"].clone();
        }
        let typ = text(&r["type"]);
        if typ == "custom-title" {
            self.set("custom_title", &r["customTitle"]);
            let c = self.data["custom_title"].clone();
            self.set("title", &c);
            return;
        }
        if typ == "ai-title" {
            let c = if self.data["custom_title"].is_string() {
                self.data["custom_title"].clone()
            } else {
                r["aiTitle"].clone()
            };
            self.set("title", &c);
            return;
        }
        let m = &r["message"];
        if typ == "system" && r["subtype"] == "turn_duration" {
            self.busy = false;
        }
        if typ == "queue-operation" {
            self.bg_end(text(&r["content"]));
        }
        if typ == "assistant" {
            let synthetic = m["model"] == "<synthetic>";
            if synthetic {
                self.error = Some(short(&content(&m["content"]), 120));
                self.busy = false;
            } else {
                self.set("model", &m["model"]);
                self.error = None;
            }
            match text(&m["stop_reason"]) {
                "tool_use" => self.busy = true,
                "end_turn" | "stop_sequence" | "max_tokens" | "refusal" => self.busy = false,
                _ => {}
            }
            let turn = if m["usage"].is_object() {
                let u = &m["usage"];
                let (inp, cr, cw) = (
                    number(&u["input_tokens"]),
                    number(&u["cache_read_input_tokens"]),
                    number(&u["cache_creation_input_tokens"]),
                );
                let key = r["requestId"]
                    .as_str()
                    .or(m["id"].as_str())
                    .or(r["uuid"].as_str())
                    .unwrap_or(ts);
                Some(self.turn(
                    key,
                    ts,
                    inp + cr + cw,
                    inp,
                    cr,
                    cw,
                    number(&u["output_tokens"]),
                    number(&u["cache_creation"]["ephemeral_1h_input_tokens"]),
                ))
            } else {
                None
            };
            for b in array(&m["content"]) {
                match text(&b["type"]) {
                    "tool_use" => {
                        let (id, name, input) = (text(&b["id"]), text(&b["name"]), &b["input"]);
                        let cmd = text(&input["command"]);
                        if ["TaskStop", "KillShell"].contains(&name) {
                            let t = input["task_id"].as_str().or(input["shell_id"].as_str());
                            if let Some(t) = t {
                                self.stop_calls.insert(id.into(), t.into());
                            }
                        }
                        if ["Bash", "Monitor", "Agent"].contains(&name) {
                            self.bg_calls.insert(id.into(), name.into());
                        }
                        if name == "AskUserQuestion" {
                            if let Some(q) = array(&input["questions"]).first() {
                                self.asks
                                    .insert(id.into(), json!([q["question"], epoch(ts), false]));
                            }
                        }
                        if name == "Bash" && !cmd.is_empty() {
                            self.asks.insert(
                                id.into(),
                                json!([
                                    cmd.chars().take(4000).collect::<String>(),
                                    epoch(ts),
                                    false
                                ]),
                            );
                        }
                        self.call(id, cmd);
                        let (cat, keys) = self.tool(name, input);
                        if let Some(i) = turn {
                            self.turns[i]["tools"]
                                .as_array_mut()
                                .unwrap()
                                .push(json!(cat));
                            self.turns[i]["uses"]
                                .as_array_mut()
                                .unwrap()
                                .push(json!(keys));
                        }
                        let hint = [
                            "command",
                            "file_path",
                            "pattern",
                            "description",
                            "prompt",
                            "url",
                            "skill",
                            "query",
                        ]
                        .into_iter()
                        .find_map(|k| input[k].as_str())
                        .map(str::to_owned)
                        .unwrap_or_else(|| input.to_string());
                        self.add_log(
                            ts,
                            "tool",
                            name,
                            true,
                            false,
                            json!({"detail":short(&hint,120)}),
                        );
                    }
                    "text" => {
                        let s = text(&b["text"]);
                        if !s.trim().is_empty() {
                            for c in rx(r"\[메일함 (q[0-9a-f]{8,40})\][ \t]*([^\n]{1,300})")
                                .captures_iter(s)
                            {
                                self.inbox_picks
                                    .insert(c[1].into(), c[2].trim_matches([' ', '`', '*']).into());
                            }
                            self.add_log(ts, "assistant", s, true, true, obj());
                        }
                    }
                    _ => {}
                }
            }
        } else if typ == "user" {
            let c = &m["content"];
            if r["isMeta"] != true && r["isCompactSummary"] != true {
                self.busy = true;
                if c.is_string() {
                    self.self_close = None;
                }
                if c.to_string()
                    .chars()
                    .take(400)
                    .collect::<String>()
                    .contains("[Request interrupted by user")
                {
                    self.busy = false;
                }
            }
            if let Some(s) = c.as_str() {
                self.bg_end(s);
                self.brief(s);
                if self.data["title"].is_null() && !s.starts_with('<') {
                    self.data["title"] = json!(short(s, 80));
                }
                self.add_log(ts, "user", s, r["isMeta"] != true, true, obj());
            } else {
                for b in array(c) {
                    if b["type"] == "tool_result" {
                        let s = content(&b["content"]);
                        self.result(text(&b["tool_use_id"]), &s, ts);
                        self.add_log(
                            ts,
                            "result",
                            &s,
                            true,
                            false,
                            json!({"size":s.chars().count(),"error":b["is_error"]==true}),
                        );
                    } else if b["type"] == "text" && !text(&b["text"]).starts_with('<') {
                        self.add_log(
                            ts,
                            "user",
                            text(&b["text"]),
                            r["isMeta"] != true,
                            true,
                            obj(),
                        );
                    }
                }
            }
        } else if typ == "system" && text(&r["subtype"]).contains("compact") {
            self.compact(ts);
        }
    }
    fn bg_end(&mut self, s: &str) {
        if rx(r"<status>(?:completed|failed|killed|stopped|cancelled|error)</status>|Monitor (?:expired|stopped|ended)").is_match(s){for c in rx(r"<task-id>(\w+)</task-id>").captures_iter(s){self.bg.remove(&c[1]);}}
    }
    fn compact(&mut self, ts: &str) {
        if !self.turns.is_empty() && !self.compactions.contains(&(self.turns.len() - 1)) {
            self.compactions.push(self.turns.len() - 1);
        }
        self.add_log(ts, "system", "컨텍스트 압축", true, false, obj());
    }
    fn codex(&mut self, r: &Value, ts: &str) {
        let p = &r["payload"];
        let typ = text(&r["type"]);
        let pt = text(&p["type"]);
        match typ {
            "session_meta" => {
                self.set("id", &p["id"]);
                self.set("cwd", &p["cwd"]);
            }
            "turn_context" => {
                self.set("cwd", &p["cwd"]);
                self.set("model", &p["model"]);
            }
            "token_usage_record" => {
                let u = &p["usage"];
                let total = number(&u["input_tokens"]);
                let cr = number(&u["cached_input_tokens"]);
                let cw = number(&u["cache_write_input_tokens"]);
                let i = self.turn(
                    p["response_id"].as_str().unwrap_or(ts),
                    ts,
                    total,
                    (total - cr - cw).max(0.),
                    cr,
                    cw,
                    number(&u["output_tokens"]),
                    0.,
                );
                for (c, k) in self.pending.drain(..) {
                    self.turns[i]["tools"]
                        .as_array_mut()
                        .unwrap()
                        .push(json!(c));
                    self.turns[i]["uses"].as_array_mut().unwrap().push(json!(k));
                }
            }
            "event_msg" => match pt {
                "task_started" => self.busy = true,
                "task_complete" | "turn_aborted" => self.busy = false,
                "token_count" => self.set("ctx_window", &p["info"]["model_context_window"]),
                _ => {}
            },
            "response_item" => match pt {
                "function_call" | "custom_tool_call" | "local_shell_call" => {
                    let name = p["name"].as_str().unwrap_or(pt);
                    let input = if !p["input"].is_null() {
                        &p["input"]
                    } else {
                        &p["arguments"]
                    };
                    let cmd = input
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| input.to_string());
                    self.call(text(&p["call_id"]), &cmd);
                    let ck = self.tool(name, input);
                    self.pending.push(ck);
                    self.add_log(
                        ts,
                        "tool",
                        name,
                        true,
                        false,
                        json!({"detail":short(&cmd,120)}),
                    );
                }
                "function_call_output" | "custom_tool_call_output" => {
                    let s = p["output"]
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| p["output"].to_string());
                    self.result(text(&p["call_id"]), &s, ts);
                    self.add_log(
                        ts,
                        "result",
                        &s,
                        true,
                        false,
                        json!({"size":s.chars().count()}),
                    );
                }
                "message" => {
                    let s = content(&p["content"]);
                    let role = text(&p["role"]);
                    if role == "assistant" && !s.trim().is_empty() {
                        self.add_log(ts, role, &s, true, true, obj());
                    } else if role == "user"
                        && (s.contains("dispatched worker")
                            || !s.trim().is_empty() && !s.trim_start().starts_with(['#', '<']))
                    {
                        self.brief(&s);
                        if self.data["title"].is_null() {
                            self.data["title"] = json!(short(&s, 80));
                        }
                        self.add_log(ts, role, &s, true, true, obj());
                    }
                }
                _ => {
                    if pt.contains("compact") {
                        self.compact(ts);
                    }
                }
            },
            _ => {
                if pt.contains("compact") {
                    self.compact(ts);
                }
            }
        }
        if self.data["launch_cwd"].is_null() {
            self.data["launch_cwd"] = self.data["cwd"].clone();
        }
    }
    pub fn plans(&self) -> Vec<Value> {
        let mut e: Vec<_> = self.events.values().cloned().collect();
        e.sort_by(|a, b| a.0.cmp(&b.0));
        plans::build(&e, &self.prompts)
    }
    pub fn summary(
        &self,
        hooks: &Value,
        orca: &Value,
        prefs: &Value,
        pricing: &Value,
        place: &Value,
    ) -> Value {
        let mut d = self.data.clone();
        let model = text(&d["model"]);
        let mut tokens = json!({"input":0,"cache_read":0,"cache_write":0,"output":0});
        let mut costs = [0.; 4];
        let mut priced = !self.turns.is_empty();
        let mut slots: BTreeMap<i64, [f64; 5]> = BTreeMap::new();
        let mut peak: f64 = 0.;
        let mut total: f64 = 0.;
        let mut tools = 0;
        let mut use_tok: BTreeMap<String, [f64; 3]> = BTreeMap::new();
        for (i, t) in self.turns.iter().enumerate() {
            let ctx = number(&t["ctx"]);
            peak = peak.max(ctx);
            total += ctx;
            tools += array(&t["tools"]).len();
            for k in ["input", "cache_read", "cache_write", "output"] {
                tokens[k] = json!(number(&tokens[k]) + number(&t[k]));
            }
            let c = turn_cost(t, model, pricing);
            if let Some(c) = c {
                for j in 0..4 {
                    costs[j] += c[j];
                }
            } else {
                priced = false;
            }
            if let Some(e) = epoch(text(&t["ts"])) {
                let slot = (e / 300.).floor() as i64;
                if slot > (now() / 300.) as i64 - 2016 {
                    let s = slots.entry(slot).or_insert([0.; 5]);
                    for (j, k) in ["input", "cache_write", "cache_read", "output"]
                        .iter()
                        .enumerate()
                    {
                        s[j] += number(&t[k]);
                    }
                    s[4] += c.map(|c| c.iter().sum::<f64>()).unwrap_or(0.);
                }
            }
            if i + 1 < self.turns.len()
                && !self.compactions.contains(&(i + 1))
                && !array(&t["tools"]).is_empty()
            {
                let a = i + 1;
                let end = self
                    .compactions
                    .iter()
                    .copied()
                    .filter(|j| *j > a)
                    .min()
                    .unwrap_or(self.turns.len());
                let growth =
                    (number(&self.turns[a]["ctx"]) - ctx).max(0.) / array(&t["tools"]).len() as f64;
                let cost = (a..end)
                    .map(|j| {
                        let q = &self.turns[j];
                        prices(
                            q["model"].as_str().unwrap_or(model),
                            number(&q["ctx"]),
                            pricing,
                        )
                        .map(|p| if j == a { p[1] } else { p[3] } / 1e6)
                        .unwrap_or(0.)
                    })
                    .sum::<f64>();
                for keys in array(&t["uses"]) {
                    let ks = array(keys);
                    for k in ks {
                        let g = growth / ks.len() as f64;
                        let v = use_tok.entry(text(k).into()).or_insert([0.; 3]);
                        v[0] += g;
                        v[1] += g * (end - a) as f64;
                        v[2] += g * cost;
                    }
                }
            }
        }
        for s in slots.values_mut() {
            s[4] = round(s[4]);
        }
        for v in use_tok.values_mut() {
            v[0] = v[0].round();
            v[1] = v[1].round();
            v[2] = round(v[2]);
        }
        let age = epoch(text(&d["last_ts"])).map(|e| now() - e);
        let hook = &hooks[self.id()];
        let bg = self
            .bg
            .values()
            .filter(|(_, ts)| epoch(ts).is_none_or(|e| now() - e < 21600.))
            .count();
        let (state, reason) = if let Some(err) = self.error.as_ref().filter(|_| !self.busy) {
            ("stalled", format!("API 오류로 멈춤: {err}"))
        } else if self.busy && self.self_close.is_some() && age.is_some_and(|a| a >= 60.) {
            ("idle", "자기 터미널을 닫고 종료".into())
        } else if hook.is_object()
            && epoch(text(&d["last_ts"])).is_some_and(|e| number(&hook["at"]) >= e - 1.)
        {
            if hook["state"] == "working" {
                if hook["mode"] == "monitoring" {
                    (
                        "bg",
                        "Orca: monitoring (턴 종료 · 백그라운드 작업 진행)".into(),
                    )
                } else {
                    (
                        "run",
                        format!("Orca: {}", hook["mode"].as_str().unwrap_or("working")),
                    )
                }
            } else {
                (
                    if age.is_some_and(|a| a < 1800.) {
                        "wait"
                    } else {
                        "idle"
                    },
                    format!("Orca: {}", text(&hook["state"])),
                )
            }
        } else if self.busy {
            if age.is_some_and(|a| a < 900.) {
                ("run", "턴 진행 중".into())
            } else {
                ("stalled", "턴이 열린 채 기록 없음".into())
            }
        } else if bg > 0 {
            ("bg", "턴 종료 · 백그라운드 작업 진행".into())
        } else if age.is_some_and(|a| a < 1800.) {
            ("wait", "턴 종료 · 입력 대기".into())
        } else {
            ("idle", "턴 종료".into())
        };
        let pane = text(&hook["pane"]);
        let pane_handle = array(&orca["terminals"])
            .iter()
            .find(|t| {
                t["connected"] == true
                    && format!("{}:{}", text(&t["tabId"]), text(&t["leafId"])) == pane
            })
            .map(|t| t["handle"].clone());
        if d["role"] != "worker" {
            if d["coordinates"] == true {
                d["role"] = json!("coordinator");
            }
            if let Some((h, _)) = self.votes.iter().max_by_key(|(_, v)| *v) {
                d["own_handle"] = json!(h);
            } else if !self.own_calls.is_empty() && pane_handle.is_some() {
                d["own_handle"] = pane_handle.clone().unwrap();
            } else if !self.runs.is_empty() {
                if let Some(r) = array(&orca["runs"])
                    .iter()
                    .find(|r| self.runs.contains_key(text(&r["id"])))
                {
                    d["own_handle"] = r["coordinator_handle"].clone();
                }
            }
        }
        let mut ids = array(&d["prior_tasks"]).to_vec();
        if !d["task_id"].is_null() {
            ids.push(d["task_id"].clone());
        }
        let mut workers: Vec<_> = array(&orca["workers"])
            .iter()
            .filter(|w| {
                (w["agentTerminalHandle"] == d["own_handle"] && !d["own_handle"].is_null())
                    || array(&d["prior_handles"]).contains(&w["agentTerminalHandle"])
            })
            .collect();
        workers.sort_by_key(|w| text(&w["startedAt"]));
        for w in &workers {
            if !ids.contains(&w["taskId"]) {
                ids.push(w["taskId"].clone());
            }
        }
        let current = workers
            .iter()
            .rev()
            .find(|w| {
                !matches!(
                    text(&w["dispatchStatus"]),
                    "completed" | "failed" | "cancelled"
                )
            })
            .map(|w| w["taskId"].clone())
            .or_else(|| {
                let created = orca["tasks"]
                    .as_object()
                    .into_iter()
                    .flat_map(|o| o.values())
                    .flat_map(array)
                    .map(|t| (text(&t["id"]), text(&t["created_at"])))
                    .collect::<HashMap<_, _>>();
                ids.iter()
                    .enumerate()
                    .max_by_key(|(i, id)| (created.get(text(id)).copied().unwrap_or(""), *i))
                    .map(|(_, id)| id.clone())
            })
            .unwrap_or(Value::Null);
        let last=self.log.iter().rev().find(|l|matches!(text(&l["role"]),"tool"|"assistant"|"user"|"system")).map(|l|json!({"role":l["role"],"ts":l["ts"],"text":short(&format!("{}{}",text(&l["text"]),if l["detail"].is_string(){format!(" · {}",text(&l["detail"]))}else{String::new()}),140)}));
        let aliases: Vec<Value> = array(&d["self_handles"])
            .iter()
            .cloned()
            .chain(pane_handle)
            .filter(|h| *h != d["own_handle"])
            .collect();
        merge(
            &mut d,
            &json!({"path":self.path,"kind":self.kind,"title":self.data["title"].as_str().unwrap_or_else(||self.id().get(..8).unwrap_or(self.id())),"task_id":current,"task_ids":ids,"own_aliases":aliases,"state":state,"state_reason":reason,"live":state=="run","bg_tasks":if state=="run"||state=="bg"{bg}else{0},"tokens":tokens,"cost":if priced{json!(round(costs.iter().sum()))}else{Value::Null},"cost_parts":if priced{json!({"input":round(costs[0]),"cache_write":round(costs[1]),"cache_read":round(costs[2]),"output":round(costs[3])})}else{Value::Null},"turns":self.turns.len(),"ctx_now":self.turns.last().map(|t|number(&t["ctx"])).unwrap_or(0.),"ctx_peak":peak,"ctx_avg":if self.turns.is_empty(){0.}else{(total/self.turns.len()as f64).round()},"compactions":self.compactions.len(),"tool_calls":tools,"skills":self.data["skill_use"].as_object().unwrap().values().map(|v|v.as_u64().unwrap_or(0)).sum::<u64>(),"skill_kinds":self.data["skill_use"].as_object().unwrap().len(),"slots":slots,"use_tok":use_tok,"last_action":last,"plan":plans::summary(&self.plans()),"place":place,"char":prefs["chars"][&self.path],"pinned":!prefs["pinned"][&self.path].is_null(),"manual_idle":false}),
        );
        if self.kind == "claude" && peak > 200000. {
            d["ctx_window"] = json!(1000000);
        }
        if let Some(mark) = prefs["idle"][&self.path].as_str() {
            if text(&d["last_ts"]) <= mark {
                d["manual_idle"] = json!(true);
                if state != "done" {
                    d["state"] = json!("idle");
                    d["live"] = json!(false);
                    d["state_reason"] = json!("수동으로 유휴 처리됨");
                }
            }
        }
        for k in [
            "custom_title",
            "launch_cwd",
            "prior_tasks",
            "prior_handles",
            "self_handles",
            "cats",
        ] {
            d.as_object_mut().unwrap().remove(k);
        }
        d
    }
    pub fn detail(&self, mut sm: Value) -> Value {
        let mut by = obj();
        for (i, t) in self.turns.iter().enumerate() {
            for name in array(&t["tools"]) {
                let k = text(name);
                if by[k].is_null() {
                    by[k] = json!({"calls":0,"ctx_growth":0});
                }
                inc(&mut by[k], "calls");
                if i + 1 < self.turns.len() && !self.compactions.contains(&(i + 1)) {
                    let g = (number(&self.turns[i + 1]["ctx"]) - number(&t["ctx"])).max(0.)
                        / array(&t["tools"]).len() as f64;
                    by[k]["ctx_growth"] = json!(number(&by[k]["ctx_growth"]) + g.floor());
                }
            }
        }
        merge(
            &mut sm,
            &json!({"turn_list":self.turns,"compaction_turns":self.compactions,"by_tool":by,"log":self.log,"cats":self.data["cats"],"plans":self.plans()}),
        );
        sm
    }
}
