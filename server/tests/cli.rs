use agent_dashboard::{core::*, data};
use serde_json::{Value, json};
use std::{
    fs,
    path::Path,
    process::{Command, Output},
};
fn command(root: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_agent-dashboard"))
        .args(args)
        .env("HOME", root)
        .env("ADASH_DATA", root.join("data"))
        .env("ATEST_DIR", root.join("progress"))
        .env("CODEX_THREAD_ID", "synthetic-test-session")
        .env_remove("CLAUDE_CODE_SESSION_ID")
        .env_remove("ORCA_TERMINAL_HANDLE")
        .env("DASH_LABEL", "local.agent-dashboard-isolated-test")
        .output()
        .unwrap()
}
#[test]
fn native_plan_echo_and_store() {
    use base64::Engine;
    let d = tempfile::tempdir().unwrap();
    let out = command(d.path(), &["aplan", "set", "조사", "구현", "검증"]);
    assert!(out.status.success());
    let stdout = String::from_utf8(out.stdout).unwrap();
    let token = stdout
        .lines()
        .find_map(|s| s.strip_prefix("APLAN:"))
        .unwrap();
    let ev: Value = serde_json::from_slice(
        &base64::engine::general_purpose::URL_SAFE
            .decode(token)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(ev["steps"], json!(["조사", "구현", "검증"]));
    let lines = read_lines(d.path().join(".agent-plans/synthetic-test-session.jsonl"));
    assert_eq!(lines[0]["event"], ev);
}
#[test]
fn native_manual_test_progress() {
    let d = tempfile::tempdir().unwrap();
    for a in [
        vec![
            "atest", "start", "--key", "manual", "--kind", "qa", "A=first", "B=second",
        ],
        vec!["atest", "case", "A", "running", "--key", "manual"],
        vec!["atest", "case", "A", "passed", "--key", "manual"],
        vec!["atest", "case", "B", "failed", "reason", "--key", "manual"],
        vec!["atest", "end", "--key", "manual"],
    ] {
        let r = command(d.path(), &a);
        assert!(r.status.success(), "{}", String::from_utf8_lossy(&r.stderr));
    }
    let r = read_json(d.path().join("progress/manual.json"));
    assert_eq!(r["phase"], "failed");
    assert_eq!(r["total"], 2);
    assert_eq!(r["done"], 2);
    assert_eq!(r["passed"], 1);
    assert_eq!(r["failed"], 1);
    assert_eq!(r["cases"][1]["msg"], "reason");
}
#[test]
fn native_test_wrapper_preserves_output_exit_and_expected_red() {
    let d = tempfile::tempdir().unwrap();
    let r = command(
        d.path(),
        &[
            "atest",
            "run",
            "--kind",
            "test",
            "--key",
            "wrapped",
            "--expect-red",
            "--",
            "sh",
            "-c",
            "printf '✓ succeeds\n✗ expected failure\n'; exit 3",
        ],
    );
    assert_eq!(r.status.code(), Some(3));
    assert_eq!(
        String::from_utf8(r.stdout).unwrap(),
        "✓ succeeds\n✗ expected failure\n"
    );
    let p = read_json(d.path().join("progress/wrapped.json"));
    assert_eq!(p["phase"], "done");
    assert_eq!(p["verdict"], "red");
    assert_eq!(p["exit"], 3);
    assert_eq!(p["passed"], 1);
    assert_eq!(p["failed"], 1);
}
#[test]
fn wrapper_records_start_failure() {
    let d = tempfile::tempdir().unwrap();
    let r = command(
        d.path(),
        &[
            "atest",
            "run",
            "--key",
            "absent",
            "--",
            "/definitely-absent-command",
        ],
    );
    assert_eq!(r.status.code(), Some(127));
    assert_eq!(
        read_json(d.path().join("progress/absent.json"))["verdict"],
        "error"
    );
}
#[test]
fn rust_runner_reports_cases() {
    let d = tempfile::tempdir().unwrap();
    let r = command(
        d.path(),
        &[
            "atest",
            "run",
            "--kind",
            "rust",
            "--key",
            "cargo",
            "--",
            "sh",
            "-c",
            "printf 'test example ... ok\ntest skipped ... ignored\n'",
        ],
    );
    assert!(r.status.success());
    let p = read_json(d.path().join("progress/cargo.json"));
    assert_eq!(p["passed"], 1);
    assert_eq!(p["pending"], 1);
}
#[test]
fn sheet_parser_handles_quoted_cells() {
    let s = "버전,1,단말,\"phone, tablet\"\n총 TC,\"1,000\",Pass,900\nFail,20,Blocked,30\nDropped,10,N-Test,40\n";
    let p = agent_dashboard::cli::parse_sheet(s).unwrap();
    assert_eq!(p["total"], 1000);
    assert_eq!(p["device"], "phone, tablet");
}
#[test]
fn data_export_import_retains_state_and_backs_up() {
    let d = tempfile::tempdir().unwrap();
    let root = d.path();
    fs::create_dir_all(root.join("data")).unwrap();
    save_json(
        root.join("data/prefs.json"),
        &json!({"external_plans":["/synthetic/plan.json"]}),
    )
    .unwrap();
    let archive = root.join("export.tar.gz");
    let out = command(root, &["adata", "export", "-o", archive.to_str().unwrap()]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    save_json(root.join("data/prefs.json"), &json!({"changed":true})).unwrap();
    let out = command(
        root,
        &["adata", "import", archive.to_str().unwrap(), "--force"],
    );
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        read_json(root.join("data/prefs.json"))["external_plans"],
        json!(["/synthetic/plan.json"])
    );
    assert!(fs::read_dir(root.join("data")).unwrap().flatten().any(|e| {
        e.file_name()
            .to_string_lossy()
            .starts_with("adata-backup-import-")
    }));
}
#[test]
fn archives_reject_paths_and_links() {
    for p in [
        "../prefs.json",
        "/prefs.json",
        "prefs.json/../../escape",
        "vscode-web",
        ".token",
        "unknown.json",
    ] {
        assert!(!data::safe_member(Path::new(p), true));
    }
    assert!(data::safe_member(Path::new("prefs.json"), true));
    assert!(!data::safe_member(Path::new("prefs.json"), false));
}
#[test]
fn subprocess_deadline_kills_descendants() {
    let started = std::time::Instant::now();
    let out = agent_dashboard::core::command("sh", &["-c", "sleep 10"], None, 1);
    assert!(out.is_err());
    assert!(started.elapsed().as_secs_f64() < 3.);
}

#[test]
fn public_symlink_and_hook_wrappers_dispatch_without_python() {
    let d = tempfile::tempdir().unwrap();
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let r = Command::new(root.join("bin/atest"))
        .args(["start", "--key", "wrapper", "A=case"])
        .current_dir(d.path())
        .env("ADASH_BINARY", env!("CARGO_BIN_EXE_agent-dashboard"))
        .env("HOME", d.path())
        .env("ATEST_DIR", d.path().join("progress"))
        .output()
        .unwrap();
    assert!(r.status.success(), "{}", String::from_utf8_lossy(&r.stderr));
    assert_eq!(
        read_json(d.path().join("progress/wrapper.json"))["cases"][0]["id"],
        "A"
    );
    for hook in ["decision-hook", "session-guard"] {
        let r = Command::new(root.join("server").join(hook))
            .env("ADASH_BINARY", d.path().join("missing"))
            .output()
            .unwrap();
        assert!(r.status.success());
        assert!(r.stdout.is_empty());
    }
}

#[test]
fn launchd_installer_validates_before_replacing_service() {
    use std::os::unix::fs::PermissionsExt;
    let d = tempfile::tempdir().unwrap();
    let bin = d.path().join("bin");
    fs::create_dir_all(&bin).unwrap();
    let launchctl = bin.join("launchctl");
    fs::write(&launchctl,"#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$HOME/launchctl.log\"\nif [ \"$1\" = print ]; then echo 'state = running'; fi\n").unwrap();
    fs::set_permissions(&launchctl, fs::Permissions::from_mode(0o755)).unwrap();
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("launchd/install.sh");
    let run = |binary: &Path| {
        Command::new(&script)
            .env("HOME", d.path())
            .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
            .env("DASH_LABEL", "local.fixture")
            .env("DASH_BINARY", binary)
            .env("DASH_DATA", d.path().join("data & state"))
            .env("DASH_PROJECTS_DIRS", d.path().join("project & notes"))
            .env("DASH_ORIGINS", "https://example.test")
            .output()
            .unwrap()
    };
    let r = run(&d.path().join("missing"));
    assert!(!r.status.success());
    assert!(!d.path().join("launchctl.log").exists());
    let r = run(Path::new(env!("CARGO_BIN_EXE_agent-dashboard")));
    assert!(r.status.success(), "{}", String::from_utf8_lossy(&r.stderr));
    let plist =
        fs::read_to_string(d.path().join("Library/LaunchAgents/local.fixture.plist")).unwrap();
    assert!(plist.contains("data &amp; state"));
    assert!(plist.contains("project &amp; notes"));
    assert!(plist.contains("agent-dashboard</string>"));
    assert!(!plist.contains("server.py"));
    let log = fs::read_to_string(d.path().join("launchctl.log")).unwrap();
    assert!(log.lines().next().unwrap().starts_with("bootout "));
    assert!(log.contains("bootstrap "));
}
