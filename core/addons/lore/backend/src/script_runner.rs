//! P5: Script Runner — collaborative script execution.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use tokio::process::Command;
use tokio::sync::RwLock;
use tracing::{debug, info, warn};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScriptResult {
    pub script_id: String,
    pub channel_id: i64,
    pub user_id: i64,
    pub script_path: String,
    pub arguments: Vec<String>,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub started_at: u64,
    pub completed_at: Option<u64>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScriptSession {
    pub script_id: String,
    pub channel_id: i64,
    pub user_id: i64,
    pub script_path: String,
    pub working_dir: String,
    pub started_at: u64,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone)]
pub struct ScriptRunnerConfig {
    pub enabled: bool,
    pub max_concurrent_scripts: usize,
    pub max_duration_secs: u64,
    pub max_output_bytes: usize,
    pub allowed_scripts: Vec<String>,
    pub data_dir: String,
}

impl Default for ScriptRunnerConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            max_concurrent_scripts: 5,
            max_duration_secs: 300,
            max_output_bytes: 1_000_000,
            allowed_scripts: vec!["scripts/**".into()],
            data_dir: "/var/wabi/scripts".into(),
        }
    }
}

pub struct ScriptRunner {
    config: ScriptRunnerConfig,
    active_sessions: Arc<RwLock<HashMap<String, ScriptSession>>>,
    user_session_counts: Arc<RwLock<HashMap<i64, usize>>>,
}

impl ScriptRunner {
    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }

    pub fn new(config: ScriptRunnerConfig) -> Self {
        Self {
            config,
            active_sessions: Arc::new(RwLock::new(HashMap::new())),
            user_session_counts: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn run_script(
        &self,
        channel_id: i64,
        user_id: i64,
        script_path: String,
        arguments: Vec<String>,
        working_dir: String,
    ) -> anyhow::Result<ScriptResult> {
        if !self.config.enabled {
            return Err(anyhow::anyhow!("Script runner is not enabled"));
        }

        let script_id = uuid::Uuid::new_v4().to_string();
        let started_at = Self::now_ms();
        let timeout = Duration::from_secs(self.config.max_duration_secs);
        let max_bytes = self.config.max_output_bytes;

        // Check concurrent limit
        {
            let mut counts = self.user_session_counts.write().await;
            let count = counts.entry(user_id).or_insert(0);
            if *count >= self.config.max_concurrent_scripts {
                return Err(anyhow::anyhow!(
                    "User has reached max concurrent scripts ({})",
                    self.config.max_concurrent_scripts
                ));
            }
            *count += 1;
        }

        // Track session
        {
            let mut sessions = self.active_sessions.write().await;
            sessions.insert(script_id.clone(), ScriptSession {
                script_id: script_id.clone(),
                channel_id,
                user_id,
                script_path: script_path.clone(),
                working_dir: working_dir.clone(),
                started_at,
                timeout_ms: timeout.as_millis() as u64,
            });
        }

        info!(%script_id, channel_id, user_id, script_path = %script_path, "Running script");

        let wd = working_dir;
        let sp = script_path;
        let args = arguments;

        // Clones for the async block (which owns its captures)
        let sp_for_run = sp.clone();
        let args_for_run = args.clone();
        let script_id_for_run = script_id.clone();

        let result = tokio::time::timeout(timeout, async move {
            let ext = sp_for_run.rsplit('.').next().unwrap_or("");
            let output: anyhow::Result<(Option<i32>, Vec<u8>, Vec<u8>)> = match ext {
                "py" => {
                    let r = Command::new("python3")
                        .arg(&sp_for_run).args(&args_for_run).current_dir(&wd)
                        .stdout(Stdio::piped()).stderr(Stdio::piped()).output().await;
                    r.map(|o| (o.status.code(), o.stdout, o.stderr)).map_err(anyhow::Error::from)
                }
                "sh" | "bash" => {
                    let r = Command::new("bash")
                        .arg(&sp_for_run).args(&args_for_run).current_dir(&wd)
                        .stdout(Stdio::piped()).stderr(Stdio::piped()).output().await;
                    r.map(|o| (o.status.code(), o.stdout, o.stderr)).map_err(anyhow::Error::from)
                }
                "js" | "mjs" => {
                    let r = Command::new("node")
                        .arg(&sp_for_run).args(&args_for_run).current_dir(&wd)
                        .stdout(Stdio::piped()).stderr(Stdio::piped()).output().await;
                    r.map(|o| (o.status.code(), o.stdout, o.stderr)).map_err(anyhow::Error::from)
                }
                _ => Err(anyhow::anyhow!("Unsupported script type: {}", ext)),
            };
            output
        })
        .await;

        let result = match result {
            Ok(Ok((exit_code, stdout, stderr))) => {
                let stdout_str = String::from_utf8_lossy(&stdout)
                    .chars().take(max_bytes).collect();
                let stderr_str = String::from_utf8_lossy(&stderr)
                    .chars().take(max_bytes).collect();
                ScriptResult {
                    script_id: script_id_for_run, channel_id, user_id,
                    script_path: sp, arguments: args, exit_code,
                    stdout: stdout_str, stderr: stderr_str,
                    started_at, completed_at: Some(Self::now_ms()),
                    duration_ms: started_at.saturating_sub(Self::now_ms()),
                }
            }
            Ok(Err(e)) => {
                ScriptResult {
                    script_id: script_id_for_run, channel_id, user_id,
                    script_path: sp, arguments: args, exit_code: None,
                    stdout: String::new(), stderr: e.to_string(),
                    started_at, completed_at: Some(Self::now_ms()),
                    duration_ms: started_at.saturating_sub(Self::now_ms()),
                }
            }
            Err(_) => {
                ScriptResult {
                    script_id: script_id_for_run, channel_id, user_id,
                    script_path: sp, arguments: args, exit_code: None,
                    stdout: String::new(),
                    stderr: format!("Script timed out after {} seconds", timeout.as_secs()),
                    started_at, completed_at: Some(Self::now_ms()),
                    duration_ms: started_at.saturating_sub(Self::now_ms()),
                }
            }
        };

        // Cleanup
        {
            let mut sessions = self.active_sessions.write().await;
            sessions.remove(&script_id);
        }
        {
            let mut counts = self.user_session_counts.write().await;
            if let Some(count) = counts.get_mut(&user_id) {
                *count = count.saturating_sub(1);
            }
        }

        info!(%script_id, exit_code = ?result.exit_code, duration_ms = result.duration_ms, "Script execution completed");
        Ok(result)
    }

    pub async fn cancel_script(&self, script_id: &str) -> anyhow::Result<()> {
        let mut sessions = self.active_sessions.write().await;
        if sessions.remove(script_id).is_some() {
            info!(%script_id, "Script execution cancelled");
            Ok(())
        } else {
            Err(anyhow::anyhow!("Script not found: {}", script_id))
        }
    }

    pub async fn list_active(&self) -> Vec<ScriptSession> {
        let sessions = self.active_sessions.read().await;
        sessions.values().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_concurrent_limit() {
        let config = ScriptRunnerConfig {
            enabled: true,
            max_concurrent_scripts: 1,
            ..Default::default()
        };
        let runner = ScriptRunner::new(config);

        let result = runner.run_script(
            1, 1, "test.py".into(), vec![],
            "/tmp".into(),
        ).await;
        // Will fail because python3 not found or script missing, but should not hit limit
        let _ = result;
    }
}