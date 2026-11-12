use agent_dashboard_ui::model::*;
use serde_json::json;
#[test]
fn all_routes_and_native_deep_links() {
    for (k, _, _) in SCREENS {
        assert_eq!(Route::parse(&format!("#{k}")).page, *k);
    }
    for (h, page) in [
        (session_hash("/fixture/한글 세션.jsonl"), "session"),
        ("#r=run-1".into(), "run"),
        ("#dr=term-1".into(), "driver"),
    ] {
        let r = Route::parse(&h);
        assert_eq!(r.page, page);
        assert_eq!(r.group(), "agents");
    }
    assert_eq!(
        Route::parse(&session_hash("/fixture/한글 세션.jsonl")).id,
        "/fixture/한글 세션.jsonl"
    );
    let route = Route::parse(&design_hash("server-1", "docs/설계.md", "1.2 제목"));
    assert_eq!(
        (route.server, route.id, route.section),
        ("server-1".into(), "docs/설계.md".into(), "1.2 제목".into())
    );
    assert_eq!(Route::parse("#unknown").page, "home");
}
#[test]
fn tree_identity_matches_rows_and_is_server_scoped() {
    let rows = vec![
        json!({"server":"a","path":"/same","id":"p","own_handle":"coord"}),
        json!({"server":"b","path":"/same","id":"p","own_handle":"coord"}),
        json!({"server":"a","path":"/worker","id":"w","role":"worker","coord_handle":"coord"}),
        json!({"server":"a","path":"/child","id":"c","parent":"p"}),
    ];
    let ix = index(&rows);
    assert_eq!(ix.roots, vec![identity(&rows[0]), identity(&rows[1])]);
    assert_eq!(ix.by_coord["a|coord"], vec![identity(&rows[2])]);
    assert!(!ix.by_coord.contains_key("b|coord"));
    assert_eq!(ix.subs["a|p"], vec![identity(&rows[3])]);
}
#[test]
fn orphans_and_self_references_remain_visible() {
    let rows = vec![
        json!({"server":"a","path":"/orphan","id":"c","parent":"missing"}),
        json!({"server":"a","path":"/self","id":"s","parent":"s"}),
    ];
    assert_eq!(index(&rows).roots.len(), 2);
}
#[test]
fn metric_only_changes_do_not_reindex() {
    let a = vec![json!({"server":"a","path":"/x","id":"x","cost":1,"state":"run"})];
    let mut b = a.clone();
    b[0]["cost"] = json!(2);
    b[0]["state"] = json!("done");
    assert_eq!(index(&a), index(&b));
}
#[test]
fn markdown_blocks_executable_content() {
    for s in [
        "<script>alert(1)</script>",
        "[x](javascript:alert(1))",
        "[x](javascript&#58;alert(1))",
        "![x](data:text/html,evil)",
    ] {
        let html = markdown(s);
        assert!(!html.contains("<script>"));
        assert!(!html.contains("href=\"javascript:"));
        assert!(!html.contains("src=\"data:"));
    }
    assert!(markdown("**text** [safe](https://example.test)").contains("<strong>text</strong>"));
}
#[test]
fn formatting_and_filters_handle_incomplete_data() {
    assert_eq!(money(&json!(null)), "—");
    assert_eq!(count(&json!(12000)), "12.0k");
    assert!(search(&json!({"title":"한글 Fixture"}), "한글 fixture"));
    assert!(!search(&json!({"title":"abc"}), "missing"));
    assert!(live(&json!({"state":"bg"})));
    assert!(!live(&json!({"state":"done"})));
}
#[test]
fn cached_tokens_and_time_boundary_are_preserved() {
    let rows = vec![
        json!({"slots":{"9":[1,2,3,4,0.1],"10":[5,6,7,8,0.2]}}),
        json!({"slots":{"10":[1,2,3,4,0.3],"invalid":[9]}}),
    ];
    let buckets = usage_buckets(&rows, 10);
    assert_eq!(buckets.len(), 1);
    assert_eq!(&buckets[&10][..4], &[6., 8., 10., 12.]);
    assert!((buckets[&10][4] - 0.5).abs() < 1e-10);
}
#[test]
fn mutable_qa_fields_do_not_change_set_identity() {
    let mut s = json!({"server":"one","epic":"QA-1","tickets":[]});
    let id = identity(&s);
    s["tickets"] = json!([{"key":"QA-2"}]);
    assert_eq!(identity(&s), id);
}
