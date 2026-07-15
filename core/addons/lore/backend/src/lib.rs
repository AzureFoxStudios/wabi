//! Wabi Lore addon — version-controlled binary asset storage via Epic Games Lore.
//!
//! This addon manages a Lore repository per channel, providing full VCS semantics
//! (branching, revision history, chunk-level dedup, file locking) for large binary
//! assets such as CAD files, 3D models, and textures.
//!
//! ## Mode of operation
//!
//! Phase 1 wraps the `lore` CLI binary via subprocess. Phase 2 may replace this
//! with direct calls to the `lore` Rust crate once its API stabilizes past v1.0.
//!
//! ## Integration with WabiDB
//!
//! Lore revisions are recorded in the WabiDB event log as `Event::LoreCommit`
//! events, so channel members see commits in their message stream and the event
//! log remains the source of truth for application-layer metadata.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tokio::process::Command;
use tokio::sync::RwLock;
use tracing::{debug, info};

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
    pub created_by: i64,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

/// A commit/revision within a Lore repository.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoreRevision {
    pub hash: String,
    pub repo_id: LoreRepoId,
    pub message: String,
    pub author_id: i64,
    pub timestamp: chrono::DateTime<chrono::Utc>,
    pub file_count: u32,
}

/// File metadata within a Lore repo.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoreFileInfo {
    pub path: String,
    pub size: u64,
    pub hash: String,
    pub revision: String,
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

/// Minimal, dependency-free description of a persisted Lore repo. Used to
/// rehydrate the in-memory repo index after a restart without coupling this
/// addon to the `wabidb` crate.
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
    pub lore_data_dir: PathBuf,
    pub default_blob_max_size_mb: u32,
    /// Name of the Asset Storage channel that finished call recordings are
    /// uploaded to automatically. The operator must create this channel once;
    /// the addon looks it up by name (it is never auto-created).
    pub recordings_channel_name: String,
}

impl Default for LoreConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            mode: LoreMode::Sidecar,
            lore_server_url: "lore://localhost:10000".into(),
            lore_binary_path: PathBuf::from("lore"),
            lore_data_dir: PathBuf::from("/var/wabi/lore"),
            default_blob_max_size_mb: 1024,
            recordings_channel_name: "Recordings".into(),
        }
    }
}

// ---------------------------------------------------------------------------
// LoreService
// ---------------------------------------------------------------------------

/// Service for managing Lore repositories and files.
///
/// Wraps the Lore CLI and coordinates with WabiDB for metadata persistence.
pub struct LoreService {
    config: LoreConfig,
    /// Tracked repos keyed by channel_id
    repos: RwLock<HashMap<i64, LoreRepo>>,
}

impl LoreService {
    pub fn new(config: LoreConfig) -> Self {
        Self {
            config,
            repos: RwLock::new(HashMap::new()),
        }
    }

    /// Name of the Asset Storage channel that finished call recordings are
    /// uploaded to.
    pub fn recordings_channel_name(&self) -> &str {
        &self.config.recordings_channel_name
    }

    /// Rebuild the in-memory repo index from durable WDB records. Call once at
    /// startup, since `repos` is not persisted across process restarts.
    pub async fn load_existing_repos(&self, seeds: Vec<LoreRepoSeed>) {
        let mut repos = self.repos.write().await;
        for seed in seeds {
            let created_at = chrono::DateTime::from_timestamp_micros(seed.created_at_micros)
                .unwrap_or_else(chrono::Utc::now);
            repos.insert(
                seed.channel_id,
                LoreRepo {
                    id: LoreRepoId::new(),
                    channel_id: seed.channel_id,
                    lore_server_url: seed.lore_server_url,
                    repo_name: seed.repo_name,
                    created_by: seed.created_by,
                    created_at,
                },
            );
        }
    }

    // -- Repo management --

    /// Create a new Lore repository for the given channel.
    pub async fn create_repo(
        &self,
        channel_id: i64,
        created_by: i64,
        repo_name: &str,
    ) -> anyhow::Result<LoreRepo> {
        let repo_id = LoreRepoId::new();
        let repo = LoreRepo {
            id: repo_id,
            channel_id,
            lore_server_url: self.config.lore_server_url.clone(),
            repo_name: repo_name.to_string(),
            created_by,
            created_at: chrono::Utc::now(),
        };

        let output = Command::new(&self.config.lore_binary_path)
            .arg("repo")
            .arg("create")
            .arg(repo_name)
            .arg("--server")
            .arg(&self.config.lore_server_url)
            .output()
            .await?;

        if !output.status.success() {
            anyhow::bail!(
                "Lore repo create failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        info!(?repo_id, channel_id, repo_name, "Created Lore repo");
        self.repos.write().await.insert(channel_id, repo.clone());
        Ok(repo)
    }

    /// Get the Lore repo for a channel, if one exists.
    pub async fn get_repo(&self, channel_id: i64) -> Option<LoreRepo> {
        self.repos.read().await.get(&channel_id).cloned()
    }

    /// List all tracked repos.
    pub async fn list_repos(&self) -> Vec<LoreRepo> {
        self.repos.read().await.values().cloned().collect()
    }

    /// List files in the channel's Lore repo.
    ///
    /// Optionally filtered by a directory prefix.
    pub async fn list_files(
        &self,
        channel_id: i64,
        path_prefix: Option<&str>,
    ) -> anyhow::Result<Vec<LoreFileInfo>> {
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;

        let mut cmd = Command::new(&self.config.lore_binary_path);
        cmd.arg("file")
            .arg("list")
            .arg("--repo")
            .arg(&repo.repo_name)
            .arg("--server")
            .arg(&self.config.lore_server_url);

        if let Some(prefix) = path_prefix {
            cmd.arg("--prefix").arg(prefix);
        }

        let output = cmd.output().await?;

        if !output.status.success() {
            anyhow::bail!(
                "Lore file list failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let files: Vec<LoreFileInfo> = serde_json::from_str(&stdout)
            .unwrap_or_else(|_| {
                stdout
                    .lines()
                    .filter(|l| !l.is_empty())
                    .map(|line| LoreFileInfo {
                        path: line.to_string(),
                        size: 0,
                        hash: String::new(),
                        revision: String::new(),
                    })
                    .collect()
            });
        Ok(files)
    }

    // -- File operations --

    /// Upload a file to the channel's Lore repo and commit.
    ///
    /// Returns the revision hash and file info.
    pub async fn upload_file(
        &self,
        channel_id: i64,
        local_path: &str,
        repo_path: &str,
        message: &str,
        author_id: i64,
    ) -> anyhow::Result<(LoreRevision, LoreFileInfo)> {
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;

        let output = Command::new(&self.config.lore_binary_path)
            .arg("file")
            .arg("write")
            .arg("--repo")
            .arg(&repo.repo_name)
            .arg("--server")
            .arg(&self.config.lore_server_url)
            .arg(local_path)
            .arg(format!(":{}", repo_path))
            .output()
            .await?;

        if !output.status.success() {
            anyhow::bail!(
                "Lore file write failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        let commit_output = Command::new(&self.config.lore_binary_path)
            .arg("commit")
            .arg("--repo")
            .arg(&repo.repo_name)
            .arg("--server")
            .arg(&self.config.lore_server_url)
            .arg("-m")
            .arg(message)
            .output()
            .await?;

        if !commit_output.status.success() {
            anyhow::bail!(
                "Lore commit failed: {}",
                String::from_utf8_lossy(&commit_output.stderr)
            );
        }

        let revision_hash = String::from_utf8_lossy(&commit_output.stdout)
            .trim()
            .to_string();

        let revision = LoreRevision {
            hash: revision_hash.clone(),
            repo_id: repo.id,
            message: message.to_string(),
            author_id,
            timestamp: chrono::Utc::now(),
            file_count: 1,
        };

        let file_info = LoreFileInfo {
            path: repo_path.to_string(),
            size: 0, // TODO: query Lore for actual size
            hash: revision_hash.clone(),
            revision: revision_hash,
        };

        info!(?revision, "Committed file to Lore repo");
        Ok((revision, file_info))
    }

    /// Download a file from the channel's Lore repo.
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

        let mut cmd = Command::new(&self.config.lore_binary_path);
        cmd.arg("file")
            .arg("write")
            .arg("--repo")
            .arg(&repo.repo_name)
            .arg("--server")
            .arg(&self.config.lore_server_url)
            .arg(repo_path)
            .arg(output_path);

        if let Some(rev) = revision {
            cmd.arg("--revision").arg(rev);
        }

        let output = cmd.output().await?;

        if !output.status.success() {
            anyhow::bail!(
                "Lore file download failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        debug!(repo_path, output_path, "Downloaded from Lore repo");
        Ok(())
    }

    /// Get file history from the Lore repo.
    pub async fn file_history(
        &self,
        channel_id: i64,
        repo_path: &str,
    ) -> anyhow::Result<Vec<LoreRevision>> {
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;

        let output = Command::new(&self.config.lore_binary_path)
            .arg("file")
            .arg("history")
            .arg("--repo")
            .arg(&repo.repo_name)
            .arg("--server")
            .arg(&self.config.lore_server_url)
            .arg(repo_path)
            .output()
            .await?;

        if !output.status.success() {
            anyhow::bail!(
                "Lore file history failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let revisions: Vec<LoreRevision> = serde_json::from_str(&stdout)?;
        Ok(revisions)
    }

    // -- Branch operations --

    /// Create a branch in the channel's Lore repo.
    pub async fn create_branch(
        &self,
        channel_id: i64,
        branch_name: &str,
        base_revision: Option<&str>,
    ) -> anyhow::Result<()> {
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;

        let mut cmd = Command::new(&self.config.lore_binary_path);
        cmd.arg("branch")
            .arg("create")
            .arg("--repo")
            .arg(&repo.repo_name)
            .arg("--server")
            .arg(&self.config.lore_server_url)
            .arg(branch_name);

        if let Some(rev) = base_revision {
            cmd.arg("--revision").arg(rev);
        }

        let output = cmd.output().await?;

        if !output.status.success() {
            anyhow::bail!(
                "Lore branch create failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        info!(branch_name, "Created branch in Lore repo");
        Ok(())
    }

    /// List branches in the channel's Lore repo.
    pub async fn list_branches(&self, channel_id: i64) -> anyhow::Result<Vec<String>> {
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;

        let output = Command::new(&self.config.lore_binary_path)
            .arg("branch")
            .arg("list")
            .arg("--repo")
            .arg(&repo.repo_name)
            .arg("--server")
            .arg(&self.config.lore_server_url)
            .output()
            .await?;

        if !output.status.success() {
            anyhow::bail!(
                "Lore branch list failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        Ok(stdout.lines().map(|l| l.to_string()).collect())
    }

    // -- Repo management operations --

    /// Delete a Lore repo for the given channel.
    pub async fn delete_repo(&self, channel_id: i64) -> anyhow::Result<()> {
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;

        let output = Command::new(&self.config.lore_binary_path)
            .arg("repo")
            .arg("delete")
            .arg(&repo.repo_name)
            .arg("--server")
            .arg(&self.config.lore_server_url)
            .output()
            .await?;

        if !output.status.success() {
            anyhow::bail!(
                "Lore repo delete failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        self.repos.write().await.remove(&channel_id);
        info!(channel_id, repo_name = repo.repo_name, "Deleted Lore repo");
        Ok(())
    }

    /// Snapshot: commit all currently staged changes without a file upload.
    pub async fn commit_staged(
        &self,
        channel_id: i64,
        message: &str,
        author_id: i64,
    ) -> anyhow::Result<LoreRevision> {
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;

        let output = Command::new(&self.config.lore_binary_path)
            .arg("commit")
            .arg("--repo")
            .arg(&repo.repo_name)
            .arg("--server")
            .arg(&self.config.lore_server_url)
            .arg("-m")
            .arg(message)
            .output()
            .await?;

        if !output.status.success() {
            anyhow::bail!(
                "Lore commit failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        let revision_hash = String::from_utf8_lossy(&output.stdout)
            .trim()
            .to_string();

        let revision = LoreRevision {
            hash: revision_hash,
            repo_id: repo.id,
            message: message.to_string(),
            author_id,
            timestamp: chrono::Utc::now(),
            file_count: 0,
        };

        info!(?revision, "Committed staged changes in Lore repo");
        Ok(revision)
    }

    // -- File operations --

    /// Delete a file from the channel's Lore repo.
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

        let output = Command::new(&self.config.lore_binary_path)
            .arg("file")
            .arg("delete")
            .arg("--repo")
            .arg(&repo.repo_name)
            .arg("--server")
            .arg(&self.config.lore_server_url)
            .arg(repo_path)
            .arg("-m")
            .arg(message)
            .output()
            .await?;

        if !output.status.success() {
            anyhow::bail!(
                "Lore file delete failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        info!(repo_path, channel_id, "Deleted file from Lore repo");
        Ok(())
    }

    // -- File locking --

    /// Acquire a lock on a file in the channel's Lore repo.
    pub async fn lock_file(
        &self,
        channel_id: i64,
        repo_path: &str,
        owner_id: i64,
    ) -> anyhow::Result<()> {
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;

        let output = Command::new(&self.config.lore_binary_path)
            .arg("lock")
            .arg("acquire")
            .arg("--repo")
            .arg(&repo.repo_name)
            .arg("--server")
            .arg(&self.config.lore_server_url)
            .arg(repo_path)
            .arg("--owner")
            .arg(owner_id.to_string())
            .output()
            .await?;

        if !output.status.success() {
            anyhow::bail!(
                "Lore lock acquire failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        info!(repo_path, channel_id, owner_id, "Acquired file lock");
        Ok(())
    }

    /// Release a lock on a file in the channel's Lore repo.
    pub async fn unlock_file(
        &self,
        channel_id: i64,
        repo_path: &str,
    ) -> anyhow::Result<()> {
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;

        let output = Command::new(&self.config.lore_binary_path)
            .arg("lock")
            .arg("release")
            .arg("--repo")
            .arg(&repo.repo_name)
            .arg("--server")
            .arg(&self.config.lore_server_url)
            .arg(repo_path)
            .output()
            .await?;

        if !output.status.success() {
            anyhow::bail!(
                "Lore lock release failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        info!(repo_path, channel_id, "Released file lock");
        Ok(())
    }

    // -- Diff --

    /// Diff a file between two revisions.
    pub async fn file_diff(
        &self,
        channel_id: i64,
        repo_path: &str,
        from_revision: &str,
        to_revision: &str,
    ) -> anyhow::Result<String> {
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;

        let output = Command::new(&self.config.lore_binary_path)
            .arg("file")
            .arg("diff")
            .arg("--repo")
            .arg(&repo.repo_name)
            .arg("--server")
            .arg(&self.config.lore_server_url)
            .arg("--from")
            .arg(from_revision)
            .arg("--to")
            .arg(to_revision)
            .arg(repo_path)
            .output()
            .await?;

        if !output.status.success() {
            anyhow::bail!(
                "Lore file diff failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }

    // -- Branch merge --

    /// Merge a branch into the current branch.
    pub async fn merge_branch(
        &self,
        channel_id: i64,
        branch_name: &str,
    ) -> anyhow::Result<()> {
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;

        let output = Command::new(&self.config.lore_binary_path)
            .arg("branch")
            .arg("merge")
            .arg("--repo")
            .arg(&repo.repo_name)
            .arg("--server")
            .arg(&self.config.lore_server_url)
            .arg(branch_name)
            .output()
            .await?;

        if !output.status.success() {
            anyhow::bail!(
                "Lore branch merge failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        info!(branch_name, channel_id, "Merged branch in Lore repo");
        Ok(())
    }

    /// Get file-level history from the Lore repo.
    pub async fn file_level_history(
        &self,
        channel_id: i64,
        repo_path: &str,
    ) -> anyhow::Result<Vec<LoreRevision>> {
        let repo = self
            .get_repo(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No Lore repo for channel {channel_id}"))?;

        let output = Command::new(&self.config.lore_binary_path)
            .arg("file")
            .arg("history")
            .arg("--repo")
            .arg(&repo.repo_name)
            .arg("--server")
            .arg(&self.config.lore_server_url)
            .arg(repo_path)
            .output()
            .await?;

        if !output.status.success() {
            anyhow::bail!(
                "Lore file history failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let revisions: Vec<LoreRevision> = serde_json::from_str(&stdout)?;
        Ok(revisions)
    }

    // -- Health --

    /// Check whether the Lore CLI and server are reachable.
    pub async fn health_check(&self) -> anyhow::Result<()> {
        let output = Command::new(&self.config.lore_binary_path)
            .arg("--version")
            .output()
            .await
            .map_err(|e| anyhow::anyhow!("Lore CLI not found: {e}"))?;

        if !output.status.success() {
            anyhow::bail!("Lore CLI returned non-zero status");
        }

        let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
        info!("Lore CLI version: {version}");

        // TODO: ping loreserver health endpoint when Lore exposes one
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_lore_repo_id() {
        let id = LoreRepoId::new();
        let json = serde_json::to_string(&id).unwrap();
        let deserialized: LoreRepoId = serde_json::from_str(&json).unwrap();
        assert_eq!(id, deserialized);
    }

    #[test]
    fn test_lore_config_default() {
        let config = LoreConfig::default();
        assert!(!config.enabled);
        assert_eq!(config.mode, LoreMode::Sidecar);
    }

    #[test]
    fn test_lore_repo_roundtrip() {
        let repo = LoreRepo {
            id: LoreRepoId::new(),
            channel_id: 42,
            lore_server_url: "lore://localhost:10000".into(),
            repo_name: "test-repo".into(),
            created_by: 1,
            created_at: chrono::Utc::now(),
        };
        let json = serde_json::to_string_pretty(&repo).unwrap();
        let deserialized: LoreRepo = serde_json::from_str(&json).unwrap();
        assert_eq!(repo.channel_id, deserialized.channel_id);
        assert_eq!(repo.repo_name, deserialized.repo_name);
    }

    #[test]
    fn test_lore_revision_roundtrip() {
        let rev = LoreRevision {
            hash: "abc123".into(),
            repo_id: LoreRepoId::new(),
            message: "initial commit".into(),
            author_id: 1,
            timestamp: chrono::Utc::now(),
            file_count: 3,
        };
        let json = serde_json::to_string(&rev).unwrap();
        let deserialized: LoreRevision = serde_json::from_str(&json).unwrap();
        assert_eq!(rev.hash, deserialized.hash);
        assert_eq!(rev.file_count, deserialized.file_count);
    }
}
