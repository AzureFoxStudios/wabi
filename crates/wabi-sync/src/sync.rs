//! The sync engine: three-way pull/push using etag baselines, conflict
//! copies, ignore-aware local walking, and the watch loop.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context};

use crate::api::{UploadOutcome, WabiClient};
use crate::config::{LinkConfig, SyncState, LINK_FILE, STATE_DIR};
use crate::etag::{etag_for_bytes, etag_for_file};

/// Paths never synced regardless of ignore files.
fn is_internal(rel: &str) -> bool {
    rel == LINK_FILE
        || rel == ".wabiignore"
        || rel == ".loreignore"
        || rel == ".wabi-repo.json"
        || rel.starts_with(&(STATE_DIR.to_string() + "/"))
        || rel.starts_with(".lore/")
        || rel.starts_with(".git/")
}

/// Glob-style `.wabiignore` matching: `**` spans `/`, `*` within a segment.
/// A leading `!` negates (last matching pattern wins, like gitignore), and
/// patterns also match ancestor directories — `node_modules` ignores
/// everything beneath it.
pub fn ignored(rel: &str, patterns: &[(bool, String)]) -> bool {
    let mut result = false;
    let mut candidates = vec![rel.to_string()];
    let mut cur = rel;
    while let Some(idx) = cur.rfind('/') {
        cur = &cur[..idx];
        candidates.push(cur.to_string());
    }
    for (negated, pattern) in patterns {
        if candidates.iter().any(|c| glob_match(pattern, c)) {
            result = !*negated;
        }
    }
    result
}

pub fn glob_match(pattern: &str, path: &str) -> bool {
    fn inner(p: &[u8], s: &[u8]) -> bool {
        match (p.first(), s.first()) {
            (None, None) => true,
            (None, Some(_)) => false,
            (Some(b'*'), _) => {
                if p.starts_with(b"**") {
                    let rest = &p[2..];
                    for i in 0..=s.len() {
                        if inner(rest, &s[i..]) {
                            return true;
                        }
                    }
                    if !rest.is_empty() && rest[0] == b'/' {
                        let rest2 = &rest[1..];
                        for i in 0..=s.len() {
                            if inner(rest2, &s[i..]) {
                                return true;
                            }
                        }
                    }
                    false
                } else {
                    let rest = &p[1..];
                    if rest.is_empty() {
                        return !s.contains(&b'/');
                    }
                    for i in 0..=s.len() {
                        if s.get(i) == Some(&b'/') {
                            break;
                        }
                        if inner(rest, &s[i..]) {
                            return true;
                        }
                    }
                    false
                }
            }
            (Some(&c), Some(&d)) => c == d && inner(&p[1..], &s[1..]),
            (Some(_), None) => false,
        }
    }
    inner(pattern.as_bytes(), path.as_bytes())
}

/// Parse `.wabiignore` into (negated, pattern) pairs.
pub fn load_ignore_patterns(folder: &Path) -> Vec<(bool, String)> {
    let Ok(raw) = std::fs::read_to_string(folder.join(".wabiignore")) else {
        return Vec::new();
    };
    raw.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(|l| {
            if let Some(p) = l.strip_prefix('!') {
                (true, p.trim().trim_end_matches('/').to_string())
            } else {
                (false, l.trim_end_matches('/').to_string())
            }
        })
        .collect()
}

/// Walk the folder and collect (relative_path, local_etag) for syncable files.
pub fn scan_local(folder: &Path) -> anyhow::Result<BTreeMap<String, String>> {
    let patterns = load_ignore_patterns(folder);
    let mut out = BTreeMap::new();
    fn walk(
        dir: &Path,
        folder: &Path,
        patterns: &[(bool, String)],
        out: &mut BTreeMap<String, String>,
    ) -> anyhow::Result<()> {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            let Ok(rel) = path.strip_prefix(folder) else { continue };
            let rel = rel.to_string_lossy().replace('\\', "/");
            if path.is_dir() {
                if !is_internal(&format!("{rel}/")) && !ignored(&rel, patterns) {
                    walk(&path, folder, patterns, out)?;
                }
                continue;
            }
            if is_internal(&rel) || ignored(&rel, patterns) {
                continue;
            }
            let etag = etag_for_file(&path)
                .with_context(|| format!("hashing {}", path.display()))?;
            out.insert(rel, etag);
        }
        Ok(())
    }
    walk(folder, folder, &patterns, &mut out)?;
    Ok(out)
}

/// Where a conflict copy goes: `dir/name.ext` → `dir/name.ext.wabi-conflict-ab12cd34`.
fn conflict_path(local: &Path, tag: &str) -> PathBuf {
    let mut s = local.as_os_str().to_os_string();
    s.push(format!(".wabi-conflict-{tag}"));
    PathBuf::from(s)
}

pub struct SyncReport {
    pub downloaded: Vec<String>,
    pub uploaded: Vec<String>,
    pub deleted_local: Vec<String>,
    pub deleted_remote: Vec<String>,
    pub conflicts: Vec<String>,
}

impl SyncReport {
    fn new() -> Self {
        Self {
            downloaded: Vec::new(),
            uploaded: Vec::new(),
            deleted_local: Vec::new(),
            deleted_remote: Vec::new(),
            conflicts: Vec::new(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.downloaded.is_empty()
            && self.uploaded.is_empty()
            && self.deleted_local.is_empty()
            && self.deleted_remote.is_empty()
            && self.conflicts.is_empty()
    }
}

pub struct SyncEngine<'a> {
    pub client: &'a WabiClient,
    pub folder: &'a Path,
    pub link: &'a LinkConfig,
    pub state: SyncState,
}

impl<'a> SyncEngine<'a> {
    pub fn new(client: &'a WabiClient, folder: &'a Path, link: &'a LinkConfig) -> Self {
        Self {
            client,
            folder,
            link,
            state: SyncState::load(folder).unwrap_or_default(),
        }
    }

    pub fn save_state(&self) -> anyhow::Result<()> {
        self.state.save(self.folder)
    }

    /// Pull remote changes down (three-way against baselines).
    pub async fn pull(&mut self) -> anyhow::Result<SyncReport> {
        let mut report = SyncReport::new();
        let manifest = self.client.manifest(self.link.channel_id).await?;
        if manifest.read_only {
            bail!("this repo is a read-only mirror; wabi-sync cannot sync it");
        }
        let local = scan_local(self.folder)?;
        let remote: BTreeMap<&str, &Option<String>> = manifest
            .files
            .iter()
            .map(|f| (f.path.as_str(), &f.etag))
            .collect();

        // Remote files: download new/changed when we have no diverging local edit.
        for (path, remote_etag) in &remote {
            let remote_etag = remote_etag.as_deref().unwrap_or("");
            let baseline = self.state.baselines.get(*path).cloned().flatten();
            let local_etag = local.get(*path);
            let remote_changed = baseline.as_deref().unwrap_or("") != remote_etag;
            let local_has = local_etag.is_some();
            if remote_changed {
                let local_clean = match (local_etag, &baseline) {
                    (Some(le), Some(b)) => Some(le.as_str()) == Some(b.as_str()),
                    (None, b) => b.is_none(), // both absent → clean
                    (Some(_), None) => false, // local-only file → diverged
                };
                if !local_has || local_clean {
                    let bytes = self
                        .client
                        .download(self.link.channel_id, path, None)
                        .await?
                        .context("server listed the file but download returned 304")?;
                    let full = self.folder.join(path);
                    if let Some(parent) = full.parent() {
                        std::fs::create_dir_all(parent)?;
                    }
                    std::fs::write(&full, &bytes)?;
                    report.downloaded.push(path.to_string());
                    self.state.baselines.insert(
                        path.to_string(),
                        Some(etag_for_bytes(&bytes)),
                    );
                } else {
                    // Both sides changed → keep both, server wins the canonical name.
                    let tag = remote_etag.chars().take(8).collect::<String>();
                    let local_file = self.folder.join(path);
                    let copy = conflict_path(&local_file, &tag);
                    std::fs::rename(&local_file, &copy)?;
                    let bytes = self
                        .client
                        .download(self.link.channel_id, path, None)
                        .await?
                        .context("conflict download failed")?;
                    std::fs::write(&local_file, &bytes)?;
                    report.conflicts.push(format!(
                        "{path} (your version saved as {})",
                        copy.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
                    ));
                    self.state.baselines.insert(
                        path.to_string(),
                        Some(etag_for_bytes(&bytes)),
                    );
                }
            }
        }

        // Baseline files that vanished remotely → delete locally when clean.
        let baseline_paths: Vec<String> = self.state.baselines.keys().cloned().collect();
        for path in baseline_paths {
            if remote.contains_key(path.as_str()) {
                continue;
            }
            let baseline = self.state.baselines.get(&path).cloned().flatten();
            if baseline.is_none() {
                self.state.baselines.remove(&path);
                continue;
            }
            let local_etag = local.get(&path);
            let local_clean = local_etag.map(|le| Some(le.as_str()) == baseline.as_deref()).unwrap_or(true);
            let local_file = self.folder.join(&path);
            if local_clean {
                if local_etag.is_some() {
                    std::fs::remove_file(&local_file).ok();
                    report.deleted_local.push(path.clone());
                }
                self.state.baselines.remove(&path);
            } else {
                // Deleted remotely, edited locally → keep as conflict copy.
                let tag = baseline.map(|b| b.chars().take(8).collect::<String>()).unwrap_or_default();
                let copy = conflict_path(&local_file, &tag);
                std::fs::rename(&local_file, &copy).ok();
                report.conflicts.push(format!(
                    "{path} (deleted on server; your version saved as conflict copy)"
                ));
                self.state.baselines.remove(&path);
            }
        }

        // Adopt etags for remote files we already have and haven't diverged on
        // (first link: everything local-unchanged gets its baseline).
        for (path, remote_etag) in &remote {
            if !self.state.baselines.contains_key(*path) {
                let local_etag = local.get(*path);
                match (local_etag, remote_etag) {
                    (Some(le), Some(re)) if le == re => {
                        self.state.baselines.insert(path.to_string(), Some(le.clone()));
                    }
                    (None, Some(re)) => {
                        // We lack the file locally and have no baseline — leave
                        // for the next pull's remote_changed branch.
                        let _ = re;
                    }
                    _ => {}
                }
            }
        }

        Ok(report)
    }

    /// Push local changes up (three-way against baselines).
    pub async fn push(&mut self) -> anyhow::Result<SyncReport> {
        let mut report = SyncReport::new();
        let local = scan_local(self.folder)?;

        // Upload new + modified local files.
        for (path, local_etag) in &local {
            let baseline = self.state.baselines.get(path).cloned().flatten();
            if baseline.as_deref() == Some(local_etag.as_str()) {
                continue; // unchanged since last sync
            }
            let bytes = std::fs::read(self.folder.join(path))?;
            let message = format!("wabi-sync: update {path}");
            let outcome = self
                .client
                .upload(
                    self.link.channel_id,
                    path,
                    bytes,
                    &message,
                    baseline.as_deref(),
                )
                .await?;
            match outcome {
                UploadOutcome::Ok { etag, revision, pending_review } => {
                    report.uploaded.push(path.clone());
                    if pending_review {
                        println!("  ↑ {} (pending review on a review branch)", path);
                    } else if !revision.is_empty() {
                        let _ = revision;
                    }
                    // Adopt the server's canonical etag (handles q- sampling
                    // mismatches on huge files).
                    let adopted = if etag.is_empty() { local_etag.clone() } else { etag };
                    self.state.baselines.insert(path.clone(), Some(adopted));
                }
                UploadOutcome::Conflict(conflict) => {
                    let tag = conflict
                        .current_etag
                        .as_deref()
                        .unwrap_or("server")
                        .chars()
                        .take(8)
                        .collect::<String>();
                    let local_file = self.folder.join(path);
                    let copy = conflict_path(&local_file, &tag);
                    std::fs::copy(&local_file, &copy)?;
                    report.conflicts.push(format!(
                        "{path} (server had newer changes; your version saved as {})",
                        copy.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
                    ));
                    // Adopt server state; the next pull fills the canonical file.
                    self.state.baselines.insert(path.clone(), conflict.current_etag.clone());
                }
            }
        }

        // Baseline files deleted locally → delete remotely.
        let baseline_paths: Vec<String> = self.state.baselines.keys().cloned().collect();
        for path in baseline_paths {
            if local.contains_key(&path) {
                continue;
            }
            let baseline = self.state.baselines.get(&path).cloned().flatten();
            if baseline.is_none() {
                continue; // was already absent remotely
            }
            match self
                .client
                .delete(self.link.channel_id, &path, baseline.as_deref())
                .await
            {
                Ok(true) => {
                    report.deleted_remote.push(path.clone());
                    self.state.baselines.insert(path.clone(), None);
                }
                Ok(false) => {
                    report.conflicts.push(format!(
                        "{path} (changed on server after your baseline; not deleted)"
                    ));
                }
                Err(e) => return Err(e),
            }
        }

        Ok(report)
    }

    /// Full round: push local work first, then pull, then record cursor.
    pub async fn sync(&mut self) -> anyhow::Result<SyncReport> {
        let mut pushed = self.push().await?;
        let mut pulled = self.pull().await?;
        let changes = self.client.changes(self.link.channel_id, 0).await?;
        self.state.cursor = changes.latest_seq;
        self.save_state()?;
        pushed.uploaded.extend(pulled.uploaded);
        pushed.downloaded.extend(pulled.downloaded);
        pushed.deleted_local.extend(pulled.deleted_local);
        pushed.deleted_remote.extend(pulled.deleted_remote);
        pushed.conflicts.extend(pulled.conflicts);
        Ok(pushed)
    }
}

pub fn print_report(prefix: &str, report: &SyncReport) {
    for p in &report.downloaded {
        println!("{prefix} ↓ {p}");
    }
    for p in &report.uploaded {
        println!("{prefix} ↑ {p}");
    }
    for p in &report.deleted_local {
        println!("{prefix} ✕ {p} (deleted locally, gone on server)");
    }
    for p in &report.deleted_remote {
        println!("{prefix} ✕ {p} (local deletion pushed)");
    }
    for p in &report.conflicts {
        println!("{prefix} ⚠ conflict: {p}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_matches_gitignore_semantics() {
        let patterns = vec![
            (false, "node_modules".to_string()),
            (false, "target/**".to_string()),
            (false, "*.log".to_string()),
            (true, "keep.log".to_string()),
        ];
        assert!(ignored("node_modules", &patterns));
        assert!(ignored("node_modules/pkg/index.js", &patterns));
        assert!(ignored("target/debug/x", &patterns));
        assert!(!ignored("src/main.rs", &patterns));
        assert!(ignored("debug.log", &patterns));
        assert!(!ignored("keep.log", &patterns)); // negated
    }

    #[test]
    fn internal_paths_are_never_synced() {
        assert!(is_internal(".wabi-sync.json"));
        assert!(is_internal(".wabi-sync/state.json"));
        assert!(is_internal(".lore/config"));
        assert!(is_internal(".git/HEAD"));
        assert!(!is_internal("src/main.rs"));
    }

    #[test]
    fn conflict_path_shape() {
        let p = conflict_path(Path::new("docs/file.txt"), "ab12cd34");
        assert_eq!(p, Path::new("docs/file.txt.wabi-conflict-ab12cd34"));
    }

    #[test]
    fn scan_local_walks_and_filters() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src/main.rs"), b"fn main() {}").unwrap();
        std::fs::create_dir_all(dir.path().join("node_modules/pkg")).unwrap();
        std::fs::write(dir.path().join("node_modules/pkg/x.js"), b"junk").unwrap();
        std::fs::write(dir.path().join(".wabiignore"), "node_modules\n").unwrap();
        std::fs::write(dir.path().join(".wabi-sync.json"), b"{}").unwrap();
        let scanned = scan_local(dir.path()).unwrap();
        assert_eq!(scanned.len(), 1);
        assert!(scanned.contains_key("src/main.rs"));
    }
}
