use crate::{
    app::App,
    core::*,
    sessions::{rx, valid_handle},
};
use serde_json::{Value, json};
use std::{collections::BTreeMap, time::Duration};
pub type Response = (u16, Value);
fn error(code: u16, s: impl Into<String>) -> Response {
    (code, json!({"error":s.into()}))
}
fn questions(q: &Value) -> bool {
    q.as_array().is_some_and(|qs| {
        !qs.is_empty()
            && qs.len() <= 4
            && qs.iter().all(|q| {
                q["question"].is_string()
                    && q["options"]
                        .as_array()
                        .is_some_and(|os| os.iter().all(|o| o["label"].is_string()))
            })
    })
}
fn recommended(q: &Value) -> String {
    let labels = array(&q["options"]);
    labels
        .iter()
        .find(|o| rx(r"(?i)\((?:Recommended|권장|추천)\)").is_match(text(&o["label"])))
        .or(labels.first())
        .map(|o| text(&o["label"]).into())
        .unwrap_or_default()
}
fn terminal(app: &App, d: &Value) -> Option<String> {
    d["terminal"]
        .as_str()
        .filter(|h| valid_handle(h))
        .map(str::to_owned)
        .or_else(|| {
            let s = app.state.read().unwrap();
            s.summaries
                .iter()
                .find(|sm| sm["id"] == d["card"]["session_id"])
                .and_then(|sm| sm["orca_focus"].as_str())
                .map(str::to_owned)
        })
}
pub fn publish(app: &App) -> Result<()> {
    let _persist = app.persistence.lock().unwrap();
    let mut s = app.state.write().unwrap();
    for key in ["pending", "inbox"] {
        let v = if key == "pending" {
            &mut s.pending
        } else {
            &mut s.inbox
        };
        if !v.is_object() {
            *v = json!({"items":[]});
        }
        if !v["items"].is_array() {
            v["items"] = json!([]);
        }
    }
    let mut pending = vec![];
    for d in array(&s.pending["items"]) {
        if d["state"].is_null() || d["state"] == "pending" {
            pending.push(d["card"].clone());
        }
    }
    pending.extend(
        array(&s.canvas)
            .iter()
            .filter(|c| c["hidden"] != true)
            .map(|c| c["card"].clone()),
    );
    pending.sort_by(|a, b| number(&a["created_at"]).total_cmp(&number(&b["created_at"])));
    let mut inbox = array(&s.inbox["items"])
        .iter()
        .map(|d| d["card"].clone())
        .collect::<Vec<_>>();
    inbox.sort_by(|a, b| number(&b["created_at"]).total_cmp(&number(&a["created_at"])));
    s.decisions = json!({"available":true,"pending":pending,"inbox":inbox,"inbox_mode":s.prefs["decision_inbox"]==true});
    let pending = json!({"items":array(&s.pending["items"]).iter().filter(|d|d["state"].is_null()||d["state"]=="pending").map(|d|json!({"card":d["card"],"terminal":d["terminal"]})).collect::<Vec<_>>()});
    let inbox = s.inbox.clone();
    drop(s);
    if read_json(app.config.data.join("pending.json")) != pending {
        save_json(app.config.data.join("pending.json"), &pending)?;
    }
    if read_json(app.config.data.join("inbox.json")) != inbox {
        save_json(app.config.data.join("inbox.json"), &inbox)?;
    }
    Ok(())
}
pub fn sweep(app: &App) -> Result<()> {
    let mut s = app.state.write().unwrap();
    let mut picks = BTreeMap::new();
    let known = s
        .sessions
        .values()
        .filter(|x| x.kind == "claude")
        .map(|x| x.id().to_owned())
        .collect::<std::collections::HashSet<_>>();
    let ready = s.scan_ready;
    let mut answered = vec![];
    for sess in s.sessions.values() {
        for (id, pick) in &sess.inbox_picks {
            picks.insert(id.clone(), pick.clone());
        }
        for (id, q) in &sess.asks {
            answered.push((sess.id().to_owned(), id.clone(), q.clone()));
        }
    }
    if let Some(items) = s.pending["items"].as_array_mut() {
        for d in items.iter_mut() {
            let c = &d["card"];
            let q0 = if c["kind"] == "permission" {
                text(&c["command"])
            } else {
                text(&c["questions"][0]["question"])
            };
            let stale = if c["tool_use_id"].is_string() {
                answered.iter().any(|(sid, id, q)| {
                    c["session_id"] == *sid && c["tool_use_id"] == *id && q[2] == true
                })
            } else {
                answered
                    .iter()
                    .filter(|(sid, _, q)| {
                        c["session_id"] == *sid
                            && text(&q[0]) == q0
                            && (number(&q[1]) - number(&c["created_at"])).abs() <= 120.
                    })
                    .min_by(|a, b| {
                        (number(&a.2[1]) - number(&c["created_at"]))
                            .abs()
                            .total_cmp(&(number(&b.2[1]) - number(&c["created_at"])).abs())
                    })
                    .is_some_and(|(_, _, q)| q[2] == true)
            };
            if now() - number(&c["created_at"]) > 7200.
                || stale
                || ready
                    && !known.contains(text(&c["session_id"]))
                    && now() - number(&c["created_at"]) > 90.
            {
                d["state"] = json!("cancelled");
                if d["settled"].is_null() {
                    d["settled"] = json!(now());
                }
            }
        }
        items.retain(|d| {
            d["state"].is_null() || d["state"] == "pending" || now() - number(&d["settled"]) < 300.
        });
    }
    if let Some(items) = s.inbox["items"].as_array_mut() {
        for d in items.iter_mut() {
            if let Some(p) = picks.get(text(&d["card"]["id"])) {
                d["card"]["chosen"] = json!(p);
            }
        }
        items.retain(|d| {
            !(ready
                && !known.contains(text(&d["card"]["session_id"]))
                && now() - number(&d["card"]["created_at"]) > 90.)
                && (d["card"]["read"] != true
                    || now() - number(&d["card"]["created_at"]) < 14. * 86400.)
        });
        items.sort_by(|a, b| {
            number(&b["card"]["created_at"]).total_cmp(&number(&a["card"]["created_at"]))
        });
        items.truncate(200);
    }
    drop(s);
    canvas_sweep(app);
    publish(app)
}
pub fn post(app: &App, action: &str, b: &Value) -> Response {
    if !b.is_object() {
        return error(400, "bad request");
    }
    if action == "mode" {
        if !b["inbox"].is_boolean() {
            return error(400, "bad request");
        }
        let mut s = app.state.write().unwrap();
        s.prefs["decision_inbox"] = b["inbox"].clone();
        drop(s);
        if let Err(e) = app.save_prefs().and_then(|_| publish(app)) {
            return error(500, e);
        }
        return (200, json!({"ok":true,"inbox":b["inbox"]}));
    }
    if action == "guard" {
        let Some(cmd) = b["command"].as_str() else {
            return error(400, "bad request");
        };
        let (held, orca, sessions) = {
            let state = app.state.read().unwrap();
            (
                state.inbox.clone(),
                state.orca.clone(),
                state.sessions.values().cloned().collect::<Vec<_>>(),
            )
        };
        let terms = array(&held["items"])
            .iter()
            .filter_map(|d| terminal(app, d))
            .collect::<std::collections::HashSet<_>>();
        let mut dirs = std::collections::HashSet::new();
        for term in array(&orca["terminals"])
            .iter()
            .filter(|t| terms.contains(text(&t["handle"])))
        {
            let p = text(&term["worktreePath"]).trim_end_matches('/');
            if !p.is_empty() {
                dirs.insert(p.to_owned());
            }
        }
        for item in array(&held["items"]) {
            let cwd = sessions
                .iter()
                .find(|s| s.id() == text(&item["card"]["session_id"]))
                .map(|s| text(&s.data["cwd"]))
                .filter(|p| !p.is_empty())
                .unwrap_or_else(|| text(&item["card"]["cwd"]));
            if !cwd.is_empty() {
                dirs.insert(cwd.trim_end_matches('/').to_owned());
            }
        }
        let hits = guard_hits(
            cmd,
            text(&b["terminal"]),
            text(&b["cwd"]),
            &terms,
            &dirs,
            array(&orca["workers"]),
        );
        return (
            200,
            if hits.is_empty() {
                obj()
            } else {
                json!({"deny":format!("이 명령은 메일함에 사용자가 확인할 결정이 남은 세션을 닫습니다 ({}). 후속 답변을 받을 수 있도록 세션을 유지하세요. 닫기가 필요하면 사용자에게 대시보드에서 직접 닫아 달라고 남기세요.",hits.join(", "))})
            },
        );
    }
    if action == "ask" {
        let permission = b.get("permission");
        if permission.is_none() && !questions(&b["questions"])
            || permission.is_some_and(|p| text(&p["command"]).trim().is_empty())
        {
            return error(400, "bad request");
        }
        let id = format!(
            "q{:x}{}",
            (now() * 1000.) as u64,
            &uuid::Uuid::new_v4().simple().to_string()[..6]
        );
        let cwd = text(&b["cwd"]);
        let mut card = json!({"id":id,"session_id":b["session_id"].as_str().filter(|s|!s.is_empty()),"tool_use_id":b["tool_use_id"],"agent":std::path::Path::new(cwd).file_name().map(|s|s.to_string_lossy()).unwrap_or("에이전트".into()),"cwd":cwd,"created_at":now()});
        if let Some(p) = permission {
            let cmd = text(&p["command"]);
            merge(
                &mut card,
                &json!({"kind":"permission","command":cmd.chars().take(4000).collect::<String>(),"title":"이 Bash 명령을 실행할까요?","context":short(text(&p["description"]),200),"tool_use_id":null,"questions":[{"question":format!("Bash 실행 허용? {}",short(cmd,160)),"header":"Bash 권한","multiSelect":false,"preview":false,"options":[{"label":"허용","description":"이번 한 번 실행합니다 (Yes)"},{"label":"거부","description":"실행하지 않습니다 (No)"}]}]}),
            );
        } else {
            card["questions"]=json!(array(&b["questions"]).iter().map(|q|json!({"question":q["question"],"header":q["header"].as_str().unwrap_or(""),"multiSelect":q["multiSelect"]==true,"preview":array(&q["options"]).iter().any(|o|!o["preview"].is_null()),"options":array(&q["options"]).iter().map(|o|json!({"label":o["label"],"description":o["description"].as_str().unwrap_or("")})).collect::<Vec<_>>()})).collect::<Vec<_>>());
        }
        let away =
            app.state.read().unwrap().prefs["decision_inbox"] == true && permission.is_none();
        let term = b["terminal"].as_str().filter(|h| valid_handle(h));
        if away {
            card["recommended"] = json!(
                array(&card["questions"])
                    .iter()
                    .map(recommended)
                    .collect::<Vec<_>>()
            );
            card["chosen"] = Value::Null;
            card["read"] = json!(false);
        }
        let mut s = app.state.write().unwrap();
        let target = if away { &mut s.inbox } else { &mut s.pending };
        if !target.is_object() {
            *target = obj();
        }
        if !target["items"].is_array() {
            target["items"] = json!([]);
        }
        target["items"]
            .as_array_mut()
            .unwrap()
            .push(json!({"card":card,"terminal":term,"state":"pending","busy":false}));
        drop(s);
        if let Err(e) = publish(app) {
            return error(500, e);
        }
        if away {
            if let Some(term) = term {
                let a = app.clone();
                let h = term.to_owned();
                std::thread::spawn(move || {
                    let workers = a.state.read().unwrap().orca["workers"].clone();
                    if let Some(w) = array(&workers)
                        .iter()
                        .find(|w| w["agentTerminalHandle"] == h)
                    {
                        let _ = orca(&[
                            "orchestration",
                            "worker-retain",
                            "--dispatch",
                            text(&w["dispatchId"]),
                        ]);
                    }
                });
            }
            return (
                200,
                json!({"id":id,"inbox":true,"deny":format!("사용자가 자리를 비워 이 질문을 에이전트 대시보드 메일함에 남겼습니다(메일함 모드). AskUserQuestion 을 다시 부르지 말고 권장 선택지나 가장 합리적인 판단으로 진행하세요. 진행 전에 정확히 한 줄로 선택을 남기세요: [메일함 {id}] 답. 나중에 후속 답변이 오므로 이 세션을 닫지 마세요. 권장 선택지: {}",array(&card["recommended"]).iter().map(text).collect::<Vec<_>>().join(" / "))}),
            );
        }
        return (200, json!({"id":id}));
    }
    let id = text(&b["id"]);
    if !rx(r"^[A-Za-z0-9_-]{1,64}$").is_match(id) {
        return error(400, "bad request");
    }
    if id.starts_with('c') && matches!(action, "answer" | "dismiss") {
        return canvas_post(app, action, id, &b["answers"]);
    }
    if action == "inbox" {
        return inbox_post(app, id, text(&b["action"]), &b["answers"]);
    }
    if action == "release" {
        return (200, json!({"ok":true}));
    }
    if action == "dismiss" {
        let found = settle(app, id, "cancelled");
        return if found {
            (200, json!({"ok":true}))
        } else {
            error(409, "이미 답했거나 닫힌 질문입니다")
        };
    }
    if action != "answer" || !b["answers"].is_array() {
        return error(400, "bad request");
    }
    let d = {
        let mut s = app.state.write().unwrap();
        let Some(d) = s.pending["items"].as_array_mut().and_then(|a| {
            a.iter_mut().find(|d| {
                d["card"]["id"] == id && (d["state"].is_null() || d["state"] == "pending")
            })
        }) else {
            return error(409, "이미 답했거나 닫힌 질문입니다");
        };
        if d["busy"] == true {
            return error(409, "이 질문의 답을 터미널에 입력하는 중입니다");
        }
        d["busy"] = json!(true);
        d.clone()
    };
    let ans = check_answers(&d["card"], &b["answers"]);
    let handle = terminal(app, &d);
    let result = match (ans, handle.as_deref()) {
        (Err(e), _) => error(400, e),
        (_, None) => error(
            409,
            "이 세션의 Orca 터미널을 찾지 못했습니다 — 터미널에서 답하세요",
        ),
        (Ok(ans), Some(h)) => match type_answers(h, &d["card"], &ans) {
            Ok(()) => {
                settle(app, id, "answered");
                (200, json!({"ok":true}))
            }
            Err(e) if e.starts_with("gone:") => {
                settle(app, id, "cancelled");
                (
                    410,
                    json!({"error":e.trim_start_matches("gone:"),"closed":true}),
                )
            }
            Err(e) => error(409, format!("{e} — 터미널에서 답하세요")),
        },
    };
    {
        let mut s = app.state.write().unwrap();
        if let Some(d) = s.pending["items"]
            .as_array_mut()
            .and_then(|a| a.iter_mut().find(|d| d["card"]["id"] == id))
        {
            d["busy"] = json!(false);
        }
    }
    if result.0 != 200 {
        let _ = append_json(
            app.config.data.join("decision.log"),
            &json!({"at":iso(),"id":id,"terminal":handle,"error":result.1["error"],"questions":d["card"]["questions"]}),
        );
    }
    result
}
fn settle(app: &App, id: &str, state: &str) -> bool {
    let mut s = app.state.write().unwrap();
    let Some(d) = s.pending["items"].as_array_mut().and_then(|a| {
        a.iter_mut()
            .find(|d| d["card"]["id"] == id && (d["state"].is_null() || d["state"] == "pending"))
    }) else {
        return false;
    };
    d["state"] = json!(state);
    d["settled"] = json!(now());
    drop(s);
    let _ = publish(app);
    true
}
fn inbox_post(app: &App, id: &str, action: &str, answers: &Value) -> Response {
    if !["read", "unread", "delete", "answer"].contains(&action) {
        return error(400, "bad request");
    }
    let d = app.state.read().unwrap().inbox["items"]
        .as_array()
        .and_then(|a| a.iter().find(|d| d["card"]["id"] == id))
        .cloned();
    let Some(d) = d else {
        return error(404, "메일함에 없는 항목입니다");
    };
    if action == "answer" {
        let Some(h) = terminal(app, &d) else {
            return error(409, "이 세션의 Orca 터미널을 찾지 못했습니다");
        };
        if array(answers).len() != array(&d["card"]["questions"]).len()
            || !array(answers).iter().any(|a| !a.is_null())
        {
            return error(400, "고른 답이 없습니다");
        }
        let mut parts = vec![];
        for (q, a) in array(&d["card"]["questions"]).iter().zip(array(answers)) {
            if a.is_null() {
                continue;
            }
            let picks = if a.is_array() {
                array(a).to_vec()
            } else {
                vec![a.clone()]
            };
            if picks.is_empty() || picks.iter().any(|a| !typed(text(a))) {
                return error(400, "보낼 수 없는 답입니다");
            }
            parts.push(format!(
                "「{}」에 {}",
                short(text(&q["question"]), 80),
                picks.iter().map(text).collect::<Vec<_>>().join(", ")
            ));
        }
        let went = d["card"]["chosen"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| {
                array(&d["card"]["recommended"])
                    .iter()
                    .map(text)
                    .collect::<Vec<_>>()
                    .join(" / ")
            });
        let msg = format!(
            "[대시보드 메일함 {id}] 앞서 {went} (으)로 진행했지만 사용자는 {} 를 골랐습니다. 반영하세요.",
            parts.join("; ")
        );
        if let Err(e) = orca(&[
            "terminal",
            "send",
            "--terminal",
            &h,
            "--text",
            &msg,
            "--enter",
        ]) {
            return error(502, e);
        }
    }
    let mut s = app.state.write().unwrap();
    if let Some(items) = s.inbox["items"].as_array_mut() {
        if matches!(action, "delete" | "answer") {
            items.retain(|d| d["card"]["id"] != id);
        } else if let Some(d) = items.iter_mut().find(|d| d["card"]["id"] == id) {
            d["card"]["read"] = json!(action == "read");
        }
    }
    drop(s);
    match publish(app) {
        Ok(()) => (200, json!({"ok":true})),
        Err(e) => error(500, e),
    }
}
fn typed(s: &str) -> bool {
    !s.is_empty() && s.chars().count() <= 500 && !s.chars().any(|c| c < ' ' || c == '\x7f')
}
pub fn check_answers(card: &Value, answers: &Value) -> Result<Value> {
    if array(answers).len() != array(&card["questions"]).len() {
        return Err("답하지 않은 질문이 있습니다".into());
    }
    if card["kind"] == "permission" {
        return if array(answers).len() == 1 && ["허용", "거부"].contains(&text(&answers[0])) {
            Ok(answers.clone())
        } else {
            Err("허용 또는 거부만 고를 수 있습니다".into())
        };
    }
    let mut out = vec![];
    for (q, a) in array(&card["questions"]).iter().zip(array(answers)) {
        let multi = q["multiSelect"] == true;
        let picks = if multi {
            a.as_array().cloned().ok_or("답하지 않은 질문이 있습니다")?
        } else {
            vec![a.clone()]
        };
        if picks.is_empty()
            || picks
                .iter()
                .any(|p| p.as_str().is_none_or(|s| s.trim().is_empty()))
        {
            return Err("답하지 않은 질문이 있습니다".into());
        }
        let mut picks = picks
            .iter()
            .map(|p| text(p).trim().to_owned())
            .collect::<Vec<_>>();
        picks.dedup();
        let labels = array(&q["options"])
            .iter()
            .map(|o| text(&o["label"]))
            .collect::<Vec<_>>();
        let free = picks
            .iter()
            .filter(|p| !labels.contains(&p.as_str()))
            .collect::<Vec<_>>();
        if labels.len() + 1 > 9
            || free.len() > if q["preview"] == true { 0 } else { 1 }
            || free.iter().any(|s| !typed(s))
        {
            return Err("이 답은 대시보드에서 넣을 수 없습니다".into());
        }
        out.push(if multi { json!(picks) } else { json!(picks[0]) });
    }
    Ok(json!(out))
}
fn compact(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}
fn screen(h: &str) -> Result<Vec<String>> {
    let t = orca(&["terminal", "read", "--terminal", h, "--screen"])?;
    let t = &t["terminal"];
    if t["source"] != "screen" {
        return Err("터미널 화면을 읽지 못했습니다".into());
    }
    Ok(if t["tail"].is_array() {
        array(&t["tail"]).iter().map(|v| text(v).into()).collect()
    } else {
        text(&t["tail"]).lines().map(str::to_owned).collect()
    })
}
pub fn picker_state(lines: &[String], card: &Value) -> Value {
    if lines
        .iter()
        .rev()
        .take(12)
        .any(|s| s.contains("Ready to submit your answers?"))
    {
        return json!({"kind":"review"});
    }
    let Some(foot) = lines.iter().rposition(|s| s.contains("Esc to cancel")) else {
        return json!({"kind":"gone","answered":lines.iter().any(|s|s.contains("User answered Claude's question"))});
    };
    if card["kind"] == "permission" {
        let title = lines[..foot]
            .iter()
            .rposition(|s| s.trim() == "Bash command");
        let Some(title) = title else {
            return json!({"kind":"other"});
        };
        let head = lines[..foot]
            .iter()
            .rposition(|s| s.contains("Do you want to proceed?"))
            .unwrap_or(title);
        if !compact(&lines[title..head.max(title) + 1].join("")).contains(
            &compact(text(&card["command"]))
                .chars()
                .take(40)
                .collect::<String>(),
        ) {
            return json!({"kind":"other"});
        }
        let rows = rows(&lines[head + 1..foot]);
        return json!({"kind":if rows.0.as_object().is_none_or(|r|r.is_empty()){"other"}else{"prompt"},"rows":rows.0});
    }
    let Some(head) = lines[..=foot]
        .iter()
        .rposition(|s| s.contains('☐') || s.contains('☒'))
    else {
        return json!({"kind":"other"});
    };
    let body = &lines[head + 1..foot];
    let first = body
        .iter()
        .position(|s| rx(r"^\s*(❯)?\s*1\.\s").is_match(s));
    let Some(first) = first else {
        return json!({"kind":"other"});
    };
    let question = compact(
        &body[..first]
            .iter()
            .map(|s| s.trim_start().trim_start_matches('│'))
            .collect::<Vec<_>>()
            .join(""),
    );
    let qi = array(&card["questions"])
        .iter()
        .position(|q| compact(text(&q["question"])) == question);
    if qi.is_none() {
        return json!({"kind":"other"});
    }
    let (rows, cursor) = rows(body);
    json!({"kind":"question","qi":qi,"answered":lines[head].contains('☒'),"rows":rows,"cursor":cursor})
}
fn rows(lines: &[String]) -> (Value, Option<u64>) {
    let mut rows = obj();
    let mut cursor = None;
    for ln in lines {
        if let Some(c) = rx(r"^\s*(❯)?\s*(\d)\.\s(?:\[(.)\]\s)?(.*)$").captures(ln) {
            let n = &c[2];
            if rows[n].is_null() {
                rows[n] = json!([c[4].trim(), c.get(3).is_some_and(|m| m.as_str() != " ")]);
                if c.get(1).is_some() {
                    cursor = n.parse().ok();
                }
            }
        }
    }
    (rows, cursor)
}
fn press(h: &str, key: &str) -> Result<()> {
    orca(&["terminal", "send", "--terminal", h, "--text", key])?;
    std::thread::sleep(Duration::from_millis(150));
    Ok(())
}
fn until(h: &str, card: &Value, p: impl Fn(&Value) -> bool) -> Result<Value> {
    let end = now() + 4.;
    loop {
        let st = picker_state(&screen(h)?, card);
        if p(&st) {
            return Ok(st);
        }
        if now() > end {
            return Err("터미널의 선택기 상태가 예상과 다릅니다".into());
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}
fn type_answers(h: &str, card: &Value, answers: &Value) -> Result<()> {
    let st = picker_state(&screen(h)?, card);
    if st["kind"] == "gone" {
        return Err("gone:터미널에 이 질문의 선택기가 없습니다".into());
    }
    if card["kind"] == "permission" {
        if st["kind"] != "prompt" {
            return Err("터미널에 이 명령의 권한 요청이 떠 있지 않습니다".into());
        }
        let yes = answers[0] == "허용";
        let key = st["rows"]
            .as_object()
            .and_then(|r| {
                r.iter().find(|(_, v)| {
                    if yes {
                        text(&v[0]) == "Yes"
                    } else {
                        text(&v[0]) == "No" || text(&v[0]).starts_with("No,")
                    }
                })
            })
            .map(|(k, _)| k)
            .ok_or("권한 요청의 선택지를 찾지 못했습니다")?;
        press(h, key)?;
        until(h, card, |s| s["kind"] != "prompt")?;
        std::thread::sleep(Duration::from_millis(300));
        until(h, card, |s| s["kind"] != "prompt")?;
        return Ok(());
    }
    if st["kind"] != "question"
        || st["qi"] != 0
        || st["answered"] == true
        || st["rows"]
            .as_object()
            .is_some_and(|r| r.values().any(|v| v[1] == true))
    {
        return Err("터미널에서 이미 답하기 시작했거나 다른 질문입니다".into());
    }
    for (i, (q, a)) in array(&card["questions"])
        .iter()
        .zip(array(answers))
        .enumerate()
    {
        let labels = array(&q["options"])
            .iter()
            .map(|o| text(&o["label"]))
            .collect::<Vec<_>>();
        let multi = q["multiSelect"] == true;
        let picks = if multi {
            array(a).to_vec()
        } else {
            vec![a.clone()]
        };
        let mut free = None;
        let mut want = vec![];
        for p in &picks {
            if let Some(n) = labels.iter().position(|l| *l == text(p)) {
                press(h, &(n + 1).to_string())?;
                want.push((n + 1).to_string());
            } else {
                free = Some(text(p));
                want.push((labels.len() + 1).to_string());
            }
        }
        if let Some(s) = free {
            if multi {
                let cur = picker_state(&screen(h)?, card)["cursor"]
                    .as_u64()
                    .unwrap_or(1) as usize;
                for _ in cur..=labels.len() {
                    press(h, "\x1b[B")?;
                }
            } else {
                press(h, &(labels.len() + 1).to_string())?;
            }
            until(h, card, |s| {
                s["kind"] == "question" && s["qi"] == i && s["cursor"] == labels.len() + 1
            })?;
            press(h, s)?;
            until(h, card, |st| {
                st["kind"] == "question"
                    && st["qi"] == i
                    && compact(s).starts_with(&compact(text(
                        &st["rows"][&(labels.len() + 1).to_string()][0],
                    )))
            })?;
        }
        if multi {
            until(h, card, |s| {
                s["kind"] == "question"
                    && s["qi"] == i
                    && s["rows"].as_object().is_some_and(|r| {
                        r.iter()
                            .filter(|(_, v)| v[1] == true)
                            .map(|(k, _)| k)
                            .collect::<std::collections::BTreeSet<_>>()
                            == want.iter().collect()
                    })
            })?;
            if free.is_some() {
                press(h, "\x1b[A")?;
            }
            press(h, "\x1b[C")?;
        } else if free.is_some() || q["preview"] == true {
            press(h, "\r")?;
        }
        let last = i + 1 == array(&card["questions"]).len();
        let st = until(h, card, |s| {
            s["kind"] == "question" && s["qi"].as_u64().is_some_and(|n| n > i as u64)
                || last && (s["kind"] == "review" || s["kind"] == "gone" && s["answered"] == true)
        })?;
        if last && st["kind"] == "review" {
            press(h, "1")?;
            until(h, card, |s| s["kind"] == "gone" && s["answered"] == true)?;
        }
    }
    Ok(())
}
pub fn canvas_port() -> u16 {
    std::env::var("WORKFLOW_CANVAS_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(4318)
}
fn client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .unwrap()
}
fn canvas_sweep(app: &App) {
    if std::net::TcpStream::connect_timeout(
        &format!("127.0.0.1:{}", canvas_port()).parse().unwrap(),
        Duration::from_millis(300),
    )
    .is_err()
    {
        app.state.write().unwrap().canvas = json!([]);
        return;
    }
    use sha1::{Digest, Sha1};
    let Ok(r) = client()
        .get(format!("http://127.0.0.1:{}/api/decisions", canvas_port()))
        .send()
    else {
        return;
    };
    let Ok(d) = r.json::<Value>() else { return };
    let old = app.state.read().unwrap().canvas.clone();
    let mut cards = vec![];
    for d in array(&d["decisions"]) {
        let key = ["workflowId", "executionId", "node"]
            .map(|k| text(&d[k]))
            .join("\n");
        let id = format!("c{:x}", Sha1::digest(key.as_bytes()))[..21].to_owned();
        let old = array(&old).iter().find(|o| o["card"]["id"] == id);
        let options = array(&d["outputs"])
            .iter()
            .filter(|o| o["id"].is_string())
            .collect::<Vec<_>>();
        let card = json!({"id":id,"kind":"canvas","session_id":null,"tool_use_id":null,"agent":d["workflowName"].as_str().unwrap_or("워크플로"),"cwd":"","created_at":old.map(|o|number(&o["card"]["created_at"])).unwrap_or_else(now),"context":format!("{} · {}",d["workflowName"].as_str().unwrap_or(text(&d["workflowId"])),d["executionLabel"].as_str().unwrap_or(text(&d["executionId"]))),"questions":[{"question":d["question"].as_str().or(d["label"].as_str()).unwrap_or(text(&d["node"])),"header":d["label"],"multiSelect":d["mode"]!="exclusive","preview":false,"options":options.iter().map(|o|json!({"label":o["label"].as_str().unwrap_or(text(&o["id"])),"description":""})).collect::<Vec<_>>()}],"canvas":{"workflow":d["workflowId"],"execution":d["executionId"],"node":d["node"],"outputs":options.iter().map(|o|&o["id"]).collect::<Vec<_>>(),"task":d["taskId"],"run":d["runId"]}});
        cards.push(json!({"card":card,"hidden":old.is_some_and(|o|o["hidden"]==true)}));
    }
    app.state.write().unwrap().canvas = json!(cards);
}
fn canvas_post(app: &App, action: &str, id: &str, answers: &Value) -> Response {
    let d = app
        .state
        .read()
        .unwrap()
        .canvas
        .as_array()
        .and_then(|a| {
            a.iter()
                .find(|d| d["card"]["id"] == id && d["hidden"] != true)
        })
        .cloned();
    let Some(d) = d else {
        return error(409, "이미 결정했거나 닫힌 결정입니다");
    };
    if action == "answer" {
        let q = &d["card"]["questions"][0];
        let picks = if q["multiSelect"] == true {
            array(&answers[0]).to_vec()
        } else {
            vec![answers[0].clone()]
        };
        let mut outputs = vec![];
        for p in picks {
            let Some(i) = array(&q["options"]).iter().position(|o| o["label"] == p) else {
                return error(400, "선택지에 있는 출력만 고를 수 있습니다");
            };
            outputs.push(d["card"]["canvas"]["outputs"][i].clone());
        }
        if outputs.is_empty() {
            return error(400, "선택지에 있는 출력만 고를 수 있습니다");
        }
        let c = &d["card"]["canvas"];
        let mut url = reqwest::Url::parse(&format!(
            "http://127.0.0.1:{}/api/workflows/",
            canvas_port()
        ))
        .unwrap();
        url.path_segments_mut()
            .unwrap()
            .pop_if_empty()
            .push(text(&c["workflow"]))
            .push("executions")
            .push(text(&c["execution"]))
            .push("decisions");
        match client()
            .post(url)
            .json(&json!({"node":c["node"],"outputs":outputs,"by":"user","via":"대시보드"}))
            .send()
        {
            Err(e) => return error(502, e.to_string()),
            Ok(r) if !r.status().is_success() => {
                return error(
                    if r.status().as_u16() == 409 { 410 } else { 502 },
                    "캔버스가 결정을 거절했습니다",
                );
            }
            _ => {}
        }
    }
    let mut s = app.state.write().unwrap();
    if let Some(d) = s
        .canvas
        .as_array_mut()
        .and_then(|a| a.iter_mut().find(|d| d["card"]["id"] == id))
    {
        d["hidden"] = json!(true);
    }
    drop(s);
    let _ = publish(app);
    (200, json!({"ok":true}))
}

pub fn guard_hits(
    command: &str,
    own: &str,
    own_cwd: &str,
    terms: &std::collections::HashSet<String>,
    dirs: &std::collections::HashSet<String>,
    workers: &[Value],
) -> Vec<String> {
    let words = shell_words::split(command)
        .unwrap_or_else(|_| command.split_whitespace().map(str::to_owned).collect());
    let worktree_hit = |sel: &str| {
        let (kind, val) = sel.split_once(':').unwrap_or((sel, ""));
        if matches!(kind, "active" | "current") && val.is_empty() {
            return dirs
                .iter()
                .any(|d| own_cwd == d || own_cwd.starts_with(&format!("{d}/")));
        }
        let val = val
            .rsplit("::")
            .next()
            .unwrap_or("")
            .trim_start_matches("refs/heads/")
            .trim_end_matches('/');
        if val.is_empty() {
            return false;
        }
        dirs.iter().any(|d| {
            if kind == "path" {
                real(val) == real(d)
            } else {
                d.contains(val)
            }
        })
    };
    let mut hits = vec![];
    for cmd in words.split(|w| matches!(w.as_str(), ";" | "&&" | "||" | "|" | "&")) {
        let Some(i) = cmd.iter().position(|s| {
            std::path::Path::new(s)
                .file_name()
                .is_some_and(|p| p == "orca")
        }) else {
            continue;
        };
        let args = cmd[i + 1..]
            .iter()
            .flat_map(|w| {
                if w.starts_with("--") {
                    w.splitn(2, '=').collect::<Vec<_>>()
                } else {
                    vec![w.as_str()]
                }
            })
            .collect::<Vec<_>>();
        let opt = |name: &str| args.windows(2).find(|w| w[0] == name).map(|w| w[1]);
        if args.starts_with(&["terminal", "close"]) {
            if let Some(sel) = opt("--worktree") {
                if worktree_hit(sel) {
                    hits.push(sel.into());
                }
            } else {
                let term = opt("--terminal").unwrap_or(own);
                if terms.contains(term) {
                    hits.push(term.into());
                }
            }
        }
        if args.starts_with(&["worktree", "rm"]) {
            if let Some(sel) = opt("--worktree") {
                if worktree_hit(sel) {
                    hits.push(sel.into());
                }
            }
        }
        if args.first() == Some(&"orchestration")
            && args
                .iter()
                .any(|w| matches!(*w, "worker-stop" | "worker-release" | "worker-abandon"))
        {
            if let Some(id) = opt("--dispatch") {
                if workers.iter().any(|w| {
                    w["dispatchId"] == id && terms.contains(text(&w["agentTerminalHandle"]))
                }) {
                    hits.push(id.into());
                }
            }
        }
    }
    hits
}
