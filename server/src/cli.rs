use crate::{core::*, sessions::rx};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE},
};
use fs2::FileExt;
use serde_json::{Value, json};
use std::{fs, io::Read, path::Path};
use unicode_normalization::UnicodeNormalization;
pub fn recognized(name: &str) -> bool {
    [
        "aplan",
        "atest",
        "adata",
        "aqa",
        "amedia",
        "ausage",
        "decision-hook",
        "session-guard",
    ]
    .contains(&name)
}
pub fn run(name: &str, args: &[String]) -> i32 {
    let c = Config::default();
    let result = match name {
        "aplan" => aplan(args),
        "atest" => return crate::atest::run(args),
        "adata" => crate::data::run(&c, args),
        "aqa" => aqa(&c, args),
        "amedia" => amedia(&c, args),
        "ausage" => ausage(&c, args),
        "decision-hook" | "session-guard" => {
            let _ = hook(name);
            Ok(0)
        }
        _ => Err("unknown command".into()),
    };
    match result {
        Ok(n) => n,
        Err(e) => {
            eprintln!("{name}: {e}");
            2
        }
    }
}
pub fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|s| !s.is_empty())
}
pub fn identity() -> String {
    env("CLAUDE_CODE_SESSION_ID")
        .or_else(|| env("CODEX_THREAD_ID"))
        .or_else(|| env("ORCA_TERMINAL_HANDLE"))
        .unwrap_or("anon".into())
}
fn aplan(args: &[String]) -> Result<i32> {
    let op = args.first().map(String::as_str).unwrap_or("");
    if !["set", "add", "done", "start", "skip", "fail"].contains(&op) {
        return Err("usage: aplan set STEPS... | add STEPS... | done [N] [NOTE] | start N | skip N | fail N".into());
    }
    let mut ev = json!({"op":op});
    if op == "set" || op == "add" {
        let steps = args[1..]
            .iter()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>();
        if steps.is_empty() {
            return Err(format!("{op} needs at least one step"));
        }
        ev["steps"] = json!(steps);
    } else {
        let mut rest = &args[1..];
        if let Some(n) = rest.first().and_then(|s| s.parse::<u64>().ok()) {
            ev["n"] = json!(n);
            rest = &rest[1..];
        } else if op != "done" {
            return Err(format!("{op} needs a step number"));
        }
        if !rest.is_empty() {
            ev["note"] = json!(rest.join(" "));
        }
    }
    ev["id"] = json!(&uuid::Uuid::new_v4().simple().to_string()[..12]);
    ev["ts"] = json!(iso());
    let sid = env("CLAUDE_CODE_SESSION_ID").or_else(|| env("CODEX_THREAD_ID"));
    let term = env("ORCA_TERMINAL_HANDLE");
    if let Some(key) = sid.as_ref().or(term.as_ref()) {
        for dir in [home().join(".agent-plans"), "/tmp/agent-plans".into()] {
            if append_json(
                dir.join(format!("{key}.jsonl")),
                &json!({"session":sid,"terminal":term,"event":ev}),
            )
            .is_ok()
            {
                break;
            }
        }
    }
    let what = match op {
        "set" => format!("plan of {} steps", array(&ev["steps"]).len()),
        "add" => format!("+{} steps", array(&ev["steps"]).len()),
        _ => format!(
            "{op} #{}",
            ev["n"]
                .as_u64()
                .map(|n| n.to_string())
                .unwrap_or("current".into())
        ),
    };
    println!(
        "aplan: {what} recorded\nAPLAN:{}",
        URL_SAFE.encode(serde_json::to_vec(&ev).map_err(|e| e.to_string())?)
    );
    Ok(0)
}
fn stdin() -> Result<String> {
    let mut s = String::new();
    std::io::stdin()
        .read_to_string(&mut s)
        .map_err(|e| e.to_string())?;
    Ok(s)
}
fn hook(name: &str) -> Result<()> {
    let e = serde_json::from_str::<Value>(&stdin()?).map_err(|e| e.to_string())?;
    let url = env("DASH_URL").unwrap_or("http://127.0.0.1:8787".into());
    let mut b = json!({"cwd":e["cwd"],"terminal":env("ORCA_TERMINAL_HANDLE")});
    let action = if name == "session-guard" {
        let cmd = text(&e["tool_input"]["command"]);
        if !cmd.contains("orca") {
            return Ok(());
        }
        b["command"] = json!(cmd);
        "guard"
    } else {
        b["session_id"] = e["session_id"].clone();
        b["tool_use_id"] = e["tool_use_id"].clone();
        if e["hook_event_name"] == "PermissionRequest" {
            if e["tool_name"] != "Bash" {
                return Ok(());
            }
            b["permission"] = json!({"command":e["tool_input"]["command"],"description":e["tool_input"]["description"]});
        } else {
            b["questions"] = e["tool_input"]["questions"].clone();
        }
        "ask"
    };
    let r = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?
        .post(format!(
            "{}/api/decision/{action}",
            url.trim_end_matches('/')
        ))
        .json(&b)
        .send()
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.json::<Value>())
        .map_err(|e| e.to_string())?;
    if r["deny"].as_str().is_some_and(|s| !s.is_empty()) {
        println!(
            "{}",
            json!({"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":r["deny"]}})
        );
    }
    Ok(())
}
pub fn parse_sheet(s: &str) -> Result<Value> {
    let labels = [
        ("버전", "version"),
        ("단말", "device"),
        ("작성자", "author"),
        ("테스터", "tester"),
        ("테스트 일자", "period"),
        ("배포 내역", "release"),
        ("총 TC", "total"),
        ("Pass", "pass"),
        ("Fail", "fail"),
        ("Blocked", "blocked"),
        ("Dropped", "dropped"),
        ("N-Test", "ntest"),
    ];
    let mut got = obj();
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .from_reader(s.trim_start_matches('\u{feff}').as_bytes());
    for row in reader.records() {
        let row = row.map_err(|e| e.to_string())?;
        for pair in row.iter().collect::<Vec<_>>().chunks_exact(2) {
            if let Some((_, field)) = labels.iter().find(|(label, _)| *label == pair[0].trim()) {
                if got[*field].is_null() {
                    got[*field] = json!(pair[1].trim());
                }
            }
        }
    }
    for k in ["total", "pass", "fail", "blocked", "dropped", "ntest"] {
        let n = text(&got[k])
            .replace(',', "")
            .parse::<u64>()
            .map_err(|_| format!("Summary 탭 양식이 아닙니다 (숫자를 못 찾음: {k})"))?;
        got[k] = json!(n);
    }
    Ok(got)
}
fn aqa(c: &Config, args: &[String]) -> Result<i32> {
    if args.len() != 3 || args[0] != "sheet" || !rx(r"^[A-Z][A-Z0-9]+-\d+$").is_match(&args[1]) {
        return Err("usage: aqa sheet EPIC BASE64-CSV|-".into());
    }
    let s = if args[2] == "-" {
        stdin()?
    } else {
        args[2].clone()
    };
    let raw = STANDARD
        .decode(s.split_whitespace().collect::<String>())
        .map_err(|e| e.to_string())?;
    let mut sheet = parse_sheet(std::str::from_utf8(&raw).map_err(|e| e.to_string())?)?;
    sheet["at"] = json!(iso());
    fs::create_dir_all(&c.data).map_err(|e| e.to_string())?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(c.data.join("qa-sheets.json.lock"))
        .map_err(|e| e.to_string())?;
    lock.lock_exclusive().map_err(|e| e.to_string())?;
    let mut store = read_json(c.data.join("qa-sheets.json"));
    if !store.is_object() {
        store = obj();
    }
    store[&args[1]] = sheet.clone();
    save_json(c.data.join("qa-sheets.json"), &store)?;
    println!(
        "aqa: {} 수행 {}/{} · Pass {} · Fail {}",
        args[1],
        number(&sheet["total"]) - number(&sheet["ntest"]),
        sheet["total"],
        sheet["pass"],
        sheet["fail"]
    );
    Ok(0)
}
fn media_entry(arg: &str) -> Option<String> {
    let rel = if arg.starts_with(['/', '~'])
        || arg.starts_with("./")
        || arg.starts_with("../")
        || Path::new(arg).exists()
    {
        let p = real(arg);
        let parent = p.parent()?;
        let movie = home().join("Movies");
        let root = ["ego-record", "aside-record", "explainer-video"]
            .into_iter()
            .find(|r| real(movie.join(r)) == parent)?;
        format!("{root}/{}", p.file_name()?.to_string_lossy())
    } else {
        arg.into()
    };
    let (root, name) = rel.split_once('/')?;
    if !["ego-record", "aside-record", "explainer-video"].contains(&root)
        || !name.ends_with(".mp4")
        || name.contains('/')
        || name.starts_with('.')
    {
        return None;
    }
    Some(rel.nfc().collect())
}
fn amedia(c: &Config, args: &[String]) -> Result<i32> {
    let op = args.first().map(String::as_str).unwrap_or("");
    if !["ls", "add", "rm", "prune"].contains(&op) {
        return Err("usage: amedia ls | add FILE... | rm ENTRY... | prune".into());
    }
    fs::create_dir_all(&c.data).map_err(|e| e.to_string())?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(c.data.join("media.json.lock"))
        .map_err(|e| e.to_string())?;
    lock.lock_exclusive().map_err(|e| e.to_string())?;
    let raw = read_json(c.data.join("media.json"));
    let mut names = array(&raw["published"])
        .iter()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    if op == "ls" {
        for n in names {
            println!(
                "{}{:<4}{}",
                if crate::media::resolve(c, &n).is_some() {
                    "ok      "
                } else {
                    "missing "
                },
                if n.starts_with("explainer-video/") {
                    "학습"
                } else {
                    "QA"
                },
                n
            );
        }
        return Ok(0);
    }
    let mut bad = false;
    if op == "prune" {
        names.retain(|n| {
            let keep = crate::media::resolve(c, n).is_some();
            if !keep {
                println!("내림(파일 없음): {n}");
            }
            keep
        });
    } else {
        if args.len() < 2 {
            return Err("add/rm needs at least one path".into());
        }
        for a in &args[1..] {
            let Some(n) = media_entry(a) else {
                bad = true;
                eprintln!("amedia: 녹화 폴더 바로 아래의 .mp4 가 아니다: {a}");
                continue;
            };
            if op == "add" {
                let p = home().join("Movies").join(&n);
                let actual = if p.is_file() {
                    Some(p)
                } else {
                    files(p.parent().unwrap(), "mp4").into_iter().find(|p| {
                        p.to_string_lossy().nfc().collect::<String>()
                            == home()
                                .join("Movies")
                                .join(&n)
                                .to_string_lossy()
                                .nfc()
                                .collect::<String>()
                    })
                };
                if actual.is_none() {
                    bad = true;
                    eprintln!("amedia: 파일이 없다: {n}");
                    continue;
                }
                if !names.iter().any(|s| s.nfc().collect::<String>() == n) {
                    names.push(n.clone());
                }
                println!("공개: {n}");
            } else {
                names.retain(|s| s.nfc().collect::<String>() != n);
                println!("내림: {n}");
            }
        }
    }
    save_json(c.data.join("media.json"), &json!({"published":names}))?;
    Ok(i32::from(bad))
}
fn ausage(c: &Config, args: &[String]) -> Result<i32> {
    let mut days = 30;
    let mut by = "both";
    let mut top = 15;
    let mut rare = 1;
    let mut js = false;
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--json" {
            js = true;
            i += 1;
            continue;
        }
        let v = args.get(i + 1).ok_or("missing option value")?;
        match args[i].as_str() {
            "--days" => days = v.parse().map_err(|_| "invalid days")?,
            "--by" => by = v,
            "--top" => top = v.parse().map_err(|_| "invalid top")?,
            "--rare" => rare = v.parse().map_err(|_| "invalid rare")?,
            _ => {
                return Err(
                    "usage: ausage [--days N] [--by app|form|both] [--top N] [--rare N] [--json]"
                        .into(),
                );
            }
        }
        i += 2;
    }
    if !["both", "app", "form"].contains(&by) {
        return Err("invalid grouping".into());
    }
    let t = crate::usage::report(c, days, by, top, rare);
    if t["log"] != true {
        return Err("usage.jsonl 가 없습니다 — 페이지에서 사용 기록이 아직 오지 않았습니다".into());
    }
    if number(&t["rows"]) == 0. {
        return Err("그 기간에 기록이 없습니다".into());
    }
    if js {
        let mut t = t.clone();
        for k in ["log", "recent"] {
            t.as_object_mut().unwrap().remove(k);
        }
        println!("{}", serde_json::to_string_pretty(&t).unwrap());
    } else {
        println!("환경별 대시보드 사용 (최근 {days}일, 기록 {}건)", t["rows"]);
        println!("환경\t기기\t클릭\t화면 시간");
        for e in array(&t["envs"]) {
            println!(
                "{}\t{}\t{}\t{}s",
                text(&e["env"]),
                e["devices"],
                e["clicks"],
                e["screen_secs"]
            );
        }
        println!("\n화면 — 연 횟수 · 화면 시간 비율");
        println!(
            "화면\t{}",
            array(&t["envs"])
                .iter()
                .map(|e| text(&e["env"]))
                .collect::<Vec<_>>()
                .join("\t")
        );
        for screen in array(&t["screens"]) {
            let values = array(&t["envs"])
                .iter()
                .map(|e| {
                    let r = &screen[text(&e["env"])];
                    if number(&r["opens"]) > 0. || number(&r["secs"]) > 0. {
                        format!("{} · {:.0}%", r["opens"], number(&r["share"]) * 100.)
                    } else {
                        "-".into()
                    }
                })
                .collect::<Vec<_>>();
            println!("{}\t{}", text(&screen["view"]), values.join("\t"));
        }
        for e in array(&t["envs"]) {
            let env = text(&e["env"]);
            println!("\n{env} — 많이 쓰는 기능");
            for row in array(&t["top"][env]) {
                println!(
                    "{}\t{}\t{:.0}%",
                    text(&row[0]),
                    row[1],
                    number(&row[1]) / number(&e["clicks"]).max(1.) * 100.
                );
            }
        }
        println!("\n다른 환경에선 쓰는데 여기선 거의 안 쓰는 기능");
        for e in array(&t["envs"]) {
            let env = text(&e["env"]);
            for row in array(&t["rare_here"][env]) {
                println!("{env}\t{}\t{}\t{}", text(&row[0]), row[1], row[2]);
            }
        }
        println!("\n모든 환경에서 드문 기능 (합계 ≤{rare}회)");
        for row in array(&t["rare_everywhere"]) {
            println!("- {} ({})", text(&row[0]), row[1]);
        }
        if array(&t["rare_everywhere"]).is_empty() {
            println!("(없음)");
        }
    }
    Ok(0)
}
