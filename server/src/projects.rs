use crate::{core::*, sessions::rx};
use serde_json::{Value, json};
use std::{collections::HashSet, fs, path::Path};
pub const STATES: [&str; 5] = ["scheduling", "pending", "active", "done", "failed"];
pub fn problems(d: &Value, folder: &str) -> Vec<String> {
    let mut out = vec![];
    let Some(o) = d.as_object() else {
        return vec!["최상위가 객체가 아님".into()];
    };
    for k in o.keys() {
        if ![
            "schemaVersion",
            "project",
            "template",
            "generatedAt",
            "stages",
        ]
        .contains(&k.as_str())
        {
            out.push(format!("알 수 없는 키 {k}"));
        }
    }
    for k in ["schemaVersion", "project", "stages"] {
        if !o.contains_key(k) {
            out.push(format!("{k} 없음"));
        }
    }
    if d["schemaVersion"].as_u64() != Some(1) {
        out.push("지원하지 않는 schemaVersion".into());
    }
    if d["project"] != folder {
        out.push("project 가 폴더 이름과 다름".into());
    }
    if d["stages"].as_array().is_none_or(|a| a.is_empty()) {
        out.push("stages 가 비어 있지 않은 배열이 아님".into());
    }
    if let Some(s) = d.get("generatedAt") {
        if epoch(text(s)).is_none() {
            out.push("generatedAt 가 date-time 이 아님".into());
        }
    }
    if d.get("template").is_some_and(|v| text(v).is_empty()) {
        out.push("template 이 비어 있지 않은 문자열이 아님".into());
    }
    let mut nos = HashSet::new();
    let mut paths = HashSet::new();
    for (i, st) in array(&d["stages"]).iter().enumerate() {
        if !st.is_object() {
            out.push(format!("stages[{i}] 가 객체가 아님"));
            continue;
        }
        for key in st.as_object().unwrap().keys() {
            if !["no", "name", "steps"].contains(&key.as_str()) {
                out.push(format!("stages[{i}]: 알 수 없는 키 {key}"));
            }
        }
        if !st["no"].as_u64().is_some_and(|n| n > 0 && nos.insert(n)) {
            out.push(format!("stages[{i}]: no 오류·중복"));
        }
        if text(&st["name"]).is_empty() || !st["steps"].is_array() {
            out.push(format!("stages[{i}]: name·steps 오류"));
        }
        for (j, sp) in array(&st["steps"]).iter().enumerate() {
            let at = format!("stages[{i}].steps[{j}]");
            let Some(object) = sp.as_object() else {
                out.push(format!("{at} 가 객체가 아님"));
                continue;
            };
            for key in object.keys() {
                if !["path", "date", "endDate", "status"].contains(&key.as_str()) {
                    out.push(format!("{at}: 알 수 없는 키 {key}"));
                }
            }
            let path = text(&sp["path"]);
            if path.is_empty() || !paths.insert(path.to_owned()) {
                out.push(format!("{at}: path 없음·중복"));
            }
            let status = text(&sp["status"]);
            if !STATES.contains(&status) {
                out.push(format!("{at}: status 오류"));
            }
            for k in ["date", "endDate"] {
                if let Some(v) = sp.get(k) {
                    if chrono::NaiveDate::parse_from_str(text(v), "%Y-%m-%d").is_err()
                        || !rx(r"^\d{4}-\d{2}-\d{2}$").is_match(text(v))
                    {
                        out.push(format!("{at}: {k} date 오류"));
                    }
                }
            }
            if status == "scheduling" && (!sp["date"].is_null() || !sp["endDate"].is_null())
                || status != "scheduling" && sp["date"].is_null()
            {
                out.push(format!("{at}: status와 날짜 불일치"));
            }
        }
    }
    out
}
fn tally(steps: &[Value]) -> Value {
    let mut c = json!({"scheduling":0,"pending":0,"active":0,"done":0,"failed":0});
    for s in steps {
        let st = text(&s["status"]);
        if STATES.contains(&st) {
            c[st] = json!(number(&c[st]) + 1.);
        }
    }
    let total = steps.len();
    let done = number(&c["done"]);
    let finished = done + number(&c["failed"]);
    let state = if total == 0 {
        "empty"
    } else if done == total as f64 {
        "done"
    } else if finished == total as f64 {
        "failed"
    } else if number(&c["active"]) > 0. || finished > 0. {
        "active"
    } else if number(&c["pending"]) > 0. {
        "pending"
    } else {
        "scheduling"
    };
    let start = steps.iter().filter_map(|s| s["date"].as_str()).min();
    let end = steps
        .iter()
        .filter_map(|s| s["endDate"].as_str().or(s["date"].as_str()))
        .max();
    json!({"status":state,"total":total,"counts":c,"ratio":if total>0{json!((done/total as f64*10000.).round()/10000.)}else{Value::Null},"start":start,"end":end})
}
pub fn derive(d: &Value) -> Value {
    let mut stages = array(&d["stages"]).to_vec();
    stages.sort_by_key(|s| s["no"].as_i64());
    for st in &mut stages {
        let mut steps = array(&st["steps"]).to_vec();
        for sp in &mut steps {
            sp["title"] = json!(
                Path::new(text(&sp["path"]))
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
            );
        }
        steps.sort_by(|a, b| {
            a["date"]
                .as_str()
                .unwrap_or("9999")
                .cmp(b["date"].as_str().unwrap_or("9999"))
                .then(text(&a["path"]).cmp(text(&b["path"])))
        });
        merge(st, &tally(&steps));
        st["steps"] = json!(steps);
    }
    let cur = stages
        .iter()
        .find(|s| s["status"] == "active")
        .or_else(|| {
            let last = stages
                .iter()
                .rposition(|s| number(&s["counts"]["done"]) + number(&s["counts"]["failed"]) > 0.)
                .map(|i| i + 1)
                .unwrap_or(0);
            stages[last..]
                .iter()
                .find(|s| matches!(text(&s["status"]), "pending" | "scheduling"))
        })
        .map(|s| json!({"no":s["no"],"name":s["name"],"status":s["status"]}));
    let mut out = tally(
        &stages
            .iter()
            .flat_map(|s| array(&s["steps"]).to_vec())
            .collect::<Vec<_>>(),
    );
    merge(
        &mut out,
        &json!({"template":d["template"],"generated_at":d["generatedAt"],"stage_count":stages.len(),"current":cur,"stages":stages}),
    );
    out
}
pub fn collect(config: &Config, version: u64) -> Value {
    let mut dirs = vec![];
    let mut list = vec![];
    for base in &config.projects {
        match fs::read_dir(base) {
            Err(e) => dirs.push(json!({"dir":base,"error":e.to_string()})),
            Ok(entries) => {
                dirs.push(json!({"dir":base,"error":null}));
                let mut entries = entries.flatten().collect::<Vec<_>>();
                entries.sort_by_key(|e| e.file_name());
                for e in entries {
                    let p = e.path().join("progress.json");
                    if !p.is_file() {
                        continue;
                    }
                    let name = e.file_name().to_string_lossy().into_owned();
                    let d = read_json(&p);
                    let errs = problems(&d, &name);
                    let mut entry =
                        json!({"name":name,"dir":base,"path":p,"mtime":mtime(&p),"error":null});
                    if errs.is_empty() {
                        merge(&mut entry, &derive(&d));
                    } else {
                        entry["error"] = json!(format!(
                            "스키마 불일치 ({}건): {}",
                            errs.len(),
                            errs.iter().take(5).cloned().collect::<Vec<_>>().join("; ")
                        ));
                        entry["problems"] = json!(errs);
                    }
                    list.push(entry);
                }
            }
        }
    }
    json!({"enabled":!config.projects.is_empty(),"version":version,"dirs":dirs,"list":list})
}
pub fn lite(mut p: Value) -> Value {
    if let Some(st) = p["stages"].as_array_mut() {
        for s in st {
            if let Some(o) = s.as_object_mut() {
                o.remove("steps");
            }
        }
    }
    p
}
pub fn note(entry: &Value, rel: &str) -> Result<Value> {
    let root = real(
        Path::new(text(&entry["path"]))
            .parent()
            .unwrap_or(Path::new(".")),
    );
    let full = real(root.join(rel));
    if !full.starts_with(&root) || full.extension().is_none_or(|e| e != "md") || !full.is_file() {
        return Err("not found".into());
    }
    if fs::metadata(&full).map_err(|e| e.to_string())?.len() > 1 << 20 {
        return Err("노트가 너무 큼".into());
    }
    let s = fs::read_to_string(&full).map_err(|e| e.to_string())?;
    let notes = files(&root, "md");
    let mut links = vec![];
    for m in rx(r"\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]").captures_iter(&s) {
        let want = format!("{}.md", m[1].trim().trim_end_matches(".md"));
        let mut hits = notes
            .iter()
            .filter_map(|p| p.strip_prefix(&root).ok())
            .filter(|p| {
                p.to_string_lossy().ends_with(&want) || want.ends_with(p.to_string_lossy().as_ref())
            })
            .collect::<Vec<_>>();
        hits.sort_by_key(|p| std::cmp::Reverse(p.as_os_str().len()));
        links.push(json!({"target":m[1].trim(),"path":hits.first()}));
    }
    Ok(
        json!({"project":entry["name"],"path":full.strip_prefix(&root).unwrap(),"abs":full,"mtime":mtime(&full),"content":s,"links":links}),
    )
}
