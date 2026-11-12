use crate::core::*;
use serde_json::{Value, json};

pub fn attach_box_notes(plan: &mut Value) {
    use crate::sessions::rx;
    let base = std::path::Path::new(text(&plan["path"]))
        .parent()
        .unwrap_or(std::path::Path::new("."))
        .to_path_buf();
    let Some(tickets) = plan["tickets"].as_array_mut() else {
        return;
    };
    for t in tickets {
        let state = read_json(base.join(format!("{}.json", text(&t["package"]))));
        let sheet = std::fs::read_to_string(text(&state["sheet_path"])).unwrap_or_default();
        let mut reasons = std::collections::HashMap::new();
        let mut idx = None;
        for ln in sheet.lines() {
            if let Some(m) = rx(r"^###\s+(\d+)\.").captures(ln) {
                idx = m[1].parse::<u64>().ok();
            } else if let Some(m) =
                rx(r"^-\s*추가 사유:\s*(.+?)(?:\s+—\s+\d{4}-\d{2}-\d{2})?\s*$").captures(ln)
            {
                if let Some(i) = idx {
                    reasons.insert(i, m[1].to_owned());
                }
            }
        }
        let round = |s: &str| {
            rx(r"(\d+)\s*(?:라운드|차)")
                .captures(s)
                .and_then(|c| c[1].parse::<u64>().ok())
        };
        let ir_round = state["integration_review"]["round"].as_u64().or_else(|| {
            array(&t["sessions"])
                .iter()
                .filter(|s| s["kind"] == "integration-review")
                .find_map(|s| round(text(&s["title"])).or_else(|| round(text(&s["key"]))))
        });
        if let Some(sessions) = t["sessions"].as_array_mut() {
            for s in sessions {
                if ["integration-review", "pr-review", "completion-review"]
                    .contains(&text(&s["kind"]))
                {
                    s["round_auto"] = json!(
                        round(text(&s["title"]))
                            .or_else(|| round(text(&s["key"])))
                            .or_else(|| if s["kind"] == "integration-review" {
                                ir_round
                            } else {
                                None
                            })
                    );
                }
                if s["fix_source"].is_string() {
                    let bx = array(&state["checkboxes"])
                        .iter()
                        .find(|b| b["index"] == s["box"]);
                    let mut reason = s["box"].as_u64().and_then(|i| reasons.get(&i)).cloned();
                    if reason.is_none() {
                        let n = bx
                            .map(|b| {
                                array(&b["fix_findings"])
                                    .iter()
                                    .map(|p| {
                                        std::fs::read_to_string(text(p))
                                            .unwrap_or_default()
                                            .matches("\n### ")
                                            .count()
                                    })
                                    .sum::<usize>()
                            })
                            .unwrap_or(0);
                        if n > 0 {
                            reason = Some(format!("findings {n}건"));
                        }
                    }
                    s["reason_auto"] = json!(reason);
                    s["round_auto"] = json!(round(text(&s["title"])).or_else(|| {
                        if s["fix_source"] == "integration-review" {
                            ir_round
                        } else {
                            Some(1)
                        }
                    }));
                }
            }
        }
    }
}

pub fn build(events: &[(String, Value)], prompts: &[(String, String)]) -> Vec<Value> {
    let mut plans: Vec<Value> = vec![];
    for (ts, ev) in events {
        let prompt = prompts.iter().rev().find(|(t, _)| t <= ts);
        let fresh = plans
            .last()
            .is_none_or(|p| prompt.is_some_and(|(t, _)| text(&p["ts"]) < t.as_str()));
        let op = text(&ev["op"]);
        if op == "set" || op == "add" && fresh {
            let old = if fresh || op == "add" {
                vec![]
            } else {
                array(&plans.last().unwrap()["steps"]).to_vec()
            };
            let steps: Vec<Value> = array(&ev["steps"])
                .iter()
                .map(|t| {
                    old.iter().find(|s| s["t"] == *t).cloned().unwrap_or_else(
                        || json!({"t":t,"st":"todo","ts0":null,"ts1":null,"note":null}),
                    )
                })
                .collect();
            if fresh {
                plans.push(json!({"prompt":prompt.map(|p|&p.1),"ts":ts,"steps":steps,"hist":[]}));
            } else {
                plans.last_mut().unwrap()["steps"] = json!(steps);
            }
        } else if op == "add" {
            if let Some(p) = plans.last_mut() {
                for t in array(&ev["steps"]) {
                    p["steps"]
                        .as_array_mut()
                        .unwrap()
                        .push(json!({"t":t,"st":"todo","ts0":null,"ts1":null,"note":null}));
                }
            }
        } else if let Some(p) = plans.last_mut() {
            let steps = p["steps"].as_array_mut().unwrap();
            let i = ev["n"]
                .as_u64()
                .and_then(|n| n.checked_sub(1))
                .map(|n| n as usize)
                .or_else(|| steps.iter().position(|x| x["st"] == "run"));
            let Some(i) = i.filter(|i| *i < steps.len()) else {
                continue;
            };
            let x = &mut steps[i];
            if x["ts0"].is_null() {
                x["ts0"] = json!(ts);
            }
            x["st"] = json!(if op == "start" { "run" } else { op });
            if op != "start" {
                x["ts1"] = json!(ts);
                if !ev["note"].is_null() {
                    x["note"] = ev["note"].clone();
                }
            }
        } else {
            continue;
        }
        if let Some(p) = plans.last_mut() {
            let steps = p["steps"].as_array_mut().unwrap();
            if op != "fail" && !steps.iter().any(|x| x["st"] == "run") {
                if let Some(s) = steps.iter_mut().find(|s| s["st"] == "todo") {
                    s["st"] = json!("run");
                    s["ts0"] = json!(ts);
                }
            }
            let done = steps
                .iter()
                .filter(|s| matches!(text(&s["st"]), "done" | "skip"))
                .count();
            let total = steps.len();
            p["hist"]
                .as_array_mut()
                .unwrap()
                .push(json!([ts, done, total]));
        }
    }
    plans
}
pub fn summary(plans: &[Value]) -> Value {
    let Some(p) = plans.last() else {
        return Value::Null;
    };
    let steps = array(&p["steps"]);
    let cur = steps
        .iter()
        .position(|x| matches!(text(&x["st"]), "run" | "fail"));
    json!({"steps":steps.iter().map(|x|&x["st"]).collect::<Vec<_>>(),"total":steps.len(),"done":steps.iter().filter(|x|matches!(text(&x["st"]),"done"|"skip")).count(),"cur":cur,"cur_text":cur.map(|i|&steps[i]["t"]),"count":plans.len(),"prompt":short(text(&p["prompt"]),120)})
}
