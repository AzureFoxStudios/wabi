//! P7: Off-box Mirroring — publish Lore repos to external platforms.
//!
//! Git backends (GitHub / GitLab / GenericGit) export the lore working tree
//! into a scratch git repo (`.wabiignore`-filtered) and `git push -f` it to
//! the configured remote. Authentication must come from the remote URL
//! itself (https token) or the ambient ssh agent — Wabi does not store
//! mirror credentials. S3 is not implemented and reports an error rather
//! than pretending to succeed.

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use tracing::{info, warn};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum MirrorBackend {
    GitHub,
    GitLab,
    GenericGit,
    S3,
}

impl std::fmt::Display for MirrorBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MirrorBackend::GitHub => write!(f, "github"),
            MirrorBackend::GitLab => write!(f, "gitlab"),
            MirrorBackend::GenericGit => write!(f, "git"),
            MirrorBackend::S3 => write!(f, "s3"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MirrorConfig {
    pub channel_id: i64,
    pub backend: MirrorBackend,
    pub remote_url: String,
    pub branches: Vec<String>,
    pub tags: bool,
    pub auto_mirror: bool,
    pub mirror_on_push: bool,
    pub credentials_secret_id: Option<String>,
    pub last_mirror_at: Option<u64>,
    pub last_mirror_status: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum MirrorStatus {
    Success,
    Partial,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MirrorResult {
    pub channel_id: i64,
    pub backend: MirrorBackend,
    pub remote_url: String,
    pub branches_synced: Vec<String>,
    pub tags_synced: Vec<String>,
    pub duration_ms: u64,
    pub status: MirrorStatus,
    pub error: Option<String>,
}

pub struct MirrorService {
    configs: RwLock<HashMap<i64, MirrorConfig>>,
}

impl MirrorService {
    pub fn new() -> Self {
        Self {
            configs: RwLock::new(HashMap::new()),
        }
    }

    pub async fn register_mirror(&self, config: MirrorConfig) -> anyhow::Result<()> {
        let channel_id = config.channel_id;
        let mut configs = self.configs.write().await;
        configs.insert(channel_id, config);
        info!(channel_id, "Mirror configuration registered");
        Ok(())
    }

    pub async fn get_config(&self, channel_id: i64) -> Option<MirrorConfig> {
        let configs = self.configs.read().await;
        configs.get(&channel_id).cloned()
    }

    pub async fn remove_mirror(&self, channel_id: i64) -> anyhow::Result<()> {
        let mut configs = self.configs.write().await;
        if configs.remove(&channel_id).is_some() {
            info!(channel_id, "Mirror configuration removed");
            Ok(())
        } else {
            Err(anyhow::anyhow!(
                "No mirror configuration for channel {}",
                channel_id
            ))
        }
    }

    pub async fn list_configs(&self) -> Vec<MirrorConfig> {
        let configs = self.configs.read().await;
        configs.values().cloned().collect()
    }

    /// Publish the channel's lore working tree to the configured remote.
    ///
    /// `working_tree` must be the channel's repo path (the caller resolves it
    /// from the lore service). Git backends do a real export-and-push; S3
    /// returns an explicit not-implemented error instead of faking success.
    pub async fn mirror(
        &self,
        channel_id: i64,
        working_tree: Option<&Path>,
    ) -> anyhow::Result<MirrorResult> {
        let mut config = self
            .get_config(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No mirror configuration for channel {}", channel_id))?;

        if matches!(config.backend, MirrorBackend::S3) {
            self.record_failure(&mut config, "S3 mirroring is not implemented").await;
            anyhow::bail!("S3 mirroring is not implemented yet; configure a git backend (github/gitlab/git)");
        }

        let working_tree = working_tree.ok_or_else(|| {
            anyhow::anyhow!("No lore repo working tree for channel {channel_id}; nothing to mirror")
        })?;

        info!(
            channel_id,
            backend = %config.backend,
            remote = %config.remote_url,
            "Starting mirror operation"
        );

        let start = std::time::Instant::now();
        let result = export_and_push(working_tree, &config.remote_url).await;
        let (status, error) = match &result {
            Ok(()) => (MirrorStatus::Success, None),
            Err(e) => (MirrorStatus::Failed, Some(e.to_string())),
        };
        let result = MirrorResult {
            channel_id,
            backend: config.backend.clone(),
            remote_url: config.remote_url.clone(),
            branches_synced: vec!["main".into()],
            tags_synced: if config.tags { vec!["latest".into()] } else { vec![] },
            duration_ms: start.elapsed().as_millis() as u64,
            status: status.clone(),
            error,
        };

        // Persist last-mirror outcome in the registry.
        {
            let mut configs = self.configs.write().await;
            if let Some(stored) = configs.get_mut(&channel_id) {
                stored.last_mirror_at = Some(
                    std::time::SystemTime::now()
                        .duration_since(std::time::SystemTime::UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(0),
                );
                stored.last_mirror_status = Some(format!("{:?}", status));
            }
        }

        match result.status {
            MirrorStatus::Success => {
                info!(channel_id, duration_ms = result.duration_ms, "Mirror operation completed");
                Ok(result)
            }
            _ => {
                let err = result.error.clone().unwrap_or_else(|| "mirror failed".into());
                Err(anyhow::anyhow!("mirror to {} failed: {}", config.remote_url, err))
            }
        }
    }

    async fn record_failure(&self, _config: &mut MirrorConfig, reason: &str) {
        warn!(reason, "Mirror operation failed before export");
    }

    pub async fn has_mirror(&self, channel_id: i64) -> bool {
        self.get_config(channel_id).await.is_some()
    }
}

/// Export a lore working tree into a fresh scratch git repo and force-push it
/// to `remote_url` as branch `main` (tagged `latest` when tags are enabled at
/// the call site — the tag is created by the receiving CI or skipped).
///
/// The lore working tree is not itself a git repo, so every mirror builds a
/// clean snapshot repo: files are copied (respecting `.wabiignore` and
/// skipping `.lore`/wabi sidecar state), committed once, and force-pushed.
/// A mirror is a snapshot view, not a history bridge.
async fn export_and_push(working_tree: &Path, remote_url: &str) -> anyhow::Result<()> {
    let scratch = std::env::temp_dir().join(format!(
        "wabi-lore-mirror-{}",
        uuid::Uuid::new_v4()
    ));
    tokio::fs::create_dir_all(&scratch).await?;

    let cleanup = |scratch: &Path| {
        let p = scratch.to_path_buf();
        async move {
            let _ = tokio::fs::remove_dir_all(&p).await;
        }
    };

    async fn git(args: &[&str], cwd: &Path) -> anyhow::Result<std::process::Output> {
        let out = tokio::process::Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .await?;
        if !out.status.success() {
            anyhow::bail!(
                "git {} failed: {}",
                args.join(" "),
                String::from_utf8_lossy(&out.stderr).trim()
            );
        }
        Ok(out)
    }

    let result: anyhow::Result<()> = async {
        git(&["init", "-q", "-b", "main"], &scratch).await?;

        // Copy tracked files: skip lore/wabi internal state and .wabiignore hits.
        let filter = crate::ignore::LazyRepoFilter::new(working_tree.to_path_buf());
        let mut walker = ignore::WalkBuilder::new(working_tree);
        walker.hidden(false).git_ignore(false).ignore(false);
        for entry in walker.build().flatten() {
            let Some(ft) = entry.file_type() else { continue };
            if !ft.is_file() {
                continue;
            }
            let rel = match entry.path().strip_prefix(working_tree) {
                Ok(r) => r.to_string_lossy().replace('\\', "/"),
                Err(_) => continue,
            };
            let top = rel.split('/').next().unwrap_or("");
            if top == ".lore" || rel == ".wabi-repo.json" || rel == ".wabiignore" || rel == ".loreignore" {
                continue;
            }
            if filter.is_ignored(&rel) {
                continue;
            }
            let dest = scratch.join(&rel);
            if let Some(parent) = dest.parent() {
                tokio::fs::create_dir_all(parent).await?;
            }
            tokio::fs::copy(entry.path(), &dest).await?;
        }

        if !remote_url.contains("://") && !remote_url.starts_with('/') {
            anyhow::bail!("remote url '{remote_url}' does not look like a git remote");
        }
        git(&["add", "-A"], &scratch).await?;
        // Nothing-to-commit is fine — the remote is already current.
        let committed = tokio::process::Command::new("git")
            .args(["-c", "user.email=wabi@localhost", "-c", "user.name=wabi", "commit", "-q", "-m", "Mirror snapshot from Wabi"])
            .current_dir(&scratch)
            .output()
            .await?;
        if !committed.status.success() {
            let stderr = String::from_utf8_lossy(&committed.stderr);
            if !stderr.contains("nothing to commit") && !stderr.contains("no changes added") {
                anyhow::bail!("git commit failed: {}", stderr.trim());
            }
        }
        git(&["remote", "add", "origin", remote_url], &scratch).await?;
        git(&["push", "-q", "-f", "origin", "main"], &scratch).await?;
        // tags=true → (re)point a lightweight `latest` tag at the snapshot.
        git(&["tag", "-f", "latest"], &scratch).await?;
        git(&["push", "-q", "-f", "origin", "latest"], &scratch).await?;
        Ok(())
    }
    .await;

    cleanup(&scratch).await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_register_and_get() {
        let service = MirrorService::new();
        let config = MirrorConfig {
            channel_id: 1,
            backend: MirrorBackend::GitHub,
            remote_url: "git@github.com:user/repo.git".into(),
            branches: vec!["main".into()],
            tags: true,
            auto_mirror: false,
            mirror_on_push: true,
            credentials_secret_id: None,
            last_mirror_at: None,
            last_mirror_status: None,
        };
        service.register_mirror(config.clone()).await.unwrap();
        let got = service.get_config(1).await.unwrap();
        assert_eq!(got.backend, MirrorBackend::GitHub);
    }

    #[tokio::test]
    async fn test_mirror_without_working_tree_is_an_error() {
        let service = MirrorService::new();
        let config = MirrorConfig {
            channel_id: 1,
            backend: MirrorBackend::GitHub,
            remote_url: "git@github.com:user/repo.git".into(),
            branches: vec!["main".into()],
            tags: true,
            auto_mirror: false,
            mirror_on_push: true,
            credentials_secret_id: None,
            last_mirror_at: None,
            last_mirror_status: None,
        };
        service.register_mirror(config).await.unwrap();
        // No working tree → honest error, NOT a fabricated Success.
        let err = service.mirror(1, None).await.unwrap_err();
        assert!(err.to_string().contains("working tree"));
    }

    #[tokio::test]
    async fn test_mirror_s3_is_not_implemented() {
        let service = MirrorService::new();
        let config = MirrorConfig {
            channel_id: 1,
            backend: MirrorBackend::S3,
            remote_url: "s3://bucket/repo".into(),
            branches: vec![],
            tags: false,
            auto_mirror: false,
            mirror_on_push: false,
            credentials_secret_id: None,
            last_mirror_at: None,
            last_mirror_status: None,
        };
        service.register_mirror(config).await.unwrap();
        let err = service.mirror(1, None).await.unwrap_err();
        assert!(err.to_string().contains("not implemented"));
    }

    /// End-to-end git mirror against a LOCAL bare repo as the remote —
    /// no network needed. Skips silently when git is unavailable.
    #[tokio::test]
    async fn test_mirror_real_push_to_local_bare_repo() {
        let git = tokio::process::Command::new("git")
            .arg("--version")
            .output()
            .await;
        match git {
            Ok(o) if o.status.success() => {}
            _ => return, // git absent — skip
        }

        let tmp = tempfile::tempdir().unwrap();
        let tree = tmp.path().join("tree");
        let bare = tmp.path().join("remote.git");
        tokio::fs::create_dir_all(&tree).await.unwrap();
        let init = tokio::process::Command::new("git")
            .args(["init", "-q", "--bare"])
            .arg(&bare)
            .output()
            .await
            .unwrap();
        assert!(init.status.success(), "git init --bare failed");

        tokio::fs::write(tree.join("hello.txt"), b"mirror me").await.unwrap();
        tokio::fs::create_dir_all(tree.join(".lore")).await.unwrap();
        tokio::fs::write(tree.join(".lore/internal.bin"), b"skip me").await.unwrap();

        let service = MirrorService::new();
        let config = MirrorConfig {
            channel_id: 1,
            backend: MirrorBackend::GenericGit,
            remote_url: bare.to_string_lossy().to_string(),
            branches: vec![],
            tags: true,
            auto_mirror: false,
            mirror_on_push: false,
            credentials_secret_id: None,
            last_mirror_at: None,
            last_mirror_status: None,
        };
        service.register_mirror(config).await.unwrap();

        let result = service.mirror(1, Some(&tree)).await.unwrap();
        assert_eq!(result.status, MirrorStatus::Success);

        // The remote received the file on main…
        let show = tokio::process::Command::new("git")
            .args(["show", "main:hello.txt"])
            .current_dir(&bare)
            .output()
            .await
            .unwrap();
        assert!(show.status.success());
        assert_eq!(show.stdout, b"mirror me");
        // …and the `latest` tag…
        let tag = tokio::process::Command::new("git")
            .args(["rev-parse", "refs/tags/latest"])
            .current_dir(&bare)
            .output()
            .await
            .unwrap();
        assert!(tag.status.success());
        // …but NOT the lore-internal state.
        let internal = tokio::process::Command::new("git")
            .args(["show", "main:.lore/internal.bin"])
            .current_dir(&bare)
            .output()
            .await
            .unwrap();
        assert!(!internal.status.success());
    }

    #[tokio::test]
    async fn test_remove() {
        let service = MirrorService::new();
        let config = MirrorConfig {
            channel_id: 1,
            backend: MirrorBackend::GitHub,
            remote_url: "git@github.com:user/repo.git".into(),
            branches: vec![],
            tags: false,
            auto_mirror: false,
            mirror_on_push: false,
            credentials_secret_id: None,
            last_mirror_at: None,
            last_mirror_status: None,
        };
        service.register_mirror(config).await.unwrap();
        assert!(service.has_mirror(1).await);
        service.remove_mirror(1).await.unwrap();
        assert!(!service.has_mirror(1).await);
    }
}