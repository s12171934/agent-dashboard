//! QA 미리보기 배포 상태 — 에픽 `config.env` 의 `QA_PREVIEW_URL`(PR 미리보기 제어 서버, 예: control.preview)의
//! 목록 조각 `/previews/rows` 를 읽어 그 에픽의 슬롯을 찾는다. 제어 서버는 로그인 뒤에만 열리므로 키체인의
//! generic password(서비스 = 제어 서버 호스트)로 `POST /login` 해 세션 쿠키를 들고 다니고, 401·로그인 화면으로
//! 돌려보내면 한 번 다시 로그인한다. 제어 서버에는 JSON API 가 없어서 화면이 5초마다 다시 받는 HTML 조각을 파싱한다.
use crate::{core::*, sessions::rx};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::Duration,
};

const ROWS_TTL: f64 = 15.;
const ERR_TTL: f64 = 60.;
const LOG_LINES: usize = 12;

fn client() -> Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())
}

fn host(base: &str) -> &str {
    base.split("://")
        .nth(1)
        .unwrap_or(base)
        .split('/')
        .next()
        .unwrap_or("")
}

/// (계정, 비밀번호) — 키체인 generic password, 서비스 이름 = 제어 서버 호스트.
fn credentials(base: &str) -> Result<(String, String)> {
    let h = host(base);
    let attrs =
        command("security", &["find-generic-password", "-s", h], None, 10).map_err(|_| {
            format!("키체인에 {h} 계정 없음 (security add-generic-password -s {h} -a <아이디> -w)")
        })?;
    let acct = rx(r#""acct"<blob>="([^"]*)""#)
        .captures(&attrs)
        .map(|c| c[1].to_owned())
        .unwrap_or_default();
    let pw = command(
        "security",
        &["find-generic-password", "-s", h, "-a", &acct, "-w"],
        None,
        10,
    )?;
    Ok((acct, pw.trim_end_matches('\n').to_owned()))
}

fn session() -> &'static Mutex<HashMap<String, String>> {
    static S: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    S.get_or_init(Default::default)
}

fn login(base: &str) -> Result<String> {
    let (user, pw) = credentials(base)?;
    // 제어 서버는 Origin 이 자기 자신이 아닌 로그인 POST 를 403 으로 거절한다.
    let r = client()?
        .post(format!("{base}/login"))
        .header("Origin", base)
        .header("Referer", format!("{base}/login"))
        .form(&[("username", user.as_str()), ("password", pw.as_str())])
        .send()
        .map_err(|e| format!("미리보기 로그인: {e}"))?;
    let cookie = r
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .filter_map(|v| v.split(';').next())
        .find(|c| c.contains('='))
        .map(str::to_owned);
    match cookie {
        Some(c) if r.status().is_redirection() || r.status().is_success() => {
            session().lock().unwrap().insert(base.into(), c.clone());
            Ok(c)
        }
        _ => Err(format!(
            "미리보기 로그인 실패 (HTTP {})",
            r.status().as_u16()
        )),
    }
}

/// 로그인한 GET. 쿠키가 없거나 거절되면(401, 로그인 화면으로 303) 한 번 다시 로그인한다.
fn get(base: &str, path: &str) -> Result<String> {
    let c = client()?;
    let mut cookie = session().lock().unwrap().get(base).cloned();
    for attempt in 0..2 {
        let ck = match cookie.take() {
            Some(c) => c,
            None => login(base)?,
        };
        let r = c
            .get(format!("{base}{path}"))
            .header("Cookie", &ck)
            .send()
            .map_err(|e| format!("미리보기 {path}: {e}"))?;
        let s = r.status();
        if s.is_success() {
            return r.text().map_err(|e| e.to_string());
        }
        if (s.as_u16() == 401 || s.is_redirection()) && attempt == 0 {
            session().lock().unwrap().remove(base);
            continue;
        }
        return Err(format!("미리보기 {path}: HTTP {}", s.as_u16()));
    }
    Err(format!("미리보기 {path}: 로그인 뒤에도 거절"))
}

fn plain(s: &str) -> String {
    let t = rx(r"<[^>]+>").replace_all(s, " ");
    let t = html_escape::decode_html_entities(&t);
    t.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `/previews/rows` 조각 → 슬롯 카드 목록.
pub fn parse_rows(page: &str) -> Vec<Value> {
    page.split(r#"<section class="preview-card"#)
        .skip(1)
        .map(|chunk| {
            let cap = |re: &str| {
                rx(re)
                    .captures(chunk)
                    .map(|c| plain(&c[1]))
                    .unwrap_or_default()
            };
            let refs = chunk
                .split(r#"<div class="ref">"#)
                .skip(1)
                .map(|r| {
                    let get = |re: &str| rx(re).captures(r).map(|c| c[1].to_owned());
                    json!({
                        "app": get(r#"class="ref-app">(?s)(.*?)</div>"#).map(|s| plain(&rx(r"<small>.*?</small>").replace(&s, ""))),
                        "repo": get(r"<small>([^<]*)</small>").map(|s| plain(&s)),
                        "title": get(r#"class="ref-title">(?s)(.*?)</div>"#).map(|s| plain(&s)),
                        "url": get(r#"class="ref-url" href="([^"]+)""#).map(|s| html_escape::decode_html_entities(&s).into_owned()),
                    })
                })
                .collect::<Vec<_>>();
            let urls = rx(r#"class="endpoint" href="([^"]+)"[^>]*>\s*<span>([^<]*)</span>"#)
                .captures_iter(chunk)
                .map(|c| json!({"label": plain(&c[2]), "url": html_escape::decode_html_entities(&c[1])}))
                .collect::<Vec<_>>();
            json!({
                "slot": cap(r#"class="slot">\s*#(\d+)"#).parse::<u64>().ok(),
                "tone": cap(r#"^\s*tone-([\w-]+)"#),
                "state": cap(r#"<span class="state ([\w-]+)""#),
                "label": cap(r#"<span class="state [\w-]+">([^<]*)</span>"#),
                "detail": cap(r#"<span class="detail">([^<]*)</span>"#),
                "refs": refs,
                "urls": urls,
            })
        })
        .collect()
}

type Cache = Mutex<HashMap<String, (f64, Result<Value>)>>;

fn cached(key: String, ttl: f64, f: impl FnOnce() -> Result<Value>) -> Result<Value> {
    static C: OnceLock<Cache> = OnceLock::new();
    let c = C.get_or_init(Default::default);
    if let Some((_, v)) = c
        .lock()
        .unwrap()
        .get(&key)
        .filter(|(t, v)| now() - t < if v.is_ok() { ttl } else { ERR_TTL })
    {
        return v.clone();
    }
    let v = f();
    c.lock().unwrap().insert(key, (now(), v.clone()));
    v
}

fn log_tail(base: &str, slot: u64) -> Value {
    cached(format!("log:{base}:{slot}"), ROWS_TTL, || {
        let page = get(base, &format!("/previews/{slot}/log"))?;
        let body = rx(r"(?s)<pre[^>]*>(.*?)</pre>")
            .captures(&page)
            .map(|c| c[1].to_owned())
            .unwrap_or(page);
        let text =
            html_escape::decode_html_entities(&rx(r"<[^>]+>").replace_all(&body, "")).into_owned();
        let lines = text
            .lines()
            .filter(|l| !l.trim().is_empty())
            .collect::<Vec<_>>();
        Ok(json!(lines[lines.len().saturating_sub(LOG_LINES)..]))
    })
    .unwrap_or(Value::Null)
}

/// 묶음의 미리보기: `config.env` `QA_PREVIEW_URL` 의 제어 서버에서 PR 참조가 모두 에픽 PR(`epic.json` `qa.*.pr_url`)인
/// 슬롯을 찾고, 없으면 `epic.json` `preview.slot` 의 슬롯을 쓴다(그 슬롯의 PR 이 에픽 PR 과 다르면 `stale`).
/// 제어 서버를 못 읽으면 `epic.json` 의 슬롯·주소에 `error` 를 붙여 돌려준다. 둘 다 없으면 null.
pub fn for_set(base: &str, epic_json: &Value) -> Value {
    let base = base.trim().trim_end_matches('/');
    let rec = &epic_json["preview"];
    if base.is_empty() && !rec.is_object() {
        return Value::Null;
    }
    let want = epic_json["qa"]
        .as_object()
        .map(|q| {
            q.values()
                .filter_map(|e| e["pr_url"].as_str())
                .map(|u| u.trim_end_matches('/').to_lowercase())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let fallback = |error: Value| {
        json!({"slot": rec["slot"], "base": base, "state": null, "label": null, "detail": null,
               "urls": array(&rec["urls"]).iter().map(|u| json!({"label": host(text(u)).split('-').next().unwrap_or(""), "url": u})).collect::<Vec<_>>(),
               "refs": [], "log": null, "stale": false, "error": error, "at": iso()})
    };
    if base.is_empty() {
        return fallback(json!("config.env 에 QA_PREVIEW_URL 없음"));
    }
    let cards = match cached(format!("rows:{base}"), ROWS_TTL, || {
        Ok(json!(parse_rows(&get(base, "/previews/rows")?)))
    }) {
        Ok(c) => c,
        Err(e) => {
            return if rec.is_object() {
                fallback(json!(e))
            } else {
                Value::Null
            };
        }
    };
    let refs_of = |c: &Value| {
        array(&c["refs"])
            .iter()
            .filter_map(|r| r["url"].as_str())
            .map(|u| u.trim_end_matches('/').to_lowercase())
            .collect::<Vec<_>>()
    };
    // 에픽 PR 에는 미리보기에 들어가지 않는 서브모듈(테스트 자동화 등)도 있으므로, 카드의 PR 참조가 모두
    // 에픽 PR 이면 그 에픽의 미리보기로 본다.
    let matches = |c: &Value| {
        let prs = refs_of(c)
            .into_iter()
            .filter(|h| h.contains("/pull/"))
            .collect::<Vec<_>>();
        !prs.is_empty() && prs.iter().all(|h| want.contains(h))
    };
    let by_pr = array(&cards).iter().find(|c| matches(c));
    let card = by_pr.or_else(|| {
        array(&cards)
            .iter()
            .find(|c| rec["slot"].as_u64().is_some() && c["slot"] == rec["slot"])
    });
    let Some(card) = card else {
        return if rec.is_object() {
            fallback(json!(format!(
                "제어 서버에 #{} 슬롯이 없음 (삭제됨?)",
                rec["slot"]
            )))
        } else {
            Value::Null
        };
    };
    let mut p = card.clone();
    let quiet = matches!(text(&p["state"]), "on" | "off");
    p["log"] = match p["slot"].as_u64() {
        Some(slot) if !quiet => log_tail(base, slot),
        _ => Value::Null,
    };
    p["base"] = json!(base);
    p["stale"] = json!(by_pr.is_none() && !want.is_empty());
    p["error"] = Value::Null;
    p["at"] = json!(iso());
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROWS: &str = r#"<section class="preview-card tone-on">
    <header><div class="slot">#1</div>
      <div class="state-box"><span class="state on">켜짐</span></div></header>
    <div class="refs"><div class="ref">
    <div class="ref-app"><span class="app-dot app-rails"></span>서버<small>plang_rails</small></div>
    <div class="ref-target"><div class="ref-title"><span class="badge neutral">브랜치</span> <b>develop</b> </div>
      <a class="ref-url" href="https://github.com/o/plang_rails/tree/develop" target="_blank">x</a></div>
  </div></div>
    <footer class="endpoints"><a class="endpoint" href="https://teacher-1.example" target="_blank"><span>대시보드</span>teacher-1</a></footer>
  </section><section class="preview-card tone-busy">
    <header><div class="slot">#2</div>
      <div class="state-box"><span class="state busy">빌드 중</span><span class="detail">8초째</span></div></header>
    <div class="refs"><div class="ref">
    <div class="ref-app"><span class="app-dot"></span>서버<small>plang_rails</small></div>
    <div class="ref-target"><div class="ref-title">PR #2577 [PSQ-1265] QA &amp; 옵션</div>
      <a class="ref-url" href="https://github.com/o/plang_rails/pull/2577" target="_blank">x</a></div>
  </div></div></section>"#;

    #[test]
    fn parses_cards() {
        let c = parse_rows(ROWS);
        assert_eq!(c.len(), 2);
        assert_eq!(c[0]["slot"], 1);
        assert_eq!(c[0]["state"], "on");
        assert_eq!(c[0]["label"], "켜짐");
        assert_eq!(c[0]["refs"][0]["app"], "서버");
        assert_eq!(c[0]["refs"][0]["repo"], "plang_rails");
        assert_eq!(c[0]["refs"][0]["title"], "브랜치 develop");
        assert_eq!(c[0]["urls"][0]["label"], "대시보드");
        assert_eq!(c[1]["tone"], "busy");
        assert_eq!(c[1]["detail"], "8초째");
        assert_eq!(c[1]["refs"][0]["title"], "PR #2577 [PSQ-1265] QA & 옵션");
        assert_eq!(
            c[1]["refs"][0]["url"],
            "https://github.com/o/plang_rails/pull/2577"
        );
    }
}
