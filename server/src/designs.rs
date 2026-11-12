use crate::{app::App, core::*, sessions::rx};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    path::{Path, PathBuf},
};
pub fn toc(s: &str) -> Vec<Value> {
    let lines = s.lines().collect::<Vec<_>>();
    let mut fence = None;
    let mut heads = vec![];
    for (i, line) in lines.iter().enumerate() {
        if let Some(m) = rx(r"^\s*(```|~~~)").captures(line) {
            let f = m[1].to_owned();
            if fence.as_ref() == Some(&f) {
                fence = None;
            } else if fence.is_none() {
                fence = Some(f);
            }
            continue;
        }
        if fence.is_none() {
            if let Some(m) = rx(r"^##\s+(.*?)\s*#*\s*$").captures(line) {
                heads.push((i + 1, m[1].to_owned()));
            }
        }
    }
    let mut out = vec![];
    if heads.first().is_none_or(|(n, _)| *n > 1) {
        let title = if heads.is_empty() {
            "본문"
        } else {
            "머리말"
        };
        out.push(json!({"id":title,"title":title,"no":null,"start":1,"end":heads.first().map(|h|h.0-1).unwrap_or(lines.len())}));
    }
    let mut seen = BTreeMap::new();
    for (i, (n, title)) in heads.iter().enumerate() {
        let count = seen.entry(title).or_insert(0);
        *count += 1;
        let id = if *count == 1 {
            title.clone()
        } else {
            format!("{title} ({count})")
        };
        let no = rx(r"^§?\s*(\d+(?:[.-]\d+)*)[.)]?(?:\s|$)")
            .captures(title)
            .map(|m| m[1].to_owned());
        out.push(json!({"id":id,"title":title,"no":no,"start":n,"end":heads.get(i+1).map(|h|h.0-1).unwrap_or(lines.len())}));
    }
    out
}
pub fn mime(p: &Path) -> Option<(&'static str, &'static str)> {
    match p.extension()?.to_str()?.to_lowercase().as_str() {
        "md" => Some(("md", "text/markdown; charset=utf-8")),
        "svg" => Some(("image", "image/svg+xml")),
        "png" => Some(("image", "image/png")),
        "jpg" | "jpeg" => Some(("image", "image/jpeg")),
        "gif" => Some(("image", "image/gif")),
        "webp" => Some(("image", "image/webp")),
        "pdf" => Some(("pdf", "application/pdf")),
        _ => None,
    }
}
pub fn collect(app: &App) -> Result<()> {
    let (prefs, plans, old, mut refs, mut sessions) = {
        let s = app.state.read().unwrap();
        (
            s.prefs.clone(),
            s.plans.clone(),
            s.design.clone(),
            s.design_refs.clone(),
            s.sessions.values().cloned().collect::<Vec<_>>(),
        )
    };
    let mut want = app
        .config
        .designs
        .iter()
        .cloned()
        .map(|p| (p, true))
        .collect::<Vec<_>>();
    for p in array(&prefs["design_dirs"]) {
        want.push((real(text(p)), true));
    }
    let names: HashSet<_> = want
        .iter()
        .filter_map(|(p, _)| p.file_name().map(|s| s.to_string_lossy().into_owned()))
        .collect();
    for p in array(&plans) {
        if let Some(root) = p["design_root"].as_str() {
            let root = real(root);
            let ancestor = root
                .ancestors()
                .find(|p| {
                    p.file_name()
                        .is_some_and(|s| names.contains(s.to_string_lossy().as_ref()))
                })
                .unwrap_or_else(|| root.parent().unwrap_or(&root));
            want.push((ancestor.to_path_buf(), false));
        }
    }
    let mut roots = vec![];
    let mut seen = HashSet::new();
    for (root, configured) in want {
        if !root.is_dir() {
            continue;
        }
        let top = git(&root, &["rev-parse", "--show-toplevel"]).ok();
        let copies = git(&root, &["worktree", "list", "--porcelain"]).unwrap_or_default();
        let mut ps = vec![root.clone()];
        if let Some(top) = top {
            if let Ok(rel) = root.strip_prefix(top) {
                for line in copies.lines() {
                    if let Some(p) = line.strip_prefix("worktree ") {
                        let p = Path::new(p).join(rel);
                        if p.is_dir() {
                            ps.push(p);
                        }
                    }
                }
            }
        }
        for (i, p) in ps.into_iter().enumerate() {
            let p = real(p);
            if seen.insert(p.clone()) {
                roots.push((p, configured && i == 0));
            }
        }
    }
    let mut sources = vec![];
    let mut docs = obj();
    for (root, configured) in &roots {
        let i = sources.len();
        let top = git(root, &["rev-parse", "--show-toplevel"]).ok();
        let common = git(
            root,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )
        .ok();
        let main = common.as_ref().and_then(|s| Path::new(s).parent());
        sources.push(json!({"dir":root,"configured":configured,"repo":main.and_then(|p|p.file_name()).map(|s|s.to_string_lossy()),"worktree":top.as_ref().and_then(|s|Path::new(s).file_name()).map(|s|s.to_string_lossy()),"main":top.as_ref().is_none_or(|t|main==Some(Path::new(t))),"branch":git(root,&["branch","--show-current"]).ok(),"head":git(root,&["rev-parse","HEAD"]).ok()}));
        for e in walkdir::WalkDir::new(root)
            .into_iter()
            .filter_entry(|e| {
                e.depth() == 0
                    || !e.file_name().to_string_lossy().starts_with('.')
                        && e.file_name() != "node_modules"
            })
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
        {
            let p = e.path();
            let Some((kind, _)) = mime(p) else { continue };
            let rel = p.strip_prefix(root).unwrap();
            let key = format!(
                "{}/{}",
                root.file_name().unwrap_or_default().to_string_lossy(),
                rel.to_string_lossy()
            );
            if docs[&key].is_null() {
                docs[&key] = json!({"key":key,"kind":kind,"copies":[]});
            }
            docs[&key]["copies"].as_array_mut().unwrap().push(json!({"src":i,"abs":p,"mtime":mtime(p),"size":e.metadata().map(|m|m.len()).unwrap_or(0)}));
        }
    }
    type NavCopies = BTreeMap<(String, String), Vec<(bool, f64, PathBuf)>>;
    let mut navs: NavCopies = BTreeMap::new();
    for (root, configured) in &roots {
        for entry in fs::read_dir(root).into_iter().flatten().flatten() {
            let path = entry.path().join("index.html");
            if path.is_file() {
                navs.entry((
                    root.file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned(),
                    entry.file_name().to_string_lossy().into_owned(),
                ))
                .or_default()
                .push((!*configured, -mtime(&path), path));
            }
        }
    }
    for ((base, slug), mut copies) in navs {
        copies.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.total_cmp(&b.1)));
        let body = fs::read_to_string(&copies[0].2).unwrap_or_default();
        let mut n = 0;
        if let Some(sections) = rx(r"(?s)\bconst\s+SECTIONS\s*=\s*\[(.*?)\]\s*;").captures(&body) {
            for (ch, group) in
                rx(r#"(?s)\btitle\s*:\s*['"]([^'"]*)['"]\s*,\s*ids\s*:\s*\[([^\]]*)\]"#)
                    .captures_iter(&sections[1])
                    .enumerate()
            {
                for id in rx(r#"['"]([^'"]+)['"]"#).captures_iter(&group[2]) {
                    n += 1;
                    let key = format!("{base}/{slug}/{}.md", &id[1]);
                    if let Some(doc) = docs.get_mut(&key) {
                        merge(doc, &json!({"ch":ch+1,"chapter":&group[1],"order":n}));
                    }
                }
            }
        }
    }
    for d in docs.as_object_mut().unwrap().values_mut() {
        d["copies"].as_array_mut().unwrap().sort_by(|a, b| {
            let ca = sources[a["src"].as_u64().unwrap() as usize]["configured"] == true;
            let cb = sources[b["src"].as_u64().unwrap() as usize]["configured"] == true;
            cb.cmp(&ca)
                .then(number(&b["mtime"]).total_cmp(&number(&a["mtime"])))
        });
        if d["kind"] == "md" {
            let s = fs::read_to_string(text(&d["copies"][0]["abs"])).unwrap_or_default();
            let mut fence = false;
            for ln in s.lines().take(400) {
                if ln.trim_start().starts_with("```") || ln.trim_start().starts_with("~~~") {
                    fence = !fence;
                } else if !fence {
                    if let Some(h) = ln.strip_prefix("# ") {
                        let id = text(&d["key"])
                            .splitn(3, '/')
                            .last()
                            .unwrap_or("")
                            .trim_end_matches(".md");
                        let h = h.trim_end_matches('#').trim();
                        let title = h
                            .strip_prefix(&format!("{id} "))
                            .or_else(|| {
                                h.strip_prefix(&format!(
                                    "{} ",
                                    Path::new(id)
                                        .file_name()
                                        .unwrap_or_default()
                                        .to_string_lossy()
                                ))
                            })
                            .unwrap_or(h);
                        d["title"] = json!(title);
                        break;
                    }
                }
            }
        }
    }
    if !refs.is_object() {
        refs = obj();
    }
    for k in ["refs", "sessions", "scanned"] {
        if !refs[k].is_object() {
            refs[k] = obj();
        }
    }
    let old_refs = refs.clone();
    if !roots.is_empty() && app.config.design_days > 0. {
        let live = sessions
            .iter()
            .map(|s| s.path.clone())
            .collect::<HashSet<_>>();
        let mut scanned = 0;
        for (path, kind) in app.transcript_paths(app.config.design_days * 24.) {
            let stamp = json!([
                mtime(&path),
                fs::metadata(&path).map(|m| m.len()).unwrap_or(0)
            ]);
            if live.contains(&path) || refs["scanned"][&path] == stamp {
                continue;
            }
            let mut session = crate::sessions::Session::new(&path, &kind);
            if session.poll().is_ok() {
                refs["scanned"][&path] = stamp;
                sessions.push(std::sync::Arc::new(session));
            }
            scanned += 1;
            if scanned >= 20 {
                break;
            }
        }
    }
    for sess in &sessions {
        refs["sessions"][sess.id()] = json!({"path":sess.path,"kind":sess.kind,"title":sess.data["title"],"task":sess.data["task_id"],"parent":sess.data["parent"]});
        for r in &sess.reads {
            let p = real(text(&r["abs"]));
            let key = roots.iter().find_map(|(root, _)| {
                p.strip_prefix(root).ok().map(|rel| {
                    format!(
                        "{}/{}",
                        root.file_name().unwrap_or_default().to_string_lossy(),
                        rel.to_string_lossy()
                    )
                })
            });
            let Some(key) = key else { continue };
            let Some(doc) = docs.get(&key) else { continue };
            let sections = if doc["kind"] == "md" {
                toc(&fs::read_to_string(&p).unwrap_or_default())
            } else {
                vec![json!({"id":"全体","start":1,"end":1})]
            };
            let mut ranges = array(&r["ranges"]).to_vec();
            if ranges.is_empty() {
                ranges.push(json!([1, u64::MAX]));
            }
            for range in ranges {
                let a = range[0].as_u64().unwrap_or(1);
                let b = range[1].as_u64().unwrap_or(u64::MAX);
                for sec in &sections {
                    let lo = a.max(sec["start"].as_u64().unwrap_or(1));
                    let hi = b.min(sec["end"].as_u64().unwrap_or(1));
                    if lo > hi {
                        continue;
                    }
                    let k = format!(
                        "{}|{}|{}|{}|{}",
                        sess.id(),
                        text(&r["call"]),
                        key,
                        text(&sec["id"]),
                        text(&r["kind"])
                    );
                    let existing = &refs["refs"][&k];
                    let (lo, hi) = if existing["lines"].is_array() {
                        (
                            lo.min(existing["lines"][0].as_u64().unwrap_or(lo)),
                            hi.max(existing["lines"][1].as_u64().unwrap_or(hi)),
                        )
                    } else {
                        (lo, hi)
                    };
                    let cover = ((hi - lo + 1) as f64
                        / (number(&sec["end"]) - number(&sec["start"]) + 1.).max(1.))
                    .min(1.);
                    let ticket = array(&plans).iter().find_map(|plan| {
                        array(&plan["tickets"])
                            .iter()
                            .find(|t| {
                                array(&t["task_ids"]).contains(&sess.data["task_id"])
                                    || t["task_id"] == sess.data["task_id"]
                                        && !sess.data["task_id"].is_null()
                            })
                            .map(|t| (plan, t))
                    });
                    refs["refs"][&k] = json!({"doc":key,"section":sec["id"],"session":sess.id(),"kind":r["kind"],"ts":r["ts"],"lines":[lo,hi],"exact":r["exact"],"cover":cover,"call":r["call"],"tool":r["tool"],"hits":r["hits"],"commit":ticket.map(|(p,_)|&p["design_commit"]),"ticket":ticket.map(|(_,t)|&t["package"])});
                }
            }
        }
    }
    let version = old["version"].as_u64().unwrap_or(0)
        + u64::from(old["docs"] != docs || old["sources"] != json!(sources) || old_refs != refs);
    let design =
        json!({"enabled":!roots.is_empty(),"version":version,"sources":sources,"docs":docs});
    if old_refs != refs {
        save_json(app.config.data.join("design-refs.json"), &refs)?;
    }
    let mut s = app.state.write().unwrap();
    s.design = design;
    s.design_refs = refs;
    Ok(())
}
pub fn list(app: &App) -> Value {
    let s = app.state.read().unwrap();
    let mut docs = vec![];
    if let Some(ds) = s.design["docs"].as_object() {
        for (key, d) in ds {
            let refs = s.design_refs["refs"]
                .as_object()
                .into_iter()
                .flat_map(|m| m.values())
                .filter(|r| r["doc"] == *key)
                .collect::<Vec<_>>();
            let c = &d["copies"][0];
            let mut row = json!({"key":key,"kind":d["kind"],"src":c["src"],"copies":array(&d["copies"]).len(),"mtime":c["mtime"],"size":c["size"],"sessions":refs.iter().map(|r|text(&r["session"])).collect::<HashSet<_>>().len(),"reads":refs.iter().filter(|r|r["kind"]=="read").count(),"searches":refs.iter().filter(|r|r["kind"]=="search").count()});
            for k in ["title", "order", "ch", "chapter"] {
                if !d[k].is_null() {
                    row[k] = d[k].clone();
                }
            }
            docs.push(row);
        }
    }
    json!({"enabled":s.design["enabled"],"version":s.design["version"],"sources":s.design["sources"],"docs":docs,"gone":[],"plans":array(&s.plans).iter().filter(|p|p["design_root"].is_string()).map(|p|json!({"project":p["project"],"path":p["path"],"design_root":p["design_root"],"design_commit":p["design_commit"]})).collect::<Vec<_>>(),"refs":s.design_refs["refs"].as_object().map(|o|o.len()).unwrap_or(0)})
}
pub fn doc(app: &App, key: &str) -> Result<Value> {
    let s = app.state.read().unwrap();
    let d = s.design["docs"].get(key).ok_or("not found")?;
    let c = &d["copies"][0];
    let src = &s.design["sources"][c["src"].as_u64().ok_or("not found")? as usize];
    let mut out = json!({"key":key,"kind":d["kind"],"mtime":c["mtime"],"size":c["size"],"source":src,"copies":array(&d["copies"]).iter().map(|c|{let mut s=s.design["sources"][c["src"].as_u64().unwrap()as usize].clone();s["mtime"]=c["mtime"].clone();s}).collect::<Vec<_>>(),"plans":[]});
    for k in ["title", "ch", "chapter"] {
        if !d[k].is_null() {
            out[k] = d[k].clone();
        }
    }
    if d["kind"] == "md" {
        if number(&c["size"]) > (32 << 20) as f64 {
            return Err("문서가 너무 큼".into());
        }
        let body = fs::read_to_string(text(&c["abs"])).map_err(|e| e.to_string())?;
        out["toc"] = json!(toc(&body));
        out["content"] = json!(body);
    }
    let mut rows: BTreeMap<(String, String), Value> = BTreeMap::new();
    for r in s.design_refs["refs"]
        .as_object()
        .into_iter()
        .flat_map(|o| o.values())
        .filter(|r| r["doc"] == key)
    {
        let sid = text(&r["session"]);
        let m = &s.design_refs["sessions"][sid];
        let row=rows.entry((text(&r["section"]).into(),sid.into())).or_insert_with(||json!({"section":r["section"],"session":sid,"title":m["title"],"path":m["path"],"kind":m["kind"],"parent":m["parent"],"reads":0,"searches":0,"lines":[],"cover":null,"first":r["ts"],"last":r["ts"],"exact":false,"commits":[],"ticket":r["ticket"]}));
        let k = if r["kind"] == "read" {
            "reads"
        } else {
            "searches"
        };
        row[k] = json!(number(&row[k]) + 1.);
        if text(&r["ts"]) > text(&row["last"]) {
            row["last"] = r["ts"].clone();
        }
        if text(&r["ts"]) < text(&row["first"]) {
            row["first"] = r["ts"].clone();
        }
        if r["lines"].is_array() {
            row["lines"]
                .as_array_mut()
                .unwrap()
                .push(r["lines"].clone());
        }
        if r["exact"] == true {
            row["exact"] = json!(true);
        }
        if r["commit"].is_string() && !array(&row["commits"]).contains(&r["commit"]) {
            row["commits"]
                .as_array_mut()
                .unwrap()
                .push(r["commit"].clone());
        }
    }
    for row in rows.values_mut() {
        let merged = union(array(&row["lines"]));
        let covered = merged.iter().map(|(a, b)| b - a + 1).sum::<u64>();
        if let Some(sec) = array(&out["toc"])
            .iter()
            .find(|s| s["id"] == row["section"])
        {
            let total = number(&sec["end"]) - number(&sec["start"]) + 1.;
            row["cover"] = json!((covered as f64 / total.max(1.)).min(1.));
        }
        row["lines"] = json!(merged);
    }
    let mut rows = rows.into_values().collect::<Vec<_>>();
    rows.sort_by(|a, b| text(&b["last"]).cmp(text(&a["last"])));
    out["refs"] = json!(rows);
    Ok(out)
}
fn union(lines: &[Value]) -> Vec<(u64, u64)> {
    let mut a = lines
        .iter()
        .filter_map(|v| Some((v[0].as_u64()?, v[1].as_u64()?)))
        .collect::<Vec<_>>();
    a.sort();
    let mut out: Vec<(u64, u64)> = vec![];
    for (a, b) in a {
        if let Some(last) = out.last_mut().filter(|(_, end)| a <= end.saturating_add(1)) {
            last.1 = last.1.max(b);
        } else {
            out.push((a, b));
        }
    }
    out
}
pub fn file(app: &App, key: &str) -> Result<(PathBuf, &'static str)> {
    let s = app.state.read().unwrap();
    let d = s.design["docs"].get(key).ok_or("not found")?;
    if d["kind"] == "md" {
        return Err("not found".into());
    }
    let c = &d["copies"][0];
    let src = &s.design["sources"][c["src"].as_u64().ok_or("not found")? as usize];
    let p = real(text(&c["abs"]));
    let root = real(text(&src["dir"]));
    if !p.starts_with(root) || !p.is_file() {
        return Err("not found".into());
    }
    if fs::metadata(&p).map_err(|e| e.to_string())?.len() > 32 << 20 {
        return Err("파일이 너무 큼".into());
    }
    let typ = mime(&p).ok_or("not found")?.1;
    Ok((p, typ))
}
pub fn session_refs(app: &App, sid: &str) -> Vec<Value> {
    let s = app.state.read().unwrap();
    let refs = s.design_refs.clone();
    let mut ids = HashSet::from([sid.to_owned()]);
    for (k, m) in refs["sessions"]
        .as_object()
        .into_iter()
        .flat_map(|m| m.iter())
    {
        if m["parent"] == sid {
            ids.insert(k.clone());
        }
    }
    let mut rows: BTreeMap<(String, String), Value> = BTreeMap::new();
    for r in refs["refs"]
        .as_object()
        .into_iter()
        .flat_map(|m| m.values())
        .filter(|r| ids.contains(text(&r["session"])))
    {
        let row=rows.entry((text(&r["doc"]).into(),text(&r["section"]).into())).or_insert_with(||json!({"doc":r["doc"],"section":r["section"],"reads":0,"searches":0,"lines":[],"cover":null,"first":r["ts"],"last":r["ts"],"sub":false}));
        let k = if r["kind"] == "read" {
            "reads"
        } else {
            "searches"
        };
        row[k] = json!(number(&row[k]) + 1.);
        if r["session"] != sid {
            row["sub"] = json!(true);
        }
        if text(&r["ts"]) < text(&row["first"]) {
            row["first"] = r["ts"].clone();
        }
        if text(&r["ts"]) > text(&row["last"]) {
            row["last"] = r["ts"].clone();
        }
        if r["lines"].is_array() {
            row["lines"]
                .as_array_mut()
                .unwrap()
                .push(r["lines"].clone());
        }
    }
    for row in rows.values_mut() {
        let doc = &s.design["docs"][text(&row["doc"])];
        let sections = toc(&fs::read_to_string(text(&doc["copies"][0]["abs"])).unwrap_or_default());
        let sec = sections.iter().find(|sec| sec["id"] == row["section"]);
        row["no"] = sec.map(|v| v["no"].clone()).unwrap_or_else(|| {
            json!(
                rx(r"^§?\s*(\d+(?:[.-]\d+)*)")
                    .captures(text(&row["section"]))
                    .map(|m| m[1].to_owned())
            )
        });
        row["start"] = sec.map(|v| v["start"].clone()).unwrap_or(Value::Null);
        for key in ["title", "ch", "chapter"] {
            if !doc[key].is_null() {
                row[format!("doc_{key}")] = doc[key].clone();
            }
        }
        if let Some(sec) = sec {
            let covered = union(array(&row["lines"]))
                .iter()
                .map(|(a, b)| b - a + 1)
                .sum::<u64>();
            row["cover"] = json!(
                (covered as f64 / (number(&sec["end"]) - number(&sec["start"]) + 1.).max(1.))
                    .min(1.)
            );
        }
        row.as_object_mut().unwrap().remove("lines");
    }
    let mut out = rows.into_values().collect::<Vec<_>>();
    out.sort_by(|a, b| {
        text(&a["doc"])
            .cmp(text(&b["doc"]))
            .then(number(&a["start"]).total_cmp(&number(&b["start"])))
    });
    out
}
