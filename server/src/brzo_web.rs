//! The Brzo app's 「웹 접속」, used to hand a Brzo QA epic's 반출 승인·머지 지시 to its coordinator at once.
//!
//! `brzo` answers only inside a Brzo agent terminal, so a message from the dashboard waits in the epic's `outbox/` for
//! the next driver round (up to 10 minutes). The app serves its window's IPC on loopback instead: a client opens the
//! `/api/events` websocket, whose `hello` names its client id, then calls `POST /api/invoke {channel, args}` with that
//! id in `x-cb-client`. Both carry the `cb_web` cookie, the token in `<BRZO_HOME>/web-access-token`; it is read per
//! connection and never logged or returned. The person's own way to reach an agent is its terminal, so a message is
//! typed in as the person would (text, a short pause, Enter) — never into an agent waiting on a question, whose dialog
//! the text would answer. `brzo-qa-driver` (brzo-qa-core) types its messages the same way when called outside Brzo;
//! this side delivers what is still queued, with the same rules, and logs the same lines.
use crate::core::*;
use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Write},
    net::TcpStream,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

/// `ADASH_BRZO_WEB` (host:port) overrides the address and `BRZO_HOME` the app's folder, for tests.
fn endpoint() -> (String, PathBuf) {
    let addr = std::env::var("ADASH_BRZO_WEB").unwrap_or_else(|_| "127.0.0.1:4317".into());
    let home = std::env::var_os("BRZO_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| expand("~/Library/Application Support/Brzo"));
    (addr, home.join("web-access-token"))
}
fn token(path: &Path) -> Result<String> {
    let t = fs::read_to_string(path).map_err(|_| {
        "Brzo 웹 접속 토큰이 없습니다 (Brzo 설정 › 웹 접속을 켜 주세요)".to_string()
    })?;
    let t = t.trim().to_owned();
    if t.is_empty() || !t.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("Brzo 웹 접속 토큰 형식이 아닙니다".into());
    }
    Ok(t)
}
/// One websocket frame (server frames are unmasked): (opcode, payload); `None` at end of stream.
fn frame(s: &mut TcpStream, buf: &mut Vec<u8>) -> Option<(u8, Vec<u8>)> {
    fn need(s: &mut TcpStream, buf: &mut Vec<u8>, n: usize) -> Option<()> {
        let mut chunk = [0u8; 8192];
        while buf.len() < n {
            let k = s.read(&mut chunk).ok()?;
            if k == 0 {
                return None;
            }
            buf.extend_from_slice(&chunk[..k]);
        }
        Some(())
    }
    need(s, buf, 2)?;
    let op = buf[0] & 0x0f;
    let (mut n, mut off) = ((buf[1] & 0x7f) as usize, 2);
    if n == 126 {
        need(s, buf, 4)?;
        (n, off) = (u16::from_be_bytes([buf[2], buf[3]]) as usize, 4);
    } else if n == 127 {
        need(s, buf, 10)?;
        (n, off) = (u64::from_be_bytes(buf[2..10].try_into().ok()?) as usize, 10);
    }
    need(s, buf, off + n)?;
    let data = buf[off..off + n].to_vec();
    buf.drain(..off + n);
    Some((op, data))
}
/// A connection to the app: its event socket, held open so the client id stays valid, and the calls made with it.
pub struct Client {
    _ws: TcpStream,
    id: String,
    cookie: String,
    addr: String,
    http: reqwest::blocking::Client,
}
impl Client {
    pub fn connect() -> Result<Self> {
        let (addr, path) = endpoint();
        let cookie = token(&path)?;
        let mut s = TcpStream::connect(&addr).map_err(|_| {
            format!(
                "Brzo 웹 접속({addr})에 연결하지 못했습니다 (앱과 웹 접속이 켜져 있는지 확인하세요)"
            )
        })?;
        s.set_read_timeout(Some(Duration::from_secs(10))).ok();
        let key = {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD.encode(uuid::Uuid::new_v4().as_bytes())
        };
        s.write_all(format!("GET /api/events HTTP/1.1\r\nHost: {addr}\r\nCookie: cb_web={cookie}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").as_bytes())
            .map_err(|e| e.to_string())?;
        let mut buf = vec![];
        let mut chunk = [0u8; 4096];
        let end = loop {
            if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                break i;
            }
            let k = s
                .read(&mut chunk)
                .map_err(|_| "Brzo 웹 접속이 응답하지 않습니다".to_string())?;
            if k == 0 {
                return Err("Brzo 웹 접속이 연결을 끊었습니다".into());
            }
            buf.extend_from_slice(&chunk[..k]);
        };
        let status = String::from_utf8_lossy(&buf[..end])
            .lines()
            .next()
            .unwrap_or("")
            .to_owned();
        if !status.contains(" 101 ") {
            return Err(format!(
                "Brzo 웹 접속이 거부했습니다: {} (토큰이 바뀌었으면 앱에서 다시 받습니다)",
                short(&status, 60)
            ));
        }
        buf.drain(..end + 4);
        for _ in 0..50 {
            let Some((op, data)) = frame(&mut s, &mut buf) else {
                break;
            };
            let v: Value = serde_json::from_slice(&data).unwrap_or(Value::Null);
            if op != 1 || v["type"] != "hello" {
                continue;
            }
            let id = match &v["clientId"] {
                Value::String(s) => s.clone(),
                Value::Number(n) => n.to_string(),
                _ => continue,
            };
            let http = reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(60))
                .build()
                .map_err(|e| e.to_string())?;
            return Ok(Self {
                _ws: s,
                id,
                cookie,
                addr,
                http,
            });
        }
        Err("Brzo 웹 접속이 hello 를 보내지 않았습니다".into())
    }
    /// Call one IPC channel as the person would from the app's window. Ok: the call's result.
    pub fn call(&self, channel: &str, args: Value) -> Result<Value> {
        let res = self
            .http
            .post(format!("http://{}/api/invoke", self.addr))
            .header("Cookie", format!("cb_web={}", self.cookie))
            .header("x-cb-client", &self.id)
            .json(&json!({"channel":channel,"args":args}))
            .send()
            .map_err(|_| format!("Brzo {channel} 호출에 실패했습니다"))?;
        let code = res.status();
        let body: Value = res.json().unwrap_or(Value::Null);
        if !code.is_success() || body["ok"] == false {
            let why = body["error"]["message"]
                .as_str()
                .or(body["error"].as_str())
                .or(body["code"].as_str())
                .unwrap_or("알 수 없는 오류");
            return Err(format!(
                "Brzo {channel} 거부 ({}): {}",
                code.as_u16(),
                short(why, 200)
            ));
        }
        Ok(body["result"].clone())
    }
    pub fn node(&self, id: &str) -> Result<Option<Value>> {
        let st = self.call("brzo:getState", json!([]))?;
        Ok(array(&st["nodes"]).iter().find(|n| n["id"] == id).cloned())
    }
}
/// A question / permission dialog is open: typed text would answer it.
const BUSY: [&str; 1] = ["waiting"];
const DOWN: [&str; 2] = ["offline", "starting"];
fn down(n: &Value) -> bool {
    n["mainHandle"].as_str().is_none_or(str::is_empty)
        || n["asleep"] == true
        || DOWN.contains(&text(&n["state"]))
}
/// Type `message` into a Brzo agent's main terminal, waking a sleeping agent first (up to `wake`).
/// Ok(None): typed; Ok(Some(why)): not now (the message stays queued); Err: the app could not be reached.
pub fn type_into(c: &Client, node: &str, message: &str, wake: Duration) -> Result<Option<String>> {
    let flat = message.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.is_empty() {
        return Ok(Some("빈 메시지".into()));
    }
    let Some(mut n) = c.node(node)? else {
        return Ok(Some("Brzo 에 그 에이전트가 없습니다".into()));
    };
    if down(&n) {
        c.call("brzo:wakeAgent", json!([node]))?;
        let until = Instant::now() + wake;
        loop {
            std::thread::sleep(Duration::from_secs(2));
            n = c.node(node)?.unwrap_or(Value::Null);
            if !down(&n) {
                std::thread::sleep(Duration::from_secs(3)); // the agent's TUI draws its prompt after the terminal comes up
                break;
            }
            if Instant::now() > until {
                return Ok(Some("깨운 에이전트가 제시간에 뜨지 않았습니다".into()));
            }
        }
    }
    if BUSY.contains(&text(&n["state"])) {
        return Ok(Some(
            "에이전트가 질문·권한 응답을 기다리는 중입니다 (입력하면 그 대화상자에 들어갑니다)"
                .into(),
        ));
    }
    let h = text(&n["mainHandle"]);
    c.call("brzo:sendInput", json!([h, flat]))?;
    std::thread::sleep(Duration::from_millis(300));
    c.call("brzo:sendInput", json!([h, "\r"]))?;
    Ok(None)
}
/// One line in the epic's driver log, as `brzo-qa-driver` writes it.
fn log(watch: &Path, msg: &str) {
    let now = chrono::Local::now();
    let _ = fs::create_dir_all(watch.join("log"));
    if let Ok(mut f) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(watch.join("log").join(now.format("%Y%m%d.log").to_string()))
    {
        let _ = writeln!(f, "[{}] {msg}", now.format("%Y-%m-%d %H:%M:%S"));
    }
}
fn log_tell(watch: &Path, parent: &str, to: &str, m: &Value) {
    let _ = fs::create_dir_all(watch.join("log"));
    let rec = json!({"at":chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),"from":m["sender"].as_str().unwrap_or("agent-dashboard"),"to":to,"type":"dispatch","subject":m["subject"],"body":m["text"],"key":m["key"],"parent":parent,"ok":true,"via":"brzo-web"});
    if let Ok(mut f) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(watch.join("log").join("tell.jsonl"))
    {
        let _ = writeln!(f, "{rec}");
    }
}
/// The epic's queued messages for its coordinators (`to: "@coordinator"`), oldest first: (file, message).
pub fn queued(watch: &Path, key: Option<&str>) -> Vec<(PathBuf, Value)> {
    let mut files = fs::read_dir(watch.join("outbox"))
        .map(|d| {
            d.flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|x| x == "json"))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    files.sort();
    files
        .into_iter()
        .filter_map(|p| {
            let m = read_json(&p);
            (m["to"] == "@coordinator" && key.is_none_or(|k| m["key"] == k)).then_some((p, m))
        })
        .collect()
}
/// Deliver the epic's queued coordinator messages (one ticket's, or all) now. A message whose coordinator is not on
/// record, gone, or on a question stays for the driver round, which also starts a new coordinator when one is gone.
/// -> {sent, waiting: [{key, why}]}; Err when the app cannot be reached at all.
pub fn flush(watch: &Path, parent: &str, key: Option<&str>) -> Result<Value> {
    let items = queued(watch, key);
    if items.is_empty() {
        return Ok(json!({"sent":0,"waiting":[]}));
    }
    let c = Client::connect()?;
    let (mut sent, mut waiting) = (0, vec![]);
    for (path, m) in items {
        let k = text(&m["key"]);
        let title = text(&m["subject"])
            .strip_prefix(&format!("{k} "))
            .unwrap_or(text(&m["subject"]))
            .to_owned();
        let rec = read_json(watch.join("tickets").join(format!("{k}.json")));
        let Some(node) = rec["coordinator"]["handle"]
            .as_str()
            .filter(|s| !s.is_empty())
        else {
            waiting.push(json!({"key":k,"why":"코디네이터 기록이 없습니다"}));
            continue;
        };
        let why = match type_into(&c, node, text(&m["text"]), Duration::from_secs(90)) {
            Ok(w) => w,
            Err(e) => Some(e),
        };
        if let Some(why) = why {
            log(watch, &format!("WEB-WAIT {k} → {node} ({title}): {why}"));
            waiting.push(json!({"key":k,"why":why}));
            continue;
        }
        log_tell(watch, parent, node, &m);
        log(
            watch,
            &format!("WEB-DELIVERED {k} → {node} ({title}) — agent-dashboard"),
        );
        let _ = fs::remove_file(path);
        sent += 1;
    }
    Ok(json!({"sent":sent,"waiting":waiting}))
}
