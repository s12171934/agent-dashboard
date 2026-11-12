use crate::core::*;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
pub fn record(config: &Config, b: &Value) -> Result<usize> {
    let env = &b["env"];
    let events = b["events"].as_array().ok_or("bad request")?;
    if !env.is_object()
        || text(&env["app"]).is_empty()
        || text(&env["form"]).is_empty()
        || text(&env["app"]).chars().count() > 40
        || text(&env["form"]).chars().count() > 40
        || events.len() > 500
    {
        return Err("bad request".into());
    }
    let mut rows = vec![];
    for e in events {
        let v = text(&e["v"]);
        let f = text(&e["f"]);
        if v.is_empty()
            || v.chars().count() > 40
            || f.is_empty()
            || f.chars().count() > 120
            || !e["t"].is_number()
        {
            return Err("bad request".into());
        }
        let ts = chrono::DateTime::from_timestamp_millis(number(&e["t"]) as i64)
            .ok_or("bad request")?
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let mut row = json!({"ts":ts,"view":v,"feat":f});
        for k in ["app", "form", "pointer", "dev"] {
            if env[k]
                .as_str()
                .is_some_and(|s| !s.is_empty() && s.chars().count() <= 40)
            {
                row[k] = env[k].clone();
            }
        }
        if e["m"]
            .as_str()
            .is_some_and(|s| !s.is_empty() && s.chars().count() <= 40)
        {
            row["form"] = e["m"].clone();
        }
        if e["d"].as_u64().is_some_and(|d| d > 0 && d <= 86400) {
            row["secs"] = e["d"].clone();
        }
        rows.push(row);
    }
    for row in &rows {
        append_json(config.data.join("usage.jsonl"), row)?;
    }
    Ok(rows.len())
}
pub fn report(config: &Config, days: u64, by: &str, top: usize, rare: u64) -> Value {
    let path = config.data.join("usage.jsonl");
    let mut rows = read_lines(&path);
    rows.retain(|r| {
        ["ts", "app", "form", "feat", "view"]
            .iter()
            .all(|key| r[key].is_string())
    });
    rows.retain(|r| {
        days == 0 || epoch(text(&r["ts"])).is_some_and(|t| t >= now() - days as f64 * 86400.)
    });
    let mut clicks: BTreeMap<String, BTreeMap<String, u64>> = BTreeMap::new();
    let mut opens: BTreeMap<String, BTreeMap<String, u64>> = BTreeMap::new();
    let mut stay: BTreeMap<String, BTreeMap<String, u64>> = BTreeMap::new();
    let mut devs: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut envs = BTreeSet::new();
    let mut views: Vec<String> = [
        "home",
        "agents",
        "session",
        "run",
        "driver",
        "compare",
        "talk",
        "tests",
        "worktrees",
        "trees",
        "decide",
        "chars",
        "usage",
        "projects",
        "designs",
    ]
    .map(str::to_owned)
    .to_vec();
    for r in &mut rows {
        let env = match by {
            "app" => text(&r["app"]).into(),
            "form" => text(&r["form"]).into(),
            _ => format!("{}/{}", text(&r["app"]), text(&r["form"])),
        };
        r["env"] = json!(env);
        envs.insert(env.clone());
        let v = text(&r["view"]).to_owned();
        if matches!(text(&r["feat"]), "open" | "stay") && !views.contains(&v) {
            views.push(v.clone());
        }
        if r["dev"].is_string() {
            devs.entry(env.clone())
                .or_default()
                .insert(text(&r["dev"]).into());
        }
        match text(&r["feat"]) {
            "open" => *opens.entry(env).or_default().entry(v).or_default() += 1,
            "stay" => {
                *stay.entry(env).or_default().entry(v).or_default() +=
                    r["secs"].as_u64().unwrap_or(0)
            }
            f => {
                *clicks
                    .entry(env)
                    .or_default()
                    .entry(format!("{v} · {f}"))
                    .or_default() += 1
            }
        }
    }
    views[15..].sort();
    let count = |m: &BTreeMap<String, BTreeMap<String, u64>>, e: &str, k: &str| {
        m.get(e).and_then(|m| m.get(k)).copied().unwrap_or(0)
    };
    let sum = |m: &BTreeMap<String, BTreeMap<String, u64>>, e: &str| {
        m.get(e).map(|m| m.values().sum::<u64>()).unwrap_or(0)
    };
    let mut every: BTreeMap<String, u64> = BTreeMap::new();
    for c in clicks.values() {
        for (k, n) in c {
            *every.entry(k.clone()).or_default() += n;
        }
    }
    let mut tops = obj();
    let mut rares = obj();
    for e in &envs {
        let mut c = clicks
            .get(e)
            .map(|m| m.iter().map(|(k, n)| json!([k, n])).collect::<Vec<_>>())
            .unwrap_or_default();
        c.sort_by(|a, b| number(&b[1]).total_cmp(&number(&a[1])));
        c.truncate(top);
        tops[e] = json!(c);
        let mut r = every
            .iter()
            .filter_map(|(k, n)| {
                let here = count(&clicks, e, k);
                (here <= rare && n - here >= 3).then(|| json!([k, here, n - here]))
            })
            .collect::<Vec<_>>();
        r.sort_by(|a, b| number(&b[2]).total_cmp(&number(&a[2])));
        r.truncate(top);
        rares[e] = json!(r);
    }
    let screens:Vec<_>=views.iter().map(|v|{let mut row=json!({"view":v});for e in &envs{let sec=count(&stay,e,v);row[e]=json!({"opens":count(&opens,e,v),"secs":sec,"share":sec as f64/sum(&stay,e).max(1)as f64});}row}).collect();
    json!({"log":path.exists(),"rows":rows.len(),"envs":envs.iter().map(|e|json!({"env":e,"devices":devs.get(e).map(|s|s.len()).unwrap_or(0),"clicks":sum(&clicks,e),"screen_secs":sum(&stay,e)})).collect::<Vec<_>>(),"screens":screens,"top":tops,"rare_here":rares,"rare_everywhere":every.iter().filter(|(_,n)|**n<=rare).map(|(k,n)|json!([k,n])).collect::<Vec<_>>(),"recent":rows.into_iter().rev().take(40).map(|r|{let mut v=obj();for k in ["ts","env","view","feat","secs"]{v[k]=r[k].clone();}v}).collect::<Vec<_>>()})
}
