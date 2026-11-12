//! Frozen outputs from the original Python server's synthetic regression scenarios.
use agent_dashboard::{core::*, flow, impl_progress};
use serde_json::{Value, json};
use std::collections::HashMap;
fn numeric(v: &Value) -> Value {
    match v {
        Value::Number(n) => json!(n.as_f64().unwrap()),
        Value::Array(a) => json!(a.iter().map(numeric).collect::<Vec<_>>()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, v)| (k.clone(), numeric(v))).collect()),
        _ => v.clone(),
    }
}
#[test]
fn test_verdicts_match_python() {
    let scenarios: Value = serde_json::from_str(include_str!("fixtures/judge.json")).unwrap();
    for (i, s) in array(&scenarios).iter().enumerate() {
        let got = agent_dashboard::test_runs::judge(
            s["code"].as_i64().unwrap() as i32,
            array(&s["cases"]),
            text(&s["log"]),
            text(&s["label"]),
            s["red"] == true,
        );
        assert_eq!(got, s["expected"], "test verdict {i}");
    }
}
#[test]
fn design_sections_match_python() {
    let scenarios: Value = serde_json::from_str(include_str!("fixtures/toc.json")).unwrap();
    for s in array(&scenarios) {
        assert_eq!(
            json!(agent_dashboard::designs::toc(text(&s["text"]))),
            s["expected"],
            "{}",
            s["text"]
        );
    }
}
#[test]
fn coordinator_handles_match_python() {
    let scenarios: Value = serde_json::from_str(include_str!("fixtures/own-handle.json")).unwrap();
    for (i, s) in array(&scenarios).iter().enumerate() {
        let mut sess = agent_dashboard::sessions::Session::new("/tmp/sid.jsonl", "claude");
        for (n, call) in array(&s["calls"]).iter().enumerate() {
            sess.feed(&json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":format!("c{n}"),"name":"Bash","input":{"command":call[0]}}]}}));
            sess.feed(&json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":format!("c{n}"),"content":call[1]}]}}));
        }
        let sm = sess.summary(
            &s["hooks"],
            &s["orca"],
            &json!({"idle":{},"chars":{},"pinned":{}}),
            &obj(),
            &Value::Null,
        );
        for k in ["role", "own_handle"] {
            assert_eq!(sm[k], s["expected"][k], "own handle scenario {i}, {k}");
        }
    }
}
#[test]
fn session_usage_and_chat_match_python() {
    let scenarios: Value = serde_json::from_str(include_str!("fixtures/sessions.json")).unwrap();
    for (i, s) in array(&scenarios).iter().enumerate() {
        let mut sess = agent_dashboard::sessions::Session::new("/tmp/sid.jsonl", text(&s["kind"]));
        for r in array(&s["records"]) {
            sess.feed(r);
        }
        let sm = sess.summary(
            &obj(),
            &json!({"runs":[],"tasks":{},"workers":[],"terminals":[]}),
            &json!({"idle":{},"chars":{},"pinned":{}}),
            &obj(),
            &Value::Null,
        );
        for (k, v) in s["expected"].as_object().unwrap() {
            assert_eq!(numeric(&sm[k]), numeric(v), "session {i}, {k}");
        }
        assert_eq!(
            numeric(&json!(sess.turns)),
            numeric(&s["turns"]),
            "session {i} turns"
        );
        assert_eq!(json!(sess.chat), s["chat"], "session {i} chat");
        assert_eq!(sess.data["cats"], s["cats"]);
    }
}
#[test]
fn account_windows_match_python() {
    let scenarios: Value = serde_json::from_str(include_str!("fixtures/plan-usage.json")).unwrap();
    for s in array(&scenarios) {
        let (limits, extra) = if s["provider"] == "claude" {
            agent_dashboard::plan_usage::claude_usage(&s["raw"])
        } else {
            agent_dashboard::plan_usage::codex_usage(&s["raw"])
        };
        assert_eq!(numeric(&limits), numeric(&s["limits"]));
        assert_eq!(numeric(&extra), numeric(&s["extra"]));
    }
}
#[test]
fn ledger_and_map_match_python() {
    let scenarios: Value =
        serde_json::from_str(include_str!("fixtures/impl-progress.json")).unwrap();
    for s in array(&scenarios) {
        if let Some(map) = s["map"].as_str() {
            assert_eq!(
                json!(impl_progress::parse_map(map)),
                s["expected"],
                "{}",
                s["name"]
            );
        } else {
            let (items, cur) = impl_progress::parse_ledger(text(&s["ledger"]));
            assert_eq!(json!(items), s["items"], "{}", s["name"]);
            assert_eq!(json!(cur), s["current"]);
            assert_eq!(
                impl_progress::summarize(&items, cur.as_deref()),
                s["summary"],
                "{}",
                s["name"]
            );
        }
    }
}
#[test]
fn flow_decisions_match_python() {
    let scenarios: Value = serde_json::from_str(include_str!("fixtures/flow.json")).unwrap();
    for (i, s) in array(&scenarios).iter().enumerate() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("contract.md");
        std::fs::write(&p, text(&s["contract"])).unwrap();
        let mut prefs = s["prefs"].clone();
        prefs["qa_contract"] = json!(p);
        let plans = s["plans"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect::<HashMap<_, _>>();
        let r = flow::check_at(
            array(&s["sessions"]),
            &s["tasks"],
            &plans,
            &s["reviews"],
            &prefs,
            s["terms_known"] == true,
            number(&s["now"]),
        );
        let fields = [
            "id", "rule", "severity", "session", "task_id", "task_ids", "ticket", "checkbox",
            "run_id",
        ];
        let mut got = array(&r["items"])
            .iter()
            .map(|r| {
                let mut out = obj();
                for k in fields {
                    out[k] = r[k].clone();
                }
                out
            })
            .collect::<Vec<_>>();
        got.sort_by(|a, b| text(&a["id"]).cmp(text(&b["id"])));
        assert_eq!(json!(got), s["expected"], "flow scenario {i}");
        assert_eq!(r["ok"], s["ok"], "flow scenario {i}");
    }
}
