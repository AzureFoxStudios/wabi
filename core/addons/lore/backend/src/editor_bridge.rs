//! P4: Editor Bridge — ephemeral code-server sessions.
//!
//! When enabled, sessions are REAL `docker run` containers of code-server
//! mounting the channel's lore working tree at `/home/coder/project`. The
//! bridge refuses (not fabricates) when disabled or when docker is absent.
//! For editor-integrated workflows prefer `wabi-sync`, which needs no
//! server-side containers at all.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
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
    #[serde(default)]
    pub container_name: String,
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

    pub fn enabled(&self) -> bool {
        self.config.enabled
    }

    /// Bind 127.0.0.1:0 to let the OS pick a free port for the container.
    async fn pick_free_port() -> anyhow::Result<u16> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        Ok(listener.local_addr()?.port())
    }

    async fn docker_rm(container: &str) {
        let out = tokio::process::Command::new("docker")
            .args(["rm", "-f", container])
            .output()
            .await;
        if !matches!(&out, Ok(o) if o.status.success()) {
            warn!(container, "docker rm failed: {:?}", out.err());
        }
    }

    pub async fn start_session(
        &self,
        channel_id: i64,
        user_id: i64,
        working_tree: &Path,
        repo_path: Option<String>,
    ) -> anyhow::Result<EditorSession> {
        if !self.config.enabled {
            return Err(anyhow::anyhow!(
                "Editor bridge is not enabled; use wabi-sync to connect your own editor instead"
            ));
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
        let container_name = format!("wabi-editor-{}", &session_id[..8]);
        let port = Self::pick_free_port().await?;

        // Real container: code-server serving the mounted working tree.
        // --auth none is acceptable because the port binds to 127.0.0.1 only.
        let run = tokio::process::Command::new("docker")
            .args([
                "run", "-d", "--rm", "--name", &container_name,
                "-p", &format!("127.0.0.1:{port}:8080"),
                "-v", &format!("{}:/home/coder/project", working_tree.display()),
                "-e", "DEFAULT_WORKSPACE=/home/coder/project",
            ])
            .arg(&self.config.code_server_image)
            .args(["--auth", "none"])
            .output()
            .await
            .map_err(|e| anyhow::anyhow!("docker not available: {e}"))?;
        if !run.status.success() {
            anyhow::bail!(
                "docker run code-server failed: {}",
                String::from_utf8_lossy(&run.stderr).trim()
            );
        }

        let now = EditorSession::now_ms();
        let session = EditorSession {
            session_id: session_id.clone(),
            channel_id,
            user_id,
            url: format!("http://localhost:{port}/"),
            token,
            container_name: container_name.clone(),
            started_at: now,
            last_activity: now,
            repo_path,
        };

        info!(%session_id, channel_id, user_id, port, container = %container_name, "Started editor session");

        {
            let mut sessions = self.sessions.write().await;
            sessions.insert(session_id.clone(), session.clone());
        }

        // Cleanup task
        let sessions_clone = Arc::clone(&self.sessions);
        let sid = session_id.clone();
        let timeout_ms = self.config.idle_timeout_secs * 1000;
        tokio::spawn(async move {
            let mut container: Option<String> = None;
            loop {
                sleep(Duration::from_secs(60)).await;
                let should_stop = {
                    let s = sessions_clone.read().await;
                    match s.get(&sid) {
                        Some(sess) => {
                            container = Some(sess.container_name.clone());
                            sess.is_idle(timeout_ms)
                        }
                        None => true,
                    }
                };
                if should_stop {
                    break;
                }
            }
            let mut s = sessions_clone.write().await;
            if let Some(sess) = s.remove(&sid) {
                Self::docker_rm(&sess.container_name).await;
            } else if let Some(c) = container {
                Self::docker_rm(&c).await;
            }
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
        if let Some(session) = sessions.remove(session_id) {
            Self::docker_rm(&session.container_name).await;
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

    fn sample_session() -> EditorSession {
        let now = EditorSession::now_ms();
        EditorSession {
            session_id: "test".into(),
            channel_id: 1,
            user_id: 1,
            url: "http://localhost:8080/".into(),
            token: "token".into(),
            container_name: "wabi-editor-test".into(),
            started_at: now - 2000_000,
            last_activity: now - 2000_000,
            repo_path: None,
        }
    }

    #[test]
    fn test_session_idle_detection() {
        assert!(sample_session().is_idle(1800_000));
    }

    #[tokio::test]
    async fn test_bridge_disabled_refuses_honestly() {
        let config = EditorBridgeConfig {
            enabled: false,
            ..Default::default()
        };
        let bridge = EditorBridge::new(config);
        assert!(!bridge.enabled());
        let result = bridge.start_session(1, 1, Path::new("/tmp"), None).await;
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(msg.contains("not enabled"));
        assert!(msg.contains("wabi-sync"), "should point users at wabi-sync");
    }

    #[tokio::test]
    async fn test_pick_free_port_binds() {
        let port = EditorBridge::pick_free_port().await.unwrap();
        assert!(port > 0);
    }
}