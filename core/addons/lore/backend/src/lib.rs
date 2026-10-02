//! Wabi Lore addon — version-controlled storage via Epic Games Lore.
//!
//! Wraps the `lore` CLI (https://github.com/epicgames/lore) to provide VCS
//! semantics inside Wabi channels. Each channel's repo gets a working tree
//! under the configured data directory.
//!
//! ## Real Lore CLI commands used
//!
//! | Operation | Lore command |
//! |---|---|
//! | Create repo | `lore repository create lore://host/name` |
//! | Clone | `lore clone lore://host/name ./path` |
//! | Stage | `lore stage file1 file2` |
//! | Commit | `lore commit "message"` |
//! | Push | `lore push` |
//! | Sync | `lore sync` |
//! | History | `lore history` |
//! | Status | `lore status --scan` |
//! | Branch | `lore branch create/list/switch` |
//! | Diff | `lore diff file` |
//! | Lock | `lore lock file` |
//!
//! ## Integration with WabiDB
//!
//! Lore revisions are recorded as `Event::LoreCommit` events so channel
//! members see commits in their message stream.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::process::Command;
use tokio::sync::RwLock;
use tracing::{debug, info, warn};

mod confined_fs;
mod git_remote;
use confined_fs::{InternalFile, RepoDir};
pub use confined_fs::validate_path as validate_repo_path;

// P4: Editor bridge — ephemeral code-server sessions
pub mod editor_bridge;
// P5: Script collaboration — run scripts from Lore repos
pub mod script_runner;
// P7: Off-box mirroring — publish to GitHub/GitLab/S3
pub mod mirror;
// Ignore filtering — .wabiignore at the Wabi layer (Lore has no .loreignore yet)
pub mod ignore;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Unique identifier for a Lore repository managed by this addon.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct LoreRepoId(pub uuid::Uuid);

impl LoreRepoId {
    pub fn new() -> Self {
        Self(uuid::Uuid::new_v4())
    }
}

impl Default for LoreRepoId {
    fn default() -> Self {
        Self::new()
    }
}

/// Class of a Lore repository attached to a channel.
///
/// - `Native` — a normal Lore repo owned by Wabi (created, imported, or linked).
///   Wabi may read and write it.
/// - `Mirror` — a read-only pointer to an external git repository. Wabi never
///   writes to a mirror; it lazily `git clone --depth 1`s the upstream into a
///   `.mirror-cache` dir under the channel's data dir and serves listings from
///   that cache. All write endpoints refuse with 501.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RepoClass {
    Native,
    Mirror { upstream_url: String },
}

impl Default for RepoClass {
    fn default() -> Self {
        RepoClass::Native
    }
}

/// A Lore repository attached to a Wabi channel.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoreRepo {
    pub id: LoreRepoId,
    pub channel_id: i64,
    pub lore_server_url: String,
    pub repo_name: String,
    pub working_tree: PathBuf,
    pub created_by: i64,
    pub created_at: chrono::DateTime<chrono::Utc>,
    /// Native vs Mirror (read-only external pointer). Defaults to Native for
    /// backward compat with previously-persisted repo metadata.
    #[serde(default)]
    pub class: RepoClass,
    /// When true, uploads are staged+committed on a per-upload review branch
    /// (`uploads/<user>-<ts>`) instead of the mainline branch, then switched
    /// back — pending review until approved/rejected via the review routes.
    #[serde(default)]
    pub auto_branch_on_upload: bool,
    /// Set when the repo's initial content came from `git clone` of this URL
    /// (files-only import; history stays at the source).
    #[serde(default)]
    pub imported_from: Option<String>,
}

impl LoreRepo {
    /// True when the repo is a read-only external mirror. Wabi must never
    /// write to a mirror working tree.
    pub fn read_only(&self) -> bool {
        matches!(self.class, RepoClass::Mirror { .. })
    }
}

/// Result of a file upload, including the review-flow fields added when the
/// repo has `auto_branch_on_upload` enabled.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoreUploadResult {
    pub revision: LoreRevision,
    pub file_info: LoreFileInfo,
    /// True when the upload was committed on a dedicated review branch and is
    /// awaiting approve/reject rather than being on the mainline.
    pub pending_review: bool,
    /// Name of the review branch the upload was committed to (None for direct
    /// commits when `auto_branch_on_upload` is disabled).
    pub review_branch: Option<String>,
}

/// Structured error for [`LoreService::import_from_git`], so the API can map
/// distinct failure modes (existing repo → 409, clone failure → 502) to the
/// correct HTTP statuses.
#[derive(Debug)]
pub enum LoreImportError {
    /// A Lore repo is already registered for the channel.
    RepoExists,
    /// `git clone` failed; carries git's stderr for the 502 body.
    CloneFailed(String),
    /// Any other error.
    Other(anyhow::Error),
}

impl std::fmt::Display for LoreImportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LoreImportError::RepoExists => {
                write!(f, "a Lore repo already exists for this channel")
            }
            LoreImportError::CloneFailed(stderr) => write!(f, "git clone failed: {stderr}"),
            LoreImportError::Other(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for LoreImportError {}

impl From<anyhow::Error> for LoreImportError {
    fn from(e: anyhow::Error) -> Self {
        LoreImportError::Other(e)
    }
}

impl From<std::io::Error> for LoreImportError {
    fn from(e: std::io::Error) -> Self {
        LoreImportError::Other(e.into())
    }
}

/// A commit/revision within a Lore repository.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoreRevision {
    pub hash: String,
    pub revision_number: u64,
    pub message: String,
    pub author: Option<String>,
    pub timestamp: String,
    pub parent: Option<String>,
}

/// File metadata within a Lore repo.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoreFileInfo {
    pub path: String,
    pub size: u64,
    pub status: String, // "added", "modified", "deleted", "clean"
    /// Content etag (SHA-256, or `q-…` sampled for large files). Used for
    /// optimistic concurrency (If-Match) and client-side change detection.
    #[serde(default)]
    pub etag: Option<String>,
}

/// Branch information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoreBranch {
    pub name: String,
    pub revision_hash: String,
    pub is_current: bool,
}

/// File lock information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoreFileLock {
    pub path: String,
    pub locked_by: Option<String>,
    pub locked_at: Option<String>,
}

/// Diff between two revisions of a file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoreDiff {
    pub path: String,
    pub unified_diff: String,
    pub lines_added: u32,
    pub lines_removed: u32,
}

/// Operation mode for the Lore server connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LoreMode {
    /// `loreserver` managed as a child process
    Embedded,
    /// `loreserver` running separately (systemd, container, etc.)
    Sidecar,
    /// Remote Lore server URL
    Remote,
}

/// Minimal description of a persisted Lore repo. Used to rehydrate the
/// in-memory repo index after a restart.
pub struct LoreRepoSeed {
    pub channel_id: i64,
    pub repo_name: String,
    pub lore_server_url: String,
    pub created_by: i64,
    pub created_at_micros: i64,
}

/// Configuration for the Lore addon.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoreConfig {
    pub enabled: bool,
    pub mode: LoreMode,
    pub lore_server_url: String,
    pub lore_binary_path: PathBuf,
    /// Root directory for working trees: `<data_dir>/<channel_id>/`
    pub lore_data_dir: PathBuf,
    pub default_blob_max_size_mb: u32,
    pub recordings_channel_name: String,
}

impl Default for LoreConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            mode: LoreMode::Embedded,
            lore_server_url: "lore://localhost:10000".into(),
            lore_binary_path: PathBuf::from("lore"),
            lore_data_dir: PathBuf::from("/var/wabi/lore"),
            default_blob_max_size_mb: 1024,
            recordings_channel_name: "Recordings".into(),
        }
    }
}

// ---------------------------------------------------------------------------
// Helper: run lore CLI command
// ---------------------------------------------------------------------------

async fn run_lore(
    binary: &PathBuf,
    working_dir: &PathBuf,
    args: &[&str],
    mode: LoreMode,
) -> anyhow::Result<std::process::Output> {
    // CLI code is trusted, but it must never consume imported links or
    // special files. All service callers hold io_gate while using the tree.
    if args.first() != Some(&"clone") {
        RepoDir::open(working_dir)?.validate_cli_tree()?;
    }
    let mut cmd = Command::new(binary);
    cmd.current_dir(working_dir)
        .env("HOME", "/var/wabi/lore");
    if matches!(mode, LoreMode::Embedded) {
        cmd.arg("--offline").arg("--local");
    }
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(120),
        cmd.kill_on_drop(true).args(args).output(),
    ).await.map_err(|_| anyhow::anyhow!("Lore command timed out"))??;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        anyhow::bail!(
            "Lore command failed: {}\nstdout: {}",
            stderr.trim(),
            stdout.trim()
        );
    }

    Ok(output)
}

// ---------------------------------------------------------------------------
// ETags (optimistic concurrency) + revision content cache
// ---------------------------------------------------------------------------

/// Files up to this size get a full-content SHA-256 etag; larger files get a
/// sampled etag (size + mtime + first/last 32 KiB) prefixed `q-` so clients
/// can tell the two apart. Both wabi-server and wabi-sync use this exact
/// algorithm — changing it is a wire-protocol break.
const ETAG_FULL_HASH_MAX_BYTES: u64 = 4 * 1024 * 1024;
const ETAG_SAMPLE_BYTES: u64 = 32 * 1024;

/// ETag for in-memory bytes (the just-uploaded body). Always a full hash —
/// callers already hold the bytes, so sampling saves nothing.
pub fn etag_for_bytes(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(bytes))
}

/// Compute the etag for a file on disk. Files above
/// [`ETAG_FULL_HASH_MAX_BYTES`] are sampled (size + mtime + head/tail bytes)
/// to keep manifest calls cheap on large binary assets.
pub async fn file_etag(path: &std::path::Path) -> anyhow::Result<String> {
    let parent = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(std::path::Path::new("."));
    let name = path.file_name().and_then(|s| s.to_str()).ok_or_else(|| anyhow::anyhow!("invalid file name"))?;
    file_etag_open(RepoDir::open(parent)?.open_file(name)?).await
}

async fn file_etag_open(file: std::fs::File) -> anyhow::Result<String> {
    use sha2::{Digest, Sha256};
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let mut file = tokio::fs::File::from_std(file);
    let meta = file.metadata().await?;
    if meta.len() <= ETAG_FULL_HASH_MAX_BYTES {
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).await?;
        return Ok(etag_for_bytes(&bytes));
    }
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);

    let mut head = vec![0u8; ETAG_SAMPLE_BYTES as usize];
    let head_len = file.read(&mut head).await?;
    head.truncate(head_len);
    file.seek(std::io::SeekFrom::End(-(ETAG_SAMPLE_BYTES.min(meta.len()) as i64)))
        .await?;
    let mut tail = vec![0u8; ETAG_SAMPLE_BYTES as usize];
    let tail_len = file.read(&mut tail).await?;
    tail.truncate(tail_len);
    let mut hasher = Sha256::new();
    hasher.update(meta.len().to_le_bytes());
    hasher.update(mtime.to_le_bytes());
    hasher.update(&head);
    hasher.update(&tail);
    Ok(format!("q-{}", hex::encode(hasher.finalize())))
}

/// Cached (size, mtime) → etag so `list_files` doesn't re-hash unchanged
/// files on every call.
type EtagCache = std::sync::Mutex<HashMap<(i64, String), (u64, u128, String)>>;

#[cfg(test)]
struct CopyTestHook {
    started: tokio::sync::oneshot::Sender<()>,
    resume: std::sync::mpsc::Receiver<()>,
}

async fn etag_cached(
    cache: &EtagCache,
    channel_id: i64,
    path: &str,
    file: std::fs::File,
) -> Option<String> {
    let meta = file.metadata().ok()?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    {
        let cache = cache.lock().unwrap();
        if let Some((size, seen_mtime, etag)) = cache.get(&(channel_id, path.to_string())) {
            if *size == meta.len() && *seen_mtime == mtime {
                return Some(etag.clone());
            }
        }
    }
    let etag = file_etag_open(file).await.ok()?;
    cache
        .lock()
        .unwrap()
        .insert((channel_id, path.to_string()), (meta.len(), mtime, etag.clone()));
    Some(etag)
}

/// Path of a cached file version:
/// `<lore_data_dir>/<channel_id>.revcache/<revision>/<repo_path>`.
/// Lives OUTSIDE the working tree so `lore status` never sees it.
fn rev_cache_path(
    lore_data_dir: &std::path::Path,
    channel_id: i64,
    revision: &str,
    repo_path: &std::path::Path,
) -> anyhow::Result<PathBuf> {
    // Both components are user-controlled and get joined under the lore data
    // dir. A revision must be a single safe segment; the path component is
    // already sanitized by the caller but we re-check defense-in-depth.
    if revision.is_empty()
        || revision.len() > 128
        || revision.contains('/')
        || revision.contains('\\')
        || revision == ".."
        || revision.contains('\0')
        || !revision.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
    {
        anyhow::bail!("invalid revision identifier '{revision}'");
    }
    let _ = sanitize_repo_path(repo_path.to_string_lossy().as_ref())?;
    Ok(lore_data_dir
        .join(format!("{}.revcache", channel_id))
        .join(revision)
        .join(repo_path))
}

/// Best-effort copy of a just-committed file version into the revision
/// cache so `?revision=` downloads work without lore CLI support.
async fn cache_revision_content(
    lore_data_dir: &std::path::Path,
    channel_id: i64,
    revision: &str,
    repo_path: &str,
    working_tree: &std::path::Path,
) {
    if revision.is_empty() {
        return;
    }
    let result = (|| -> anyhow::Result<()> {
        rev_cache_path(lore_data_dir, channel_id, revision, std::path::Path::new(repo_path))?;
        let source = RepoDir::open(working_tree)?.open_file(repo_path)?;
        let cache = RepoDir::open(lore_data_dir)?
            .child(std::ffi::OsStr::new(&format!("{channel_id}.revcache")), true)?
            .child(std::ffi::OsStr::new(revision), true)?;
        cache.write_from(repo_path, source)?;
        Ok(())
    })();
    if let Err(error) = result {
        warn!(%error, repo_path, revision, "revcache: confined copy failed");
    }
}

/// TTL for the external-mirror fetch cache. After this long the cache is
/// considered stale and the next read re-runs `git clone --depth 1`.
const MIRROR_CACHE_TTL_SECS: u64 = 600;

/// Durable sidecar for repo attributes that WabiDB's `LoreRepoRecord` does not
/// carry (repo class, auto-branch review flag, import provenance). Stored as
/// `.wabi-repo.json` in the channel working tree so mirrors / review flow
/// survive a restart without touching WabiDB.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct RepoStateFile {
    #[serde(default)]
    class: RepoClass,
    #[serde(default)]
    auto_branch_on_upload: bool,
    #[serde(default)]
    imported_from: Option<String>,
}


// ---------------------------------------------------------------------------
// LoreService
// ---------------------------------------------------------------------------

/// Service for managing Lore repositories and files.
pub struct LoreService {
    config: LoreConfig,
    repos: RwLock<HashMap<i64, LoreRepo>>,
    /// P4: ephemeral editor sessions (code-server bridge)
    pub editor_bridge: editor_bridge::EditorBridge,
    /// P5: collaborative script execution
    pub script_runner: script_runner::ScriptRunner,
    /// P7: off-box mirroring to GitHub/GitLab/S3
    pub mirror: mirror::MirrorService,
    /// Ignore filters per channel (lazy-loaded, mtime-checked)
    ignore_filters: std::sync::RwLock<HashMap<i64, Arc<ignore::LazyRepoFilter>>>,
    /// (size, mtime) → etag memo so listings don't re-hash unchanged files
    etag_cache: EtagCache,
    /// Serialize tree replacement, branch/CLI writes, and open/copy operations.
    /// Never held while HTTP upload bodies are being received.
    io_gate: Arc<tokio::sync::Mutex<()>>,
    #[cfg(test)]
    copy_test_hook: std::sync::Mutex<Option<CopyTestHook>>,
}

impl LoreService {
    pub fn new(config: LoreConfig) -> Self {
        let editor_config = editor_bridge::EditorBridgeConfig::default();
        let script_config = script_runner::ScriptRunnerConfig::default();
        Self {
            editor_bridge: editor_bridge::EditorBridge::new(editor_config),
            script_runner: script_runner::ScriptRunner::new(script_config),
            mirror: mirror::MirrorService::new(),
            config,
            repos: RwLock::new(HashMap::new()),
            ignore_filters: std::sync::RwLock::new(HashMap::new()),
            etag_cache: std::sync::Mutex::new(HashMap::new()),
            io_gate: Arc::new(tokio::sync::Mutex::new(())),
            #[cfg(test)]
            copy_test_hook: std::sync::Mutex::new(None),
        }
    }

    pub fn recordings_channel_name(&self) -> &str {
        &self.config.recordings_channel_name
    }

    /// Configured per-file size cap in bytes (`default_blob_max_size_mb`).
    pub fn blob_max_size_bytes(&self) -> u64 {
        u64::from(self.config.default_blob_max_size_mb) * 1024 * 1024
    }

    /// Working-tree path for a channel's repo, if registered.
    pub async fn repo_working_tree(&self, channel_id: i64) -> Option<PathBuf> {
        self.get_repo(channel_id).await.map(|r| r.working_tree)
    }

        /// Get or create the ignore filter for a channel's repo.
    fn get_ignore_filter(
        &self,
        channel_id: i64,
        working_tree: &std::path::Path,
    ) -> Arc<ignore::LazyRepoFilter> {
        use std::collections::hash_map::Entry;
        let mut filters = self.ignore_filters.write().unwrap();
        match filters.entry(channel_id) {
            Entry::Occupied(e) => e.get().clone(),
            Entry::Vacant(e) => {
                let filter = Arc::new(ignore::LazyRepoFilter::new(working_tree.to_path_buf()));
                e.insert(filter.clone());
                filter
            }
        }
    }

    /// Rebuild the in-memory repo index from durable WDB records.
    pub async fn load_existing_repos(&self, seeds: Vec<LoreRepoSeed>) {
        let _io = self.io_gate.lock().await;
        let mut repos = self.repos.write().await;
        for seed in seeds {
            let created_at = chrono::DateTime::from_timestamp_micros(seed.created_at_micros)
                .unwrap_or_else(chrono::Utc::now);
            let working_tree = self.config.lore_data_dir.join(seed.channel_id.to_string());
            // WDB can contain a historical registration after its working tree
            // was deleted or a pre-persistent deployment stored it elsewhere.
            // Do not rehydrate such ghosts: exposing them as live repos makes
            // every file/history call fail as a generic 500. The admin can
            // recreate or explicitly repair the channel instead.
            let root = match RepoDir::open(&working_tree) {
                Ok(root) if root.validate_cli_tree().is_ok() => root,
                _ => { warn!(channel_id = seed.channel_id, "Skipping unsafe Lore tree"); continue; }
            };
            let has_repo_state = root.open_internal(InternalFile::RepoState).is_ok();
            let has_lore_state = root.child(std::ffi::OsStr::new(".lore"), false).is_ok();
            if !has_lore_state && !has_repo_state {
                warn!(channel_id = seed.channel_id, path = ?working_tree, "Skipping stale Lore repo registration with no working tree");
                continue;
            }
            let mut repo = LoreRepo {
                id: LoreRepoId::new(),
                channel_id: seed.channel_id,
                lore_server_url: seed.lore_server_url,
                repo_name: seed.repo_name,
                working_tree,
                created_by: seed.created_by,
                created_at,
                class: RepoClass::Native,
                auto_branch_on_upload: false,
                imported_from: None,
            };
            // Rehydrate repo-class / review-flow attributes that WabiDB does
            // not persist, from the sidecar state file in the working tree.
            if let Ok(content) = RepoDir::open(&repo.working_tree).and_then(|dir| dir.read_internal(InternalFile::RepoState)) {
                if let Ok(cfg) = serde_json::from_slice::<RepoStateFile>(&content) {
                    repo.class = cfg.class;
                    repo.auto_branch_on_upload = cfg.auto_branch_on_upload;
                    repo.imported_from = cfg.imported_from;
                }
            }
            repos.insert(seed.channel_id, repo);
        }
    }

    /// The configured connection mode (Embedded / Sidecar / Remote).
    pub fn mode(&self) -> LoreMode {
        self.config.mode
    }

    /// Persist repo attributes that WabiDB does not carry to the sidecar state
    /// file in the working tree.
    async fn save_repo_state(&self, repo: &LoreRepo) -> anyhow::Result<()> {
        let cfg = RepoStateFile {
            class: repo.class.clone(),
            auto_branch_on_upload: repo.auto_branch_on_upload,
            imported_from: repo.imported_from.clone(),
        };
        let content = serde_json::to_vec_pretty(&cfg)?;
        RepoDir::open(&repo.working_tree)?.publish_internal(InternalFile::RepoState, &content)?;
        Ok(())
    }

    /// Refuse to write to a read-only mirror repo. Every mutating operation
    /// calls this first.
    fn ensure_writable(&self, repo: &LoreRepo) -> anyhow::Result<()> {
        if repo.read_only() {
            anyhow::bail!("mirror repos are read-only via Wabi; browse upstream");
        }
        Ok(())
    }

    /// Resolve the repo for a write and validate the target path: writability
    /// (mirrors are read-only), traversal safety (P0), and `.wabiignore`.
    /// Shared by commit-uploads and stage-only uploads so the two paths
    /// cannot drift apart.
    async fn resolve_writable_target(
        &self,
        channel_id: i64,
        repo_path: &str,
    ) -> anyhow::Result<LoreRepo> {
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;
        self.ensure_writable(&repo)?;

        // Client path policy is mandatory. Actual file operations also use
        // descriptor-relative no-follow opens; syntax alone is not confinement.
        sanitize_repo_path(repo_path)?;

        // Reject ignored paths BEFORE touching the working tree — a late
        // rejection used to leave the uploaded bytes on disk.
        let filter = self.get_ignore_filter(channel_id, &repo.working_tree);
        if filter.is_ignored(repo_path) {
            anyhow::bail!("path '{}' is ignored by .wabiignore", repo_path);
        }
        Ok(repo)
    }

    // -- Repo management --

    /// Create a new Lore repository for the given channel.
    ///
    /// Uses `lore repository create lore://host/name` which initializes
    /// the working tree in the current directory.
    pub async fn create_repo(
        &self,
        channel_id: i64,
        created_by: i64,
        repo_name: &str,
    ) -> anyhow::Result<LoreRepo> {
        let _io = self.io_gate.lock().await;
        let repo_id = LoreRepoId::new();
        let working_tree = self.config.lore_data_dir.join(channel_id.to_string());

        // Ensure parent exists
        tokio::fs::create_dir_all(&self.config.lore_data_dir).await?;
        let root = RepoDir::open(&self.config.lore_data_dir)?
            .child(std::ffi::OsStr::new(&channel_id.to_string()), true)?;
        root.validate_cli_tree()?;

        // Self-heal: a previous create may have completed on disk but failed
        // to register durably (crash, restart mid-flow, WDB write error).
        // The Lore CLI then refuses every retry with "Repository already
        // exist in path". If the tree already holds a repo, adopt it.
        if working_tree.join(".lore").exists() || working_tree.join(".wabi-repo.json").exists() {
            let mut repo = LoreRepo {
                id: repo_id,
                channel_id,
                lore_server_url: self.config.lore_server_url.clone(),
                repo_name: repo_name.to_string(),
                working_tree,
                created_by,
                created_at: chrono::Utc::now(),
                class: RepoClass::Native,
                auto_branch_on_upload: false,
                imported_from: None,
            };
            // Recover persisted attributes from the sidecar state file, same
            // as load_existing_repos does for rehydrated repos.
            if let Ok(content) = RepoDir::open(&repo.working_tree).and_then(|dir| dir.read_internal(InternalFile::RepoState)) {
                if let Ok(cfg) = serde_json::from_slice::<RepoStateFile>(&content) {
                    repo.class = cfg.class;
                    repo.auto_branch_on_upload = cfg.auto_branch_on_upload;
                    repo.imported_from = cfg.imported_from;
                }
            }
            info!(
                channel_id,
                repo_name,
                "Adopted existing Lore working tree (previous registration was lost)"
            );
            self.repos.write().await.insert(channel_id, repo.clone());
            self.save_repo_state(&repo).await?;
            return Ok(repo);
        }

        let repo_url = format!("{}/{}", self.config.lore_server_url, repo_name);

        // `lore repository create lore://host/name`
        run_lore(
            &self.config.lore_binary_path,
            &working_tree,
            &["repository", "create", &repo_url],
            self.config.mode
        )
        .await?;

        let repo = LoreRepo {
            id: repo_id,
            channel_id,
            lore_server_url: self.config.lore_server_url.clone(),
            repo_name: repo_name.to_string(),
            working_tree,
            created_by,
            created_at: chrono::Utc::now(),
            class: RepoClass::Native,
            auto_branch_on_upload: false,
            imported_from: None,
        };

        info!(
            repo_id = ?repo_id,
            channel_id,
            repo_name,
            "Created Lore repo"
        );

        self.repos.write().await.insert(channel_id, repo.clone());

        // Seed ignore files into the new repo
        self.seed_ignore_files(&repo).await?;
        self.save_repo_state(&repo).await?;

        Ok(repo)
    }

    /// Link an EXISTING Lore repo to a channel.
    ///
    /// Unlike [`create_repo`] (which makes a brand-new empty repo), this clones
    /// an existing repo from the Lore server into the channel's working tree —
    /// so a team can bind a repo that already has history (e.g. a project that
    /// was started elsewhere) without losing anything.
    pub async fn link_repo(
        &self,
        channel_id: i64,
        created_by: i64,
        repo_name: &str,
    ) -> anyhow::Result<LoreRepo> {
        let _io = self.io_gate.lock().await;
        // Embedded mode has no server to clone an existing repo from.
        if matches!(self.config.mode, LoreMode::Embedded) {
            anyhow::bail!("linking an existing lore repo requires sidecar or remote mode");
        }
        let repo_id = LoreRepoId::new();
        let working_tree = self.config.lore_data_dir.join(channel_id.to_string());

        // Ensure parent exists (parent of the working tree dir)
        if let Some(parent) = working_tree.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        let repo_url = format!("{}/{}", self.config.lore_server_url, repo_name);

        // `lore clone lore://host/name ./working_tree`
        let clone_dir = working_tree
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| std::path::PathBuf::from("/tmp"));
        run_lore(
            &self.config.lore_binary_path,
            &clone_dir,
            &[
                "clone",
                &repo_url,
                working_tree.to_str().unwrap_or("."),
            ],
            self.config.mode
        )
        .await?;

        let repo = LoreRepo {
            id: repo_id,
            channel_id,
            lore_server_url: self.config.lore_server_url.clone(),
            repo_name: repo_name.to_string(),
            working_tree,
            created_by,
            created_at: chrono::Utc::now(),
            class: RepoClass::Native,
            auto_branch_on_upload: false,
            imported_from: None,
        };

        info!(
            repo_id = ?repo_id,
            channel_id,
            repo_name,
            "Linked existing Lore repo to channel"
        );

        self.repos.write().await.insert(channel_id, repo.clone());

        RepoDir::open(&repo.working_tree)?.validate_cli_tree()?;
        // Seed ignore files (no-op if they already exist in the cloned repo)
        self.seed_ignore_files(&repo).await?;
        self.save_repo_state(&repo).await?;

        Ok(repo)
    }

    /// Seed `.wabiignore` and forward-compat `.loreignore` into a new repo.
    ///
    /// Only writes if the file doesn't already exist — so linking an existing
    /// repo that already has its own `.wabiignore` is a no-op.
    async fn seed_ignore_files(&self, repo: &LoreRepo) -> anyhow::Result<()> {
        let root = RepoDir::open(&repo.working_tree)?;
        let defaults = ignore::LazyRepoFilter::default_ignore_content();
        root.seed_internal(InternalFile::WabiIgnore, defaults.as_bytes())?;
        root.seed_internal(InternalFile::LoreIgnore, defaults.as_bytes())?;
        Ok(())
    }

    /// Get the Lore repo for a channel, if one exists.
    pub async fn get_repo(&self, channel_id: i64) -> Option<LoreRepo> {
        self.repos.read().await.get(&channel_id).cloned()
    }

    /// List all tracked repos.
    pub async fn list_repos(&self) -> Vec<LoreRepo> {
        self.repos.read().await.values().cloned().collect()
    }

    /// Forget a detached binding without touching its files or history.
    /// Call after the durable binding removal succeeds.
    pub async fn detach_repo(&self, channel_id: i64) {
        let _io = self.io_gate.lock().await;
        self.repos.write().await.remove(&channel_id);
        info!(channel_id, "Detached Lore repo (working tree kept)");
    }

    /// Delete a Lore repo for the given channel.
    pub async fn delete_repo(&self, channel_id: i64) -> anyhow::Result<()> {
        let _io = self.io_gate.lock().await;
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;

        // Mirror repos keep their fetch cache under the working tree — drop it
        // explicitly (it also lives inside the working tree, so the
        // remove_dir_all below would remove it anyway, but be explicit).
        RepoDir::open(&repo.working_tree)?;
        RepoDir::open(&self.config.lore_data_dir)?
            .remove_child_tree(std::ffi::OsStr::new(&channel_id.to_string()))?;
        self.etag_cache.lock().unwrap().retain(|(id, _), _| *id != channel_id);
        self.ignore_filters.write().unwrap().remove(&channel_id);

        self.repos.write().await.remove(&channel_id);
        info!(channel_id, "Deleted Lore repo");
        Ok(())
    }

    /// Register a read-only external mirror repo for a channel.
    ///
    /// This is a pointer, not a clone: no bytes are fetched at registration
    /// time. The channel's working tree stays empty and file/history reads
    /// lazily `git clone --depth 1` the upstream into
    /// `<lore_data_dir>/<channel_id>/.mirror-cache` (see
    /// [`LoreService::ensure_mirror_cache`]).
    pub async fn register_external_mirror(
        &self,
        channel_id: i64,
        created_by: i64,
        name: &str,
        upstream_url: &str,
    ) -> anyhow::Result<LoreRepo> {
        git_remote::validate_source_target(upstream_url)?;
        let _io = self.io_gate.lock().await;
        if self.get_repo(channel_id).await.is_some() {
            anyhow::bail!("a Lore repo already exists for channel {channel_id}");
        }
        let repo_id = LoreRepoId::new();
        let working_tree = self.config.lore_data_dir.join(channel_id.to_string());
        tokio::fs::create_dir_all(&self.config.lore_data_dir).await?;
        let root = RepoDir::open(&self.config.lore_data_dir)?
            .child(std::ffi::OsStr::new(&channel_id.to_string()), true)?;
        root.validate_cli_tree()?;

        let repo = LoreRepo {
            id: repo_id,
            channel_id,
            lore_server_url: self.config.lore_server_url.clone(),
            repo_name: name.to_string(),
            working_tree,
            created_by,
            created_at: chrono::Utc::now(),
            class: RepoClass::Mirror {
                upstream_url: upstream_url.to_string(),
            },
            auto_branch_on_upload: false,
            imported_from: None,
        };

        self.save_repo_state(&repo).await?;
        self.repos.write().await.insert(channel_id, repo.clone());

        info!(
            channel_id,
            name,
            upstream_url,
            "Registered external mirror repo (read-only via Wabi)"
        );

        Ok(repo)
    }

    /// Invalidate a mirror repo's fetch cache so the next read re-clones.
    /// Used by the mirror webhook (`POST /mirror/refresh`) when the upstream
    /// publishes new content.
    pub async fn refresh_mirror_cache(&self, channel_id: i64) -> anyhow::Result<()> {
        let _io = self.io_gate.lock().await;
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;
        if !repo.read_only() {
            anyhow::bail!("channel {channel_id} is not an external mirror repo");
        }
        let root = RepoDir::open(&repo.working_tree)?;
        match root.remove_child_tree(std::ffi::OsStr::new(".mirror-cache")) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        self.etag_cache.lock().unwrap().retain(|(id, _), _| *id != channel_id);
        self.ignore_filters.write().unwrap().remove(&channel_id);
        info!(channel_id, "Mirror cache invalidated; next read will re-fetch");
        Ok(())
    }

    /// Lazily ensure a mirror repo's fetch cache exists and is fresh.
    ///
    /// Runs `git clone --depth 1 <upstream_url>` into
    /// `<lore_data_dir>/<channel_id>/.mirror-cache` on first read and re-runs
    /// it after [`MIRROR_CACHE_TTL_SECS`] have elapsed. Returns the cache dir
    /// path that file listings / reads should be served from.
    async fn ensure_mirror_cache(&self, repo: &LoreRepo) -> anyhow::Result<PathBuf> {
        let upstream = match &repo.class {
            RepoClass::Mirror { upstream_url } => upstream_url.clone(),
            RepoClass::Native => anyhow::bail!("channel {} is not a mirror repo", repo.channel_id),
        };
        let cache = repo.working_tree.join(".mirror-cache");
        let root = RepoDir::open(&repo.working_tree)?;
        let cache_dir = match root.child(std::ffi::OsStr::new(".mirror-cache"), false) {
            Ok(dir) => Some(dir),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        let is_fresh = if let Some(dir) = &cache_dir {
            match dir.open_internal(InternalFile::MirrorFetched) {
                Ok(file) => file.metadata()?.modified()?.elapsed()
                    .map(|age| age.as_secs() < MIRROR_CACHE_TTL_SECS).unwrap_or(false),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
                Err(error) => return Err(error.into()),
            }
        } else { false };
        if !is_fresh {
            if cache_dir.is_some() {
                root.remove_child_tree(std::ffi::OsStr::new(".mirror-cache"))?;
            }
            let cache_dir = root.child(std::ffi::OsStr::new(".mirror-cache"), true)?;
            self.etag_cache.lock().unwrap().retain(|(id, _), _| *id != repo.channel_id);
            self.ignore_filters.write().unwrap().remove(&repo.channel_id);
            let output = git_remote::clone_into(&upstream, &cache).await?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                anyhow::bail!(
                    "git clone of mirror upstream failed: {}",
                    stderr.trim()
                );
            }
            cache_dir.publish_internal(InternalFile::MirrorFetched,
                chrono::Utc::now().timestamp().to_string().as_bytes())?;
            info!(
                channel_id = repo.channel_id,
                upstream = %upstream,
                "Fetched external mirror cache"
            );
        }
        Ok(cache)
    }

    // -- File operations --

    /// List files in the channel's Lore repo using `lore status --scan`.
    pub async fn list_files(
        &self,
        channel_id: i64,
        path_prefix: Option<&str>,
    ) -> anyhow::Result<Vec<LoreFileInfo>> {
        let _io = self.io_gate.lock().await;
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;

        // Mirror repos are read-only pointers: serve listings from the lazily
        // fetched git cache instead of a Lore working tree.
        if repo.read_only() {
            return self.mirror_list_files(&repo, path_prefix).await;
        }

        // `lore status --scan` reports only UNCOMMITTED changes — a committed
        // repo listed as status alone browsed as empty. The working tree is
        // the truth for browsing: walk it, then overlay status labels.
        let output = run_lore(
            &self.config.lore_binary_path,
            &repo.working_tree,
            &["status", "--scan"],
            self.config.mode
        )
        .await?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let status_map: std::collections::HashMap<String, String> = stdout
            .lines()
            .filter_map(parse_status_line)
            .collect();

        // Filter out ignored paths (node_modules, target, .env, etc.)
        let filter = self.get_ignore_filter(channel_id, &repo.working_tree);

        let mut paths: Vec<String> = walk_working_tree_files(&repo.working_tree).await;
        paths.retain(|p| sanitize_repo_path(p).is_ok() && !filter.is_ignored(p));
        paths.sort();

        let mut files: Vec<LoreFileInfo> = paths
            .into_iter()
            .map(|path| {
                let status = status_map
                    .get(&path)
                    .cloned()
                    .unwrap_or_else(|| "clean".to_string());
                LoreFileInfo {
                    path,
                    size: 0,
                    status,
                    etag: None,
                }
            })
            .collect();

        // Filter by prefix if requested
        if let Some(prefix) = path_prefix {
            files.retain(|f| f.path.starts_with(prefix));
        }

        // Enrich with file sizes and etags from the filesystem
        let root = RepoDir::open(&repo.working_tree)?;
        let mut regular_files = Vec::new();
        for mut file in files {
            let Ok(opened) = root.open_file(&file.path) else { continue; };
            file.size = opened.metadata()?.len();
            file.etag = etag_cached(&self.etag_cache, channel_id, &file.path, opened).await;
            regular_files.push(file);
        }
        let files = regular_files;

        Ok(files)
    }

    /// Serve a file listing from a mirror repo's fetch cache
    /// (`git ls-files` on the shallow clone).
    async fn mirror_list_files(
        &self,
        repo: &LoreRepo,
        path_prefix: Option<&str>,
    ) -> anyhow::Result<Vec<LoreFileInfo>> {
        let cache = self.ensure_mirror_cache(repo).await?;

        let output = Command::new("git")
            .current_dir(&cache)
            .args(["ls-files"])
            .output()
            .await?;
        if !output.status.success() {
            anyhow::bail!(
                "git ls-files failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut files: Vec<LoreFileInfo> = stdout
            .lines()
            .filter(|l| !l.is_empty())
            .map(|path| LoreFileInfo {
                path: path.to_string(),
                size: 0,
                status: "clean".to_string(),
                etag: None,
            })
            .collect();

        if let Some(prefix) = path_prefix {
            files.retain(|f| f.path.starts_with(prefix));
        }

        let filter = self.get_ignore_filter(repo.channel_id, &cache);
        files.retain(|f| sanitize_repo_path(&f.path).is_ok() && !filter.is_ignored(&f.path));

        let root = RepoDir::open(&repo.working_tree)?.child(std::ffi::OsStr::new(".mirror-cache"), false)?;
        let mut regular_files = Vec::new();
        for mut file in files {
            let Ok(opened) = root.open_file(&file.path) else { continue; };
            file.size = opened.metadata()?.len();
            file.etag = etag_cached(&self.etag_cache, repo.channel_id, &file.path, opened).await;
            regular_files.push(file);
        }
        let files = regular_files;

        Ok(files)
    }

    /// Current head etag of a single file (None = file does not exist).
    /// Used by the API for If-Match conflict checks on PUT/DELETE.
    pub async fn head_etag(
        &self,
        channel_id: i64,
        repo_path: &str,
    ) -> anyhow::Result<Option<String>> {
        let _io = self.io_gate.lock().await;
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;
        // P0 hardening: reject traversal/absolute paths before joining.
        let safe_path = sanitize_repo_path(repo_path)?;
        let root = RepoDir::open(&repo.working_tree)?;
        let root = if repo.read_only() {
            self.ensure_mirror_cache(&repo).await?;
            root.child(std::ffi::OsStr::new(".mirror-cache"), false)?
        } else {
            self.sync_repo(&repo).await?;
            root
        };
        match root.open_file(safe_path.to_str().unwrap()) {
            Ok(file) => Ok(Some(file_etag_open(file).await?)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    /// Resolve a file inside a mirror repo's fetch cache, cloning it on demand.
    /// Used by the download path to serve mirror file bytes.
    pub async fn mirror_cache_file(
        &self,
        channel_id: i64,
        repo_path: &str,
    ) -> anyhow::Result<std::fs::File> {
        let _io = self.io_gate.lock().await;
        let repo = self.get_repo(channel_id).await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;
        sanitize_repo_path(repo_path)?;
        self.ensure_mirror_cache(&repo).await?;
        Ok(RepoDir::open(&repo.working_tree)?
            .child(std::ffi::OsStr::new(".mirror-cache"), false)?.open_file(repo_path)?)
    }

    /// Upload a file to the channel's Lore repo.
    ///
    /// Copies the file into the working tree, stages, commits, and pushes.
    /// When the repo has `auto_branch_on_upload` enabled, the stage+commit
    /// happen on a fresh `uploads/{user}-{ts}` review branch and the working
    /// tree is switched back to the mainline branch — the change is pending
    /// review until approved (`approve_review_branch`) or rejected
    /// (`reject_review_branch`).
    pub async fn upload_file(
        &self,
        channel_id: i64,
        local_path: &str,
        repo_path: &str,
        message: &str,
        author_id: i64,
    ) -> anyhow::Result<LoreUploadResult> {
        let _io = self.io_gate.lock().await;
        let repo = self.resolve_writable_target(channel_id, repo_path).await?;

        // Artist-friendly review flow: switch to a fresh per-upload branch
        // BEFORE touching the working tree so the new file lands on the branch,
        // then switch back to the mainline after committing.
        let mut pending_review = false;
        let mut review_branch = None;
        let mainline_branch = if repo.auto_branch_on_upload {
            let mainline = self.current_branch_name(&repo).await?;
            let safe_user = sanitize_username(author_id);
            let branch = format!("uploads/{safe_user}-{}", chrono::Utc::now().timestamp());
            run_lore(
                &self.config.lore_binary_path,
                &repo.working_tree,
                &["branch", "create", &branch],
                self.config.mode
            )
            .await?;
            run_lore(
                &self.config.lore_binary_path,
                &repo.working_tree,
                &["branch", "switch", &branch],
                self.config.mode
            )
            .await?;
            pending_review = true;
            review_branch = Some(branch);
            info!(
                channel_id,
                branch = ?review_branch,
                "Upload routed to review branch (auto_branch_on_upload)"
            );
            Some(mainline)
        } else {
            None
        };

        // Write through held directory descriptors; imported links cannot
        // redirect either directory creation or the final publication.
        let root = RepoDir::open(&repo.working_tree)?;
        root.write_from(repo_path, std::fs::File::open(local_path)?)?;

        // Stage the file
        run_lore(
            &self.config.lore_binary_path,
            &repo.working_tree,
            &["stage", repo_path],
            self.config.mode
        )
        .await?;

        // Commit
        let commit_output = run_lore(
            &self.config.lore_binary_path,
            &repo.working_tree,
            &["commit", message],
            self.config.mode
        )
        .await?;

        // Push (no-op in embedded/offline mode)
        self.push_repo(&repo).await?;


        // Parse revision from commit output
        let stdout = String::from_utf8_lossy(&commit_output.stdout);
        let revision = parse_revision_from_output(&stdout);

        // Persist this version's bytes so `?revision=` downloads work without
        // relying on unverified lore CLI capabilities.
        cache_revision_content(
            &self.config.lore_data_dir,
            channel_id,
            &revision.hash,
            repo_path,
            &repo.working_tree,
        )
        .await;

        // Capture the committed review branch's metadata before restoring
        // mainline, which may contain older bytes or no file at this path.
        let opened = root.open_file(repo_path)?;
        let size = opened.metadata()?.len();
        let etag = file_etag_open(opened).await.ok();

        // Switch back to the mainline branch after a review-branch commit.
        if let Some(mainline) = mainline_branch {
            run_lore(
                &self.config.lore_binary_path,
                &repo.working_tree,
                &["branch", "switch", &mainline],
                self.config.mode
            )
            .await?;
        }

        // Mainline has changed again; no branch-specific etag can be retained
        // under the channel/path cache key.
        self.etag_cache.lock().unwrap().remove(&(channel_id, repo_path.to_string()));

        info!(
            channel_id,
            repo_path,
            revision = ?revision.hash,
            "Uploaded file to Lore repo"
        );


        let file_info = LoreFileInfo {
            path: repo_path.to_string(),
            size,
            status: "added".to_string(),
            etag,
        };

        Ok(LoreUploadResult {
            revision,
            file_info,
            pending_review,
            review_branch,
        })
    }

    /// Stage a file WITHOUT committing — the batch-push half of the device
    /// setup flow. A folder's files are staged one by one, then sealed with a
    /// single `snapshot`/commit, so importing N files produces ONE revision
    /// instead of N (GitHub-style "initial commit").
    ///
    /// Deliberately bypasses `auto_branch_on_upload`: staged batches are
    /// sealed by an explicit snapshot on the current branch, not routed
    /// through per-upload review branches.
    pub async fn stage_file(
        &self,
        channel_id: i64,
        local_path: &str,
        repo_path: &str,
    ) -> anyhow::Result<LoreFileInfo> {
        let _io = self.io_gate.lock().await;
        let repo = self.resolve_writable_target(channel_id, repo_path).await?;

        // Write through held directory descriptors; imported links cannot
        // redirect either directory creation or the final publication.
        let root = RepoDir::open(&repo.working_tree)?;
        root.write_from(repo_path, std::fs::File::open(local_path)?)?;

        // Stage the file (commit happens later, once, via snapshot)
        run_lore(
            &self.config.lore_binary_path,
            &repo.working_tree,
            &["stage", repo_path],
            self.config.mode
        )
        .await?;

        let opened = root.open_file(repo_path)?;
        let size = opened.metadata()?.len();
        let etag = etag_cached(&self.etag_cache, channel_id, repo_path, opened).await;

        info!(
            channel_id,
            repo_path,
            "Staged file in Lore repo (batch push, no commit yet)"
        );

        Ok(LoreFileInfo {
            path: repo_path.to_string(),
            size,
            status: "staged".to_string(),
            etag,
        })
    }

    /// Open authorized repository content through held directory descriptors.
    /// Callers must consume this handle instead of reopening a validated path.
    /// A branch/cache replacement cannot redirect the open handle to a symlink.
    pub async fn open_content_file(
        &self,
        channel_id: i64,
        repo_path: &str,
        revision: Option<&str>,
    ) -> anyhow::Result<std::fs::File> {
        let _io = self.io_gate.lock().await;
        self.open_content_file_locked(channel_id, repo_path, revision).await
    }

    /// Publish a confined snapshot. The export worker owns the I/O gate
    /// until all source handles stop being consumed, including cancellation.
    pub async fn mirror_export(&self, channel_id: i64) -> anyhow::Result<mirror::MirrorResult> {
        let gate = self.io_gate.clone().lock_owned().await;
        let repo = self.get_repo(channel_id).await
            .ok_or_else(|| anyhow::anyhow!("No Lore repository for mirror export"))?;
        let root = RepoDir::open(&repo.working_tree)?;
        let root = if matches!(repo.class, RepoClass::Mirror { .. }) {
            self.ensure_mirror_cache(&repo).await?;
            root.child(std::ffi::OsStr::new(".mirror-cache"), false)?
        } else { root };
        self.mirror.mirror(channel_id, Some(mirror::MirrorSource::new(root, gate))).await
    }

    /// Copy repository content into a caller-owned private regular file.
    /// The blocking worker owns the tree gate until it actually stops, even
    /// if the awaiting HTTP request is cancelled during a filesystem read.
    pub async fn copy_content_to(
        &self,
        channel_id: i64,
        repo_path: &str,
        revision: Option<&str>,
        mut output: std::fs::File,
    ) -> anyhow::Result<u64> {
        use std::sync::atomic::{AtomicBool, Ordering};
        struct CancelOnDrop(Arc<AtomicBool>);
        impl Drop for CancelOnDrop {
            fn drop(&mut self) { self.0.store(true, Ordering::Release); }
        }
        let gate = self.io_gate.clone().lock_owned().await;
        let mut source = self.open_content_file_locked(channel_id, repo_path, revision).await?;
        let cancelled = Arc::new(AtomicBool::new(false));
        let _cancel = CancelOnDrop(cancelled.clone());
        #[cfg(test)]
        let hook = self.copy_test_hook.lock().unwrap().take();
        tokio::task::spawn_blocking(move || -> anyhow::Result<u64> {
            use std::io::{Read, Seek, Write};
            let _gate = gate;
            #[cfg(test)]
            if let Some(hook) = hook {
                let _ = hook.started.send(());
                hook.resume.recv()?;
            }
            if cancelled.load(Ordering::Acquire) { anyhow::bail!("download cancelled"); }
            if !output.metadata()?.is_file() { anyhow::bail!("download output must be a regular file"); }
            output.set_len(0)?;
            output.seek(std::io::SeekFrom::Start(0))?;
            let mut bytes = 0u64;
            let mut buffer = [0u8; 64 * 1024];
            loop {
                if cancelled.load(Ordering::Acquire) { anyhow::bail!("download cancelled"); }
                let count = source.read(&mut buffer)?;
                if count == 0 { break; }
                if cancelled.load(Ordering::Acquire) { anyhow::bail!("download cancelled"); }
                output.write_all(&buffer[..count])?;
                bytes += count as u64;
            }
            output.flush()?;
            output.seek(std::io::SeekFrom::Start(0))?;
            Ok(bytes)
        }).await.map_err(|_| anyhow::anyhow!("download worker stopped"))?
    }

    // The caller holds io_gate through all tree selection and file opens.
    async fn open_content_file_locked(
        &self,
        channel_id: i64,
        repo_path: &str,
        revision: Option<&str>,
    ) -> anyhow::Result<std::fs::File> {
        let repo = self.get_repo(channel_id).await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;
        let safe_path = sanitize_repo_path(repo_path)?;
        if let Some(revision) = revision.filter(|r| !r.is_empty()) {
            let revision = sanitize_revision_arg(revision)?;
            if repo.read_only() {
                anyhow::bail!("revision pinning is not supported for read-only mirror repos");
            }
            rev_cache_path(&self.config.lore_data_dir, channel_id, &revision, &safe_path)?;
            return Ok(RepoDir::open(&self.config.lore_data_dir)?
                .child(std::ffi::OsStr::new(&format!("{channel_id}.revcache")), false)?
                .child(std::ffi::OsStr::new(&revision), false)?.open_file(repo_path)?);
        }
        let root = RepoDir::open(&repo.working_tree)?;
        if repo.read_only() {
            self.ensure_mirror_cache(&repo).await?;
            return Ok(root.child(std::ffi::OsStr::new(".mirror-cache"), false)?.open_file(repo_path)?);
        }
        // Even embedded sync is a no-op; never let an unsafe native tree
        // reach CLI operations before opening the requested content.
        root.validate_cli_tree()?;
        self.sync_repo(&repo).await?;
        Ok(root.open_file(repo_path)?)
    }

    /// Copy a stable download snapshot, preserving revision/mirror rules.
    pub async fn download_file(
        &self,
        channel_id: i64,
        repo_path: &str,
        output_path: &str,
        revision: Option<&str>,
    ) -> anyhow::Result<()> {
        let _io = self.io_gate.lock().await;
        let source = self.open_content_file_locked(channel_id, repo_path, revision).await?;
        let output = std::path::Path::new(output_path);
        let parent = output.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(std::path::Path::new("."));
        let name = output.file_name().and_then(|n| n.to_str()).ok_or_else(|| anyhow::anyhow!("invalid output name"))?;
        RepoDir::open(parent)?.write_from(name, source)?;
        debug!(repo_path, output_path, "Downloaded confined Lore content");
        Ok(())
    }

    /// Get file content as string.
    pub async fn get_file_content(
        &self,
        channel_id: i64,
        repo_path: &str,
    ) -> anyhow::Result<String> {
        let _io = self.io_gate.lock().await;
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;

        sanitize_repo_path(repo_path)?;
        let root = RepoDir::open(&repo.working_tree)?;
        let root = if repo.read_only() {
            self.ensure_mirror_cache(&repo).await?;
            root.child(std::ffi::OsStr::new(".mirror-cache"), false)?
        } else { root };
        Ok(String::from_utf8(root.read(repo_path)?)?)
    }

    /// Get file history using `lore history`.
    /// Accepts a path filter string (empty = all history).
    pub async fn file_history(
        &self,
        channel_id: i64,
        path_filter: &str,
    ) -> anyhow::Result<Vec<LoreRevision>> {
        let _io = self.io_gate.lock().await;
        if !path_filter.is_empty() { sanitize_repo_path(path_filter)?; }
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;

        // Mirror repos: history comes from `git log` on the shallow fetch
        // cache, with native git path filtering. Note the shallow clone only
        // carries the tip commit.
        if repo.read_only() {
            return self.mirror_history(&repo, path_filter).await;
        }

        let output = run_lore(
            &self.config.lore_binary_path,
            &repo.working_tree,
            &["history"],
            self.config.mode
        )
        .await?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let revisions = parse_history_output(&stdout);

        // `lore history` has no per-path mode, so a path filter cannot be
        // applied here honestly — the API layer filters via WabiDB commit
        // records (which carry file paths) for native repos. Unfiltered
        // callers get the whole-repo history.
        Ok(revisions)
    }

    /// Serve revision history from a mirror repo's fetch cache via
    /// `git log` (shallow clone → tip commit only). Git filters by path
    /// natively, so the path filter is honored exactly.
    async fn mirror_history(
        &self,
        repo: &LoreRepo,
        path_filter: &str,
    ) -> anyhow::Result<Vec<LoreRevision>> {
        let cache = self.ensure_mirror_cache(repo).await?;

        let mut args = vec![
            "log".to_string(),
            "--pretty=format:%H%n%an%n%at%n%s".to_string(),
        ];
        if !path_filter.is_empty() {
            args.push("--".to_string());
            args.push(path_filter.to_string());
        }
        let output = Command::new("git")
            .current_dir(&cache)
            .args(&args)
            .output()
            .await?;
        if !output.status.success() {
            anyhow::bail!(
                "git log failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let total = stdout.lines().count() as u64;
        let mut revisions = Vec::new();
        let mut lines = stdout.lines();
        let mut number = total;
        while let (Some(hash), Some(author), Some(ts), Some(subject)) =
            (lines.next(), lines.next(), lines.next(), lines.next())
        {
            revisions.push(LoreRevision {
                hash: hash.to_string(),
                revision_number: number,
                message: subject.to_string(),
                author: Some(author.to_string()),
                timestamp: ts.to_string(),
                parent: None,
            });
            number = number.saturating_sub(1);
        }
        Ok(revisions)
    }

    /// Get diff between current state and a revision.
    pub async fn get_diff(
        &self,
        channel_id: i64,
        repo_path: &str,
    ) -> anyhow::Result<LoreDiff> {
        let _io = self.io_gate.lock().await;
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;
        sanitize_repo_path(repo_path)?;

        // Mirror repos are read-only: the working tree IS the fetched upstream
        // state, so there is never a local-vs-head diff. Report empty rather
        // than refusing — diff is a read operation.
        if repo.read_only() {
            return Ok(LoreDiff {
                path: repo_path.to_string(),
                unified_diff: String::new(),
                lines_added: 0,
                lines_removed: 0,
            });
        }

        let output = run_lore(
            &self.config.lore_binary_path,
            &repo.working_tree,
            &["diff", repo_path],
            self.config.mode
        )
        .await?;

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();

        // Count additions/removals
        let lines_added = stdout.lines().filter(|l| l.starts_with('+') && !l.starts_with("+++")).count() as u32;
        let lines_removed = stdout.lines().filter(|l| l.starts_with('-') && !l.starts_with("---")).count() as u32;

        Ok(LoreDiff {
            path: repo_path.to_string(),
            unified_diff: stdout,
            lines_added,
            lines_removed,
        })
    }

    // -- Branch operations --

    /// Create a branch using `lore branch create <name>`.
    pub async fn create_branch(
        &self,
        channel_id: i64,
        branch_name: &str,
        _base_revision: Option<&str>,
    ) -> anyhow::Result<()> {
        let _io = self.io_gate.lock().await;
        sanitize_revision_arg(branch_name)?;
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;
        self.ensure_writable(&repo)?;

        run_lore(
            &self.config.lore_binary_path,
            &repo.working_tree,
            &["branch", "create", branch_name],
            self.config.mode
        )
        .await?;

        info!(branch_name, "Created branch in Lore repo");
        Ok(())
    }

    /// List branches using `lore branch list`.
    pub async fn list_branches(&self, channel_id: i64) -> anyhow::Result<Vec<LoreBranch>> {
        let _io = self.io_gate.lock().await;
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;
        self.ensure_writable(&repo)?;

        let output = run_lore(
            &self.config.lore_binary_path,
            &repo.working_tree,
            &["branch", "list"],
            self.config.mode
        )
        .await?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let branches: Vec<LoreBranch> = stdout
            .lines()
            .filter(|l| !l.is_empty())
            .map(|line| {
                let is_current = line.starts_with('*');
                let name = line.trim_start_matches('*').trim().to_string();
                LoreBranch {
                    name,
                    revision_hash: String::new(), // Would need additional parsing
                    is_current,
                }
            })
            .collect();

        Ok(branches)
    }

    /// Switch branch. Lore uses `lore branch switch <name>` or similar.
    pub async fn switch_branch(
        &self,
        channel_id: i64,
        branch_name: &str,
    ) -> anyhow::Result<()> {
        let _io = self.io_gate.lock().await;
        sanitize_revision_arg(branch_name)?;
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;
        self.ensure_writable(&repo)?;

        run_lore(
            &self.config.lore_binary_path,
            &repo.working_tree,
            &["branch", "switch", branch_name],
            self.config.mode
        )
        .await?;

        info!(branch_name, "Switched branch in Lore repo");
        Ok(())
    }

    /// Merge a branch into the current branch using `lore branch merge`.
    ///
    /// The current branch is captured first; `lore branch merge <src>` merges
    /// the source into the currently checked-out branch, so we refuse when the
    /// requested branch IS the current one (nothing to merge into itself) and
    /// push the merged result afterwards.
    pub async fn merge_branch(
        &self,
        channel_id: i64,
        branch_name: &str,
    ) -> anyhow::Result<()> {
        let _io = self.io_gate.lock().await;
        sanitize_revision_arg(branch_name)?;
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;
        self.ensure_writable(&repo)?;

        let current = self.current_branch_name(&repo).await?;
        if current == branch_name {
            anyhow::bail!(
                "branch '{branch_name}' is already checked out; merge a different branch into it"
            );
        }

        // Merge the source branch into the current branch.
        run_lore(
            &self.config.lore_binary_path,
            &repo.working_tree,
            &["branch", "merge", branch_name],
            self.config.mode
        )
        .await?;

        // Sync + publish the merged result (no-ops in embedded mode).
        self.sync_repo(&repo).await?;
        self.push_repo(&repo).await?;

        info!(
            from = branch_name,
            into = current,
            "Merged branch in Lore repo"
        );
        Ok(())
    }

    /// Name of the branch currently checked out in the repo's working tree.
    async fn current_branch_name(&self, repo: &LoreRepo) -> anyhow::Result<String> {
        let output = run_lore(
            &self.config.lore_binary_path,
            &repo.working_tree,
            &["branch", "list"],
            self.config.mode
        )
        .await?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            let line = line.trim();
            if line.starts_with('*') {
                let name = line.trim_start_matches('*').trim();
                if !name.is_empty() {
                    return Ok(name.to_string());
                }
            }
        }
        // Fallback: first non-empty line is treated as current in
        // single-branch repos.
        for line in stdout.lines() {
            let name = line.trim();
            if !name.is_empty() {
                return Ok(name.to_string());
            }
        }
        anyhow::bail!(
            "could not determine current branch in repo {}",
            repo.channel_id
        )
    }

    /// Retire a branch after its work has landed (approve) or been rejected.
    ///
    /// Lore has no destructive `branch delete`; `lore branch archive` is the
    /// native way to take a branch out of active use (it stops showing in
    /// `lore branch list` unless `--archived` is passed). If the branch is
    /// currently checked out, switch to another branch first.
    async fn retire_branch(&self, repo: &LoreRepo, branch_name: &str) -> anyhow::Result<()> {
        let current = self.current_branch_name(repo).await?;
        if current == branch_name {
            let output = run_lore(
                &self.config.lore_binary_path,
                &repo.working_tree,
                &["branch", "list"],
                self.config.mode
            )
            .await?;
            let stdout = String::from_utf8_lossy(&output.stdout);
            let other = stdout
                .lines()
                .map(|l| l.trim().trim_start_matches('*').trim().to_string())
                .find(|n| !n.is_empty() && *n != branch_name);
            if let Some(other) = other {
                run_lore(
                    &self.config.lore_binary_path,
                    &repo.working_tree,
                    &["branch", "switch", &other],
                    self.config.mode
                )
                .await?;
            } else {
                anyhow::bail!("cannot retire branch '{branch_name}': it is the only branch");
            }
        }
        run_lore(
            &self.config.lore_binary_path,
            &repo.working_tree,
            &["branch", "archive", branch_name],
            self.config.mode
        )
        .await?;
        Ok(())
    }

    /// Approve a review branch: merge it into the repo's mainline (current)
    /// branch, then retire it. Returns the tip revision of the review branch.
    pub async fn approve_review_branch(
        &self,
        channel_id: i64,
        branch_name: &str,
    ) -> anyhow::Result<LoreRevision> {
        let _io = self.io_gate.lock().await;
        sanitize_revision_arg(branch_name)?;
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;
        self.ensure_writable(&repo)?;

        let mainline = self.current_branch_name(&repo).await?;

        // Capture the review branch's tip revision to report.
        run_lore(
            &self.config.lore_binary_path,
            &repo.working_tree,
            &["branch", "switch", branch_name],
            self.config.mode
        )
        .await?;
        let history_out = run_lore(
            &self.config.lore_binary_path,
            &repo.working_tree,
            &["history"],
            self.config.mode
        )
        .await?;
        let revision = parse_history_output(&String::from_utf8_lossy(&history_out.stdout))
            .into_iter()
            .next()
            .unwrap_or_else(|| LoreRevision {
                hash: String::new(),
                revision_number: 0,
                message: format!("Approved {branch_name}"),
                author: None,
                timestamp: String::new(),
                parent: None,
            });

        // Back on the mainline, merge the review branch into it.
        run_lore(
            &self.config.lore_binary_path,
            &repo.working_tree,
            &["branch", "switch", &mainline],
            self.config.mode
        )
        .await?;
        run_lore(
            &self.config.lore_binary_path,
            &repo.working_tree,
            &["branch", "merge", branch_name],
            self.config.mode
        )
        .await?;

        // Retire the review branch.
        self.retire_branch(&repo, branch_name).await?;

        info!(channel_id, branch = branch_name, "Approved and merged review branch");
        Ok(revision)
    }

    /// Reject a review branch: retire it without merging into the mainline.
    pub async fn reject_review_branch(
        &self,
        channel_id: i64,
        branch_name: &str,
    ) -> anyhow::Result<()> {
        let _io = self.io_gate.lock().await;
        sanitize_revision_arg(branch_name)?;
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;
        self.ensure_writable(&repo)?;

        self.retire_branch(&repo, branch_name).await?;

        info!(channel_id, branch = branch_name, "Rejected review branch (retired)");
        Ok(())
    }

    /// Toggle the auto-branch review flow for a repo.
    pub async fn set_auto_branch_on_upload(
        &self,
        channel_id: i64,
        enabled: bool,
    ) -> anyhow::Result<()> {
        let _io = self.io_gate.lock().await;
        let snapshot = {
            let mut repos = self.repos.write().await;
            let repo = repos.get_mut(&channel_id).ok_or_else(|| {
                anyhow::anyhow!("No Lore repo for channel {channel_id}")
            })?;
            repo.auto_branch_on_upload = enabled;
            repo.clone()
        };
        self.save_repo_state(&snapshot).await?;
        info!(channel_id, enabled, "Updated auto_branch_on_upload");
        Ok(())
    }

    /// Commit all staged changes with a message.
    pub async fn commit_staged(
        &self,
        channel_id: i64,
        message: &str,
        _author_id: i64,
    ) -> anyhow::Result<LoreRevision> {
        let _io = self.io_gate.lock().await;
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;
        self.ensure_writable(&repo)?;

        let commit_output = run_lore(
            &self.config.lore_binary_path,
            &repo.working_tree,
            &["commit", message],
            self.config.mode
        )
        .await?;

        // Push (no-op in embedded/offline mode)
        self.push_repo(&repo).await?;

        let stdout = String::from_utf8_lossy(&commit_output.stdout);
        let revision = parse_revision_from_output(&stdout);
        // A batch snapshot seals files that stage_file did not cache. Keep
        // the I/O gate through publication so a branch switch cannot substitute
        // another revision's bytes while the snapshot is being copied.
        for path in walk_working_tree_files(&repo.working_tree).await {
            if sanitize_repo_path(&path).is_ok() {
                cache_revision_content(&self.config.lore_data_dir, channel_id,
                    &revision.hash, &path, &repo.working_tree).await;
            }
        }


        info!(channel_id, message, "Committed staged changes");
        Ok(revision)
    }

    /// Delete a file from the Lore repo.
    pub async fn delete_file(
        &self,
        channel_id: i64,
        repo_path: &str,
        message: &str,
    ) -> anyhow::Result<()> {
        let _io = self.io_gate.lock().await;
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;
        self.ensure_writable(&repo)?;

        // P0 hardening: reject traversal/absolute paths before any filesystem
        // or lore CLI touch.
        let safe_path = sanitize_repo_path(repo_path)?;

        let root = RepoDir::open(&repo.working_tree)?;
        match root.remove_file(safe_path.to_str().unwrap()) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }

        // Stage the deletion
        run_lore(
            &self.config.lore_binary_path,
            &repo.working_tree,
            &["stage", repo_path],
            self.config.mode
        )
        .await?;

        // Commit
        run_lore(
            &self.config.lore_binary_path,
            &repo.working_tree,
            &["commit", message],
            self.config.mode
        )
        .await?;

        // Push (no-op in embedded/offline mode)
        self.push_repo(&repo).await?;

        info!(channel_id, repo_path, "Deleted file from Lore repo");
        Ok(())
    }

    /// Get file-level history (alias for file_history with a specific path).
    pub async fn file_level_history(
        &self,
        channel_id: i64,
        repo_path: &str,
    ) -> anyhow::Result<Vec<LoreRevision>> {
        sanitize_repo_path(repo_path)?;
        self.file_history(channel_id, repo_path).await
    }

    /// Get diff between two revisions of a file.
    /// Returns unified diff as a string.
    pub async fn file_diff(
        &self,
        channel_id: i64,
        repo_path: &str,
        from: &str,
        to: &str,
    ) -> anyhow::Result<String> {
        let _io = self.io_gate.lock().await;
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;

        // P0 hardening: all three arguments reach the lore/git command line.
        sanitize_repo_path(repo_path)?;
        sanitize_revision_arg(from)?;
        sanitize_revision_arg(to)?;

        // Mirror repos: both revisions are git objects in the fetch cache, so
        // diff with git directly.
        if repo.read_only() {
            let cache = self.ensure_mirror_cache(&repo).await?;
            let output = Command::new("git")
                .current_dir(&cache)
                .args(["diff", from, to, "--", repo_path])
                .output()
                .await?;
            if !output.status.success() {
                anyhow::bail!(
                    "git diff failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            return Ok(String::from_utf8_lossy(&output.stdout).to_string());
        }

        // Lore diff: compare two revisions
        // If from/to are revision hashes, use `lore diff <from> <to> <path>`
        let output = run_lore(
            &self.config.lore_binary_path,
            &repo.working_tree,
            &["diff", from, to, repo_path],
            self.config.mode
        )
        .await;

        // If that fails (e.g., from/to aren't valid revision args), fall back to current diff
        match output {
            Ok(out) => Ok(String::from_utf8_lossy(&out.stdout).to_string()),
            Err(_) => {
                // Fall back to current working tree diff
                drop(_io);
                let diff_result = self.get_diff(channel_id, repo_path).await;
                match diff_result {
                    Ok(diff) => Ok(diff.unified_diff),
                    Err(e) => Err(anyhow::anyhow!("Diff failed: {}", e)),
                }
            }
        }
    }

    /// Health check — verify the Lore CLI and, in sidecar/remote modes, that
    /// the configured lore server is actually reachable (TCP connect with a
    /// short timeout). Embedded mode is offline-local only.
    pub async fn health_check(&self) -> anyhow::Result<()> {
        // Embedded mode is offline-local only — no server to ping.
        if matches!(self.config.mode, LoreMode::Embedded) {
            return Ok(());
        }
        // Verify the CLI is available
        let output = Command::new(&self.config.lore_binary_path)
            .arg("--version")
            .output()
            .await?;
        if !output.status.success() {
            anyhow::bail!("Lore CLI not available: {}", String::from_utf8_lossy(&output.stderr));
        }

        // Verify the configured lore server is reachable — a present CLI with
        // a dead server would otherwise report healthy.
        let server = self
            .config
            .lore_server_url
            .trim_start_matches("lore://")
            .trim_end_matches('/')
            .to_string();
        let (host, port) = server.rsplit_once(':').ok_or_else(|| {
            anyhow::anyhow!("invalid lore server url '{}'", self.config.lore_server_url)
        })?;
        let port: u16 = port.parse().map_err(|_| {
            anyhow::anyhow!("invalid lore server port in '{}'", self.config.lore_server_url)
        })?;
        let connect = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            tokio::net::TcpStream::connect((host, port)),
        )
        .await
        .map_err(|_| anyhow::anyhow!("lore server {host}:{port} unreachable (timeout)"))?
        .map_err(|e| anyhow::anyhow!("lore server {host}:{port} unreachable: {e}"))?;
        drop(connect);

        Ok(())
    }

    // -- Lock operations --

    /// Lock a file using `lore lock <path>`.
    pub async fn lock_file(
        &self,
        channel_id: i64,
        repo_path: &str,
        user_id: i64,
    ) -> anyhow::Result<LoreFileLock> {
        let _io = self.io_gate.lock().await;
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;
        self.ensure_writable(&repo)?;
        sanitize_repo_path(repo_path)?;

        let locked_at = chrono::Utc::now().to_rfc3339();

        // Embedded mode has no server to hold lock state — degrade to a local
        // record rather than erroring.
        if matches!(self.config.mode, LoreMode::Embedded) {
            info!(repo_path, "offline repo: file lock degraded (no server)");
            return Ok(LoreFileLock {
                path: repo_path.to_string(),
                locked_by: Some(user_id.to_string()),
                locked_at: Some(locked_at),
            });
        }

        let output = run_lore(
            &self.config.lore_binary_path,
            &repo.working_tree,
            &["lock", repo_path],
            self.config.mode
        )
        .await?;

        info!(repo_path, "Locked file in Lore repo");

        // Prefer the owner the lore server reports ("locked by <name>"),
        // falling back to the requesting user's id — Wabi knows who asked.
        let stdout = String::from_utf8_lossy(&output.stdout);
        let server_reported = stdout.lines().find_map(|l| {
            let l = l.trim();
            l.to_ascii_lowercase()
                .starts_with("locked by")
                .then(|| l.split_once(':').map(|(_, name)| name.trim().to_string()))
                .flatten()
        });

        Ok(LoreFileLock {
            path: repo_path.to_string(),
            locked_by: Some(server_reported.unwrap_or_else(|| user_id.to_string())),
            locked_at: Some(locked_at),
        })
    }

    /// Unlock a file.
    pub async fn unlock_file(
        &self,
        channel_id: i64,
        repo_path: &str,
    ) -> anyhow::Result<()> {
        let _io = self.io_gate.lock().await;
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;
        self.ensure_writable(&repo)?;
        sanitize_repo_path(repo_path)?;

        // Embedded mode has no server — no-op.
        if matches!(self.config.mode, LoreMode::Embedded) {
            info!(repo_path, "offline repo: file unlock no-op (no server)");
            return Ok(());
        }

        run_lore(
            &self.config.lore_binary_path,
            &repo.working_tree,
            &["lock", "--unlock", repo_path],
            self.config.mode
        )
        .await?;

        info!(repo_path, "Unlocked file in Lore repo");
        Ok(())
    }

    // -- Sync operations --

    /// Sync the working tree with the remote.
    pub async fn sync(&self, channel_id: i64) -> anyhow::Result<()> {
        let _io = self.io_gate.lock().await;
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;
        self.sync_repo(&repo).await
    }

    /// Push the current branch's commits to the remote.
    pub async fn push(&self, channel_id: i64) -> anyhow::Result<()> {
        let _io = self.io_gate.lock().await;
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;
        self.push_repo(&repo).await
    }

    /// Internal sync with the embedded/offline no-op handled here.
    async fn sync_repo(&self, repo: &LoreRepo) -> anyhow::Result<()> {
        // Mirror repos are pointers to git; sync is meaningless (reads lazily
        // re-fetch the git cache).
        if repo.read_only() {
            return Ok(());
        }
        if matches!(self.config.mode, LoreMode::Embedded) {
            info!("offline repo: sync skipped");
            return Ok(());
        }
        run_lore(
            &self.config.lore_binary_path,
            &repo.working_tree,
            &["sync"],
            self.config.mode
        )
        .await?;
        Ok(())
    }

    /// Internal push with the embedded/offline no-op handled here.
    async fn push_repo(&self, repo: &LoreRepo) -> anyhow::Result<()> {
        self.ensure_writable(repo)?;
        if matches!(self.config.mode, LoreMode::Embedded) {
            info!("offline repo: sync skipped");
            return Ok(());
        }
        run_lore(
            &self.config.lore_binary_path,
            &repo.working_tree,
            &["push"],
            self.config.mode
        )
        .await?;
        Ok(())
    }

    /// Get repo status.
    pub async fn status(&self, channel_id: i64) -> anyhow::Result<String> {
        let _io = self.io_gate.lock().await;
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;

        // Mirror repos: report from the git fetch cache — status is a read.
        if repo.read_only() {
            let cache = self.ensure_mirror_cache(&repo).await?;
            let output = Command::new("git")
                .current_dir(&cache)
                .args(["status", "--short"])
                .output()
                .await?;
            if !output.status.success() {
                anyhow::bail!(
                    "git status failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            return Ok(format!(
                "read-only mirror (upstream snapshot)\n{}",
                String::from_utf8_lossy(&output.stdout)
            ));
        }

        let output = run_lore(
            &self.config.lore_binary_path,
            &repo.working_tree,
            &["status", "--scan"],
            self.config.mode
        )
        .await?;

        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }

    /// Get the Lore server URL for external tool integration.
    pub fn lore_server_url(&self) -> &str {
        &self.config.lore_server_url
    }

    /// Get the repo URL for a channel.
    pub async fn repo_url(&self, channel_id: i64) -> Option<String> {
        let repo = self.get_repo(channel_id).await?;
        Some(format!("{}/{}", repo.lore_server_url, repo.repo_name))
    }

    /// Import a git repository's files into a new native Lore repo.
    ///
    /// This is a files-only migration: `git clone --depth 1` → strip `.git` →
    /// `lore repository create` in place → seed ignore files → stage all →
    /// commit "Initial import from <url>" → move into the channel working
    /// tree. History stays at the source; the caller should register a mirror
    /// alongside if history browsing is desired.
    ///
    /// The returned [`LoreImportError`] lets the API map clone failures to 502
    /// and "repo already exists" to 409.
    pub async fn import_from_git(
        &self,
        channel_id: i64,
        created_by: i64,
        name: &str,
        upstream_url: &str,
    ) -> Result<LoreRepo, LoreImportError> {
        let _io = self.io_gate.lock().await;
        if let Some(existing) = self.get_repo(channel_id).await {
            // Adopt EMPTY repos — with auto-create on, every new lore channel
            // gets a repo the moment it exists, and "create project channel →
            // import my existing code" must work, not 409. The move-into-place
            // step below replaces the pristine tree and the registration.
            // Anything with real content (or a read-only mirror) stays a hard
            // RepoExists.
            if existing.read_only()
                || RepoDir::open(&existing.working_tree).and_then(|dir| dir.validate_cli_tree()).is_err()
                || !working_tree_is_pristine(&existing.working_tree).await
            {
                return Err(LoreImportError::RepoExists);
            }
            info!(
                channel_id,
                "Adopting empty Lore repo registration for git import"
            );
        }

        let tmp_dir = std::env::temp_dir().join(format!(
            "wabi-lore-import-{}",
            uuid::Uuid::new_v4()
        ));
        tokio::fs::create_dir_all(&tmp_dir).await.map_err(LoreImportError::from)?;

        // 1. Clone upstream into a temp dir.
        let clone_out = match git_remote::clone_into(upstream_url, &tmp_dir).await {
            Ok(output) => output,
            Err(error) => {
                let _ = tokio::fs::remove_dir_all(&tmp_dir).await;
                return Err(LoreImportError::from(error));
            }
        };
        if !clone_out.status.success() {
            let stderr = String::from_utf8_lossy(&clone_out.stderr);
            let _ = tokio::fs::remove_dir_all(&tmp_dir).await;
            return Err(LoreImportError::CloneFailed(stderr.trim().to_string()));
        }

        // Imported trees cannot supply Lore/Wabi furniture or links. This
        // must precede every CLI/sidecar write, not just the final publication.
        if let Err(error) = RepoDir::open(&tmp_dir).and_then(|dir| dir.validate_import()) {
            let _ = tokio::fs::remove_dir_all(&tmp_dir).await;
            return Err(LoreImportError::Other(error.into()));
        }

        // 2. Strip the git metadata so the dir becomes a plain lore working tree.
        let git_dir = tmp_dir.join(".git");
        if git_dir.exists() {
            tokio::fs::remove_dir_all(&git_dir)
                .await
                .map_err(LoreImportError::from)?;
        }

        let repo_url = format!("{}/{}", self.config.lore_server_url, name);

        // 3. `lore repository create lore://host/name` inside the cloned dir.
        run_lore(
            &self.config.lore_binary_path,
            &tmp_dir,
            &["repository", "create", &repo_url],
            self.config.mode
        )
        .await
        .map_err(LoreImportError::from)?;

        // 4. Seed `.wabiignore` / `.loreignore` (no-op if already present).
        let scratch = LoreRepo {
            id: LoreRepoId::new(),
            channel_id,
            lore_server_url: self.config.lore_server_url.clone(),
            repo_name: name.to_string(),
            working_tree: tmp_dir.clone(),
            created_by,
            created_at: chrono::Utc::now(),
            class: RepoClass::Native,
            auto_branch_on_upload: false,
            imported_from: Some(upstream_url.to_string()),
        };
        self.seed_ignore_files(&scratch)
            .await
            .map_err(LoreImportError::from)?;

        // 5. Stage everything and create the initial import commit.
        run_lore(
            &self.config.lore_binary_path,
            &tmp_dir,
            &["stage", "."],
            self.config.mode
        )
        .await
        .map_err(LoreImportError::from)?;
        let msg = format!("Initial import from {}", upstream_url);
        run_lore(
            &self.config.lore_binary_path,
            &tmp_dir,
            &["commit", &msg],
            self.config.mode
        )
        .await
        .map_err(LoreImportError::from)?;

        // 6. Move into place as the channel's working tree. Prefer rename
        // (same filesystem); fall back to a recursive copy for /tmp → data dir.
        let working_tree = self.config.lore_data_dir.join(channel_id.to_string());
        if working_tree.exists() {
            tokio::fs::remove_dir_all(&working_tree)
                .await
                .map_err(LoreImportError::from)?;
        }
        if let Some(parent) = working_tree.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(LoreImportError::from)?;
        }
        if let Err(e) = tokio::fs::rename(&tmp_dir, &working_tree).await {
            tracing::debug!(
                error = %e,
                "import: rename across filesystems, falling back to copy"
            );
            tokio::fs::create_dir_all(&working_tree)
                .await
                .map_err(LoreImportError::from)?;
            let copy = Command::new("cp")
                .arg("-a")
                .arg(format!("{}/.", tmp_dir.display()))
                .arg(&working_tree)
                .output()
                .await
                .map_err(LoreImportError::from)?;
            if !copy.status.success() {
                let stderr = String::from_utf8_lossy(&copy.stderr);
                let _ = tokio::fs::remove_dir_all(&tmp_dir).await;
                let _ = tokio::fs::remove_dir_all(&working_tree).await;
                return Err(LoreImportError::Other(anyhow::anyhow!(
                    "failed to move imported repo into place: {}",
                    stderr.trim()
                )));
            }
            let _ = tokio::fs::remove_dir_all(&tmp_dir).await;
        }

        let repo = LoreRepo {
            id: LoreRepoId::new(),
            channel_id,
            lore_server_url: self.config.lore_server_url.clone(),
            repo_name: name.to_string(),
            working_tree,
            created_by,
            created_at: chrono::Utc::now(),
            class: RepoClass::Native,
            auto_branch_on_upload: false,
            imported_from: Some(upstream_url.to_string()),
        };
        self.save_repo_state(&repo).await.map_err(LoreImportError::from)?;
        self.repos.write().await.insert(channel_id, repo.clone());

        info!(
            channel_id,
            upstream_url,
            name,
            "Imported git repo (files only) into Lore"
        );

        Ok(repo)
    }
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/// Derive a review-branch username component from the uploader's numeric id,
/// sanitized to `[a-z0-9-]` (lore branch names are free-form, but this keeps
/// them URL/path-safe and deterministic).
fn sanitize_username(author_id: i64) -> String {
    let raw = format!("user-{author_id}");
    raw.chars()
        .map(|c| {
            if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Slug for auto-created repo names: lowercase `[a-z0-9-]`, separator runs
/// collapsed, leading/trailing dashes trimmed. A channel named "My Project!"
/// becomes repo `my-project`, so lore URLs read `lore://host/my-project`
/// instead of `lore://host/ch-47`. Empty output (e.g. input "!!!") tells the
/// caller to fall back to the `ch-{id}` form.
pub fn slugify_repo_name(input: &str) -> String {
    let mut slug = String::with_capacity(input.len());
    let mut pending_dash = false;
    for c in input.chars() {
        if c.is_ascii_alphanumeric() {
            if pending_dash && !slug.is_empty() {
                slug.push('-');
            }
            pending_dash = false;
            slug.push(c.to_ascii_lowercase());
        } else {
            pending_dash = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    slug
}

/// Collect every regular file under `root` as repo-relative POSIX paths.
/// Same furniture rules as [`working_tree_is_pristine`]: lore metadata, the
/// Wabi sidecar, ignore seeds, and the mirror cache stay hidden from
/// listings; symlinks are skipped so the walk can never escape the tree.
async fn walk_working_tree_files(root: &std::path::Path) -> Vec<String> {
    fn walk<'a>(
        root: &'a std::path::Path,
        dir: &'a std::path::Path,
        out: &'a mut Vec<String>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'a>> {
        Box::pin(async move {
            let mut entries = match tokio::fs::read_dir(dir).await {
                Ok(e) => e,
                Err(_) => return,
            };
            while let Ok(Some(entry)) = entries.next_entry().await {
                if dir == root {
                    match entry.file_name().to_string_lossy().as_ref() {
                        ".lore" | ".wabi-repo.json" | ".wabiignore" | ".loreignore"
                        | ".mirror-cache" => continue,
                        _ => {}
                    }
                }
                let path = entry.path();
                // symlink_metadata: never follow links out of the tree.
                let Ok(meta) = tokio::fs::symlink_metadata(&path).await else {
                    continue;
                };
                if meta.is_dir() {
                    walk(root, &path, out).await;
                } else if meta.is_file() {
                    if let Ok(rel) = path.strip_prefix(root) {
                        out.push(rel.to_string_lossy().replace('\\', "/"));
                    }
                }
            }
        })
    }
    let mut out = Vec::new();
    walk(root, root, &mut out).await;
    out
}

/// True when a working tree holds nothing but lore metadata and the seeded
/// ignore files — i.e. the repo was created (auto-create) but never received
/// content. Used by [`LoreService::import_from_git`] to decide whether an
/// existing registration is adoptable.
async fn working_tree_is_pristine(dir: &std::path::Path) -> bool {
    fn walk(
        dir: &std::path::Path,
        top: bool,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + '_>> {
        Box::pin(async move {
            let mut entries = match tokio::fs::read_dir(dir).await {
                Ok(e) => e,
                // Missing/unreadable tree — nothing to protect, treat as pristine.
                Err(_) => return true,
            };
            while let Ok(Some(entry)) = entries.next_entry().await {
                if top {
                    // Seeded repo furniture: lore metadata, the Wabi sidecar
                    // state file, ignore files, and the mirror clone cache.
                    match entry.file_name().to_string_lossy().as_ref() {
                        ".lore" | ".wabi-repo.json" | ".wabiignore" | ".loreignore"
                        | ".mirror-cache" => continue,
                        _ => {}
                    }
                }
                let path = entry.path();
                if path.is_dir() {
                    if !walk(&path, false).await {
                        return false;
                    }
                } else {
                    // Any user file anywhere makes the tree non-pristine.
                    return false;
                }
            }
            true
        })
    }
    walk(dir, true).await
}

/// Validate a user-supplied repo-relative path BEFORE joining it into any
/// working tree. Raw `Path::join` used to let `../` escapes reach the host
/// filesystem on every upload/download/delete/lock/diff route (audit P0).
///
/// Returns the normalized relative path on success.
pub(crate) fn sanitize_repo_path(repo_path: &str) -> anyhow::Result<std::path::PathBuf> {
    Ok(validate_repo_path(repo_path)?)
}

/// Validate a revision-ish argument passed to the lore/git CLI (`from`,
/// `to`, revision pins). These are hashes, branch names, or the literal
/// `HEAD`/`working` — never paths, so `/` is allowed (review branches look
/// like `uploads/user-1-1724…`) while whitespace, control characters,
/// flag-shaped prefixes, and absurd lengths are rejected.
pub(crate) fn sanitize_revision_arg(arg: &str) -> anyhow::Result<String> {
    if arg.is_empty() {
        anyhow::bail!("revision argument must not be empty");
    }
    if arg.len() > 256 {
        anyhow::bail!("revision argument too long");
    }
    if arg.starts_with('-') {
        anyhow::bail!("revision arguments may not start with '-'");
    }
    if arg.chars().any(|c| c.is_control() || c == '\0' || c.is_whitespace()) {
        anyhow::bail!("revision argument contains invalid characters");
    }
    Ok(arg.to_string())
}

/// Parse revision info from `lore commit` output.
///
/// Lore writes prose progress lines ("Fragmenting files…", "Committing…")
/// before the metadata block and an indented message line, so only indented
/// lines are treated as the commit message — unindented prose used to leak
/// into `revision.message`.
fn parse_revision_from_output(output: &str) -> LoreRevision {
    let mut hash = String::new();
    let mut revision_number = 0u64;
    let mut message = String::new();
    let mut timestamp = String::new();

    for raw_line in output.lines() {
        let line = raw_line.trim();
        if line.starts_with("Signature") {
            if let Some(h) = line.split(':').nth(1) {
                hash = h.trim().to_string();
            }
        } else if line.starts_with("Revision") {
            if let Some(n) = line.split(':').nth(1) {
                revision_number = n.trim().parse().unwrap_or(0);
            }
        } else if line.starts_with("Date") {
            if let Some(d) = line.split(':').nth(1) {
                timestamp = d.trim().to_string();
            }
        } else if line.starts_with("Commit succeeded") {
            break;
        } else if raw_line.starts_with(char::is_whitespace)
            && !line.is_empty()
            && message.is_empty()
        {
            message = line.to_string();
        }
    }

    LoreRevision {
        hash,
        revision_number,
        message,
        author: None,
        timestamp,
        parent: None,
    }
}

/// Parse one line of `lore status --scan` output into `(status, path)`.
///
/// Lore mixes prose into status output (progress lines, repository headers,
/// summaries). Those used to be treated as file paths, which 500'd file
/// listings. A line is a file entry only when it is either
/// `<status-char> <path>` (A/M/D/R/C/!/?/…) or a bare path-shaped token
/// (contains `/` or a `.ext`, no spaces, no trailing `:`).
pub(crate) fn parse_status_line(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Known prose prefixes seen in lore status/commit output.
    const PROSE_PREFIXES: [&str; 10] = [
        "Repository",
        "On branch",
        "Branch",
        "Scanning",
        "Committing",
        "Committed",
        "Syncing",
        "Synchronizing",
        "Fragmenting",
        "Working tree",
    ];
    if PROSE_PREFIXES.iter().any(|p| trimmed.starts_with(p)) {
        return None;
    }

    let looks_like_path = |p: &str| {
        !p.is_empty()
            && !p.contains(' ')
            && !p.ends_with(':')
            && (p.contains('/') || p.contains('.'))
    };

    // "<status> <path>" form
    if let Some((status, path)) = trimmed.split_once(' ') {
        let status = status.trim();
        let path = path.trim();
        if status.len() <= 2
            && status
                .chars()
                .all(|c| c.is_ascii_uppercase() || c == '?' || c == '!')
            && looks_like_path(path)
        {
            return Some((status.to_string(), path.to_string()));
        }
    }

    // Bare path form
    if looks_like_path(trimmed) {
        return Some(("clean".to_string(), trimmed.to_string()));
    }
    None
}

/// Parse revision history from `lore history` output.
///
/// Metadata lines are `Key : value` at column 0; commit messages are indented
/// continuation lines (see the fixtures in the tests below). Unindented
/// unknown lines are prose and are skipped rather than swallowed into the
/// current entry's message.
fn parse_history_output(output: &str) -> Vec<LoreRevision> {
    let mut revisions = Vec::new();
    let mut current: Option<LoreRevision> = None;

    for raw_line in output.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            if let Some(r) = current.take() {
                revisions.push(r);
            }
            continue;
        }

        let is_metadata = line.starts_with("Signature")
            || line.starts_with("Revision")
            || line.starts_with("Date")
            || line.starts_with("Parent")
            || line.starts_with("Branch");
        let is_message = raw_line.starts_with(char::is_whitespace);
        if !is_metadata && !is_message {
            // Unindented unknown line = prose → skip WITHOUT creating an
            // entry (prose between commits used to mint phantom revisions).
            continue;
        }

        let entry = current.get_or_insert_with(|| LoreRevision {
            hash: String::new(),
            revision_number: 0,
            message: String::new(),
            author: None,
            timestamp: String::new(),
            parent: None,
        });

        if line.starts_with("Signature") {
            if let Some(h) = line.split(':').nth(1) {
                entry.hash = h.trim().to_string();
            }
        } else if line.starts_with("Revision") {
            if let Some(n) = line.split(':').nth(1) {
                entry.revision_number = n.trim().parse().unwrap_or(0);
            }
        } else if line.starts_with("Date") {
            if let Some(d) = line.split(':').nth(1) {
                entry.timestamp = d.trim().to_string();
            }
        } else if line.starts_with("Parent") {
            if let Some(p) = line.split(':').nth(1) {
                entry.parent = Some(p.trim().to_string());
            }
        } else if line.starts_with("Branch") {
            // Skip branch line
        } else {
            // Indented continuation → commit message body
            if !entry.message.is_empty() {
                entry.message.push('\n');
            }
            entry.message.push_str(line);
        }
    }

    if let Some(r) = current {
        revisions.push(r);
    }

    revisions
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn fixture_native_service(data: &std::path::Path) -> (LoreService, LoreRepo) {
        let service = LoreService::new(LoreConfig {
            mode: LoreMode::Embedded,
            lore_data_dir: data.to_path_buf(),
            lore_binary_path: data.join("never-invoked-lore"),
            ..LoreConfig::default()
        });
        let repo = service.register_external_mirror(42, 1, "Source", "https://example.org/source.git")
            .await.unwrap();
        service.repos.write().await.get_mut(&42).unwrap().class = RepoClass::Native;
        (service, repo)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn native_direct_reads_and_uploads_reject_leaf_and_directory_symlinks() {
        use std::os::unix::fs::symlink;
        let data = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let (service, repo) = fixture_native_service(data.path()).await;
        std::fs::write(outside.path().join("victim"), b"private-canary").unwrap();
        symlink(outside.path().join("victim"), repo.working_tree.join("leaf")).unwrap();
        symlink(outside.path(), repo.working_tree.join("directory")).unwrap();
        let upload = data.path().join("upload");
        std::fs::write(&upload, b"attacker-bytes").unwrap();
        let output = data.path().join("output");
        std::fs::write(&output, b"unchanged-output").unwrap();
        for path in ["leaf", "directory/victim"] {
            assert!(service.get_file_content(42, path).await.is_err());
            assert!(service.head_etag(42, path).await.is_err());
            assert!(service.download_file(42, path, output.to_str().unwrap(), None).await.is_err());
            assert!(service.stage_file(42, upload.to_str().unwrap(), path).await.is_err());
            assert!(service.upload_file(42, upload.to_str().unwrap(), path, "attack", 1).await.is_err());
        }
        assert_eq!(std::fs::read(outside.path().join("victim")).unwrap(), b"private-canary");
        assert_eq!(std::fs::read(&output).unwrap(), b"unchanged-output");
    }

    #[tokio::test]
    async fn native_metadata_is_never_a_client_file_even_with_empty_ignore_rules() {
        let data = tempfile::tempdir().unwrap();
        let (service, repo) = fixture_native_service(data.path()).await;
        std::fs::create_dir(repo.working_tree.join(".lore")).unwrap();
        std::fs::write(repo.working_tree.join(".lore/head"), b"internal").unwrap();
        std::fs::write(repo.working_tree.join(".wabiignore"), b"").unwrap();
        let upload = data.path().join("upload");
        std::fs::write(&upload, b"attacker-bytes").unwrap();
        let output = data.path().join("output");
        for path in [".lore/head", "./.lore/head", ".wabi-repo.json", ".git/config", "src/.lore/head"] {
            assert!(service.get_file_content(42, path).await.is_err());
            assert!(service.head_etag(42, path).await.is_err());
            assert!(service.download_file(42, path, output.to_str().unwrap(), None).await.is_err());
            assert!(service.stage_file(42, upload.to_str().unwrap(), path).await.is_err());
            assert!(service.delete_file(42, path, "attack").await.is_err());
        }
        assert_eq!(std::fs::read(repo.working_tree.join(".lore/head")).unwrap(), b"internal");
        assert!(!output.exists());
        assert!(serde_json::from_slice::<RepoStateFile>(&std::fs::read(repo.working_tree.join(".wabi-repo.json")).unwrap()).is_ok());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn revision_cache_never_follows_leaf_or_directory_links() {
        use std::os::unix::fs::symlink;
        let data = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let (service, _) = fixture_native_service(data.path()).await;
        std::fs::write(outside.path().join("victim"), b"private-canary").unwrap();
        std::fs::create_dir_all(data.path().join("42.revcache/rev1")).unwrap();
        symlink(outside.path().join("victim"), data.path().join("42.revcache/rev1/leaf")).unwrap();
        symlink(outside.path(), data.path().join("42.revcache/rev1/directory")).unwrap();
        symlink(outside.path(), data.path().join("42.revcache/rev2")).unwrap();
        let output = data.path().join("output");
        std::fs::write(&output, b"unchanged-output").unwrap();
        for (path, revision) in [("leaf", "rev1"), ("directory/victim", "rev1"), ("victim", "rev2")] {
            assert!(service.download_file(42, path, output.to_str().unwrap(), Some(revision)).await.is_err());
        }
        assert_eq!(std::fs::read(&output).unwrap(), b"unchanged-output");
        assert_eq!(std::fs::read(outside.path().join("victim")).unwrap(), b"private-canary");
    }

    async fn fixture_git_repo(path: &std::path::Path) {
        std::fs::create_dir_all(path).unwrap();
        for arguments in [vec!["init", "--quiet"], vec!["add", "--all"],
            vec!["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"]] {
            let output = Command::new("git").current_dir(path).args(arguments).output().await.unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn git_import_rejects_unsafe_furniture_before_lore_cli_or_sidecar_write() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        for malicious_name in [".lore", ".wabi-repo.json", "linked-content"] {
            let data = tempfile::tempdir().unwrap();
            let source = tempfile::tempdir().unwrap();
            let outside = tempfile::tempdir().unwrap();
            std::fs::write(outside.path().join("victim"), b"canary").unwrap();
            if malicious_name == ".wabi-repo.json" {
                std::fs::write(source.path().join(malicious_name), b"{\"type\":\"mirror\"}").unwrap();
            } else {
                symlink(outside.path().join("victim"), source.path().join(malicious_name)).unwrap();
            }
            fixture_git_repo(source.path()).await;
            let cli = data.path().join("lore-fixture");
            let called = data.path().join("called");
            std::fs::write(&cli, format!("#!/bin/sh\ntouch '{}'\nexit 0\n", called.display())).unwrap();
            std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
            let service = LoreService::new(LoreConfig {
                mode: LoreMode::Embedded,
                lore_data_dir: data.path().join("repos"),
                lore_binary_path: cli,
                ..LoreConfig::default()
            });
            assert!(service.import_from_git(42, 1, "Imported", source.path().to_str().unwrap()).await.is_err());
            assert!(!called.exists(), "CLI saw unsafe imported furniture {malicious_name}");
            assert!(service.get_repo(42).await.is_none());
            assert_eq!(std::fs::read(outside.path().join("victim")).unwrap(), b"canary");
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn real_git_import_adopts_empty_auto_created_native_repo() {
        use std::os::unix::fs::PermissionsExt;
        let data = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        std::fs::write(source.path().join("hello.txt"), b"real imported Git content").unwrap();
        fixture_git_repo(source.path()).await;
        let cli = data.path().join("lore-fixture");
        let calls = data.path().join("calls");
        std::fs::write(&cli, format!("#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'\nexit 0\n", calls.display())).unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
        let service = LoreService::new(LoreConfig {
            mode: LoreMode::Embedded,
            lore_data_dir: data.path().join("repos"),
            lore_binary_path: cli,
            ..LoreConfig::default()
        });
        let initial = service.create_repo(42, 1, "auto-created").await.unwrap();
        assert!(working_tree_is_pristine(&initial.working_tree).await);
        let imported = service.import_from_git(42, 1, "Imported", source.path().to_str().unwrap()).await.unwrap();
        assert_eq!(imported.repo_name, "Imported");
        assert_eq!(imported.imported_from.as_deref(), source.path().to_str());
        assert_eq!(std::fs::read(imported.working_tree.join("hello.txt")).unwrap(), b"real imported Git content");
        assert!(!imported.working_tree.join(".git").exists());
        assert_eq!(service.get_repo(42).await.unwrap().repo_name, "Imported");
        let saved: RepoStateFile = serde_json::from_slice(&std::fs::read(imported.working_tree.join(".wabi-repo.json")).unwrap()).unwrap();
        assert_eq!(saved.imported_from, imported.imported_from);
        let calls = std::fs::read_to_string(calls).unwrap();
        assert!(calls.contains("repository create"));
        assert!(calls.contains("stage ."));
        assert!(calls.contains("commit Initial import"));
        assert!(matches!(service.import_from_git(42, 1, "Overwrite", source.path().to_str().unwrap()).await, Err(LoreImportError::RepoExists)));
    }

    #[tokio::test]
    async fn mirror_concurrent_reads_share_a_fresh_clone_and_skip_links_and_metadata() {
        let data = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(source.path().join("normal.txt"), b"first").unwrap();
        std::fs::write(source.path().join(".wabi-repo.json"), b"untrusted metadata").unwrap();
        #[cfg(unix)] {
            std::fs::write(outside.path().join("victim"), b"private-canary").unwrap();
            std::os::unix::fs::symlink(outside.path().join("victim"), source.path().join("link")).unwrap();
            std::os::unix::fs::symlink(outside.path(), source.path().join("directory")).unwrap();
        }
        fixture_git_repo(source.path()).await;
        let service = LoreService::new(LoreConfig { lore_data_dir: data.path().to_path_buf(), ..LoreConfig::default() });
        service.register_external_mirror(42, 1, "Source", source.path().to_str().unwrap()).await.unwrap();
        let (first, second, third) = tokio::join!(
            service.get_file_content(42, "normal.txt"),
            service.get_file_content(42, "normal.txt"),
            service.get_file_content(42, "normal.txt"),
        );
        assert_eq!(first.unwrap(), "first");
        assert_eq!(second.unwrap(), "first");
        assert_eq!(third.unwrap(), "first");
        std::fs::write(source.path().join("normal.txt"), b"second").unwrap();
        for arguments in [vec!["add", "--all"], vec!["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "second"]] {
            assert!(Command::new("git").current_dir(source.path()).args(arguments).output().await.unwrap().status.success());
        }
        // Old freshness logic compared an epoch timestamp with 600 seconds,
        // unnecessarily cloning on every read and racing concurrent readers.
        assert_eq!(service.get_file_content(42, "normal.txt").await.unwrap(), "first");
        assert!(service.get_file_content(42, ".wabi-repo.json").await.is_err());
        #[cfg(unix)] {
            assert!(service.get_file_content(42, "link").await.is_err());
            assert!(service.head_etag(42, "directory/victim").await.is_err());
        }
        let files = service.list_files(42, None).await.unwrap();
        assert_eq!(files.iter().map(|file| file.path.as_str()).collect::<Vec<_>>(), vec!["normal.txt"]);
        service.refresh_mirror_cache(42).await.unwrap();
        assert_eq!(service.get_file_content(42, "normal.txt").await.unwrap(), "second");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn batch_snapshot_pins_original_bytes_through_confined_revision_publication() {
        use std::os::unix::fs::PermissionsExt;
        let data = tempfile::tempdir().unwrap();
        let (mut service, repo) = fixture_native_service(data.path()).await;
        let cli = data.path().join("lore-fixture");
        std::fs::write(&cli, b"#!/bin/sh\nprintf 'Signature : abc123\\n'\n").unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
        service.config.lore_binary_path = cli;
        let upload = data.path().join("upload");
        std::fs::write(&upload, b"original").unwrap();
        service.stage_file(42, upload.to_str().unwrap(), "docs/file.txt").await.unwrap();
        let revision = service.commit_staged(42, "Snapshot", 1).await.unwrap();
        assert_eq!(revision.hash, "abc123");
        std::fs::write(repo.working_tree.join("docs/file.txt"), b"new-head").unwrap();
        let output = data.path().join("output");
        service.download_file(42, "docs/file.txt", output.to_str().unwrap(), Some(&revision.hash)).await.unwrap();
        assert_eq!(std::fs::read(output).unwrap(), b"original");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn review_upload_pins_review_bytes_before_restoring_mainline() {
        use std::os::unix::fs::PermissionsExt;
        // Exercise replacement and brand-new files: mainline restores old
        // bytes in the first case, and removes the new path in the second.
        for mainline_has_file in [true, false] {
            let data = tempfile::tempdir().unwrap();
            let (mut service, repo) = fixture_native_service(data.path()).await;
            service.repos.write().await.get_mut(&42).unwrap().auto_branch_on_upload = true;
            std::fs::create_dir(repo.working_tree.join("docs")).unwrap();
            std::fs::create_dir(repo.working_tree.join(".lore")).unwrap();
            if mainline_has_file {
                std::fs::write(repo.working_tree.join("docs/file.txt"), b"mainline").unwrap();
                std::fs::write(repo.working_tree.join(".lore/mainline-file"), b"mainline").unwrap();
            }
            let cli = data.path().join("lore-fixture");
            std::fs::write(&cli, br##"#!/bin/sh
if [ "$3" = branch ] && [ "$4" = list ]; then
  printf '* main\n'
elif [ "$3" = branch ] && [ "$4" = switch ] && [ "$5" = main ]; then
  if [ -f .lore/mainline-file ]; then cp .lore/mainline-file docs/file.txt; else rm docs/file.txt; fi
else
  printf 'Signature : def456\n'
fi
"##).unwrap();
            std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
            service.config.lore_binary_path = cli;
            let upload = data.path().join("upload");
            std::fs::write(&upload, b"review-content").unwrap();
            let result = service.upload_file(42, upload.to_str().unwrap(), "docs/file.txt", "Review", 1).await.unwrap();
            assert!(result.pending_review);
            assert_eq!(result.revision.hash, "def456");
            assert_eq!(result.file_info.size, b"review-content".len() as u64);
            assert_eq!(result.file_info.etag, Some(etag_for_bytes(b"review-content")));
            let output = data.path().join("output");
            service.download_file(42, "docs/file.txt", output.to_str().unwrap(), Some(&result.revision.hash)).await.unwrap();
            assert_eq!(std::fs::read(output).unwrap(), b"review-content");
            if mainline_has_file {
                assert_eq!(service.get_file_content(42, "docs/file.txt").await.unwrap(), "mainline");
            } else {
                assert!(service.head_etag(42, "docs/file.txt").await.unwrap().is_none());
            }
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn archive_handles_cannot_be_redirected_after_listing_or_open() {
        use std::io::Read;
        use std::os::unix::fs::symlink;
        let data = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let (service, repo) = fixture_native_service(data.path()).await;
        std::fs::write(repo.working_tree.join("normal.txt"), b"inside").unwrap();
        std::fs::write(outside.path().join("victim"), b"private-canary").unwrap();
        // Simulate a tree/branch change after listing and after a secure open.
        let mut opened = service.open_content_file(42, "normal.txt", None).await.unwrap();
        std::fs::remove_file(repo.working_tree.join("normal.txt")).unwrap();
        symlink(outside.path().join("victim"), repo.working_tree.join("normal.txt")).unwrap();
        let mut bytes = Vec::new();
        opened.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"inside");
        assert!(service.open_content_file(42, "normal.txt", None).await.is_err());
        assert!(service.open_content_file(42, ".wabi-repo.json", None).await.is_err());
        assert_eq!(std::fs::read(outside.path().join("victim")).unwrap(), b"private-canary");
    }

    #[tokio::test]
    async fn descriptor_snapshot_preserves_retained_temp_handle_and_cancellation_gate() {
        let data = tempfile::tempdir().unwrap();
        let (service, repo) = fixture_native_service(data.path()).await;
        std::fs::write(repo.working_tree.join("normal.txt"), b"inside").unwrap();
        let temporary = tempfile::NamedTempFile::new().unwrap();
        assert_eq!(service.copy_content_to(42, "normal.txt", None, temporary.as_file().try_clone().unwrap()).await.unwrap(), 6);
        let mut retained = temporary.as_file().try_clone().unwrap();
        use std::io::{Read, Seek};
        retained.seek(std::io::SeekFrom::Start(0)).unwrap();
        let mut bytes = Vec::new();
        retained.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"inside");

        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (resume_tx, resume_rx) = std::sync::mpsc::channel();
        *service.copy_test_hook.lock().unwrap() = Some(CopyTestHook { started: started_tx, resume: resume_rx });
        let service = Arc::new(service);
        let worker_service = service.clone();
        let output = temporary.as_file().try_clone().unwrap();
        let worker = tokio::spawn(async move { worker_service.copy_content_to(42, "normal.txt", None, output).await });
        started_rx.await.unwrap();
        worker.abort();
        assert!(worker.await.unwrap_err().is_cancelled());
        assert!(service.io_gate.try_lock().is_err(), "cancelled request released admission before its blocking worker stopped");
        resume_tx.send(()).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(1), service.io_gate.lock()).await.unwrap();
        assert_eq!(std::fs::read(temporary.path()).unwrap(), b"inside");
    }

    #[tokio::test]
    async fn detached_binding_is_unavailable_but_files_survive_relink() {
        let temp = tempfile::tempdir().unwrap();
        let service = LoreService::new(LoreConfig {
            lore_data_dir: temp.path().to_path_buf(),
            ..LoreConfig::default()
        });
        let repo = service.register_external_mirror(42, 1, "Source", "https://example.org/source.git").await.unwrap();
        tokio::fs::write(repo.working_tree.join("preserved.txt"), b"keep this").await.unwrap();
        service.detach_repo(42).await;
        assert!(service.get_repo(42).await.is_none());
        assert!(service.list_repos().await.is_empty());
        assert_eq!(tokio::fs::read(repo.working_tree.join("preserved.txt")).await.unwrap(), b"keep this");
        assert!(repo.working_tree.join(".wabi-repo.json").exists());
        service.register_external_mirror(42, 1, "Source", "https://example.org/source.git").await.unwrap();
        assert!(service.get_repo(42).await.is_some());
        assert_eq!(tokio::fs::read(repo.working_tree.join("preserved.txt")).await.unwrap(), b"keep this");
    }

    #[test]
    fn test_parse_commit_output() {
        let output = r#"Fragmenting files and updating tree hashes
Committing staged changes
Committed 2/2 directories, 2/2 files, 269.00 bytes/269.00 bytes (2 modified, 0 deleted)
Repository: 3f2a1b4c5d6e7f8a923b5e2b2f74fbe8
Revision  : 1
Signature : a3f8c2d1e4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1
Branch    : e726318bbc3fd75ac8733a7e030cc35b
Date      : Wed, 14 Jan 2026 09:24:18 +0000
    Initial revision
Commit succeeded"#;

        let revision = parse_revision_from_output(output);
        assert_eq!(revision.revision_number, 1);
        assert!(!revision.hash.is_empty());
        assert!(!revision.timestamp.is_empty());
        // The indented message line, not the prose progress lines above it.
        assert_eq!(revision.message, "Initial revision");
    }

    #[test]
    fn test_parse_status_line_rejects_prose() {
        // Real-shaped lore status output with prose mixed in.
        let output = r#"Repository: 3f2a1b4c5d6e7f8a923b5e2b2f74fbe8
On branch e726318bbc3fd75ac8733a7e030cc35b
Scanning working tree for changes
A src/main.rs
M docs/readme.md
Committed 2/2 directories, 2/2 files, 269.00 bytes
Fragmenting files and updating tree hashes
D old/legacy.txt"#;

        let files: Vec<(String, String)> = output.lines().filter_map(parse_status_line).collect();
        assert_eq!(
            files,
            vec![
                ("A".to_string(), "src/main.rs".to_string()),
                ("M".to_string(), "docs/readme.md".to_string()),
                ("D".to_string(), "old/legacy.txt".to_string()),
            ]
        );
    }

    #[test]
    fn test_parse_status_line_bare_paths_and_noise() {
        assert_eq!(
            parse_status_line("assets/textures/skin.png"),
            Some(("clean".into(), "assets/textures/skin.png".into()))
        );
        assert_eq!(
            parse_status_line("notes.txt"),
            Some(("clean".into(), "notes.txt".into()))
        );
        // Summary lines, headers, and sentences are not paths.
        assert_eq!(parse_status_line("3 files changed"), None);
        assert_eq!(parse_status_line("Working tree clean"), None);
        assert_eq!(parse_status_line("Syncing with lore://host:10000"), None);
        assert_eq!(parse_status_line(""), None);
    }

    #[test]
    fn test_parse_history_skips_prose_between_entries() {
        let output = r#"Revision  : 3
Signature : 352cba705adcadb430541b5dd8c80f8da13c38dae1a3e4f4f12307d010acc3ca
Branch    : e726318bbc3fd75ac8733a7e030cc35b
Date      : Sat, 8 Aug 2026 03:06:29 +0000
    Add Wabi Rust skeleton

Scanning repository metadata
3 revisions displayed

Revision  : 2
Signature : a42adab82488bc6fbe024520a6a5fb689e03ad6c1135d64b72aa89ffb8ff14b
Branch    : e726318bbc3fd75ac8733a7e030cc35b
Date      : Sat, 8 Aug 2026 03:05:43 +0000
    Add feature module"#;

        let revisions = parse_history_output(output);
        assert_eq!(revisions.len(), 2);
        assert_eq!(revisions[0].revision_number, 3);
        assert_eq!(revisions[0].message, "Add Wabi Rust skeleton");
        assert_eq!(revisions[1].revision_number, 2);
        assert_eq!(revisions[1].message, "Add feature module");
    }

    #[tokio::test]
    async fn test_etag_for_bytes_stable_and_sensitive() {
        let a = etag_for_bytes(b"hello world");
        let b = etag_for_bytes(b"hello world");
        let c = etag_for_bytes(b"hello world!");
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_eq!(a.len(), 64); // hex sha-256
    }

    #[tokio::test]
    async fn test_file_etag_small_file_matches_bytes_hash() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("f.bin");
        tokio::fs::write(&p, b"small payload").await.unwrap();
        let etag = file_etag(&p).await.unwrap();
        assert_eq!(etag, etag_for_bytes(b"small payload"));
    }

    #[tokio::test]
    async fn test_rev_cache_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let tree = dir.path().join("225");
        tokio::fs::create_dir_all(tree.join("src")).await.unwrap();
        tokio::fs::write(tree.join("src/main.rs"), b"fn main() {}").await.unwrap();

        let rev = "abc123";
        cache_revision_content(dir.path(), 225, rev, "src/main.rs", &tree).await;
        let cached = rev_cache_path(dir.path(), 225, rev, "src/main.rs".as_ref()).unwrap();
        let content = tokio::fs::read(&cached).await.unwrap();
        assert_eq!(content, b"fn main() {}");
        // Outside the working tree, so lore status never sees it.
        assert!(cached.starts_with(dir.path().join("225.revcache")));
    }

    #[test]
    fn test_sanitize_repo_path_rejects_traversal_and_absolute() {
        assert!(sanitize_repo_path("../etc/passwd").is_err());
        assert!(sanitize_repo_path("a/../../b").is_err());
        assert!(sanitize_repo_path("/etc/passwd").is_err());
        assert!(sanitize_repo_path("..\\windows\\system32").is_err());
        assert!(sanitize_repo_path("foo\0bar").is_err());
        assert!(sanitize_repo_path("").is_err());
        assert!(sanitize_repo_path("src/main.rs").is_ok());
        assert!(sanitize_repo_path("./src/main.rs").is_ok());
        assert!(sanitize_repo_path(".hidden").is_ok());
    }

    #[test]
    fn test_sanitize_revision_arg_rules() {
        assert!(sanitize_revision_arg("abc123").is_ok());
        assert!(sanitize_revision_arg("HEAD").is_ok());
        assert!(sanitize_revision_arg("uploads/user-1-1724").is_ok());
        assert!(sanitize_revision_arg("-oProxyCommand=x").is_err());
        assert!(sanitize_revision_arg("a b").is_err());
        assert!(sanitize_revision_arg("").is_err());
    }

    #[test]
    fn test_rev_cache_path_rejects_bad_revision_segments() {
        let dir = tempfile::tempdir().unwrap();
        assert!(rev_cache_path(dir.path(), 1, "../evil", "x.txt".as_ref()).is_err());
        assert!(rev_cache_path(dir.path(), 1, "a/b", "x.txt".as_ref()).is_err());
        assert!(rev_cache_path(dir.path(), 1, "..", "x.txt".as_ref()).is_err());
        assert!(rev_cache_path(dir.path(), 1, "abc123", "x.txt".as_ref()).is_ok());
    }

    #[test]
    fn test_parse_history_output() {
        let output = r#"Revision  : 3
Signature : 352cba705adcadb430541b5dd8c80f8da13c38dae1a3e4f4f12307d010acc3ca
Branch    : e726318bbc3fd75ac8733a7e030cc35b
Date      : Sat, 8 Aug 2026 03:06:29 +0000
    Add Wabi Rust skeleton

Revision  : 2
Signature : a42adab82488bc6fbe024520a6a5fb689e03ad6c1135d64b72aa89ffb8ff14b
Branch    : e726318bbc3fd75ac8733a7e030cc35b
Date      : Sat, 8 Aug 2026 03:05:43 +0000
    Add feature module"#;

        let revisions = parse_history_output(output);
        assert_eq!(revisions.len(), 2);
        assert_eq!(revisions[0].revision_number, 3);
        assert_eq!(revisions[1].revision_number, 2);
    }

    #[test]
    fn test_repo_class_default_is_native() {
        assert_eq!(RepoClass::default(), RepoClass::Native);
        // serde-tagged roundtrip
        let native = serde_json::json!({ "type": "native" });
        assert_eq!(
            serde_json::from_value::<RepoClass>(native).unwrap(),
            RepoClass::Native
        );
        let mirror = serde_json::json!({ "type": "mirror", "upstream_url": "https://x/y.git" });
        assert_eq!(
            serde_json::from_value::<RepoClass>(mirror).unwrap(),
            RepoClass::Mirror {
                upstream_url: "https://x/y.git".into()
            }
        );
    }

    #[test]
    fn test_lore_repo_read_only() {
        let base = |class: RepoClass| LoreRepo {
            id: LoreRepoId::new(),
            channel_id: 1,
            lore_server_url: "lore://localhost:1".into(),
            repo_name: "r".into(),
            working_tree: PathBuf::from("/tmp/wabi-lore-test"),
            created_by: 0,
            created_at: chrono::Utc::now(),
            class,
            auto_branch_on_upload: false,
            imported_from: None,
        };
        assert!(!base(RepoClass::Native).read_only());
        assert!(base(RepoClass::Mirror {
            upstream_url: "https://x/y.git".into()
        })
        .read_only());
    }

    #[test]
    fn test_repo_class_defaults_in_json() {
        // Old repo metadata (no `class`) deserializes as Native.
        let repo_json = serde_json::json!({
            "id": "00000000-0000-0000-0000-000000000000",
            "channel_id": 1,
            "lore_server_url": "lore://localhost:1",
            "repo_name": "r",
            "working_tree": "/tmp/wabi-lore-test",
            "created_by": 0,
            "created_at": "2026-01-01T00:00:00Z"
        });
        let repo: LoreRepo = serde_json::from_value(repo_json).unwrap();
        assert_eq!(repo.class, RepoClass::Native);
        assert!(!repo.auto_branch_on_upload);
        assert!(repo.imported_from.is_none());
    }

    #[test]
    fn test_sanitize_username() {
        assert_eq!(sanitize_username(42), "user-42");
        // '-' is an allowed char, so negative ids pass through harmlessly.
        assert_eq!(sanitize_username(-7), "user--7");
    }

    #[test]
    fn test_slugify_repo_name() {
        assert_eq!(slugify_repo_name("Wabi"), "wabi");
        assert_eq!(slugify_repo_name("My Project!"), "my-project");
        // Separator runs collapse; leading/trailing junk trims away.
        assert_eq!(slugify_repo_name("  --Audio -- Assets-- "), "audio-assets");
        // Unicode falls back to separators, never panics.
        assert_eq!(slugify_repo_name("日本語プロジェクト"), "");
        assert_eq!(slugify_repo_name("!!!"), "");
    }

    #[tokio::test]
    async fn test_walk_working_tree_files() {
        let tmp = tempfile::tempdir().unwrap();
        // Furniture is hidden; nested files come back as POSIX rel paths.
        tokio::fs::create_dir_all(tmp.path().join(".lore")).await.unwrap();
        tokio::fs::create_dir_all(tmp.path().join("src/deep")).await.unwrap();
        tokio::fs::write(tmp.path().join(".wabi-repo.json"), b"{}")
            .await
            .unwrap();
        for f in ["README.md", ".wabiignore", "src/hello.rs", "src/deep/x.txt"] {
            tokio::fs::write(tmp.path().join(f), b"x").await.unwrap();
        }
        // A symlink must not be followed or listed.
        #[cfg(unix)]
        tokio::fs::symlink("/etc/hostname", tmp.path().join("escape"))
            .await
            .ok();

        let mut paths = walk_working_tree_files(tmp.path()).await;
        paths.sort();
        assert_eq!(
            paths,
            vec![
                "README.md".to_string(),
                "src/deep/x.txt".to_string(),
                "src/hello.rs".to_string(),
            ]
        );
    }

    #[tokio::test]
    async fn test_working_tree_is_pristine() {
        let tmp = tempfile::tempdir().unwrap();
        // Empty tree: pristine.
        tokio::fs::create_dir_all(tmp.path()).await.unwrap();
        assert!(working_tree_is_pristine(tmp.path()).await);

        // Seeded furniture only: still pristine.
        for furniture in [".lore", ".mirror-cache"] {
            tokio::fs::create_dir_all(tmp.path().join(furniture))
                .await
                .unwrap();
        }
        for file in [".wabi-repo.json", ".wabiignore", ".loreignore"] {
            tokio::fs::write(tmp.path().join(file), b"x")
                .await
                .unwrap();
        }
        assert!(working_tree_is_pristine(tmp.path()).await);

        // Furniture inside .lore is ignored wholesale.
        tokio::fs::write(tmp.path().join(".lore/head"), b"x")
            .await
            .unwrap();
        assert!(working_tree_is_pristine(tmp.path()).await);

        // Any user file — even nested, even empty — breaks pristine.
        tokio::fs::create_dir_all(tmp.path().join("src"))
            .await
            .unwrap();
        tokio::fs::write(tmp.path().join("src/hello.rs"), b"fn main() {}")
            .await
            .unwrap();
        assert!(!working_tree_is_pristine(tmp.path()).await);
    }
}
