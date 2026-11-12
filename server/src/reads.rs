//! Read evidence derived from completed tool calls. Never execute transcript commands.
use crate::{core::*, sessions::rx};
use serde_json::{Value, json};
use std::path::Path;
pub fn tool(name: &str, input: &Value, cwd: &str, body: &str) -> Vec<Value> {
    let input = if let Some(s) = input.as_str() {
        serde_json::from_str(s).unwrap_or_else(|_| json!({"command":s}))
    } else {
        input.clone()
    };
    let mut out = vec![];
    if name == "Read" {
        let p = text(&input["file_path"]);
        if p.is_empty() {
            return out;
        }
        let nums = body
            .lines()
            .filter_map(|ln| {
                rx(r"^\s*(\d+)(?:→|\t|[:|])")
                    .captures(ln)
                    .and_then(|m| m[1].parse::<usize>().ok())
            })
            .collect::<Vec<_>>();
        if Path::new(p).extension().is_some_and(|e| e != "md") {
            out.push(json!({"abs":p,"kind":"read","ranges":[],"exact":true}));
        } else if let (Some(a), Some(b)) = (nums.iter().min(), nums.iter().max()) {
            out.push(json!({"abs":p,"kind":"read","ranges":[[a,b]],"exact":true}));
        }
        return out;
    }
    let cwd = input["workdir"]
        .as_str()
        .or(input["working_directory"].as_str())
        .unwrap_or(cwd);
    if name == "Grep" {
        let p = real(Path::new(cwd).join(text(&input["path"])));
        if p.is_file() {
            let nums = body
                .lines()
                .filter_map(|ln| ln.split(':').next()?.parse::<u64>().ok())
                .collect::<Vec<_>>();
            for n in nums {
                out.push(json!({"abs":p,"kind":"search","ranges":[[n,n]],"exact":true}));
            }
        }
        return out;
    }
    if name.contains("exec")
        && input["command"].is_string()
        && text(&input["command"]).contains("tools.")
    {
        let mut out = vec![];
        for capture in
            rx(r#"\bcmd\s*:\s*("(?:\\.|[^"\\])*")"#).captures_iter(text(&input["command"]))
        {
            if let Ok(cmd) = serde_json::from_str::<String>(&capture[1]) {
                out.extend(tool("Bash", &json!({"command":cmd}), cwd, body));
            }
        }
        if !out.is_empty() {
            return out;
        }
    }
    let cmd = input["command"]
        .as_str()
        .or(input["cmd"].as_str())
        .unwrap_or("");
    if cmd.is_empty() {
        return out;
    }
    let mut cwd = Path::new(cwd).to_path_buf();
    for segment in cmd.split([';', '\n', '|']) {
        let segment = segment.trim().trim_start_matches('&').trim();
        if let Some(s) = segment.strip_prefix("cd ") {
            cwd = real(cwd.join(s.trim().trim_matches(['\'', '"'])));
            continue;
        }
        let mut ranges = vec![];
        let mut kind = "read";
        if segment.starts_with("sed ") {
            for c in rx(r#"(?:^|[ '"])(\d+)(?:,(\d+))?p"#).captures_iter(segment) {
                let a = c[1].parse::<u64>().unwrap_or(1);
                let b = c
                    .get(2)
                    .and_then(|m| m.as_str().parse::<u64>().ok())
                    .unwrap_or(a);
                ranges.push(json!([a, b]));
            }
        } else if segment.starts_with("head ") {
            let n = rx(r"(?:-n\s*|^-)(\d+)")
                .captures(segment)
                .and_then(|m| m[1].parse::<u64>().ok())
                .unwrap_or(10);
            ranges.push(json!([1, n]));
        } else if segment.starts_with("tail ") {
            let n = rx(r"-n\s*\+(\d+)")
                .captures(segment)
                .and_then(|m| m[1].parse::<u64>().ok());
            if let Some(n) = n {
                ranges.push(json!([n, u64::MAX]));
            } else {
                continue;
            }
        } else if segment.starts_with("rg ") || segment.starts_with("grep ") {
            kind = "search";
            if segment.contains("^##") || segment.contains("^#") {
                continue;
            }
        } else if !segment.starts_with("cat ") {
            continue;
        }
        for m in rx(r#"(?:"([^"]+\.(?:md|svg|png|jpg|jpeg|webp|pdf))"|'([^']+\.(?:md|svg|png|jpg|jpeg|webp|pdf))'|([^\s'"<>]+\.(?:md|svg|png|jpg|jpeg|webp|pdf)))"#).captures_iter(segment){let name=m.get(1).or(m.get(2)).or(m.get(3)).unwrap().as_str();let p=real(if name.starts_with("~/"){expand(name)}else{cwd.join(name)});if kind=="search"{for c in rx(r"(?m)^(?:[^\n:]+:)?(\d+):").captures_iter(body){if let Ok(n)=c[1].parse::<u64>(){out.push(json!({"abs":p,"kind":kind,"ranges":[[n,n]],"exact":true}));}}}else{out.push(json!({"abs":p,"kind":kind,"ranges":ranges,"exact":!ranges.is_empty()||segment.starts_with("cat ")}));}}
    }
    out
}
