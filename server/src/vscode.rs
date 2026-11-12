use crate::{app::App, core::*, http::local, sessions::rx};
use axum::{
    body::{Body, to_bytes},
    extract::Request,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use serde_json::json;
use sha1::{Digest, Sha1};
use std::{
    fs,
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::Duration,
};
const CODE: &str = "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";
pub fn socket(app: &App) -> PathBuf {
    let data = app.config.data.join("vscode-web");
    let hash = format!("{:x}", Sha1::digest(data.to_string_lossy().as_bytes()));
    std::env::temp_dir().join(format!("adash-vscode-web-{}.sock", &hash[..10]))
}
pub fn base(app: &App) -> Result<String> {
    use std::os::unix::fs::PermissionsExt;
    let d = app.config.data.join("vscode-web");
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    fs::set_permissions(&d, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    let p = d.join("secret");
    if let Ok(s) = fs::read_to_string(&p) {
        let s = s.trim();
        if rx(r"^[A-Za-z0-9_-]{20,}$").is_match(s) {
            return Ok(format!("/vscode/{s}"));
        }
    }
    let secret = uuid::Uuid::new_v4().simple().to_string()
        + &uuid::Uuid::new_v4().simple().to_string()[..16];
    fs::write(&p, &secret)
        .and_then(|_| fs::set_permissions(&p, fs::Permissions::from_mode(0o600)))
        .map_err(|e| e.to_string())?;
    Ok(format!("/vscode/{secret}"))
}
pub fn url(app: &App, path: &str) -> String {
    format!("{}/?folder={path}", base(app).unwrap_or_default())
}
pub fn ensure(app: &App) -> Result<()> {
    static START: OnceLock<Mutex<()>> = OnceLock::new();
    let _guard = START.get_or_init(Default::default).lock().unwrap();
    let sock = socket(app);
    if std::os::unix::net::UnixStream::connect(&sock).is_ok() {
        return Ok(());
    }
    if !std::path::Path::new(CODE).exists() {
        return Err(format!("VS Code 가 설치돼 있지 않습니다 ({CODE})"));
    }
    let b = base(app)?;
    let d = app.config.data.join("vscode-web");
    let machine = d.join("data/Machine");
    fs::create_dir_all(&machine).map_err(|e| e.to_string())?;
    let mut settings = read_json(machine.join("settings.json"));
    if !settings.is_object() {
        settings = obj();
    }
    merge(
        &mut settings,
        &json!({"files.readonlyInclude":{"**":true},"workbench.startupEditor":"none","chat.disableAIFeatures":true,"workbench.secondarySideBar.defaultVisibility":"hidden"}),
    );
    save_json(machine.join("settings.json"), &settings)?;
    let _ = fs::remove_file(&sock);
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(d.join("serve-web.log"))
        .map_err(|e| e.to_string())?;
    let mut child = std::process::Command::new(CODE)
        .args([
            "serve-web",
            "--socket-path",
            sock.to_str().unwrap_or(""),
            "--without-connection-token",
            "--accept-server-license-terms",
            "--server-base-path",
            &b,
            "--server-data-dir",
            d.to_str().unwrap_or(""),
            "--disable-telemetry",
        ])
        .env("VSCODE_RECONNECTION_GRACE_TIME", "300000")
        .stdin(std::process::Stdio::null())
        .stdout(log.try_clone().map_err(|e| e.to_string())?)
        .stderr(log)
        .spawn()
        .map_err(|e| e.to_string())?;
    let end = now() + 90.;
    loop {
        if std::os::unix::net::UnixStream::connect(&sock).is_ok() {
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            return Ok(());
        }
        if let Some(code) = child.try_wait().map_err(|e| e.to_string())? {
            return Err(format!(
                "serve-web 이 종료됨 ({code}) — {}",
                d.join("serve-web.log").display()
            ));
        }
        if now() > end {
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            return Err("serve-web 이 90초 안에 뜨지 않았습니다".into());
        }
        std::thread::sleep(Duration::from_millis(500));
    }
}
fn error(code: StatusCode, msg: &str) -> Response {
    (code, axum::Json(json!({"error":msg}))).into_response()
}
pub async fn proxy(app: &App, mut request: Request) -> Response {
    if !local(request.headers()) {
        return error(
            StatusCode::FORBIDDEN,
            "웹 VS Code 는 이 맥에서 연 화면에서만 됩니다",
        );
    }
    let app2 = app.clone();
    let b = match tokio::task::spawn_blocking(move || base(&app2)).await {
        Ok(Ok(b)) => b,
        _ => return error(StatusCode::INTERNAL_SERVER_ERROR, "secret error"),
    };
    let path = request.uri().path().to_owned();
    if path != b && !path.starts_with(&(b.clone() + "/")) {
        return error(StatusCode::NOT_FOUND, "not found");
    }
    let stream = match tokio::net::UnixStream::connect(socket(app)).await {
        Ok(s) => s,
        Err(_) => {
            return error(
                StatusCode::BAD_GATEWAY,
                "웹 VS Code 가 떠 있지 않습니다. 대시보드에서 다시 여세요",
            );
        }
    };
    let upgrade = request
        .headers()
        .get(header::UPGRADE)
        .is_some_and(|v| v == "websocket");
    let on_client = upgrade.then(|| hyper::upgrade::on(&mut request));
    let page = request.method() == "GET" && (path == b || path == b.clone() + "/");
    let theme = request
        .uri()
        .query()
        .unwrap_or("")
        .split('&')
        .find_map(|q| q.strip_prefix("theme="))
        .filter(|s| ["light", "dark"].contains(s))
        .map(str::to_owned);
    for k in [
        "connection",
        "keep-alive",
        "proxy-connection",
        "te",
        "trailer",
        "accept-language",
    ] {
        request.headers_mut().remove(k);
    }
    request
        .headers_mut()
        .insert("accept-language", "en".parse().unwrap());
    if upgrade {
        request
            .headers_mut()
            .insert(header::CONNECTION, "Upgrade".parse().unwrap());
    } else {
        request
            .headers_mut()
            .insert(header::CONNECTION, "close".parse().unwrap());
    }
    if page {
        request.headers_mut().remove(header::ACCEPT_ENCODING);
    }
    let (mut sender, conn) =
        match hyper::client::conn::http1::handshake(hyper_util::rt::TokioIo::new(stream)).await {
            Ok(c) => c,
            Err(_) => return error(StatusCode::BAD_GATEWAY, "VS Code 연결 실패"),
        };
    tokio::spawn(async move {
        let _ = conn.with_upgrades().await;
    });
    let mut upstream = match sender.send_request(request).await {
        Ok(r) => r,
        Err(_) => return error(StatusCode::BAD_GATEWAY, "VS Code 응답 실패"),
    };
    if upgrade && upstream.status() == StatusCode::SWITCHING_PROTOCOLS {
        let on_upstream = hyper::upgrade::on(&mut upstream);
        tokio::spawn(async move {
            if let (Ok(client), Ok(server)) = (on_client.unwrap().await, on_upstream.await) {
                let mut a = hyper_util::rt::TokioIo::new(client);
                let mut b = hyper_util::rt::TokioIo::new(server);
                let _ = tokio::io::copy_bidirectional(&mut a, &mut b).await;
            }
        });
    }
    let (parts, body) = upstream.into_parts();
    let mut response = Response::from_parts(parts, Body::new(body));
    response.headers_mut().remove("x-frame-options");
    if let Some(csp) = response
        .headers()
        .get(header::CONTENT_SECURITY_POLICY)
        .and_then(|v| v.to_str().ok())
    {
        let csp = csp
            .split(';')
            .filter(|s| !s.trim().to_lowercase().starts_with("frame-ancestors"))
            .collect::<Vec<_>>()
            .join(";");
        if let Ok(v) = csp.parse() {
            response
                .headers_mut()
                .insert(header::CONTENT_SECURITY_POLICY, v);
        }
    }
    let cookies = response
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .map(|s| {
            format!(
                "{}; SameSite=None; Secure; Partitioned",
                rx(r"(?i);\s*SameSite=\w+").replace_all(s, "")
            )
        })
        .collect::<Vec<_>>();
    response.headers_mut().remove(header::SET_COOKIE);
    for c in cookies {
        if let Ok(v) = c.parse() {
            response.headers_mut().append(header::SET_COOKIE, v);
        }
    }
    if page && response.status() == StatusCode::OK {
        let (parts, body) = response.into_parts();
        let bytes = match to_bytes(body, 32 << 20).await {
            Ok(b) => b,
            Err(_) => return error(StatusCode::BAD_GATEWAY, "workbench page too large"),
        };
        let page = String::from_utf8_lossy(&bytes);
        let modified = rx(r#"(id="vscode-workbench-web-configuration" data-settings=")([^"]*)""#)
            .replacen(&page, 1, |c: &regex::Captures| {
                let raw = html_escape::decode_html_entities(&c[2]);
                let mut d =
                    serde_json::from_str::<serde_json::Value>(&raw).unwrap_or_else(|_| obj());
                if !d["configurationDefaults"].is_object() {
                    d["configurationDefaults"] = obj();
                }
                d["configurationDefaults"]["security.workspace.trust.enabled"] = json!(false);
                if let Some(theme) = &theme {
                    d["configurationDefaults"]["workbench.colorTheme"] =
                        json!(if theme == "light" {
                            "Default Light Modern"
                        } else {
                            "Default Dark Modern"
                        });
                    d["configurationDefaults"]["window.autoDetectColorScheme"] = json!(false);
                }
                format!(
                    "{}{}\"",
                    &c[1],
                    html_escape::encode_double_quoted_attribute(&d.to_string())
                )
            })
            .into_owned();
        response = Response::from_parts(parts, Body::from(modified.clone()));
        response.headers_mut().remove(header::TRANSFER_ENCODING);
        response.headers_mut().insert(
            header::CONTENT_LENGTH,
            modified.len().to_string().parse().unwrap(),
        );
    }
    response
}
