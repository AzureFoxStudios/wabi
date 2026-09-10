//! Explicitly granted, manual local workspaces. No watcher, shell, or shared Lore staging.
//! Tokens are used for one request only and are never written to the workspace index.
use std::{collections::HashMap, fs, io::{Read, Write}, path::{Path, PathBuf}, sync::{Arc, Mutex, atomic::{AtomicU64, Ordering}}, time::Duration};
use anyhow::{anyhow, bail, Context, Result};
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use url::Url;

const META: &str = ".wabi-workspace";
const MAX_TRANSFER: u64 = 1024 * 1024 * 1024;
const MAX_INDEX: u64 = 8 * 1024 * 1024;
static NEXT: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
struct Grant {
    root: PathBuf,
    window: String,
    server: Url,
    channel: i64,
    identity: String,
    gate: Arc<tokio::sync::Mutex<()>>,
}
#[derive(Default)]
pub struct LocalWorkspaceState(Mutex<HashMap<String, Grant>>);
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection { handle: String, folder: String, identity: String, state: Value }
#[derive(Serialize)]
pub struct LocalFile { path: String, hash: String, size: u64 }
#[derive(Serialize)]
pub struct Scan { files: Vec<LocalFile>, ignore: String }

fn unique() -> String {
    format!("{}-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos(), NEXT.fetch_add(1, Ordering::Relaxed))
}
fn valid_path(path: &str) -> bool {
    !path.is_empty() && path.len() <= 4096 && !path.chars().any(|c| c.is_control() || c == '\\' || c == ':')
        && path.split('/').all(|p| {
            let stem = p.split('.').next().unwrap_or("").to_ascii_uppercase();
            !p.is_empty() && p != "." && p != ".." && !p.ends_with('.') && !p.ends_with(' ')
                && !["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"].contains(&stem.as_str())
        })
}
fn internal(path: &str) -> bool {
    path.split('/').any(|p| [".git", ".lore", ".wabi-sync", META, ".wabi-sync.json", ".wabiignore", ".loreignore", ".wabi-repo.json", ".ssh", ".gnupg", "node_modules", "target", ".svelte-kit", "build", "dist", "data", "logs", ".DS_Store"].contains(&p)
        || p.starts_with(".env") || p.contains(".wabi-conflict-"))
}
fn grant(state: &LocalWorkspaceState, window: &WebviewWindow, handle: &str) -> Result<Grant> {
    let grants = state.0.lock().map_err(|_| anyhow!("Workspace registry unavailable"))?;
    let g = grants.get(handle).context("Reconnect this local folder")?;
    if g.window != window.label() { bail!("This window has no access to that local folder"); }
    Ok(g.clone())
}
/// Check every existing component, not just a prefix string. Never traverse symlinks.
fn checked(root: &Path, relative: &str, private: bool) -> Result<PathBuf> {
    if !valid_path(relative) || (!private && internal(relative)) { bail!("Unsafe or excluded path: {relative}"); }
    if fs::symlink_metadata(root)?.file_type().is_symlink() || root.canonicalize()?.as_path() != root { bail!("Linked root or an ancestor became a symlink"); }
    let mut path = root.to_path_buf();
    for part in relative.split('/') {
        path.push(part);
        match fs::symlink_metadata(&path) {
            Ok(m) if m.file_type().is_symlink() => bail!("Symlink paths are not supported: {relative}"),
            Ok(_) => {},
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {},
            Err(e) => return Err(e.into()),
        }
    }
    Ok(path)
}
fn meta_dir(root: &Path) -> Result<PathBuf> {
    let path = checked(root, META, true)?;
    fs::create_dir_all(&path)?;
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; fs::set_permissions(&path, fs::Permissions::from_mode(0o700))?; }
    Ok(path)
}
fn current_hash(path: &Path) -> Result<Option<String>> {
    match fs::symlink_metadata(path) {
        Ok(meta) if !meta.is_file() || meta.file_type().is_symlink() => bail!("Expected a non-symlink regular file: {}", path.display()),
        Ok(_) => {},
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    }
    let mut file = match fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    if !file.metadata()?.is_file() { bail!("Expected a regular file: {}", path.display()); }
    let mut hash = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop { let n = file.read(&mut buf)?; if n == 0 { break; } hash.update(&buf[..n]); }
    Ok(Some(format!("{:x}", hash.finalize())))
}
fn assert_local(g: &Grant, path: &str, expected: &Option<String>) -> Result<PathBuf> {
    let target = checked(&g.root, path, false)?;
    if current_hash(&target)? != *expected { bail!("{path} changed locally. Rescan and review it before retrying."); }
    Ok(target)
}
fn read_index(g: &Grant) -> Result<Value> {
    let mut path = checked(&g.root, &format!("{META}/state.json"), true)?;
    if !path.exists() {
        let previous = checked(&g.root, &format!("{META}/state.previous.json"), true)?;
        if previous.exists() { path = previous; } else { return Ok(Value::Null); }
    }
    let metadata = fs::metadata(&path)?;
    if !metadata.is_file() || metadata.len() > MAX_INDEX { bail!("Workspace index must be a regular file under 8 MiB"); }
    let value: Value = serde_json::from_slice(&fs::read(path)?)?;
    if value["version"] != 1 || value["identity"].as_str() != Some(g.identity.as_str()) {
        bail!("This folder is linked to another account, server, or project. Choose a different folder.");
    }
    Ok(value)
}
/// Use a durable backup before replacing a file (including metadata). Never discard local bytes.
fn replace_with_backup(g: &Grant, target: &Path, temp: Option<&Path>, expected: &Option<String>) -> Result<()> {
    let backup_root = checked(&g.root, &format!("{META}/backups"), true)?;
    fs::create_dir_all(&backup_root)?;
    let backup = backup_root.join(unique());
    let existed = target.exists();
    if existed {
        let record = backup_root.join(format!("{}.json", backup.file_name().unwrap().to_string_lossy()));
        fs::write(&record, serde_json::to_vec(&json!({"originalPath": target.strip_prefix(&g.root)?.to_string_lossy(), "backup": backup.file_name().unwrap().to_string_lossy()}))?)?;
        fs::rename(target, &backup)?;
        if current_hash(&backup)? != *expected {
            // Do not overwrite a file recreated by an editor after the rename.
            if !target.exists() { fs::hard_link(&backup, target)?; }
            bail!("Local file changed during replacement; it is preserved in .wabi-workspace/backups");
        }
    } else if expected.is_some() { bail!("Local file disappeared during replacement; retry the scan"); }
    if let Some(source) = temp {
        if let Err(error) = fs::hard_link(source, target) {
            if existed && !target.exists() { fs::hard_link(&backup, target).context("Replacement failed; original remains in .wabi-workspace/backups")?; }
            return Err(error.into());
        }
    }
    Ok(())
}
struct Temp(PathBuf);
impl Drop for Temp { fn drop(&mut self) { let _ = fs::remove_file(&self.0); } }
fn temp_file(g: &Grant) -> Result<(Temp, fs::File)> {
    let path = meta_dir(&g.root)?.join(format!("transfer-{}", unique()));
    let mut options = fs::OpenOptions::new(); options.write(true).create_new(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    let file = options.open(&path)?;
    Ok((Temp(path), file))
}
fn endpoint(g: &Grant, path: &str) -> Result<Url> {
    let mut url = g.server.clone();
    url.path_segments_mut().map_err(|_| anyhow!("Invalid server URL"))?.pop_if_empty()
        .extend(["api", "addons", "lore", "repos", &g.channel.to_string(), "files", path]);
    Ok(url)
}
fn client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(300)).build()?)
}
async fn response_ok(resp: reqwest::Response) -> Result<reqwest::Response> {
    match resp.status().as_u16() {
        200..=299 => Ok(resp),
        401 => bail!("Session expired. Sign in again; no local files were overwritten."),
        403 => bail!("The server denied this operation. Check project membership and permissions."),
        409 | 412 => bail!("The server file changed. Refresh and resolve the conflict before retrying."),
        code => bail!("Lore request failed (HTTP {code}); the selection was retained. Check server status before retrying."),
    }
}

#[tauri::command]
pub async fn lore_local_choose(app: tauri::AppHandle, window: WebviewWindow, state: State<'_, LocalWorkspaceState>, server_url: String, channel_id: i64, account_id: String) -> Result<Option<Connection>, String> {
    let mut server = Url::parse(&server_url).map_err(|_| "Invalid server URL")?;
    if !["http", "https"].contains(&server.scheme()) || server.host_str().is_none() || !server.username().is_empty() || server.password().is_some() || server.query().is_some() || server.fragment().is_some() || channel_id <= 0 || account_id.is_empty() {
        return Err("A signed-in account and an HTTP(S) Wabi server are required".into());
    }
    let base_path = server.path().trim_end_matches('/').to_string();
    server.set_path(&base_path);
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().set_title("Choose a folder for manual Wabi staging").pick_folder(move |folder| { let _ = tx.send(folder); });
    let Some(folder) = rx.await.map_err(|_| "Folder selection cancelled")? else { return Ok(None); };
    let root = folder.into_path().map_err(|_| "A local filesystem folder is required")?.canonicalize().map_err(|e| e.to_string())?;
    if !root.is_dir() { return Err("Choose a folder".into()); }
    if fs::symlink_metadata(root.join(".wabi-sync.json")).is_ok() { return Err("This folder is linked to automatic wabi-sync. Choose a separate folder for manual staging; do not run both workflows on the same folder.".into()); }
    let identity = serde_json::to_string(&(server.as_str(), &account_id, channel_id)).map_err(|e| e.to_string())?;
    let mut grants = state.0.lock().map_err(|_| "Workspace registry unavailable")?;
    if let Some((handle, existing)) = grants.iter().find(|(_, g)| g.root == root) {
        if existing.identity != identity || existing.window != window.label() { return Err("This folder is already connected in another project or window".into()); }
        return Ok(Some(Connection { handle: handle.clone(), folder: root.to_string_lossy().into(), identity, state: read_index(existing).map_err(|e| e.to_string())? }));
    }
    if grants.len() >= 128 { return Err("Too many local folder grants. Restart Wabi to release them.".into()); }
    let g = Grant { root: root.clone(), window: window.label().into(), server, channel: channel_id, identity: identity.clone(), gate: Arc::new(tokio::sync::Mutex::new(())) };
    let saved = read_index(&g).map_err(|e| e.to_string())?;
    let handle = unique();
    grants.insert(handle.clone(), g);
    Ok(Some(Connection { handle, folder: root.to_string_lossy().into(), identity, state: saved }))
}

#[tauri::command]
pub async fn lore_local_scan(window: WebviewWindow, state: State<'_, LocalWorkspaceState>, handle: String) -> Result<Scan, String> {
    let g = grant(&state, &window, &handle).map_err(|e| e.to_string())?;
    let _guard = g.gate.lock().await;
    let root = g.root.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<Scan> {
        fn walk(root: &Path, dir: &Path, files: &mut Vec<LocalFile>, depth: usize) -> Result<()> {
            if depth > 64 { bail!("Folder nesting is too deep; scan stopped without publishing"); }
            for entry in fs::read_dir(dir)? {
                let entry = entry?;
                let path = entry.path();
                let relative = path.strip_prefix(root)?.components()
                    .map(|part| part.as_os_str().to_str().context("Non-Unicode project filename"))
                    .collect::<Result<Vec<_>>>()?.join("/");
                if internal(&relative) { continue; }
                if !valid_path(&relative) { bail!("Unsupported project filename: {relative}"); }
                let ty = entry.file_type()?;
                if ty.is_symlink() { bail!("Symlink in project: {relative}. Scan stopped to avoid treating skipped files as deletions."); }
                if ty.is_dir() { walk(root, &path, files, depth + 1)?; }
                else if ty.is_file() {
                    if files.len() >= 100_000 { bail!("Project scan exceeds 100,000 files"); }
                    let hash = current_hash(&path)?.context("File disappeared during scan; retry")?;
                    files.push(LocalFile { path: relative, hash, size: entry.metadata()?.len() });
                } else { bail!("Unsupported filesystem entry: {relative}"); }
            }
            Ok(())
        }
        checked(&root, "scan-probe", true)?;
        let mut files = Vec::new(); walk(&root, &root, &mut files, 0)?;
        let ignore_path = checked(&root, ".wabiignore", true)?;
        let ignore = match fs::metadata(&ignore_path) {
            Ok(meta) => { if !meta.is_file() || meta.len() > 64 * 1024 { bail!(".wabiignore must be a regular file under 64 KiB"); } fs::read_to_string(ignore_path)? },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(e) => return Err(e.into()),
        };
        Ok(Scan { files, ignore })
    }).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn lore_local_save_state(window: WebviewWindow, state: State<'_, LocalWorkspaceState>, handle: String, index: Value) -> Result<(), String> {
    let g = grant(&state, &window, &handle).map_err(|e| e.to_string())?;
    let _guard = g.gate.lock().await;
    let job = g.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<()> {
        if index["version"] != 1 || index["identity"].as_str() != Some(job.identity.as_str()) { bail!("Workspace identity mismatch"); }
        let bytes = serde_json::to_vec(&index)?;
        if bytes.len() as u64 > MAX_INDEX { bail!("Workspace index too large"); }
        let (temp, mut file) = temp_file(&job)?; file.write_all(&bytes)?; file.sync_all()?; drop(file);
        let target = checked(&job.root, &format!("{META}/state.json"), true)?;
        // Keep one prior index, not a growing full-index backup on every checkbox click.
        let previous = checked(&job.root, &format!("{META}/state.previous.json"), true)?;
        if target.exists() {
            if previous.exists() { fs::remove_file(&previous)?; }
            fs::rename(&target, &previous)?;
        } // If recovering from a previous-only index, retain it until replacement succeeds.
        if let Err(e) = fs::rename(&temp.0, &target) {
            if previous.exists() { fs::rename(&previous, &target)?; }
            return Err(e.into());
        }
        Ok(())
    }).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn lore_local_open(window: WebviewWindow, state: State<'_, LocalWorkspaceState>, handle: String) -> Result<(), String> {
    let g = grant(&state, &window, &handle).map_err(|e| e.to_string())?;
    open::that(g.root).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn lore_local_publish(window: WebviewWindow, state: State<'_, LocalWorkspaceState>, handle: String, path: String, local_hash: Option<String>, remote_etag: Option<String>, token: String, message: String) -> Result<Value, String> {
    let g = grant(&state, &window, &handle).map_err(|e| e.to_string())?;
    let _guard = g.gate.lock().await;
    async {
        if message.trim().is_empty() || message.len() > 8000 || token.is_empty() { bail!("A summary and active session are required"); }
        let target = assert_local(&g, &path, &local_hash)?;
        let http = client()?;
        let mut repo_url = g.server.clone();
        repo_url.path_segments_mut().map_err(|_| anyhow!("Invalid server URL"))?.pop_if_empty()
            .extend(["api", "addons", "lore", "repos", &g.channel.to_string()]);
        let repo: Value = response_ok(http.get(repo_url).bearer_auth(&token).send().await?).await?.json().await?;
        if repo["auto_branch_on_upload"].as_bool().or_else(|| repo["autoBranchOnUpload"].as_bool()).unwrap_or(false) {
            bail!("This project requires review. Use the Repository review workflow; manual desktop publishing does not bypass it.");
        }
        let url = endpoint(&g, &path)?;
        if local_hash.is_none() {
            let expected = remote_etag.as_ref().context("Cannot delete an untracked remote file")?;
            response_ok(http.delete(url).bearer_auth(&token).header("If-Match", format!("\"{expected}\""))
                .json(&json!({"message": message})).send().await?).await?;
            return Ok(json!({"localHash": null, "remoteEtag": null, "pendingReview": false}));
        }
        if fs::metadata(&target)?.len() > MAX_TRANSFER { bail!("This desktop transfer exceeds the 1 GiB safety limit"); }
        // Upload a private, fingerprint-verified snapshot, never a live editor file.
        let snapshot_grant = g.clone(); let expected = local_hash.clone();
        let temp = tauri::async_runtime::spawn_blocking(move || -> Result<Temp> {
            let (temp, file) = temp_file(&snapshot_grant)?; drop(file);
            fs::copy(&target, &temp.0)?;
            if current_hash(&temp.0)? != expected { bail!("File changed after staging. Review and stage it again."); }
            Ok(temp)
        }).await??;
        let length = fs::metadata(&temp.0)?.len();
        let file = tokio::fs::File::open(&temp.0).await?;
        let stream = futures_util::stream::try_unfold(file, |mut file| async move {
            let mut buffer = vec![0u8; 64 * 1024];
            let n = file.read(&mut buffer).await?;
            if n == 0 { Ok::<_, std::io::Error>(None) } else { buffer.truncate(n); Ok(Some((bytes::Bytes::from(buffer), file))) }
        });
        let resp = response_ok(http.put(url).query(&[("message", message.as_str())]).bearer_auth(&token)
            .header("Content-Type", "application/octet-stream").header("Content-Length", length.to_string())
            .header("If-Match", format!("\"{}\"", remote_etag.as_deref().unwrap_or("")))
            .body(reqwest::Body::wrap_stream(stream)).send().await?).await?;
        let body: Value = resp.json().await?;
        let etag = body["etag"].as_str().filter(|s| !s.is_empty()).context("Upload accepted without an ETag. Refresh before retrying.")?;
        Ok(json!({"localHash": local_hash, "remoteEtag": etag,
            "pendingReview": body["pending_review"].as_bool().or_else(|| body["pendingReview"].as_bool()).unwrap_or(false),
            "warning": if body["wdbRecorded"] == false { Some("File accepted, but the server could not record its activity event.") } else { None }}))
    }.await.map_err(|e: anyhow::Error| e.to_string())
}

#[tauri::command]
pub async fn lore_local_pull(window: WebviewWindow, state: State<'_, LocalWorkspaceState>, handle: String, path: String, local_hash: Option<String>, remote_etag: Option<String>, token: String) -> Result<Value, String> {
    let g = grant(&state, &window, &handle).map_err(|e| e.to_string())?;
    let _guard = g.gate.lock().await;
    async {
        let target = assert_local(&g, &path, &local_hash)?;
        let resp = client()?.get(endpoint(&g, &path)?).bearer_auth(&token).send().await?;
        if remote_etag.is_none() {
            if local_hash.is_none() { bail!("No tracked local file to remove"); }
            // A hidden/unreadable repo may also return 404. Prove the repo is readable
            // and the path really is absent before moving any local file.
            let mut manifest_url = g.server.clone();
            manifest_url.path_segments_mut().map_err(|_| anyhow!("Invalid server URL"))?.pop_if_empty()
                .extend(["api", "addons", "lore", "repos", &g.channel.to_string(), "manifest"]);
            let manifest: Value = response_ok(client()?.get(manifest_url).bearer_auth(&token).send().await?).await?.json().await?;
            let files = manifest["files"].as_array().context("Invalid remote manifest")?;
            if files.iter().any(|file| file["path"].as_str() == Some(path.as_str())) { bail!("Remote file is no longer deleted; refresh"); }
            if resp.status() != reqwest::StatusCode::NOT_FOUND { bail!("Remote deletion changed; refresh before pulling"); }
            // Local deletion is reversible: move the old version to the workspace backup area.
            assert_local(&g, &path, &local_hash)?;
            replace_with_backup(&g, &target, None, &local_hash)?;
            return Ok(json!({"localHash":null,"remoteEtag":null}));
        }
        let resp = response_ok(resp).await?;
        let etag = resp.headers().get("ETag").and_then(|v| v.to_str().ok()).map(|s| s.trim_matches('"').to_string());
        if etag != remote_etag { bail!("Server version changed during download. Refresh and retry."); }
        if resp.content_length().is_some_and(|n| n > MAX_TRANSFER) { bail!("This desktop transfer exceeds the 1 GiB safety limit"); }
        let (temp, file) = temp_file(&g)?; drop(file);
        let mut file = tokio::fs::OpenOptions::new().write(true).open(&temp.0).await?;
        let mut stream = resp.bytes_stream(); let mut total = 0u64; let mut hash = Sha256::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?; total += chunk.len() as u64;
            if total > MAX_TRANSFER { bail!("Download exceeded the 1 GiB safety limit"); }
            file.write_all(&chunk).await?; hash.update(&chunk);
        }
        file.sync_all().await?; drop(file);
        let downloaded_hash = format!("{:x}", hash.finalize());
        // Editors may save while the network transfer runs. Check again immediately before replacing.
        assert_local(&g, &path, &local_hash)?;
        if let Some(parent) = target.parent() { fs::create_dir_all(parent)?; }
        checked(&g.root, &path, false)?;
        replace_with_backup(&g, &target, Some(&temp.0), &local_hash)?;
        Ok(json!({"localHash":downloaded_hash,"remoteEtag":remote_etag}))
    }.await.map_err(|e: anyhow::Error| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn rejects_unsafe_paths() {
        for p in ["../x", "/x", "a//b", "a/../b", "C:x", "a\\b", "CON.txt", "file.", "a\0b"] { assert!(!valid_path(p), "{p}"); }
        assert!(valid_path("characters/rynar.blend"));
    }
    #[test] fn protects_internal_and_secret_files() {
        for p in [".env", "nested/.env.local", ".git/config", ".wabi-workspace/state.json", ".ssh/id_rsa", "target/bin"] { assert!(internal(p), "{p}"); }
    }
    #[test] fn full_hash_known_vector() {
        assert_eq!(format!("{:x}", Sha256::digest(b"hello world")), "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
    }
    #[cfg(unix)]
    #[test] fn rejects_symlink_escape() {
        let root = std::env::temp_dir().join(format!("wabi-local-test-{}", unique()));
        fs::create_dir(&root).unwrap();
        std::os::unix::fs::symlink(std::env::temp_dir(), root.join("escape")).unwrap();
        assert!(checked(&root, "escape/secret", false).is_err());
        fs::remove_file(root.join("escape")).unwrap(); fs::remove_dir(root).unwrap();
    }
}
