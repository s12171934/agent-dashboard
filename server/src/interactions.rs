use crate::{app::App, core::*, impl_progress::canvas_dir};
use serde_json::{Value, json};
use sha1::{Digest, Sha1};
use std::{collections::HashMap, fs};
pub fn collect(app: &App, limit: usize, hb: bool) -> Result<Value> {
    let raw = orca(&[
        "orchestration",
        "inbox",
        "--limit",
        &(if hb { limit } else { limit * 3 }).to_string(),
    ])?;
    let (state, prefs) = {
        let s = app.state.read().unwrap();
        (s.orca.clone(), s.prefs.clone())
    };
    let mut dispatch = HashMap::new();
    for w in array(&state["workers"]) {
        dispatch.insert(
            text(&w["dispatchId"]).to_owned(),
            w["agentTerminalHandle"].clone(),
        );
    }
    let coords = array(&state["runs"])
        .iter()
        .map(|r| (text(&r["id"]).to_owned(), r["coordinator_handle"].clone()))
        .collect::<HashMap<_, _>>();
    let mut messages = vec![];
    for m in array(&raw["messages"]) {
        if !hb && m["type"] == "heartbeat" {
            continue;
        }
        let p = if let Some(p) = m["payload"].as_str() {
            serde_json::from_str::<Value>(p).unwrap_or(Value::Null)
        } else {
            m["payload"].clone()
        };
        if p["dispatchId"].is_string() && text(&m["from_handle"]).starts_with("term_") {
            dispatch
                .entry(text(&p["dispatchId"]).into())
                .or_insert(m["from_handle"].clone());
        }
        let body = text(&m["body"]);
        messages.push(json!({"id":m["id"],"run_id":m["run_id"],"type":m["type"],"priority":m["priority"],"thread_id":m["thread_id"],"subject":m["subject"],"body":body.chars().take(6000).collect::<String>(),"cut":body.chars().count()>6000,"from":m["from_handle"],"to":m["to_handle"],"task_id":p["taskId"],"outcome":p["outcome"],"phase":p["phase"],"question":p["question"],"files":p["filesModified"].as_array().cloned().unwrap_or_default(),"read":m["read"]==true,"created_at":m["created_at"]}));
        if messages.len() >= limit {
            break;
        }
    }
    for qs in array(&prefs["qa_sets"]) {
        for r in read_lines(expand(text(&qs["watch"])).join("log/tell.jsonl"))
            .into_iter()
            .rev()
            .take(limit)
        {
            if !r["to"].is_string() {
                continue;
            }
            let body = text(&r["body"]);
            let typ = text(&r["type"]);
            messages.push(json!({"id":format!("tell_{:x}",Sha1::digest(r.to_string().as_bytes()))[..17].to_owned(),"run_id":null,"type":if ["question","escalation","status","dispatch"].contains(&typ){typ}else{"status"},"priority":"normal","thread_id":null,"subject":r["subject"],"body":body.chars().take(6000).collect::<String>(),"cut":body.chars().count()>6000,"from":r["from"],"to":r["to"],"task_id":null,"outcome":null,"phase":null,"question":null,"files":[],"read":true,"created_at":r["at"],"via":"terminal","kind":r["type"],"key":r["key"],"failed":r["ok"]==false}));
        }
    }
    let root = canvas_dir(app);
    let mut dirs = fs::read_dir(root)
        .map(|e| e.flatten().map(|e| e.path()).collect::<Vec<_>>())
        .unwrap_or_default();
    dirs.sort();
    for d in dirs.into_iter().rev().take(40) {
        let m = read_json(d.join("meta.json"));
        let wf = text(&m["workflowId"]);
        if wf.is_empty() {
            continue;
        }
        let coord = m["coordinatorTerminal"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| format!("run:{}", text(&m["runId"])));
        let canvas = format!("canvas:{wf}");
        let name = d.file_name().unwrap_or_default().to_string_lossy();
        let events = read_lines(d.join("events.jsonl"));
        for (i, e) in events.iter().enumerate() {
            let kind = text(&e["type"]);
            let (typ, label, back) = match kind {
                "registered" => ("status", "실행 등록", false),
                "note" => ("status", "메모", false),
                "worker" => ("status", "워커 보고", false),
                "gate" => ("question", "게이트", false),
                "error" => ("escalation", "오류", false),
                "report" => ("worker_done", "마무리 보고", false),
                "coordinator-closed" => ("status", "코디네이터 종료", true),
                "finished" => ("status", "전체 종료", true),
                "requested" | "coordinator" => ("dispatch", "실행 지시", true),
                _ => continue,
            };
            let body = text(&e["message"]);
            messages.push(json!({"id":format!("canvas_{name}_{i}"),"run_id":m["runId"],"type":typ,"priority":"normal","subject":format!("{label} · {}",short(body,80)),"body":body.chars().take(6000).collect::<String>(),"cut":body.chars().count()>6000,"from":if back{&canvas}else{&coord},"to":if back{&coord}else{&canvas},"read":true,"via":"canvas","canvas_name":m["workflowName"].as_str().unwrap_or(wf),"launch":name,"created_at":e["at"],"kind":kind,"files":[]}));
        }
    }
    let term = |addr: &str| {
        if let Some(id) = addr.strip_prefix("run:") {
            (coords.get(id).cloned().unwrap_or(Value::Null), "run")
        } else if let Some(id) = addr.strip_prefix("dispatch:") {
            (dispatch.get(id).cloned().unwrap_or(Value::Null), "dispatch")
        } else if addr.starts_with("term_") {
            (json!(addr), "term")
        } else if addr.starts_with("canvas:") {
            (Value::Null, "canvas")
        } else {
            (Value::Null, "other")
        }
    };
    for m in &mut messages {
        let (ft, fk) = term(text(&m["from"]));
        let (tt, tk) = term(text(&m["to"]));
        merge(
            m,
            &json!({"from_term":ft,"from_kind":fk,"to_term":tt,"to_kind":tk}),
        );
    }
    messages.sort_by(|a, b| text(&b["created_at"]).cmp(text(&a["created_at"])));
    messages.truncate(limit);
    Ok(json!({"messages":messages,"fetched":array(&raw["messages"]).len()}))
}
pub fn canvas_info(local: bool) -> Value {
    let port = crate::decisions::canvas_port();
    let up = std::net::TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().unwrap(),
        std::time::Duration::from_millis(500),
    )
    .is_ok();
    if local {
        return json!({"url":format!("http://127.0.0.1:{port}/"),"up":up,"error":null});
    }
    let mut url = None;
    for cli in [
        "tailscale",
        "/opt/homebrew/bin/tailscale",
        "/usr/local/bin/tailscale",
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    ] {
        let result = command(
            "env",
            &["TAILSCALE_BE_CLI=1", cli, "serve", "status", "--json"],
            None,
            5,
        );
        if let Ok(s) = result {
            let d = serde_json::from_str::<Value>(&s).unwrap_or(Value::Null);
            for (host, c) in d["Web"].as_object().into_iter().flat_map(|o| o.iter()) {
                let p = text(&c["Handlers"]["/"]["Proxy"]).trim_end_matches('/');
                if p == format!("http://127.0.0.1:{port}")
                    || p == format!("http://localhost:{port}")
                {
                    url = Some(format!("https://{}/", host.trim_end_matches(":443")));
                    break;
                }
            }
            break;
        }
    }
    json!({"url":url,"up":up,"error":if url.is_none(){json!(format!("tailscale serve 에 캔버스가 없습니다. 이 Mac 에서 `tailscale serve --bg --https={port} http://127.0.0.1:{port}` 를 실행하세요"))}else{Value::Null}})
}

pub fn get(app: &App, limit: usize, hb: bool) -> Result<Value> {
    let a = app.clone();
    cached_json(
        format!("interactions:{}:{limit}:{hb}", app.config.data.display()),
        3.,
        false,
        move || collect(&a, limit, hb),
    )
}
