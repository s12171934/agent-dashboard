use crate::{
    app::{App, orca_all},
    core::*,
    sessions::rx,
    terminals, vscode, worktrees,
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

pub fn build_report(set: &Value) -> Value {
    let tickets = array(&set["tickets"]);
    let mut jira = obj();
    let mut days: BTreeMap<String, u64> = BTreeMap::new();
    let mut repos = obj();
    let mut prs = HashSet::new();
    let mut lead = vec![];
    let mut starts = vec![];
    let mut rounds = 0;
    let mut reopened = vec![];
    for t in tickets {
        let st = jira_stage(t);
        jira[st] = json!(number(&jira[st]) + 1.);
        let q = &t["qa"];
        rounds += q["round"].as_u64().unwrap_or(0);
        if number(&q["round"]) > 1. {
            reopened.push(json!({"key":t["key"],"summary":t["summary"],"round":q["round"]}));
        }
        for r in array(&q["rounds"]) {
            if let Some(e) = epoch(text(r)) {
                starts.push(e);
                let day = text(r).get(..10).unwrap_or("").to_owned();
                *days.entry(day).or_default() += 1;
            }
        }
        if let Some(a) = array(&q["rounds"]).first().and_then(|v| epoch(text(v))) {
            let b = ["committed", "approved", "delivered", "cleaned"]
                .iter()
                .filter_map(|k| epoch(text(&q["at"][k])))
                .max_by(f64::total_cmp);
            if let Some(b) = b.filter(|b| *b >= a) {
                lead.push(json!({"key":t["key"],"summary":t["summary"],"hours":((b-a)/3600.*10.).round()/10.,"round":q["round"]}));
            }
        }
        for p in array(&q["prs"]) {
            prs.insert(text(p).to_owned());
        }
        for r in array(&t["repos"]) {
            if let Some(url) = r["pr"]["url"].as_str() {
                prs.insert(url.into());
            }
        }
    }
    for p in &prs {
        if let Some(c) = rx(r"/([^/]+)/pull/\d+").captures(p) {
            repos[&c[1]] = json!(number(&repos[&c[1]]) + 1.);
        }
    }
    lead.sort_by(|a, b| number(&b["hours"]).total_cmp(&number(&a["hours"])));
    let mut hs = lead.iter().map(|r| number(&r["hours"])).collect::<Vec<_>>();
    hs.sort_by(f64::total_cmp);
    reopened.sort_by(|a, b| number(&b["round"]).total_cmp(&number(&a["round"])));
    let begin = starts
        .into_iter()
        .min_by(f64::total_cmp)
        .and_then(|t| chrono::DateTime::from_timestamp(t as i64, 0))
        .map(|t| t.to_rfc3339());
    json!({"version":1,"written_at":iso(),"epic":set["epic"],"summary":set["summary"],"begin":begin,"end":set["retired_at"].as_str().map(str::to_owned).unwrap_or_else(iso),"tickets":tickets.len(),"jira":jira,"driven":tickets.iter().filter(|t|t["qa"].is_object()).count(),"ignored":tickets.iter().filter(|t|t["qa"]["ignored"]==true).count(),"rounds":rounds,"reopened":reopened.len(),"shipped":tickets.iter().filter(|t|!array(&t["qa"]["prs"]).is_empty()||matches!(text(&t["qa"]["stage"]),"delivered"|"cleaned")).count(),"lead":{"n":hs.len(),"median":hs.get(hs.len()/2),"longest":lead.into_iter().take(5).collect::<Vec<_>>()},"most_rounds":reopened.into_iter().take(5).collect::<Vec<_>>(),"days":days.into_iter().map(|(day,n)|json!({"day":day,"rounds":n})).collect::<Vec<_>>(),"prs":prs.len(),"repos":repos,"left":tickets.iter().filter(|t|jira_stage(t)!="qa").map(|t|json!({"key":t["key"],"summary":t["summary"],"status":t["status"]})).collect::<Vec<_>>(),"blocked":tickets.iter().filter(|t|t["qa"]["blocked"]==true).map(|t|&t["key"]).collect::<Vec<_>>()})
}
fn report_analysis(watch: &Path) -> Value {
    let md = fs::read_to_string(watch.join("report.md")).ok();
    let task = read_json(watch.join("report-task.json"));
    let mut out = json!({"md":md,"md_at":modified(watch.join("report.md")),"status":null,"at":task["at"],"error":null});
    if let Some(pid) = task["pid"].as_u64() {
        let alive = unsafe { libc::kill(pid as i32, 0) } == 0;
        if alive && task["exit"].is_null() {
            out["status"] = json!("running");
        } else {
            let done = task["exit"].as_i64().is_none_or(|c| c == 0)
                && out["md_at"]
                    .as_str()
                    .is_some_and(|mt| mt >= text(&task["at"]))
                && md
                    .as_ref()
                    .is_some_and(|s| !s.trim_start().starts_with("> 미완성"));
            out["status"] = json!(if done { "completed" } else { "failed" });
            if !done {
                out["error"] = json!(format!(
                    "보고서가 미완성이거나 새로 쓰이지 않았습니다 — {}",
                    watch.join("report.log").display()
                ));
            }
        }
    }
    out
}
fn report_start(app: &App, set: &Value) -> Result<()> {
    let watch = expand(text(&set["watch"]));
    let facts = if set["report"].is_object() {
        set["report"].clone()
    } else {
        build_report(set)
    };
    let prefs = app.state.read().unwrap().prefs.clone();
    let input = json!({"facts":facts,"tickets":array(&set["tickets"]).iter().map(|t|json!({"key":t["key"],"summary":t["summary"],"status":t["status"],"assignee":t["assignee"],"round":t["qa"]["round"],"ignored":t["qa"]["ignored"],"blocked_reason":t["qa"]["blocked_reason"],"notes":t["step"].as_str().into_iter().map(str::to_owned).chain(array(&t["notes"]).iter().filter_map(|n|n.as_str().map(str::to_owned))).collect::<Vec<_>>(),"prs":array(&t["qa"]["prs"]).iter().cloned().chain(array(&t["repos"]).iter().filter_map(|r|r["pr"].get("url").cloned())).collect::<Vec<_>>()})).collect::<Vec<_>>()});
    save_json(watch.join("report-input.json"), &input)?;
    let mut prompt = if let Some(p) = prefs["qa_report_prompt"].as_str() {
        fs::read_to_string(expand(p)).map_err(|e| e.to_string())?
    } else {
        include_str!("../assets/report-prompt.txt").into()
    };
    for (k, v) in [
        ("epic", text(&set["epic"]).to_owned()),
        ("summary", text(&set["summary"]).into()),
        ("out", watch.join("report.md").display().to_string()),
        (
            "input",
            watch.join("report-input.json").display().to_string(),
        ),
        ("watch", watch.display().to_string()),
        ("vault", app.config.vault.display().to_string()),
        (
            "project",
            app.config
                .vault
                .join(text(&set["project"]))
                .display()
                .to_string(),
        ),
    ] {
        prompt = prompt.replace(&format!("{{{{{k}}}}}"), &v);
    }
    let log = fs::File::create(watch.join("report.log")).map_err(|e| e.to_string())?;
    let mut cmd = std::process::Command::new("claude");
    cmd.args([
        "-p",
        &prompt,
        "--model",
        prefs["qa_report_model"].as_str().unwrap_or("opus"),
        "--permission-mode",
        "dontAsk",
        "--allowedTools",
        "Read",
        "Glob",
        "Grep",
        "Bash(gh pr view:*)",
        "Bash(gh api:*)",
        "Bash(ls:*)",
        &format!("Edit(/{}/**)", watch.display()),
        "--add-dir",
        app.config.vault.to_str().unwrap_or(""),
    ])
    .current_dir(&watch)
    .stdin(std::process::Stdio::null())
    .stdout(log.try_clone().map_err(|e| e.to_string())?)
    .stderr(log);
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let mut task = json!({"pid":child.id(),"at":iso()});
    save_json(watch.join("report-task.json"), &task)?;
    std::thread::spawn(move || {
        task["exit"] = json!(child.wait().ok().and_then(|s| s.code()).unwrap_or(1));
        let _ = save_json(watch.join("report-task.json"), &task);
    });
    Ok(())
}
fn qa_cli(app: &App, set: &Value, args: &[String]) -> Result<(i32, String)> {
    let prefs = app.state.read().unwrap().prefs.clone();
    let cli = expand(
        prefs["qa_driver"]
            .as_str()
            .unwrap_or("~/.claude/skills/qa-ticket-driver/bin/qa-driver"),
    );
    if !cli.is_file() {
        return Ok((
            127,
            format!(
                "qa-driver 가 없다: {} (prefs.json qa_driver)",
                cli.display()
            ),
        ));
    }
    let watch = expand(text(&set["watch"]));
    let mut a = vec![
        cli.display().to_string(),
        "--home".into(),
        watch.parent().unwrap_or(&watch).display().to_string(),
    ];
    a.push(args.first().ok_or("bad request")?.clone());
    a.push(text(&set["epic"]).into());
    a.extend(args.iter().skip(1).cloned());
    let (code, out, err) = command_full(
        "python3",
        &a.iter().map(String::as_str).collect::<Vec<_>>(),
        None,
        600,
        &[],
    )?;
    Ok((code, format!("{out}\n{err}").trim().into()))
}
pub fn qa_action(app: &App, what: &str, b: &Value) -> (u16, Value) {
    let error = |code, s: String| (code, json!({"error":s}));
    let epic = text(&b["epic"]);
    let action = text(&b["action"]);
    if !rx(r"^[A-Z][A-Z0-9]+-\d+$").is_match(epic) {
        return error(400, "bad request".into());
    }
    let set = app.state.read().unwrap().reviews["sets"]
        .as_array()
        .and_then(|a| a.iter().find(|s| s["epic"] == epic))
        .cloned();
    let Some(set) = set else {
        return error(404, "없는 QA 묶음입니다".into());
    };
    if what == "automation" {
        let id = text(&b["id"]);
        if !["enable", "disable", "run"].contains(&action)
            || !array(&set["automations"]).iter().any(|a| a["id"] == id)
        {
            return error(400, "이 묶음의 자동화가 아니거나 모르는 동작입니다".into());
        }
        let args = if action == "run" {
            vec!["automations", "run", id]
        } else {
            vec![
                "automations",
                "edit",
                id,
                if action == "enable" {
                    "--enabled"
                } else {
                    "--disabled"
                },
            ]
        };
        return match terminals::invoke(&args, 60) {
            Ok(_) => (200, json!({"ok":true})),
            Err(e) => error(502, e),
        };
    }
    if !set["watch"].is_string() {
        return error(409, "이 묶음에는 상태 디렉터리가 없습니다".into());
    }
    if action == "report" {
        if set["retired"] != true {
            return error(409, "종료된 QA 만 보고서를 씁니다".into());
        }
        if matches!(
            text(&report_analysis(&expand(text(&set["watch"])))["status"]),
            "running" | "launching"
        ) {
            return error(409, "보고서 워커가 이미 돌고 있습니다".into());
        }
        return match report_start(app, &set) {
            Ok(()) => (200, json!({"ok":true,"output":"보고서 워커를 띄웁니다"})),
            Err(e) => error(502, e),
        };
    }
    let keys = array(&set["tickets"])
        .iter()
        .map(|t| text(&t["key"]))
        .collect::<HashSet<_>>();
    let key = text(&b["key"]);
    let mut args: Vec<String> = match action {
        "close_finished" => {
            let ks = array(&b["keys"]);
            if ks.is_empty() || ks.iter().any(|k| !keys.contains(text(k))) {
                return error(400, "닫을 티켓 목록이 잘못됐습니다".into());
            }
            std::iter::once("close".into())
                .chain(ks.iter().map(|k| text(k).to_owned()))
                .collect()
        }
        "retire_check" => vec!["retire".into(), "--dry-run".into()],
        "retire" => vec!["retire".into()],
        "adopt_check" => vec!["adopt".into(), "--check".into()],
        "adopt" => {
            let mut a = vec!["adopt".into()];
            for (k, v) in b["set"].as_object().into_iter().flat_map(|o| o.iter()) {
                if !rx(r"^[A-Z][A-Z0-9_]*$").is_match(k) || !v.is_string() || text(v).contains('\n')
                {
                    return error(400, "이관 설정 값이 잘못됐습니다".into());
                }
                a.extend(["--set".into(), format!("{k}={}", text(v))]);
            }
            if let Some(id) = b["automation"].as_str() {
                if !array(&set["automations"]).iter().any(|a| a["id"] == id) {
                    return error(400, "이 묶음의 자동화가 아닙니다".into());
                }
                a.extend(["--automation".into(), id.into()]);
            }
            a
        }
        _ => {
            if !keys.contains(key) {
                return error(404, "묶음에 없는 티켓입니다".into());
            }
            match action {
                "approve" | "merge" => {
                    vec![action.into(), key.into(), "--by".into(), "대시보드".into()]
                }
                "cleanup_check" => vec!["cleanup".into(), key.into(), "--dry-run".into()],
                "cleanup" | "restart" | "close" | "ignore" => vec![action.into(), key.into()],
                "unignore" => vec!["ignore".into(), key.into(), "--undo".into()],
                _ => return error(400, "모르는 동작입니다".into()),
            }
        }
    };
    let _ = &mut args;
    match qa_cli(app, &set, &args) {
        Ok((code, output)) => (
            if code == 0 || code == 3 { 200 } else { 502 },
            json!({"ok":code==0,"code":code,"output":output}),
        ),
        Err(e) => error(if e.contains("timed out") { 504 } else { 502 }, e),
    }
}
fn ship_start(app: &App, t: &Value, qs: &Value) -> Result<()> {
    let prefs = app.state.read().unwrap().prefs.clone();
    let key = text(&t["key"]);
    let epic = text(&qs["epic"]);
    let template = expand(text(&prefs["ship_prompt"]));
    let mut spec = fs::read_to_string(template).map_err(|e| e.to_string())?;
    let repos=array(&t["repos"]).iter().map(|r|format!("- {} — 워크트리 `{}`, 브랜치 `{}`, 베이스 `{}` ({}), PR {} ({}), 앞선 커밋 {} · 뒤처진 커밋 {} · 미커밋 {}",text(&r["repo"]),text(&r["path"]),text(&r["branch"]),text(&r["base"]),text(&r["base_src"]),r["pr"]["url"].as_str().unwrap_or("없음"),text(&r["pr"]["state"]),r["ahead"],r["behind"],r["dirty"])).collect::<Vec<_>>().join("\n");
    for (k, v) in [
        ("key", key.into()),
        ("summary", text(&t["summary"]).into()),
        (
            "jira_url",
            format!("{}/browse/{key}", text(&prefs["jira_site"])),
        ),
        ("jira_status", text(&t["status"]).into()),
        ("assignee", t["assignee"].as_str().unwrap_or("없음").into()),
        ("epic", epic.into()),
        (
            "project",
            app.config
                .vault
                .join(text(&qs["project"]))
                .display()
                .to_string(),
        ),
        ("vault", app.config.vault.display().to_string()),
        ("step_note", t["step"].as_str().unwrap_or("없음").into()),
        (
            "notes",
            array(&t["notes"])
                .iter()
                .map(text)
                .collect::<Vec<_>>()
                .join(", "),
        ),
        ("repos", repos),
    ] {
        spec = spec.replace(&format!("{{{{{k}}}}}"), &v);
    }
    let objective = format!("{epic} 티켓 반출 (대시보드)");
    let runs = orca_all("runs", &["orchestration", "run-list"])?;
    let rid = if let Some(r) = runs.iter().find(|r| r["objective"] == objective) {
        text(&r["id"]).to_owned()
    } else {
        let r = terminals::invoke(
            &["orchestration", "run-create", "--objective", &objective],
            30,
        )?;
        text(&r["run"]["id"]).to_owned()
    };
    let r = terminals::invoke(
        &[
            "orchestration",
            "worker-start",
            "--run",
            &rid,
            "--spec",
            &spec,
            "--task-title",
            &format!("{key} 반출"),
            "--worktree",
            &format!("path:{}", expand(text(&qs["ship_place"])).display()),
            "--agent",
            prefs["ship_agent"].as_str().unwrap_or("claude"),
            "--model",
            prefs["ship_model"].as_str().unwrap_or("opus"),
        ],
        240,
    )?;
    let h = r["agentTerminalHandle"]
        .as_str()
        .or(r["startupTerminal"]["handle"].as_str());
    if let Some(h) = h {
        let _ = orca(&[
            "terminal",
            "rename",
            "--terminal",
            h,
            "--title",
            &format!("{key} 반출"),
        ]);
    }
    app.state.write().unwrap().ship_jobs[key] =
        json!({"status":"dispatched","task_id":r["taskId"],"run_id":rid,"at":iso()});
    Ok(())
}
pub fn action(app: &App, action: &str, b: &Value, local: bool) -> (u16, Value) {
    let error = |code, s: String| (code, json!({"error":s}));
    let key = text(&b["key"]);
    if !rx(r"^[A-Z][A-Z0-9]+-\d+$").is_match(key) || b.get("done").is_some_and(|v| !v.is_boolean())
    {
        return error(400, "bad request".into());
    }
    let (set, t) = {
        let s = app.state.read().unwrap();
        let hit = array(&s.reviews["sets"]).iter().find_map(|st| {
            array(&st["tickets"])
                .iter()
                .find(|t| t["key"] == key)
                .map(|t| (st.clone(), t.clone()))
        });
        let Some(hit) = hit else {
            return error(404, "묶음에 없는 티켓입니다".into());
        };
        hit
    };
    if array(&t["repos"]).is_empty() {
        return error(409, "이 티켓의 워크트리가 없습니다".into());
    }
    if ["open", "web"].contains(&action) {
        if !local {
            return error(403, "에디터 열기는 이 맥에서 연 화면에서만 됩니다".into());
        }
        if action == "web" {
            if let Err(e) = vscode::ensure(app) {
                return error(502, e);
            }
            return (
                200,
                json!({"repos":array(&t["repos"]).iter().map(|r|json!({"repo":r["repo"],"path":r["path"],"url":vscode::url(app,text(&r["path"]))})).collect::<Vec<_>>() }),
            );
        }
        for r in array(&t["repos"]) {
            if let Err(e) = worktrees::open_editor(text(&r["path"]), text(&b["editor"]), true) {
                return error(502, e);
            }
        }
        return (200, json!({"ok":true}));
    }
    if action == "ship" {
        let prefs = app.state.read().unwrap().prefs.clone();
        let qs = array(&prefs["qa_sets"])
            .iter()
            .find(|s| s["epic"] == set["epic"])
            .cloned()
            .unwrap_or(Value::Null);
        if !expand(text(&prefs["ship_prompt"])).is_file() || !qs["ship_place"].is_string() {
            return error(
                409,
                "prefs.json 의 ship_prompt 또는 ship_place 가 없습니다".into(),
            );
        }
        if jira_stage(&t) != "prog" {
            return error(409, "진행 중인 Jira 티켓만 반출할 수 있습니다".into());
        }
        let mut s = app.state.write().unwrap();
        if matches!(
            text(&s.ship_jobs[key]["status"]),
            "launching" | "dispatched"
        ) {
            return error(409, "이미 반출 중입니다".into());
        }
        s.ship_jobs[key] = json!({"status":"launching","at":iso(),"error":null});
        drop(s);
        let a = app.clone();
        let key = key.to_owned();
        std::thread::spawn(move || {
            if let Err(e) = ship_start(&a, &t, &qs) {
                a.state.write().unwrap().ship_jobs[&key] =
                    json!({"status":"launch_failed","at":iso(),"error":e});
            }
        });
        return (202, json!({"ok":true}));
    }
    if action != "mark" {
        return error(400, "bad request".into());
    }
    let done = b["done"] != false;
    let stage = text(&t["qa"]["stage"]);
    if done
        && set["driver"] == true
        && STAGES
            .iter()
            .position(|k| *k == stage)
            .is_some_and(|i| i < 5)
    {
        return error(
            409,
            "코디네이터가 커밋(ready/)하기 전이라 아직 리뷰할 수 없습니다".into(),
        );
    }
    let mut shas = obj();
    for r in array(&t["repos"]) {
        match git(
            Path::new(text(&r["path"])),
            &["rev-parse", "--short=9", "HEAD"],
        ) {
            Ok(s) => shas[text(&r["repo"])] = json!(s),
            Err(e) => return error(502, e),
        }
    }
    let Some(step) = t["step"].as_str() else {
        return error(409, "스텝 노트가 없습니다".into());
    };
    if let Err(e) = write_review(
        Path::new(step),
        done.then_some(&shas),
        if done {
            t["qa"]["round"].as_u64()
        } else {
            None
        },
    ) {
        return error(500, format!("스텝 노트 기록 실패: {e}"));
    }
    let mut approve = None;
    if done && stage == "committed" && set["driver"] == true {
        match qa_cli(
            app,
            &set,
            &[
                "approve".into(),
                key.into(),
                "--by".into(),
                "대시보드 리뷰 완료".into(),
            ],
        ) {
            Ok((0, out)) => approve = Some(out),
            Ok((_, e)) | Err(e) => {
                return error(502, format!("리뷰는 기록했지만 반출 승인 실패: {e}"));
            }
        }
    }
    let mut s = app.state.write().unwrap();
    if let Some(sets) = s.reviews["sets"].as_array_mut() {
        for set in sets {
            for t in set["tickets"].as_array_mut().unwrap() {
                if t["key"] == key {
                    merge(
                        t,
                        &json!({"review":if done{"done"}else{"pending"},"review_sha":if done{shas.clone()}else{obj()},"review_round":if done{t["qa"]["round"].clone()}else{Value::Null},"review_at":if done{json!(chrono::Local::now().date_naive().to_string())}else{Value::Null}}),
                    );
                }
            }
        }
    }
    (
        200,
        json!({"ok":true,"review_sha":if done{shas}else{obj()},"approved":approve.is_some(),"output":approve}),
    )
}
pub const STAGES: [&str; 9] = [
    "selected",
    "worktree",
    "analysis",
    "implementing",
    "reviewing",
    "committed",
    "approved",
    "delivered",
    "cleaned",
];
fn cached(key: String, ttl: f64, f: impl FnOnce() -> Result<Value>) -> Result<Value> {
    static CACHE: OnceLock<Mutex<HashMap<String, (f64, Value)>>> = OnceLock::new();
    let c = CACHE.get_or_init(Default::default);
    if let Some((_, v)) = c.lock().unwrap().get(&key).filter(|(t, _)| now() - t < ttl) {
        return Ok(v.clone());
    }
    let v = f()?;
    c.lock().unwrap().insert(key, (now(), v.clone()));
    Ok(v)
}
fn modified(p: impl AsRef<Path>) -> Value {
    let t = mtime(p);
    if t > 0. {
        json!(
            chrono::DateTime::from_timestamp(t as i64, 0)
                .unwrap()
                .to_rfc3339()
        )
    } else {
        Value::Null
    }
}
pub fn jira_stage(t: &Value) -> &'static str {
    let s = text(&t["status"]).split_whitespace().collect::<String>();
    if rx(r"(?i)hold|홀딩|보류").is_match(&s) {
        "hold"
    } else if s.contains("QA준비") {
        "ready"
    } else if s.contains("개발완료") {
        "dev"
    } else if s.contains("QA완료") || t["cat"] == "done" {
        "qa"
    } else if t["cat"] == "new" {
        "todo"
    } else {
        "prog"
    }
}
fn jira_get(prefs: &Value, path: &str, query: &[(&str, String)]) -> Result<Value> {
    let site = text(&prefs["jira_site"]).trim_end_matches('/');
    let email = text(&prefs["jira_email"]);
    let token = std::env::var("ATLASSIAN_API_TOKEN")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            command(
                "/bin/zsh",
                &["-ic", "print -r -- $ATLASSIAN_API_TOKEN"],
                None,
                15,
            )
            .unwrap_or_default()
            .lines()
            .last()
            .unwrap_or("")
            .trim()
            .to_owned()
        });
    if site.is_empty() || email.is_empty() || token.is_empty() {
        return Err(
            "Jira 설정 없음 (prefs.json jira_site · jira_email, ATLASSIAN_API_TOKEN)".into(),
        );
    }
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?
        .get(format!("{site}/rest/api/3/{path}"))
        .query(query)
        .basic_auth(email, Some(token))
        .header("Accept", "application/json")
        .send()
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.json())
        .map_err(|e| format!("Jira: {e}"))
}
fn jira_epic(prefs: &Value, epic: &str) -> Result<Value> {
    cached(
        format!("jira:{}:{epic}", text(&prefs["jira_site"])),
        300.,
        || {
            let e = jira_get(
                prefs,
                &format!("issue/{epic}"),
                &[("fields", "summary".into())],
            )?;
            let mut tickets = vec![];
            let mut next = String::new();
            for _ in 0..100 {
                let mut q = vec![
                    ("jql", format!("parent = {epic} ORDER BY key")),
                    ("fields", "summary,status,assignee".into()),
                    ("maxResults", "100".into()),
                ];
                if !next.is_empty() {
                    q.push(("nextPageToken", next.clone()));
                }
                let d = jira_get(prefs, "search/jql", &q)?;
                for i in array(&d["issues"]) {
                    let f = &i["fields"];
                    tickets.push(json!({"key":i["key"],"summary":f["summary"],"status":f["status"]["name"],"cat":f["status"]["statusCategory"]["key"],"assignee":f["assignee"]["displayName"]}));
                }
                let nxt = text(&d["nextPageToken"]);
                if nxt.is_empty() || nxt == next || d["isLast"] == true {
                    break;
                }
                next = nxt.into();
            }
            Ok(json!({"summary":e["fields"]["summary"],"tickets":tickets}))
        },
    )
}
pub fn note_review(path: &Path) -> Value {
    let s = fs::read_to_string(path).unwrap_or_default();
    let fm = rx(r"(?s)^---\n(.*?)\n---")
        .captures(&s)
        .map(|c| c[1].to_owned())
        .unwrap_or_default();
    let mut out =
        json!({"status":null,"review":null,"review_sha":{},"review_at":null,"review_round":null});
    let mut sub = false;
    for ln in fm.lines() {
        if sub && ln.starts_with(char::is_whitespace) {
            if let Some((k, v)) = ln.trim().split_once(':') {
                out["review_sha"][k.trim()] = json!(v.trim().trim_matches(['\'', '"']));
            }
            continue;
        }
        sub = false;
        let (k, v) = ln.split_once(':').unwrap_or((ln, ""));
        if k == "review_sha" {
            sub = true;
        } else if ["status", "review", "review_at", "review_round"].contains(&k)
            && !v.trim().is_empty()
        {
            out[k] = json!(v.trim());
        }
    }
    out
}
pub fn write_review(path: &Path, shas: Option<&Value>, round: Option<u64>) -> Result<()> {
    let s = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let m = rx(r"(?s)^---\n(.*?)\n---\n")
        .captures(&s)
        .ok_or("frontmatter 없음")?;
    let mut keep = vec![];
    let mut skip = false;
    for ln in m[1].lines() {
        if skip && ln.starts_with(char::is_whitespace) {
            continue;
        }
        skip = rx(r"^(review|review_sha|review_at|review_round):").is_match(ln);
        if !skip {
            keep.push(ln.to_owned());
        }
    }
    if let Some(shas) = shas {
        keep.extend(["review: done".into(), "review_sha:".into()]);
        let mut entries = shas
            .as_object()
            .into_iter()
            .flat_map(|o| o.iter())
            .collect::<Vec<_>>();
        entries.sort_by_key(|(k, _)| *k);
        for (k, v) in entries {
            keep.push(format!("  {k}: \"{}\"", text(v)));
        }
        keep.push(format!("review_at: {}", chrono::Local::now().date_naive()));
        if let Some(n) = round {
            keep.push(format!("review_round: {n}"));
        }
    }
    let text = format!(
        "---\n{}\n---\n{}",
        keep.join("\n"),
        &s[m.get(0).unwrap().end()..]
    );
    let tmp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    fs::write(&tmp, text)
        .and_then(|_| fs::rename(&tmp, path))
        .map_err(|e| e.to_string())
}
fn signals(watch: &Path, kind: &str, key: &str) -> Vec<String> {
    let re = rx(&format!(r"^{}(?:-[^.]+)?(?:\.md)?$", regex::escape(key)));
    let mut out = fs::read_dir(watch.join(kind))
        .map(|ds| {
            ds.flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|s| re.is_match(s))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    out.sort();
    out
}
pub fn qa_ticket(watch: &Path, key: &str) -> Value {
    let claims = fs::read_to_string(watch.join("claimed").join(key))
        .unwrap_or_default()
        .lines()
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.split('\t').map(str::to_owned).collect::<Vec<_>>())
        .collect::<Vec<_>>();
    if claims.is_empty() {
        return Value::Null;
    }
    let rec = read_json(watch.join("tickets").join(format!("{key}.json")));
    let hand = signals(watch, "handoffs", key)
        .into_iter()
        .filter(|s| !s.ends_with("-deliver.md"))
        .collect::<Vec<_>>();
    let done = signals(watch, "done", key);
    let has = |kind: &str| watch.join(kind).join(format!("{key}.md")).exists();
    let stage = if watch.join("cleaned").join(key).exists() {
        "cleaned"
    } else if has("delivered") {
        "delivered"
    } else if has("approved") {
        "approved"
    } else if has("ready") {
        "committed"
    } else if !hand.is_empty() && done.len() >= hand.len() {
        "reviewing"
    } else if !hand.is_empty() {
        "implementing"
    } else if rec["coordinator"].is_object() || rec["driver"] != true && !claims.is_empty() {
        "analysis"
    } else if rec["worktree"].is_object() {
        "worktree"
    } else {
        "selected"
    };
    let blocked = signals(watch, "blocked", key)
        .into_iter()
        .filter(|f| {
            stage != "cleaned"
                || mtime(watch.join("blocked").join(f)) > mtime(watch.join("cleaned").join(key))
        })
        .collect::<Vec<_>>();
    let reason = blocked
        .first()
        .and_then(|f| fs::read_to_string(watch.join("blocked").join(f)).ok())
        .and_then(|s| s.lines().nth(2).map(str::to_owned));
    let prs = fs::read_to_string(watch.join("delivered").join(format!("{key}.md")))
        .map(|s| {
            rx(r"https://\S+/pull/\d+")
                .find_iter(&s)
                .map(|m| m.as_str().to_owned())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let coord = rec["coordinator"]["handle"]
        .as_str()
        .map(str::to_owned)
        .or_else(|| claims.last().and_then(|c| c.get(2)).cloned());
    let workers = rec["workers"]
        .as_object()
        .into_iter()
        .flat_map(|o| o.iter())
        .map(|(name, w)| {
            let mut w = w.clone();
            w["name"] = json!(name);
            w
        })
        .collect::<Vec<_>>();
    let mut all = claims
        .iter()
        .filter_map(|c| c.get(2))
        .cloned()
        .chain(coord.clone())
        .chain(
            workers
                .iter()
                .filter_map(|w| w["handle"].as_str().map(str::to_owned)),
        )
        .collect::<Vec<_>>();
    let mut seen = HashSet::new();
    all.retain(|h| seen.insert(h.clone()));
    let mut links = obj();
    for w in &workers {
        if let Some(h) = w["handle"].as_str() {
            let parent = claims
                .iter()
                .rev()
                .find(|c| c.len() > 2 && c[0].as_str() <= text(&w["at"]))
                .and_then(|c| c.get(2))
                .cloned()
                .or(coord.clone());
            links[h] = json!(parent);
        }
    }
    let first = |kind: &str, names: &[String]| {
        names
            .iter()
            .map(|n| modified(watch.join(kind).join(n)))
            .filter(|v| v.is_string())
            .min_by(|a, b| text(a).cmp(text(b)))
    };
    json!({"stage":stage,"stage_no":STAGES.iter().position(|k|*k==stage).unwrap()+1,"blocked":!blocked.is_empty(),"blocked_reason":reason,"ignored":watch.join("ignored").join(key).exists(),"round":claims.len(),"coordinator":coord,"workers":workers,"worktree":rec["worktree"]["path"],"at":{"selected":claims.last().and_then(|c|c.first()),"worktree":rec["worktree"]["created_at"],"analysis":rec["coordinator"]["at"].as_str().map(str::to_owned).or_else(||claims.last().and_then(|c|c.first()).cloned()),"implementing":first("handoffs",&hand),"reviewing":done.iter().map(|n|modified(watch.join("done").join(n))).max_by(|a,b|text(a).cmp(text(b))),"committed":modified(watch.join("ready").join(format!("{key}.md"))),"approved":modified(watch.join("approved").join(format!("{key}.md"))),"delivered":modified(watch.join("delivered").join(format!("{key}.md"))),"cleaned":modified(watch.join("cleaned").join(key))},"prs":prs,"handoffs":hand.len(),"done":done.len(),"driver":rec["driver"]==true,"merge_at":modified(watch.join("merge").join(format!("{key}.md"))),"rounds":claims.iter().map(|c|c.get(1).and_then(|s|s.parse::<i64>().ok()).and_then(|t|chrono::DateTime::from_timestamp(t,0)).map(|d|d.to_rfc3339()).unwrap_or_else(||c[0].clone())).collect::<Vec<_>>(),"links":links,"handles":all})
}
fn project_notes(
    app: &App,
    project: &str,
    prefix: &str,
) -> HashMap<String, (PathBuf, Vec<PathBuf>)> {
    let root = app.config.vault.join(project);
    let prog = read_json(root.join("progress.json"));
    let key = |s: &str| {
        rx(r"[A-Z][A-Z0-9]+-\d+")
            .find_iter(s)
            .map(|m| m.as_str().to_owned())
            .find(|k| k.starts_with(prefix))
    };
    let mut out = HashMap::new();
    for st in array(&prog["stages"]) {
        for sp in array(&st["steps"]) {
            if let Some(k) = key(text(&sp["path"])) {
                out.entry(k)
                    .or_insert((root.join(text(&sp["path"])), vec![]));
            }
        }
    }
    for p in files(root, "md") {
        if let Some(k) = key(p.file_name().unwrap_or_default().to_string_lossy().as_ref()) {
            if let Some((step, notes)) = out.get_mut(&k) {
                if *step != p {
                    notes.push(p);
                }
            }
        }
    }
    out
}
fn repo(path: &str, name: &str, prefs: &Value) -> Value {
    let p = Path::new(path);
    let branch = git(p, &["branch", "--show-current"]).unwrap_or_default();
    let head = git(p, &["rev-parse", "HEAD"]).ok();
    let pr = cached(format!("pr:{path}:{branch}"), 600., || {
        let d = command(
            "gh",
            &[
                "pr",
                "list",
                "--head",
                &branch,
                "--state",
                "all",
                "--limit",
                "1",
                "--json",
                "number,url,state,baseRefName",
            ],
            Some(p),
            20,
        )?;
        let d = serde_json::from_str::<Value>(&d).map_err(|e| e.to_string())?;
        Ok(d[0].clone())
    })
    .unwrap_or(Value::Null);
    let base = pr["baseRefName"]
        .as_str()
        .or(prefs["review_bases"][name].as_str())
        .unwrap_or("main");
    let base_ref = [format!("origin/{base}"), base.into()]
        .into_iter()
        .find(|b| git(p, &["rev-parse", "--verify", "--quiet", b]).is_ok());
    let mut stats = obj();
    if let Some(base_ref) = &base_ref {
        let diff = format!("{base_ref}...HEAD");
        let counts = git(p, &["rev-list", "--left-right", "--count", &diff]).unwrap_or_default();
        let nums = counts
            .split_whitespace()
            .filter_map(|s| s.parse::<u64>().ok())
            .collect::<Vec<_>>();
        let ss = git(p, &["diff", "--shortstat", &diff]).unwrap_or_default();
        let n = |pat: &str| {
            rx(pat)
                .captures(&ss)
                .and_then(|c| c[1].parse::<u64>().ok())
                .unwrap_or(0)
        };
        stats = json!({"behind":nums.first(),"ahead":nums.get(1),"files":n(r"(\d+) files? changed"),"ins":n(r"(\d+) insertions?"),"dels":n(r"(\d+) deletions?")});
    }
    let mut r = json!({"repo":name,"path":path,"branch":branch,"name":null,"comment":null,"head":head,"base":base,"base_ref":base_ref,"base_src":if !pr.is_null(){"PR"}else if prefs["review_bases"][name].is_string(){"설정"}else{"기본"},"pr":pr,"dirty":git(p,&["status","--porcelain"]).ok().map(|s|s.lines().count())});
    merge(&mut r, &stats);
    r
}
pub fn collect(app: &App) -> Result<()> {
    let (prefs, old, orca_state, test_history, tests) = {
        let s = app.state.read().unwrap();
        (
            s.prefs.clone(),
            s.reviews.clone(),
            s.orca.clone(),
            s.test_history.clone(),
            s.tests.clone(),
        )
    };
    if array(&prefs["qa_sets"]).is_empty() {
        return Ok(());
    }
    let worktrees = orca(&["worktree", "list"])?;
    let automations = cached("review-automations".into(), 60., || {
        orca(&["automations", "list"])
    })
    .unwrap_or(Value::Null);
    let mut sets = vec![];
    let mut gone = read_json(app.config.data.join("review-gone.json"));
    if !gone.is_object() {
        gone = obj();
    }
    for qs in array(&prefs["qa_sets"]) {
        let epic = text(&qs["epic"]);
        let project = text(&qs["project"]);
        let data = jira_epic(&prefs, epic);
        let (error, data) = match data {
            Ok(d) => (Value::Null, d),
            Err(e) => {
                let old = array(&old["sets"]).iter().find(|s| s["epic"] == epic);
                (
                    json!(e),
                    json!({"summary":old.map(|s|&s["summary"]),"tickets":old.map(|s|s["tickets"].clone()).unwrap_or(json!([]))}),
                )
            }
        };
        let notes = project_notes(
            app,
            project,
            &format!("{}-", epic.split('-').next().unwrap_or("")),
        );
        let watch = expand(text(&qs["watch"]));
        let driver = watch.join("tickets").is_dir();
        let mut tickets = vec![];
        for child in array(&data["tickets"]) {
            let key = text(&child["key"]);
            let qa = qa_ticket(&watch, key);
            let mut paths = vec![];
            if let Some(wt) = qa["worktree"].as_str().filter(|p| Path::new(p).is_dir()) {
                let subs = git(
                    Path::new(wt),
                    &[
                        "config",
                        "--file",
                        ".gitmodules",
                        "--get-regexp",
                        r"^submodule\..*\.path$",
                    ],
                )
                .unwrap_or_default();
                for ln in subs.lines() {
                    if let Some(sub) = ln.split_whitespace().last() {
                        let p = Path::new(wt).join(sub);
                        if p.join(".git").exists()
                            && git(&p, &["branch", "--show-current"]).is_ok_and(|s| !s.is_empty())
                        {
                            paths.push((
                                p.display().to_string(),
                                Path::new(sub)
                                    .file_name()
                                    .unwrap_or_default()
                                    .to_string_lossy()
                                    .into_owned(),
                            ));
                        }
                    }
                }
                if paths.is_empty() && !Path::new(wt).join(".gitmodules").is_file() {
                    paths.push((
                        wt.into(),
                        Path::new(wt)
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .into_owned(),
                    ));
                }
            } else {
                for w in array(&worktrees["worktrees"]) {
                    let p = text(&w["path"]);
                    if w["isMainWorktree"] == true
                        || w["isArchived"] == true
                        || !Path::new(p).is_dir()
                        || !rx(&format!(
                            r"(?:^|[^A-Za-z0-9]){}(?:$|[^0-9])",
                            regex::escape(key)
                        ))
                        .is_match(
                            Path::new(p)
                                .file_name()
                                .unwrap_or_default()
                                .to_string_lossy()
                                .as_ref(),
                        )
                    {
                        continue;
                    }
                    let main = array(&worktrees["worktrees"])
                        .iter()
                        .find(|m| m["repoId"] == w["repoId"] && m["isMainWorktree"] == true);
                    let name = main
                        .and_then(|m| Path::new(text(&m["path"])).file_name())
                        .or_else(|| Path::new(p).parent().and_then(|p| p.file_name()))
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned();
                    paths.push((p.into(), name));
                }
            }
            let mut repos = paths
                .iter()
                .map(|(p, n)| repo(p, n, &prefs))
                .collect::<Vec<_>>();
            repos.sort_by_key(|r| {
                (
                    array(&prefs["review_first"])
                        .iter()
                        .position(|n| *n == r["repo"])
                        .unwrap_or(usize::MAX),
                    text(&r["repo"]).to_owned(),
                )
            });
            let note = notes.get(key);
            let fm = note.map(|(p, _)| note_review(p)).unwrap_or_else(obj);
            let reopened = qa["round"].as_u64().unwrap_or(0)
                > fm["review_round"]
                    .as_str()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or_else(|| qa["round"].as_u64().unwrap_or(0));
            let review = if repos.is_empty() {
                "none"
            } else if fm["review"] != "done" {
                "pending"
            } else if reopened {
                "reopened"
            } else {
                "done"
            };
            let test = test_history
                .as_object()
                .into_iter()
                .flat_map(|m| m.values())
                .chain(array(&tests["files"]).iter())
                .filter(|r| {
                    ["key", "label", "owner"]
                        .iter()
                        .any(|k| text(&r[k]).contains(key))
                })
                .max_by_key(|r| {
                    r["finished_at"]
                        .as_str()
                        .or(r["updated_at"].as_str())
                        .or(r["started_at"].as_str())
                        .unwrap_or("")
                })
                .cloned();
            let mut known = gone[key].clone();
            if !known.is_object() {
                known = obj();
            }
            let live = repos
                .iter()
                .filter_map(|r| r["pr"]["url"].as_str())
                .collect::<HashSet<_>>();
            for r in &repos {
                if let Some(url) = r["pr"]["url"].as_str() {
                    known[url] = json!({"repo":r["repo"],"branch":r["branch"]});
                }
            }
            for p in array(&qa["prs"]) {
                if known[text(p)].is_null() {
                    known[text(p)] = obj();
                }
            }
            gone[key] = known.clone();
            let mut gone_rows = vec![];
            for (url, meta) in known.as_object().unwrap() {
                if live.contains(url.as_str()) {
                    continue;
                }
                let pr=cached(format!("gone:{url}"),600.,||{let s=command("gh",&["pr","view",url,"--json","number,url,state,baseRefName,headRefName,additions,deletions,changedFiles,mergedAt"],None,20)?;serde_json::from_str(&s).map_err(|e|e.to_string())}).unwrap_or(Value::Null);
                let parts = url.split('/').collect::<Vec<_>>();
                gone_rows.push(json!({"repo":meta["repo"].as_str().unwrap_or_else(||parts.get(parts.len().saturating_sub(3)).unwrap_or(&"?")),"branch":meta["branch"].as_str().or(pr["headRefName"].as_str()).unwrap_or(""),"pr":{"number":pr["number"].as_u64().or_else(||parts.last().and_then(|s|s.parse().ok())),"url":url,"state":pr["state"]},"base":pr["baseRefName"],"merged_at":pr["mergedAt"],"files":pr["changedFiles"],"ins":pr["additions"],"dels":pr["deletions"]}));
            }
            let mut t = child.clone();
            merge(
                &mut t,
                &json!({"repos":repos,"gone":gone_rows,"review":review,"review_at":fm["review_at"],"review_sha":fm["review_sha"],"review_round":fm["review_round"],"step":note.map(|n|&n.0),"step_status":fm["status"],"notes":note.map(|n|&n.1),"test":test,"ship":app.state.read().unwrap().ship_jobs[key],"qa":qa}),
            );
            if let Some(q) = t["qa"].as_object_mut() {
                q.insert(
                    "live".into(),
                    json!(
                        array(&qa["handles"])
                            .iter()
                            .filter(|h| array(&orca_state["terminals"])
                                .iter()
                                .any(|t| t["handle"] == **h && t["connected"] == true))
                            .collect::<Vec<_>>()
                    ),
                );
            }
            tickets.push(t);
        }
        let autos=array(&automations["automations"]).iter().filter(|a|format!("{} {} {}",text(&a["name"]),text(&a["prompt"]),text(&a["precheck"]["command"])).contains(epic)).map(|a|json!({"id":a["id"],"name":a["name"],"enabled":a["enabled"],"rrule":a["rrule"],"driver":text(&a["prompt"]).contains("qa-driver"),"next":a["nextRunAt"],"last":a["lastRunAt"],"runs":[]})).collect::<Vec<_>>();
        let mut config = obj();
        for ln in fs::read_to_string(watch.join("config.env"))
            .unwrap_or_default()
            .lines()
        {
            if let Some((k, v)) = ln.split_once('=') {
                if !k.trim().starts_with('#') {
                    config[k.trim()] = json!(
                        shell_words::split(v)
                            .ok()
                            .and_then(|v| v.first().cloned())
                            .unwrap_or_default()
                    );
                }
            }
        }
        let sheet = read_json(app.config.data.join("qa-sheets.json"))[epic].clone();
        let mut set = json!({"epic":epic,"summary":data["summary"],"project":project,"error":error,"tickets":tickets,"stray":[],"watch":qs["watch"],"driver":driver,"coord_worktree":config["QA_COORD_WORKTREE"],"retired":watch.join("retired").exists(),"retired_at":modified(watch.join("retired")),"finished":!tickets.is_empty()&&tickets.iter().all(|t|jira_stage(t)=="qa"),"sheet":if sheet.is_object(){let mut s=sheet;s["url"]=qs["sheet"].clone();s}else if qs["sheet"].is_string(){json!({"url":qs["sheet"]})}else{Value::Null},"stages":STAGES,"automations":autos,"adopted":autos.iter().any(|a|a["driver"]==true),"report":null,"analysis":null});
        if set["retired"] == true {
            let mut report = read_json(watch.join("report.json"));
            if !report.is_object() {
                report = build_report(&set);
                save_json(watch.join("report.json"), &report)?;
            }
            set["report"] = report;
            set["analysis"] = report_analysis(&watch);
            if set["analysis"]["md"].is_null() && !watch.join("report-task.json").exists() {
                let a = app.clone();
                let st = set.clone();
                std::thread::spawn(move || {
                    let _ = report_start(&a, &st);
                });
            }
        }
        sets.push(set);
    }
    save_json(app.config.data.join("review-gone.json"), &gone)?;
    app.state.write().unwrap().reviews =
        json!({"sets":sets,"updated":iso(),"jira":prefs["jira_site"]});
    Ok(())
}
