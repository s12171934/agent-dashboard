use crate::{cli, core::*, sessions::rx, test_runs};
use fs2::FileExt;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
fn dir() -> PathBuf {
    cli::env("ATEST_DIR")
        .map(PathBuf::from)
        .unwrap_or("/private/tmp/agent-test-progress".into())
}
fn current() -> PathBuf {
    dir().join(format!(
        ".cur-{}",
        rx(r"[^\w.-]").replace_all(&cli::identity(), "_")
    ))
}
fn new_key(kind: &str) -> String {
    format!(
        "{kind}-{}-{}",
        chrono::Local::now().format("%m%d-%H%M%S"),
        std::process::id()
    )
}
pub struct Progress {
    pub key: String,
    pub data: Value,
    pub cases: Vec<(String, Value)>,
    open_ended: bool,
}
impl Progress {
    fn new(key: String, fields: Value) -> Self {
        let mut d = json!({"phase":"running","started_at":iso(),"owner":cli::env("ATEST_OWNER"),"terminal":cli::env("ORCA_TERMINAL_HANDLE"),"session_id":cli::env("CLAUDE_CODE_SESSION_ID").or_else(||cli::env("CODEX_THREAD_ID"))});
        merge(&mut d, &fields);
        Self {
            key,
            data: d,
            cases: vec![],
            open_ended: false,
        }
    }
    fn load(key: &str) -> Result<Self> {
        let mut d = read_json(dir().join(format!("{key}.json")));
        if !d.is_object() {
            return Err(format!("no run '{key}' (atest start first)"));
        }
        let cases = d
            .as_object_mut()
            .unwrap()
            .remove("cases")
            .unwrap_or(json!([]));
        Ok(Self {
            key: key.into(),
            data: d,
            cases: array(&cases)
                .iter()
                .map(|c| (text(&c["id"]).to_owned(), c.clone()))
                .collect(),
            open_ended: false,
        })
    }
    fn case(
        &mut self,
        key: &str,
        id: Option<&str>,
        title: Option<&str>,
        status: Option<&str>,
        msg: Option<&str>,
        ms: Option<f64>,
    ) {
        let i = self
            .cases
            .iter()
            .position(|(k, _)| k == key)
            .unwrap_or_else(|| {
                self.cases.push((
                    key.into(),
                    json!({"id":id.unwrap_or(key),"title":title.unwrap_or(""),"status":"queued"}),
                ));
                self.cases.len() - 1
            });
        let c = &mut self.cases[i].1;
        if let Some(v) = title {
            c["title"] = json!(v);
        }
        if let Some(v) = status {
            c["status"] = json!(v);
        }
        if let Some(v) = msg {
            c["msg"] = json!(v);
        }
        if let Some(v) = ms {
            c["ms"] = json!(v);
        }
        if status == Some("running") {
            c["t0"] = json!(now());
        } else if status.is_some() {
            if let Some(t0) = c
                .as_object_mut()
                .unwrap()
                .remove("t0")
                .and_then(|v| v.as_f64())
            {
                if ms.is_none() {
                    c["ms"] = json!(((now() - t0) * 1000.).round());
                }
            }
        }
    }
    pub fn save(&self) -> Result<()> {
        let cs = self
            .cases
            .iter()
            .map(|(_, v)| v.clone())
            .collect::<Vec<_>>();
        let count = |states: &[&str]| {
            cs.iter()
                .filter(|c| states.contains(&text(&c["status"])))
                .count()
        };
        let done = count(&["passed", "failed", "skipped", "interrupted"]);
        let mut total = self.data["total"].as_u64().filter(|n| *n > 0);
        if total.unwrap_or(0) < cs.len() as u64 {
            total = if self.open_ended && self.data["phase"] == "running" {
                None
            } else {
                Some(cs.len() as u64)
            };
        }
        let mut d = self.data.clone();
        let elapsed = epoch(text(&d["started_at"]))
            .map(|t| now() - t)
            .unwrap_or(0.);
        let running = d["phase"] == "running";
        merge(
            &mut d,
            &json!({"total":total,"done":done,"passed":count(&["passed"]),"failed":count(&["failed","interrupted"]),"pending":if count(&["skipped"])>0{json!(count(&["skipped"]))}else{Value::Null},"updated_at":iso(),"eta_s":if running&&total.is_some()&&done>0{json!((elapsed/done as f64*(total.unwrap_or(0)as f64-done as f64).max(0.)).round())}else{Value::Null}}),
        );
        let cs = if cs.len() > 500 {
            let mut keep = cs
                .iter()
                .filter(|c| matches!(text(&c["status"]), "failed" | "running"))
                .take(500)
                .cloned()
                .collect::<Vec<_>>();
            let mut rest = cs
                .iter()
                .filter(|c| !matches!(text(&c["status"]), "failed" | "running"))
                .rev()
                .take(500 - keep.len())
                .cloned()
                .collect::<Vec<_>>();
            rest.reverse();
            keep.extend(rest);
            keep
        } else {
            cs
        };
        d["failures"]=json!(cs.iter().filter(|c|matches!(text(&c["status"]),"failed"|"interrupted")).take(20).map(|c|json!({"id":format!("{}{}",text(&c["id"]),if text(&c["title"]).is_empty(){String::new()}else{format!(" {}",text(&c["title"]))}),"msg":c["msg"].as_str().unwrap_or("")})).collect::<Vec<_>>());
        d["cases"] = json!(cs);
        save_json(dir().join(format!("{}.json", self.key)), &d)
    }
}
pub fn detect(args: &[String]) -> &'static str {
    let words = args
        .iter()
        .take_while(|s| !s.starts_with('-'))
        .map(|s| {
            std::path::Path::new(s)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
        })
        .collect::<Vec<_>>()
        .join(" ");
    for (k, p) in [
        ("rspec", r"\brspec\b|parallel:spec"),
        ("vitest", r"\bvitest\b"),
        ("jest", r"\bjest\b"),
        ("playwright", r"\bplaywright\b"),
    ] {
        if rx(p).is_match(&words) {
            return k;
        }
    }
    if words.contains("cargo") && args.iter().any(|s| s == "test") {
        "rust"
    } else if args.iter().any(|s| s == "--test")
        && words
            .split_whitespace()
            .last()
            .is_some_and(|s| s == "node" || s == "tsx")
    {
        "node-test"
    } else {
        "test"
    }
}
fn formatter_present(args: &[String]) -> bool {
    if args
        .iter()
        .any(|s| s == "-f" || s.starts_with("--format") || s.starts_with("-f") && s.len() > 2)
        || rx(r"(-f|--format)\b").is_match(&cli::env("SPEC_OPTS").unwrap_or_default())
    {
        return true;
    }
    [
        PathBuf::from(".rspec"),
        ".rspec-local".into(),
        home().join(".rspec"),
    ]
    .iter()
    .any(|p| fs::read_to_string(p).is_ok_and(|s| rx(r"(?m)^\s*(-f|--format)\b").is_match(&s)))
}
fn parse_events(path: &PathBuf, pos: &mut usize, r: &mut Progress) {
    let Ok(bytes) = fs::read(path) else { return };
    if *pos > bytes.len() {
        *pos = 0;
    }
    let Some(end) = bytes[*pos..].iter().rposition(|b| *b == b'\n') else {
        return;
    };
    let end = *pos + end + 1;
    for raw in bytes[*pos..end].split(|b| *b == b'\n') {
        let Ok(e) = serde_json::from_slice::<Value>(raw) else {
            continue;
        };
        if e["ev"] == "start" {
            r.data["total"] = json!(number(&r.data["total"]) + number(&e["total"]));
            r.data["detail"] = Value::Null;
        } else if e["ev"] == "case" {
            r.case(
                text(&e["key"]),
                e["id"].as_str(),
                e["title"].as_str(),
                e["status"].as_str(),
                e["msg"].as_str(),
                e["ms"].as_f64(),
            );
        }
    }
    *pos = end;
}
fn wrap(opts: &HashMap<String, String>, mut args: Vec<String>) -> Result<i32> {
    if args.is_empty() {
        return Err("run needs a command after --".into());
    }
    let kind = opts
        .get("kind")
        .cloned()
        .unwrap_or_else(|| detect(&args).into());
    let key = opts.get("key").cloned().unwrap_or_else(|| new_key(&kind));
    if !rx(r"^[\w.-]{1,180}$").is_match(&key) {
        return Err("invalid run key".into());
    }
    let logs = dir().join("logs");
    fs::create_dir_all(&logs).map_err(|e| e.to_string())?;
    let log = logs.join(format!("{key}.log"));
    let mut p = Progress::new(
        key.clone(),
        json!({"kind":kind,"label":opts.get("label").cloned().unwrap_or_else(||format!("{kind} {}",args.iter().rev().take(3).rev().cloned().collect::<Vec<_>>().join(" "))),"detail":"준비 중","log":log,"cmd":short(&args.iter().map(|s|shell_words::quote(s)).collect::<Vec<_>>().join(" "),300)}),
    );
    p.open_ended = kind != "rspec";
    p.save()?;
    let mut env = vec![(
        "FORCE_COLOR".to_owned(),
        cli::env("FORCE_COLOR").unwrap_or("0".into()),
    )];
    let events = if kind == "rspec" {
        let e = logs.join(format!("{key}.events"));
        fs::write(&e, "").map_err(|e| e.to_string())?;
        let formatter = Config::default().here.join("atest-rspec.rb");
        let extra = format!(
            "{} --require {} --format AtestFormatter --out /dev/null",
            if formatter_present(&args) {
                ""
            } else {
                "--format progress"
            },
            shell_words::quote(formatter.to_string_lossy().as_ref())
        );
        env.push((
            "SPEC_OPTS".into(),
            format!("{} {extra}", cli::env("SPEC_OPTS").unwrap_or_default()),
        ));
        env.push(("ATEST_EVENTS".into(), e.display().to_string()));
        Some(e)
    } else {
        None
    };
    if kind == "vitest" && !args.iter().any(|a| a.starts_with("--reporter")) {
        args.push("--reporter=verbose".into());
    }
    if kind == "jest" && !args.iter().any(|a| a == "--verbose") {
        args.push("--verbose".into());
    }
    if kind == "node-test" && !args.iter().any(|a| a.starts_with("--test-reporter")) {
        let i = args
            .iter()
            .position(|a| a == "--test")
            .unwrap_or(args.len());
        args.insert(i, "--test-reporter=spec".into());
    }
    let (reader, writer) = os_pipe::pipe().map_err(|e| e.to_string())?;
    let mut cmd = std::process::Command::new(&args[0]);
    cmd.args(&args[1..])
        .envs(env)
        .stdout(writer.try_clone().map_err(|e| e.to_string())?)
        .stderr(writer);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let code = if e.kind() == std::io::ErrorKind::PermissionDenied {
                126
            } else {
                127
            };
            let msg = format!("명령 시작 실패: {e} ({})", args[0]);
            merge(
                &mut p.data,
                &json!({"phase":"failed","verdict":"error","exit":code,"detail":msg,"judged":true}),
            );
            p.save()?;
            fs::write(log, &msg).map_err(|e| e.to_string())?;
            eprintln!("atest: {msg}");
            return Ok(code);
        }
    };
    drop(cmd);
    eprintln!(
        "atest: {kind} 진행을 {} 에 기록 (로그 {})",
        dir().join(format!("{key}.json")).display(),
        log.display()
    );
    let pid = child.id();
    let mut signals =
        signal_hook::iterator::Signals::new([libc::SIGINT, libc::SIGTERM, libc::SIGHUP])
            .map_err(|e| e.to_string())?;
    let signal_handle = signals.handle();
    std::thread::spawn(move || {
        for sig in signals.forever() {
            unsafe {
                libc::kill(pid as i32, sig);
            }
        }
    });
    let shared = Arc::new(Mutex::new(p));
    let stop = Arc::new(AtomicBool::new(false));
    let progress = shared.clone();
    let stopping = stop.clone();
    let saver = std::thread::spawn(move || {
        let mut pos = 0;
        loop {
            if let Some(events) = events.as_ref() {
                parse_events(events, &mut pos, &mut progress.lock().unwrap());
            }
            let _ = progress.lock().unwrap().save();
            if stopping.load(Ordering::Relaxed) {
                break;
            }
            std::thread::sleep(Duration::from_millis(300));
        }
    });
    let mut log_file = fs::File::create(&log).map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(reader);
    let mut raw = vec![];
    let mut n = 0;
    let mut last: Option<usize> = None;
    loop {
        raw.clear();
        let size = reader
            .read_until(b'\n', &mut raw)
            .map_err(|e| e.to_string())?;
        if size == 0 {
            break;
        }
        std::io::stdout()
            .write_all(&raw)
            .and_then(|_| std::io::stdout().flush())
            .map_err(|e| e.to_string())?;
        log_file.write_all(&raw).map_err(|e| e.to_string())?;
        if kind == "rspec" {
            continue;
        }
        let line = String::from_utf8_lossy(&raw);
        let line = rx(r"\x1b\[[0-9;?]*[A-Za-z]")
            .replace_all(&line, "")
            .trim_end()
            .to_owned();
        if let Some(c) = rx(r"^\s*→\s+(.+)").captures(&line) {
            if let Some(i) = last {
                let mut p = shared.lock().unwrap();
                let v: &mut Value = &mut p.cases[i].1;
                if v["status"] == "failed" && v["msg"].is_null() {
                    v["msg"] = json!(short(&c[1], 500));
                }
            }
            continue;
        }
        let parsed = if let Some(c) = rx(
            r"^\s*(?:\d+\s+)?(✓|✔|√|✗|✕|×|✖|✘|↓)\s+(.+?)(?:\s+\(?(\d+(?:\.\d+)?)\s*(ms|s)\)?)?\s*$",
        )
        .captures(&line)
        {
            if rx(r"\(\d+ tests?(?: \| [^)]*)?\)").is_match(&line) {
                None
            } else {
                Some((
                    c[2].to_owned(),
                    if ["✓", "✔", "√"].contains(&&c[1]) {
                        "passed"
                    } else if &c[1] == "↓" {
                        "skipped"
                    } else {
                        "failed"
                    },
                    c.get(3)
                        .and_then(|m| m.as_str().parse::<f64>().ok())
                        .map(|n| {
                            n * if c.get(4).is_some_and(|m| m.as_str() == "s") {
                                1000.
                            } else {
                                1.
                            }
                        }),
                ))
            }
        } else {
            rx(r"^test (.+?) \.\.\. (ok|FAILED|ignored)$")
                .captures(&line)
                .map(|c| {
                    (
                        c[1].into(),
                        match &c[2] {
                            "ok" => "passed",
                            "ignored" => "skipped",
                            _ => "failed",
                        },
                        None,
                    )
                })
        };
        if let Some((title, status, ms)) = parsed {
            n += 1;
            let title = rx(r"^\|[^|]+\|\s+").replace(&title, "").into_owned();
            let (id, title) = title
                .split_once(" > ")
                .filter(|(h, _)| h.contains('/') || h.contains('.'))
                .map(|(id, t)| (id.into(), t.into()))
                .unwrap_or((format!("#{n}"), title));
            let mut p = shared.lock().unwrap();
            p.data["detail"] = Value::Null;
            p.case(
                &n.to_string(),
                Some(&id),
                Some(&title),
                Some(status),
                None,
                ms,
            );
            last = Some(p.cases.len() - 1);
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    use std::os::unix::process::ExitStatusExt;
    let code = status
        .code()
        .unwrap_or_else(|| 128 + status.signal().unwrap_or(0));
    signal_handle.close();
    stop.store(true, Ordering::Relaxed);
    let _ = saver.join();
    let mut p = shared.lock().unwrap();
    for (_, c) in &mut p.cases {
        if matches!(text(&c["status"]), "running" | "queued") {
            c["status"] = json!(if code != 0 { "interrupted" } else { "skipped" });
        }
    }
    let cases = p.cases.iter().map(|(_, c)| c.clone()).collect::<Vec<_>>();
    let log = read_tail(&log, 400_000);
    let mut judgement = test_runs::judge(
        code,
        &cases,
        &log,
        text(&p.data["label"]),
        opts.contains_key("expect-red"),
    );
    if let Some(extra) = judgement.as_object_mut().unwrap().remove("extra") {
        for c in array(&extra) {
            p.case(
                text(&c["id"]),
                c["id"].as_str(),
                c["title"].as_str(),
                c["status"].as_str(),
                c["msg"].as_str(),
                None,
            );
        }
    }
    merge(&mut p.data, &judgement);
    p.data["exit"] = json!(code);
    p.save()?;
    Ok(code)
}
pub fn run(args: &[String]) -> i32 {
    let result = (|| -> Result<i32> {
        let op = args.first().map(String::as_str).unwrap_or("");
        if !["run", "start", "case", "note", "end"].contains(&op) {
            return Err("usage: atest run [--kind K] [--label L] [--key K] [--expect-red] -- COMMAND... | start [CASES...] | case ID STATUS [NOTE] | note TEXT | end [passed|failed]".into());
        }
        let mut opts = HashMap::new();
        let mut rest = vec![];
        let mut i = 1;
        while i < args.len() {
            let a = &args[i];
            if a == "--" && op == "run" {
                rest.extend_from_slice(&args[i + 1..]);
                break;
            }
            if a == "--expect-red" && op == "run" {
                opts.insert("expect-red".into(), "true".into());
                i += 1;
            } else if ["--kind", "--label", "--key", "--total", "--title"].contains(&a.as_str()) {
                let v = args.get(i + 1).ok_or("option needs a value")?;
                opts.insert(a.trim_start_matches('-').to_owned(), v.clone());
                i += 2;
            } else if op == "run" {
                rest.extend_from_slice(&args[i..]);
                break;
            } else {
                rest.push(a.clone());
                i += 1;
            }
        }
        if op == "run" {
            return wrap(&opts, rest);
        }
        fs::create_dir_all(dir()).map_err(|e| e.to_string())?;
        let explicit = opts.contains_key("key");
        let key = if op == "start" {
            opts.get("key")
                .cloned()
                .unwrap_or_else(|| new_key(opts.get("kind").map(String::as_str).unwrap_or("check")))
        } else {
            opts.get("key")
                .cloned()
                .or_else(|| fs::read_to_string(current()).ok().map(|s| s.trim().into()))
                .ok_or("no run started in this session (atest start, or --key)")?
        };
        if !rx(r"^[\w.-]{1,180}$").is_match(&key) {
            return Err("invalid run key".into());
        }
        let lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(dir().join(format!(".{key}.lock")))
            .map_err(|e| e.to_string())?;
        lock.lock_exclusive().map_err(|e| e.to_string())?;
        let mut p = if op == "start" {
            Progress::new(
                key.clone(),
                json!({"kind":opts.get("kind").map(String::as_str).unwrap_or("check"),"label":opts.get("label").or(opts.get("kind")).map(String::as_str).unwrap_or("check"),"total":opts.get("total").and_then(|s|s.parse::<u64>().ok())}),
            )
        } else {
            Progress::load(&key)?
        };
        match op {
            "start" => {
                for c in &rest {
                    let (id, title) = c.split_once('=').unwrap_or((c, ""));
                    p.case(
                        id.trim(),
                        Some(id.trim()),
                        Some(title.trim()),
                        None,
                        None,
                        None,
                    );
                }
                if !explicit {
                    fs::write(current(), &key).map_err(|e| e.to_string())?;
                }
                println!("atest: run {key} started ({} cases)", p.cases.len());
            }
            "case" => {
                if rest.len() < 2
                    || !["running", "passed", "failed", "skipped"].contains(&rest[1].as_str())
                {
                    return Err("case needs ID and running|passed|failed|skipped".into());
                }
                p.case(
                    &rest[0],
                    Some(&rest[0]),
                    opts.get("title").map(String::as_str),
                    Some(&rest[1]),
                    (!rest[2..].is_empty())
                        .then(|| rest[2..].join(" "))
                        .as_deref(),
                    None,
                );
                println!("atest: {} {}", rest[0], rest[1]);
            }
            "note" => {
                p.data["detail"] = json!(rest.join(" "));
                println!("atest: note recorded");
            }
            "end" => {
                for (_, c) in &mut p.cases {
                    if c["status"] == "running" {
                        c["status"] = json!("interrupted");
                    }
                }
                let bad = p
                    .cases
                    .iter()
                    .any(|(_, c)| matches!(text(&c["status"]), "failed" | "interrupted"));
                let verdict = rest
                    .first()
                    .filter(|s| s.as_str() == "passed" || s.as_str() == "failed");
                p.data["phase"] = json!(if verdict.is_some_and(|s| s == "failed")
                    || verdict.is_none() && bad
                {
                    "failed"
                } else {
                    "done"
                });
                p.data["detail"] = json!(rest[usize::from(verdict.is_some())..].join(" "));
                if !explicit {
                    let _ = fs::remove_file(current());
                }
                println!("atest: run {key} finished");
            }
            _ => {}
        }
        p.save()?;
        Ok(0)
    })();
    match result {
        Ok(code) => code,
        Err(e) => {
            eprintln!("atest: {e}");
            2
        }
    }
}
