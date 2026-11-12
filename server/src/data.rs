use crate::{cli, core::*};
use serde_json::{Value, json};
use std::{
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
};
const MANIFEST: &str = "adata-manifest.json";
fn present(c: &Config, cache: bool, local: bool) -> Vec<(&'static str, &'static str)> {
    DATA_FILES
        .iter()
        .copied()
        .filter(|(n, k)| {
            c.data.join(n).exists()
                && (*k == "state" || cache && *k == "cache" || local && *k == "local")
        })
        .collect()
}
fn size(p: &Path) -> u64 {
    if p.is_file() {
        fs::metadata(p).map(|m| m.len()).unwrap_or(0)
    } else {
        walkdir::WalkDir::new(p)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
            .filter_map(|e| e.metadata().ok().map(|m| m.len()))
            .sum()
    }
}
fn human(n: u64) -> String {
    let mut x = n as f64;
    for u in ["B", "KB", "MB", "GB", "TB"] {
        if x < 1024. || u == "TB" {
            return format!("{x:.1}{u}");
        }
        x /= 1024.;
    }
    String::new()
}
fn archive(folder: &Path, names: &[String], output: &Path, manifest: Option<&Value>) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let f = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(output)
        .map_err(|e| e.to_string())?;
    f.set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|e| e.to_string())?;
    let zip = flate2::write::GzEncoder::new(f, flate2::Compression::default());
    let mut tar = tar::Builder::new(zip);
    tar.follow_symlinks(false);
    if let Some(m) = manifest {
        let b = serde_json::to_vec(m).map_err(|e| e.to_string())?;
        let mut h = tar::Header::new_gnu();
        h.set_size(b.len() as u64);
        h.set_mode(0o600);
        h.set_mtime(now() as u64);
        h.set_cksum();
        tar.append_data(&mut h, MANIFEST, b.as_slice())
            .map_err(|e| e.to_string())?;
    }
    for name in names {
        let p = folder.join(name);
        if fs::symlink_metadata(&p).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(format!("refusing symlink data entry: {name}"));
        }
        if p.is_dir() {
            tar.append_dir_all(name, &p)
        } else {
            tar.append_path_with_name(&p, name)
        }
        .map_err(|e| e.to_string())?;
    }
    tar.into_inner()
        .map_err(|e| e.to_string())?
        .finish()
        .map_err(|e| e.to_string())?;
    Ok(())
}
fn backup(folder: &Path, names: &[String], why: &str) -> Result<Option<PathBuf>> {
    let names = names
        .iter()
        .filter(|n| folder.join(n).exists())
        .cloned()
        .collect::<Vec<_>>();
    if names.is_empty() {
        return Ok(None);
    }
    let p = folder.join(format!(
        "adata-backup-{why}-{}.tar.gz",
        chrono::Local::now().format("%Y%m%d-%H%M%S")
    ));
    archive(folder, &names, &p, None)?;
    Ok(Some(p))
}
struct Stopped {
    restart: bool,
    domain: String,
    plist: PathBuf,
}
impl Stopped {
    fn new(force: bool) -> Result<Self> {
        let label = cli::env("DASH_LABEL").unwrap_or("local.agent-dashboard".into());
        let domain = format!("gui/{}", unsafe { libc::getuid() });
        let plist = home().join(format!("Library/LaunchAgents/{label}.plist"));
        let restart = command(
            "launchctl",
            &["print", &format!("{domain}/{label}")],
            None,
            5,
        )
        .is_ok();
        if restart {
            command(
                "launchctl",
                &["bootout", &format!("{domain}/{label}")],
                None,
                10,
            )?;
        }
        let guard = Self {
            restart,
            domain,
            plist,
        };
        let port = cli::env("DASH_PORT")
            .and_then(|v| v.parse::<u16>().ok())
            .unwrap_or(8787);
        if !force
            && std::net::TcpStream::connect_timeout(
                &format!("127.0.0.1:{port}").parse().unwrap(),
                std::time::Duration::from_millis(300),
            )
            .is_ok()
        {
            return Err(format!(
                "port {port} is in use; stop the manually started server first, or pass --force"
            ));
        }
        Ok(guard)
    }
}
impl Drop for Stopped {
    fn drop(&mut self) {
        if self.restart {
            if let Err(e) = command(
                "launchctl",
                &["bootstrap", &self.domain, self.plist.to_str().unwrap_or("")],
                None,
                10,
            ) {
                eprintln!("adata: failed to restart launchd agent: {e}");
            }
        }
    }
}
pub fn safe_member(p: &Path, regular: bool) -> bool {
    regular
        && !p.is_absolute()
        && p.components().all(|c| matches!(c, Component::Normal(_)))
        && p.components().count() == 1
        && DATA_FILES
            .iter()
            .any(|(n, k)| p == Path::new(n) && *k != "local")
}
fn remove(p: &Path) -> Result<()> {
    match fs::symlink_metadata(p) {
        Ok(m) if m.is_dir() && !m.file_type().is_symlink() => {
            fs::remove_dir_all(p).map_err(|e| e.to_string())
        }
        Ok(_) => fs::remove_file(p).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
fn copy_path(src: &Path, dst: &Path) -> Result<()> {
    let m = fs::symlink_metadata(src).map_err(|e| e.to_string())?;
    if m.file_type().is_symlink() {
        std::os::unix::fs::symlink(fs::read_link(src).map_err(|e| e.to_string())?, dst)
            .map_err(|e| e.to_string())?;
    } else if m.is_dir() {
        fs::create_dir_all(dst).map_err(|e| e.to_string())?;
        for e in fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
            copy_path(&e.path(), &dst.join(e.file_name()))?;
        }
    } else {
        fs::copy(src, dst).map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn option<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .map(String::as_str)
}
pub fn run(c: &Config, args: &[String]) -> Result<i32> {
    use std::os::unix::fs::PermissionsExt;
    let op = args.first().map(String::as_str).unwrap_or("");
    if op == "path" {
        println!("{}", c.data.display());
    } else if op == "ls" {
        println!("{}", c.data.display());
        for (n, k) in present(c, true, true) {
            let p = c.data.join(n);
            println!(
                "{k:<5}  {:>10}  {}  {n}",
                human(size(&p)),
                chrono::DateTime::from_timestamp(mtime(&p) as i64, 0)
                    .map(|t| t.to_rfc3339())
                    .unwrap_or_default()
            );
        }
    } else if op == "export" {
        let files = present(c, args.iter().any(|s| s == "--with-cache"), false);
        if files.is_empty() {
            return Err(format!("nothing to export in {}", c.data.display()));
        }
        let default = format!(
            "adash-data-{}-{}.tar.gz",
            command("hostname", &["-s"], None, 3)
                .unwrap_or("host".into())
                .trim(),
            chrono::Local::now().format("%Y%m%d-%H%M")
        );
        let output = absolute(
            option(args, "--output")
                .or_else(|| option(args, "-o"))
                .unwrap_or(&default),
        );
        let file_kinds = files
            .iter()
            .map(|(n, k)| ((*n).to_owned(), json!(k)))
            .collect::<serde_json::Map<_, _>>();
        let manifest = json!({"from":command("hostname",&[],None,3).unwrap_or_default().trim(),"data":c.data,"home":home(),"at":iso(),"files":file_kinds});
        archive(
            &c.data,
            &files
                .iter()
                .map(|(n, _)| (*n).to_owned())
                .collect::<Vec<_>>(),
            &output,
            Some(&manifest),
        )?;
        for (n, k) in files {
            println!("  {k:<5}  {n}");
        }
        println!("{} ({})", output.display(), human(size(&output)));
    } else if op == "import" {
        let input = absolute(args.get(1).ok_or("import needs FILE")?);
        let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(
            fs::File::open(&input).map_err(|e| e.to_string())?,
        ));
        let mut manifest = None;
        let mut names = vec![];
        for entry in tar.entries().map_err(|e| e.to_string())? {
            let e = entry.map_err(|e| e.to_string())?;
            let p = e.path().map_err(|e| e.to_string())?.into_owned();
            if p == Path::new(MANIFEST) {
                let mut raw = String::new();
                e.take(1 << 20)
                    .read_to_string(&mut raw)
                    .map_err(|e| e.to_string())?;
                manifest = serde_json::from_str::<Value>(&raw).ok();
            } else if safe_member(&p, e.header().entry_type().is_file()) {
                names.push(p.to_string_lossy().into_owned());
            } else {
                println!("  skip   {}", p.display());
            }
        }
        let manifest = manifest
            .ok_or("archive has no valid adata-manifest.json — not made by adata export")?;
        names.sort();
        names.dedup();
        fs::create_dir_all(&c.data).map_err(|e| e.to_string())?;
        let _stop = Stopped::new(args.iter().any(|s| s == "--force"))?;
        if let Some(p) = backup(&c.data, &names, "import")? {
            println!("replaced files backed up: {}", p.display());
        }
        for n in &names {
            remove(&c.data.join(n))?;
        }
        let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(
            fs::File::open(&input).map_err(|e| e.to_string())?,
        ));
        for e in tar.entries().map_err(|e| e.to_string())? {
            let mut e = e.map_err(|e| e.to_string())?;
            let p = e.path().map_err(|e| e.to_string())?.into_owned();
            if safe_member(&p, e.header().entry_type().is_file()) {
                let dst = c.data.join(&p);
                let mut f = fs::OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(&dst)
                    .map_err(|e| e.to_string())?;
                f.set_permissions(fs::Permissions::from_mode(0o600))
                    .map_err(|e| e.to_string())?;
                std::io::copy(&mut e, &mut f).map_err(|e| e.to_string())?;
                println!("  in     {}", p.display());
            }
        }
        println!(
            "from {} ({}) → {}",
            text(&manifest["from"]),
            text(&manifest["at"]),
            c.data.display()
        );
        if manifest["home"] != json!(home()) {
            println!(
                "the old machine's home was {} — run adata check for paths to fix",
                text(&manifest["home"])
            );
        }
    } else if op == "migrate" {
        let default = c.here.join("data");
        let dest = absolute(option(args, "--to").unwrap_or(default.to_str().unwrap_or("data")));
        if real(&dest) == real(&c.data) {
            println!("already in {}", dest.display());
            return Ok(0);
        }
        let files = present(c, true, true);
        if files.is_empty() {
            return Err(format!("nothing to move in {}", c.data.display()));
        }
        let force = args.iter().any(|s| s == "--force");
        let clashes = files
            .iter()
            .filter(|(n, _)| dest.join(n).exists())
            .map(|(n, _)| (*n).to_owned())
            .collect::<Vec<_>>();
        if !clashes.is_empty() && !force {
            return Err(format!(
                "{} already holds {} — pass --force to replace them",
                dest.display(),
                clashes.join(", ")
            ));
        }
        let _stop = Stopped::new(force)?;
        fs::create_dir_all(&dest)
            .and_then(|_| fs::set_permissions(&dest, fs::Permissions::from_mode(0o700)))
            .map_err(|e| e.to_string())?;
        let _ = backup(&dest, &clashes, "migrate")?;
        for (n, k) in files {
            let src = c.data.join(n);
            let dst = dest.join(n);
            remove(&dst)?;
            if fs::rename(&src, &dst).is_err() {
                copy_path(&src, &dst)?;
                remove(&src)?;
            }
            println!("  {k:<5}  {n}");
        }
        let label = cli::env("DASH_LABEL").unwrap_or("local.agent-dashboard".into());
        let plist = home().join(format!("Library/LaunchAgents/{label}.plist"));
        if plist.is_file() {
            for (k, v) in [
                ("StandardOutPath", dest.join("server.log")),
                ("StandardErrorPath", dest.join("server.log")),
                ("EnvironmentVariables.ADASH_DATA", dest.clone()),
            ] {
                command(
                    "plutil",
                    &[
                        "-replace",
                        k,
                        "-string",
                        v.to_str().unwrap_or(""),
                        plist.to_str().unwrap_or(""),
                    ],
                    None,
                    5,
                )?;
            }
        }
        println!("{} → {}", c.data.display(), dest.display());
        if dest != default {
            println!(
                "outside server/data: export ADASH_DATA={} for the CLIs too",
                dest.display()
            );
        }
    } else if op == "check" {
        let prefs = read_json(c.data.join("prefs.json"));
        if !prefs.is_object() {
            return Err("cannot read prefs.json".into());
        }
        let mut missing = vec![];
        fn walk(v: &Value, where_: String, out: &mut Vec<(String, String)>) {
            if let Some(o) = v.as_object() {
                for (k, v) in o {
                    walk(
                        v,
                        if where_.is_empty() {
                            k.clone()
                        } else {
                            format!("{where_}.{k}")
                        },
                        out,
                    );
                }
            } else if let Some(a) = v.as_array() {
                for (i, v) in a.iter().enumerate() {
                    walk(v, format!("{where_}[{i}]"), out);
                }
            } else if let Some(s) = v.as_str() {
                if (s.starts_with('/') || s.starts_with("~/"))
                    && !s.contains('\n')
                    && s.len() < 1024
                    && !expand(s).exists()
                {
                    out.push((where_, s.into()));
                }
            }
        }
        walk(&prefs, String::new(), &mut missing);
        for (k, v) in &missing {
            println!("  {k}: {v}");
        }
        println!(
            "{}",
            if missing.is_empty() {
                "every path in prefs.json exists".into()
            } else {
                format!(
                    "{} path(s) in prefs.json not found on this machine",
                    missing.len()
                )
            }
        );
    } else {
        return Err("usage: adata path | ls | export [-o FILE] [--with-cache] | import FILE [--force] | migrate [--to DIR] [--force] | check".into());
    }
    Ok(0)
}
