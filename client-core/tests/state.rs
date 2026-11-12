use agent_dashboard_client_core::*;
use serde_json::{Value, json};
fn payload(ids: &[&str]) -> Vec<u8> {
    serde_json::to_vec(&json!({"decisions":{"available":true,"pending":ids.iter().map(|id|json!({"id":id,"agent":"조율자","questions":[{"question":"진행할까요?","header":"승인","multiSelect":false,"options":[{"label":"진행","description":"계속합니다"}]}],"kind":"question","created_at":123.})).collect::<Vec<_>>(),"inbox":[],"inbox_mode":false},"sessions":ids.iter().map(|id|json!({"path":format!("/fixture/{id}.jsonl"),"title":"한글 세션","decision":{"id":id}})).collect::<Vec<_>>()})).unwrap()
}
#[test]
fn first_load_is_seen_and_later_changes_are_notified_once() {
    let mut store = DecisionStore::default();
    let first = store.apply(&payload(&["a"])).unwrap();
    assert!(first.new_ids.is_empty());
    assert_eq!(first.sessions["a"].title.as_deref(), Some("한글 세션"));
    let second = store.apply(&payload(&["b"])).unwrap();
    assert_eq!(second.new_ids, ["b"]);
    assert_eq!(second.gone_ids, ["a"]);
    let duplicate = store.apply(&payload(&["b"])).unwrap();
    assert!(duplicate.new_ids.is_empty() && duplicate.gone_ids.is_empty());
}
#[test]
fn unavailable_keeps_the_last_questions_and_names() {
    let mut store = DecisionStore::default();
    store.apply(&payload(&["a"])).unwrap();
    let unavailable = br#"{"decisions":{"available":false,"pending":[]},"sessions":[]}"#;
    let out = store.apply(unavailable).unwrap();
    assert_eq!(out.pending[0].id, "a");
    assert!(out.sessions.contains_key("a"));
    assert!(out.new_ids.is_empty() && out.gone_ids.is_empty());
}
#[test]
fn invalid_or_duplicate_response_is_atomic() {
    let mut store = DecisionStore::default();
    store.apply(&payload(&["a"])).unwrap();
    for bytes in [
        b"invalid".to_vec(),
        br#"{"error":"server unavailable"}"#.to_vec(),
        payload(&["b", "b"]),
    ] {
        assert!(store.apply(&bytes).is_err());
    }
    let out = store.apply(&payload(&["a"])).unwrap();
    assert!(out.new_ids.is_empty() && out.gone_ids.is_empty());
}
#[test]
fn server_switch_resets_priming() {
    let mut store = DecisionStore::default();
    store.apply(&payload(&["a"])).unwrap();
    store.reset();
    let out = store.apply(&payload(&["b"])).unwrap();
    assert!(out.new_ids.is_empty() && out.gone_ids.is_empty());
}
#[test]
fn wire_roundtrip_retains_permission_and_option_metadata() {
    let bytes = payload(&["a"]);
    let original: Value = serde_json::from_slice(&bytes).unwrap();
    let wire: DecisionsPayload = serde_json::from_slice(&bytes).unwrap();
    let out = serde_json::to_value(wire).unwrap();
    assert_eq!(
        out["decisions"]["pending"][0]["created_at"],
        original["decisions"]["pending"][0]["created_at"]
    );
    assert_eq!(
        out["decisions"]["pending"][0]["questions"][0]["options"][0]["description"],
        "계속합니다"
    );
    assert_eq!(out["decisions"]["inbox_mode"], false);
}
#[test]
fn c_abi_owns_strings_and_handles_null_inputs() {
    unsafe {
        use std::ffi::CStr;
        let store = adash_decision_store_new();
        let bytes = payload(&["a"]);
        let out = adash_decision_store_apply(store, bytes.as_ptr(), bytes.len());
        let value: Value = serde_json::from_slice(CStr::from_ptr(out).to_bytes()).unwrap();
        assert_eq!(value["result"]["pending"][0]["id"], "a");
        adash_core_string_free(out);
        let out = adash_decision_store_apply(std::ptr::null_mut(), std::ptr::null(), 0);
        let value: Value = serde_json::from_slice(CStr::from_ptr(out).to_bytes()).unwrap();
        assert_eq!(value["ok"], false);
        adash_core_string_free(out);
        let out = adash_decision_store_apply(store, std::ptr::null(), 1);
        let value: Value = serde_json::from_slice(CStr::from_ptr(out).to_bytes()).unwrap();
        assert_eq!(value["ok"], false);
        adash_core_string_free(out);
        adash_decision_store_reset(store);
        adash_decision_store_free(store);
        adash_decision_store_free(std::ptr::null_mut());
        adash_core_string_free(std::ptr::null_mut());
    }
}
