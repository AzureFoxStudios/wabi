//! P4: Editor Bridge — ephemeral code-server sessions.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use tokio::time::sleep;
use tracing::{debug, info, warn};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditorSession {
    pub session_id: String,
    pub channel_id: i64,
    pub user_id: i64,
    pub url: String,
    pub token: String,
    pub started_at: u64,
    pub last_activity: u64,
    pub repo_path: Option<String>,
}

impl EditorSession {
    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }

    pub fn is_idle(&self, timeout_ms: u64) -> bool {
        Self::now_ms().saturating_sub(self.last_activity) > timeout_ms
    }
}

#[derive(Debug, Clone)]
pub struct EditorBridgeConfig {
    pub enabled: bool,
    pub code_server_image: String,
    pub code_server_port: u16,
    pub idle_timeout_secs: u64,
    pub max_concurrent_sessions: usize,
    pub data_dir: PathBuf,
}

impl Default for EditorBridgeConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            code_server_image: "codercom/code-server:4.92".into(),
            code_server_port: 8080,
            idle_timeout_secs: 1800,
            max_concurrent_sessions: 10,
            data_dir: PathBuf::from("/var/wabi/editor-sessions"),
        }
    }
}

pub struct EditorBridge {
    config: EditorBridgeConfig,
    sessions: Arc<RwLock<HashMap<String, EditorSession>>>,
}

impl EditorBridge {
    pub fn new(config: EditorBridgeConfig) -> Self {
        Self {
            config,
            sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn start_session(
        &self,
        channel_id: i64,
        user_id: i64,
        repo_path: Option<String>,
    ) -> anyhow::Result<EditorSession> {
        if !self.config.enabled {
            return Err(anyhow::anyhow!("Editor bridge is not enabled"));
        }

        {
            let sessions = self.sessions.read().await;
            if sessions.len() >= self.config.max_concurrent_sessions {
                return Err(anyhow::anyhow!(
                    "Maximum concurrent editor sessions reached ({})",
                    self.config.max_concurrent_sessions
                ));
            }
        }

        let session_id = uuid::Uuid::new_v4().to_string();
        let token = uuid::Uuid::new_v4().to_string();
        let now = EditorSession::now_ms();

        let session = EditorSession {
            session_id: session_id.clone(),
            channel_id,
            user_id,
            url: format!(
                "http://localhost:{}/?token={}",
                self.config.code_server_port, token
            ),
            token: token.clone(),
            started_at: now,
            last_activity: now,
            repo_path,
        };

        info!(%session_id, channel_id, user_id, "Started editor session");

        {
            let mut sessions = self.sessions.write().await;
            sessions.insert(session_id.clone(), session.clone());
        }

        // Cleanup task
        let sessions_clone = Arc::clone(&self.sessions);
        let sid = session_id.clone();
        let timeout_ms = self.config.idle_timeout_secs * 1000;
        tokio::spawn(async move {
            loop {
                sleep(Duration::from_secs(60)).await;
                let should_stop = {
                    let s = sessions_clone.read().await;
                    if let Some(sess) = s.get(&sid) {
                        sess.is_idle(timeout_ms)
                    } else {
                        true
                    }
                };
                if should_stop {
                    break;
                }
            }
            let mut s = sessions_clone.write().await;
            s.remove(&sid);
            debug!(%sid, "Editor session expired and cleaned up");
        });

        Ok(session)
    }

    pub async fn get_session(&self, session_id: &str) -> Option<EditorSession> {
        let mut sessions = self.sessions.write().await;
        let session = sessions.get(session_id).cloned()?;
        if let Some(s) = sessions.get_mut(session_id) {
            s.last_activity = EditorSession::now_ms();
        }
        Some(session)
    }

    pub async fn stop_session(&self, session_id: &str) -> anyhow::Result<()> {
        let mut sessions = self.sessions.write().await;
        if sessions.remove(session_id).is_some() {
            info!(%session_id, "Editor session stopped");
            Ok(())
        } else {
            Err(anyhow::anyhow!("Session not found: {}", session_id))
        }
    }

    pub async fn list_sessions(&self) -> Vec<EditorSession> {
        let sessions = self.sessions.read().await;
        sessions.values().cloned().collect()
    }

    pub async fn cleanup_idle(&self) {
        let timeout_ms = self.config.idle_timeout_secs * 1000;
        let mut sessions = self.sessions.write().await;
        sessions.retain(|id, sess| {
            if sess.is_idle(timeout_ms) {
                warn!(%id, "Cleaning up idle editor session");
                false
            } else {
                true
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_session_idle_detection() {
        let now = EditorSession::now_ms();
        let session = EditorSession {
            session_id: "test".into(),
            channel_id: 1,
            user_id: 1,
            url: "http://localhost:8080".into(),
            token: "token".into(),
            started_at: now - 2000_000,
            last_activity: now - 2000_000,
            repo_path: None,
        };
        assert!(session.is_idle(1800_000));
    }

    #[tokio::test]
    async fn test_bridge_start_session() {
        let config = EditorBridgeConfig {
            enabled: true,
            ..Default::default()
        };
        let bridge = EditorBridge::new(config);
        let session = bridge.start_session(1, 1, None).await.unwrap();
        assert_eq!(session.channel_id, 1);
        assert!(session.url.contains("token="));
    }

    #[tokio::test]
    async fn test_bridge_disabled() {
        let config = EditorBridgeConfig {
            enabled: false,
            ..Default::default()
        };
        let bridge = EditorBridge::new(config);
        let result = bridge.start_session(1, 1, None).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("not enabled"));
    }
}