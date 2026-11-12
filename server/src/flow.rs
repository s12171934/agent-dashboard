use crate::{core::*, sessions::rx};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
};
pub fn rules() -> Value {
    json!({"order":"순서 위반","missing":"필수 단계 누락","stall":"정체","repeat":"반복","plan":"계획 미이행"})
}
fn deviation(
    rule: &str,
    severity: &str,
    unit: &str,
    key: &str,
    reason: String,
    evidence: Vec<String>,
    refs: Value,
) -> Value {
    let mut d = json!({"id":format!("{rule}|{key}"),"rule":rule,"rule_name":rules()[rule],"severity":severity,"unit":unit,"reason":reason,"evidence":evidence,"session":null,"task_id":null,"task_ids":[],"ticket":null,"handles":[]});
    merge(&mut d, &refs);
    d
}
fn clock(ts: &str) -> String {
    epoch(ts)
        .and_then(|t| chrono::DateTime::from_timestamp(t as i64, 0))
        .map(|d| d.format("%H:%M").to_string())
        .unwrap_or("?".into())
}
fn role(t: &Value) -> String {
    let name = t["display_name"]
        .as_str()
        .or(t["task_title"].as_str())
        .unwrap_or("");
    rx(r"^[A-Z]+\d+(?:#\d+)?\s*(.*)$")
        .captures(name)
        .map(|m| m[1].trim().into())
        .unwrap_or_else(|| name.into())
}
pub fn contracts(prefs: &Value) -> Value {
    let path = expand(
        prefs["qa_contract"]
            .as_str()
            .unwrap_or("~/.claude/skills/qa-ticket-driver/exports/state-contract.md"),
    );
    let s = fs::read_to_string(&path).unwrap_or_default();
    let mut writer = BTreeMap::new();
    for c in rx(r"(?m)^\|\s*`(\w+)/[^`]*`[^|]*\|\s*([^|]+?)\s*\|").captures_iter(&s) {
        writer.entry(c[1].to_owned()).or_insert(c[2].to_owned());
    }
    let mut stages = vec![];
    for c in
        rx(r"(?m)^\|\s*(\d+)\s*\|\s*`(\w+)`\s*([^|]*?)\s*\|\s*(.*?)\s*\|\s*$").captures_iter(&s)
    {
        let first = rx(r"`(\w+)/").captures(&c[4]).map(|c| c[1].to_owned());
        let by = first
            .as_ref()
            .and_then(|k| writer.get(k))
            .cloned()
            .unwrap_or_default();
        let sig = rx(r"^`(\w+)/<KEY>(?:\.md)?`$")
            .captures(c[4].trim())
            .map(|c| c[1].to_owned());
        stages.push(json!({"no":c[1].parse::<u64>().unwrap_or(0),"key":&c[2],"label":c[3].trim(),"by":by,"user":by.contains("사용자"),"signal":sig}));
    }
    stages.sort_by_key(|s| s["no"].as_u64());
    let source = if stages.is_empty() {
        for (i, k) in [
            "selected",
            "worktree",
            "analysis",
            "implementing",
            "reviewing",
            "committed",
            "approved",
            "delivered",
            "cleaned",
        ]
        .iter()
        .enumerate()
        {
            stages.push(json!({"no":i+1,"key":k,"label":k,"by":"","user":false,"signal":null}));
        }
        Value::Null
    } else {
        json!(path)
    };
    let mut checkbox = prefs["checkbox_flow"].clone();
    if !checkbox.is_object() {
        checkbox = json!({"roles":["구현","리뷰 codex","리뷰 claude","판정"],"work":["구현"],"review":["리뷰 codex","리뷰 claude"],"verdict":["판정"]});
    }
    checkbox["source"] = json!(if prefs["checkbox_flow"].is_object() {
        "prefs.json checkbox_flow"
    } else {
        "agent-dashboard checkbox flow"
    });
    json!({"qa":{"source":source,"stages":stages},"checkbox":checkbox})
}
pub fn check(
    summaries: &[Value],
    tasks: &Value,
    plans: &HashMap<String, Value>,
    reviews: &Value,
    prefs: &Value,
    terms_known: bool,
) -> Value {
    check_at(summaries, tasks, plans, reviews, prefs, terms_known, now())
}
pub fn check_at(
    summaries: &[Value],
    tasks: &Value,
    plans: &HashMap<String, Value>,
    reviews: &Value,
    prefs: &Value,
    terms_known: bool,
    time: f64,
) -> Value {
    let contracts = contracts(prefs);
    let mut items = vec![];
    let mut sess_of = HashMap::new();
    for sm in summaries {
        if sm["parent"].is_null() {
            for t in array(&sm["task_ids"]) {
                sess_of.insert(text(t).to_owned(), sm);
            }
        }
        if !sm["parent"].is_null() {
            continue;
        }
        if sm["state"] == "stalled" {
            items.push(deviation(
                "stall",
                "bad",
                "session",
                text(&sm["path"]),
                format!("응답 없음 — {}", text(&sm["state_reason"])),
                vec![
                    format!("마지막 기록 {}", clock(text(&sm["last_ts"]))),
                    format!("마지막 동작: {}", text(&sm["last_action"]["text"])),
                ],
                json!({"session":sm["path"],"task_id":sm["task_id"]}),
            ));
        }
        let ended = sm["state"] == "done"
            || sm["state"] == "idle"
                && (sm["manual_idle"] == true
                    || sm["decision"].is_null()
                        && sm["orca_focus"].is_null()
                        && (!sm["own_handle"].is_null() && terms_known
                            || epoch(text(&sm["last_ts"])).is_some_and(|t| time - t >= 21600.)));
        if ended {
            if let Some(p) = plans.get(text(&sm["path"])) {
                let left = array(&p["steps"])
                    .iter()
                    .filter(|s| matches!(text(&s["st"]), "run" | "todo"))
                    .collect::<Vec<_>>();
                if !left.is_empty() {
                    items.push(deviation(
                        "plan",
                        "warn",
                        "session",
                        &format!("{}|{}", text(&sm["path"]), text(&p["ts"])),
                        format!("세션이 끝났는데 계획 {}단계가 남음", left.len()),
                        vec![format!(
                            "남은 단계: {}",
                            left.iter()
                                .take(4)
                                .map(|s| short(text(&s["t"]), 40))
                                .collect::<Vec<_>>()
                                .join(" · ")
                        )],
                        json!({"session":sm["path"],"task_id":sm["task_id"]}),
                    ));
                }
            }
        }
    }
    for (rid, ts) in tasks.as_object().into_iter().flat_map(|o| o.iter()) {
        let mut boxes: BTreeMap<String, Vec<&Value>> = BTreeMap::new();
        for t in array(ts) {
            let label = t["display_name"]
                .as_str()
                .or(t["task_title"].as_str())
                .unwrap_or("");
            if let Some(c) = rx(r"^([A-Z]+\d+#\d+)\s*").captures(label) {
                boxes.entry(c[1].into()).or_default().push(t);
            }
        }
        for (box_, mut ts) in boxes {
            ts.sort_by(|a, b| text(&a["created_at"]).cmp(text(&b["created_at"])));
            for v in ts.iter().filter(|t| {
                array(&contracts["checkbox"]["verdict"])
                    .iter()
                    .any(|r| *r == role(t))
                    && t["status"] == "completed"
            }) {
                let (vc, vd) = (
                    epoch(text(&v["created_at"])),
                    epoch(text(&v["completed_at"])),
                );
                let (Some(vc), Some(vd)) = (vc, vd) else {
                    continue;
                };
                let mut lack = vec![];
                for r in array(&contracts["checkbox"]["review"]) {
                    if let Some(t) = ts.iter().rev().find(|t| {
                        role(t) == text(r) && epoch(text(&t["created_at"])).is_some_and(|t| t <= vc)
                    }) {
                        if t["status"] != "cancelled"
                            && !(t["status"] == "completed"
                                && epoch(text(&t["completed_at"])).is_some_and(|t| t <= vd + 60.))
                        {
                            lack.push(*t);
                        }
                    }
                }
                if !lack.is_empty() {
                    let mut ids = vec![v["id"].clone()];
                    ids.extend(lack.iter().map(|t| t["id"].clone()));
                    items.push(deviation("missing","bad","task",text(&v["id"]),format!("{} 결과 없이 판정",lack.iter().map(|t|role(t)).collect::<Vec<_>>().join(" · ")),lack.iter().map(|t|format!("{}: 결과 없음 (상태 {})",role(t),text(&t["status"]))).collect(),json!({"session":sess_of.get(text(&v["id"])).map(|s|&s["path"]),"task_id":v["id"],"task_ids":ids,"checkbox":box_,"run_id":rid})));
                }
            }
            let rounds = ts
                .iter()
                .filter(|t| {
                    array(&contracts["checkbox"]["work"])
                        .iter()
                        .any(|r| *r == role(t))
                })
                .collect::<Vec<_>>();
            if rounds.len() >= 3 {
                let last = rounds.last().unwrap();
                items.push(deviation("repeat","warn","checkbox",&format!("{rid}|{box_}"),format!("같은 체크박스 구현→리뷰 {}라운드",rounds.len()),vec![format!("구현 {}회",rounds.len())],json!({"session":sess_of.get(text(&last["id"])).map(|s|&s["path"]),"task_id":last["id"],"task_ids":rounds.iter().map(|t|&t["id"]).collect::<Vec<_>>(),"checkbox":box_,"run_id":rid})));
            }
        }
    }
    let stages = array(&contracts["qa"]["stages"]);
    for set in array(reviews) {
        for t in array(&set["tickets"]) {
            let qa = &t["qa"];
            if !qa.is_object() || qa["ignored"] == true {
                continue;
            }
            let Some(cur) = stages.iter().position(|s| s["key"] == qa["stage"]) else {
                continue;
            };
            if qa["driver"] == true {
                for (i, s) in stages
                    .iter()
                    .enumerate()
                    .take(stages.len().saturating_sub(1))
                {
                    let next = &stages[i + 1];
                    if s["user"] == true
                        && qa["at"][text(&s["key"])].is_null()
                        && !qa["at"][text(&next["key"])].is_null()
                        && cur > i
                    {
                        items.push(deviation(
                            "order",
                            "bad",
                            "ticket",
                            &format!("{}|gate|{}", text(&t["key"]), text(&s["key"])),
                            format!("{} 없이 {}", text(&s["label"]), text(&next["label"])),
                            vec![format!(
                                "{} 신호 없음 — 계약상 {} 차례",
                                text(&s["key"]),
                                text(&s["by"])
                            )],
                            json!({"ticket":t["key"],"handles":qa["handles"]}),
                        ));
                    }
                }
            }
            let open = array(&t["repos"])
                .iter()
                .filter(|r| r["pr"]["state"] == "OPEN")
                .collect::<Vec<_>>();
            if !open.is_empty()
                && t["status"].is_string()
                && matches!(crate::review::jira_stage(t), "dev" | "ready" | "qa")
            {
                items.push(deviation(
                    "order",
                    "warn",
                    "ticket",
                    &format!("{}|jira-open", text(&t["key"])),
                    format!("머지 전 Jira 「{}」", text(&t["status"])),
                    vec![format!("열린 PR {}개", open.len())],
                    json!({"ticket":t["key"],"handles":qa["handles"]}),
                ));
            }
            if !open.is_empty() && qa["stage"] == "cleaned" {
                items.push(deviation(
                    "order",
                    "bad",
                    "ticket",
                    &format!("{}|clean-open", text(&t["key"])),
                    "머지 전 정리".into(),
                    vec![format!("열린 PR {}개", open.len())],
                    json!({"ticket":t["key"],"handles":qa["handles"]}),
                ));
            }
        }
    }
    for item in &mut items {
        if item["unit"] == "ticket" {
            item["session"] = summaries
                .iter()
                .find(|sm| {
                    sm["parent"].is_null()
                        && array(&item["handles"])
                            .iter()
                            .any(|h| *h == sm["own_handle"] || *h == sm["orca_focus"])
                })
                .map(|sm| sm["path"].clone())
                .unwrap_or(Value::Null);
        }
    }
    let before = items.len();
    items.retain(|d| prefs["flow_ok"][text(&d["id"])].is_null());
    json!({"contracts":contracts,"ok":before-items.len(),"items":items,"rules":rules()})
}
