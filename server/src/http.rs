use crate::{
    app::App,
    archive, chars,
    core::*,
    decisions, designs, glance, impl_progress, interactions, media, projects, review,
    sessions::{Session, rx},
    terminals, usage, vscode, worktrees,
};
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{Request, State},
    http::{HeaderMap, StatusCode, header},
    response::{
        IntoResponse, Response,
        sse::{Event, KeepAlive, Sse},
    },
};
use serde_json::{Value, json};
use std::{collections::HashMap, convert::Infallible, time::Duration};
use tokio_stream::{StreamExt, wrappers::BroadcastStream};

pub const API_VERSION: u64 = 1;

pub fn host(header: &str) -> String {
    let h = header.trim().to_lowercase();
    if let Some(s) = h.strip_prefix('[') {
        s.split(']').next().unwrap_or("").into()
    } else if h.matches(':').count() == 1 {
        h.split(':').next().unwrap_or("").into()
    } else {
        h
    }
}
pub fn host_allowed(h: &str, c: &Config) -> bool {
    let h = host(h);
    !h.is_empty()
        && (["127.0.0.1", "localhost", "::1"].contains(&h.as_str())
            || c.hosts.iter().any(|s| s.to_lowercase() == h)
            || !h.contains('.')
            || h.ends_with(".ts.net"))
}
pub fn origin_allowed(o: &str, c: &Config) -> bool {
    let o = o.trim_end_matches('/').to_lowercase();
    rx(r"^http://(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$").is_match(&o)
        || c.origins.iter().any(|allowed| {
            let a = allowed.trim_end_matches('/').to_lowercase();
            let Some((scheme, h)) = a.split_once("://") else {
                return false;
            };
            o == a || o.starts_with(&format!("{scheme}://")) && o.ends_with(&format!(".{h}"))
        })
}
pub fn local(h: &HeaderMap) -> bool {
    ["127.0.0.1", "localhost", "::1"]
        .contains(&host(h.get("host").and_then(|v| v.to_str().ok()).unwrap_or("")).as_str())
        && !h.contains_key("x-forwarded-for")
}
pub fn router(app: App) -> Router {
    Router::new()
        .fallback(handle)
        .layer(tower_http::compression::CompressionLayer::new().gzip(true))
        .with_state(app)
}
fn reply(code: u16, v: Value) -> Response {
    (
        StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        axum::Json(v),
    )
        .into_response()
}
fn json(v: Value) -> Response {
    reply(200, v)
}
fn err(code: u16, s: &str) -> Response {
    reply(code, json!({"error":s}))
}
fn query(s: &str) -> HashMap<String, Vec<String>> {
    let u = reqwest::Url::parse(&format!("http://localhost/?{s}")).unwrap();
    let mut m: HashMap<String, Vec<String>> = HashMap::new();
    for (k, v) in u.query_pairs() {
        m.entry(k.into_owned()).or_default().push(v.into_owned());
    }
    m
}
fn q<'a>(q: &'a HashMap<String, Vec<String>>, k: &str) -> &'a str {
    q.get(k)
        .and_then(|v| v.first())
        .map(String::as_str)
        .unwrap_or("")
}
async fn handle(State(app): State<App>, request: Request) -> Response {
    let headers = request.headers().clone();
    if !host_allowed(
        headers
            .get("host")
            .and_then(|v| v.to_str().ok())
            .unwrap_or(""),
        &app.config,
    ) {
        return err(403, "unknown host");
    }
    let origin = headers.get("origin").cloned();
    if origin
        .as_ref()
        .is_some_and(|v| !v.to_str().is_ok_and(|s| origin_allowed(s, &app.config)))
    {
        return err(403, "origin not allowed");
    }
    let method = request.method().as_str().to_owned();
    let path = request.uri().path().to_owned();
    let qs = query(request.uri().query().unwrap_or(""));
    let mut response = if method == "OPTIONS" {
        let mut r = StatusCode::NO_CONTENT.into_response();
        for (k, v) in [
            ("access-control-allow-methods", "GET, POST"),
            ("access-control-allow-headers", "Content-Type"),
            ("access-control-max-age", "600"),
        ] {
            r.headers_mut()
                .insert(axum::http::HeaderName::from_static(k), v.parse().unwrap());
        }
        if headers
            .get("access-control-request-private-network")
            .is_some_and(|v| v == "true")
        {
            r.headers_mut().insert(
                "access-control-allow-private-network",
                "true".parse().unwrap(),
            );
        }
        r
    } else if method == "GET" && path == "/events" {
        let version = app.state.read().unwrap().version;
        let initial = tokio_stream::iter(vec![Ok::<_, Infallible>(
            Event::default().data(version.to_string()),
        )]);
        let updates = BroadcastStream::new(app.events.subscribe()).filter_map(|r| {
            r.ok().map(|v| {
                Ok::<_, Infallible>(if let Some(p) = v.strip_prefix("projects:") {
                    Event::default().event("projects").data(p)
                } else {
                    Event::default().data(v)
                })
            })
        });
        Sse::new(initial.chain(updates))
            .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
            .into_response()
    } else if path.starts_with("/vscode/") {
        vscode::proxy(&app, request).await
    } else if method == "GET" && path == "/api/media/file" {
        media_response(&app, q(&qs, "path"), &headers).await
    } else {
        let body = if method == "POST" {
            if !headers
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| v.starts_with("application/json"))
            {
                return cors(err(400, "bad request"), origin.as_ref());
            }
            match to_bytes(request.into_body(), 15 << 20).await {
                Ok(b) => match serde_json::from_slice::<Value>(&b) {
                    Ok(v) if v.is_object() => v,
                    _ => return cors(err(400, "bad request"), origin.as_ref()),
                },
                Err(_) => return cors(err(413, "request too large"), origin.as_ref()),
            }
        } else {
            Value::Null
        };
        let task = tokio::task::spawn_blocking(move || {
            dispatch(&app, &method, &path, &qs, &headers, &body)
        })
        .await;
        match task {
            Ok(r) => r,
            Err(e) => {
                eprintln!("request failed: {e}");
                err(500, "internal server error")
            }
        }
    };
    if let Some(origin) = origin {
        response
            .headers_mut()
            .insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
        response
            .headers_mut()
            .append(header::VARY, "Origin".parse().unwrap());
    }
    response
}
fn dispatch(
    app: &App,
    method: &str,
    path: &str,
    qs: &HashMap<String, Vec<String>>,
    headers: &HeaderMap,
    b: &Value,
) -> Response {
    if method == "POST" {
        return post(app, path, headers, b);
    }
    if method != "GET" {
        return err(405, "method not allowed");
    }
    match path{
        "/api/glance" => json(glance::collect(app)),
        "/api/history" => json(archive::history_payload(app)),
        "/api/vault/recent" => json(archive::recent(app,q(qs,"limit").parse::<usize>().unwrap_or(10).clamp(1,50))),
        "/api/interactions" => match interactions::get(app,q(qs,"limit").parse::<usize>().unwrap_or(1500).clamp(50,5000),q(qs,"hb")=="1") {Ok(v)=>json(v),Err(e)=>err(502,&e)},
        "/api/canvas" => json(interactions::canvas_info(local(headers))),
        "/api/impl-progress" => json(impl_progress::collect(app,q(qs,"run"),q(qs,"term"),q(qs,"launch"))),
        "/api/designs" => json(designs::list(app)),
        "/api/design" => match designs::doc(app,q(qs,"path")){Ok(v)=>json(v),Err(e)=>err(if e=="not found"{404}else{413},&e)},
        "/api/design/refs" => json(json!({"refs":designs::session_refs(app,q(qs,"session"))})),
        "/api/design/file" => match designs::file(app,q(qs,"path")){Ok((p,typ))=>file_response(&p,typ),Err(e)=>err(if e=="not found"{404}else{413},&e)},
        "/api/chars/jobs" => json(json!({"jobs":chars::jobs(app),"redraws":app.state.read().unwrap().redraws.as_object().unwrap().values().cloned().collect::<Vec<_>>()})),
        "/api/chars/file" => match chars::file(app,q(qs,"job"),q(qs,"f")){Some((p,typ))=>file_response(&p,typ),None=>err(404,"not found")},
        "/api/worktrees" => match worktrees::get(app,q(qs,"fresh")=="1"){Ok(v)=>json(v),Err(e)=>err(502,&e)},
        "/api/orca/job" => match app.state.read().unwrap().jobs.get(q(qs,"id")){Some(v)=>json(v.clone()),None=>err(404,"not found")},
        "/api/orca/places" => match terminals::places(){Ok(v)=>json(v),Err(e)=>err(502,&e)},
        "/api/reviews" => json(app.state.read().unwrap().reviews.clone()),
 "/"=>json(json!({"name":"agent-dashboard","api":API_VERSION})),
 "/api/state"=>{let s=app.state.read().unwrap();let base=q(qs,"base");if let Some(old)=s.snapshots.iter().rev().find(|v|v["version"].as_u64()==base.parse::<u64>().ok()){json(delta(&s.snapshot,old))}else{json(s.snapshot.clone())}},
 "/api/session"|"/api/chat"=>{let chat=path=="/api/chat";let path=q(qs,"path");let s=app.state.read().unwrap();let sess=s.sessions.get(path).cloned();let sm=s.summaries.iter().find(|s|s["path"]==path).cloned();let(hooks,orca,prefs,pricing)=(s.hooks.clone(),s.orca.clone(),s.prefs.clone(),s.pricing.clone());drop(s);let session=if let Some(s)=sess{Some(s)}else{let p=real(path);let allowed=[home().join(".claude/projects"),home().join(".codex/sessions"),home().join("Library/Application Support/orca")].iter().any(|root|p.starts_with(root));if allowed&&p.is_file()&&p.extension().is_some_and(|x|x=="jsonl"){let mut s=Session::new(path,if path.contains("rollout-"){"codex"}else{"claude"});s.poll().ok().map(|_|std::sync::Arc::new(s))}else{None}};if let Some(sess)=session{if chat{return json(json!({"chat":sess.chat}));}let sm=sm.unwrap_or_else(||sess.summary(&hooks,&orca,&prefs,&pricing,&Value::Null));let mut detail=sess.detail(sm);detail["vault_on"]=json!(app.config.vault.is_dir());detail["vault_notes"]=json!(archive::vault_notes(app,&sess.kind,sess.id()));detail["design_refs"]=json!(designs::session_refs(app,sess.id()));json(detail)}else if let Some(sm)=sm{json(sm)}else{err(404,"not found")}},
 "/api/plans"=>{let s=app.state.read().unwrap();let mut out=obj();for p in qs.get("p").into_iter().flatten().take(200){if let Some(sess)=s.sessions.get(p){out[p]=json!(sess.plans().into_iter().rev().take(8).collect::<Vec<_>>().into_iter().rev().map(|p|json!({"ts":p["ts"],"prompt":short(text(&p["prompt"]),120),"steps":p["steps"]})).collect::<Vec<_>>());}}json(json!({"plans":out}))},
 "/api/tests"=>{let s=app.state.read().unwrap();let mut runs=s.test_history.as_object().map(|o|o.iter().map(|(k,v)|{let mut v=v.clone();v["id"]=json!(k);v}).collect::<Vec<_>>()).unwrap_or_default();runs.sort_by(|a,b|text(&b["finished_at"]).cmp(text(&a["finished_at"])));json(json!({"runs":runs,"at":s.tests["history_at"]}))},
 "/api/tests/run"=>{let s=app.state.read().unwrap();let id=q(qs,"id");if let Some(d)=s.test_history.get(id){let mut d=d.clone();d["id"]=json!(id);json(d)}else{err(404,"보관된 실행이 없습니다")}},
 "/api/run"=>{let s=app.state.read().unwrap();let id=q(qs,"id");let r=array(&s.orca["runs"]).iter().find(|r|r["id"]==id);if let Some(r)=r{json(json!({"run":r,"tasks":s.orca["tasks"][id],"workers":array(&s.orca["workers"]).iter().filter(|w|w["runId"]==id).collect::<Vec<_>>()}))}else{err(404,"not found")}},
 "/api/decisions"=>{let s=app.state.read().unwrap();let wire=json!({"decisions":s.decisions,"sessions":s.summaries.iter().filter(|sm|!sm["decision"].is_null()).map(|sm|json!({"path":sm["path"],"title":sm["title"],"decision":sm["decision"]})).collect::<Vec<_>>()});match serde_json::from_value::<agent_dashboard_client_core::DecisionsPayload>(wire){Ok(payload)=>json(serde_json::to_value(payload).unwrap()),Err(e)=>{eprintln!("decision wire contract: {e}");err(500,"invalid decision payload")}}},
 "/api/decision/wait"=>json(json!({"state":"gone"})),
 "/api/decision/mode"=>json(json!({"inbox":app.state.read().unwrap().prefs["decision_inbox"]==true})),
 "/api/projects"=>{let s=app.state.read().unwrap();let mut p=s.projects.clone();p["projects"]=json!(array(&p["list"]).iter().cloned().map(projects::lite).collect::<Vec<_>>());p.as_object_mut().unwrap().remove("list");json(p)},
 "/api/project"|"/api/project/note"=>{let s=app.state.read().unwrap();let p=array(&s.projects["list"]).iter().find(|p|p["name"]==q(qs,"name")&&(q(qs,"dir").is_empty()||p["dir"]==q(qs,"dir"))).cloned();drop(s);if let Some(p)=p{if path.ends_with("/note"){match projects::note(&p,q(qs,"path")){Ok(v)=>json(v),Err(e)=>err(if e=="not found"{404}else{400},&e)}}else{json(p)}}else{err(404,"not found")}},
 "/api/media"=>json(media::list(app)),
 "/api/usage/report"=>{let n=|k,default|q(qs,k).parse::<u64>().unwrap_or(default);let days=n("days",30);let top=n("top",15);let rare=n("rare",1);let by=if q(qs,"by").is_empty(){"both"}else{q(qs,"by")};if days>3650||!(1..=200).contains(&top)||rare>100||!["app","form","both"].contains(&by){err(400,"bad request")}else{json(usage::report(&app.config,days,by,top as usize,rare))}},
 "/usage"=>([(header::CONTENT_TYPE,"text/html; charset=utf-8"),(header::CONTENT_SECURITY_POLICY,"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'")],include_str!("../assets/usage.html")).into_response(),
 _=>err(404,"not found")}
}
fn post(app: &App, path: &str, _headers: &HeaderMap, b: &Value) -> Response {
    if let Some(action) = path.strip_prefix("/api/decision/") {
        let (code, v) = decisions::post(app, action, b);
        return reply(code, v);
    }
    for (prefix, kind) in [
        ("/api/orca/", 0),
        ("/api/worktrees/", 1),
        ("/api/chars/", 2),
        ("/api/review/", 3),
        ("/api/qa/", 4),
    ] {
        if let Some(action) = path.strip_prefix(prefix) {
            let (code, v) = match kind {
                0 => terminals::action(app, action, b),
                1 => worktrees::action(app, action, b, local(_headers)),
                2 => chars::action(app, action, b),
                3 => review::action(app, action, b, local(_headers)),
                _ => review::qa_action(app, action, b),
            };
            return reply(code, v);
        }
    }
    match path {
        "/api/pref" => {
            let action = text(&b["action"]);
            let Some(paths) = b["paths"].as_array() else {
                return err(400, "bad request");
            };
            if !["idle", "unidle", "char", "pin", "unpin"].contains(&action)
                || action == "char"
                    && !b["who"].is_null()
                    && !rx(r"^[a-z0-9-]{1,40}$").is_match(text(&b["who"]))
            {
                return err(400, "bad request");
            }
            let mut s = app.state.write().unwrap();
            for p in paths {
                let Some(p) = p.as_str() else {
                    return err(400, "bad request");
                };
                let last = s.sessions.get(p).map(|s| s.data["last_ts"].clone());
                if last.is_none()
                    && action != "unpin"
                    && !(action == "char" && p.starts_with("orca-terminal:"))
                {
                    continue;
                }
                match action {
                    "idle" => s.prefs["idle"][p] = last.unwrap_or(Value::Null),
                    "unidle" => {
                        s.prefs["idle"].as_object_mut().unwrap().remove(p);
                    }
                    "pin" => s.prefs["pinned"][p] = json!(iso()),
                    "unpin" => {
                        s.prefs["pinned"].as_object_mut().unwrap().remove(p);
                    }
                    "char" => {
                        if b["who"].is_null() {
                            s.prefs["chars"].as_object_mut().unwrap().remove(p);
                        } else {
                            s.prefs["chars"][p] = json!({"who":b["who"],"boss":b["boss"]==true,"pick":b["pick"]==true});
                        }
                    }
                    _ => {}
                }
            }
            drop(s);
            match app.save_prefs() {
                Ok(()) => json(json!({"ok":true})),
                Err(e) => err(500, &e),
            }
        }
        "/api/usage" => match usage::record(&app.config, b) {
            Ok(n) => json(json!({"ok":true,"n":n})),
            Err(e) => err(400, &e),
        },
        "/api/flow/ok" => {
            let id = text(&b["id"]);
            if id.is_empty() || b.get("ok").is_some_and(|v| !v.is_boolean()) {
                return err(400, "bad request");
            }
            let mut s = app.state.write().unwrap();
            if b["ok"] != false {
                s.prefs["flow_ok"][id] =
                    json!({"at":iso(),"rule":b["item"]["rule"],"reason":b["item"]["reason"]});
            } else {
                s.prefs["flow_ok"].as_object_mut().unwrap().remove(id);
            }
            drop(s);
            match app.save_prefs() {
                Ok(()) => json(json!({"ok":true})),
                Err(e) => err(500, &e),
            }
        }
        _ => err(400, "bad request"),
    }
}
pub fn delta(new: &Value, old: &Value) -> Value {
    let mut d = obj();
    for (k, v) in new.as_object().unwrap() {
        if ["version", "health", "api"].contains(&k.as_str()) {
            continue;
        }
        if *v == old[k] {
            continue;
        }
        if ["sessions", "ext_plans"].contains(&k.as_str()) {
            d[k] = list_delta(k, v, &old[k]);
        } else if k == "tests" {
            let mut a = v.clone();
            let mut b = old[k].clone();
            let af = a
                .as_object_mut()
                .unwrap()
                .remove("files")
                .unwrap_or(json!([]));
            let bf = b
                .as_object_mut()
                .and_then(|o| o.remove("files"))
                .unwrap_or(json!([]));
            if a != b {
                d[k] = a;
            }
            if af != bf {
                d["tests.files"] = list_delta("tests.files", &af, &bf);
            }
        } else {
            d[k] = v.clone();
        }
    }
    json!({"version":new["version"],"api":new["api"],"base":old["version"],"health":new["health"],"delta":d})
}
fn list_delta(kind: &str, new: &Value, old: &Value) -> Value {
    let key = |v: &Value| {
        if kind == "sessions" {
            format!("{}:{}", text(&v["kind"]), text(&v["id"]))
        } else {
            text(&v[if kind == "ext_plans" { "path" } else { "key" }]).into()
        }
    };
    let before: HashMap<_, _> = array(old).iter().map(|v| (key(v), v)).collect();
    let after: HashMap<_, _> = array(new).iter().map(|v| (key(v), v)).collect();
    if before.len() != array(old).len() || after.len() != array(new).len() {
        return new.clone();
    }
    let upd: Vec<_> = array(new)
        .iter()
        .filter(|v| before.get(&key(v)).is_none_or(|old| **old != **v))
        .collect();
    let del: Vec<_> = array(old)
        .iter()
        .map(key)
        .filter(|k| !after.contains_key(k))
        .collect();
    let mut out = json!({"upd":upd,"del":del});
    let n: Vec<_> = array(new).iter().map(key).collect();
    let o: Vec<_> = array(old).iter().map(key).collect();
    if kind != "sessions" && n != o {
        out["order"] = json!(n);
    }
    out
}
async fn media_response(app: &App, path: &str, headers: &HeaderMap) -> Response {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let Some(p) = media::resolve(&app.config, path) else {
        return err(404, "not found");
    };
    let mut f = match tokio::fs::File::open(&p).await {
        Ok(f) => f,
        Err(_) => return err(404, "not found"),
    };
    let size = f.metadata().await.map(|m| m.len()).unwrap_or(0);
    let range = media::byte_range(
        size,
        headers.get(header::RANGE).and_then(|v| v.to_str().ok()),
    );
    let Ok((start, end, code)) = range else {
        let mut r = StatusCode::RANGE_NOT_SATISFIABLE.into_response();
        r.headers_mut().insert(
            header::CONTENT_RANGE,
            format!("bytes */{size}").parse().unwrap(),
        );
        return r;
    };
    let len = if size == 0 { 0 } else { end - start + 1 };
    if f.seek(std::io::SeekFrom::Start(start)).await.is_err() {
        return err(500, "read error");
    }
    let mut r = Response::new(Body::from_stream(tokio_util::io::ReaderStream::new(
        f.take(len),
    )));
    *r.status_mut() = StatusCode::from_u16(code).unwrap();
    for (k, v) in [
        ("content-type", "video/mp4".into()),
        ("content-length", len.to_string()),
        ("accept-ranges", "bytes".into()),
        ("cache-control", "private, max-age=3600".into()),
        ("x-content-type-options", "nosniff".into()),
    ] {
        r.headers_mut()
            .insert(axum::http::HeaderName::from_static(k), v.parse().unwrap());
    }
    if code == 206 {
        r.headers_mut().insert(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{size}").parse().unwrap(),
        );
    }
    r
}

fn file_response(path: &std::path::Path, typ: &str) -> Response {
    match std::fs::read(path) {
        Ok(bytes) => {
            let mut r = bytes.into_response();
            r.headers_mut()
                .insert(header::CONTENT_TYPE, typ.parse().unwrap());
            r.headers_mut()
                .insert(header::CACHE_CONTROL, "no-cache".parse().unwrap());
            r.headers_mut()
                .insert("x-content-type-options", "nosniff".parse().unwrap());
            if typ == "image/svg+xml" {
                r.headers_mut().insert(
                    header::CONTENT_SECURITY_POLICY,
                    "default-src 'none'; style-src 'unsafe-inline'; img-src data:"
                        .parse()
                        .unwrap(),
                );
            }
            r
        }
        Err(_) => err(404, "not found"),
    }
}

fn cors(mut r: Response, origin: Option<&axum::http::HeaderValue>) -> Response {
    if let Some(o) = origin {
        r.headers_mut()
            .insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, o.clone());
        r.headers_mut()
            .append(header::VARY, "Origin".parse().unwrap());
    }
    r
}
