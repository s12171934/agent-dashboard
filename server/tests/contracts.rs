use agent_dashboard::{app::App, core::*, decisions, http, media, plans, sessions::Session};
use serde_json::{Value, json};
use tower::ServiceExt;

fn session() -> Session {
    Session::new("/tmp/sid.jsonl", "claude")
}
fn summary(s: &Session) -> Value {
    s.summary(
        &json!({}),
        &json!({"terminals":[],"runs":[],"workers":[]}),
        &json!({"idle":{},"pinned":{},"chars":{}}),
        &json!({}),
        &Value::Null,
    )
}
#[test]
fn rename_outranks_generated_title() {
    let mut s = session();
    for r in [
        json!({"type":"user","message":{"content":"first prompt"}}),
        json!({"type":"custom-title","customTitle":"my name"}),
        json!({"type":"ai-title","aiTitle":"generated"}),
    ] {
        s.feed(&r);
    }
    assert_eq!(s.data["title"], "my name");
}
#[test]
fn duplicate_usage_is_not_double_counted() {
    let mut s = session();
    for n in [1, 7] {
        s.feed(&json!({"type":"assistant","requestId":"same","message":{"id":"m","model":"gpt-6.1-sol","usage":{"input_tokens":100,"output_tokens":n},"content":[]}}));
    }
    assert_eq!(s.turns.len(), 1);
    assert_eq!(s.turns[0]["output"], 7.);
}
#[test]
fn codex_cache_tokens_are_separated() {
    let mut s = Session::new("/tmp/rollout-x.jsonl", "codex");
    s.feed(&json!({"type":"token_usage_record","payload":{"response_id":"r","usage":{"input_tokens":150,"cached_input_tokens":60,"cache_write_input_tokens":20,"output_tokens":2}}}));
    assert_eq!(s.turns[0]["input"], 70.);
    assert_eq!(s.turns[0]["ctx"], 150.);
}
#[test]
fn incomplete_jsonl_record_is_retained() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("x.jsonl");
    std::fs::write(&p, b"{\"type\":\"custom-title\",\"customTitle\":\"x\"}").unwrap();
    let mut s = Session::new(p.to_str().unwrap(), "claude");
    assert!(!s.poll().unwrap());
    assert_eq!(s.offset, 0);
    std::fs::OpenOptions::new()
        .append(true)
        .open(&p)
        .unwrap()
        .write_all(b"\n")
        .unwrap();
    assert!(s.poll().unwrap());
    assert_eq!(s.data["title"], "x");
}
use std::io::Write;
#[test]
fn plan_revision_keeps_finished_steps() {
    let ev = vec![
        ("1".into(), json!({"op":"set","steps":["a","b"]})),
        ("2".into(), json!({"op":"done","n":1})),
        ("3".into(), json!({"op":"set","steps":["a","b","c"]})),
    ];
    let p = plans::build(&ev, &[]);
    assert_eq!(p.len(), 1);
    assert_eq!(p[0]["steps"][0]["st"], "done");
    assert_eq!(p[0]["steps"][1]["st"], "run");
}
#[test]
fn instructions_split_plans() {
    let e = vec![
        ("2".into(), json!({"op":"set","steps":["a"]})),
        ("4".into(), json!({"op":"set","steps":["b"]})),
    ];
    let p = plans::build(
        &e,
        &[("1".into(), "first".into()), ("3".into(), "second".into())],
    );
    assert_eq!(p.len(), 2);
    assert_eq!(p[1]["prompt"], "second");
}
#[test]
fn orchestration_receipt_identifies_own_terminal() {
    let mut s = session();
    let h = "term_aaaaaaaa-0000-0000-0000-000000000001";
    s.feed(&json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"call","name":"Bash","input":{"command":"orca orchestration run-create --json"}}]}}));
    s.feed(&json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"call","content":format!("{{\"id\":\"run_111111111111\",\"coordinator_handle\":\"{h}\"}}")}]}}));
    let sm = summary(&s);
    assert_eq!(sm["own_handle"], h);
    assert_eq!(sm["role"], "coordinator");
}
#[test]
fn help_does_not_claim_coordinator() {
    let mut s = session();
    s.feed(&json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"call","name":"Bash","input":{"command":"orca orchestration worker-start --help"}}]}}));
    assert_eq!(summary(&s)["role"], "solo");
    assert!(summary(&s)["own_handle"].is_null());
}
#[test]
fn range_requests_cover_seek_and_suffix() {
    assert_eq!(
        media::byte_range(100, Some("bytes=10-19")).unwrap(),
        (10, 19, 206)
    );
    assert_eq!(
        media::byte_range(100, Some("bytes=-12")).unwrap(),
        (88, 99, 206)
    );
    assert_eq!(
        media::byte_range(100, Some("bytes=90-")).unwrap(),
        (90, 99, 206)
    );
    assert!(media::byte_range(100, Some("bytes=100-")).is_err());
    assert!(media::byte_range(100, Some("bytes=-0")).is_err());
    assert!(media::byte_range(100, Some("bytes=0-1,3-4")).is_err());
}
#[test]
fn host_and_origin_boundary() {
    let mut c = Config::default();
    c.origins.push("https://example.pages.dev".into());
    assert!(http::host_allowed("[::1]:8787", &c));
    assert!(http::host_allowed("my-mac.tail.ts.net", &c));
    assert!(!http::host_allowed("evil.example", &c));
    assert!(http::origin_allowed(
        "https://preview.example.pages.dev",
        &c
    ));
    assert!(!http::origin_allowed(
        "https://example.pages.dev.evil.test",
        &c
    ));
    assert!(!http::origin_allowed("null", &c));
}
#[test]
fn typed_answer_rejects_control_keys() {
    let c = json!({"questions":[{"question":"q","options":[{"label":"a"}],"multiSelect":false,"preview":false}]});
    assert!(decisions::check_answers(&c, &json!(["hello"])).is_ok());
    assert!(decisions::check_answers(&c, &json!(["hello\rcommand"])).is_err());
}
#[test]
fn permission_does_not_allow_arbitrary_text() {
    let c = json!({"kind":"permission","questions":[{}]});
    assert!(decisions::check_answers(&c, &json!(["허용"])).is_ok());
    assert!(decisions::check_answers(&c, &json!(["always allow"])).is_err());
}
#[test]
fn delta_preserves_item_identity() {
    let old = json!({"version":1,"api":1,"health":{},"sessions":[{"kind":"claude","id":"a","title":"old"}],"tests":{"files":[{"key":"x"}],"history_n":1}});
    let new = json!({"version":2,"api":1,"health":{},"sessions":[{"kind":"claude","id":"a","title":"new"},{"kind":"codex","id":"b"}],"tests":{"files":[],"history_n":1}});
    let d = http::delta(&new, &old);
    assert_eq!(d["base"], 1);
    assert_eq!(d["delta"]["sessions"]["upd"].as_array().unwrap().len(), 2);
    assert_eq!(d["delta"]["tests.files"]["del"], json!(["x"]));
}
#[tokio::test]
async fn api_root_and_preflight() {
    use axum::{body::Body, http::Request};
    let d = tempfile::tempdir().unwrap();
    let c = Config {
        data: d.path().into(),
        vault: d.path().join("none"),
        ..Config::default()
    };
    let a = App::new(c);
    a.build_snapshot().unwrap();
    let r = http::router(a);
    let root = r
        .clone()
        .oneshot(
            Request::builder()
                .uri("/")
                .header("host", "localhost:8787")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(root.status(), 200);
    let denied = r
        .clone()
        .oneshot(
            Request::builder()
                .uri("/")
                .header("host", "evil.test")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(denied.status(), 403);
    let pre = r
        .oneshot(
            Request::builder()
                .method("OPTIONS")
                .uri("/api/pref")
                .header("host", "localhost:8787")
                .header("origin", "http://localhost:8000")
                .header("access-control-request-private-network", "true")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(pre.status(), 204);
    assert_eq!(
        pre.headers()["access-control-allow-private-network"],
        "true"
    );
}

#[test]
fn inbox_guard_covers_all_closing_commands() {
    use std::collections::HashSet;
    let terms = HashSet::from(["term-held".to_owned()]);
    let dirs = HashSet::from(["/work/feature-123".to_owned()]);
    let workers = vec![json!({"dispatchId":"dispatch-held","agentTerminalHandle":"term-held"})];
    for command in [
        "orca terminal close --terminal=term-held",
        "orca terminal close",
        "orca worktree rm --worktree path:/work/feature-123",
        "orca terminal close --worktree current",
        "orca orchestration worker-release --dispatch dispatch-held",
        "echo ready && /opt/bin/orca orchestration worker-stop --dispatch=dispatch-held",
        "orca orchestration worker-abandon --dispatch dispatch-held",
    ] {
        assert!(
            !decisions::guard_hits(
                command,
                "term-held",
                "/work/feature-123/sub",
                &terms,
                &dirs,
                &workers
            )
            .is_empty(),
            "{command}"
        );
    }
    assert!(
        decisions::guard_hits(
            "orca terminal close --terminal term-other",
            "term-held",
            "/other",
            &terms,
            &dirs,
            &workers
        )
        .is_empty()
    );
}

#[test]
fn design_reparse_preserves_reference_identity_and_combines_coverage() {
    use agent_dashboard::designs;
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("designs");
    std::fs::create_dir_all(root.join("feature")).unwrap();
    let doc = root.join("feature/spec.md");
    std::fs::write(&doc, "# spec Title\n## 1 Start\na\nb\n").unwrap();
    std::fs::write(
        root.join("feature/index.html"),
        "const SECTIONS = [{title:'Chapter',ids:['spec']}];",
    )
    .unwrap();
    let app = App::new(Config {
        data: temp.path().join("data"),
        designs: vec![root],
        design_days: 0.,
        vault: temp.path().join("none"),
        ..Config::default()
    });
    let mut sess = Session::new("/tmp/reference.jsonl", "claude");
    sess.reads.push(json!({"abs":doc,"call":"call-1","kind":"read","ranges":[[2,2],[4,4]],"exact":true,"ts":"2026-01-01T00:00:00Z"}));
    app.state
        .write()
        .unwrap()
        .sessions
        .insert(sess.path.clone(), std::sync::Arc::new(sess));
    designs::collect(&app).unwrap();
    let first = designs::list(&app);
    assert_eq!(first["refs"], 1);
    assert_eq!(first["docs"][0]["ch"], 1);
    designs::collect(&app).unwrap();
    assert_eq!(designs::list(&app)["version"], first["version"]);
    assert!(
        app.state.read().unwrap().design_refs["refs"]
            .get("reference|call-1|designs/feature/spec.md|1 Start|read")
            .is_some()
    );
    let refs = designs::session_refs(&app, "reference");
    assert_eq!(refs.len(), 1);
    assert_eq!(refs[0]["reads"], 1.);
    assert_eq!(refs[0]["doc_title"], "Title");
    assert_eq!(refs[0]["cover"], 1.);
}

#[test]
fn unchanged_snapshot_does_not_advance_version_for_health_ticks() {
    let temp = tempfile::tempdir().unwrap();
    let app = App::new(Config {
        data: temp.path().join("data"),
        vault: temp.path().join("absent"),
        ..Config::default()
    });
    app.build_snapshot().unwrap();
    let before = app.state.read().unwrap().version;
    app.health.ok("fixture");
    app.build_snapshot().unwrap();
    let state = app.state.read().unwrap();
    assert_eq!(state.version, before);
    assert_eq!(state.snapshots.len(), 1);
    assert!(state.snapshot["health"]["loops"]["fixture"]["ok"].is_number());
}

#[test]
fn stale_cache_refresh_is_single_and_cannot_overwrite_a_fresh_result() {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
        mpsc,
    };
    let key = uuid::Uuid::new_v4().to_string();
    assert_eq!(
        cached_json(key.clone(), 10., false, || Ok(json!(1))).unwrap(),
        1
    );
    let (started, seen) = mpsc::channel();
    let (release, wait) = mpsc::channel();
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    assert_eq!(
        cached_json(key.clone(), -1., false, move || {
            count.fetch_add(1, Ordering::SeqCst);
            started.send(()).unwrap();
            wait.recv().unwrap();
            Ok(json!(2))
        })
        .unwrap(),
        1
    );
    seen.recv_timeout(std::time::Duration::from_secs(2))
        .unwrap();
    let count = calls.clone();
    assert_eq!(
        cached_json(key.clone(), -1., false, move || {
            count.fetch_add(1, Ordering::SeqCst);
            Ok(json!(99))
        })
        .unwrap(),
        1
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        cached_json(key.clone(), 10., true, || Ok(json!(3))).unwrap(),
        3
    );
    release.send(()).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(50));
    assert_eq!(
        cached_json(key.clone(), 10., false, || panic!("fresh cache recomputed")).unwrap(),
        3
    );
    drop_cache(&key);
}

#[test]
fn orca_cli_response_envelope_is_unwrapped_and_errors_are_rejected() {
    assert_eq!(
        decode_orca(r#"{"ok":true,"result":{"runs":[{"id":"run_fixture"}]},"_meta":{}}"#).unwrap()
            ["runs"][0]["id"],
        "run_fixture"
    );
    assert!(decode_orca(r#"{"ok":false,"error":"unavailable"}"#).is_err());
    assert!(decode_orca(r#"{"ok":true}"#).is_err());
    assert!(decode_orca("invalid json").is_err());
}
