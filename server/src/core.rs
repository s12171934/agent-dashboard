//! Shared filesystem, process, configuration and JSON primitives. No feature dependencies.
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use wait_timeout::ChildExt;

pub type Result<T> = std::result::Result<T, String>;
pub fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}
pub fn iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub fn epoch(s: &str) -> Option<f64> {
    DateTime::parse_from_rfc3339(&s.replace(' ', "T"))
        .ok()
        .or_else(|| {
            chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S")
                .ok()
                .map(|d| d.and_utc().fixed_offset())
        })
        .map(|d| d.timestamp_millis() as f64 / 1000.)
}
pub fn short(s: &str, n: usize) -> String {
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() > n {
        format!(
            "{}…",
            s.chars().take(n.saturating_sub(1)).collect::<String>()
        )
    } else {
        s
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
pub fn obj() -> Value {
    json!({})
}

#[derive(Default)]
struct CachedJson {
    at: f64,
    value: Option<Value>,
    refreshing: bool,
    generation: u64,
}
type CacheEntry = Arc<Mutex<CachedJson>>;
fn json_caches() -> &'static Mutex<HashMap<String, CacheEntry>> {
    static C: std::sync::OnceLock<Mutex<HashMap<String, CacheEntry>>> = std::sync::OnceLock::new();
    C.get_or_init(Default::default)
}
pub fn drop_cache(key: &str) {
    json_caches().lock().unwrap().remove(key);
}
/// Serve the last successful result while exactly one worker refreshes an expired expensive query.
pub fn cached_json(
    key: String,
    ttl: f64,
    fresh: bool,
    f: impl FnOnce() -> Result<Value> + Send + 'static,
) -> Result<Value> {
    let entry = json_caches()
        .lock()
        .unwrap()
        .entry(key)
        .or_default()
        .clone();
    let mut e = entry.lock().unwrap();
    if fresh || e.value.is_none() {
        let v = f()?;
        e.at = now();
        e.generation += 1;
        e.refreshing = false;
        e.value = Some(v.clone());
        return Ok(v);
    }
    let value = e.value.clone().unwrap();
    if now() - e.at <= ttl || e.refreshing {
        return Ok(value);
    }
    e.refreshing = true;
    e.generation += 1;
    let generation = e.generation;
    drop(e);
    std::thread::spawn(move || {
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
        let mut e = entry.lock().unwrap();
        if e.generation == generation {
            if let Ok(Ok(v)) = r {
                e.value = Some(v);
            }
            e.at = now();
            e.refreshing = false;
        }
    });
    Ok(value)
}

pub fn read_tail(path: &Path, limit: u64) -> String {
    use std::io::{Seek, SeekFrom};
    let Ok(mut f) = fs::File::open(path) else {
        return String::new();
    };
    let size = f.metadata().map(|s| s.len()).unwrap_or(0);
    let _ = f.seek(SeekFrom::Start(size.saturating_sub(limit)));
    let mut b = vec![];
    let _ = f.take(limit).read_to_end(&mut b);
    String::from_utf8_lossy(&b).into_owned()
}
pub fn merge(dst: &mut Value, src: &Value) {
    if let (Some(a), Some(b)) = (dst.as_object_mut(), src.as_object()) {
        a.extend(b.clone());
    }
}
pub fn expand(p: impl AsRef<Path>) -> PathBuf {
    let s = p.as_ref().to_string_lossy();
    if s == "~" {
        home()
    } else if let Some(s) = s.strip_prefix("~/") {
        home().join(s)
    } else {
        p.as_ref().to_path_buf()
    }
}
pub fn absolute(p: impl AsRef<Path>) -> PathBuf {
    let p = expand(p);
    if p.is_absolute() {
        p
    } else {
        std::env::current_dir().unwrap_or_default().join(p)
    }
}
pub fn real(p: impl AsRef<Path>) -> PathBuf {
    let p = absolute(p);
    fs::canonicalize(&p).unwrap_or(p)
}
pub fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}
pub fn read_json(p: impl AsRef<Path>) -> Value {
    fs::read(p)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null)
}
pub fn read_lines(p: impl AsRef<Path>) -> Vec<Value> {
    fs::read_to_string(p)
        .unwrap_or_default()
        .lines()
        .filter_map(|s| serde_json::from_str(s).ok())
        .collect()
}
pub fn save_json(p: impl AsRef<Path>, v: &Value) -> Result<()> {
    let p = p.as_ref();
    if let Some(d) = p.parent() {
        fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let tmp = p.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    let bytes = serde_json::to_vec(v).map_err(|e| e.to_string())?;
    let result = fs::write(&tmp, bytes).and_then(|_| fs::rename(&tmp, p));
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result.map_err(|e| e.to_string())
}
pub fn append_json(p: impl AsRef<Path>, v: &Value) -> Result<()> {
    let p = p.as_ref();
    if let Some(d) = p.parent() {
        fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(p)
        .map_err(|e| e.to_string())?;
    let mut b = serde_json::to_vec(v).map_err(|e| e.to_string())?;
    b.push(b'\n');
    f.write_all(&b).map_err(|e| e.to_string())
}
pub fn mtime(p: impl AsRef<Path>) -> f64 {
    fs::metadata(p)
        .and_then(|s| s.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|x| x.as_secs_f64())
        .unwrap_or(0.)
}
pub fn files(root: impl AsRef<Path>, extension: &str) -> Vec<PathBuf> {
    walkdir::WalkDir::new(root)
        .follow_links(true)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file() && e.path().extension().is_some_and(|x| x == extension))
        .map(|e| e.into_path())
        .collect()
}

/// Drain stdout/stderr concurrently, including while waiting, so large CLI replies cannot deadlock.
pub fn command(program: &str, args: &[&str], cwd: Option<&Path>, timeout: u64) -> Result<String> {
    let (code, stdout, stderr) = command_full(program, args, cwd, timeout, &[])?;
    if code == 0 {
        Ok(stdout)
    } else {
        Err(short(&format!("{program}: {stderr} {stdout}"), 500))
    }
}
pub fn command_full(
    program: &str,
    args: &[&str],
    cwd: Option<&Path>,
    timeout: u64,
    env: &[(String, String)],
) -> Result<(i32, String, String)> {
    use std::os::unix::process::CommandExt;
    let mut cmd = Command::new(program);
    cmd.process_group(0)
        .envs(env.iter().map(|(k, v)| (k, v)))
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    if Path::new(program)
        .file_name()
        .is_some_and(|name| name == "orca")
    {
        // Dashboard list calls must span every Run, regardless of the launching agent's pane.
        cmd.env_remove("ORCA_TERMINAL_HANDLE")
            .env_remove("ORCA_PANE_KEY");
    }
    if let Some(p) = cwd {
        cmd.current_dir(p);
    }
    let mut child = cmd.spawn().map_err(|e| format!("{program}: {e}"))?;
    let out = child.stdout.take().unwrap();
    let err = child.stderr.take().unwrap();
    let drain = |mut r: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut b = Vec::new();
            let _ = r.read_to_end(&mut b);
            b
        })
    };
    let a = drain(Box::new(out));
    let b = drain(Box::new(err));
    let status = child
        .wait_timeout(Duration::from_secs(timeout))
        .map_err(|e| e.to_string())?;
    let timed = status.is_none();
    let status = if let Some(s) = status {
        s
    } else {
        unsafe {
            libc::kill(-(child.id() as i32), libc::SIGKILL);
        }
        let _ = child.kill();
        child.wait().map_err(|e| e.to_string())?
    };
    let stdout = String::from_utf8_lossy(&a.join().unwrap_or_default()).into_owned();
    let stderr = String::from_utf8_lossy(&b.join().unwrap_or_default()).into_owned();
    if timed {
        Err(format!("{program}: timed out after {timeout}s"))
    } else {
        Ok((status.code().unwrap_or(1), stdout, stderr))
    }
}
pub fn orca(args: &[&str]) -> Result<Value> {
    orca_timeout(args, 15)
}
pub fn orca_timeout(args: &[&str], timeout: u64) -> Result<Value> {
    let mut full = args.to_vec();
    if args.first() == Some(&"orchestration")
        && args.get(1).is_some_and(|command| {
            matches!(
                *command,
                "run-list"
                    | "run-show"
                    | "task-list"
                    | "worker-list"
                    | "worker-show"
                    | "inbox"
                    | "gate-list"
                    | "dispatch-show"
            )
        })
        && !args.contains(&"--full")
    {
        full.push("--full");
    }
    full.push("--json");
    decode_orca(&command("orca", &full, None, timeout)?)
}
pub fn decode_orca(stdout: &str) -> Result<Value> {
    let mut data: Value = serde_json::from_str(stdout).map_err(|e| format!("orca: {e}"))?;
    if data["ok"] != true {
        return Err(format!("orca: {}", short(stdout, 300)));
    }
    data.as_object_mut()
        .and_then(|object| object.remove("result"))
        .ok_or_else(|| "orca: missing result".into())
}
pub fn git(path: &Path, args: &[&str]) -> Result<String> {
    command("git", args, Some(path), 15).map(|s| s.trim_end().to_owned())
}

#[derive(Clone, Debug)]
pub struct Config {
    pub here: PathBuf,
    pub data: PathBuf,
    pub vault: PathBuf,
    pub hours: f64,
    pub runs: usize,
    pub hosts: Vec<String>,
    pub origins: Vec<String>,
    pub projects: Vec<PathBuf>,
    pub designs: Vec<PathBuf>,
    pub design_days: f64,
    pub port: u16,
}
impl Default for Config {
    fn default() -> Self {
        let executable =
            std::env::current_exe().unwrap_or_else(|_| PathBuf::from("agent-dashboard"));
        let here = std::env::var_os("ADASH_SERVER_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                executable
                    .ancestors()
                    .find(|p| p.join("Cargo.toml").is_file() && p.join("src").is_dir())
                    .map(Path::to_path_buf)
                    .unwrap_or_else(|| executable.parent().unwrap_or(Path::new(".")).to_path_buf())
            });
        let data = std::env::var_os("ADASH_DATA")
            .map(|p| absolute(PathBuf::from(p)))
            .unwrap_or_else(|| {
                if here.join("data").is_dir() {
                    here.join("data")
                } else {
                    here.clone()
                }
            });
        Self {
            here,
            data,
            vault: home().join("Obsidian/obsidian"),
            hours: 24.,
            runs: 8,
            hosts: vec!["127.0.0.1".into()],
            origins: vec![],
            projects: vec![],
            designs: vec![],
            design_days: 14.,
            port: 8787,
        }
    }
}
pub const DATA_FILES: &[(&str, &str)] = &[
    ("prefs.json", "state"),
    ("settled.json", "state"),
    ("pending.json", "state"),
    ("inbox.json", "state"),
    ("decision.log", "state"),
    ("plan-history.json", "state"),
    ("test-history.json", "state"),
    ("design-refs.json", "state"),
    ("media.json", "state"),
    ("qa-sheets.json", "state"),
    ("review-gone.json", "state"),
    ("worktree-notes.json", "state"),
    ("usage.jsonl", "state"),
    ("pricing.json", "state"),
    ("history-cache.json", "cache"),
    ("plan-usage.json", "cache"),
    ("server.log", "local"),
    ("vscode-web", "local"),
    (".token", "local"),
];
pub fn prefs(config: &Config) -> Value {
    let mut v = read_json(config.data.join("prefs.json"));
    if !v.is_object() {
        v = obj();
    }
    for k in ["idle", "chars", "pinned", "flow_ok"] {
        if !v[k].is_object() {
            v[k] = obj();
        }
    }
    v
}

#[derive(Clone, Default)]
pub struct Health(pub Arc<Mutex<HashMap<String, Value>>>);
impl Health {
    pub fn ok(&self, name: &str) {
        let mut h = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let old = h.entry(name.into()).or_insert_with(obj);
        merge(old, &json!({"ok":now(),"error":null}));
    }
    pub fn fail(&self, name: &str, e: &str) {
        eprintln!("{} {name}: {e}", iso());
        let mut h = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let old = h.entry(name.into()).or_insert_with(obj);
        merge(old, &json!({"at":now(),"error":short(e,300)}));
    }
    pub fn value(&self) -> Value {
        json!({"now":now(),"loops":*self.0.lock().unwrap_or_else(|e|e.into_inner())})
    }
}

pub fn read_new_json(path: &Path, offset: &mut u64) -> Vec<Value> {
    use std::io::{Seek, SeekFrom};
    let Ok(mut f) = fs::File::open(path) else {
        return vec![];
    };
    let size = f.metadata().map(|m| m.len()).unwrap_or(0);
    if size < *offset {
        *offset = 0;
    }
    if size == *offset {
        return vec![];
    }
    if f.seek(SeekFrom::Start(*offset)).is_err() {
        return vec![];
    }
    let mut bytes = Vec::new();
    if f.read_to_end(&mut bytes).is_err() {
        return vec![];
    }
    let Some(end) = bytes.iter().rposition(|b| *b == b'\n') else {
        return vec![];
    };
    *offset += (end + 1) as u64;
    bytes[..=end]
        .split(|b| *b == b'\n')
        .filter_map(|s| serde_json::from_slice(s).ok())
        .collect()
}
