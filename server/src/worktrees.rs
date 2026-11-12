use crate::{app::App, core::*};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
pub fn porcelain(s: &str) -> Vec<Value> {
    let mut out = vec![];
    for b in s.trim().split("\n\n") {
        let mut w = json!({"path":null,"head":null,"branch":null,"detached":false,"locked":false,"prunable":false,"bare":false});
        for ln in b.lines() {
            let (k, v) = ln.split_once(' ').unwrap_or((ln, ""));
            match k {
                "worktree" => w["path"] = json!(v),
                "HEAD" => w["head"] = json!(v.chars().take(9).collect::<String>()),
                "branch" => w["branch"] = json!(v.trim_start_matches("refs/heads/")),
                "detached" | "locked" | "prunable" | "bare" => w[k] = json!(true),
                _ => {}
            }
        }
        if w["path"].is_string() {
            out.push(w);
        }
    }
    out
}
pub fn nested_gitdirs(gd: &Path) -> Vec<PathBuf> {
    let mut out = vec![];
    let mut stack = vec![(gd.to_path_buf(), 0)];
    while let Some((p, depth)) = stack.pop() {
        if depth > 16 {
            continue;
        }
        let Ok(es) = fs::read_dir(&p) else { continue };
        let entries = es.flatten().collect::<Vec<_>>();
        let names = entries
            .iter()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect::<HashSet<_>>();
        if names.contains("HEAD") && (names.contains("objects") || names.contains("commondir")) {
            if p != gd
                && !names.contains("commondir")
                && fs::read_dir(p.join("worktrees")).is_ok_and(|mut ds| ds.next().is_some())
            {
                out.push(p.clone());
            }
            for d in ["modules", "worktrees"] {
                if names.contains(d) {
                    stack.push((p.join(d), depth + 1));
                }
            }
        } else {
            for e in entries {
                if e.file_type().is_ok_and(|s| s.is_dir()) {
                    stack.push((e.path(), depth + 1));
                }
            }
        }
    }
    out
}
pub fn collect(app: &App, fresh: bool) -> Result<Value> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, (f64, Value)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    let old = cache.lock().unwrap().get(&app.config.data).cloned();
    let mut listing = if let Some((_, v)) = old.filter(|(at, _)| !fresh && now() - at < 20.) {
        v
    } else {
        let rs = orca(&["repo", "list"])?;
        let ws = orca(&["worktree", "list"])?;
        let by_path = array(&ws["worktrees"])
            .iter()
            .filter(|w| w["path"].is_string())
            .map(|w| (real(text(&w["path"])), w))
            .collect::<HashMap<_, _>>();
        let mut repos = vec![];
        let mut common = HashSet::new();
        for r in array(&rs["repos"])
            .iter()
            .filter(|r| (r["kind"].is_null() || r["kind"] == "git") && r["path"].is_string())
        {
            let p = Path::new(text(&r["path"]));
            let name = r["displayName"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    p.file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned()
                });
            let listing = git(p, &["worktree", "list", "--porcelain"]);
            if let Ok(g) = git(
                p,
                &["rev-parse", "--path-format=absolute", "--git-common-dir"],
            ) {
                common.insert(real(g));
            }
            repos.push(json!({"name":name,"path":p,"error":listing.as_ref().err(),"worktrees":listing.map(|s|porcelain(&s)).unwrap_or_default()}));
        }
        let mut modules = HashSet::new();
        for g in &common {
            for m in nested_gitdirs(g) {
                if !common.contains(&m) {
                    modules.insert(m);
                }
            }
        }
        let mut modules = modules.into_iter().collect::<Vec<_>>();
        modules.sort();
        for gd in modules {
            let out = command(
                "git",
                &[
                    "--git-dir",
                    gd.to_str().unwrap_or(""),
                    "worktree",
                    "list",
                    "--porcelain",
                ],
                None,
                10,
            );
            let rel = command(
                "git",
                &[
                    "--git-dir",
                    gd.to_str().unwrap_or(""),
                    "config",
                    "core.worktree",
                ],
                None,
                5,
            )
            .unwrap_or_default();
            let top = real(gd.join(rel.trim()));
            let mut rows = out.as_ref().map(|s| porcelain(s)).unwrap_or_default();
            if let Some(w) = rows.first_mut() {
                if top.is_dir() {
                    w["path"] = json!(top);
                }
            }
            repos.push(json!({"name":format!("{} · {}",top.file_name().unwrap_or_default().to_string_lossy(),top.parent().and_then(|p|p.file_name()).unwrap_or_default().to_string_lossy()),"path":top,"error":out.err(),"worktrees":rows}));
        }
        let mut seen = HashSet::new();
        for repo in &mut repos {
            let Some(rows) = repo["worktrees"].as_array_mut() else {
                continue;
            };
            rows.retain(|w| seen.insert(real(text(&w["path"]))));
            for (i, w) in rows.iter_mut().enumerate() {
                let p = Path::new(text(&w["path"])).to_path_buf();
                let o = by_path.get(&real(&p));
                w["main"] = json!(i == 0);
                w["orca"] = json!(o.is_some());
                w["name"] = json!(
                    o.and_then(|o| o["displayName"].as_str())
                        .map(str::to_owned)
                        .unwrap_or_else(|| p
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .into_owned())
                );
                w["comment"] = json!(o.and_then(|o| o["comment"].as_str()).unwrap_or(""));
                let missing = !p.is_dir() && w["bare"] != true;
                w["missing"] = json!(missing);
                if missing || w["bare"] == true {
                    merge(
                        w,
                        &json!({"dirty":null,"committed":null,"subject":null,"submodules":[]}),
                    );
                    continue;
                }
                let status = git(&p, &["status", "--porcelain", "--untracked-files=normal"]);
                let last = git(&p, &["log", "-1", "--format=%ct%x09%s"]).unwrap_or_default();
                let (ts, subject) = last.split_once('\t').unwrap_or(("", ""));
                merge(
                    w,
                    &json!({"dirty":status.ok().map(|s|s.lines().filter(|s|!s.is_empty()).count()),"committed":ts.parse::<u64>().ok(),"subject":short(subject,120),"submodules":submodules(&p)}),
                );
            }
        }
        let v = json!({"repos":repos,"at":now()});
        cache
            .lock()
            .unwrap()
            .insert(app.config.data.clone(), (now(), v.clone()));
        v
    };
    let notes = read_json(app.config.data.join("worktree-notes.json"));
    for r in listing["repos"].as_array_mut().unwrap() {
        for w in r["worktrees"].as_array_mut().unwrap() {
            w["note"] = notes[text(&w["path"])].clone();
        }
    }
    Ok(listing)
}
fn submodules(p: &Path) -> Vec<Value> {
    if !p.join(".gitmodules").is_file() {
        return vec![];
    }
    let command = r#"printf "%s\t%s\t%s\n" "$displaypath" "$(git symbolic-ref -q --short HEAD)" "$(git rev-parse --short=9 HEAD)""#;
    git(
        p,
        &["submodule", "foreach", "--recursive", "--quiet", command],
    )
    .unwrap_or_default()
    .lines()
    .filter_map(|ln| {
        let a = ln.splitn(3, '\t').collect::<Vec<_>>();
        (a.len() == 3).then(
            || json!({"path":a[0],"branch":if a[1].is_empty(){None}else{Some(a[1])},"head":a[2]}),
        )
    })
    .collect()
}
pub fn blockers(w: &Value) -> Vec<String> {
    if w["missing"] == true || w["prunable"] == true {
        return vec![];
    }
    let mut out = vec![];
    if number(&w["dirty"]) > 0. {
        out.push(format!("커밋하지 않은 변경 {}개가 있습니다", w["dirty"]));
    }
    if w["locked"] == true {
        out.push("잠긴 워크트리입니다 (git worktree lock)".into());
    }
    let path = Path::new(text(&w["path"]));
    if let Ok(g) = git(path, &["rev-parse", "--absolute-git-dir"]) {
        let n = nested_gitdirs(Path::new(&g))
            .iter()
            .map(|m| {
                fs::read_dir(m.join("worktrees"))
                    .map(|e| e.count())
                    .unwrap_or(0)
            })
            .sum::<usize>();
        if n > 0 {
            out.push(format!(
                "안의 서브모듈에 딸린 워크트리 {n}개가 함께 못 쓰게 됩니다"
            ));
        }
    }
    if path.join(".gitmodules").is_file() {
        let sm = git(
            path,
            &[
                "submodule",
                "foreach",
                "--recursive",
                "--quiet",
                r#"test -z "$(git rev-list -1 HEAD --branches --not --remotes)" || echo "$displaypath""#,
            ],
        );
        match sm {
            Ok(s) if !s.is_empty() => out.push(format!(
                "원격에 없는 커밋이 있는 서브모듈: {}",
                s.lines().collect::<Vec<_>>().join(", ")
            )),
            Err(e) => out.push(format!("서브모듈의 보존 여부를 확인하지 못했습니다: {e}")),
            _ => {}
        }
    }
    out
}
pub fn action(app: &App, action: &str, b: &Value, local: bool) -> (u16, Value) {
    let error = |code, s: String| (code, json!({"error":s}));
    let Some(path) = b["path"].as_str() else {
        return error(400, "bad request".into());
    };
    if action != "note" && !local {
        return error(403, "이 맥에서 연 화면에서만 됩니다".into());
    }
    let listing = match collect(app, true) {
        Ok(v) => v,
        Err(e) => return error(502, e),
    };
    let hit = array(&listing["repos"]).iter().find_map(|r| {
        array(&r["worktrees"])
            .iter()
            .find(|w| w["path"] == path)
            .map(|w| (r, w))
    });
    let Some((rp, w)) = hit else {
        return error(404, "목록에 없는 워크트리입니다".into());
    };
    if action == "note" {
        let note = b["text"].as_str().unwrap_or("").trim();
        if note.chars().count() > 4000 {
            return error(400, "메모는 4000자까지입니다".into());
        }
        let _guard = app.persistence.lock().unwrap();
        let mut notes = read_json(app.config.data.join("worktree-notes.json"));
        if !notes.is_object() {
            notes = obj();
        }
        if note.is_empty() {
            notes.as_object_mut().unwrap().remove(path);
        } else {
            notes[path] = json!({"text":note,"at":now()});
        }
        return match save_json(app.config.data.join("worktree-notes.json"), &notes) {
            Ok(()) => {
                invalidate(app);
                (200, json!({"note":notes[path]}))
            }
            Err(e) => error(500, e),
        };
    }
    if action == "open" {
        if w["missing"] == true || w["bare"] == true {
            return error(409, "디스크에 없는 워크트리입니다".into());
        }
        return match open_editor(path, text(&b["editor"]), false) {
            Ok(()) => (200, json!({"ok":true})),
            Err(e) => error(502, e),
        };
    }
    if action == "web" {
        return match crate::vscode::ensure(app) {
            Ok(()) => (200, json!({"url":crate::vscode::url(app,path)})),
            Err(e) => error(502, e),
        };
    }
    if action != "remove" || b.get("force").is_some_and(|v| !v.is_boolean()) {
        return error(400, "bad request".into());
    }
    if w["main"] == true || w["bare"] == true {
        return error(409, "저장소의 메인 체크아웃은 지울 수 없습니다".into());
    }
    let reasons = if b["force"] == true {
        vec![]
    } else {
        blockers(w)
    };
    if !reasons.is_empty() {
        return (409, json!({"error":reasons.join("\n"),"reasons":reasons}));
    }
    let main = array(&rp["worktrees"])
        .iter()
        .find(|w| w["main"] == true)
        .map(|w| text(&w["path"]))
        .unwrap_or(text(&rp["path"]));
    let result = if w["missing"] == true || w["prunable"] == true {
        command("git", &["-C", main, "worktree", "prune"], None, 120)
    } else if w["orca"] == true {
        command(
            "orca",
            &[
                "worktree",
                "rm",
                "--worktree",
                &format!("path:{path}"),
                "--force",
                "--json",
            ],
            None,
            120,
        )
    } else {
        command(
            "git",
            &["-C", main, "worktree", "remove", "--force", "--force", path],
            None,
            120,
        )
    };
    match result {
        Err(e) => error(502, e),
        Ok(_) => {
            if Path::new(path).is_dir() && w["missing"] != true {
                return error(502, "명령은 끝났지만 폴더가 남아 있습니다".into());
            }
            let mut notes = read_json(app.config.data.join("worktree-notes.json"));
            if let Some(o) = notes.as_object_mut() {
                o.remove(path);
                let _ = save_json(app.config.data.join("worktree-notes.json"), &notes);
            }
            invalidate(app);
            (200, json!({"ok":true}))
        }
    }
}
pub fn open_editor(path: &str, editor: &str, new: bool) -> Result<()> {
    let (cli, app) = if editor == "zed" {
        ("/Applications/Zed.app/Contents/MacOS/cli", "Zed")
    } else {
        (
            "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
            "Visual Studio Code",
        )
    };
    let mut args = vec![];
    let binary = if Path::new(cli).is_file() {
        cli
    } else {
        args.extend(["-a", app]);
        "open"
    };
    if new {
        args.push("-n");
    }
    args.push(path);
    command(binary, &args, None, 15).map(|_| ())
}

pub fn get(app: &App, fresh: bool) -> Result<Value> {
    let a = app.clone();
    cached_json(
        format!("worktrees:{}", app.config.data.display()),
        20.,
        fresh,
        move || collect(&a, true),
    )
}
fn invalidate(app: &App) {
    drop_cache(&format!("worktrees:{}", app.config.data.display()));
}
