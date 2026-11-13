use agent_dashboard::core::*;
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Read},
    process::{Child, Command, Stdio},
};
struct Server {
    child: Child,
    base: String,
    _temp: tempfile::TempDir,
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn server() -> Server {
    server_with_collect(false)
}
fn server_with_collect(collect: bool) -> Server {
    use std::os::unix::fs::PermissionsExt;
    let d = tempfile::tempdir().unwrap();
    let bin = d.path().join("bin");
    fs::create_dir_all(&bin).unwrap();
    fs::write(bin.join("orca"),r#"#!/bin/sh
if [ -n "${ORCA_TERMINAL_HANDLE:-}${ORCA_PANE_KEY:-}" ]; then echo '{"ok":false,"error":"inherited terminal binding"}'; exit 1; fi
case "$1 $2" in
 'repo list') echo '{"ok":true,"result":{"repos":[]}}' ;;
 'worktree list') echo '{"ok":true,"result":{"worktrees":[]}}' ;;
 'terminal list')
   if [ -f "$HOME/terminals.json" ]; then cat "$HOME/terminals.json"; else echo '{"ok":true,"result":{"terminals":[]}}'; fi ;;
 'terminal read') cat "$HOME/terminal-screen.json" ;;
 'terminal show') cat "$HOME/terminal-info.json" ;;
 'terminal send')
   printf '%s\0' "$@" >> "$HOME/terminal-input"
   codex_step=0
   if [ -f "$HOME/codex-step" ]; then codex_step=$(cat "$HOME/codex-step"); fi
   codex_step=$((codex_step + 1))
   printf '%s' "$codex_step" > "$HOME/codex-step"
   if [ -f "$HOME/terminal-screen-$codex_step.json" ]; then cp "$HOME/terminal-screen-$codex_step.json" "$HOME/terminal-screen.json"; fi
   echo '{"ok":true,"result":{"accepted":true,"prompt":{"stages":["input_accepted"]}}}' ;;
 'orchestration inbox') echo '{"ok":true,"result":{"messages":[]}}' ;;
 'orchestration run-list'|'orchestration task-list'|'orchestration worker-list')
   case " $* " in *' --full '*) ;; *) echo '{"ok":false,"error":"missing --full"}'; exit 1 ;; esac
   case "$2" in
    run-list) echo '{"ok":true,"result":{"runs":[{"id":"run_fixture","objective":"mock Run","created_at":"2026-11-12T00:00:00Z","status":"completed"}],"nextCursor":null}}' ;;
    task-list) echo '{"ok":true,"result":{"tasks":[]}}' ;;
    worker-list) echo '{"ok":true,"result":{"workers":[]}}' ;;
   esac ;;
 *) echo '{"ok":true,"result":{}}' ;;
esac
"#).unwrap();
    fs::set_permissions(bin.join("orca"), fs::Permissions::from_mode(0o755)).unwrap();
    fs::write(bin.join("security"), "#!/bin/sh\nexit 1\n").unwrap();
    fs::set_permissions(bin.join("security"), fs::Permissions::from_mode(0o755)).unwrap();
    let transcript = d
        .path()
        .join(".claude/projects/fixture/session-fixture.jsonl");
    fs::create_dir_all(transcript.parent().unwrap()).unwrap();
    fs::write(&transcript,format!("{}\n{}\n",json!({"type":"user","timestamp":iso(),"sessionId":"session-fixture","cwd":"/fixture","message":{"content":"collector fixture"}}),json!({"type":"custom-title","customTitle":"Rust scanner fixture"}))).unwrap();
    let data = d.path().join("data");
    fs::create_dir_all(&data).unwrap();
    let movie = d.path().join("Movies/ego-record");
    fs::create_dir_all(&movie).unwrap();
    fs::write(movie.join("fixture.mp4"), b"0123456789").unwrap();
    save_json(
        data.join("media.json"),
        &json!({"published":["ego-record/fixture.mp4"]}),
    )
    .unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_agent-dashboard"));
    if !collect {
        command.arg("--no-collect");
    }
    let mut child = command
        .args(["--port", "0", "--vault", "/definitely-absent-vault"])
        .env("HOME", d.path())
        .env("ORCA_TERMINAL_HANDLE", "must-be-removed")
        .env("ORCA_PANE_KEY", "must-be-removed")
        .env("ADASH_DATA", data)
        .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
        .stderr(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    let mut line = String::new();
    BufReader::new(child.stderr.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let base = line
        .split("http://")
        .nth(1)
        .unwrap_or_else(|| panic!("server did not bind: {line}"))
        .trim()
        .trim_end_matches('/')
        .to_owned();
    Server {
        child,
        base: format!("http://{base}"),
        _temp: d,
    }
}
#[test]
fn all_original_routes_are_served() {
    let s = server();
    let routes: Value = serde_json::from_str(include_str!("fixtures/routes.json")).unwrap();
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap();
    for p in array(&routes["get"]) {
        let p = text(p);
        let r = client.get(format!("{}{p}", s.base)).send().unwrap();
        if p == "/events" {
            assert_eq!(r.status(), 200);
            continue;
        }
        assert!(!r.status().is_server_error(), "GET {p} -> {}", r.status());
        if !["/usage"].contains(&p) {
            let body: Value = r.json().unwrap_or_else(|e| panic!("GET {p}: {e}"));
            assert!(body.is_object(), "GET {p}");
        }
    }
    for p in array(&routes["post"]) {
        let p = text(p);
        let r = client
            .post(format!("{}{p}", s.base))
            .json(&json!({}))
            .send()
            .unwrap();
        assert!(!r.status().is_server_error(), "POST {p} -> {}", r.status());
        let _: Value = r.json().unwrap();
    }
}
#[test]
fn cors_preflight_and_validation_errors() {
    let s = server();
    let client = reqwest::blocking::Client::new();
    let r = client
        .post(format!("{}/api/pref", s.base))
        .header("Origin", "http://localhost:8000")
        .header("Content-Type", "application/json")
        .body("bad json")
        .send()
        .unwrap();
    assert_eq!(r.status(), 400);
    assert_eq!(
        r.headers()["access-control-allow-origin"],
        "http://localhost:8000"
    );
    let r = client
        .get(&s.base)
        .header("Origin", "https://untrusted.example")
        .send()
        .unwrap();
    assert_eq!(r.status(), 403);
}
#[test]
fn sse_uses_numeric_snapshot_versions() {
    let s = server();
    let client = reqwest::blocking::Client::new();
    let mut r = client.get(format!("{}/events", s.base)).send().unwrap();
    assert_eq!(r.headers()["content-type"], "text/event-stream");
    let mut frame = Vec::new();
    let mut b = [0; 1];
    while frame.len() < 200 && !frame.ends_with(b"\n\n") {
        r.read_exact(&mut b).unwrap();
        frame.push(b[0]);
    }
    let line = String::from_utf8(frame).unwrap();
    let version = line
        .lines()
        .find_map(|l| l.strip_prefix("data:"))
        .unwrap()
        .trim();
    assert!(version.parse::<u64>().is_ok());
}
#[test]
fn media_stream_supports_ranges_and_rejects_escape() {
    let s = server();
    let client = reqwest::blocking::Client::new();
    let url = format!("{}/api/media/file?path=ego-record%2Ffixture.mp4", s.base);
    let r = client
        .get(&url)
        .header("Range", "bytes=2-5")
        .send()
        .unwrap();
    assert_eq!(r.status(), 206);
    assert_eq!(r.headers()["content-range"], "bytes 2-5/10");
    assert_eq!(r.bytes().unwrap().as_ref(), b"2345");
    let r = client
        .get(&url)
        .header("Range", "bytes=99-")
        .send()
        .unwrap();
    assert_eq!(r.status(), 416);
    let r = client
        .get(format!("{}/api/media/file?path=..%2Fprefs.json", s.base))
        .send()
        .unwrap();
    assert_eq!(r.status(), 404);
}
#[test]
fn state_delta_and_flow_acknowledgement() {
    let s = server();
    let client = reqwest::blocking::Client::new();
    let first: Value = client
        .get(format!("{}/api/state", s.base))
        .send()
        .unwrap()
        .json()
        .unwrap();
    let delta: Value = client
        .get(format!("{}/api/state?base={}", s.base, first["version"]))
        .send()
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(delta["base"], first["version"]);
    assert_eq!(delta["delta"], json!({}));
    let r = client
        .post(format!("{}/api/flow/ok", s.base))
        .json(&json!({"id":"plan|synthetic","ok":true}))
        .send()
        .unwrap();
    assert_eq!(r.status(), 200);
}

#[test]
fn active_collectors_read_only_new_transcript_records() {
    let server = server_with_collect(true);
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .unwrap();
    let wait_for = |title: &str| {
        for _ in 0..50 {
            let state: Value = client
                .get(format!("{}/api/state", server.base))
                .send()
                .unwrap()
                .json()
                .unwrap();
            if array(&state["sessions"])
                .iter()
                .any(|s| s["title"] == title)
            {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        panic!("collector did not publish {title}");
    };
    wait_for("Rust scanner fixture");
    use std::io::Write;
    let path = server
        ._temp
        .path()
        .join(".claude/projects/fixture/session-fixture.jsonl");
    writeln!(
        fs::OpenOptions::new().append(true).open(path).unwrap(),
        "{}",
        json!({"type":"custom-title","customTitle":"Rust scanner updated"})
    )
    .unwrap();
    wait_for("Rust scanner updated");
    let state: Value = client
        .get(format!("{}/api/state", server.base))
        .send()
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(state["orca"]["runs"][0]["id"], "run_fixture");
    assert!(state["orca"]["error"].is_null());
}

#[test]
fn codex_ask_is_collected_and_removed_after_its_async_answer() {
    let server = server_with_collect(true);
    let transcript = server
        ._temp
        .path()
        .join(".codex/sessions/rollout-fixture.jsonl");
    fs::create_dir_all(transcript.parent().unwrap()).unwrap();
    fs::write(&transcript, format!("{}\n{}\n{}\n",
        json!({"type":"session_meta","timestamp":iso(),"payload":{"id":"codex-http-fixture","cwd":"/fixture"}}),
        json!({"type":"response_item","timestamp":iso(),"payload":{"type":"function_call","name":"request_user_input_async","call_id":"codex-ask","arguments":"{\"questions\":[{\"title\":\"어디까지 진행할까요?\",\"options\":[\"여기까지\",\"계속\"]}]}"}}),
        json!({"type":"response_item","timestamp":iso(),"payload":{"type":"function_call_output","call_id":"codex-ask","output":"{\"accepted\":true}"}})
    )).unwrap();
    let client = reqwest::blocking::Client::new();
    let decisions = || {
        client
            .get(format!("{}/api/decisions", server.base))
            .send()
            .unwrap()
            .json::<Value>()
            .unwrap()
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    let pending = loop {
        let d = decisions();
        if !array(&d["decisions"]["pending"]).is_empty() && !array(&d["sessions"]).is_empty() {
            break d;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "Codex ask was not collected: {d}"
        );
        std::thread::sleep(std::time::Duration::from_millis(100));
    };
    let mut core = agent_dashboard_client_core::DecisionStore::default();
    let update = core.apply(&serde_json::to_vec(&pending).unwrap()).unwrap();
    assert_eq!(
        update.pending[0].questions[0].question,
        "어디까지 진행할까요?"
    );
    assert_eq!(pending["decisions"]["pending"][0]["kind"], "codex");
    assert_eq!(
        pending["sessions"][0]["decision"]["id"],
        pending["decisions"]["pending"][0]["id"]
    );
    let glance: Value = client
        .get(format!("{}/api/glance", server.base))
        .send()
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(
        glance["decisions"][0]["options"],
        json!(["여기까지", "계속"])
    );
    let answer = json!({"type":"response_item","timestamp":iso(),"payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"> 어디까지 진행할까요?\n\n계속"}]}});
    use std::io::Write;
    writeln!(
        fs::OpenOptions::new()
            .append(true)
            .open(&transcript)
            .unwrap(),
        "{answer}"
    )
    .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let d = decisions();
        if array(&d["decisions"]["pending"]).is_empty() {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "Codex answer did not close the card: {d}"
        );
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

#[test]
fn native_decisions_contract_is_shared_with_the_client_core() {
    let server = server();
    let client = reqwest::blocking::Client::new();
    let response:Value=client.post(format!("{}/api/decision/ask",server.base)).json(&json!({"session_id":"native-fixture","cwd":"/fixture","tool_use_id":"call-native","questions":[{"question":"진행할까요?","header":"검토","options":[{"label":"진행","description":"다음 단계로"},{"label":"보류","description":"기다림"}]}]})).send().unwrap().json().unwrap();
    assert!(response["id"].is_string());
    let response = client
        .get(format!("{}/api/decisions", server.base))
        .send()
        .unwrap();
    assert_eq!(response.status(), 200);
    let body = response.bytes().unwrap();
    let raw: Value = serde_json::from_slice(&body).unwrap();
    let mut core = agent_dashboard_client_core::DecisionStore::default();
    let result = core.apply(&body).unwrap();
    assert_eq!(result.pending[0].questions[0].options[0].label, "진행");
    assert!(result.new_ids.is_empty());
    assert_eq!(
        raw["decisions"]["pending"][0]["questions"][0]["options"][0]["description"],
        "다음 단계로"
    );
}

fn codex_reply_fixture(server: &Server, asynchronous: bool, questions: Value) -> Value {
    let home = server._temp.path();
    let terminal = "term_aaaaaaaa-0000-0000-0000-000000000001";
    save_json(home.join("terminals.json"), &json!({"ok":true,"result":{"terminals":[{"handle":terminal,"connected":true,"tabId":"fixture-tab","leafId":"fixture-leaf","agentIdentity":"codex"}]}})).unwrap();
    let hooks = home.join("Library/Application Support/orca/agent-hooks/last-status.json");
    save_json(hooks, &json!({"entries":{"fixture":{"providerSession":{"id":"codex-reply-fixture"},"payload":{"state":"working"},"receivedAt":now()*1000.,"paneKey":"fixture-tab:fixture-leaf"}}})).unwrap();
    let transcript = home.join(".codex/sessions/rollout-reply.jsonl");
    fs::create_dir_all(transcript.parent().unwrap()).unwrap();
    let name = if asynchronous {
        "request_user_input_async"
    } else {
        "request_user_input"
    };
    fs::write(transcript, format!("{}\n{}\n",
        json!({"type":"session_meta","timestamp":iso(),"payload":{"id":"codex-reply-fixture","cwd":"/fixture"}}),
        json!({"type":"response_item","timestamp":iso(),"payload":{"type":"function_call","name":name,"call_id":"codex-reply","arguments":json!({"questions":questions}).to_string()}})
    )).unwrap();
    let client = reqwest::blocking::Client::new();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        let d: Value = client
            .get(format!("{}/api/state", server.base))
            .send()
            .unwrap()
            .json()
            .unwrap();
        if array(&d["sessions"])
            .iter()
            .any(|s| s["id"] == "codex-reply-fixture" && s["orca_focus"] == terminal)
        {
            if let Some(card) = array(&d["decisions"]["pending"]).first() {
                return card.clone();
            }
        }
        assert!(
            std::time::Instant::now() < deadline,
            "Codex reply fixture not linked"
        );
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}
fn terminal_screen(server: &Server, filename: &str, lines: &[&str]) {
    save_json(
        server._temp.path().join(filename),
        &json!({"ok":true,"result":{"terminal":{"source":"screen","tail":lines}}}),
    )
    .unwrap();
}
fn reply(server: &Server, card: &Value, answers: Value) -> reqwest::blocking::Response {
    reqwest::blocking::Client::new()
        .post(format!("{}/api/decision/answer", server.base))
        .json(&json!({"id":card["id"],"answers":answers}))
        .send()
        .unwrap()
}

#[test]
fn codex_async_reply_is_submitted_once_without_overwriting_a_draft() {
    let server = server_with_collect(true);
    let card = codex_reply_fixture(
        &server,
        true,
        json!([{"title":"진행할까요?","options":["진행","보류"]},{"title":"추가 의견은?"}]),
    );
    terminal_screen(
        &server,
        "terminal-screen.json",
        &["› 사용자가 작성 중인 초안", "GPT-6.1", "? for shortcuts"],
    );
    assert_eq!(
        reply(&server, &card, json!(["진행", "상세 의견"])).status(),
        409
    );
    assert!(!server._temp.path().join("terminal-input").exists());
    save_json(server._temp.path().join("terminal-screen.json"),&json!({"ok":true,"result":{"terminal":{"source":"screen","tail":["Working"],"draft":"Orca UI 초안"}}})).unwrap();
    assert_eq!(
        reply(&server, &card, json!(["진행", "상세 의견"])).status(),
        409
    );
    assert!(!server._temp.path().join("terminal-input").exists());
    terminal_screen(&server, "terminal-screen.json", &["Working"]);
    save_json(server._temp.path().join("terminal-info.json"),&json!({"ok":true,"result":{"terminal":{"agentIdentity":"codex","connected":true,"writable":true}}})).unwrap();
    assert_eq!(
        reply(&server, &card, json!(["진행", "상세 의견"])).status(),
        200
    );
    let input = fs::read_to_string(server._temp.path().join("terminal-input")).unwrap();
    assert!(input.contains("> 진행할까요?\n\n진행\n\n> 추가 의견은?\n\n상세 의견"));
    assert_eq!(
        reply(&server, &card, json!(["진행", "상세 의견"])).status(),
        409
    );
    assert_eq!(
        fs::read_to_string(server._temp.path().join("terminal-input")).unwrap(),
        input
    );
}

#[test]
fn codex_sync_reply_checks_question_before_typing_the_choice() {
    let server = server_with_collect(true);
    let card = codex_reply_fixture(
        &server,
        false,
        json!([{"id":"proceed","question":"진행할까요?","header":"확인","options":[{"label":"진행"},{"label":"보류"}]}]),
    );
    terminal_screen(
        &server,
        "terminal-screen.json",
        &[
            "Question 1/1 (1 unanswered)",
            "다른 질문",
            "› 1. 진행",
            "  2. 보류",
            "enter to submit answer · esc to interrupt",
        ],
    );
    assert_eq!(reply(&server, &card, json!(["보류"])).status(), 409);
    assert!(!server._temp.path().join("terminal-input").exists());
    terminal_screen(
        &server,
        "terminal-screen.json",
        &[
            "Question 1/1 (1 unanswered)",
            "진행할까요?",
            "› 1. 진행",
            "  2. 보류",
            "enter to submit answer · esc to interrupt",
        ],
    );
    terminal_screen(
        &server,
        "terminal-screen-1.json",
        &["› Ask Codex to do anything", "? for shortcuts"],
    );
    assert_eq!(reply(&server, &card, json!(["보류"])).status(), 200);
    let input = fs::read_to_string(server._temp.path().join("terminal-input")).unwrap();
    assert!(input.contains("--text\0"));
    assert!(input.contains("2\0"));
    assert!(!input.contains("--enter"));
}

#[test]
fn codex_sync_freeform_uses_bracketed_paste_and_then_submits() {
    let server = server_with_collect(true);
    let card = codex_reply_fixture(
        &server,
        false,
        json!([{"id":"notes","question":"추가 의견은?","header":"의견","options":null}]),
    );
    terminal_screen(
        &server,
        "terminal-screen.json",
        &[
            "Question 1/1 (1 unanswered)",
            "추가 의견은?",
            "› Type your answer (optional)",
            "enter to submit answer · esc to interrupt",
        ],
    );
    terminal_screen(
        &server,
        "terminal-screen-2.json",
        &["› Ask Codex to do anything", "? for shortcuts"],
    );
    assert_eq!(
        reply(&server, &card, json!(["직접 입력한 의견입니다"])).status(),
        200
    );
    let input = fs::read_to_string(server._temp.path().join("terminal-input")).unwrap();
    assert!(input.contains("\x1b[200~직접 입력한 의견입니다\x1b[201~\0"));
    assert!(input.contains("\r\0"));
}
