use crate::{app::App, core::*};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    sync::{Mutex, OnceLock},
    time::Duration,
};
struct Token {
    source: String,
    token: String,
    exp: Option<f64>,
    who: Value,
    account: String,
}
#[derive(Default)]
struct Control {
    profiles: HashMap<String, Value>,
    next: HashMap<String, f64>,
    backoff: HashMap<String, f64>,
}
fn jwt(tok: &str) -> Value {
    tok.split('.')
        .nth(1)
        .and_then(|s| URL_SAFE_NO_PAD.decode(s.trim_end_matches('=')).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_else(obj)
}
fn keychain(service: &str, acct: Option<&str>) -> Value {
    let mut a = vec!["find-generic-password", "-s", service];
    if let Some(acct) = acct {
        a.extend(["-a", acct]);
    }
    a.push("-w");
    command("security", &a, None, 10)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null)
}
fn plan(s: &str) -> String {
    match s {
        "claude_team" => "Team",
        "claude_enterprise" => "Enterprise",
        "claude_max" => "Max",
        "claude_pro" => "Pro",
        _ => s,
    }
    .into()
}
fn tokens() -> Vec<(String, Token)> {
    let mut out = vec![];
    for (source, d) in [
        ("keychain", keychain("Claude Code-credentials", None)),
        (
            "credentials.json",
            read_json(home().join(".claude/.credentials.json")),
        ),
    ] {
        let o = &d["claudeAiOauth"];
        if o["accessToken"].is_string() {
            out.push((
                "claude".into(),
                Token {
                    source: source.into(),
                    token: text(&o["accessToken"]).into(),
                    exp: o["expiresAt"].as_f64().map(|n| n / 1000.),
                    who: Value::Null,
                    account: String::new(),
                },
            ));
        }
    }
    let root = home().join("Library/Application Support/orca");
    if let Ok(ds) = fs::read_dir(root.join("claude-accounts")) {
        for d in ds.flatten() {
            let acct = read_json(d.path().join("auth/oauth-account.json"));
            if !acct["accountUuid"].is_string() {
                continue;
            }
            let o = keychain(
                "Orca Claude Code Managed Credentials",
                d.file_name().to_str(),
            );
            let o = &o["claudeAiOauth"];
            out.push(("claude".into(),Token{source:"orca".into(),token:text(&o["accessToken"]).into(),exp:o["expiresAt"].as_f64().map(|n|n/1000.),who:json!({"uuid":acct["accountUuid"],"email":acct["emailAddress"],"plan":plan(text(&acct["organizationType"]))}),account:String::new()}));
        }
    }
    let mut paths = vec![("~/.codex", home().join(".codex/auth.json"))];
    if let Ok(ds) = fs::read_dir(root.join("codex-accounts")) {
        for d in ds.flatten() {
            paths.push(("orca", d.path().join("home/auth.json")));
        }
    }
    for (source, p) in paths {
        let d = read_json(p);
        let t = &d["tokens"];
        if !t["access_token"].is_string() || !t["account_id"].is_string() {
            continue;
        }
        let c = jwt(text(&t["id_token"]));
        let cp = text(&c["https://api.openai.com/auth"]["chatgpt_plan_type"])
            .trim_start_matches("self_serve_")
            .replace('_', " ");
        out.push((
            "codex".into(),
            Token {
                source: source.into(),
                token: text(&t["access_token"]).into(),
                exp: jwt(text(&t["access_token"]))["exp"].as_f64(),
                who: json!({"uuid":t["account_id"],"email":c["email"],"plan":cp}),
                account: text(&t["account_id"]).into(),
            },
        ));
    }
    out
}
pub fn claude_usage(raw: &Value) -> (Value, Value) {
    let limits=array(&raw["limits"]).iter().map(|b|{let kind=text(&b["kind"]);let name=match kind{"session"=>"5시간 세션","weekly_all"=>"주간 전체","weekly_scoped"=>"주간",_=>kind};let model=text(&b["scope"]["model"]["display_name"]);json!({"kind":kind,"name":if model.is_empty(){name.into()}else{format!("{name} · {model}")},"percent":b["percent"],"active":b["is_active"]==true,"resets_at":epoch(text(&b["resets_at"]))})}).collect::<Vec<_>>();
    let ex = &raw["extra_usage"];
    let cents = |v: &Value| v.as_f64().map(|v| (v / 100. * 100.).round() / 100.);
    let extra = if ex.is_object() {
        json!({"used_usd":cents(&ex["used_credits"]),"limit_usd":cents(&ex["monthly_limit"]),"reached":ex["spend_limit_reached"]==true})
    } else {
        Value::Null
    };
    (json!(limits), extra)
}
pub fn codex_usage(raw: &Value) -> (Value, Value) {
    let window = |sec: f64| {
        if sec == 18000. {
            "5시간".into()
        } else if sec == 604800. {
            "주간".into()
        } else if sec > 0. {
            format!("{}시간", (sec / 3600.).round())
        } else {
            "?".into()
        }
    };
    let mut limits = vec![];
    for k in ["primary_window", "secondary_window"] {
        let w = &raw["rate_limit"][k];
        if w.is_object() {
            limits.push(json!({"kind":k,"name":window(number(&w["limit_window_seconds"])),"percent":w["used_percent"],"active":raw["rate_limit"]["limit_reached"]==true,"resets_at":w["reset_at"]}));
        }
    }
    for extra in array(&raw["additional_rate_limits"]) {
        for k in ["primary_window", "secondary_window"] {
            let w = &extra["rate_limit"][k];
            if w.is_object() {
                limits.push(json!({"kind":k,"name":format!("{} · {}",window(number(&w["limit_window_seconds"])),extra["limit_name"].as_str().unwrap_or("?")),"percent":w["used_percent"],"active":false,"resets_at":w["reset_at"]}));
            }
        }
    }
    let cr = &raw["credits"];
    let credits = if cr.is_object() {
        json!({"has":cr["has_credits"]==true,"unlimited":cr["unlimited"]==true,"balance":cr["balance"],"reached":cr["overage_limit_reached"]==true})
    } else {
        Value::Null
    };
    (json!(limits), credits)
}
pub fn collect(app: &App) -> Result<()> {
    static CONTROL: OnceLock<Mutex<Control>> = OnceLock::new();
    let mut ctl = CONTROL.get_or_init(Default::default).lock().unwrap();
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let prev = read_json(app.config.data.join("plan-usage.json"));
    let mut grouped: HashMap<String, (String, Value, Vec<Token>)> = HashMap::new();
    for (provider, mut t) in tokens() {
        if t.who.is_null() {
            if t.exp.is_some_and(|n| n <= now()) {
                continue;
            }
            let h = format!("{:x}", Sha256::digest(t.token.as_bytes()));
            if !ctl.profiles.contains_key(&h) {
                let p = client
                    .get("https://api.anthropic.com/api/oauth/profile")
                    .bearer_auth(&t.token)
                    .header("anthropic-beta", "oauth-2025-04-20")
                    .send();
                let Ok(p) = p else { continue };
                if !p.status().is_success() {
                    continue;
                }
                let Ok(p) = p.json::<Value>() else { continue };
                ctl.profiles.insert(h.clone(),json!({"uuid":p["account"]["uuid"],"email":p["account"]["email"],"plan":plan(text(&p["organization"]["organization_type"]))}));
            }
            t.who = ctl.profiles[&h].clone();
        }
        let id = text(&t.who["uuid"]);
        if id.is_empty() {
            continue;
        }
        let key = format!("{provider}:{id}");
        grouped
            .entry(key)
            .or_insert_with(|| (provider, t.who.clone(), vec![]))
            .2
            .push(t);
    }
    let mut cards = obj();
    for (key, (provider, who, tokens)) in grouped {
        let old = &prev[&key];
        let mut c = if old.is_object() { old.clone() } else { obj() };
        merge(
            &mut c,
            &json!({"key":key,"provider":provider,"note":null,"stale":old["at"].is_number()}),
        );
        for f in ["email", "plan"] {
            if who[f].is_string() {
                c[f] = who[f].clone();
            }
        }
        let token = tokens
            .into_iter()
            .find(|t| !t.token.is_empty() && t.exp.is_none_or(|n| n > now()));
        let Some(t) = token else {
            c["note"] = json!("토큰 만료 — 이 계정으로 로그인하면 다시 읽힙니다");
            cards[&key] = c;
            continue;
        };
        let next = *ctl
            .next
            .entry(key.clone())
            .or_insert(number(&c["checked"]) + 300.);
        if now() < next {
            c["stale"] = json!(c["error"].is_string());
            cards[&key] = c;
            continue;
        }
        ctl.next.insert(key.clone(), now() + 300.);
        c["checked"] = json!(now());
        c["source"] = json!(t.source);
        let req = if provider == "claude" {
            client
                .get("https://api.anthropic.com/api/oauth/usage")
                .bearer_auth(&t.token)
                .header("anthropic-beta", "oauth-2025-04-20")
        } else {
            client
                .get("https://chatgpt.com/backend-api/wham/usage")
                .bearer_auth(&t.token)
                .header("ChatGPT-Account-Id", t.account)
                .header("User-Agent", "codex-cli")
        };
        match req.send() {
            Ok(r) if r.status().is_success() => match r.json::<Value>() {
                Ok(raw) => {
                    let (limits, extra) = if provider == "claude" {
                        claude_usage(&raw)
                    } else {
                        codex_usage(&raw)
                    };
                    c["limits"] = limits;
                    c[if provider == "claude" {
                        "extra"
                    } else {
                        "credits"
                    }] = extra;
                    merge(&mut c, &json!({"at":now(),"error":null,"stale":false}));
                    ctl.backoff.remove(&key);
                }
                Err(_) => c["error"] = json!("사용량 응답을 해석하지 못했습니다"),
            },
            Ok(r) => {
                let status = r.status().as_u16();
                if status == 401 || status == 429 {
                    let back = (ctl.backoff.get(&key).copied().unwrap_or(450.) * 2.).min(3600.);
                    let retry = r
                        .headers()
                        .get("retry-after")
                        .and_then(|v| v.to_str().ok())
                        .and_then(|s| s.parse::<f64>().ok())
                        .unwrap_or(0.);
                    ctl.next.insert(key.clone(), now() + back.max(retry));
                    ctl.backoff.insert(key.clone(), back);
                }
                c["error"] = json!(match status {
                    401 => "토큰 만료·폐기".into(),
                    403 => "권한 없음".into(),
                    429 => "요청 한도(잠시 뒤 다시)".into(),
                    _ => format!("HTTP {status}"),
                });
                c["stale"] = json!(c["at"].is_number());
            }
            Err(_) => {
                c["error"] = json!("사용량 API 에 연결하지 못했습니다");
                c["stale"] = json!(c["at"].is_number());
            }
        }
        cards[&key] = c;
    }
    for (key, old) in prev.as_object().into_iter().flat_map(|m| m.iter()) {
        if cards.get(key).is_none() {
            let mut c = old.clone();
            merge(
                &mut c,
                &json!({"stale":true,"note":"이 Mac 에서 토큰을 찾지 못함"}),
            );
            cards[key] = c;
        }
    }
    save_json(app.config.data.join("plan-usage.json"), &cards)?;
    let mut accounts = cards
        .as_object()
        .unwrap()
        .values()
        .cloned()
        .collect::<Vec<_>>();
    accounts.sort_by(|a, b| {
        text(&a["provider"])
            .cmp(text(&b["provider"]))
            .then(text(&a["email"]).cmp(text(&b["email"])))
    });
    app.state.write().unwrap().plan_usage =
        json!({"available":!accounts.is_empty(),"accounts":accounts});
    Ok(())
}
