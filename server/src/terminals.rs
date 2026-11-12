use crate::{
    app::App,
    core::*,
    sessions::{rx, valid_handle},
};
use serde_json::{Value, json};
pub fn invoke(args: &[&str], timeout: u64) -> Result<Value> {
    orca_timeout(args, timeout)
}
pub fn places() -> Result<Value> {
    let rs = orca(&["repo", "list"])?;
    let ws = orca(&["worktree", "list"])?;
    Ok(
        json!({"repos":array(&rs["repos"]).iter().filter(|r|r["kind"].is_null()||r["kind"]=="git").map(|r|json!({"id":r["id"],"name":r["displayName"].as_str().unwrap_or(text(&r["path"])),"path":r["path"]})).collect::<Vec<_>>(),"worktrees":array(&ws["worktrees"]).iter().filter(|w|w["isArchived"]!=true).map(|w|json!({"id":w["id"],"repo":w["repoId"],"name":w["displayName"].as_str().unwrap_or(text(&w["path"])),"path":w["path"],"branch":text(&w["branch"]).trim_start_matches("refs/heads/"),"main":w["isMainWorktree"]==true})).collect::<Vec<_>>()}),
    )
}
pub fn check_launch(b: &Value, p: &Value) -> Result<(Vec<String>, String, String)> {
    let kind = text(&b["kind"]);
    let agent = b["agent"].as_str().unwrap_or("claude");
    let prompt = text(&b["prompt"]).trim();
    let title = text(&b["title"]).trim();
    let model = text(&b["model"]);
    let effort = text(&b["effort"]);
    if !["worktree", "agent"].contains(&kind) || !["claude", "codex"].contains(&agent) {
        return Err("잘못된 요청입니다".into());
    }
    if prompt.chars().count() > 20000 || title.chars().count() > 60 {
        return Err("프롬프트는 20000자, 탭 이름은 60자까지입니다".into());
    }
    if !model.is_empty() && !rx(r"^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,79}$").is_match(model) {
        return Err("모델 id 에 쓸 수 없는 문자가 있습니다".into());
    }
    if !effort.is_empty()
        && (model.is_empty() || !["low", "medium", "high", "xhigh", "max"].contains(&effort))
    {
        return Err("effort 는 모델을 고른 때만 줄 수 있습니다".into());
    }
    let (mut args, name, where_) = if kind == "worktree" {
        let name = text(&b["name"]);
        if !rx(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$").is_match(name) {
            return Err("워크트리 이름은 영문·숫자·.-_ 로 60자까지입니다".into());
        }
        let r = array(&p["repos"])
            .iter()
            .find(|r| r["id"] == b["repo"])
            .ok_or("Orca 에 등록된 저장소가 아닙니다")?;
        if array(&p["worktrees"])
            .iter()
            .any(|w| w["repo"] == r["id"] && w["name"] == name)
        {
            return Err("워크트리가 이미 있습니다".into());
        }
        (
            vec![
                "worktree".into(),
                "create".into(),
                "--repo".into(),
                format!("id:{}", text(&r["id"])),
                "--name".into(),
                name.into(),
                "--no-parent".into(),
                "--setup".into(),
                "run".into(),
            ],
            name.to_owned(),
            format!("{} / {name}", text(&r["name"])),
        )
    } else {
        let w = array(&p["worktrees"])
            .iter()
            .find(|w| w["id"] == b["worktree"])
            .ok_or("Orca 에 있는 워크트리가 아닙니다")?;
        (
            vec![
                "agent".into(),
                "launch".into(),
                "--worktree".into(),
                format!("id:{}", text(&w["id"])),
            ],
            text(&w["name"]).to_owned(),
            text(&w["name"]).to_owned(),
        )
    };
    args.extend([
        "--agent".into(),
        agent.into(),
        "--surface".into(),
        "terminal".into(),
    ]);
    if !prompt.is_empty() {
        args.extend(["--prompt".into(), prompt.into()]);
    }
    if !model.is_empty() {
        args.extend(["--model".into(), model.into()]);
        if !effort.is_empty() {
            args.extend(["--effort".into(), effort.into()]);
        }
    }
    Ok((
        args,
        if title.is_empty() { name } else { title.into() },
        where_,
    ))
}
pub fn start_launch(app: &App, args: Vec<String>, label: String, where_: String) -> String {
    let id = format!(
        "launch-{}-{}",
        (now() * 1000.) as u64,
        &uuid::Uuid::new_v4().simple().to_string()[..6]
    );
    app.state.write().unwrap().jobs[&id] = json!({"id":id,"kind":"launch","label":label,"where":where_,"total":1,"done":0,"closed":[],"failed":[],"state":"running","started":now()});
    let a = app.clone();
    let jid = id.clone();
    std::thread::spawn(move || {
        let args = args.iter().map(String::as_str).collect::<Vec<_>>();
        let result = invoke(&args, 300);
        let mut s = a.state.write().unwrap();
        match result {
            Ok(r) => {
                let launch = r.get("launch").unwrap_or(&r);
                let h = launch["outcome"]["handle"]
                    .as_str()
                    .or(r["agentTerminalHandle"].as_str())
                    .or(r["startupTerminal"]["handle"].as_str())
                    .map(str::to_owned);
                if let Some(h) = &h {
                    s.launched.insert(h.clone());
                }
                let job = &mut s.jobs[&jid];
                merge(
                    job,
                    &json!({"state":"done","finished":now(),"done":1,"handle":h,"note":null,"closed":h.as_ref().map(|h|vec![h]).unwrap_or_default()}),
                );
                drop(s);
                if let Some(h) = h {
                    let _ = orca(&["terminal", "rename", "--terminal", &h, "--title", &label]);
                }
            }
            Err(e) => {
                merge(
                    &mut s.jobs[&jid],
                    &json!({"state":"done","finished":now(),"done":1,"handle":null,"failed":[{"handle":null,"error":short(&e,300)}]}),
                );
            }
        }
    });
    id
}
fn close(h: &str) -> Result<()> {
    let mut last = String::new();
    for _ in 0..2 {
        match invoke(&["terminal", "close", "--terminal", h], 30) {
            Ok(_) => return Ok(()),
            Err(e) => last = e,
        }
        match invoke(&["terminal", "list"], 30) {
            Ok(d) => {
                if !array(&d["terminals"])
                    .iter()
                    .any(|t| t["handle"] == h && t["connected"] == true)
                {
                    return Ok(());
                }
            }
            Err(_) => return Err(format!("{last} · 닫혔는지 확인 못 함")),
        }
    }
    Err(last)
}
pub fn action(app: &App, action: &str, b: &Value) -> (u16, Value) {
    let error = |code, s: String| (code, json!({"error":s}));
    if action == "launch" {
        let p = match places() {
            Ok(p) => p,
            Err(e) => return error(502, e),
        };
        return match check_launch(b, &p) {
            Ok((args, label, where_)) => {
                let id = start_launch(app, args, label.clone(), where_);
                (202, json!({"ok":true,"job":id,"label":label}))
            }
            Err(e) => error(400, e),
        };
    }
    let h = text(&b["handle"]);
    if !valid_handle(h) {
        return error(400, "bad request".into());
    }
    let s = app.state.read().unwrap();
    let connected = array(&s.orca["terminals"])
        .iter()
        .any(|t| t["handle"] == h && t["connected"] == true);
    let sm = s.summaries.iter().find(|sm| sm["orca_focus"] == h);
    let known = connected
        && if action == "close" {
            sm.is_some()
        } else if action == "send" {
            sm.is_some() || s.launched.contains(h)
        } else {
            true
        };
    if !known {
        return error(404, "Orca 에 연결된 세션 터미널이 아닙니다".into());
    }
    let below = if b["cascade"] == true {
        sm.map(|sm| array(&sm["orca_close_tree"]).to_vec())
            .unwrap_or_default()
    } else {
        vec![]
    };
    drop(s);
    if action == "send" {
        let text = text(&b["text"]).trim();
        if text.is_empty() || text.chars().count() > 20000 {
            return error(400, "보낼 프롬프트가 없거나 20000자를 넘습니다".into());
        }
        return match invoke(
            &[
                "terminal",
                "send",
                "--terminal",
                h,
                "--text",
                text,
                "--enter",
                "--wait-submit",
                "5",
            ],
            25,
        ) {
            Ok(r) => {
                let send = r.get("send").unwrap_or(&r);
                (
                    200,
                    json!({"ok":true,"started":array(&send["prompt"]["stages"]).contains(&json!("turn_started"))}),
                )
            }
            Err(e) => error(if e.contains("timed out") { 504 } else { 502 }, e),
        };
    }
    if action == "focus" {
        return match invoke(&["terminal", "switch", "--terminal", h], 30) {
            Ok(_) => {
                let _ = command("open", &["-a", "Orca"], None, 5);
                (200, json!({"ok":true}))
            }
            Err(e) => error(if e.contains("timed out") { 504 } else { 502 }, e),
        };
    }
    if action != "close" || b.get("cascade").is_some_and(|v| !v.is_boolean()) {
        return error(400, "bad request".into());
    }
    let id = format!(
        "close-{}-{}",
        (now() * 1000.) as u64,
        &uuid::Uuid::new_v4().simple().to_string()[..6]
    );
    let mut targets = below.iter().map(|h| text(h).to_owned()).collect::<Vec<_>>();
    targets.push(h.into());
    let total = targets.len();
    app.state.write().unwrap().jobs[&id] = json!({"id":id,"handle":h,"total":total,"done":0,"closed":[],"failed":[],"state":"running","started":now()});
    let a = app.clone();
    let jid = id.clone();
    std::thread::spawn(move || {
        for h in targets {
            let result = close(&h);
            let mut s = a.state.write().unwrap();
            let job = &mut s.jobs[&jid];
            job["done"] = json!(number(&job["done"]) + 1.);
            match result {
                Ok(()) => {
                    job["closed"].as_array_mut().unwrap().push(json!(h));
                    if let Some(ts) = s.orca["terminals"].as_array_mut() {
                        ts.retain(|t| t["handle"] != h);
                    }
                }
                Err(e) => job["failed"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"handle":h,"error":e})),
            }
        }
        let mut s = a.state.write().unwrap();
        merge(&mut s.jobs[&jid], &json!({"state":"done","finished":now()}));
        s.jobs
            .as_object_mut()
            .unwrap()
            .retain(|_, j| j["state"] != "done" || now() - number(&j["finished"]) < 600.);
    });
    (202, json!({"ok":true,"job":id,"total":total}))
}
