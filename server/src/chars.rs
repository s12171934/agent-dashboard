use crate::{app::App, core::*, sessions::rx, terminals};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
};
const BUILTIN: [&str; 5] = ["ren", "hina", "kaede", "yuki", "nova"];
fn root() -> PathBuf {
    home().join(".cache/agent-dashboard/chars")
}
fn store() -> PathBuf {
    home().join(".cache/agent-dashboard/char-sheets")
}
fn valid(who: &str) -> bool {
    rx(r"^[a-z][a-z0-9-]{1,23}$").is_match(who)
}
fn jobdir(id: &str) -> Option<PathBuf> {
    rx(r"^[a-z0-9-]+-\d{8}-\d{6}$")
        .is_match(id)
        .then(|| root().join(id))
}
fn status(app: &App, p: &Path, mut j: Value) -> Value {
    let who = text(&j["who"]).to_owned();
    let mut done = vec![];
    for (k, f) in [
        ("desc", "desc.txt".into()),
        ("full", format!("{who}-full.webp")),
        ("bust", format!("{who}-bust.webp")),
        ("sd", format!("{who}-sd-bust.png")),
        ("published", ".published".into()),
    ] {
        if p.join(f).exists() {
            done.push(k);
        }
    }
    let sheets = ["full", "bust", "sd"]
        .iter()
        .filter(|k| p.join(format!("{who}_{k}.png")).is_file())
        .collect::<Vec<_>>();
    let mut error = fs::read_to_string(p.join("failed.txt"))
        .ok()
        .map(|s| short(&s, 500));
    if j["launch"].is_string() && j["handle"].is_null() {
        let launch = app.state.read().unwrap().jobs[text(&j["launch"])].clone();
        if launch["state"] == "done" {
            if launch["handle"].is_string() {
                j["handle"] = launch["handle"].clone();
            } else {
                j["launch_error"] = json!(
                    launch["failed"][0]["error"]
                        .as_str()
                        .unwrap_or("에이전트를 띄우지 못했습니다")
                );
            }
            let _ = save_json(p.join("job.json"), &j);
        }
    }
    if error.is_none() {
        error = j["launch_error"].as_str().map(str::to_owned);
    }
    if error.is_none() && !done.contains(&"published") && j["handle"].is_string() {
        let s = app.state.read().unwrap();
        if !array(&s.orca["terminals"]).is_empty()
            && !array(&s.orca["terminals"])
                .iter()
                .any(|t| t["handle"] == j["handle"] && t["connected"] == true)
        {
            error = Some("에이전트 터미널이 결과 없이 닫혔습니다".into());
        }
    }
    let mut state = if done.contains(&"published") {
        "published"
    } else if error.is_some() {
        "failed"
    } else {
        "running"
    };
    if p.join(".removed").exists()
        && (!done.contains(&"published")
            || mtime(p.join(".removed")) >= mtime(p.join(".published")))
    {
        state = "removed";
    }
    let updated = fs::read_dir(p)
        .map(|es| {
            es.flatten()
                .map(|e| mtime(e.path()))
                .fold(number(&j["created"]), f64::max)
        })
        .unwrap_or(0.);
    merge(
        &mut j,
        &json!({"done":done,"sheets":sheets,"state":state,"error":error,"updated":updated}),
    );
    j
}
fn keep(p: &Path, who: &str) -> Result<()> {
    fs::create_dir_all(store()).map_err(|e| e.to_string())?;
    for e in fs::read_dir(p).map_err(|e| e.to_string())?.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if (name.starts_with(&format!("{who}_")) || name.starts_with(&format!("{who}-")))
            && (name.ends_with(".png") || name.ends_with(".webp"))
        {
            fs::copy(e.path(), store().join(&name)).map_err(|e| e.to_string())?;
        } else if name == "desc.txt" || name.starts_with("ref.") {
            fs::copy(e.path(), store().join(format!("{who}-{name}"))).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
pub fn jobs(app: &App) -> Vec<Value> {
    let mut out = vec![];
    if let Ok(ds) = fs::read_dir(root()) {
        for e in ds.flatten() {
            let p = e.path();
            let j = read_json(p.join("job.json"));
            if !j.is_object() || !valid(text(&j["who"])) {
                continue;
            }
            let j = status(app, &p, j);
            if j["state"] != "running" && now() - number(&j["updated"]) > 14. * 86400. {
                if j["state"] == "published" {
                    let _ = keep(&p, text(&j["who"]));
                }
                let _ = fs::remove_dir_all(p);
            } else {
                out.push(j);
            }
        }
    }
    out.sort_by(|a, b| number(&b["created"]).total_cmp(&number(&a["created"])));
    out
}
pub fn file(app: &App, id: &str, kind: &str) -> Option<(PathBuf, &'static str)> {
    let p = jobdir(id)?;
    let j = read_json(p.join("job.json"));
    let who = text(&j["who"]);
    if !valid(who) {
        return None;
    }
    let (name, typ) = match kind {
        "ref" => {
            let p = fs::read_dir(&p)
                .ok()?
                .flatten()
                .map(|e| e.path())
                .find(|p| {
                    p.file_name()
                        .is_some_and(|n| n.to_string_lossy().starts_with("ref."))
                })?;
            let typ = match p.extension()?.to_str()? {
                "png" => "image/png",
                "jpg" => "image/jpeg",
                "webp" => "image/webp",
                _ => return None,
            };
            return Some((p, typ));
        }
        "full" | "bust" | "sd" => (format!("{who}_{kind}.png"), "image/png"),
        _ => return None,
    };
    let f = real(p.join(name));
    let _ = app;
    (f.starts_with(real(p)) && f.is_file()).then_some((f, typ))
}
fn publish(app: &App, who: &str, args: &[&str]) -> Result<()> {
    if !valid(who) {
        return Err("잘못된 이름입니다".into());
    }
    let repo = app.config.here.parent().unwrap_or(&app.config.here);
    let py = command(
        repo.join("scripts/char-python.sh").to_str().unwrap_or(""),
        &[],
        Some(repo),
        300,
    )?;
    let script = repo.join("scripts/char-publish.py");
    let mut a = vec![script.to_str().unwrap_or(""), who];
    a.extend_from_slice(args);
    command(py.trim(), &a, Some(repo), 180).map(|_| ())
}
pub fn create(app: &App, b: &Value) -> Result<Value> {
    let who = text(&b["who"]);
    let name = text(&b["name"]).trim();
    let look = text(&b["look"]).trim();
    let notes = text(&b["notes"]).trim();
    let agent = b["agent"].as_str().unwrap_or("claude");
    let model = text(&b["model"]);
    if !valid(who)
        || BUILTIN.contains(&who)
        || [
            "sera", "daichi", "mina", "toru", "midori", "gonta", "fumi", "sho", "aki",
        ]
        .contains(&who)
    {
        return Err(
            "영문 이름은 소문자·숫자·- 2~24자이며 기본 캐릭터 이름은 쓸 수 없습니다".into(),
        );
    }
    if name.is_empty()
        || name.chars().count() > 20
        || look.chars().count() > 80
        || notes.chars().count() > 1000
        || name.contains('\'')
        || look.contains('\'')
    {
        return Err(
            "표시 이름은 20자, 생김새는 80자, 요청은 1000자까지입니다 (작은따옴표는 쓸 수 없음)"
                .into(),
        );
    }
    if !["claude", "codex"].contains(&agent)
        || !model.is_empty() && !rx(r"^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,79}$").is_match(model)
    {
        return Err("에이전트나 모델 id 가 잘못됐습니다".into());
    }
    let image = STANDARD
        .decode(text(&b["image"]))
        .map_err(|_| "원본 그림을 읽지 못했습니다")?;
    let ext = if image.starts_with(b"\x89PNG\r\n\x1a\n") {
        "png"
    } else if image.starts_with(b"\xff\xd8\xff") {
        "jpg"
    } else if image.starts_with(b"RIFF") && image.get(8..12) == Some(b"WEBP") {
        "webp"
    } else {
        return Err("원본 그림은 PNG·JPEG·WebP 만 됩니다".into());
    };
    if image.len() > 10 << 20 {
        return Err("원본 그림은 10MB 까지입니다".into());
    }
    if jobs(app)
        .iter()
        .any(|j| j["who"] == who && j["state"] == "running")
    {
        return Err("이 캐릭터를 만드는 작업이 이미 돌고 있습니다".into());
    }
    let places = terminals::places()?;
    let repo = app.config.here.parent().unwrap_or(&app.config.here);
    let w = array(&places["worktrees"])
        .iter()
        .find(|w| real(text(&w["path"])) == real(repo))
        .ok_or("Orca 에 이 저장소가 등록돼 있어야 합니다")?;
    let id = format!("{who}-{}", chrono::Local::now().format("%Y%m%d-%H%M%S"));
    let d = root().join(&id);
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    let reference = d.join(format!("ref.{ext}"));
    fs::write(&reference, image).map_err(|e| e.to_string())?;
    let boss = b["boss"] == true;
    let driver = b["driver"] == true && !boss;
    let role = if boss {
        "코디네이터"
    } else if driver {
        "스크립트 드라이버"
    } else {
        "워커"
    };
    let mut brief = include_str!("../assets/char-brief.txt").to_owned();
    for(k,v)in [("name",name.to_owned()),("who",who.to_owned()),("work",d.display().to_string()),("ref",reference.display().to_string()),("repo",repo.display().to_string()),("role",role.into()),("look",if look.is_empty(){"(없음 — 원본에서 읽는다)"}else{look}.into()),("notes",notes.into()),("boss_line",if boss{"코디네이터이므로 머리에 black wireless gaming headset with a small boom microphone worn on the head 를 넣는다."}else{"헤드셋은 넣지 않는다(코디네이터 표시)."}.into()),("boss_flag",if boss{" --boss"}else if driver{" --driver"}else{""}.into())]{brief=brief.replace(&format!("{{{k}}}"),&v);}
    fs::write(d.join("brief.md"), brief).map_err(|e| e.to_string())?;
    let mut args = vec![
        "agent".into(),
        "launch".into(),
        "--worktree".into(),
        format!("id:{}", text(&w["id"])),
        "--agent".into(),
        agent.into(),
        "--surface".into(),
        "terminal".into(),
        "--prompt".into(),
        format!(
            "{}/brief.md 를 읽고 그 순서대로 캐릭터 「{name}」({who})를 만들어 올려 주세요.",
            d.display()
        ),
    ];
    if !model.is_empty() {
        args.extend(["--model".into(), model.into()]);
    }
    let mut job = json!({"id":id,"who":who,"name":name,"look":look,"notes":notes,"boss":boss,"driver":driver,"agent":agent,"model":model,"created":now(),"launch":null,"handle":null});
    save_json(d.join("job.json"), &job)?;
    let launch = terminals::start_launch(
        app,
        args,
        format!("캐릭터 · {name}"),
        text(&w["name"]).into(),
    );
    job["launch"] = json!(launch);
    save_json(d.join("job.json"), &job)?;
    Ok(status(app, &d, job))
}
fn gather(app: &App, who: &str) -> Result<()> {
    fs::create_dir_all(store()).map_err(|e| e.to_string())?;
    for j in jobs(app) {
        if j["who"] == who && j["state"] == "published" {
            if let Some(d) = jobdir(text(&j["id"])) {
                keep(&d, who)?;
                break;
            }
        }
    }
    for k in ["full", "bust", "sd"] {
        for s in ["a", "b", "c", "d"] {
            let suffix = if s == "a" {
                String::new()
            } else {
                format!("_{s}")
            };
            if !store().join(format!("{who}_{k}{suffix}.png")).is_file() {
                return Err("시트 원본(세트 A~D)이 없어 다시 그릴 수 없습니다 — 「새 캐릭터」로 다시 만드세요".into());
            }
        }
    }
    if !BUILTIN.contains(&who) && !store().join(format!("{who}-desc.txt")).is_file() {
        return Err("생김새 설명(desc.txt)이 없어 다시 그릴 수 없습니다".into());
    }
    Ok(())
}
pub fn action(app: &App, action: &str, b: &Value) -> (u16, Value) {
    let result = (|| -> Result<Value> {
        let who = text(&b["who"]);
        match action {
            "create" => Ok(json!({"ok":true,"job":create(app,b)?})),
            "remove" => {
                let Some(d) = jobdir(text(&b["id"])) else {
                    return Ok(json!({"ok":false}));
                };
                let j = read_json(d.join("job.json"));
                if !j.is_object() {
                    return Ok(json!({"ok":false}));
                }
                if status(app, &d, j)["state"] == "running" {
                    return Err(
                        "돌고 있는 작업은 지울 수 없습니다 — Orca 에서 에이전트를 먼저 끝내세요"
                            .into(),
                    );
                }
                fs::remove_dir_all(d).map_err(|e| e.to_string())?;
                Ok(json!({"ok":true}))
            }
            "unpublish" => {
                publish(app, who, &["--remove"])?;
                for j in jobs(app) {
                    if j["who"] == who && j["state"] != "running" {
                        if let Some(d) = jobdir(text(&j["id"])) {
                            let _ = fs::remove_dir_all(d);
                        }
                    }
                }
                if let Ok(ds) = fs::read_dir(store()) {
                    for e in ds.flatten() {
                        let n = e.file_name().to_string_lossy().into_owned();
                        if n.starts_with(&format!("{who}_")) || n.starts_with(&format!("{who}-")) {
                            let _ = fs::remove_file(e.path());
                        }
                    }
                }
                app.state
                    .write()
                    .unwrap()
                    .redraws
                    .as_object_mut()
                    .unwrap()
                    .remove(who);
                Ok(json!({"ok":true}))
            }
            "meta" => {
                let name = text(&b["name"]);
                let look = text(&b["look"]);
                if name.contains('\'') || look.contains('\'') {
                    return Err("작은따옴표는 쓸 수 없습니다".into());
                }
                let mut args = vec!["--meta", "--name", name, "--look", look];
                if b["boss"] == true {
                    args.push("--boss");
                } else if b["driver"] == true {
                    args.push("--driver");
                }
                publish(app, who, &args)?;
                Ok(json!({"ok":true}))
            }
            "redraw" => {
                let kind = text(&b["kind"]);
                let set = text(&b["set"]);
                let name = text(&b["name"]);
                let look = text(&b["look"]);
                if !valid(who)
                    || !["full", "bust", "sd"].contains(&kind)
                    || !["a", "b", "c", "d"].contains(&set)
                    || name.trim().is_empty()
                    || name.chars().count() > 20
                    || look.chars().count() > 80
                {
                    return Err("잘못된 요청입니다".into());
                }
                if app.state.read().unwrap().redraws[who]["state"] == "running" {
                    return Err("이 캐릭터를 이미 다시 그리는 중입니다".into());
                }
                gather(app, who)?;
                let entry = json!({"who":who,"kind":kind,"set":set,"state":"running","step":"draw","error":null,"started":now(),"ended":null});
                app.state.write().unwrap().redraws[who] = entry.clone();
                let a = app.clone();
                let b = b.clone();
                std::thread::spawn(move || {
                    let who = text(&b["who"]);
                    let run = (|| -> Result<()> {
                        let repo = a.config.here.parent().unwrap_or(&a.config.here);
                        let mut env = vec![("CHAR_OUT".into(), store().display().to_string())];
                        if !BUILTIN.contains(&who) {
                            env.push((
                                "CHAR_DESC".into(),
                                fs::read_to_string(store().join(format!("{who}-desc.txt")))
                                    .map_err(|e| e.to_string())?,
                            ));
                            if let Ok(ds) = fs::read_dir(store()) {
                                if let Some(p) = ds.flatten().find(|e| {
                                    e.file_name()
                                        .to_string_lossy()
                                        .starts_with(&format!("{who}-ref."))
                                }) {
                                    env.push(("CHAR_REF".into(), p.path().display().to_string()));
                                }
                            }
                        }
                        let (code, out, err) = command_full(
                            repo.join("scripts/char-gen.sh").to_str().unwrap_or(""),
                            &[
                                who,
                                text(&b["kind"]),
                                store().to_str().unwrap_or(""),
                                text(&b["set"]),
                            ],
                            Some(&store()),
                            1800,
                            &env,
                        )?;
                        let _ = fs::write(
                            store().join(format!(".redraw-{who}.log")),
                            format!("{out}\n{err}"),
                        );
                        if code != 0 {
                            return Err(format!("그리지 못했습니다 — {}", short(&err, 200)));
                        }
                        a.state.write().unwrap().redraws[who]["step"] = json!("publish");
                        let mut args = vec![
                            "--name",
                            text(&b["name"]),
                            "--look",
                            text(&b["look"]),
                            "--dir",
                        ];
                        let st = store();
                        args.push(st.to_str().unwrap_or(""));
                        if b["boss"] == true {
                            args.push("--boss");
                        } else if b["driver"] == true {
                            args.push("--driver");
                        }
                        publish(&a, who, &args)
                    })();
                    let mut s = a.state.write().unwrap();
                    merge(
                        &mut s.redraws[who],
                        &json!({"state":if run.is_ok(){"done"}else{"failed"},"error":run.err(),"ended":now()}),
                    );
                });
                Ok(json!({"ok":true,"redraw":entry}))
            }
            _ => Err("bad request".into()),
        }
    })();
    match result {
        Ok(v) => (
            if ["create", "redraw"].contains(&action) {
                202
            } else {
                200
            },
            v,
        ),
        Err(e) => (
            if e.contains("timed out") { 504 } else { 400 },
            json!({"error":e}),
        ),
    }
}
