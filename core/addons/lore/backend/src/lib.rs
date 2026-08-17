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
    let mut cmd = Command::new(binary);
    cmd.current_dir(working_dir)
        .env("HOME", "/var/wabi/lore");
    if matches!(mode, LoreMode::Embedded) {
        cmd.arg("--offline").arg("--local");
    }
    let output = cmd
        .args(args)
        .output()
        .await?;

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
    use sha2::{Digest, Sha256};
    let meta = tokio::fs::metadata(path).await?;
    if meta.len() <= ETAG_FULL_HASH_MAX_BYTES {
        let bytes = tokio::fs::read(path).await?;
        return Ok(etag_for_bytes(&bytes));
    }
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut file = tokio::fs::File::open(path).await?;
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
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

async fn etag_cached(
    cache: &EtagCache,
    channel_id: i64,
    path: &str,
    full_path: &std::path::Path,
) -> Option<String> {
    let meta = tokio::fs::metadata(full_path).await.ok()?;
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
    let etag = file_etag(full_path).await.ok()?;
    cache
        .lock()
        .unwrap()
        .insert((channel_id, path.to_string()), (meta.len(), mtime, etag.clone()));
    Some(etag)
}

/// Path of a cached file version:
/// `<lore_data_dir>/<channel_id>.revcache/<revision>/<repo_path>`.
/// Lives OUTSIDE the working tree so `lore status` never sees it.
fn rev_cache_path(lore_data_dir: &std::path::Path, channel_id: i64, revision: &str, repo_path: &str) -> PathBuf {
    lore_data_dir
        .join(format!("{}.revcache", channel_id))
        .join(revision)
        .join(repo_path)
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
    let dest = rev_cache_path(lore_data_dir, channel_id, revision, repo_path);
    if let Some(parent) = dest.parent() {
        if let Err(e) = tokio::fs::create_dir_all(parent).await {
            warn!(error = %e, repo_path, "revcache: create dir failed");
            return;
        }
    }
    if let Err(e) = tokio::fs::copy(working_tree.join(repo_path), &dest).await {
        warn!(error = %e, repo_path, revision, "revcache: copy failed");
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

fn repo_state_path(working_tree: &PathBuf) -> PathBuf {
    working_tree.join(".wabi-repo.json")
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
            let has_repo_state = working_tree.join(".wabi-repo.json").exists();
            let has_lore_state = working_tree.join(".lore").exists();
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
            let cfg_path = repo_state_path(&repo.working_tree);
            if let Ok(content) = tokio::fs::read_to_string(&cfg_path).await {
                if let Ok(cfg) = serde_json::from_str::<RepoStateFile>(&content) {
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
        let path = repo_state_path(&repo.working_tree);
        let content = serde_json::to_string_pretty(&cfg)?;
        tokio::fs::write(&path, content).await?;
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
        let repo_id = LoreRepoId::new();
        let working_tree = self.config.lore_data_dir.join(channel_id.to_string());

        // Ensure parent exists
        tokio::fs::create_dir_all(&working_tree).await?;

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
        self.seed_ignore_files(&repo).await.ok();
        self.save_repo_state(&repo).await.ok();

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

        // Seed ignore files (no-op if they already exist in the cloned repo)
        self.seed_ignore_files(&repo).await.ok();
        self.save_repo_state(&repo).await.ok();

        Ok(repo)
    }

    /// Seed `.wabiignore` and forward-compat `.loreignore` into a new repo.
    ///
    /// Only writes if the file doesn't already exist — so linking an existing
    /// repo that already has its own `.wabiignore` is a no-op.
    async fn seed_ignore_files(&self, repo: &LoreRepo) -> anyhow::Result<()> {
        let wabiignore = repo.working_tree.join(".wabiignore");
        if !wabiignore.exists() {
            tokio::fs::write(
                &wabiignore,
                ignore::LazyRepoFilter::default_ignore_content(),
            )
            .await?;
            info!(path = ?wabiignore, "Seeded .wabiignore");
        }

        // Forward-compat: seed .loreignore so when Lore adds native support
        // (EpicGames/lore#118), the repo is ready.
        let loreignore = repo.working_tree.join(".loreignore");
        if !loreignore.exists() {
            tokio::fs::write(
                &loreignore,
                ignore::LazyRepoFilter::default_ignore_content(),
            )
            .await?;
            info!(path = ?loreignore, "Seeded .loreignore (forward-compat)");
        }

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

    /// Delete a Lore repo for the given channel.
    pub async fn delete_repo(&self, channel_id: i64) -> anyhow::Result<()> {
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;

        // Mirror repos keep their fetch cache under the working tree — drop it
        // explicitly (it also lives inside the working tree, so the
        // remove_dir_all below would remove it anyway, but be explicit).
        let mirror_cache = repo.working_tree.join(".mirror-cache");
        if mirror_cache.exists() {
            tokio::fs::remove_dir_all(&mirror_cache).await?;
        }

        // Remove working tree
        tokio::fs::remove_dir_all(&repo.working_tree).await?;

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
        if self.get_repo(channel_id).await.is_some() {
            anyhow::bail!("a Lore repo already exists for channel {channel_id}");
        }
        let repo_id = LoreRepoId::new();
        let working_tree = self.config.lore_data_dir.join(channel_id.to_string());
        tokio::fs::create_dir_all(&working_tree).await?;

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
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;
        if !repo.read_only() {
            anyhow::bail!("channel {channel_id} is not an external mirror repo");
        }
        let cache = repo.working_tree.join(".mirror-cache");
        if cache.exists() {
            tokio::fs::remove_dir_all(&cache).await?;
        }
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
        let marker = cache.join(".wabi-mirror-fetched-at");

        let is_fresh = tokio::fs::metadata(&marker)
            .await
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::SystemTime::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() < MIRROR_CACHE_TTL_SECS)
            .unwrap_or(false);

        if !is_fresh {
            if cache.exists() {
                tokio::fs::remove_dir_all(&cache).await?;
            }
            tokio::fs::create_dir_all(&cache).await?;
            let output = Command::new("git")
                .arg("clone")
                .arg("--depth")
                .arg("1")
                .arg(&upstream)
                .arg(&cache)
                .output()
                .await?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                anyhow::bail!(
                    "git clone of mirror upstream failed: {}",
                    stderr.trim()
                );
            }
            tokio::fs::write(&marker, format!("{}", chrono::Utc::now().timestamp())).await?;
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
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;

        // Mirror repos are read-only pointers: serve listings from the lazily
        // fetched git cache instead of a Lore working tree.
        if repo.read_only() {
            return self.mirror_list_files(&repo, path_prefix).await;
        }

        // `lore status --scan` outputs file status
        let output = run_lore(
            &self.config.lore_binary_path,
            &repo.working_tree,
            &["status", "--scan"],
            self.config.mode
        )
        .await?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut files: Vec<LoreFileInfo> = stdout
            .lines()
            .filter_map(parse_status_line)
            .map(|(status, path)| LoreFileInfo {
                path,
                size: 0,
                status,
                etag: None,
            })
            .collect();

        // Filter by prefix if requested
        if let Some(prefix) = path_prefix {
            files.retain(|f| f.path.starts_with(prefix));
        }

        // Filter out ignored paths (node_modules, target, .env, etc.)
        let filter = self.get_ignore_filter(channel_id, &repo.working_tree);
        files.retain(|f| !filter.is_ignored(&f.path));

        // Enrich with file sizes and etags from the filesystem
        for file in files.iter_mut() {
            let full_path = repo.working_tree.join(&file.path);
            if let Ok(metadata) = tokio::fs::metadata(&full_path).await {
                file.size = metadata.len();
            }
            file.etag = etag_cached(&self.etag_cache, channel_id, &file.path, &full_path).await;
        }

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
        files.retain(|f| !filter.is_ignored(&f.path));

        for file in files.iter_mut() {
            let full_path = cache.join(&file.path);
            if let Ok(metadata) = tokio::fs::metadata(&full_path).await {
                file.size = metadata.len();
            }
            file.etag = etag_cached(&self.etag_cache, repo.channel_id, &file.path, &full_path).await;
        }

        Ok(files)
    }

    /// Current head etag of a single file (None = file does not exist).
    /// Used by the API for If-Match conflict checks on PUT/DELETE.
    pub async fn head_etag(
        &self,
        channel_id: i64,
        repo_path: &str,
    ) -> anyhow::Result<Option<String>> {
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;
        let base = if repo.read_only() {
            self.ensure_mirror_cache(&repo).await?
        } else {
            self.sync_repo(&repo).await?;
            repo.working_tree.clone()
        };
        let full = base.join(repo_path);
        if !tokio::fs::try_exists(&full).await.unwrap_or(false) {
            return Ok(None);
        }
        Ok(Some(file_etag(&full).await?))
    }

    /// Resolve a file inside a mirror repo's fetch cache, cloning it on demand.
    /// Used by the download path to serve mirror file bytes.
    pub async fn mirror_cache_file(
        &self,
        channel_id: i64,
        repo_path: &str,
    ) -> anyhow::Result<PathBuf> {
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;
        if !repo.read_only() {
            anyhow::bail!("channel {channel_id} is not an external mirror repo");
        }
        let cache = self.ensure_mirror_cache(&repo).await?;
        let full = cache.join(repo_path);
        if !full.exists() {
            anyhow::bail!(
                "file '{}' not found in mirror repo for channel {channel_id}",
                repo_path
            );
        }
        Ok(full)
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
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;
        self.ensure_writable(&repo)?;

        // Reject ignored paths BEFORE touching the working tree or creating a
        // review branch — a late rejection used to leave the uploaded bytes
        // on disk and the repo stranded on the review branch.
        {
            let filter = self.get_ignore_filter(channel_id, &repo.working_tree);
            if filter.is_ignored(repo_path) {
                return Err(anyhow::anyhow!(
                    "path '{}' is ignored by .wabiignore",
                    repo_path
                ));
            }
        }

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

        // Create parent directory in working tree
        let dest = repo.working_tree.join(repo_path);
        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        // Copy file into working tree
        tokio::fs::copy(local_path, &dest).await?;

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

        info!(
            channel_id,
            repo_path,
            revision = ?revision.hash,
            "Uploaded file to Lore repo"
        );

        let size = tokio::fs::metadata(&dest).await.map(|m| m.len()).unwrap_or(0);
        let etag = file_etag(&dest).await.ok();
        // The file may have changed again on disk; the cache is keyed by
        // (size, mtime) so a stale entry self-heals on next read.
        if let Some(etag) = &etag {
            let mtime = tokio::fs::metadata(&dest)
                .await
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::SystemTime::UNIX_EPOCH).ok())
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            self.etag_cache.lock().unwrap().insert(
                (channel_id, repo_path.to_string()),
                (size, mtime, etag.clone()),
            );
        }

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

    /// Download a file from the Lore repo to a local path.
    /// Supports revision pinning: revision-pinned reads are served from the
    /// local revision cache (populated at wabi-mediated commit time); head
    /// reads come from the (synced) working tree.
    pub async fn download_file(
        &self,
        channel_id: i64,
        repo_path: &str,
        output_path: &str,
        revision: Option<&str>,
    ) -> anyhow::Result<()> {
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;

        if let Some(rev) = revision.filter(|r| !r.is_empty()) {
            if repo.read_only() {
                anyhow::bail!("revision pinning is not supported for read-only mirror repos");
            }
            let cached =
                rev_cache_path(&self.config.lore_data_dir, channel_id, rev, repo_path);
            if !cached.exists() {
                anyhow::bail!(
                    "no cached content for '{repo_path}' at revision '{rev}' \
                     (only versions committed through Wabi are cached)"
                );
            }
            tokio::fs::copy(&cached, output_path).await?;
            debug!(repo_path, rev, "Downloaded from revision cache");
            return Ok(());
        }

        // Mirror downloads are served from the git fetch cache via
        // `mirror_cache_file` — the lore CLI path never runs for mirrors.
        if repo.read_only() {
            let source = self.mirror_cache_file(channel_id, repo_path).await?;
            tokio::fs::copy(source, output_path).await?;
            debug!(repo_path, output_path, "Downloaded from mirror repo cache");
            return Ok(());
        }

        // Sync first to ensure we have the latest (no-op in embedded mode)
        self.sync_repo(&repo).await?;

        // Copy from working tree
        let source = repo.working_tree.join(repo_path);
        tokio::fs::copy(source, output_path).await?;

        debug!(repo_path, output_path, "Downloaded from Lore repo");
        Ok(())
    }

    /// Get file content as string.
    pub async fn get_file_content(
        &self,
        channel_id: i64,
        repo_path: &str,
    ) -> anyhow::Result<String> {
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;

        // Mirror repos: read from the lazily fetched git cache.
        if repo.read_only() {
            let cache = self.ensure_mirror_cache(&repo).await?;
            let full = cache.join(repo_path);
            let content = tokio::fs::read_to_string(&full).await.map_err(|e| {
                anyhow::anyhow!("read '{repo_path}' from mirror repo: {e}")
            })?;
            return Ok(content);
        }

        let content = tokio::fs::read_to_string(repo.working_tree.join(repo_path)).await?;
        Ok(content)
    }

    /// Get file history using `lore history`.
    /// Accepts a path filter string (empty = all history).
    pub async fn file_history(
        &self,
        channel_id: i64,
        path_filter: &str,
    ) -> anyhow::Result<Vec<LoreRevision>> {
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
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;

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
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;
        self.ensure_writable(&repo)?;

        // Remove file from working tree
        let file_path = repo.working_tree.join(repo_path);
        if file_path.exists() {
            tokio::fs::remove_file(&file_path).await?;
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
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;

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
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;
        self.ensure_writable(&repo)?;

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
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;
        self.ensure_writable(&repo)?;

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
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;
        self.sync_repo(&repo).await
    }

    /// Push the current branch's commits to the remote.
    pub async fn push(&self, channel_id: i64) -> anyhow::Result<()> {
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
        if self.get_repo(channel_id).await.is_some() {
            return Err(LoreImportError::RepoExists);
        }

        let tmp_dir = std::env::temp_dir().join(format!(
            "wabi-lore-import-{}",
            uuid::Uuid::new_v4()
        ));
        tokio::fs::create_dir_all(&tmp_dir).await.map_err(LoreImportError::from)?;

        // 1. Clone upstream into a temp dir.
        let clone_out = Command::new("git")
            .arg("clone")
            .arg("--depth")
            .arg("1")
            .arg(upstream_url)
            .arg(&tmp_dir)
            .output()
            .await
            .map_err(LoreImportError::from)?;
        if !clone_out.status.success() {
            let stderr = String::from_utf8_lossy(&clone_out.stderr);
            let _ = tokio::fs::remove_dir_all(&tmp_dir).await;
            return Err(LoreImportError::CloneFailed(stderr.trim().to_string()));
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
        let cached = rev_cache_path(dir.path(), 225, rev, "src/main.rs");
        let content = tokio::fs::read(&cached).await.unwrap();
        assert_eq!(content, b"fn main() {}");
        // Outside the working tree, so lore status never sees it.
        assert!(cached.starts_with(dir.path().join("225.revcache")));
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
}
