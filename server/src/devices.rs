//! 실기기 탭: 이 맥에 연결된 실측 기기(iOS·Android)와 그 기기를 쓰는 세션, 기기 화면 라이브.
//!
//! 점유는 mobile-record 스킬(`free_devices.py`·`launch_runner.py`·`mobile_record.py`)의 규약을 그대로 읽는다.
//! - 사용자 임시 폴더의 `mobile-{runner,record,hold}-<sha256(id)[..16]>.lock` 에 flock 이 잡혀 있으면 사용 중
//! - 기기 ID 를 인자로 든 프로세스(xcodebuild·adb -s …)가 있으면 사용 중
//! - `mobile-device-queue/*.json` 은 기기를 기다리는 세션
//!
//! 락을 쥔(또는 기기 ID 를 든) 프로세스의 환경 변수 `CLAUDE_CODE_SESSION_ID`·`CODEX_THREAD_ID`·`ORCA_TERMINAL_HANDLE`
//! 로 세션과 Orca 터미널을 찾는다. 화면은 iOS 는 DeviceKit 러너의 `/mjpeg` 를, Android 는 `adb exec-out screencap`
//! 을 기기마다 한 번만 받아 보는 사람 모두에게 나눠 준다. 아무도 보지 않으면 멈춘다.
//! 대시보드가 띄우는 adb 는 기기 ID 를 인자 대신 `ANDROID_SERIAL` 로 넘긴다 — 인자에 ID 가 보이면 다른 세션의
//! `free_devices.py` 가 그 기기를 사용 중으로 판정해 버리기 때문이다.
use crate::{app::App, core::*};
use axum::{
    body::Body,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tokio::sync::broadcast;

const LOCKS: [(&str, &str); 3] = [
    ("mobile-runner-", "runner"),
    ("mobile-record-", "record"),
    ("mobile-hold-", "hold"),
];

fn temp_dir() -> PathBuf {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        // Python 의 tempfile.gettempdir() 는 TMPDIR 을 따른다. launchd 아래에서는 TMPDIR 이 비어 있을 수 있어
        // 사용자 임시 폴더를 직접 묻는다.
        command("/usr/bin/getconf", &["DARWIN_USER_TEMP_DIR"], None, 5)
            .ok()
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty())
            .or_else(|| std::env::var("TMPDIR").ok())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/tmp"))
    })
    .clone()
}

pub fn lock_key(id: &str) -> String {
    let d = Sha256::digest(id.as_bytes());
    d.iter().map(|b| format!("{b:02x}")).collect::<String>()[..16].to_owned()
}

fn which(name: &str, fallbacks: &[PathBuf]) -> Option<PathBuf> {
    std::env::var("PATH")
        .unwrap_or_default()
        .split(':')
        .map(|d| Path::new(d).join(name))
        .chain(fallbacks.iter().cloned())
        .find(|p| p.is_file())
}
fn adb() -> Option<PathBuf> {
    which(
        "adb",
        &[home().join("Library/Android/sdk/platform-tools/adb")],
    )
}
fn ffmpeg() -> Option<PathBuf> {
    which("ffmpeg", &[PathBuf::from("/opt/homebrew/bin/ffmpeg")])
}

fn ios_devices() -> Vec<Value> {
    let Ok(out) = command(
        "/usr/bin/xcrun",
        &["devicectl", "list", "devices", "-j", "/dev/stdout", "-q"],
        None,
        20,
    ) else {
        return vec![];
    };
    let v: Value = serde_json::from_str(&out).unwrap_or(Value::Null);
    array(&v["result"]["devices"])
        .iter()
        .filter(|d| {
            d["hardwareProperties"]["reality"] == "physical"
                && !text(&d["connectionProperties"]["transportType"]).is_empty()
        })
        .map(|d| {
            let mut ids = vec![
                text(&d["hardwareProperties"]["udid"]).to_owned(),
                text(&d["identifier"]).to_owned(),
            ];
            ids.retain(|s| !s.is_empty());
            ids.sort();
            ids.dedup();
            json!({"platform":"ios","name":d["deviceProperties"]["name"],"os":d["deviceProperties"]["osVersionNumber"],
                "model":d["hardwareProperties"]["marketingName"],"transport":d["connectionProperties"]["transportType"],"ids":ids})
        })
        .collect()
}

fn android_devices() -> Vec<Value> {
    let Some(adb) = adb() else { return vec![] };
    let Ok(out) = command(&adb.to_string_lossy(), &["devices", "-l"], None, 10) else {
        return vec![];
    };
    out.lines()
        .skip(1)
        .filter_map(|line| {
            let f: Vec<&str> = line.split_whitespace().collect();
            if f.len() < 2 || f[1] != "device" || f[0].starts_with("emulator-") {
                return None;
            }
            let model = f
                .iter()
                .find_map(|x| x.strip_prefix("model:"))
                .unwrap_or(f[0]);
            Some(json!({"platform":"android","name":model,"os":null,"model":model,"transport":if f[0].contains(':'){"network"}else{"wired"},"ids":[f[0]]}))
        })
        .collect()
}

struct Proc {
    ppid: u32,
    command: String,
}
fn process_table() -> HashMap<u32, Proc> {
    command("/bin/ps", &["-axo", "pid=,ppid=,command="], None, 10)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let pid = it.next()?.parse().ok()?;
            let ppid = it.next()?.parse().ok()?;
            Some((
                pid,
                Proc {
                    ppid,
                    command: it.collect::<Vec<_>>().join(" "),
                },
            ))
        })
        .collect()
}

/// 그 프로세스의 환경에서 세션·터미널을 찾는다. `ps -E` 는 같은 사용자의 프로세스 환경을 명령줄 뒤에 붙여 준다.
fn env_of(pid: u32) -> HashMap<&'static str, String> {
    let mut out = HashMap::new();
    let Ok(s) = command(
        "/bin/ps",
        &["-E", "-ww", "-o", "command=", "-p", &pid.to_string()],
        None,
        5,
    ) else {
        return out;
    };
    for tok in s.split_whitespace() {
        for k in [
            "CLAUDE_CODE_SESSION_ID",
            "CODEX_THREAD_ID",
            "ORCA_TERMINAL_HANDLE",
        ] {
            if let Some(v) = tok.strip_prefix(k).and_then(|r| r.strip_prefix('=')) {
                out.insert(k, v.to_owned());
            }
        }
    }
    out
}

/// 세션 ID·Orca 터미널: 그 프로세스부터 부모 쪽으로 올라가며 처음 찾은 것.
fn owner_of(pid: u32, ps: &HashMap<u32, Proc>) -> (Option<String>, Option<String>) {
    let mut cur = pid;
    for _ in 0..8 {
        let env = env_of(cur);
        let sid = env
            .get("CLAUDE_CODE_SESSION_ID")
            .or(env.get("CODEX_THREAD_ID"))
            .cloned()
            .or_else(|| {
                // Claude Code 본체는 ~/.claude/sessions/<pid>.json 에 자기 세션 ID 를 적는다
                let v = read_json(home().join(format!(".claude/sessions/{cur}.json")));
                v["sessionId"].as_str().map(str::to_owned)
            });
        let term = env.get("ORCA_TERMINAL_HANDLE").cloned();
        if sid.is_some() || term.is_some() {
            return (sid, term);
        }
        match ps.get(&cur) {
            Some(p) if p.ppid > 1 => cur = p.ppid,
            _ => break,
        }
    }
    (None, None)
}

fn lock_holders(path: &Path) -> Vec<u32> {
    use fs2::FileExt;
    let Ok(f) = std::fs::OpenOptions::new().append(true).open(path) else {
        return vec![];
    };
    if f.try_lock_exclusive().is_ok() {
        let _ = FileExt::unlock(&f);
        return vec![];
    }
    // 확인하려고 연 파일을 닫은 뒤에 물어야 lsof 가 이 서버를 보유자로 세지 않는다
    drop(f);
    let me = std::process::id();
    let pids: Vec<u32> = command_full(
        "/usr/sbin/lsof",
        &["-t", "--", &path.to_string_lossy()],
        None,
        5,
        &[],
    )
    .map(|(_, o, _)| {
        o.lines()
            .filter_map(|l| l.trim().parse().ok())
            .filter(|p| *p != me)
            .collect()
    })
    .unwrap_or_default();
    // 락은 잡혀 있는데 쥔 프로세스를 못 찾은 경우에도 사용 중으로 남긴다 (pid 0)
    if pids.is_empty() { vec![0] } else { pids }
}

fn arg_after<'a>(cmd: &'a str, flag: &str) -> Option<&'a str> {
    let mut it = cmd.split_whitespace();
    while let Some(t) = it.next() {
        if t == flag {
            return it.next();
        }
        if let Some(v) = t.strip_prefix(flag).and_then(|r| r.strip_prefix('=')) {
            return Some(v);
        }
    }
    None
}

fn session_info(app: &App, sid: Option<&str>, term: Option<&str>) -> (Value, Value) {
    let s = app.state.read().unwrap();
    let sm = sid
        .and_then(|id| s.summaries.iter().find(|x| text(&x["id"]) == id))
        .or_else(|| {
            term.and_then(|h| {
                s.summaries
                    .iter()
                    .find(|x| text(&x["orca_focus"]) == h && x["parent"].is_null())
            })
        });
    let session = match sm {
        Some(x) => {
            json!({"id":x["id"],"path":x["path"],"kind":x["kind"],"title":x["title"],"state":x["state"],"state_reason":x["state_reason"],"last_ts":x["last_ts"],"role":x["role"],"place":x["place"]})
        }
        None => sid.map_or(Value::Null, |id| json!({"id":id,"path":null})),
    };
    let terminal = term.map_or(Value::Null, |h| {
        let t = array(&s.orca["terminals"]).iter().find(|t| t["handle"] == h);
        match t {
            Some(t) => json!({"handle":h,"title":t["title"],"worktree":t["worktreePath"],"branch":t["branch"],"connected":t["connected"]}),
            None => json!({"handle":h}),
        }
    });
    (session, terminal)
}

fn label_of(cmd: &str) -> Option<String> {
    cmd.contains("free_devices.py")
        .then(|| arg_after(cmd, "--label").map(str::to_owned))
        .flatten()
        .filter(|l| l != "unlabeled")
}

fn scan(app: &App) -> Value {
    let ps = process_table();
    let me = std::process::id();
    let tmp = temp_dir();
    let mut devices = ios_devices();
    devices.extend(android_devices());
    let mut env_cache: HashMap<u32, (Option<String>, Option<String>)> = HashMap::new();
    let mut owner = |pid: u32| {
        env_cache
            .entry(pid)
            .or_insert_with(|| owner_of(pid, &ps))
            .clone()
    };
    for d in &mut devices {
        let ids: Vec<String> = array(&d["ids"])
            .iter()
            .map(|x| text(x).to_owned())
            .collect();
        // (pid, role)
        let mut uses: Vec<(u32, &str)> = vec![];
        for id in &ids {
            let key = lock_key(id);
            for (prefix, role) in LOCKS {
                for pid in lock_holders(&tmp.join(format!("{prefix}{key}.lock"))) {
                    uses.push((pid, role));
                }
            }
        }
        for (pid, p) in &ps {
            if *pid == me || p.ppid == me || !ids.iter().any(|id| p.command.contains(id.as_str())) {
                continue;
            }
            uses.push((*pid, "process"));
        }
        // 같은 세션(없으면 같은 터미널, 그것도 없으면 프로세스)끼리 묶는다
        let mut groups: Vec<(String, Value)> = vec![];
        let mut runner_out: Option<String> = None;
        for (pid, role) in uses {
            let cmd = ps.get(&pid).map(|p| p.command.clone()).unwrap_or_default();
            if cmd.contains("launch_runner.py") {
                runner_out = arg_after(&cmd, "--out").map(str::to_owned).or(runner_out);
            }
            let (sid, term) = if pid == 0 { (None, None) } else { owner(pid) };
            let key = sid
                .clone()
                .or_else(|| term.clone())
                .unwrap_or_else(|| format!("pid:{pid}"));
            let idx = match groups.iter().position(|(k, _)| *k == key) {
                Some(i) => i,
                None => {
                    let (session, terminal) = session_info(app, sid.as_deref(), term.as_deref());
                    groups.push((key, json!({"session":session,"terminal":terminal,"roles":[],"label":null,"procs":[]})));
                    groups.len() - 1
                }
            };
            let g = &mut groups[idx].1;
            if !array(&g["roles"]).iter().any(|r| r == role) {
                g["roles"].as_array_mut().unwrap().push(json!(role));
            }
            if let Some(l) = label_of(&cmd) {
                g["label"] = json!(l);
            }
            if pid != 0 && !array(&g["procs"]).iter().any(|p| p["pid"] == pid) {
                g["procs"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"pid":pid,"command":short(&cmd, 240)}));
            }
        }
        let busy = !groups.is_empty();
        let runner = groups
            .iter()
            .any(|(_, g)| array(&g["roles"]).iter().any(|r| r == "runner"));
        let recording = groups
            .iter()
            .any(|(_, g)| array(&g["roles"]).iter().any(|r| r == "record"));
        let id = ids.first().cloned().unwrap_or_default();
        if let Some(out) = runner_out {
            endpoints().lock().unwrap().insert(id.clone(), out);
        }
        let stream = if d["platform"] == "android" {
            json!({"kind":"screencap","ok":true})
        } else if runner {
            json!({"kind":"mjpeg","ok":true})
        } else {
            json!({"kind":"mjpeg","ok":false,"reason":"DeviceKit 러너가 떠 있지 않아 화면을 받을 수 없습니다"})
        };
        d["id"] = json!(id);
        d["free"] = json!(!busy);
        d["recording"] = json!(recording);
        d["users"] = json!(groups.into_iter().map(|(_, g)| g).collect::<Vec<_>>());
        d["stream"] = stream;
    }
    // 기기를 기다리는 세션 (free_devices.py --acquire 의 FIFO 대기열)
    let mut queue = vec![];
    let mut entries: Vec<PathBuf> = std::fs::read_dir(tmp.join("mobile-device-queue"))
        .map(|r| r.flatten().map(|e| e.path()).collect())
        .unwrap_or_default();
    entries.sort();
    for p in entries {
        let w = read_json(&p);
        let Some(pid) = w["pid"].as_u64().map(|x| x as u32) else {
            continue;
        };
        if !ps.contains_key(&pid) {
            continue;
        }
        let (sid, term) = owner(pid);
        let (session, terminal) = session_info(app, sid.as_deref(), term.as_deref());
        let since = p
            .file_stem()
            .and_then(|s| s.to_str())
            .and_then(|s| s.split('-').next())
            .and_then(|ns| ns.parse::<f64>().ok())
            .map(|ns| ns / 1e9);
        queue.push(json!({"pid":pid,"platform":w["platform"],"label":w["label"],"since":since,"session":session,"terminal":terminal}));
    }
    json!({"devices":devices,"queue":queue,"at":now(),"tools":{"adb":adb().is_some(),"ffmpeg":ffmpeg().is_some()}})
}

/// GET /api/devices — 3초 동안은 같은 결과를 돌려준다 (devicectl·lsof·ps 를 매번 부르지 않게)
pub fn list(app: &App) -> Value {
    static CACHE: OnceLock<Mutex<(f64, Value)>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new((0., Value::Null)));
    let mut c = cache.lock().unwrap();
    if now() - c.0 > 3. || c.1.is_null() {
        *c = (now(), scan(app));
    }
    c.1.clone()
}

// ---------- 화면 라이브 ----------

/// 기기 ID → launch_runner 의 --out 폴더 (endpoint.txt 가 있는 곳)
fn endpoints() -> &'static Mutex<HashMap<String, String>> {
    static E: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    E.get_or_init(Default::default)
}

type Frame = Arc<(&'static str, Vec<u8>)>;
struct Feed {
    tx: broadcast::Sender<Frame>,
    last: Mutex<Option<Frame>>,
}
fn feeds() -> &'static Mutex<HashMap<String, Arc<Feed>>> {
    static F: OnceLock<Mutex<HashMap<String, Arc<Feed>>>> = OnceLock::new();
    F.get_or_init(Default::default)
}

fn ios_endpoint(ids: &[String]) -> Option<String> {
    let outs = endpoints().lock().unwrap().clone();
    for id in ids {
        if let Some(out) = outs.get(id) {
            if let Ok(e) = std::fs::read_to_string(Path::new(out).join("endpoint.txt")) {
                let e = e.trim().trim_end_matches('/').to_owned();
                if e.starts_with("http://") {
                    return Some(e);
                }
            }
        }
    }
    // launch_runner 를 거치지 않은 러너: 페어링 터널 주소의 DeviceKit 기본 포트
    let tmp = std::env::temp_dir().join(format!("adash-dev-{}.json", uuid::Uuid::new_v4()));
    let ok = command(
        "/usr/bin/xcrun",
        &[
            "devicectl",
            "device",
            "info",
            "details",
            "--device",
            &ids[0],
            "--json-output",
            &tmp.to_string_lossy(),
        ],
        None,
        20,
    )
    .is_ok();
    let v = read_json(&tmp);
    let _ = std::fs::remove_file(&tmp);
    let ip = text(&v["result"]["connectionProperties"]["tunnelIPAddress"]);
    (ok && !ip.is_empty()).then(|| format!("http://[{ip}]:12004"))
}

/// multipart(MJPEG) 응답을 프레임 단위로 자른다: 머리의 Content-Length 만큼이 JPEG 한 장
fn take_frame(buf: &mut Vec<u8>) -> Option<Vec<u8>> {
    let head_end = buf.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = String::from_utf8_lossy(&buf[..head_end]).to_lowercase();
    let len: usize = head
        .lines()
        .find_map(|l| l.strip_prefix("content-length:"))
        .and_then(|v| v.trim().parse().ok())?;
    let start = head_end + 4;
    if buf.len() < start + len {
        return None;
    }
    let frame = buf[start..start + len].to_vec();
    buf.drain(..start + len);
    Some(frame)
}

async fn run_ios(feed: Arc<Feed>, ids: Vec<String>) {
    let client = reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(3))
        .build()
        .unwrap();
    while feed.tx.receiver_count() > 0 {
        let ids2 = ids.clone();
        let endpoint = tokio::task::spawn_blocking(move || ios_endpoint(&ids2))
            .await
            .ok()
            .flatten();
        if let Some(e) = endpoint {
            // 녹화(5fps·50%)보다 가볍게: 보기용이라 3fps·40%
            if let Ok(resp) = client
                .get(format!("{e}/mjpeg?fps=3&quality=60&scale=40"))
                .send()
                .await
            {
                let mut body = resp.bytes_stream();
                let mut buf = Vec::new();
                use tokio_stream::StreamExt;
                loop {
                    let next = tokio::time::timeout(Duration::from_secs(10), body.next()).await;
                    let Ok(Some(Ok(chunk))) = next else { break };
                    buf.extend_from_slice(&chunk);
                    while let Some(f) = take_frame(&mut buf) {
                        let f: Frame = Arc::new(("image/jpeg", f));
                        *feed.last.lock().unwrap() = Some(f.clone());
                        let _ = feed.tx.send(f);
                    }
                    if buf.len() > 8 << 20 {
                        buf.clear();
                    }
                    if feed.tx.receiver_count() == 0 {
                        return;
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

async fn run_android(feed: Arc<Feed>, serial: String) {
    use tokio::process::Command;
    let Some(adb) = adb() else { return };
    let ff = ffmpeg();
    while feed.tx.receiver_count() > 0 {
        let started = std::time::Instant::now();
        let shot = tokio::time::timeout(
            Duration::from_secs(10),
            Command::new(&adb)
                .env("ANDROID_SERIAL", &serial)
                .args(["exec-out", "screencap", "-p"])
                .kill_on_drop(true)
                .output(),
        )
        .await;
        let png = match shot {
            Ok(Ok(o)) if o.status.success() && o.stdout.starts_with(b"\x89PNG") => o.stdout,
            _ => {
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            }
        };
        // 원본 PNG 는 한 장에 수 MB 라 원격(tailnet)에서 보기 무겁다: ffmpeg 가 있으면 줄인 JPEG 로
        let frame: (&'static str, Vec<u8>) = match &ff {
            Some(ff) => {
                let mut child = match Command::new(ff)
                    .args([
                        "-hide_banner",
                        "-loglevel",
                        "error",
                        "-f",
                        "png_pipe",
                        "-i",
                        "-",
                        "-vf",
                        "scale='min(540,iw)':-2",
                        "-q:v",
                        "6",
                        "-f",
                        "mjpeg",
                        "-",
                    ])
                    .stdin(std::process::Stdio::piped())
                    .stdout(std::process::Stdio::piped())
                    .kill_on_drop(true)
                    .spawn()
                {
                    Ok(c) => c,
                    Err(_) => continue,
                };
                let mut stdin = child.stdin.take().unwrap();
                let writer = tokio::spawn(async move {
                    use tokio::io::AsyncWriteExt;
                    let _ = stdin.write_all(&png).await;
                });
                let out =
                    tokio::time::timeout(Duration::from_secs(10), child.wait_with_output()).await;
                let _ = writer.await;
                match out {
                    Ok(Ok(o)) if o.status.success() && !o.stdout.is_empty() => {
                        ("image/jpeg", o.stdout)
                    }
                    _ => continue,
                }
            }
            None => ("image/png", png),
        };
        let f: Frame = Arc::new(frame);
        *feed.last.lock().unwrap() = Some(f.clone());
        let _ = feed.tx.send(f);
        let spent = started.elapsed();
        if spent < Duration::from_millis(700) {
            tokio::time::sleep(Duration::from_millis(700) - spent).await;
        }
    }
}

/// GET /api/devices/stream?id=<기기 ID> — multipart/x-mixed-replace 로 화면을 흘린다 (<img src> 로 본다)
pub async fn stream(app: &App, id: &str) -> Response {
    let app2 = app.clone();
    let listed = tokio::task::spawn_blocking(move || list(&app2))
        .await
        .unwrap_or(Value::Null);
    let Some(dev) = array(&listed["devices"])
        .iter()
        .find(|d| array(&d["ids"]).iter().any(|x| x == id))
        .cloned()
    else {
        return (StatusCode::NOT_FOUND, "unknown device").into_response();
    };
    if dev["stream"]["ok"] != true {
        return (
            StatusCode::CONFLICT,
            text(&dev["stream"]["reason"]).to_owned(),
        )
            .into_response();
    }
    let key = text(&dev["id"]).to_owned();
    let (feed, rx) = {
        let mut map = feeds().lock().unwrap();
        if let Some(f) = map.get(&key).filter(|f| f.tx.receiver_count() > 0) {
            let f = f.clone();
            let rx = f.tx.subscribe();
            (f, rx)
        } else {
            let (tx, rx) = broadcast::channel(4);
            let f = Arc::new(Feed {
                tx,
                last: Mutex::new(None),
            });
            map.insert(key.clone(), f.clone());
            let ids: Vec<String> = array(&dev["ids"])
                .iter()
                .map(|x| text(x).to_owned())
                .collect();
            if dev["platform"] == "android" {
                tokio::spawn(run_android(f.clone(), key.clone()));
            } else {
                tokio::spawn(run_ios(f.clone(), ids));
            }
            (f, rx)
        }
    };
    let first = feed.last.lock().unwrap().clone();
    let part = |f: &Frame| {
        let mut b = format!(
            "--frame\r\nContent-Type: {}\r\nContent-Length: {}\r\n\r\n",
            f.0,
            f.1.len()
        )
        .into_bytes();
        b.extend_from_slice(&f.1);
        b.extend_from_slice(b"\r\n");
        Ok::<_, std::convert::Infallible>(axum::body::Bytes::from(b))
    };
    use tokio_stream::StreamExt;
    let head = tokio_stream::iter(first.iter().map(part).collect::<Vec<_>>());
    let rest = tokio_stream::wrappers::BroadcastStream::new(rx)
        .filter_map(move |r| r.ok().map(|f| part(&f)));
    let mut r = Response::new(Body::from_stream(head.chain(rest)));
    let h = r.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        "multipart/x-mixed-replace; boundary=frame".parse().unwrap(),
    );
    h.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_key_matches_free_devices() {
        // python3 -c "import hashlib;print(hashlib.sha256(b'R39M306319P').hexdigest()[:16])"
        assert_eq!(lock_key("R39M306319P"), "eb14b8b912014573");
    }

    #[test]
    fn take_frame_splits_mjpeg_parts() {
        let mut buf = b"--b\r\nContent-Type: image/jpeg\r\nContent-Length: 3\r\n\r\nabc\r\n--b\r\nContent-Length: 2\r\n\r\nx".to_vec();
        assert_eq!(take_frame(&mut buf).as_deref(), Some(&b"abc"[..]));
        assert_eq!(take_frame(&mut buf), None);
        buf.extend_from_slice(b"y\r\n");
        assert_eq!(take_frame(&mut buf).as_deref(), Some(&b"xy"[..]));
    }

    #[test]
    fn label_and_flags() {
        let c = "python free_devices.py --acquire ios --label PSQ-1227";
        assert_eq!(label_of(c).as_deref(), Some("PSQ-1227"));
        assert_eq!(arg_after("x --out=/a/b y", "--out"), Some("/a/b"));
        assert_eq!(label_of("python other.py --label X"), None);
    }
}
