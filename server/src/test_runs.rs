use crate::{core::*, sessions::rx};
use serde_json::{Value, json};
use std::fs;
pub fn normalize(cases: &Value) -> Vec<Value> {
    array(cases).iter().take(500).filter(|c|c.is_object()).map(|c|{let title=text(&c["title"]);let code=c["id"].as_str().or(c["tc"].as_str()).unwrap_or("");let m=rx(r"^\s*(TC-[\w.-]+)\s*[:·—-]?\s*").captures(title);let(code,title)=if let Some(m)=m.filter(|m|code.is_empty()||code==&m[1]){(m[1].to_owned(),title[m.get(0).unwrap().end()..].to_owned())}else{(code.into(),title.into())};json!({"id":short(&code,80),"title":short(&title,200),"status":c["status"],"msg":c["msg"].as_str().or(c["error"].as_str()).filter(|s|!s.is_empty()).map(|s|short(s,300)),"ms":c.get("ms").or(c.get("duration_ms"))})}).collect()
}
pub fn judge(code: i32, cases: &[Value], log: &str, label: &str, red: bool) -> Value {
    let lines = log.lines().collect::<Vec<_>>();
    let head=lines.iter().enumerate().rev().find_map(|(i,s)|rx(r"^run-tc \S+ · (?:요청 \d+ ID|spec .+?) · 통과 (\d+) · 실패 (\d+) · 로드 오류 (\d+)(?: · 미발견 (\d+))?").captures(s).map(|m|(i,m)));
    let mut extra = vec![];
    if let Some((i, _)) = &head {
        let any_failed = cases.iter().any(|c| c["status"] == "failed");
        for line in &lines[*i..] {
            if let Some(m) =
                rx(r"^  (\S+): (통과|실패|로드 실패|결과없음) \(통과 (\d+) · 실패 (\d+)\)")
                    .captures(line)
            {
                let id = &m[1];
                let word = &m[2];
                let c = if word == "통과" {
                    Some(json!({"id":id,"title":format!("통과 {}",&m[3]),"status":"passed"}))
                } else if word == "결과없음" {
                    Some(json!({"id":id,"title":"결과 없음","status":"skipped","msg":"결과없음"}))
                } else if !any_failed {
                    Some(
                        json!({"id":id,"title":format!("{} · 통과 {} · 실패 {}",word,&m[3],&m[4]),"status":"failed","msg":word}),
                    )
                } else {
                    None
                };
                if let Some(c) = c {
                    extra.push(c);
                }
            } else if let Some(m) = rx(r"^  미발견: (.+)").captures(line) {
                for id in m[1].split_whitespace() {
                    extra.push(
                        json!({"id":id,"title":"테스트 미발견","status":"skipped","msg":"미발견"}),
                    );
                }
            }
        }
        extra.retain(|c| !cases.iter().any(|h| h["id"] == c["id"]));
    }
    let all = cases.iter().chain(extra.iter()).collect::<Vec<_>>();
    let failed = all
        .iter()
        .filter(|c| matches!(text(&c["status"]), "failed" | "interrupted"))
        .count();
    let passed = all.iter().filter(|c| c["status"] == "passed").count();
    let make = |phase: &str, verdict: Option<&str>, detail: Option<String>| json!({"phase":phase,"verdict":verdict,"detail":detail,"extra":extra,"judged":true});
    if let Some(m) = lines
        .iter()
        .rev()
        .find_map(|s| rx(r"빨강 판정: (합격|불합격)(.*)").captures(s))
    {
        return if &m[1] == "합격" {
            make(
                "done",
                Some("red"),
                Some(format!("의도한 빨강 확인{}", &m[2])),
            )
        } else {
            make(
                "failed",
                None,
                Some(format!(
                    "빨강이어야 하는데 {}",
                    m[2].trim_matches([' ', '—'])
                )),
            )
        };
    }
    if failed > 0 && (red || rx(r"(?i)\bred\b|빨강").is_match(label)) {
        return make(
            "done",
            Some("red"),
            Some(format!("의도한 빨강 확인 · 실패 {failed}")),
        );
    }
    if red && (passed > 0 || code == 0) {
        return make("failed", None, Some("빨강이어야 하는데 실패 0".into()));
    }
    if code == 0 && failed == 0 {
        return make("done", None, None);
    }
    if failed > 0 {
        return make("failed", None, None);
    }
    if let Some((_, h)) = &head {
        let n = |i| {
            h.get(i)
                .and_then(|m| m.as_str().parse::<u64>().ok())
                .unwrap_or(0)
        };
        if n(2) == 0 && n(3) == 0 && n(4) > 0 && n(1) > 0 {
            let missing = all
                .iter()
                .filter(|c| c["msg"] == "미발견")
                .map(|c| text(&c["id"]))
                .collect::<Vec<_>>()
                .join(" ");
            return make(
                "done",
                Some("warn"),
                Some(format!("미발견 {missing} · 나머지 통과 {}", &h[1])),
            );
        }
    }
    let mut suites = vec![];
    for s in &lines {
        if let Some(c) = rx(r"^\s*FAIL\s+(\S+)").captures(s) {
            let name = c[1].to_owned();
            if !suites.contains(&name) {
                suites.push(name);
            }
        }
    }
    let tests = lines
        .iter()
        .rev()
        .find_map(|s| {
            rx(r"^\s*Tests?:?\s+(.+)")
                .captures(s)
                .map(|c| c[1].to_owned())
        })
        .unwrap_or_default();
    if passed > 0 && !suites.is_empty() && !tests.contains("failed") {
        let names = suites
            .iter()
            .take(3)
            .map(|s| {
                std::path::Path::new(s)
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
            })
            .collect::<Vec<_>>()
            .join(", ");
        let more = if suites.len() > 3 {
            format!(" 외 {}", suites.len() - 3)
        } else {
            String::new()
        };
        return make(
            "done",
            Some("warn"),
            Some(format!(
                "로드 실패 스위트 {}개({names}{more}) · 테스트는 전부 통과",
                suites.len()
            )),
        );
    }
    if passed == 0 {
        let why = lines
            .iter()
            .find(|s| {
                rx(r"^\s*(?:run-tc: |\w*Error: |error: |Could not |No tests found)").is_match(s)
            })
            .copied()
            .or_else(|| {
                lines
                    .iter()
                    .rev()
                    .find(|s| !s.trim().is_empty() && !s.starts_with("로그:"))
                    .copied()
            })
            .map(|s| s.trim().chars().take(200).collect::<String>())
            .unwrap_or_else(|| {
                if code != 0 {
                    format!("종료 코드 {code}")
                } else {
                    "실행된 테스트 없음".into()
                }
            });
        return make("failed", Some("error"), Some(why));
    }
    make(
        "failed",
        None,
        if code != 0 {
            Some(format!("종료 코드 {code}"))
        } else {
            None
        },
    )
}
pub fn collect(config: &Config, prefs: &Value, plans: &Value, history: &mut Value) -> Value {
    let original_history = history.clone();
    if !history.is_object() {
        *history = obj();
    }
    let mut runs = vec![];
    let dir = std::env::var_os("ATEST_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| "/private/tmp/agent-test-progress".into());
    if let Ok(entries) = fs::read_dir(&dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().is_none_or(|x| x != "json") || now() - mtime(&p) > 86400. {
                continue;
            }
            let mut d = read_json(&p);
            if !d.is_object() {
                continue;
            }
            if d["phase"].is_null() {
                d["phase"] = if d["status"] == "failed"
                    || d["status"] == "done" && number(&d["exit"]) != 0.
                {
                    json!("failed")
                } else {
                    d["status"].clone()
                };
                if d["label"].is_null() {
                    d["label"] = d["task"].clone();
                }
                if d["detail"].is_null() {
                    d["detail"] = d["summary"].clone();
                }
            }
            d["cases"] = json!(normalize(&d["cases"]));
            if d["phase"] == "failed" && d["judged"] != true {
                let log = read_tail(std::path::Path::new(text(&d["log"])), 400_000);
                if !log.is_empty() {
                    let j = judge(
                        d["exit"].as_i64().unwrap_or(1) as i32,
                        array(&d["cases"]),
                        &log,
                        text(&d["label"]),
                        false,
                    );
                    let extra = array(&j["extra"]).to_vec();
                    d["cases"].as_array_mut().unwrap().extend(extra);
                    merge(&mut d, &j);
                    d.as_object_mut().unwrap().remove("extra");
                    d["passed"] = json!(
                        array(&d["cases"])
                            .iter()
                            .filter(|c| c["status"] == "passed")
                            .count()
                    );
                    d["failed"] = json!(
                        array(&d["cases"])
                            .iter()
                            .filter(|c| c["status"] == "failed")
                            .count()
                    );
                }
            }
            d["key"] = json!(p.file_stem().unwrap_or_default().to_string_lossy());
            d["mtime"] = json!(mtime(&p));
            if !d["failures"].is_array() {
                d["failures"] = json!([]);
            }
            if matches!(text(&d["phase"]), "done" | "failed") {
                let fin = d["updated_at"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(iso);
                let key = format!(
                    "file:{}:{}",
                    text(&d["key"]),
                    d["started_at"].as_str().unwrap_or(&fin)
                );
                let mut rec = d.clone();
                merge(
                    &mut rec,
                    &json!({"src":"file","finished_at":fin,"archived_at":now()}),
                );
                if let Some(old) = history.get(&key) {
                    rec["archived_at"] = old["archived_at"].clone();
                }
                history[&key] = rec;
            }
            runs.push(d);
        }
    }
    let mut paths: Vec<_> = array(&prefs["run_tc_progress"])
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect();
    for p in array(plans) {
        for t in array(&p["tickets"]) {
            if let Some(s) = t["e2e_progress"].as_str() {
                paths.push(s.into());
            }
        }
    }
    paths.sort();
    paths.dedup();
    let mut run_tc = obj();
    for p in paths {
        let d = read_json(&p);
        if !d.is_object() {
            continue;
        }
        run_tc[&p] = d.clone();
        for h in array(&d["history"]) {
            let id = text(&h["run"]);
            if id.is_empty() {
                continue;
            }
            let k = format!("run-tc:{id}");
            let mut c = read_json(
                std::path::Path::new(&p)
                    .parent()
                    .unwrap_or(std::path::Path::new("."))
                    .join("e2e-runs")
                    .join(format!("{id}.tests.json")),
            );
            if !c.is_array() {
                c = json!([]);
            }
            let mut rec = h.clone();
            merge(
                &mut rec,
                &json!({"src":"run-tc","key":id,"kind":"e2e","label":format!("E2E {}",array(&h["ids"]).iter().map(text).collect::<Vec<_>>().join(", ")),"owner":h["caller"],"phase":if number(&h["failed"])>0.||text(&h["outcome"]).contains("중단"){"failed"}else{"done"},"detail":h["outcome"],"cases":normalize(&c),"failures":[],"judged":true,"archived_at":history.get(&k).map(|v|v["archived_at"].clone()).unwrap_or_else(||json!(now()))}),
            );
            history[&k] = rec;
        }
    }
    let mut keys: Vec<_> = history.as_object().unwrap().keys().cloned().collect();
    keys.sort_by(|a, b| {
        number(&history[b]["archived_at"]).total_cmp(&number(&history[a]["archived_at"]))
    });
    for (k, i) in keys.into_iter().zip(0..) {
        if i >= 2000 || number(&history[&k]["archived_at"]) < now() - 30. * 86400. {
            history.as_object_mut().unwrap().remove(&k);
        }
    }
    if original_history != *history {
        let _ = save_json(config.data.join("test-history.json"), history);
    }
    json!({"files":runs,"run_tc":run_tc,"history_n":history.as_object().unwrap().len(),"history_at":now()})
}
pub fn lite(mut d: Value) -> Value {
    if matches!(text(&d["phase"]), "done" | "failed") && !array(&d["cases"]).is_empty() {
        let c = array(&d["cases"]);
        let n = c.len();
        let bad = c
            .iter()
            .filter(|c| matches!(text(&c["status"]), "failed" | "timedOut" | "interrupted"))
            .count();
        let ok = c.iter().filter(|c| c["status"] == "passed").count();
        d["hist_id"] = json!(format!(
            "file:{}:{}",
            text(&d["key"]),
            d["started_at"]
                .as_str()
                .or(d["updated_at"].as_str())
                .unwrap_or("")
        ));
        d["case_counts"] = json!({"n":n,"bad":bad,"ok":ok});
        d.as_object_mut().unwrap().remove("cases");
    }
    d
}
