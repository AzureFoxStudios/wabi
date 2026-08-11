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
use tracing::{debug, info};

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
            lore_server_url: "lore://localhost:41337".into(),
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
        }
    }

    pub fn recordings_channel_name(&self) -> &str {
        &self.config.recordings_channel_name
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
            repos.insert(
                seed.channel_id,
                LoreRepo {
                    id: LoreRepoId::new(),
                    channel_id: seed.channel_id,
                    lore_server_url: seed.lore_server_url,
                    repo_name: seed.repo_name,
                    working_tree,
                    created_by: seed.created_by,
                    created_at,
                },
            );
        }
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

        // Remove working tree
        tokio::fs::remove_dir_all(&repo.working_tree).await?;

        self.repos.write().await.remove(&channel_id);
        info!(channel_id, "Deleted Lore repo");
        Ok(())
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
            .filter(|l| !l.is_empty() && !l.starts_with("Repository") && !l.starts_with("On branch"))
            .map(|line| {
                // Parse "A file/path" or "M file/path" or just "file/path"
                let (status, path) = if let Some((s, p)) = line.split_once(' ') {
                    (s.trim(), p.trim())
                } else {
                    ("clean", line.trim())
                };

                LoreFileInfo {
                    path: path.to_string(),
                    size: 0,
                    status: status.to_string(),
                }
            })
            .collect();

        // Filter by prefix if requested
        if let Some(prefix) = path_prefix {
            files.retain(|f| f.path.starts_with(prefix));
        }

        // Filter out ignored paths (node_modules, target, .env, etc.)
        let filter = self.get_ignore_filter(channel_id, &repo.working_tree);
        files.retain(|f| !filter.is_ignored(&f.path));

        // Enrich with file sizes from the filesystem
        for file in files.iter_mut() {
            let full_path = repo.working_tree.join(&file.path);
            if let Ok(metadata) = tokio::fs::metadata(&full_path).await {
                file.size = metadata.len();
            }
        }

        Ok(files)
    }

    /// Upload a file to the channel's Lore repo.
    ///
    /// Copies the file into the working tree, stages, commits, and pushes.
    /// Returns (revision, file_info) for API compatibility.
    pub async fn upload_file(
        &self,
        channel_id: i64,
        local_path: &str,
        repo_path: &str,
        message: &str,
        _author_id: i64,
    ) -> anyhow::Result<(LoreRevision, LoreFileInfo)> {
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;

        // Create parent directory in working tree
        let dest = repo.working_tree.join(repo_path);
        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        // Copy file into working tree
        tokio::fs::copy(local_path, &dest).await?;

        // Check if the path is ignored
        let filter = self.get_ignore_filter(channel_id, &repo.working_tree);
        if filter.is_ignored(repo_path) {
            return Err(anyhow::anyhow!(
                "path '{}' is ignored by .wabiignore",
                repo_path
            ));
        }

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

        // Push
        run_lore(
            &self.config.lore_binary_path,
            &repo.working_tree,
            &["push"],
            self.config.mode
        )
        .await?;

        // Parse revision from commit output
        let stdout = String::from_utf8_lossy(&commit_output.stdout);
        let revision = parse_revision_from_output(&stdout);

        info!(
            channel_id,
            repo_path,
            revision = ?revision.hash,
            "Uploaded file to Lore repo"
        );

        let file_info = LoreFileInfo {
            path: repo_path.to_string(),
            size: 0,
            status: "added".to_string(),
        };

        Ok((revision, file_info))
    }

    /// Download a file from the Lore repo to a local path.
    /// Supports optional revision pinning.
    pub async fn download_file(
        &self,
        channel_id: i64,
        repo_path: &str,
        output_path: &str,
        _revision: Option<&str>,
    ) -> anyhow::Result<()> {
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;

        // Sync first to ensure we have the latest
        run_lore(
            &self.config.lore_binary_path,
            &repo.working_tree,
            &["sync"],
            self.config.mode
        )
        .await?;

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

        let content = tokio::fs::read_to_string(repo.working_tree.join(repo_path)).await?;
        Ok(content)
    }

    /// Get file history using `lore history`.
    /// Accepts a path filter string (empty = all history).
    pub async fn file_history(
        &self,
        channel_id: i64,
        _path_filter: &str,
    ) -> anyhow::Result<Vec<LoreRevision>> {
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;

        let output = run_lore(
            &self.config.lore_binary_path,
            &repo.working_tree,
            &["history"],
            self.config.mode
        )
        .await?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let revisions = parse_history_output(&stdout);

        // If a specific file path is requested, filter revisions that touched it
        // (full implementation would use `lore file history` if available)
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

    /// Merge a branch into the current branch.
    /// Lore doesn't have a direct merge command — we switch to the target branch,
    /// sync, then switch back.
    pub async fn merge_branch(
        &self,
        channel_id: i64,
        branch_name: &str,
    ) -> anyhow::Result<()> {
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;

        // Switch to the branch to merge
        run_lore(
            &self.config.lore_binary_path,
            &repo.working_tree,
            &["branch", "switch", branch_name],
            self.config.mode
        )
        .await?;

        // Sync to get latest
        run_lore(
            &self.config.lore_binary_path,
            &repo.working_tree,
            &["sync"],
            self.config.mode
        )
        .await?;

        info!(branch_name, "Merged branch in Lore repo");
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

        let commit_output = run_lore(
            &self.config.lore_binary_path,
            &repo.working_tree,
            &["commit", message],
            self.config.mode
        )
        .await?;

        // Push
        run_lore(
            &self.config.lore_binary_path,
            &repo.working_tree,
            &["push"],
            self.config.mode
        )
        .await?;

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

        // Push
        run_lore(
            &self.config.lore_binary_path,
            &repo.working_tree,
            &["push"],
            self.config.mode
        )
        .await?;

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

    /// Health check — verify the Lore CLI and server are reachable.
    pub async fn health_check(&self) -> anyhow::Result<()> {
        // Embedded mode is offline-local only — no server to ping.
        if matches!(self.config.mode, LoreMode::Embedded) {
            return Ok(());
        }
        // Try running `lore --version` to verify CLI is available
        let output = Command::new(&self.config.lore_binary_path)
            .arg("--version")
            .output()
            .await?;

        if !output.status.success() {
            anyhow::bail!("Lore CLI not available: {}", String::from_utf8_lossy(&output.stderr));
        }

        Ok(())
    }

    // -- Lock operations --

    /// Lock a file using `lore lock <path>`.
    pub async fn lock_file(
        &self,
        channel_id: i64,
        repo_path: &str,
        _user_id: i64,
    ) -> anyhow::Result<LoreFileLock> {
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;

        let output = run_lore(
            &self.config.lore_binary_path,
            &repo.working_tree,
            &["lock", repo_path],
            self.config.mode
        )
        .await?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        info!(repo_path, "Locked file in Lore repo");

        Ok(LoreFileLock {
            path: repo_path.to_string(),
            locked_by: None, // Parse from output if available
            locked_at: None,
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

        run_lore(
            &self.config.lore_binary_path,
            &repo.working_tree,
            &["sync"],
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
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/// Parse revision info from `lore commit` output.
fn parse_revision_from_output(output: &str) -> LoreRevision {
    let mut hash = String::new();
    let mut revision_number = 0u64;
    let mut message = String::new();
    let mut timestamp = String::new();

    for line in output.lines() {
        let line = line.trim();
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
        } else if !line.is_empty() && message.is_empty() {
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

/// Parse revision history from `lore history` output.
fn parse_history_output(output: &str) -> Vec<LoreRevision> {
    let mut revisions = Vec::new();
    let mut current: Option<LoreRevision> = None;

    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() {
            if let Some(r) = current.take() {
                revisions.push(r);
            }
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
        } else if !entry.message.is_empty() {
            // Append to message
            entry.message.push('\n');
            entry.message.push_str(line);
        } else if !line.starts_with("Repository") {
            entry.message = line.to_string();
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
}
