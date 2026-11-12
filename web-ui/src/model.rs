use serde_json::Value;
use std::collections::{HashMap, HashSet};
pub const SCREENS: &[(&str, &str, &str)] = &[
    ("home", "홈", "home"),
    ("agents", "에이전트", "users"),
    ("worktrees", "QA · 워크트리 리뷰", "layers"),
    ("projects", "프로젝트", "flow"),
    ("tests", "테스트", "flask"),
    ("decide", "결정 대기", "help"),
    ("usage", "플랜 사용량", "zap"),
    ("compare", "비교", "chart"),
    ("talk", "상호작용", "chat"),
    ("designs", "설계문서", "book"),
    ("media", "녹화 영상", "play"),
    ("canvas", "워크플로 캔버스", "monitor"),
    ("trees", "워크트리", "branch"),
    ("chars", "캐릭터", "image"),
];
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Route {
    pub page: String,
    pub id: String,
    pub server: String,
    pub section: String,
}
impl Route {
    pub fn parse(hash: &str) -> Self {
        let hash = hash.trim_start_matches('#');
        let h = urlencoding::decode(hash)
            .map(|v| v.into_owned())
            .unwrap_or_else(|_| hash.into());
        let mut out = Self {
            page: "home".into(),
            id: String::new(),
            server: String::new(),
            section: String::new(),
        };
        for (prefix, page) in [("s=", "session"), ("r=", "run"), ("dr=", "driver")] {
            if let Some(id) = h.strip_prefix(prefix) {
                out.page = page.into();
                out.id = id.into();
                return out;
            }
        }
        if let Some(s) = h.strip_prefix("dz=") {
            let mut p = s.split('|').collect::<Vec<_>>();
            out.page = "designs".into();
            out.server = p.remove(0).into();
            if p.len() > 1 {
                out.section = p.pop().unwrap().into();
            }
            out.id = p.join("|");
        } else if SCREENS.iter().any(|(key, _, _)| *key == h) {
            out.page = h;
        }
        out
    }
    pub fn group(&self) -> &str {
        if ["session", "run", "driver"].contains(&self.page.as_str()) {
            "agents"
        } else {
            &self.page
        }
    }
}
pub fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
pub fn number(v: &Value) -> f64 {
    v.as_f64().unwrap_or(0.)
}
pub fn array(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
pub fn label(v: &Value, keys: &[&str]) -> String {
    keys.iter()
        .map(|k| text(&v[k]))
        .find(|v| !v.is_empty())
        .unwrap_or("")
        .into()
}
pub fn count(v: &Value) -> String {
    let n = number(v);
    if n >= 1e6 {
        format!("{:.1}M", n / 1e6)
    } else if n >= 1e3 {
        format!("{:.1}k", n / 1e3)
    } else {
        format!("{n:.0}")
    }
}
pub fn money(v: &Value) -> String {
    v.as_f64().map(|n| format!("${n:.2}")).unwrap_or("—".into())
}
pub fn state_label(st: &str) -> &str {
    match st {
        "run" | "running" | "active" | "dispatched" | "in_progress" => "실행 중",
        "bg" => "백그라운드",
        "wait" => "입력 대기",
        "stalled" => "응답 없음",
        "done" | "completed" => "완료",
        "failed" | "fail" => "실패",
        "cancelled" => "취소",
        "ready" => "준비",
        "blocked" => "선행 대기",
        "scheduling" => "일정 조율",
        "pending" => "대기",
        "planned" => "생성 대기",
        _ => "유휴",
    }
}
pub fn live(v: &Value) -> bool {
    ["run", "bg", "wait", "stalled"].contains(&text(&v["state"]))
}
pub fn session_hash(path: &str) -> String {
    format!("#s={}", urlencoding::encode(path))
}
pub fn design_hash(server: &str, key: &str, section: &str) -> String {
    format!(
        "#dz={}",
        urlencoding::encode(&format!("{server}|{key}|{section}"))
    )
}
pub fn key(v: &Value) -> String {
    ["path", "id", "key", "handle", "epic", "launch", "name"]
        .iter()
        .find_map(|k| v[k].as_str().filter(|s| !s.is_empty()).map(str::to_owned))
        .unwrap_or_else(|| v.to_string())
}
pub fn search(v: &Value, q: &str) -> bool {
    let haystack = v.to_string().to_lowercase();
    q.to_lowercase()
        .split_whitespace()
        .all(|word| haystack.contains(word))
}
/// Indices contain identities only; metric-only changes do not invalidate the tree.
#[derive(Clone, Default, Debug, PartialEq, Eq)]
pub struct Index {
    pub roots: Vec<String>,
    pub by_coord: HashMap<String, Vec<String>>,
    pub subs: HashMap<String, Vec<String>>,
    pub places: HashMap<String, Vec<String>>,
}
pub fn identity(v: &Value) -> String {
    format!("{}|{}", text(&v["server"]), key(v))
}
pub fn relation(v: &Value, field: &str) -> String {
    format!("{}|{}", text(&v["server"]), text(&v[field]))
}
pub fn place_key(v: &Value) -> String {
    format!(
        "{} · {}",
        text(&v["server"]),
        label(&v["place"], &["path", "worktree", "project"])
    )
}
pub fn index(rows: &[Value]) -> Index {
    let mut out = Index::default();
    let ids = rows
        .iter()
        .map(|s| relation(s, "id"))
        .collect::<HashSet<_>>();
    let owners = rows
        .iter()
        .filter(|s| s["parent"].is_null() && !text(&s["own_handle"]).is_empty())
        .map(|s| relation(s, "own_handle"))
        .collect::<HashSet<_>>();
    for s in rows {
        let id = identity(s);
        let parent = relation(s, "parent");
        let coord = relation(s, "coord_handle");
        if s["parent"].is_string() && ids.contains(&parent) && parent != relation(s, "id") {
            out.subs.entry(parent).or_default().push(id.clone());
        } else if s["role"] == "worker"
            && owners.contains(&coord)
            && coord != relation(s, "own_handle")
        {
            out.by_coord.entry(coord).or_default().push(id.clone());
        } else {
            out.roots.push(id.clone());
        }
        if s["parent"].is_null() {
            out.places.entry(place_key(s)).or_default().push(id);
        }
    }
    if out.roots.is_empty() {
        out.roots = rows
            .iter()
            .filter(|s| s["parent"].is_null())
            .map(identity)
            .collect();
    }
    out
}
pub fn markdown(source: &str) -> String {
    use pulldown_cmark::{CowStr, Event, Options, Parser, Tag, TagEnd};
    let mut events = vec![];
    let mut unsafe_link = 0;
    for e in Parser::new_ext(
        source,
        Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS,
    ) {
        match e {
            Event::Html(s) | Event::InlineHtml(s) => events.push(Event::Text(s)),
            Event::Start(Tag::Link { ref dest_url, .. })
            | Event::Start(Tag::Image { ref dest_url, .. })
                if !safe_url(dest_url) =>
            {
                unsafe_link += 1;
                events.push(Event::Start(Tag::Emphasis));
            }
            Event::End(TagEnd::Link | TagEnd::Image) if unsafe_link > 0 => {
                unsafe_link -= 1;
                events.push(Event::End(TagEnd::Emphasis));
            }
            Event::Start(Tag::Link {
                link_type,
                dest_url,
                title,
                id,
            }) => events.push(Event::Start(Tag::Link {
                link_type,
                dest_url: CowStr::from(dest_url.into_string()),
                title,
                id,
            })),
            _ => events.push(e),
        }
    }
    let mut html = String::new();
    pulldown_cmark::html::push_html(&mut html, events.into_iter());
    html
}
pub fn safe_url(s: &str) -> bool {
    let value = s.trim().to_lowercase();
    !value.starts_with("javascript:")
        && !value.starts_with("vbscript:")
        && !value.starts_with("data:")
        && !value.chars().any(|c| c < ' ')
}

/// Wire slots are epoch / 300 seconds: input, cache write, cache read, output, cost.
pub fn usage_buckets(rows: &[Value], since: i64) -> std::collections::BTreeMap<i64, [f64; 5]> {
    let mut out = std::collections::BTreeMap::new();
    for r in rows {
        for (k, v) in r["slots"].as_object().into_iter().flat_map(|m| m.iter()) {
            let Ok(t) = k.parse::<i64>() else { continue };
            if t < since {
                continue;
            }
            let b = out.entry(t).or_insert([0.; 5]);
            for (i, n) in b.iter_mut().enumerate() {
                *n += number(&v[i]);
            }
        }
    }
    out
}
