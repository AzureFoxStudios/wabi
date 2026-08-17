//! P5: Script Runner — collaborative script execution.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use tokio::process::Command;
use tokio::sync::RwLock;
use tracing::{info, warn};

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
    /// OS pid of the running interpreter — `cancel_script` kills this.
    #[serde(default)]
    pub pid: Option<u32>,
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

    /// Glob-style allowlist check: `**` spans path separators, `*` matches
    /// within one segment. An empty allowlist rejects everything.
    pub(crate) fn path_allowed(&self, script_path: &str) -> bool {
        self.config.allowed_scripts.iter().any(|pattern| {
            glob_match(pattern, script_path)
        })
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
        if !self.path_allowed(&script_path) {
            return Err(anyhow::anyhow!(
                "script '{}' is not in the allowed_scripts allowlist",
                script_path
            ));
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

        // Resolve the interpreter and spawn the process ourselves (instead of
        // `.output()`) so cancel and timeout can actually kill it.
        let ext = script_path.rsplit('.').next().unwrap_or("");
        let interpreter = match ext {
            "py" => "python3",
            "sh" | "bash" => "bash",
            "js" | "mjs" => "node",
            other => {
                let mut counts = self.user_session_counts.write().await;
                if let Some(count) = counts.get_mut(&user_id) {
                    *count = count.saturating_sub(1);
                }
                return Err(anyhow::anyhow!("Unsupported script type: {}", other));
            }
        };

        let child = {
            let spawn = Command::new(interpreter)
                .arg(&script_path)
                .args(&arguments)
                .current_dir(&working_dir)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn();
            match spawn {
                Ok(c) => c,
                Err(e) => {
                    let mut counts = self.user_session_counts.write().await;
                    if let Some(count) = counts.get_mut(&user_id) {
                        *count = count.saturating_sub(1);
                    }
                    return Err(anyhow::anyhow!("failed to start '{interpreter}': {e}"));
                }
            }
        };
        let pid = child.id().unwrap_or(0);
        if pid == 0 {
            warn!(%script_id, "could not determine script pid; cancel will not be able to kill it");
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
                pid: (pid != 0).then_some(pid),
            });
        }

        info!(%script_id, channel_id, user_id, script_path = %script_path, pid, "Running script");

        let script_id_for_run = script_id.clone();
        let sp = script_path.clone();
        let args = arguments.clone();

        let result = match tokio::time::timeout(timeout, child.wait_with_output()).await {
            Ok(Ok(output)) => {
                let stdout_str = String::from_utf8_lossy(&output.stdout)
                    .chars().take(max_bytes).collect();
                let stderr_str = String::from_utf8_lossy(&output.stderr)
                    .chars().take(max_bytes).collect();
                ScriptResult {
                    script_id: script_id_for_run, channel_id, user_id,
                    script_path: sp, arguments: args, exit_code: output.status.code(),
                    stdout: stdout_str, stderr: stderr_str,
                    started_at, completed_at: Some(Self::now_ms()),
                    duration_ms: Self::now_ms().saturating_sub(started_at),
                }
            }
            Ok(Err(e)) => {
                ScriptResult {
                    script_id: script_id_for_run, channel_id, user_id,
                    script_path: sp, arguments: args, exit_code: None,
                    stdout: String::new(), stderr: e.to_string(),
                    started_at, completed_at: Some(Self::now_ms()),
                    duration_ms: Self::now_ms().saturating_sub(started_at),
                }
            }
            Err(_) => {
                // Timeout: the child is still running — kill it before
                // reporting, instead of leaking the process.
                if pid != 0 {
                    kill_pid(pid).await;
                }
                ScriptResult {
                    script_id: script_id_for_run, channel_id, user_id,
                    script_path: sp, arguments: args, exit_code: None,
                    stdout: String::new(),
                    stderr: format!("Script timed out after {} seconds", timeout.as_secs()),
                    started_at, completed_at: Some(Self::now_ms()),
                    duration_ms: Self::now_ms().saturating_sub(started_at),
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
        if let Some(session) = sessions.remove(script_id) {
            if let Some(pid) = session.pid {
                kill_pid(pid).await;
            }
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

/// SIGTERM a pid via /bin/kill (best-effort; logged on failure).
async fn kill_pid(pid: u32) {
    let out = Command::new("kill")
        .arg(pid.to_string())
        .output()
        .await;
    match out {
        Ok(o) if o.status.success() => {}
        other => warn!(pid, "kill failed: {:?}", other.err()),
    }
}

/// Tiny glob matcher for the script allowlist: `**` spans `/`, `*` matches
/// within a segment, everything else matches literally.
pub(crate) fn glob_match(pattern: &str, path: &str) -> bool {
    fn match_inner(p: &[u8], s: &[u8]) -> bool {
        match (p.first(), s.first()) {
            (None, None) => true,
            (None, Some(_)) => false,
            (Some(b'*'), _) => {
                if p.starts_with(b"**") {
                    // `**` matches zero or more path chars (incl. '/')
                    let rest = &p[2..];
                    // optional leading '/' consumed by `**`
                    for i in 0..=s.len() {
                        if match_inner(rest, &s[i..]) {
                            return true;
                        }
                    }
                    if !rest.is_empty() && rest[0] == b'/' {
                        let rest2 = &rest[1..];
                        for i in 0..=s.len() {
                            if match_inner(rest2, &s[i..]) {
                                return true;
                            }
                        }
                    }
                    false
                } else {
                    // `*` matches zero or more chars within a segment
                    let rest = &p[1..];
                    if rest.is_empty() {
                        return !s.contains(&b'/');
                    }
                    for i in 0..=s.len() {
                        if s.get(i) == Some(&b'/') {
                            break;
                        }
                        if match_inner(rest, &s[i..]) {
                            return true;
                        }
                    }
                    false
                }
            }
            (Some(&c), Some(&d)) => c == d && match_inner(&p[1..], &s[1..]),
            (Some(_), None) => false,
        }
    }
    match_inner(pattern.as_bytes(), path.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_glob_match() {
        assert!(glob_match("scripts/**", "scripts/build.sh"));
        assert!(glob_match("scripts/**", "scripts/sub/run.py"));
        assert!(glob_match("scripts/*.sh", "scripts/build.sh"));
        assert!(!glob_match("scripts/*.sh", "scripts/sub/build.sh"));
        assert!(!glob_match("scripts/**", "evil.py"));
        assert!(!glob_match("scripts/**", "other/scripts/evil.py"));
    }

    #[tokio::test]
    async fn test_allowlist_is_enforced() {
        let config = ScriptRunnerConfig {
            enabled: true,
            max_concurrent_scripts: 1,
            ..Default::default()
        };
        let runner = ScriptRunner::new(config);

        // Outside the allowlist → rejected before anything is spawned.
        let err = runner
            .run_script(1, 1, "test.py".into(), vec![], "/tmp".into())
            .await
            .unwrap_err();
        assert!(err.to_string().contains("allowlist"));

        // Disabled runner → rejected even for allowed paths.
        let disabled = ScriptRunner::new(ScriptRunnerConfig::default());
        let err = disabled
            .run_script(1, 1, "scripts/ok.sh".into(), vec![], "/tmp".into())
            .await
            .unwrap_err();
        assert!(err.to_string().contains("not enabled"));
    }
}