use crate::{app::App, core::*, sessions::rx};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    path::{Path, PathBuf},
};
pub fn canvas_dir(app: &App) -> PathBuf {
    let s = app.state.read().unwrap();
    let root = s.prefs["canvas_data"]
        .as_str()
        .map(expand)
        .or_else(|| std::env::var("WORKFLOW_CANVAS_DATA_DIR").ok().map(expand))
        .unwrap_or_else(|| {
            app.config
                .vault
                .join("40_Tools/workflow-canvas/.local/workflows")
        });
    root.join(".executions")
}
pub fn parse_map(s: &str) -> Vec<Value> {
    let mut out = vec![];
    let mut seen = HashSet::new();
    let mut inside = false;
    let mut add =
        |key: String, label: String, repo: Option<String>, layer: Option<u64>, separate: bool| {
            if seen.insert(key.clone()) {
                out.push(
                    json!({"key":key,"label":label,"repo":repo,"layer":layer,"separate":separate}),
                );
            }
        };
    for ln in s.lines() {
        if ln.trim().is_empty() {
            continue;
        }
        if !ln.starts_with(char::is_whitespace) {
            if let Some(c) = rx(r"^([a-z][a-z -]*?)\s*(\([^)]*\))?\s*:").captures(ln) {
                let name = c[1].trim();
                if name == "order" {
                    inside = true;
                    continue;
                }
                if name.starts_with("separate run") {
                    for c in rx(r"([A-Z][A-Z0-9]+-\d+)\s*([^\s(·|,]*)")
                        .captures_iter(&ln[c.get(0).unwrap().end()..])
                    {
                        add(c[1].into(), c[2].into(), None, None, true);
                    }
                    continue;
                }
                inside = false;
                continue;
            }
        }
        if !inside {
            continue;
        }
        let Some(c) = rx(r"^\s*(\d+)\s+(.*)$").captures(ln) else {
            continue;
        };
        let layer = c[1].parse().ok();
        let rest = &c[2];
        let segs = rest.split('|').map(str::trim).collect::<Vec<_>>();
        let multi = segs.len() > 1
            && segs
                .iter()
                .all(|s| rx(r"^[A-Z][A-Z0-9]+-\d+\b").is_match(s));
        if multi || segs.len() == 1 {
            for seg in segs {
                let toks = seg.split_whitespace().collect::<Vec<_>>();
                if toks
                    .first()
                    .is_none_or(|t| !rx(r"^[A-Z][A-Z0-9]+-\d+$").is_match(t))
                {
                    continue;
                }
                let sep = seg.contains("별도 실행");
                add(
                    toks[0].into(),
                    toks.get(1)
                        .filter(|s| !s.starts_with('('))
                        .unwrap_or(&"")
                        .to_string(),
                    if sep {
                        None
                    } else {
                        toks.get(2).map(|s| s.to_string())
                    },
                    layer,
                    sep,
                );
            }
        } else {
            let toks = segs[0].split_whitespace().collect::<Vec<_>>();
            if toks
                .first()
                .is_some_and(|t| rx(r"^[A-Z][A-Z0-9]+-\d+$").is_match(t))
            {
                add(
                    toks[0].into(),
                    toks.get(1).unwrap_or(&"").to_string(),
                    segs.get(1)
                        .and_then(|s| s.split_whitespace().next())
                        .map(str::to_owned),
                    layer,
                    rest.contains("별도 실행"),
                );
            }
        }
    }
    out
}
pub fn norm(s: &str) -> &'static str {
    let s = s.trim().to_lowercase();
    if s.starts_with("done") || s.starts_with("verified") || ["완료", "통과"].contains(&s.as_str())
    {
        "done"
    } else if s.starts_with("committed") || s.starts_with("커밋") {
        "committed"
    } else if ["running", "in_progress", "진행"]
        .iter()
        .any(|p| s.starts_with(p))
    {
        "running"
    } else if ["blocked", "fail", "막힘", "실패"]
        .iter()
        .any(|p| s.starts_with(p))
    {
        "blocked"
    } else {
        "pending"
    }
}
pub fn parse_ledger(s: &str) -> (Vec<Value>, Option<String>) {
    let mut out = vec![];
    let mut head: Option<Vec<String>> = None;
    let mut inside = false;
    for ln in s.lines() {
        if ln.starts_with("## ") {
            inside = ln.trim() == "## 체크박스";
            continue;
        }
        if !inside || !ln.trim_start().starts_with('|') {
            continue;
        }
        let cells = ln
            .trim()
            .trim_matches('|')
            .split('|')
            .map(str::trim)
            .collect::<Vec<_>>();
        if head.is_none() {
            head = Some(cells.iter().map(|s| s.to_string()).collect());
            continue;
        }
        if cells.iter().all(|c| c.chars().all(|c| "-: ".contains(c)))
            || cells.first().is_none_or(|c| !rx(r"^cb\d+$").is_match(c))
        {
            continue;
        }
        let head = head.as_ref().unwrap();
        let col = |name, d| head.iter().position(|s| s == name).unwrap_or(d);
        let extra = cells.len().saturating_sub(head.len());
        let (ti, ki, si) = (col("문구", 1), col("종류", 2), col("상태", 3));
        let text = if ki > ti {
            cells
                .get(ti..(ki + extra).min(cells.len()))
                .unwrap_or(&[])
                .join(" | ")
        } else {
            cells.get(ti).unwrap_or(&"").to_string()
        };
        let kind = cells.get(ki + extra).unwrap_or(&"");
        let raw = cells.get(si + extra).unwrap_or(&"");
        out.push(json!({"cb":cells[0],"text":text,"kind":kind,"status":norm(raw),"raw":raw,"closing":text=="완료"}));
    }
    let mut log = BTreeMap::new();
    for c in rx(r"(?m)^[-*\s]*체크박스 실행:\s*(cb\d+)\s+(\S+)").captures_iter(s) {
        log.insert(c[1].to_owned(), c[2].to_owned());
    }
    for x in &mut out {
        if x["status"] == "pending" {
            if let Some(st) = log.get(text(&x["cb"])) {
                let st = norm(st);
                if st != "pending" {
                    x["status"] = json!(st);
                    x["from_log"] = json!(true);
                }
            }
        }
    }
    let cur = rx(r"(?m)^[-*\s]*현재 체크박스:\s*(cb\d+)")
        .captures(s)
        .map(|c| c[1].to_owned());
    (out, cur)
}
pub fn summarize(items: &[Value], current: Option<&str>) -> Value {
    let work = items
        .iter()
        .filter(|x| x["closing"] != true)
        .collect::<Vec<_>>();
    let done = work
        .iter()
        .filter(|x| matches!(text(&x["status"]), "done" | "committed"))
        .count();
    let state = if !work.is_empty() && done == work.len() {
        "done"
    } else if items.iter().any(|x| x["status"] == "blocked") {
        "blocked"
    } else {
        "running"
    };
    let mut cur = current.and_then(|c| items.iter().find(|x| x["cb"] == c));
    if state != "done" && cur.is_none_or(|c| c["status"] == "done") {
        cur = items
            .iter()
            .find(|x| matches!(text(&x["status"]), "running" | "blocked"))
            .or_else(|| work.iter().find(|x| x["status"] == "committed").copied())
            .or_else(|| work.iter().find(|x| x["status"] == "pending").copied())
            .or(cur);
    }
    json!({"done":done,"total":work.len(),"state":state,"current":cur})
}
fn ledger(project: &str, repo: &str, wt: &str, key: &str) -> Option<PathBuf> {
    let p = Path::new(project);
    let dirs = [
        p.to_path_buf(),
        p.join(repo),
        p.parent().unwrap_or(p).join(repo),
    ];
    for d in dirs {
        if d.is_dir() {
            if let Ok(g) = git(
                &d,
                &["rev-parse", "--path-format=absolute", "--git-common-dir"],
            ) {
                for name in [wt, key] {
                    if !name.is_empty() {
                        let f = Path::new(&g)
                            .join("worktrees")
                            .join(name)
                            .join("checkbox-review/ledger.md");
                        if f.is_file() {
                            return Some(f);
                        }
                    }
                }
            }
        }
    }
    None
}
pub fn collect(app: &App, run: &str, term: &str, launch: &str) -> Value {
    let root = canvas_dir(app);
    let mut names = fs::read_dir(&root)
        .map(|es| {
            es.flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    names.sort();
    let mut children: BTreeMap<String, BTreeMap<String, Value>> = BTreeMap::new();
    for name in names.iter().filter(|n| n.ends_with("-impl-ticket")) {
        let mut m = read_json(root.join(name).join("meta.json"));
        let parent = text(&m["parent"]["launch"]).to_owned();
        let wt = m["inputs"]["wt"]
            .as_str()
            .or(m["title"].as_str())
            .unwrap_or("")
            .to_owned();
        if let Some(k) = rx(r"^([A-Z][A-Z0-9]+-\d+)").captures(&wt) {
            let key = k[1].to_owned();
            m["launch"] = json!(name);
            m["wt"] = json!(wt);
            children.entry(parent).or_default().insert(key, m);
        }
    }
    let mut projects = vec![];
    for name in names.iter().rev().filter(|n| n.ends_with("-impl-project")) {
        if !launch.is_empty() && name != launch {
            continue;
        }
        let m = read_json(root.join(name).join("meta.json"));
        if !m.is_object()
            || !run.is_empty() && m["runId"] != run
            || !term.is_empty() && m["coordinatorTerminal"] != term
        {
            continue;
        }
        let kids = children.get(name).cloned().unwrap_or_default();
        let mut tickets =
            parse_map(&fs::read_to_string(root.join(name).join("1-map.txt")).unwrap_or_default());
        for k in kids.keys() {
            if !tickets.iter().any(|t| t["key"] == *k) {
                tickets.push(json!({"key":k,"label":"","repo":null,"layer":null,"separate":false,"unmapped":true}));
            }
        }
        let mut totals = json!({"done":0,"total":0,"tickets":0,"tickets_done":0,"unknown":0});
        for t in &mut tickets {
            let key = text(&t["key"]).to_owned();
            let child = kids.get(&key);
            let project = child.map(|c| text(&c["project"])).unwrap_or("");
            let repo = t["repo"]
                .as_str()
                .map(str::to_owned)
                .or_else(|| {
                    Path::new(project)
                        .file_name()
                        .map(|s| s.to_string_lossy().into_owned())
                })
                .unwrap_or_default();
            t["repo"] = json!(repo);
            t["child"]=child.map(|c|json!({"launch":c["launch"],"runId":c["runId"],"wt":c["wt"],"project":c["project"],"startedAt":c["startedAt"]})).unwrap_or(Value::Null);
            let f = if !project.is_empty() {
                ledger(
                    project,
                    &repo,
                    child.map(|c| text(&c["wt"])).unwrap_or(""),
                    &key,
                )
            } else {
                None
            }
            .or_else(|| {
                if t["separate"] == true {
                    return None;
                }
                kids.values()
                    .filter_map(|c| ledger(text(&c["project"]), &repo, "", &key))
                    .next()
            });
            t["ledger"] = json!(f);
            if let Some(f) = f {
                let (items, cur) = parse_ledger(&fs::read_to_string(f).unwrap_or_default());
                merge(t, &summarize(&items, cur.as_deref()));
                t["items"] = json!(items);
            } else {
                merge(
                    t,
                    &json!({"items":[],"done":0,"total":null,"current":null,"state":if t["separate"]==true{"out"}else{"todo"}}),
                );
            }
            if t["separate"] == true {
                continue;
            }
            for (k, n) in [
                ("tickets", 1.),
                ("unknown", f64::from(t["total"].is_null())),
                ("done", number(&t["done"])),
                ("total", number(&t["total"])),
                ("tickets_done", f64::from(t["state"] == "done")),
            ] {
                totals[k] = json!(number(&totals[k]) + n);
            }
        }
        projects.push(json!({"launch":name,"title":m["title"].as_str().unwrap_or(name),"runId":m["runId"],"epic":m["values"]["jira_scope"],"project_key":m["values"]["project_key"],"coordinator":m["coordinatorTerminal"],"startedAt":m["startedAt"],"summary":totals,"tickets":tickets}));
    }
    json!({"projects":projects})
}
