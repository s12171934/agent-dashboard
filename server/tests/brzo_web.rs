//! `brzo_web::flush` against a fake Brzo 「웹 접속」: the websocket `hello`, `/api/invoke` and the outbox rules.
use agent_dashboard::brzo_web;
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    sync::{Arc, Mutex},
};

const TOKEN: &str = "ab12";

/// Answers the websocket upgrade with a `hello` and every `/api/invoke` from `nodes`; records the calls it got.
fn fake(nodes: Value) -> (String, Arc<Mutex<Vec<Value>>>) {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = l.local_addr().unwrap().to_string();
    let calls = Arc::new(Mutex::new(vec![]));
    let log = calls.clone();
    std::thread::spawn(move || {
        for s in l.incoming().flatten() {
            let nodes = nodes.clone();
            let log = log.clone();
            std::thread::spawn(move || serve(s, &nodes, &log));
        }
    });
    (addr, calls)
}
fn serve(mut s: TcpStream, nodes: &Value, log: &Mutex<Vec<Value>>) {
    let mut r = BufReader::new(s.try_clone().unwrap());
    let mut head = vec![];
    loop {
        let mut ln = String::new();
        if r.read_line(&mut ln).unwrap_or(0) == 0 || ln == "\r\n" {
            break;
        }
        head.push(ln.trim_end().to_owned());
    }
    let has = |h: &str| head.iter().any(|l| l.to_ascii_lowercase().starts_with(h));
    if !head
        .iter()
        .any(|l| l.eq_ignore_ascii_case(&format!("Cookie: cb_web={TOKEN}")))
    {
        let _ = s.write_all(b"HTTP/1.1 401 No\r\nContent-Length: 0\r\n\r\n");
        return;
    }
    if head[0].starts_with("GET /api/events") && has("upgrade: websocket") {
        let _ = s.write_all(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
        let msg = br#"{"type":"hello","clientId":"42"}"#;
        let mut f = vec![0x81, msg.len() as u8];
        f.extend_from_slice(msg);
        let _ = s.write_all(&f);
        std::thread::sleep(std::time::Duration::from_secs(5));
        return;
    }
    let len = head
        .iter()
        .find_map(|l| {
            l.to_ascii_lowercase()
                .strip_prefix("content-length: ")
                .map(|n| n.parse::<usize>().unwrap())
        })
        .unwrap_or(0);
    let mut body = vec![0; len];
    r.read_exact(&mut body).unwrap();
    let call: Value = serde_json::from_slice(&body).unwrap();
    assert!(
        head.iter()
            .any(|l| l.eq_ignore_ascii_case("x-cb-client: 42")),
        "client id header"
    );
    let result = match call["channel"].as_str().unwrap() {
        "brzo:getState" => json!({"nodes":nodes}),
        _ => Value::Null,
    };
    log.lock().unwrap().push(call);
    let out = json!({"ok":true,"result":result}).to_string();
    let _ = write!(
        s,
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{out}",
        out.len()
    );
}
fn epic(dir: &std::path::Path) {
    for (k, node) in [("QA-1", "n_idle"), ("QA-2", "n_ask"), ("QA-3", "")] {
        fs::create_dir_all(dir.join("tickets")).unwrap();
        let coord = if node.is_empty() {
            Value::Null
        } else {
            json!({"handle":node})
        };
        fs::write(
            dir.join("tickets").join(format!("{k}.json")),
            json!({"key":k,"backend":"brzo","coordinator":coord}).to_string(),
        )
        .unwrap();
    }
    fs::create_dir_all(dir.join("outbox")).unwrap();
    for (i, k) in ["QA-1", "QA-2", "QA-3"].iter().enumerate() {
        fs::write(
            dir.join("outbox").join(format!("{i}-{k}.json")),
            json!({"to":"@coordinator","text":format!("{k} 반출\n승인"),"subject":format!("{k} 반출"),"key":k,"sender":"dante"}).to_string(),
        )
        .unwrap();
    }
    fs::write(
        dir.join("outbox").join("9-other.json"),
        json!({"to":"n_x","text":"hi","key":"QA-1"}).to_string(),
    )
    .unwrap();
}

#[test]
fn flush_types_into_idle_coordinators_and_leaves_the_rest_queued() {
    let home = tempfile::tempdir().unwrap();
    fs::write(home.path().join("web-access-token"), format!("{TOKEN}\n")).unwrap();
    let (addr, calls) = fake(json!([
        {"id":"n_idle","mainHandle":"pty_1","state":"done"},
        {"id":"n_ask","mainHandle":"pty_2","state":"waiting"},
    ]));
    // SAFETY: this test binary's only test sets them before any thread reads the environment.
    unsafe {
        std::env::set_var("ADASH_BRZO_WEB", &addr);
        std::env::set_var("BRZO_HOME", home.path());
    }
    let watch = tempfile::tempdir().unwrap();
    epic(watch.path());

    // one ticket only
    let r = brzo_web::flush(watch.path(), "QA-0", Some("QA-1")).unwrap();
    assert_eq!(r["sent"], 1);
    let inputs = calls
        .lock()
        .unwrap()
        .iter()
        .filter(|c| c["channel"] == "brzo:sendInput")
        .map(|c| c["args"].clone())
        .collect::<Vec<_>>();
    assert_eq!(
        inputs,
        vec![json!(["pty_1", "QA-1 반출 승인"]), json!(["pty_1", "\r"])]
    );
    let left = brzo_web::queued(watch.path(), None);
    assert_eq!(
        left.len(),
        2,
        "QA-2·QA-3 stay; the message to another agent is not a coordinator's"
    );
    assert!(watch.path().join("outbox").join("9-other.json").exists());
    let tell = fs::read_to_string(watch.path().join("log").join("tell.jsonl")).unwrap();
    let rec: Value = serde_json::from_str(tell.lines().next().unwrap()).unwrap();
    assert_eq!(
        (
            rec["to"].as_str(),
            rec["via"].as_str(),
            rec["from"].as_str()
        ),
        (Some("n_idle"), Some("brzo-web"), Some("dante"))
    );

    // the rest: one waits on a question, one has no coordinator on record
    calls.lock().unwrap().clear();
    let r = brzo_web::flush(watch.path(), "QA-0", None).unwrap();
    assert_eq!(r["sent"], 0);
    let why = r["waiting"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w["key"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert_eq!(why, ["QA-2", "QA-3"]);
    assert!(
        !calls
            .lock()
            .unwrap()
            .iter()
            .any(|c| c["channel"] == "brzo:sendInput"),
        "nothing typed into a dialog"
    );
    assert_eq!(brzo_web::queued(watch.path(), None).len(), 2);
    let log = fs::read_dir(watch.path().join("log"))
        .unwrap()
        .flatten()
        .find(|e| e.path().extension().is_some_and(|x| x == "log"))
        .unwrap();
    let log = fs::read_to_string(log.path()).unwrap();
    assert!(log.contains("WEB-DELIVERED QA-1 → n_idle (반출)"), "{log}");
    assert!(log.contains("WEB-WAIT QA-2 → n_ask"), "{log}");

    // a wrong token is refused, and nothing is removed
    fs::write(home.path().join("web-access-token"), "zz99").unwrap();
    assert!(
        brzo_web::flush(watch.path(), "QA-0", None)
            .unwrap_err()
            .contains("거부")
    );
    assert_eq!(brzo_web::queued(watch.path(), None).len(), 2);
}
