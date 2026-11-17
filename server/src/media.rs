use crate::{app::App, core::*, sessions::rx};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};
use unicode_normalization::UnicodeNormalization;
// The ~/Movies folders whose recordings media.json may publish: the record skills' (ego-record, aside-record,
// mobile-record) and the explainer videos.
pub const ROOTS: [&str; 4] = [
    "ego-record",
    "aside-record",
    "mobile-record",
    "explainer-video",
];
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
    if !ROOTS.contains(&root)
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
// A recording's .timeline.txt: "[H:]MM:SS kind text" lines (the text may be absent: mobile-record's runner writes
// one word per action), or "kind text Ns" with the seconds at the end (hand-written retake notes).
pub fn timeline(path: &Path) -> Vec<Value> {
    fs::read_to_string(path.with_extension("timeline.txt"))
        .unwrap_or_default()
        .lines()
        .filter_map(|s| {
            let s = s.trim();
            if let Some(c) = rx(r"^(?:(\d+):)?(\d{1,2}):(\d{2})\s+(\S+)(?:\s+(.*))?$").captures(s) {
                let n = |i| {
                    c.get(i)
                        .and_then(|m| m.as_str().parse::<u64>().ok())
                        .unwrap_or(0)
                };
                let text = c.get(5).map_or("", |m| m.as_str().trim());
                return Some(json!({"t":n(1)*3600+n(2)*60+n(3),"kind":&c[4],"text":text}));
            }
            let c = rx(r"^(\S+)\s+(.*?)\s+(\d+)s$").captures(s)?;
            Some(json!({"t":c[3].parse::<u64>().ok()?,"kind":&c[1],"text":c[2].trim()}))
        })
        .collect()
}
// The child boxes of an MP4 box's payload: (type, payload)
fn boxes(b: &[u8]) -> Vec<(&[u8], &[u8])> {
    let mut out = vec![];
    let mut i = 0;
    while i + 8 <= b.len() {
        let size = u32::from_be_bytes(b[i..i + 4].try_into().unwrap()) as usize;
        let (head, size) = match size {
            1 if i + 16 <= b.len() => (
                16,
                u64::from_be_bytes(b[i + 8..i + 16].try_into().unwrap()) as usize,
            ),
            0 => (8, b.len() - i),
            n => (8, n),
        };
        if size < head || i + size > b.len() {
            break;
        }
        out.push((&b[i + 4..i + 8], &b[i + head..i + size]));
        i += size;
    }
    out
}
fn child<'a>(b: &'a [u8], kind: &[u8]) -> Option<&'a [u8]> {
    boxes(b)
        .into_iter()
        .find(|(k, _)| *k == kind)
        .map(|(_, v)| v)
}
fn be(b: &[u8], at: usize, n: usize) -> Option<u64> {
    let s = b.get(at..at + n)?;
    Some(s.iter().fold(0u64, |a, &x| a << 8 | x as u64))
}
// Seconds of picture-less time before a recording's first frame: its video track's edit list may open with an empty
// edit (a recorder whose clock started before its first frame), and players show nothing for that long.
pub fn lead(path: &Path) -> f64 {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = fs::File::open(path) else {
        return 0.0;
    };
    let mut moov = None;
    let mut head = [0u8; 16];
    while f.read_exact(&mut head[..8]).is_ok() {
        let mut size = u32::from_be_bytes(head[..4].try_into().unwrap()) as u64;
        let mut skip = 8;
        if size == 1 {
            if f.read_exact(&mut head[8..16]).is_err() {
                break;
            }
            size = u64::from_be_bytes(head[8..16].try_into().unwrap());
            skip = 16;
        }
        if &head[4..8] == b"moov" {
            if size < skip || size - skip > 64 << 20 {
                break;
            }
            let mut b = vec![0; (size - skip) as usize];
            if f.read_exact(&mut b).is_ok() {
                moov = Some(b);
            }
            break;
        }
        if size < skip || f.seek(SeekFrom::Current((size - skip) as i64)).is_err() {
            break;
        }
    }
    let Some(moov) = moov else {
        return 0.0;
    };
    let scale = child(&moov, b"mvhd")
        .and_then(|m| be(m, if m[0] == 1 { 20 } else { 12 }, 4))
        .unwrap_or(0);
    if scale == 0 {
        return 0.0;
    }
    for (_, trak) in boxes(&moov).into_iter().filter(|(k, _)| *k == b"trak") {
        let video = child(trak, b"mdia")
            .and_then(|m| child(m, b"hdlr"))
            .is_some_and(|h| h.get(8..12) == Some(b"vide"));
        if !video {
            continue;
        }
        let Some(elst) = child(trak, b"edts").and_then(|e| child(e, b"elst")) else {
            return 0.0;
        };
        let wide = elst.first() == Some(&1);
        let (n, step) = (
            be(elst, 4, 4).unwrap_or(0) as usize,
            if wide { 20 } else { 12 },
        );
        let mut empty = 0u64;
        for i in 0..n {
            let at = 8 + i * step;
            let dur = be(elst, at, if wide { 8 } else { 4 });
            let media = be(
                elst,
                at + if wide { 8 } else { 4 },
                if wide { 8 } else { 4 },
            );
            let none = if wide { u64::MAX } else { u32::MAX as u64 };
            match (dur, media) {
                (Some(d), Some(m)) if m == none => empty += d,
                _ => break,
            }
        }
        return (empty as f64 / scale as f64 * 1000.0).round() / 1000.0;
    }
    0.0
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
        // "<name> YYYYmmdd-HHMMSS" (mobile-record leaves the seconds out: "YYYYmmdd-HHMM")
        let m = rx(r"\s(\d{8}-\d{4}(?:\d{2})?)(?:-\d+)?$").captures(&stem);
        let started = m.as_ref().map(|m| {
            let t = &m[1];
            format!(
                "{}-{}-{} {}:{}:{}",
                &t[..4],
                &t[4..6],
                &t[6..8],
                &t[9..11],
                &t[11..13],
                if t.len() > 13 { &t[13..] } else { "00" }
            )
        });
        let name = m
            .as_ref()
            .map(|m| &stem[..m.get(0).unwrap().start()])
            .unwrap_or(&stem);
        videos.push(json!({"path":rel,"root":root,"name":name,"started":started,"size":fs::metadata(&p).map(|s|s.len()).unwrap_or(0),"mtime":mtime(&p),"kind":if root=="explainer-video"{"learn"}else{"qa"},"timeline":timeline(&p),"captions":captions(&p),"lead":lead(&p)}));
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
