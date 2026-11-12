use crate::{
    app::App,
    core::*,
    sessions::{Session, rx},
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Read,
    path::Path,
};
pub fn history(app: &App) -> Result<()> {
    let (old, live, prefs, pricing) = {
        let s = app.state.read().unwrap();
        (
            s.history.clone(),
            s.sessions.keys().cloned().collect::<HashSet<_>>(),
            s.prefs.clone(),
            s.pricing.clone(),
        )
    };
    let mut found = obj();
    for (p, k) in app.transcript_paths(7. * 24.) {
        if live.contains(&p) {
            continue;
        }
        let version = json!([mtime(&p), fs::metadata(&p).map(|s| s.len()).unwrap_or(0)]);
        if old[&p]["v"] == version {
            found[&p] = old[&p].clone();
            continue;
        }
        let mut sess = Session::new(&p, &k);
        if sess.poll().is_err() {
            continue;
        }
        let mut sm = sess.summary(
            &obj(),
            &json!({"runs":[],"workers":[],"terminals":[]}),
            &prefs,
            &pricing,
            &Value::Null,
        );
        sm.as_object_mut().unwrap().retain(|k, _| {
            [
                "id", "kind", "path", "title", "model", "parent", "started", "last_ts", "slots",
            ]
            .contains(&k.as_str())
        });
        found[&p] = json!({"v":version,"s":sm});
    }
    if old != found {
        save_json(app.config.data.join("history-cache.json"), &found)?;
    }
    let mut s = app.state.write().unwrap();
    s.history = found;
    s.history_at = now();
    Ok(())
}
pub fn history_payload(app: &App) -> Value {
    let s = app.state.read().unwrap();
    let live = s
        .sessions
        .values()
        .map(|s| (s.kind.as_str(), s.id()))
        .collect::<HashSet<_>>();
    let mut by: HashMap<(String, String), Value> = HashMap::new();
    for f in s.history.as_object().into_iter().flat_map(|m| m.values()) {
        let mut x = f["s"].clone();
        if live.contains(&(text(&x["kind"]), text(&x["id"]))) {
            continue;
        }
        if let Some(slots) = x["slots"].as_object_mut() {
            slots.retain(|k, _| k.parse::<f64>().is_ok_and(|t| t > now() / 300. - 2016.));
            if slots.is_empty() {
                continue;
            }
        } else {
            continue;
        }
        let key = (text(&x["kind"]).into(), text(&x["id"]).into());
        if by.get(&key).is_none_or(|old| {
            old["slots"].as_object().map(|m| m.len()).unwrap_or(0)
                < x["slots"].as_object().unwrap().len()
        }) {
            by.insert(key, x);
        }
    }
    json!({"updated":s.history_at,"scanning":false,"days":7,"sessions":by.into_values().collect::<Vec<_>>()})
}
pub fn vault(app: &App) -> Result<()> {
    if !app.config.vault.is_dir() {
        return Ok(());
    }
    let (old, projects) = {
        let s = app.state.read().unwrap();
        (s.vault.clone(), s.projects.clone())
    };
    let mut notes = obj();
    for e in walkdir::WalkDir::new(&app.config.vault)
        .into_iter()
        .filter_entry(|e| {
            e.depth() == 0
                || !e.file_name().to_string_lossy().starts_with('.')
                    && e.file_name() != "node_modules"
        })
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file() && e.path().extension().is_some_and(|s| s == "md"))
    {
        let p = e.path();
        let rel = p
            .strip_prefix(&app.config.vault)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let mt = mtime(p);
        if old["notes"][&rel]["mtime"] == mt {
            notes[&rel] = old["notes"][&rel].clone();
            continue;
        }
        let mut head = String::new();
        if fs::File::open(p)
            .and_then(|f| f.take(8192).read_to_string(&mut head))
            .is_err()
        {
            continue;
        }
        let fm = rx(r"(?s)^---\n(.*?)\n---")
            .captures(&head)
            .map(|c| c[1].to_owned())
            .unwrap_or_default();
        let field = |k: &str| {
            rx(&format!(r"(?m)^{k}:\s*(.+?)\s*$"))
                .captures(&fm)
                .map(|c| c[1].trim_matches(['\'', '"']).to_owned())
        };
        let agent = rx(r"agent/(claude|codex)-([0-9A-Za-z][\w-]*)")
            .captures(&fm)
            .map(|m| format!("{}-{}", &m[1], &m[2]));
        notes[&rel] = json!({"title":field("title").unwrap_or_else(||p.file_stem().unwrap_or_default().to_string_lossy().into_owned()),"created":field("created"),"updated":field("updated"),"agent":agent,"mtime":mt});
    }
    let mut steps = obj();
    for p in array(&projects["list"]) {
        let root = Path::new(text(&p["path"]))
            .parent()
            .unwrap_or(Path::new("."));
        for st in array(&p["stages"]) {
            for sp in array(&st["steps"]) {
                let full = root.join(text(&sp["path"]));
                let Ok(rel) = full.strip_prefix(&app.config.vault) else {
                    continue;
                };
                let rel = rel.to_string_lossy().into_owned();
                let r = json!({"project":p["name"],"dir":p["dir"],"path":sp["path"],"title":sp["title"],"status":sp["status"],"no":st["no"],"stage":st["name"]});
                let mut hits = vec![rel];
                let body = fs::read_to_string(&full).unwrap_or_default();
                for c in rx(r"\[\[([^\]|#\n]+)").captures_iter(&body) {
                    let target = format!("{}.md", c[1].trim().trim_end_matches(".md"));
                    let key = notes
                        .as_object()
                        .unwrap()
                        .keys()
                        .filter(|k| k.ends_with(&target))
                        .min_by_key(|k| k.len());
                    if let Some(key) = key {
                        let abs = app.config.vault.join(key);
                        if abs.starts_with(root)
                            && !key.ends_with("/_index.md")
                            && !key.contains("/rules/")
                        {
                            hits.push(key.clone());
                        }
                    }
                }
                for hit in hits {
                    if !steps[&hit].is_array() {
                        steps[&hit] = json!([]);
                    }
                    if !array(&steps[&hit]).contains(&r) {
                        steps[&hit].as_array_mut().unwrap().push(r.clone());
                    }
                }
            }
        }
    }
    app.state.write().unwrap().vault = json!({"on":true,"notes":notes,"steps":steps});
    Ok(())
}
pub fn vault_notes(app: &App, kind: &str, id: &str) -> Vec<Value> {
    let s = app.state.read().unwrap();
    let tag = format!("{kind}-{id}");
    let mut out = vec![];
    for (rel, n) in s.vault["notes"]
        .as_object()
        .into_iter()
        .flat_map(|m| m.iter())
        .filter(|(_, n)| n["agent"] == tag)
    {
        let mut n = n.clone();
        merge(
            &mut n,
            &json!({"path":rel,"abs":app.config.vault.join(rel),"steps":s.vault["steps"][rel].as_array().cloned().unwrap_or_default()}),
        );
        out.push(n);
    }
    out.sort_by(|a, b| number(&b["mtime"]).total_cmp(&number(&a["mtime"])));
    out
}
pub fn recent(app: &App, limit: usize) -> Value {
    let s = app.state.read().unwrap();
    let mut out = vec![];
    for (rel, n) in s.vault["notes"]
        .as_object()
        .into_iter()
        .flat_map(|m| m.iter())
        .filter(|(_, n)| n["agent"].is_string())
    {
        let sess = s
            .sessions
            .values()
            .find(|x| format!("{}-{}", x.kind, x.id()) == text(&n["agent"]));
        out.push(json!({"path":rel,"abs":app.config.vault.join(rel),"title":n["title"],"mtime":n["mtime"],"agent":n["agent"],"session":sess.map(|s|&s.path),"session_title":sess.map(|s|&s.data["title"])}));
    }
    out.sort_by(|a, b| number(&b["mtime"]).total_cmp(&number(&a["mtime"])));
    out.truncate(limit);
    json!({"on":s.vault["on"],"notes":out})
}
