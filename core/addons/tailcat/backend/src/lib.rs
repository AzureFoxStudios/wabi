//! Wabi Tailcat addon — private-access transport for family/friend instances.
//!
//! Runs `tailcat serve <pipe_port>` as a subprocess (Lore external-binary
//! pattern) and a loopback tagging forwarder (see `forwarder.rs`). The pipe
//! is transport-only: Wabi auth always gates membership. Settings persist
//! under `<data_dir>/tailcat/` and apply hot — a config change bounces only
//! the listener subprocess, never wabi-server (design invariants in
//! docs/plans/2026-09-01-tailcat-private-access.md).
//!
//! Deliberate deviations from the mesh pattern (documented in the plan doc):
//! - runtime-gated, unconditionally compiled (like mesh) so one binary serves
//!   both postures;
//! - config is file+audit-log backed, NOT env vars — no restart ever required.

pub mod forwarder;
pub mod store;

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use rand::RngCore;
use serde::Serialize;
use tokio::process::{Child, Command};
use tokio::sync::{watch, Mutex, Notify, RwLock};
use tracing::{info, warn};

pub use store::{AuditEntry, MemberKeyRecord, PersistedSettings, TailcatStore};

/// Env override for the tailcat binary path (bootstrap only; everything else
/// is runtime config). Defaults to `tailcat` on PATH.
pub const BINARY_ENV: &str = "WABI_TAILCAT_BINARY";

/// Optional env pointing at a self-hosted DERP map JSON (passed to the
/// listener as `--derpmap-url`). Bootstrap-level infra config, like the
/// binary path. See docs/deployment/DERP_SELF_HOST_GUIDE.md.
pub const DERPMAP_ENV: &str = "WABI_TAILCAT_DERPMAP_URL";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusSnapshot {
    pub enabled: bool,
    pub running: bool,
    pub address: Option<String>,
    pub pipe_port: u16,
    pub server_port: u16,
    pub binary_path: String,
    pub binary_version: Option<String>,
    pub keys: Vec<MemberKeyRecord>,
    pub last_error: Option<String>,
    pub started_at: Option<String>,
}

#[derive(Debug, Default)]
struct Inner {
    /// Configured state (persisted). `running` tracks the subprocess.
    wanted: bool,
    running: bool,
    listener_generation: u64,
    address: Option<String>,
    last_error: Option<String>,
    started_at: Option<String>,
    binary_version: Option<String>,
    binary_version_checked: bool,
}

pub struct TailcatManager {
    server_port: u16,
    binary_path: PathBuf,
    store: TailcatStore,
    /// Startup-generated secret shared with the tagging forwarder. Never
    /// leaves the process; public clients cannot forge pipe identity.
    pipe_auth_token: String,
    inner: RwLock<Inner>,
    rebounce: Notify,
    tasks: tokio::sync::OnceCell<()>,
    shutdown_tx: std::sync::OnceLock<watch::Sender<bool>>,
    shutdown_done: Notify,
    changes: Mutex<()>,
    forwarder: Mutex<Option<(watch::Sender<bool>, tokio::task::JoinHandle<()>)>>,
}

impl TailcatManager {
    pub fn new(server_port: u16, data_dir: &Path) -> Arc<Self> {
        let binary_path = std::env::var(BINARY_ENV)
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("tailcat"));
        let mut token_bytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut token_bytes);
        Arc::new(Self {
            server_port,
            binary_path,
            store: TailcatStore::new(data_dir),
            pipe_auth_token: hex::encode(token_bytes),
            inner: RwLock::new(Inner::default()),
            rebounce: Notify::new(),
            tasks: tokio::sync::OnceCell::new(),
            shutdown_tx: std::sync::OnceLock::new(),
            shutdown_done: Notify::new(),
            changes: Mutex::new(()),
            forwarder: Mutex::new(None),
        })
    }

    /// Test-only: the in-process forwarder token (never exposed via HTTP).
    #[doc(hidden)]
    pub fn pipe_auth_token_for_tests(&self) -> &str {
        &self.pipe_auth_token
    }

    pub fn pipe_port(&self) -> u16 {
        self.store
            .load_settings()
            .pipe_port
            .unwrap_or(self.server_port.saturating_add(1).max(1))
    }

    /// Load persisted state and start tasks if the pipe should run. Called
    /// once from main; also implicitly via mutations in tests.
    pub async fn init(self: &Arc<Self>) {
        let settings = self.store.load_settings();
        self.inner.write().await.wanted = settings.enabled;
        if settings.enabled {
            info!("[tailcat] enabled in persisted settings; starting listener");
        }
        self.ensure_tasks().await;
        if settings.enabled {
            self.rebounce.notify_one();
        }
    }

    /// Process shutdown, not a persisted user setting change. Stop the monitor
    /// and its owned child without disabling private access on the next launch.
    pub async fn shutdown(&self) {
        self.stop_forwarder().await;
        if let Some(tx) = self.shutdown_tx.get() {
            let _ = tx.send(true);
            let _ = tokio::time::timeout(
                std::time::Duration::from_secs(3),
                self.shutdown_done.notified(),
            )
            .await;
        }
    }

    /// Spawn the forwarder + monitor exactly once.
    async fn ensure_tasks(self: &Arc<Self>) {
        self.tasks
            .get_or_init(|| async {
                let (tx, rx) = watch::channel(false);
                let _ = self.shutdown_tx.set(tx);
                if let Err(e) = self.replace_forwarder(None).await {
                    self.set_running(
                        false,
                        Some(format!("Private-access port could not be bound: {e}")),
                    )
                    .await;
                }
                tokio::spawn(Self::monitor_task(self.clone(), rx));
            })
            .await;
    }

    async fn stop_forwarder(&self) {
        if let Some((stop, mut task)) = self.forwarder.lock().await.take() {
            let _ = stop.send(true);
            if tokio::time::timeout(std::time::Duration::from_secs(2), &mut task)
                .await
                .is_err()
            {
                task.abort();
            }
        }
    }

    async fn replace_forwarder(
        &self,
        listener: Option<tokio::net::TcpListener>,
    ) -> anyhow::Result<()> {
        let listener = match listener {
            Some(listener) => listener,
            None => {
                tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, self.pipe_port()))
                    .await?
            }
        };
        self.stop_forwarder().await;
        let (stop, rx) = watch::channel(false);
        let target = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), self.server_port);
        let token = self.pipe_auth_token.clone();
        let task = tokio::spawn(async move {
            if let Err(e) = forwarder::run_listener(listener, target, token, rx).await {
                warn!("[tailcat] forwarder stopped: {e}");
            }
        });
        *self.forwarder.lock().await = Some((stop, task));
        Ok(())
    }

    /// Change only this instance's Wabi pipe. Other LAN services are never targets.
    pub async fn set_pipe_port(
        self: &Arc<Self>,
        port: u16,
        actor: i64,
    ) -> anyhow::Result<StatusSnapshot> {
        let _change = self.changes.lock().await;
        anyhow::ensure!(
            port >= 1024 && port != self.server_port,
            "Choose a port from 1024 to 65535 distinct from the Wabi server port"
        );
        self.ensure_tasks().await;
        if port == self.pipe_port() {
            return Ok(self.status().await);
        }
        // Reserve before changing saved settings; a conflict leaves the current pipe intact.
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
        let mut settings = self.store.load_settings();
        settings.pipe_port = Some(port);
        self.store.save_settings(&settings)?;
        self.replace_forwarder(Some(listener)).await?;
        self.store
            .append_audit(actor, "pipe-port-change", Some(port.to_string()));
        self.inner.write().await.address = None;
        self.rebounce.notify_one();
        Ok(self.status().await)
    }

    pub async fn set_key_allowed(
        self: &Arc<Self>,
        key_id: &str,
        allowed: bool,
        actor: i64,
    ) -> anyhow::Result<()> {
        let _change = self.changes.lock().await;
        let mut keys = self.store.load_keys();
        let identity = keys
            .iter()
            .find(|k| k.id == key_id)
            .map(|k| canonical_key(&k.public_key))
            .ok_or_else(|| anyhow::anyhow!("No such device key"))?;
        for key in keys
            .iter_mut()
            .filter(|k| canonical_key(&k.public_key) == identity)
        {
            key.allowed = allowed;
        }
        self.store.save_keys(&keys)?;
        self.store.append_audit(
            actor,
            if allowed { "key-allow" } else { "key-block" },
            Some(key_id.to_string()),
        );
        self.bounce_if_wanted().await;
        Ok(())
    }

    async fn monitor_task(self: Arc<Self>, mut shutdown: watch::Receiver<bool>) {
        let mut child: Option<Child> = None;
        let mut consecutive_failures: u32 = 0;
        loop {
            if *shutdown.borrow() {
                if let Some(mut c) = child.take() {
                    let _ = c.start_kill();
                    let _ = c.wait().await;
                }
                break;
            }
            let wanted = self.inner.read().await.wanted;
            if !wanted {
                if let Some(mut c) = child.take() {
                    let _ = c.start_kill();
                    let _ = c.wait().await;
                }
                self.set_running(false, None).await;
                tokio::select! {
                    _ = self.rebounce.notified() => {},
                    _ = shutdown.changed() => {},
                }
                continue;
            }
            if child.is_none() {
                match self.spawn_listener().await {
                    Ok(c) => {
                        child = Some(c);
                        consecutive_failures = 0;
                    }
                    Err(e) => {
                        self.set_running(false, Some(e.to_string())).await;
                        let delay = std::time::Duration::from_secs(
                            (1u64 << consecutive_failures.min(5)).min(30),
                        );
                        warn!("[tailcat] listener spawn failed ({e}); retrying in {delay:?}");
                        tokio::select! {
                            _ = tokio::time::sleep(delay) => {},
                            _ = self.rebounce.notified() => {},
                            _ = shutdown.changed() => {},
                        }
                        consecutive_failures += 1;
                        continue;
                    }
                }
            }
            // Own the child across the select to satisfy the borrow checker.
            let mut c = child.take().expect("child");
            tokio::select! {
                _ = shutdown.changed() => {
                    let _ = c.start_kill(); let _ = c.wait().await;
                    break;
                }
                _ = self.rebounce.notified() => {
                    let _ = c.start_kill();
                    let _ = c.wait().await;
                    self.set_running(false, None).await;
                    // Loop respawns immediately with fresh config (allow-list,
                    // port changes).
                }
                status = c.wait() => {
                    match status {
                        Ok(code) => {
                            warn!("[tailcat] listener exited: {code}");
                            let msg = format!("listener exited: {code}");
                            self.set_running(false, Some(msg)).await;
                        }
                        Err(e) => {
                            self.set_running(false, Some(e.to_string())).await;
                        }
                    }
                    self.inner.write().await.address = None;
                }
            }
        }
        self.set_running(false, None).await;
        self.shutdown_done.notify_one();
    }

    async fn spawn_listener(self: &Arc<Self>) -> anyhow::Result<Child> {
        self.probe_binary_version().await;
        let pipe_port = self.pipe_port();
        let addr_file = self.store.dir().join("addr.txt");
        let _ = std::fs::remove_file(&addr_file);

        let mut cmd = Command::new(&self.binary_path);
        // Flags MUST precede positional args (tailcat rejects "--allow=..."
        // after the port — it parses as a service name and exits).
        cmd.arg("serve").arg("--json");
        let allow = self.allow_list();
        anyhow::ensure!(
            !allow.is_empty(),
            "No allowed device keys. Register or allow a device before connecting."
        );
        anyhow::ensure!(
            self.forwarder
                .lock()
                .await
                .as_ref()
                .is_some_and(|(_, task)| !task.is_finished()),
            "Private-access forwarder is not running"
        );
        cmd.arg(format!("--allow={allow}"));
        if let Ok(derpmap) = std::env::var(DERPMAP_ENV) {
            let derpmap = derpmap.trim().to_string();
            if !derpmap.is_empty() {
                cmd.arg(format!("--derpmap-url={derpmap}"));
            }
        }
        cmd.arg(pipe_port.to_string());
        cmd.env("TAILCAT_ADDR_FILE", &addr_file);
        cmd.kill_on_drop(true);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::null());
        cmd.stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| {
            anyhow::anyhow!(
                "failed to spawn {} (set {} to override): {e}",
                self.binary_path.display(),
                BINARY_ENV
            )
        })?;
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                use tokio::io::{AsyncBufReadExt, BufReader};
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::debug!("[tailcat-listener] {line}");
                }
            });
        }

        let started = chrono::Utc::now().to_rfc3339();
        let generation = {
            let mut inner = self.inner.write().await;
            inner.listener_generation += 1;
            inner.running = true;
            inner.started_at = Some(started);
            inner.last_error = None;
            inner.address = None;
            inner.listener_generation
        };

        // Wait (bounded) for the address blob so status/`/connect` have it.
        let manager = Arc::downgrade(self);
        tokio::spawn(async move {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            loop {
                if std::time::Instant::now() > deadline {
                    if let Some(m) = manager.upgrade() {
                        m.publish_listener_result(generation, None).await;
                    }
                    return;
                }
                if let Ok(raw) = tokio::fs::read_to_string(&addr_file).await {
                    let trimmed = raw.trim().to_string();
                    if trimmed.starts_with("tc") {
                        if let Some(m) = manager.upgrade() {
                            m.publish_listener_result(generation, Some(trimmed)).await;
                        }
                        return;
                    }
                }
                if manager.upgrade().is_none() {
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        });
        Ok(child)
    }

    /// Toggle the pipe. Hot: bounces only the listener subprocess; disabling
    /// is an immediate kill-switch. Audited.
    pub async fn set_enabled(
        self: &Arc<Self>,
        enabled: bool,
        actor: i64,
    ) -> anyhow::Result<StatusSnapshot> {
        let _change = self.changes.lock().await;
        let mut settings = self.store.load_settings();
        settings.enabled = enabled;
        self.store.save_settings(&settings)?;
        self.store
            .append_audit(actor, if enabled { "enable" } else { "disable" }, None);
        self.inner.write().await.wanted = enabled;
        self.ensure_tasks().await;
        self.rebounce.notify_one();

        // Give the monitor a moment to reflect the transition in status.
        for _ in 0..30 {
            let snap = self.status().await;
            if snap.running == enabled {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        Ok(self.status().await)
    }

    /// Register a client public key for a member (idempotent per
    /// user+key; label updates allowed). Audited. Bounces the listener so
    /// the allow-list picks it up live.
    pub async fn register_key(
        self: &Arc<Self>,
        user_id: i64,
        public_key: String,
        label: Option<String>,
    ) -> anyhow::Result<MemberKeyRecord> {
        let _change = self.changes.lock().await;
        let raw_key = public_key.trim();
        let material = raw_key.strip_prefix("nodekey:").unwrap_or(raw_key);
        anyhow::ensure!(
            material.len() == 64 && material.bytes().all(|b| b.is_ascii_hexdigit()),
            "Device public key must contain 64 hexadecimal digits"
        );
        let key = canonical_key(raw_key);
        if key.is_empty() || key.len() > 512 {
            anyhow::bail!("public key must be 1..512 chars");
        }
        let mut keys = self.store.load_keys();
        if let Some(existing) = keys
            .iter_mut()
            .find(|k| k.user_id == user_id && canonical_key(&k.public_key) == key)
        {
            existing.label = label.clone().or(existing.label.clone());
            let updated = existing.clone();
            self.store.save_keys(&keys)?;
            self.store
                .append_audit(user_id, "key-label-update", Some(key));
            self.bounce_if_wanted().await;
            return Ok(updated);
        }
        anyhow::ensure!(
            !keys.iter().any(|k| canonical_key(&k.public_key) == key),
            "Device key belongs to another member"
        );
        let record = MemberKeyRecord {
            allowed: true,
            id: uuid::Uuid::new_v4().to_string(),
            user_id,
            public_key: key.clone(),
            label,
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        keys.push(record.clone());
        self.store.save_keys(&keys)?;
        self.store.append_audit(user_id, "key-register", Some(key));
        self.bounce_if_wanted().await;
        Ok(record)
    }

    /// Revoke one key (admin action). Audited. Hot allow-list update.
    pub async fn revoke_key(self: &Arc<Self>, key_id: &str, actor: i64) -> anyhow::Result<()> {
        let _change = self.changes.lock().await;
        let mut keys = self.store.load_keys();
        let before = keys.len();
        keys.retain(|k| k.id != key_id);
        if keys.len() == before {
            anyhow::bail!("no such key: {key_id}");
        }
        self.store.save_keys(&keys)?;
        self.store
            .append_audit(actor, "key-revoke", Some(key_id.to_string()));
        self.bounce_if_wanted().await;
        Ok(())
    }

    pub fn keys(&self) -> Vec<MemberKeyRecord> {
        self.store.load_keys()
    }

    /// Connection info for a member: the address blob iff the pipe is
    /// enabled AND that member has at least one registered key.
    pub async fn address_for(&self, user_id: i64) -> Option<String> {
        let inner = self.inner.read().await;
        if !inner.wanted {
            return None;
        }
        let has_key = self
            .store
            .load_keys()
            .iter()
            .any(|k| k.user_id == user_id && k.allowed);
        if !has_key {
            return None;
        }
        inner.address.clone()
    }

    pub async fn status(&self) -> StatusSnapshot {
        self.probe_binary_version().await;
        let inner = self.inner.read().await;
        StatusSnapshot {
            enabled: inner.wanted,
            running: inner.running,
            address: inner.address.clone(),
            pipe_port: self.pipe_port(),
            server_port: self.server_port,
            binary_path: self.binary_path.display().to_string(),
            binary_version: inner.binary_version.clone(),
            keys: self.store.load_keys(),
            last_error: inner.last_error.clone(),
            started_at: inner.started_at.clone(),
        }
    }

    /// Audit tail (admin visibility).
    pub fn audit_tail(&self, limit: usize) -> Vec<AuditEntry> {
        self.store.read_audit(limit)
    }

    /// Stable IP bucket for the authenticated loopback transport, scoped
    /// separately from public ingress. The forwarder has no remote member
    /// identity: its ephemeral source port must never reset a creation quota.
    /// Untrusted or malformed tags fall back to the physical peer IP.
    pub fn rate_limit_key(&self, headers: &http::HeaderMap, peer: &std::net::SocketAddr) -> String {
        let authenticated = peer.ip().is_loopback()
            && headers
                .get(forwarder::PIPE_AUTH_HEADER)
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| v == self.pipe_auth_token);
        if authenticated {
            if let Some(client) = headers
                .get(forwarder::PIPE_CLIENT_HEADER)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<std::net::SocketAddr>().ok())
            {
                return format!("pipe:{}", client.ip());
            }
        }
        peer.ip().to_string()
    }

    // A reader belongs to one child, not the manager's entire lifetime. The
    // existing state lock makes ownership validation and publication indivisible.
    async fn publish_listener_result(&self, generation: u64, address: Option<String>) {
        let mut inner = self.inner.write().await;
        if !inner.running || inner.listener_generation != generation {
            return;
        }
        match address {
            Some(address) => inner.address = Some(address),
            None => {
                inner.last_error =
                    Some("listener started but produced no address within 10s".into())
            }
        }
    }

    async fn set_running(&self, running: bool, err: Option<String>) {
        let mut inner = self.inner.write().await;
        inner.running = running;
        if !running {
            inner.address = None;
            inner.started_at = None;
        }
        if err.is_some() {
            inner.last_error = err;
        }
    }

    async fn bounce_if_wanted(self: &Arc<Self>) {
        if self.inner.read().await.wanted {
            self.ensure_tasks().await;
            self.rebounce.notify_one();
        }
    }

    fn allow_list(&self) -> String {
        let keys = self.store.load_keys();
        let blocked: std::collections::HashSet<_> = keys
            .iter()
            .filter(|k| !k.allowed)
            .map(|k| canonical_key(&k.public_key))
            .collect();
        let allowed: std::collections::BTreeSet<_> = keys
            .iter()
            .filter(|k| k.allowed)
            .map(|k| canonical_key(&k.public_key))
            .filter(|k| !blocked.contains(k))
            .collect();
        allowed.into_iter().collect::<Vec<_>>().join(",")
    }

    /// One-time `tailcat version` probe so the admin panel can say whether
    /// the binary is actually present/working.
    async fn probe_binary_version(&self) {
        {
            let inner = self.inner.read().await;
            if inner.binary_version_checked {
                return;
            }
        }
        let version = Command::new(&self.binary_path)
            .arg("version")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .await
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
        let mut inner = self.inner.write().await;
        inner.binary_version = version;
        inner.binary_version_checked = true;
    }
}

fn canonical_key(key: &str) -> String {
    format!(
        "nodekey:{}",
        key.strip_prefix("nodekey:")
            .unwrap_or(key)
            .to_ascii_lowercase()
    )
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;

    #[tokio::test]
    async fn stopped_and_replaced_listeners_reject_late_reader_publication() {
        let dir = tempfile::tempdir().unwrap();
        let manager = TailcatManager::new(3001, dir.path());
        // Skip the unrelated external binary probe.
        manager.inner.write().await.binary_version_checked = true;
        for generation in 1..=100 {
            {
                let mut inner = manager.inner.write().await;
                inner.running = true;
                inner.listener_generation = generation;
            }
            manager
                .publish_listener_result(generation, Some("tc-current".into()))
                .await;
            assert_eq!(
                manager.status().await.address.as_deref(),
                Some("tc-current")
            );
            manager.set_running(false, None).await;
            // Historical HTTP failure: the detached reader completed AFTER stop.
            manager
                .publish_listener_result(generation, Some("tc-stale".into()))
                .await;
            manager.publish_listener_result(generation, None).await;
            let stopped = manager.status().await;
            assert!(!stopped.running);
            assert!(stopped.address.is_none());
            assert!(stopped.started_at.is_none());
            assert!(stopped.last_error.is_none());
            {
                let mut inner = manager.inner.write().await;
                inner.running = true;
                inner.listener_generation = generation + 1;
            }
            manager
                .publish_listener_result(generation, Some("tc-old-child".into()))
                .await;
            manager.publish_listener_result(generation, None).await;
            let replaced = manager.status().await;
            assert!(replaced.address.is_none());
            assert!(replaced.last_error.is_none());
        }
    }
}
