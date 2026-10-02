//! P7: Off-box Mirroring — publish Lore repos to external platforms.
//!
//! Git backends (GitHub / GitLab / GenericGit) export the lore working tree
//! into a private scratch git repo (`.wabiignore`-filtered) and replace only
//! its explicit snapshot refs, guarded by the inspected remote revisions.
//! Destinations must pass the same public HTTPS policy as imports; ambient
//! credentials, Git configuration and transport helpers are not inherited. S3 is not implemented and reports an error rather
//! than pretending to succeed.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;

use crate::confined_fs::{InternalFile, RepoDir};

use serde::{Deserialize, Serialize};
use tokio::sync::{OwnedMutexGuard, RwLock};
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
        if !matches!(config.backend, MirrorBackend::S3) {
            crate::git_remote::validate_push_target(&config.remote_url)?;
        }
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
    /// Only the Lore service may supply a held repository capability and
    /// owned I/O gate. S3 returns an explicit unsupported error.
    pub(crate) async fn mirror(
        &self,
        channel_id: i64,
        source: Option<MirrorSource>,
    ) -> anyhow::Result<MirrorResult> {
        let mut config = self
            .get_config(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No mirror configuration for channel {}", channel_id))?;

        if matches!(config.backend, MirrorBackend::S3) {
            self.record_failure(&mut config, "S3 mirroring is not implemented")
                .await;
            anyhow::bail!(
                "S3 mirroring is not implemented yet; configure a git backend (github/gitlab/git)"
            );
        }

        let source = source.ok_or_else(|| {
            anyhow::anyhow!("No lore repo working tree for channel {channel_id}; nothing to mirror")
        })?;

        info!(
            channel_id,
            backend = %config.backend,
            remote = %config.remote_url,
            "Starting mirror operation"
        );

        let start = std::time::Instant::now();
        let result = export_and_push(source, &config.remote_url, config.tags).await;
        let (status, error) = match &result {
            Ok(()) => (MirrorStatus::Success, None),
            Err(e) => (MirrorStatus::Failed, Some(e.to_string())),
        };
        let result = MirrorResult {
            channel_id,
            backend: config.backend.clone(),
            remote_url: config.remote_url.clone(),
            branches_synced: vec!["main".into()],
            tags_synced: if config.tags {
                vec!["latest".into()]
            } else {
                vec![]
            },
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
                info!(
                    channel_id,
                    duration_ms = result.duration_ms,
                    "Mirror operation completed"
                );
                Ok(result)
            }
            _ => {
                let err = result
                    .error
                    .clone()
                    .unwrap_or_else(|| "mirror failed".into());
                Err(anyhow::anyhow!(
                    "mirror to {} failed: {}",
                    config.remote_url,
                    err
                ))
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

/// Source capability and admission lifetime; no ambient source path escapes.
pub(crate) struct MirrorSource {
    root: RepoDir,
    gate: OwnedMutexGuard<()>,
    #[cfg(test)]
    hook: Option<SnapshotHook>,
}

impl MirrorSource {
    pub(crate) fn new(root: RepoDir, gate: OwnedMutexGuard<()>) -> Self {
        Self {
            root,
            gate,
            #[cfg(test)]
            hook: None,
        }
    }
}

#[cfg(test)]
struct SnapshotHook {
    started: tokio::sync::oneshot::Sender<()>,
    resume: std::sync::mpsc::Receiver<()>,
}

struct CancelOnDrop(Arc<AtomicBool>);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

/// The blocking worker owns both admission and scratch cleanup. Cancelling
/// its caller cannot admit a branch replacement while source I/O continues.
async fn copy_snapshot(source: MirrorSource) -> anyhow::Result<tempfile::TempDir> {
    let cancelled = Arc::new(AtomicBool::new(false));
    let _cancel = CancelOnDrop(cancelled.clone());
    let worker = tokio::task::spawn_blocking(move || -> anyhow::Result<tempfile::TempDir> {
        let MirrorSource {
            root,
            gate,
            #[cfg(test)]
            hook,
        } = source;
        let _gate = gate;
        let scratch = tempfile::Builder::new()
            .prefix("wabi-lore-mirror-")
            .tempdir()?;
        let mut matcher = ignore::gitignore::GitignoreBuilder::new(Path::new(""));
        match root.open_internal(InternalFile::WabiIgnore) {
            Ok(file) => {
                let mut contents = String::new();
                file.take(1024 * 1024 + 1).read_to_string(&mut contents)?;
                if contents.len() > 1024 * 1024 {
                    anyhow::bail!("Mirror ignore file is too large");
                }
                for line in contents.lines() {
                    matcher.add_line(None, line)?;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                for pattern in crate::ignore::LazyRepoFilter::default_patterns() {
                    matcher.add_line(None, pattern)?;
                }
            }
            Err(error) => return Err(error.into()),
        }
        let matcher = matcher.build()?;
        let files = root.content_files()?;
        #[cfg(test)]
        if let Some(hook) = hook {
            let _ = hook.started.send(());
            hook.resume.recv()?;
        }
        let mut total_bytes = 0u64;
        for path in files {
            if cancelled.load(Ordering::Acquire) {
                anyhow::bail!("Mirror export cancelled");
            }
            if matcher
                .matched_path_or_any_parents(Path::new(&path), false)
                .is_ignore()
            {
                continue;
            }
            let mut source = root.open_file(&path)?;
            let destination = scratch
                .path()
                .join(crate::confined_fs::validate_path(&path)?);
            if let Some(parent) = destination.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut output = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(destination)?;
            let mut buffer = [0u8; 64 * 1024];
            loop {
                if cancelled.load(Ordering::Acquire) {
                    anyhow::bail!("Mirror export cancelled");
                }
                let count = source.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                total_bytes = total_bytes.saturating_add(count as u64);
                if total_bytes > 4 * 1024 * 1024 * 1024 {
                    anyhow::bail!("Mirror snapshot exceeds 4 GiB");
                }
                if cancelled.load(Ordering::Acquire) {
                    anyhow::bail!("Mirror export cancelled");
                }
                output.write_all(&buffer[..count])?;
            }
            output.flush()?;
        }
        Ok(scratch)
    });
    tokio::time::timeout(Duration::from_secs(60), worker)
        .await
        .map_err(|_| anyhow::anyhow!("Mirror export timed out"))?
        .map_err(|_| anyhow::anyhow!("Mirror export worker stopped"))?
}

async fn export_and_push(source: MirrorSource, remote_url: &str, tags: bool) -> anyhow::Result<()> {
    // Validate and pin before reading any repository content.
    let target = crate::git_remote::resolve_push_target(remote_url).await?;
    let scratch = copy_snapshot(source).await?;
    crate::git_remote::checked_local(
        &["init", "--quiet", "--template=", "-b", "main"],
        scratch.path(),
    )
    .await?;
    crate::git_remote::checked_local(&["add", "--all", "--force", "--", "."], scratch.path())
        .await?;
    crate::git_remote::checked_local(
        &[
            "-c",
            "user.email=wabi@localhost",
            "-c",
            "user.name=wabi",
            "commit",
            "--quiet",
            "--allow-empty",
            "-m",
            "Mirror snapshot from Wabi",
        ],
        scratch.path(),
    )
    .await?;
    crate::git_remote::push_snapshot(&target, scratch.path(), tags).await
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
            remote_url: "https://github.com/user/repo.git".into(),
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
            remote_url: "https://github.com/user/repo.git".into(),
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

        tokio::fs::write(tree.join("hello.txt"), b"mirror me")
            .await
            .unwrap();
        tokio::fs::create_dir_all(tree.join(".lore")).await.unwrap();
        tokio::fs::write(tree.join(".lore/internal.bin"), b"skip me")
            .await
            .unwrap();
        for furniture in [
            ".git/config",
            ".mirror-cache/canary",
            "nested/.git/config",
            ".wabi-repo.json",
        ] {
            let path = tree.join(furniture);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, b"private furniture canary").unwrap();
        }
        std::fs::write(tree.join(".wabiignore"), "*.log\n!keep.log\n").unwrap();
        std::fs::write(tree.join("skip.log"), b"ignored").unwrap();
        std::fs::write(tree.join("keep.log"), b"keep me").unwrap();

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

        let gate = Arc::new(tokio::sync::Mutex::new(())).lock_owned().await;
        let source = MirrorSource::new(RepoDir::open(&tree).unwrap(), gate);
        let result = service.mirror(1, Some(source)).await.unwrap();
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
        for hidden in [
            ".git/config",
            ".mirror-cache/canary",
            "nested/.git/config",
            ".wabi-repo.json",
            ".wabiignore",
            "skip.log",
        ] {
            let output = tokio::process::Command::new("git")
                .args(["show", &format!("main:{hidden}")])
                .current_dir(&bare)
                .output()
                .await
                .unwrap();
            assert!(
                !output.status.success(),
                "exported furniture or ignored file: {hidden}"
            );
        }
        let kept = tokio::process::Command::new("git")
            .args(["show", "main:keep.log"])
            .current_dir(&bare)
            .output()
            .await
            .unwrap();
        assert_eq!(kept.stdout, b"keep me");

        // A subsequent snapshot replaces main intentionally, without changing
        // the existing latest tag when tagging is disabled.
        let old_tag = tag.stdout;
        std::fs::write(tree.join("hello.txt"), b"new snapshot").unwrap();
        let mut config = service.get_config(1).await.unwrap();
        config.tags = false;
        service.register_mirror(config).await.unwrap();
        let gate = Arc::new(tokio::sync::Mutex::new(())).lock_owned().await;
        service
            .mirror(
                1,
                Some(MirrorSource::new(RepoDir::open(&tree).unwrap(), gate)),
            )
            .await
            .unwrap();
        let tag = tokio::process::Command::new("git")
            .args(["rev-parse", "refs/tags/latest"])
            .current_dir(&bare)
            .output()
            .await
            .unwrap();
        assert_eq!(tag.stdout, old_tag);
        let show = tokio::process::Command::new("git")
            .args(["show", "main:hello.txt"])
            .current_dir(&bare)
            .output()
            .await
            .unwrap();
        assert_eq!(show.stdout, b"new snapshot");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn source_replacement_with_symlink_cannot_export_outside_bytes() {
        let tree = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(tree.path().join("file.txt"), b"original").unwrap();
        std::fs::write(outside.path().join("canary"), b"outside private canary").unwrap();
        let gate = Arc::new(tokio::sync::Mutex::new(())).lock_owned().await;
        let (started, ready) = tokio::sync::oneshot::channel();
        let (resume, wait) = std::sync::mpsc::channel();
        let mut source = MirrorSource::new(RepoDir::open(tree.path()).unwrap(), gate);
        source.hook = Some(SnapshotHook {
            started,
            resume: wait,
        });
        let operation = tokio::spawn(copy_snapshot(source));
        ready.await.unwrap();
        std::fs::remove_file(tree.path().join("file.txt")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("canary"), tree.path().join("file.txt"))
            .unwrap();
        resume.send(()).unwrap();
        assert!(operation.await.unwrap().is_err());
    }

    #[tokio::test]
    async fn cancelled_snapshot_retains_source_gate_until_worker_stops() {
        let tree = tempfile::tempdir().unwrap();
        std::fs::write(tree.path().join("file.txt"), b"content").unwrap();
        let io_gate = Arc::new(tokio::sync::Mutex::new(()));
        let gate = io_gate.clone().lock_owned().await;
        let (started, ready) = tokio::sync::oneshot::channel();
        let (resume, wait) = std::sync::mpsc::channel();
        let mut source = MirrorSource::new(RepoDir::open(tree.path()).unwrap(), gate);
        source.hook = Some(SnapshotHook {
            started,
            resume: wait,
        });
        let operation = tokio::spawn(copy_snapshot(source));
        ready.await.unwrap();
        operation.abort();
        assert!(operation.await.unwrap_err().is_cancelled());
        assert!(io_gate.try_lock().is_err());
        resume.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(2), io_gate.lock())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn unsafe_mirror_destinations_are_rejected_before_registration() {
        let service = MirrorService::new();
        for remote in [
            "file:///tmp/repo",
            "ssh://host/repo",
            "ext::command",
            "git@host:repo",
            "https://user:secret@example.com/repo",
            "https://127.0.0.1/repo",
        ] {
            let config = MirrorConfig {
                channel_id: 1,
                backend: MirrorBackend::GenericGit,
                remote_url: remote.into(),
                branches: vec![],
                tags: false,
                auto_mirror: false,
                mirror_on_push: false,
                credentials_secret_id: None,
                last_mirror_at: None,
                last_mirror_status: None,
            };
            assert!(
                service.register_mirror(config).await.is_err(),
                "accepted {remote}"
            );
            assert!(service.get_config(1).await.is_none());
        }
    }

    #[tokio::test]
    async fn test_remove() {
        let service = MirrorService::new();
        let config = MirrorConfig {
            channel_id: 1,
            backend: MirrorBackend::GitHub,
            remote_url: "https://github.com/user/repo.git".into(),
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
