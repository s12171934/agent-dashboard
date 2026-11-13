use crate::{app::App, core::*, sessions::rx};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};
use unicode_normalization::UnicodeNormalization;
pub fn resolve(config: &Config, rel: &str) -> Option<PathBuf> {
    let rel = rel.nfc().collect::<String>();
    let rel = rel.as_str();
    let published = read_json(config.data.join("media.json"));
    if !array(&published["published"])
        .iter()
        .any(|p| text(p).nfc().collect::<String>() == rel)
    {
        return None;
    }
    let (root, name) = rel.split_once('/')?;
    if !["ego-record", "aside-record", "explainer-video"].contains(&root)
        || name.contains('/')
        || name.starts_with('.')
        || !name.ends_with(".mp4")
    {
        return None;
    }
    let base = real(home().join("Movies").join(root));
    let p = real(base.join(name));
    (p.parent() == Some(base.as_path()) && p.is_file()).then_some(p)
}
pub fn timeline(path: &Path) -> Vec<Value> {
    fs::read_to_string(path.with_extension("timeline.txt"))
        .unwrap_or_default()
        .lines()
        .filter_map(|s| {
            let c = rx(r"^(?:(\d+):)?(\d{1,2}):(\d{2})\s+(\S+)\s+(.*)$").captures(s.trim())?;
            let n = |i| {
                c.get(i)
                    .and_then(|m| m.as_str().parse::<u64>().ok())
                    .unwrap_or(0)
            };
            Some(json!({"t":n(1)*3600+n(2)*60+n(3),"kind":&c[4],"text":c[5].trim()}))
        })
        .collect()
}
pub fn captions(path: &Path) -> Vec<Value> {
    let mut p = path.with_extension("srt");
    if !p.is_file() {
        let mut ps = files(path.with_extension(""), "srt");
        ps.sort();
        let Some(first) = ps.first() else {
            return vec![];
        };
        p = first.clone();
    }
    let s = fs::read_to_string(p)
        .unwrap_or_default()
        .replace("\r\n", "\n");
    rx(r"\n\s*\n")
        .split(&s)
        .filter_map(|b| {
            let lines = b.lines().collect::<Vec<_>>();
            let (i, c) = lines.iter().enumerate().find_map(|(i, s)| {
                rx(r"(\d+):(\d{2}):(\d{2})[,.](\d{3})\s*-->")
                    .captures(s)
                    .map(|c| (i, c))
            })?;
            let n = |i| {
                c.get(i)
                    .and_then(|m| m.as_str().parse::<f64>().ok())
                    .unwrap_or(0.)
            };
            let s = lines[i + 1..]
                .iter()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            if s.is_empty() {
                None
            } else {
                Some(json!({"t":n(1)*3600.+n(2)*60.+n(3)+n(4)/1000.,"text":s}))
            }
        })
        .collect()
}
/// Associate QA recordings with known projects without guessing from a Jira prefix.
pub fn classify(videos: &mut [Value], projects: &Value, reviews: &Value) {
    let keys = |s: &str| {
        rx(r"\b[A-Z][A-Z0-9]*-\d+\b")
            .find_iter(s)
            .map(|m| m.as_str().to_owned())
            .collect::<Vec<_>>()
    };
    let mut index: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for p in array(&projects["list"]) {
        let name = text(&p["name"]);
        if name.is_empty() {
            continue;
        }
        for key in keys(name).into_iter().chain(
            array(&p["stages"])
                .iter()
                .flat_map(|s| array(&s["steps"]))
                .flat_map(|s| keys(text(&s["path"]))),
        ) {
            index.entry(key).or_default().insert(name.to_owned());
        }
    }
    for set in array(&reviews["sets"]) {
        let name = text(&set["project"])
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or("");
        if name.is_empty() {
            continue;
        }
        for key in std::iter::once(text(&set["epic"]))
            .chain(array(&set["tickets"]).iter().map(|t| text(&t["key"])))
            .filter(|k| !k.is_empty())
        {
            index
                .entry(key.to_owned())
                .or_default()
                .insert(name.to_owned());
        }
    }
    for v in videos.iter_mut().filter(|v| v["kind"] == "qa") {
        let ticket = keys(text(&v["name"])).into_iter().next();
        let candidates = ticket.as_ref().and_then(|t| index.get(t));
        let project = candidates.filter(|c| c.len() == 1).and_then(|c| c.first());
        v["ticket"] = json!(ticket);
        v["project"] = json!(project);
    }
}
pub fn list(app: &App) -> Value {
    let config = &app.config;
    let mut videos = vec![];
    let mut missing = vec![];
    let published = read_json(config.data.join("media.json"));
    for r in array(&published["published"]) {
        let rel = text(r);
        let Some(p) = resolve(config, rel) else {
            missing.push(r.clone());
            continue;
        };
        let root = rel.split('/').next().unwrap();
        let stem = p.file_stem().unwrap_or_default().to_string_lossy();
        let m = rx(r"\s(\d{8}-\d{6})(?:-\d+)?$").captures(&stem);
        let started = m.as_ref().map(|m| {
            format!(
                "{}-{}-{} {}:{}:{}",
                &m[1][..4],
                &m[1][4..6],
                &m[1][6..8],
                &m[1][9..11],
                &m[1][11..13],
                &m[1][13..]
            )
        });
        let name = m
            .as_ref()
            .map(|m| &stem[..m.get(0).unwrap().start()])
            .unwrap_or(&stem);
        videos.push(json!({"path":rel,"root":root,"name":name,"started":started,"size":fs::metadata(&p).map(|s|s.len()).unwrap_or(0),"mtime":mtime(&p),"kind":if root=="explainer-video"{"learn"}else{"qa"},"timeline":timeline(&p),"captions":captions(&p)}));
    }
    let state = app.state.read().unwrap();
    classify(&mut videos, &state.projects, &state.reviews);
    json!({"videos":videos,"missing":missing})
}
pub fn byte_range(size: u64, header: Option<&str>) -> Result<(u64, u64, u16)> {
    if size == 0 {
        return if header.is_some() {
            Err("range".into())
        } else {
            Ok((0, 0, 200))
        };
    }
    let Some(s) = header else {
        return Ok((0, size - 1, 200));
    };
    let c = rx(r"^bytes=(\d*)-(\d*)$")
        .captures(s.trim())
        .ok_or("range")?;
    if c[1].is_empty() && c[2].is_empty() {
        return Err("range".into());
    }
    let (start, end) = if c[1].is_empty() {
        let n = c[2].parse::<u64>().map_err(|_| "range")?;
        if n == 0 {
            return Err("range".into());
        }
        (size.saturating_sub(n), size - 1)
    } else {
        (
            c[1].parse::<u64>().map_err(|_| "range")?,
            if c[2].is_empty() {
                size - 1
            } else {
                c[2].parse::<u64>().map_err(|_| "range")?.min(size - 1)
            },
        )
    };
    if start > end {
        Err("range".into())
    } else {
        Ok((start, end, 206))
    }
}
