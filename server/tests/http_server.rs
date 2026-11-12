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
