//! The sync engine: three-way pull/push using etag baselines, conflict
//! copies, ignore-aware local walking, and the watch loop.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context};

use crate::api::{DeleteOutcome, UploadOutcome, WabiClient};
use crate::config::{FolderLock, LinkConfig, StateOwner, SyncState, LINK_FILE, STATE_DIR};
use crate::etag::{etag_for_bytes, etag_for_file, ETAG_FULL_HASH_MAX_BYTES};

/// What every conflict copy has in its file name.
const CONFLICT_MARKER: &str = ".wabi-conflict-";

/// Paths never synced regardless of ignore files, in either direction:
/// - this tool's own link file and state directory;
/// - conflict copies, which belong to the folder they were made in;
/// - the names the server refuses as repository metadata, at any depth and
///   in any letter case (`reserved` and `ignore_file` in the Lore addon's
///   `confined_fs.rs`).
fn is_internal(rel: &str) -> bool {
    rel.split('/').any(|component| {
        let name = component.to_ascii_lowercase();
        name == LINK_FILE
            || name == STATE_DIR
            || name.contains(CONFLICT_MARKER)
            || matches!(
                name.as_str(),
                ".git"
                    | ".lore"
                    | ".mirror-cache"
                    | ".wabi-repo.json"
                    | ".wabi-mirror-fetched-at"
                    | ".wabiignore"
                    | ".loreignore"
            )
            || name.starts_with(".wabi-publish-")
    })
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

/// Put `bytes`, the contents of `local`, in a conflict copy next to it and
/// return the copy's path. A file that is already there is never written over: it may
/// be the only place an earlier version of the user's work exists. The name
/// is `<file>.wabi-conflict-<tag>`, then `-2`, `-3`, … until one is free. A
/// name whose file already holds exactly these bytes is used as it is, so a
/// round repeated after a failure does not pile up identical copies.
fn save_conflict_copy(local: &Path, bytes: &[u8], tag: &str) -> anyhow::Result<PathBuf> {
    use std::io::Write;
    let mut n = 1u32;
    loop {
        let candidate = if n == 1 {
            conflict_path(local, tag)
        } else {
            conflict_path(local, &format!("{tag}-{n}"))
        };
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&candidate) {
            Ok(mut file) => {
                file.write_all(bytes)?;
                file.sync_all()?;
                return Ok(candidate);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                if std::fs::read(&candidate).is_ok_and(|existing| existing == bytes) {
                    return Ok(candidate);
                }
                n += 1;
            }
            Err(e) => return Err(e).with_context(|| format!("writing {}", candidate.display())),
        }
    }
}

pub struct SyncReport {
    pub downloaded: Vec<String>,
    pub uploaded: Vec<String>,
    pub deleted_local: Vec<String>,
    pub deleted_remote: Vec<String>,
    pub conflicts: Vec<String>,
    /// Uploaded to a review branch and not yet on the mainline.
    pub waiting_review: Vec<String>,
    /// Local deletions the server refused (403).
    pub not_deleted: Vec<String>,
    /// Local files the server refused, each with the reason. They stay as
    /// they are in the folder and are offered again on the next round.
    pub not_uploaded: Vec<String>,
    /// Things the user should know that are about the folder, not one file.
    pub notices: Vec<String>,
}

impl SyncReport {
    fn new() -> Self {
        Self {
            downloaded: Vec::new(),
            uploaded: Vec::new(),
            deleted_local: Vec::new(),
            deleted_remote: Vec::new(),
            conflicts: Vec::new(),
            waiting_review: Vec::new(),
            not_deleted: Vec::new(),
            not_uploaded: Vec::new(),
            notices: Vec::new(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.downloaded.is_empty()
            && self.uploaded.is_empty()
            && self.deleted_local.is_empty()
            && self.deleted_remote.is_empty()
            && self.conflicts.is_empty()
            && self.waiting_review.is_empty()
            && self.not_deleted.is_empty()
            && self.not_uploaded.is_empty()
            && self.notices.is_empty()
    }
}

pub struct SyncEngine<'a> {
    pub client: &'a WabiClient,
    pub folder: &'a Path,
    pub link: &'a LinkConfig,
    pub state: SyncState,
    /// Lines for the next report's `notices`.
    notices: Vec<String>,
    /// Held until the engine is dropped: no other wabi-sync process reads
    /// or writes this folder's state meanwhile.
    _lock: FolderLock,
}

impl<'a> SyncEngine<'a> {
    /// Fails when another process holds the folder, or when the folder's
    /// state file is there and cannot be read.
    pub fn new(client: &'a WabiClient, folder: &'a Path, link: &'a LinkConfig) -> anyhow::Result<Self> {
        let lock = FolderLock::acquire(folder)?;
        // A state recorded for another server or channel is not this link's.
        let owner = StateOwner { server_url: client.server_url().to_string(), channel_id: link.channel_id };
        let (mut state, notice) = SyncState::for_owner(folder, owner)?;
        // An earlier build synced conflict copies like any other file. With
        // no record of them here they are neither deleted nor replaced, on
        // the server or in the folder.
        state.baselines.retain(|path, _| !is_internal(path));
        state.pending_review.retain(|path, _| !is_internal(path));
        state.local_fingerprints.retain(|path, _| !is_internal(path));
        Ok(Self { client, folder, link, state, notices: notice.into_iter().collect(), _lock: lock })
    }

    pub fn save_state(&self) -> anyhow::Result<()> {
        self.state.save(self.folder)
    }

    /// `bytes` were just downloaded and written to `path`: record the
    /// server's etag as the baseline and the local file as unchanged.
    fn record_download(&mut self, path: &str, bytes: &[u8], manifest_etag: &str) -> anyhow::Result<()> {
        // Up to the full-hash limit the etag is the content hash. Above it
        // only the server can say what its etag is, so take the manifest's.
        let server_etag = if bytes.len() as u64 > ETAG_FULL_HASH_MAX_BYTES && !manifest_etag.is_empty() {
            manifest_etag.to_string()
        } else {
            etag_for_bytes(bytes)
        };
        let local_etag = etag_for_file(&self.folder.join(path))?;
        self.state.record_local(path, &local_etag, &server_etag);
        self.state.baselines.insert(path.to_string(), Some(server_etag));
        Ok(())
    }

    /// The user and someone else both changed `path`. The rule, wherever the
    /// conflict is found: the canonical name ends up holding the server's
    /// version (nothing, when the file was deleted there), the user's version
    /// goes to a conflict copy next to it, and the baseline becomes the
    /// server's. The client never sends the user's version over the other
    /// change by itself; the user does that by putting the conflict copy's
    /// bytes back in the file. Returns the line for the report.
    ///
    /// `server_etag` is `None` when the server has no such file.
    ///
    /// When both sides turn out to hold the same bytes there is no copy and
    /// no line. Otherwise the line for the user goes into the state, saved
    /// in the same write as the conflict itself, and stays there until a
    /// report that carries it is handed over (`finish`): the user's file
    /// now holds someone else's version, and they are told even if the rest
    /// of this round fails or the process is killed.
    async fn keep_both(&mut self, path: &str, server_etag: Option<&str>) -> anyhow::Result<()> {
        let local_file = self.folder.join(path);
        let name = |p: &Path| p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let Some(server_etag) = server_etag else {
            let copy = save_conflict_copy(&local_file, &std::fs::read(&local_file)?, "deleted")?;
            std::fs::remove_file(&local_file)?;
            self.state.baselines.remove(path);
            self.state.pending_review.remove(path);
            self.state.local_fingerprints.remove(path);
            self.state.unreported_conflicts.push(format!(
                "{path} (deleted on the server; your version is saved as {})",
                name(&copy)
            ));
            return self.save_state();
        };
        // Fetch before touching the folder: a failed download leaves the
        // user's file where it was.
        let bytes = self
            .client
            .download(self.link.channel_id, path, None)
            .await?
            .context("conflict download failed")?;
        let mine = std::fs::read(&local_file)?;
        if mine == bytes {
            // The same bytes on both sides, which the etags could not show:
            // over the full-hash limit the server's etag is never one the
            // client can compute. Nothing to keep apart; adopt its etag.
            self.state.pending_review.remove(path);
            self.record_download(path, &bytes, server_etag)?;
            return Ok(());
        }
        let tag = server_etag.chars().take(8).collect::<String>();
        let copy = save_conflict_copy(&local_file, &mine, &tag)?;
        std::fs::write(&local_file, &bytes)?;
        self.state.pending_review.remove(path);
        self.record_download(path, &bytes, server_etag)?;
        self.state.unreported_conflicts.push(format!(
            "{path} (changed on the server too; {path} now holds the server's version, yours is saved as {})",
            name(&copy)
        ));
        // On disk at once: a round that fails later, or is killed, must not
        // find this conflict a second time, and must not forget to report it.
        self.save_state()
    }

    /// The end of every round, successful or not. The state is saved either
    /// way: each step records itself as soon as it is done, so the saved
    /// state is what actually happened and a retry starts from there. A
    /// successful round's report takes the conflict lines waiting in the
    /// state (this round's and any left by a round that failed).
    fn finish(&mut self, result: anyhow::Result<SyncReport>) -> anyhow::Result<SyncReport> {
        let result = result.map(|mut report| {
            let mut conflicts = std::mem::take(&mut self.state.unreported_conflicts);
            conflicts.append(&mut report.conflicts);
            report.conflicts = conflicts;
            report.notices.append(&mut self.notices);
            report
        });
        let saved = self.save_state();
        let report = result?;
        saved?;
        Ok(report)
    }

    /// Conflicts settled by a round that then failed. The caller shows them
    /// with the error; they are then no longer waiting to be reported.
    pub fn take_unreported_conflicts(&mut self) -> Vec<String> {
        let conflicts = std::mem::take(&mut self.state.unreported_conflicts);
        if !conflicts.is_empty() {
            // If this cannot be saved they are shown again next round.
            let _ = self.save_state();
        }
        conflicts
    }

    /// Notices of a round that failed, for the caller to show with the error.
    pub fn take_notices(&mut self) -> Vec<String> {
        std::mem::take(&mut self.notices)
    }

    /// Pull remote changes down (three-way against baselines).
    pub async fn pull(&mut self) -> anyhow::Result<SyncReport> {
        let result = self.pull_steps().await;
        self.finish(result)
    }

    async fn pull_steps(&mut self) -> anyhow::Result<SyncReport> {
        let mut report = SyncReport::new();
        let manifest = self.client.manifest(self.link.channel_id).await?;
        if manifest.read_only {
            bail!("this repo is a read-only mirror; wabi-sync cannot sync it");
        }
        let local = scan_local(self.folder)?;
        let remote: BTreeMap<&str, &Option<String>> = manifest
            .files
            .iter()
            .filter(|f| !is_internal(&f.path))
            .map(|f| (f.path.as_str(), &f.etag))
            .collect();

        // Remote files: download new/changed when we have no diverging local edit.
        for (path, remote_etag) in &remote {
            // The server sends a null etag when it could not hash the file.
            // That says nothing about whether the file changed, so the path
            // is left as it is this round: not fetched again over the local
            // copy, not a conflict, and (being listed) not deleted.
            let Some(remote_etag) = remote_etag.as_deref() else {
                continue;
            };
            // A review upload was approved: the mainline now has the etag we
            // uploaded, so it becomes the ordinary baseline.
            if self.state.pending_review.get(*path).map(String::as_str) == Some(remote_etag) {
                self.state.pending_review.remove(*path);
                self.state.baselines.insert(path.to_string(), Some(remote_etag.to_string()));
            }
            let baseline = self.state.baselines.get(*path).cloned().flatten();
            let local_etag = local.get(*path);
            let remote_changed = baseline.as_deref().unwrap_or("") != remote_etag;
            let local_has = local_etag.is_some();
            if remote_changed && local_etag.map(String::as_str) == Some(remote_etag) {
                // The folder already holds the server's bytes: a download or
                // a conflict that an interrupted round did not get to
                // record, or the same edit made in two places.
                self.state.pending_review.remove(*path);
                self.state.local_fingerprints.remove(*path);
                self.state.baselines.insert(path.to_string(), Some(remote_etag.to_string()));
                continue;
            }
            if remote_changed {
                // The mainline moved to something other than what is waiting
                // for review; the branches below settle the path (a pending
                // local file differs from its baseline, so it is kept as a
                // conflict copy).
                let local_clean = match (local_etag, &baseline) {
                    (Some(le), Some(_)) => self.state.local_matches_baseline(path, le),
                    (None, b) => b.is_none(), // both absent → clean
                    (Some(_), None) => false, // local-only file → diverged
                };
                // The state is changed only once the path is settled: a step
                // that fails must leave it describing the folder as it is.
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
                    self.state.pending_review.remove(*path);
                    self.record_download(path, &bytes, remote_etag)?;
                } else {
                    // Both sides changed.
                    self.keep_both(path, Some(remote_etag)).await?;
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
                self.state.local_fingerprints.remove(&path);
                continue;
            }
            let local_etag = local.get(&path);
            let local_clean = local_etag.map(|le| self.state.local_matches_baseline(&path, le)).unwrap_or(true);
            let local_file = self.folder.join(&path);
            if local_clean {
                if local_etag.is_some() {
                    std::fs::remove_file(&local_file).ok();
                    report.deleted_local.push(path.clone());
                }
                self.state.baselines.remove(&path);
                self.state.pending_review.remove(&path);
                self.state.local_fingerprints.remove(&path);
            } else {
                // Deleted remotely, edited locally.
                self.keep_both(&path, None).await?;
            }
        }

        Ok(report)
    }

    /// Push local changes up (three-way against baselines).
    pub async fn push(&mut self) -> anyhow::Result<SyncReport> {
        let result = self.push_steps().await;
        self.finish(result)
    }

    async fn push_steps(&mut self) -> anyhow::Result<SyncReport> {
        let mut report = SyncReport::new();
        let local = scan_local(self.folder)?;

        // Upload new + modified local files.
        for (path, local_etag) in &local {
            let baseline = self.state.baselines.get(path).cloned().flatten();
            if self.state.local_matches_baseline(path, local_etag) {
                // Unchanged since last sync (or put back to the mainline
                // version while an edit was waiting for review; the
                // fingerprint then described the edit, so it goes too).
                if self.state.pending_review.remove(path).is_some() {
                    self.state.local_fingerprints.remove(path);
                }
                continue;
            }
            if self.state.local_matches_pending(path, local_etag) {
                // Already uploaded to a review branch; nothing new to send.
                report.waiting_review.push(path.clone());
                continue;
            }
            let bytes = std::fs::read(self.folder.join(path))?;
            // What the file looked like locally when these bytes were sent.
            // Up to the full-hash limit that is the hash of the bytes read
            // just now; above it, the sampled etag from the scan.
            let sent_etag = if bytes.len() as u64 <= ETAG_FULL_HASH_MAX_BYTES {
                etag_for_bytes(&bytes)
            } else {
                local_etag.clone()
            };
            let message = format!("wabi-sync: update {path}");
            let outcome = self
                .client
                .upload(
                    self.link.channel_id,
                    path,
                    bytes,
                    &message,
                    // Never unconditional. With no baseline the upload is
                    // create-only (`If-Match: ""`): if the server has a file
                    // at this path that this folder never saw, it answers
                    // 409 and both versions are kept.
                    Some(baseline.as_deref().unwrap_or("")),
                )
                .await?;
            match outcome {
                UploadOutcome::Ok { etag, revision, pending_review } => {
                    report.uploaded.push(path.clone());
                    let _ = revision;
                    // Adopt the server's canonical etag: it is what If-Match
                    // and the manifest comparison need. For a file over the
                    // full-hash limit it never equals the local etag, so the
                    // local one is recorded next to it.
                    let adopted = if etag.is_empty() { sent_etag.clone() } else { etag };
                    self.state.record_local(path, &sent_etag, &adopted);
                    if pending_review {
                        // The bytes went to a review branch, not the mainline:
                        // the baseline stays the mainline's so the pull does
                        // not take this file for a clean copy of it.
                        report.waiting_review.push(path.clone());
                        self.state.pending_review.insert(path.clone(), adopted);
                    } else {
                        self.state.pending_review.remove(path);
                        self.state.baselines.insert(path.clone(), Some(adopted));
                    }
                }
                UploadOutcome::Refused(refusal) => {
                    // Nothing changed on either side; the rest of the round
                    // does not depend on this file.
                    report.not_uploaded.push(format!("{path} (not uploaded: {refusal})"));
                }
                UploadOutcome::Conflict(conflict) => {
                    if conflict.current_etag.as_deref() == Some(sent_etag.as_str()) {
                        // The server already holds these very bytes (the
                        // same edit made twice): nothing to keep apart.
                        self.state.pending_review.remove(path);
                        self.state.local_fingerprints.remove(path);
                        self.state.baselines.insert(path.clone(), conflict.current_etag);
                        continue;
                    }
                    self.keep_both(path, conflict.current_etag.as_deref()).await?;
                }
            }
        }

        // A file removed locally is no longer waiting for review.
        self.state.pending_review.retain(|path, _| local.contains_key(path));
        self.state.local_fingerprints.retain(|path, _| local.contains_key(path));

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
                Ok(DeleteOutcome::Deleted) => {
                    report.deleted_remote.push(path.clone());
                    self.state.baselines.insert(path.clone(), None);
                }
                Ok(DeleteOutcome::Conflict) => {
                    report.conflicts.push(format!(
                        "{path} (changed on server after your baseline; not deleted)"
                    ));
                }
                Ok(DeleteOutcome::Forbidden) => {
                    // Baseline stays: the file is still on the server.
                    report.not_deleted.push(path.clone());
                }
                Err(e) => return Err(e),
            }
        }

        Ok(report)
    }

    /// Full round: push local work first, then pull, then record cursor.
    pub async fn sync(&mut self) -> anyhow::Result<SyncReport> {
        let result = self.sync_steps().await;
        self.finish(result)
    }

    async fn sync_steps(&mut self) -> anyhow::Result<SyncReport> {
        let mut pushed = self.push_steps().await?;
        // What the push did is on disk before the pull starts.
        self.save_state()?;
        let pulled = self.pull_steps().await?;
        self.state.cursor = self.client.feed_end(self.link.channel_id, self.state.cursor).await?;
        pushed.uploaded.extend(pulled.uploaded);
        pushed.downloaded.extend(pulled.downloaded);
        pushed.deleted_local.extend(pulled.deleted_local);
        pushed.deleted_remote.extend(pulled.deleted_remote);
        pushed.conflicts.extend(pulled.conflicts);
        // Only what is still pending after the pull (not approved or
        // conflicted in this same round).
        pushed.waiting_review.retain(|p| self.state.pending_review.contains_key(p));
        Ok(pushed)
    }
}

/// What `wabi-sync status` says about the files in the folder.
pub struct LocalStatus {
    /// Changed since the last sync and not sent anywhere yet.
    pub changed: Vec<String>,
    /// Sent to a review branch, unchanged since, and not on the mainline.
    pub waiting_review: Vec<String>,
}

pub fn local_status(state: &SyncState, local: &BTreeMap<String, String>) -> LocalStatus {
    let mut status = LocalStatus { changed: Vec::new(), waiting_review: Vec::new() };
    for (path, etag) in local {
        if state.local_matches_baseline(path, etag) {
            continue;
        }
        if state.local_matches_pending(path, etag) {
            status.waiting_review.push(path.clone());
        } else {
            status.changed.push(path.clone());
        }
    }
    status
}

/// How `wabi-sync watch` paces itself: it waits for file-system events, lets
/// a burst of them settle, and then asks the server whether the feed moved.
pub struct WatchPacer {
    last_fs_event: std::time::Instant,
}

#[derive(Debug, PartialEq, Eq)]
pub enum WatchStep {
    /// Keep waiting for events.
    Wait,
    /// Ask the server whether the feed moved, and run a round if it did or
    /// if `local_changed`.
    Poll { local_changed: bool },
}

impl WatchPacer {
    pub fn new(now: std::time::Instant) -> Self {
        Self { last_fs_event: now }
    }

    /// The wait for a file-system event ended at `now`, with an event or
    /// with its timeout.
    pub fn after_wait(&mut self, fs_event: bool, now: std::time::Instant) -> WatchStep {
        if fs_event {
            // Debounce: drain further events for a short window.
            self.last_fs_event = now;
            return WatchStep::Wait;
        }
        if now.duration_since(self.last_fs_event) < std::time::Duration::from_millis(500) {
            return WatchStep::Wait;
        }
        WatchStep::Poll { local_changed: fs_event }
    }
}

pub fn print_report(prefix: &str, report: &SyncReport) {
    for p in &report.notices {
        println!("{prefix} note: {p}");
    }
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
    for p in &report.waiting_review {
        println!("{prefix} … {p} (waiting for review; not on the mainline yet)");
    }
    for p in &report.not_deleted {
        println!("{prefix} ⚠ {p} (not deleted: you do not have permission)");
    }
    for p in &report.not_uploaded {
        println!("{prefix} ⚠ {p}");
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
        // The server's reserved names, at any depth and in any case.
        for path in [
            "sub/.git/config",
            "sub/.Lore/head",
            "a/.wabi-repo.json",
            "a/.mirror-cache/x",
            ".wabi-mirror-fetched-at",
            "a/.wabi-publish-123/x",
            ".wabiignore",
            "sub/.WabiIgnore",
            "sub/.loreignore",
            "nested/.wabi-sync/state.json",
            "nested/.wabi-sync.json",
        ] {
            assert!(is_internal(path), "{path}");
        }
        // Conflict copies.
        assert!(is_internal("docs/file.txt.wabi-conflict-ab12cd34"));
        assert!(is_internal("docs/file.txt.wabi-conflict-ab12cd34-2"));
        for path in [".gitignore", ".github/workflows/ci.yml", "wabi-conflict-notes.txt", "lore/readme.md"] {
            assert!(!is_internal(path), "{path}");
        }
    }

    /// B7. Only what must be excluded is: the link file and state directory
    /// at the folder's root, and conflict copies as this client names them.
    #[test]
    fn names_that_only_look_internal_are_not() {
        for path in [
            "How.Wabi-Conflict-Works.md",
            "about.wabi-conflict-handling.md",
            "notes.wabi-conflict-old/a.md",
            "docs.wabi-conflict-ab12cd34/a.md",
            "nested/.wabi-sync/state.json",
            "nested/.wabi-sync.json",
            "a.txt.wabi-conflict-ab12cd34.bak",
            "a.txt.wabi-conflict-",
        ] {
            assert!(!is_internal(path), "{path}");
        }
        for path in [
            ".wabi-sync.json",
            ".wabi-sync/state.json",
            ".wabi-sync/lock",
            "docs/file.txt.wabi-conflict-ab12cd34",
            "docs/file.txt.wabi-conflict-ab12cd34-2",
            "docs/file.txt.wabi-conflict-ab12cd34-17",
            "big.bin.wabi-conflict-q-1a2b3c",
            "big.bin.wabi-conflict-q-1a2b3c-3",
            "gone.txt.wabi-conflict-deleted",
            "gone.txt.wabi-conflict-deleted-2",
            // A conflict copy of a file that itself looks like one.
            "x.wabi-conflict-old.wabi-conflict-00ff00ff",
        ] {
            assert!(is_internal(path), "{path}");
        }
    }

    /// B5. A conflict copy's name fits in one file name whatever the
    /// original's length, keeps the marker and tag, and cuts on a character.
    #[test]
    fn conflict_copy_of_a_long_name_is_shortened() {
        for name in ["n".repeat(250), "é".repeat(120), format!("{}.txt", "x".repeat(251))] {
            let copy = conflict_path(&Path::new("docs").join(&name), "ab12cd34-12");
            let copy_name = copy.file_name().unwrap().to_str().unwrap();
            assert!(copy_name.len() <= 255, "{} bytes", copy_name.len());
            assert!(copy_name.ends_with(".wabi-conflict-ab12cd34-12"), "{copy_name}");
            assert!(name.starts_with(copy_name.strip_suffix(".wabi-conflict-ab12cd34-12").unwrap()));
            assert!(is_internal(&format!("docs/{copy_name}")));
            assert_eq!(copy.parent(), Some(Path::new("docs")));
        }
    }

    /// B5. A link to nothing is left out of the scan; the scan goes on.
    #[cfg(unix)]
    #[test]
    fn scan_goes_on_past_a_dangling_symlink() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), b"a").unwrap();
        std::os::unix::fs::symlink("nowhere", dir.path().join("broken")).unwrap();
        let scanned = scan_local(dir.path()).expect("the scan stopped at the link");
        assert_eq!(scanned.keys().collect::<Vec<_>>(), vec!["a.txt"]);
    }

    /// B8. A local edit is pushed when the events have settled, whether or
    /// not the server's feed moved.
    #[test]
    fn watch_runs_a_round_after_a_local_edit() {
        use std::time::{Duration, Instant};
        let start = Instant::now();
        let mut pacer = WatchPacer::new(start);
        // Nothing happened: only the feed can start a round.
        assert_eq!(pacer.after_wait(false, start + Duration::from_millis(750)), WatchStep::Poll { local_changed: false });
        // An editor saves: a burst of events, then quiet.
        let edit = start + Duration::from_secs(5);
        assert_eq!(pacer.after_wait(true, edit), WatchStep::Wait);
        assert_eq!(pacer.after_wait(true, edit + Duration::from_millis(10)), WatchStep::Wait);
        assert_eq!(
            pacer.after_wait(false, edit + Duration::from_millis(760)),
            WatchStep::Poll { local_changed: true },
            "the edit was forgotten by the time a round could run"
        );
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
        std::fs::create_dir_all(dir.path().join(".wabi-sync")).unwrap();
        std::fs::write(dir.path().join(".wabi-sync/state.json"), b"{}").unwrap();
        std::fs::write(dir.path().join("src/main.rs.wabi-conflict-ab12cd34"), b"mine").unwrap();
        std::fs::create_dir_all(dir.path().join("src/.git")).unwrap();
        std::fs::write(dir.path().join("src/.git/config"), b"x").unwrap();
        let scanned = scan_local(dir.path()).unwrap();
        assert_eq!(scanned.len(), 1);
        assert!(scanned.contains_key("src/main.rs"));
    }
}
