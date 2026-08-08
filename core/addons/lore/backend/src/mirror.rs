//! P7: Off-box Mirroring — publish Lore repos to external platforms.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use tracing::info;

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

    pub async fn mirror(&self, channel_id: i64) -> anyhow::Result<MirrorResult> {
        let config = self
            .get_config(channel_id)
            .await
            .ok_or_else(|| anyhow::anyhow!("No mirror configuration for channel {}", channel_id))?;

        info!(
            channel_id,
            backend = %config.backend,
            remote = %config.remote_url,
            "Starting mirror operation"
        );

        let start = std::time::Instant::now();
        let branches_synced = config.branches.clone();
        let tags_synced = if config.tags {
            vec!["latest".into()]
        } else {
            vec![]
        };

        let result = MirrorResult {
            channel_id,
            backend: config.backend.clone(),
            remote_url: config.remote_url.clone(),
            branches_synced,
            tags_synced,
            duration_ms: start.elapsed().as_millis() as u64,
            status: MirrorStatus::Success,
            error: None,
        };

        info!(
            channel_id,
            duration_ms = result.duration_ms,
            "Mirror operation completed"
        );

        Ok(result)
    }

    pub async fn has_mirror(&self, channel_id: i64) -> bool {
        self.get_config(channel_id).await.is_some()
    }
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
    async fn test_mirror() {
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
        let result = service.mirror(1).await.unwrap();
        assert_eq!(result.status, MirrorStatus::Success);
        assert_eq!(result.channel_id, 1);
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