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

fn codex_question(asynchronous: bool, ts: &str) -> Session {
    let mut s = Session::new("/fixture/rollout-codex.jsonl", "codex");
    s.feed(&json!({"type":"session_meta","timestamp":ts,"payload":{"id":"codex-fixture","cwd":"/fixture"}}));
    let (name, questions) = if asynchronous {
        (
            "request_user_input_async",
            json!([{"title":"진행할까요?","options":["진행","보류"]},{"title":"추가 의견은?"}]),
        )
    } else {
        (
            "functions.request_user_input",
            json!([{"id":"proceed","question":"진행할까요?","header":"확인","options":[{"label":"진행","description":"계속"},{"label":"보류","description":"기다림"}]}]),
        )
    };
    s.feed(&json!({"type":"response_item","timestamp":ts,"payload":{"type":"function_call","name":name,"call_id":"ask-1","arguments":json!({"questions":questions}).to_string()}}));
    s
}

#[test]
fn codex_sync_questions_close_on_tool_result() {
    let mut s = codex_question(false, &iso());
    let ask = &s.codex_asks["ask-1"];
    assert!(!ask.closed);
    assert_eq!(ask.questions[0]["header"], "확인");
    assert_eq!(ask.questions[0]["options"][0]["description"], "계속");
    s.feed(&json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"ask-1","output":"{\"answers\":{\"proceed\":{\"answers\":[\"진행\"]}}}"}}));
    assert!(s.codex_asks["ask-1"].closed);
}

#[test]
fn codex_async_receipt_and_turn_end_wait_for_the_quoted_answer() {
    let mut s = codex_question(true, &iso());
    let receipt = json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"ask-1","output":"{\"accepted\":true}"}});
    s.feed(&receipt);
    s.feed(&json!({"type":"event_msg","payload":{"type":"task_complete"}}));
    for text in [
        "다른 수정도 진행해",
        "> 진행할까요? 다시 검토\n\n진행",
        "> 진행할까요?\n\n진행",
    ] {
        s.feed(&json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":text}]}}));
        assert!(!s.codex_asks["ask-1"].closed);
    }
    assert_eq!(
        s.codex_asks["ask-1"].questions[0]["options"][0]["label"],
        "진행"
    );
    assert_eq!(s.codex_asks["ask-1"].questions[1]["options"], json!([]));
    s.feed(&json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"> 진행할까요?\n\n진행\n\n> 추가 의견은?\n\n없음"}]}}));
    assert!(s.codex_asks["ask-1"].closed);
    s.feed(&receipt);
    assert!(s.codex_asks["ask-1"].closed);
}

#[test]
fn codex_questions_close_on_errors_and_abort_and_ignore_invalid_calls() {
    for asynchronous in [false, true] {
        let mut s = codex_question(asynchronous, &iso());
        s.feed(&json!({"type":"event_msg","payload":{"type":"turn_aborted"}}));
        assert!(s.codex_asks["ask-1"].closed);
        let mut s = codex_question(asynchronous, &iso());
        s.feed(&json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"ask-1","output":"request_user_input is unavailable in Default mode"}}));
        assert!(s.codex_asks["ask-1"].closed);
    }
    let mut s = Session::new("/fixture/invalid.jsonl", "codex");
    for arguments in ["{", "{}", "{\"questions\":[{\"title\":\" \"}]}"] {
        s.feed(&json!({"type":"response_item","payload":{"type":"function_call","name":"request_user_input_async","call_id":"invalid","arguments":arguments}}));
    }
    assert!(s.codex_asks.is_empty());
}

#[test]
fn codex_decisions_reach_session_and_native_contract_and_close_on_answer() {
    let d = tempfile::tempdir().unwrap();
    let a = App::new(Config {
        data: d.path().into(),
        vault: d.path().join("none"),
        ..Config::default()
    });
    let ts = chrono::DateTime::from_timestamp((now() - 120.) as i64, 0)
        .unwrap()
        .to_rfc3339();
    let s = codex_question(false, &ts);
    {
        let mut state = a.state.write().unwrap();
        state.scan_ready = true;
        state
            .sessions
            .insert(s.path.clone(), std::sync::Arc::new(s.clone()));
        // The same rollout can also be discovered through an Orca account's session directory.
        state
            .sessions
            .insert("/orca/duplicate.jsonl".into(), std::sync::Arc::new(s));
    }
    for _ in 0..2 {
        decisions::sweep(&a).unwrap();
    }
    // The incremental scanner temporarily removes a session while reading its new records.
    let held = std::mem::take(&mut a.state.write().unwrap().sessions);
    decisions::sweep(&a).unwrap();
    assert_eq!(
        array(&a.state.read().unwrap().decisions["pending"]).len(),
        1
    );
    a.state.write().unwrap().sessions = held;
    a.build_snapshot().unwrap();
    let snapshot = a.state.read().unwrap().snapshot.clone();
    let card = snapshot["decisions"]["pending"][0].clone();
    assert_eq!(array(&snapshot["decisions"]["pending"]).len(), 1);
    assert_eq!(snapshot["sessions"][0]["decision"]["id"], card["id"]);
    let payload: agent_dashboard_client_core::DecisionsPayload =
        serde_json::from_value(snapshot).unwrap();
    assert_eq!(
        payload.decisions.pending[0].questions[0].question,
        "진행할까요?"
    );
    assert_eq!(
        decisions::post(&a, "answer", &json!({"id":card["id"],"answers":["진행"]})).0,
        409
    );
    {
        let mut state = a.state.write().unwrap();
        for sess in state.sessions.values_mut() {
            std::sync::Arc::make_mut(sess).feed(&json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"ask-1","output":"{}"}}));
        }
    }
    decisions::sweep(&a).unwrap();
    assert!(array(&a.state.read().unwrap().decisions["pending"]).is_empty());
}

#[test]
fn codex_dismissal_survives_sweeps_and_restart() {
    let d = tempfile::tempdir().unwrap();
    let config = Config {
        data: d.path().into(),
        vault: d.path().join("none"),
        ..Config::default()
    };
    let s = codex_question(true, &iso());
    let a = App::new(config.clone());
    a.state
        .write()
        .unwrap()
        .sessions
        .insert(s.path.clone(), std::sync::Arc::new(s.clone()));
    decisions::sweep(&a).unwrap();
    let id = a.state.read().unwrap().decisions["pending"][0]["id"].clone();
    assert_eq!(decisions::post(&a, "dismiss", &json!({"id":id})).0, 200);
    a.state.write().unwrap().pending["items"][0]["settled"] = json!(now() - 600.);
    decisions::sweep(&a).unwrap();
    let restarted = App::new(config);
    restarted
        .state
        .write()
        .unwrap()
        .sessions
        .insert(s.path.clone(), std::sync::Arc::new(s));
    decisions::sweep(&restarted).unwrap();
    assert!(array(&restarted.state.read().unwrap().decisions["pending"]).is_empty());
    let mut expired = codex_question(true, "2020-01-01T00:00:00Z");
    expired.data["id"] = json!("expired");
    restarted
        .state
        .write()
        .unwrap()
        .sessions
        .insert("expired".into(), std::sync::Arc::new(expired));
    decisions::sweep(&restarted).unwrap();
    assert!(array(&restarted.state.read().unwrap().decisions["pending"]).is_empty());
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
fn qa_media_uses_project_steps_and_review_tickets() {
    let projects = json!({"list":[
        {"name":"PRD-7 모바일 개선","stages":[{"steps":[{"path":"일정/PRD-7 5.01 DEV-12 구현.md"}]}]},
        {"name":"PRD-8 가입 개선","stages":[]}
    ]});
    let reviews = json!({"sets":[{"project":"10_Projects/PRD-8 가입 개선","epic":"QA-20","tickets":[{"key":"QA-21"}]}]});
    let mut videos = vec![
        json!({"kind":"qa","name":"DEV-12 모바일 재촬영"}),
        json!({"kind":"qa","name":"PRD-7 데스크톱"}),
        json!({"kind":"qa","name":"QA-21 회귀"}),
        json!({"kind":"qa","name":"QA-20 전체"}),
        json!({"kind":"learn","name":"DEV-12 설계 해설"}),
    ];
    media::classify(&mut videos, &projects, &reviews);
    assert_eq!(videos[0]["project"], "PRD-7 모바일 개선");
    assert_eq!(videos[0]["ticket"], "DEV-12");
    assert_eq!(videos[1]["project"], "PRD-7 모바일 개선");
    assert_eq!(videos[2]["project"], "PRD-8 가입 개선");
    assert_eq!(videos[3]["project"], "PRD-8 가입 개선");
    assert!(videos[4].get("project").is_none());
    assert!(videos[4].get("ticket").is_none());
}

#[test]
fn qa_media_keeps_unknown_and_ambiguous_projects_unclassified() {
    let projects = json!({"list":[
        {"name":"PRD-7 모바일 개선","stages":[{"steps":[{"path":"DEV-12.md"}]}]},
        {"name":"PRD-8 가입 개선","stages":[{"steps":[{"path":"DEV-12.md"}]}]}
    ]});
    let mut videos = vec![
        json!({"kind":"qa","name":"DEV-12 공통 화면"}),
        json!({"kind":"qa","name":"DEV-99 알 수 없는 티켓"}),
        json!({"kind":"qa","name":"티켓 없는 녹화"}),
    ];
    media::classify(&mut videos, &projects, &json!({"sets":[]}));
    assert!(videos.iter().all(|v| v["project"].is_null()));
    assert_eq!(videos[0]["ticket"], "DEV-12");
    assert_eq!(videos[1]["ticket"], "DEV-99");
    assert!(videos[2]["ticket"].is_null());
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
