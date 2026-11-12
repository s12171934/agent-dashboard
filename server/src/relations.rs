use crate::{app::App, core::*};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
pub fn apply(app: &App, summaries: &mut [Value], plans: &mut Value, orca: &Value) -> Result<()> {
    let plan_guard = app.persistence.lock().unwrap();
    let mut history = read_json(app.config.data.join("plan-history.json"));
    if !history.is_object() {
        history = obj();
    }
    let original = history.clone();
    let mut aliases: HashMap<String, Vec<usize>> = HashMap::new();
    let owned = summaries
        .iter()
        .filter(|s| s["parent"].is_null())
        .filter_map(|s| s["own_handle"].as_str().map(str::to_owned))
        .collect::<HashSet<_>>();
    for (i, s) in summaries
        .iter()
        .enumerate()
        .filter(|(_, s)| s["parent"].is_null())
    {
        for h in array(&s["own_aliases"]) {
            if !owned.contains(text(h)) {
                aliases.entry(text(h).into()).or_default().push(i);
            }
        }
    }
    let primary = aliases
        .iter()
        .filter(|(_, v)| v.len() == 1)
        .map(|(h, v)| (h.clone(), summaries[v[0]]["own_handle"].clone()))
        .collect::<HashMap<_, _>>();
    for s in summaries.iter_mut().filter(|s| s["parent"].is_null()) {
        if s["role"] == "worker" {
            if let Some(h) = primary.get(text(&s["coord_handle"])) {
                s["coord_alias"] = s["coord_handle"].clone();
                s["coord_handle"] = h.clone();
            }
        }
    }
    for (h, indices) in aliases {
        if indices.len() == 1 {
            let s = &mut summaries[indices[0]];
            if !array(&s["made_terms"]).contains(&json!(h)) {
                s["made_terms"].as_array_mut().unwrap().push(json!(h));
            }
        }
    }
    let reviews = app.state.read().unwrap().reviews.clone();
    let mut links = HashMap::new();
    for set in array(&reviews["sets"]) {
        for t in array(&set["tickets"]) {
            for (w, c) in t["qa"]["links"]
                .as_object()
                .into_iter()
                .flat_map(|o| o.iter())
            {
                links.insert(w.clone(), c.clone());
            }
        }
    }
    let heads = links
        .values()
        .filter_map(Value::as_str)
        .collect::<HashSet<_>>();
    for s in summaries.iter_mut().filter(|s| s["parent"].is_null()) {
        let h = s["orca_focus"]
            .as_str()
            .or(s["own_handle"].as_str())
            .unwrap_or("")
            .to_owned();
        if s["role"] == "solo" && links.get(&h).is_some_and(|c| *c != h) {
            s["role"] = json!("worker");
            s["coord_handle"] = links[&h].clone();
            if s["own_handle"].is_null() {
                s["own_handle"] = json!(h);
            }
        } else if s["role"] != "worker" && heads.contains(h.as_str()) {
            s["role"] = json!("coordinator");
            if s["own_handle"].is_null() {
                s["own_handle"] = json!(h);
            }
        }
    }
    let by_id = summaries
        .iter()
        .enumerate()
        .filter(|(_, s)| s["parent"].is_null())
        .map(|(i, s)| (text(&s["id"]).to_owned(), i))
        .collect::<HashMap<_, _>>();
    let mut by_handle = HashMap::new();
    for (i, s) in summaries
        .iter()
        .enumerate()
        .filter(|(_, s)| s["parent"].is_null())
    {
        if let Some(h) = s["own_handle"].as_str() {
            by_handle.insert(h.to_owned(), i);
        }
        for h in array(&s["own_aliases"]) {
            by_handle.entry(text(h).to_owned()).or_insert(i);
        }
    }
    if let Some(plans) = plans.as_array_mut() {
        for p in plans {
            let path = text(&p["path"]).to_owned();
            let sid = text(&p["coordinator_session"]);
            let sched = text(&p["scheduler_terminal"]);
            let found = by_id
                .get(sid)
                .copied()
                .or_else(|| by_handle.get(text(&p["coordinator_terminal"])).copied())
                .or_else(|| {
                    if sched.is_empty() {
                        None
                    } else {
                        summaries
                            .iter()
                            .position(|s| array(&s["made_terms"]).contains(&json!(sched)))
                    }
                })
                .or_else(|| by_handle.get(sched).copied())
                .or_else(|| by_id.get(text(&history[&path]["owner"])).copied());
            if let Some(mut i) = found {
                let mut seen = HashSet::new();
                while summaries[i]["role"] == "worker" && seen.insert(i) {
                    let Some(parent) = by_handle.get(text(&summaries[i]["coord_handle"])) else {
                        break;
                    };
                    i = *parent;
                }
                let id = summaries[i]["id"].clone();
                if p["coordinator_session"] != id {
                    p["coordinator_session"] = id.clone();
                    p["coordinator_inferred"] = json!(true);
                }
                if !history[&path].is_object() {
                    history[&path] = obj();
                }
                history[&path]["owner"] = id;
                let mut extra = vec![p["scheduler_terminal"].clone()];
                extra.extend(
                    array(&p["tickets"])
                        .iter()
                        .map(|t| t["driver_terminal_handle"].clone()),
                );
                extra.extend(array(&p["driver_history"]).to_vec());
                extra.extend(
                    array(&orca["runs"])
                        .iter()
                        .filter(|r| array(&p["run_ids"]).contains(&r["id"]))
                        .map(|r| r["coordinator_handle"].clone()),
                );
                for h in extra.into_iter().filter(Value::is_string) {
                    if !array(&summaries[i]["made_terms"]).contains(&h) {
                        summaries[i]["made_terms"].as_array_mut().unwrap().push(h);
                    }
                }
            } else {
                p["owner_problem"] = json!(if !sid.is_empty() {
                    format!("계획이 적은 코디네이터 세션 {} 을 찾지 못함", short(sid, 8))
                } else {
                    "계획의 코디네이터·스케줄러 세션을 찾지 못함".into()
                });
            }
        }
    }
    if original != history {
        save_json(app.config.data.join("plan-history.json"), &history)?;
    }
    drop(plan_guard);
    let mut settled = read_json(app.config.data.join("settled.json"));
    if !settled.is_object() {
        settled = obj();
    }
    if !settled["tasks"].is_object() {
        settled["tasks"] = obj();
    }
    let old = settled.clone();
    for w in array(&orca["workers"]) {
        if matches!(
            text(&w["dispatchStatus"]),
            "completed" | "failed" | "cancelled"
        ) {
            settled["tasks"][text(&w["taskId"])] = w["dispatchStatus"].clone();
        }
    }
    for t in orca["tasks"]
        .as_object()
        .into_iter()
        .flat_map(|o| o.values())
        .flat_map(array)
    {
        if matches!(text(&t["status"]), "completed" | "failed" | "cancelled") {
            settled["tasks"][text(&t["id"])] = t["status"].clone();
        }
    }
    if old != settled {
        save_json(app.config.data.join("settled.json"), &settled)?;
    }
    let long = summaries
        .iter()
        .filter(|s| s["kind"] == "claude" && number(&s["ctx_peak"]) > 200000.)
        .map(|s| s["model"].clone())
        .collect::<Vec<_>>();
    for s in summaries.iter_mut() {
        if s["kind"] == "claude" && number(&s["compactions"]) == 0. && long.contains(&s["model"]) {
            s["ctx_window"] = json!(1000000);
        }
        let status = &settled["tasks"][text(&s["task_id"])];
        if status.is_string() {
            let completed = orca["tasks"]
                .as_object()
                .into_iter()
                .flat_map(|o| o.values())
                .flat_map(array)
                .find(|t| t["id"] == s["task_id"])
                .and_then(|t| epoch(text(&t["completed_at"])));
            let open = array(&orca["terminals"])
                .iter()
                .any(|t| t["connected"] == true && t["handle"] == s["own_handle"]);
            let went_on = completed
                .zip(epoch(text(&s["last_ts"])))
                .is_some_and(|(done, last)| last - done > 300.);
            if !(open && went_on) {
                merge(
                    s,
                    &json!({"state":"done","live":false,"state_reason":format!("Orca: dispatch {}",text(status))}),
                );
            }
        }
    }
    let mut prefs = app.state.read().unwrap().prefs.clone();
    let before = prefs.clone();
    for s in summaries.iter_mut() {
        let focus = text(&s["orca_focus"]);
        let key = format!("orca-terminal:{focus}");
        if s["pending"] != true && s["char"].is_null() && prefs["chars"][&key].is_object() {
            s["char"] = prefs["chars"][&key].clone();
            prefs["chars"][text(&s["path"])] = s["char"].clone();
        }
    }
    let pending = summaries
        .iter()
        .filter(|s| s["pending"] == true)
        .map(|s| text(&s["path"]).to_owned())
        .collect::<HashSet<_>>();
    if number(&orca["updated"]) > 0. && orca["error"].is_null() {
        prefs["chars"]
            .as_object_mut()
            .unwrap()
            .retain(|k, _| !k.starts_with("orca-terminal:") || pending.contains(k));
    }
    if prefs != before {
        let mut state = app.state.write().unwrap();
        for (key, value) in prefs["chars"].as_object().unwrap() {
            if before["chars"][key] != *value {
                state.prefs["chars"][key] = value.clone();
            }
        }
        for key in before["chars"].as_object().unwrap().keys() {
            if prefs["chars"].get(key).is_none() {
                state.prefs["chars"].as_object_mut().unwrap().remove(key);
            }
        }
        drop(state);
        app.save_prefs()?;
    }
    Ok(())
}
pub fn close_tree(sm: &Value, summaries: &[Value], orca: &Value) -> Vec<Value> {
    let mut owners = [
        text(&sm["own_handle"]).to_owned(),
        text(&sm["orca_focus"]).to_owned(),
    ]
    .into_iter()
    .chain(array(&sm["made_terms"]).iter().map(|h| text(h).to_owned()))
    .collect::<HashSet<_>>();
    let mut tree = HashSet::from([text(&sm["id"]).to_owned()]);
    let mut level = array(&sm["made_terms"]).to_vec();
    loop {
        let kids = summaries
            .iter()
            .filter(|w| {
                w["role"] == "worker"
                    && w["parent"].is_null()
                    && !tree.contains(text(&w["id"]))
                    && owners.contains(text(&w["coord_handle"]))
            })
            .collect::<Vec<_>>();
        if kids.is_empty() {
            break;
        }
        for w in kids {
            tree.insert(text(&w["id"]).into());
            level.push(w["orca_focus"].clone());
            level.extend(array(&w["made_terms"]).to_vec());
            owners.extend([
                text(&w["own_handle"]).to_owned(),
                text(&w["orca_focus"]).to_owned(),
            ]);
            owners.extend(array(&w["made_terms"]).iter().map(|h| text(h).to_owned()));
        }
    }
    let foreign = summaries
        .iter()
        .filter(|s| !tree.contains(text(&s["id"])))
        .map(|s| text(&s["orca_focus"]))
        .collect::<HashSet<_>>();
    let connected = array(&orca["terminals"])
        .iter()
        .filter(|t| t["connected"] == true)
        .map(|t| text(&t["handle"]))
        .collect::<HashSet<_>>();
    let mut seen = HashSet::new();
    level
        .into_iter()
        .rev()
        .filter(|h| {
            h.is_string()
                && *h != sm["orca_focus"]
                && connected.contains(text(h))
                && !foreign.contains(text(h))
                && seen.insert(text(h).to_owned())
        })
        .collect()
}
