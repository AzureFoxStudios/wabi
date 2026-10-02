//! Coordinated local application + engine boundary. No inventory certificate,
//! writer promotion or distributed lease is provided here. The encrypted lane
//! captures core roots/config only; external-store readiness remains unproven.
use std::{sync::Arc, time::Duration};
use tokio::task::JoinHandle;
use wabidb::engine::checkpoint::PausedEngine;

use crate::{instance_operations::Quiescent, state::AppState};

pub struct InstanceCheckpointBoundary {
    database: PausedEngine,
    _operations: Quiescent,
    state: Arc<AppState>,
}

impl InstanceCheckpointBoundary {
    /// Set an async deadline for admission/engine drain before file I/O. On
    /// timeout pending preparation and its guards are dropped. Synchronous
    /// validation cannot be preempted; a late result is refused too. This is
    /// not a deadline for a started blocking copy.
    pub async fn prepare_with_timeout(
        state: Arc<AppState>,
        timeout: Duration,
    ) -> anyhow::Result<Self> {
        if timeout.is_zero() {
            anyhow::bail!("checkpoint drain timeout must be positive");
        }
        let deadline = tokio::time::Instant::now()
            .checked_add(timeout)
            .ok_or_else(|| anyhow::anyhow!("checkpoint drain timeout is out of range"))?;
        let boundary = tokio::time::timeout_at(deadline, Self::prepare(state))
            .await
            .map_err(|_| anyhow::anyhow!("checkpoint drain deadline elapsed"))??;
        if tokio::time::Instant::now() >= deadline {
            anyhow::bail!("checkpoint drain deadline elapsed");
        }
        Ok(boundary)
    }

    /// Must run outside ordinary request/callback admission. Application work
    /// drains first, then both database mutation paths are held. A paused engine
    /// alone would not drain sidecar publication following a database commit.
    pub async fn prepare(state: Arc<AppState>) -> anyhow::Result<Self> {
        if !matches!(
            state.config.server_role,
            crate::config::ServerRole::Authority
        ) {
            anyhow::bail!("checkpoint boundary requires an Authority instance");
        }
        let operations = state.instance_operations.quiesce().await?;
        let database = state.wdb.engine_handle().pause_for_checkpoint().await?;
        Ok(Self {
            database,
            _operations: operations,
            state,
        })
    }

    pub fn applied_seq(&self) -> u64 {
        self.database.applied_seq()
    }

    pub fn prefix_fingerprint(&self) -> &str {
        self.database.prefix_fingerprint()
    }

    /// Read only, while both application and engine checkpoint guards remain
    /// held. This applied prefix is not an encryption allocation high water.
    pub(crate) fn source_identity(
        &self,
    ) -> crate::instance_archive::source_context::FrozenSourceIdentity {
        crate::instance_archive::source_context::FrozenSourceIdentity::capture(
            &self.state,
            self.applied_seq(),
            self.prefix_fingerprint(),
        )
    }

    /// Stream a V2 encrypted core snapshot without a plaintext staging tree.
    /// Caller must be outside normal admission and provide resource limits.
    /// Restores remain inactive; this never certifies external state or HA.
    pub fn export_encrypted(
        self,
        recipient: String,
        output: std::path::PathBuf,
        limits: crate::instance_archive::LiveExportLimits,
    ) -> JoinHandle<wabidb::error::Result<crate::instance_archive::LiveArchiveReceipt>> {
        self.with_files(move |state, seq, prefix| {
            let result = (|| -> anyhow::Result<_> {
                let data = std::fs::canonicalize(&state.config.data_dir)?;
                let uploads = std::fs::canonicalize(&state.config.uploads_dir)?;
                // File-backed blacklist policy must be in one of the captured
                // roots even when no policy file has been written yet.
                let blacklist = std::path::Path::new(&state.config.blacklist_file);
                let parent = blacklist
                    .parent()
                    .filter(|p| !p.as_os_str().is_empty())
                    .unwrap_or(std::path::Path::new("."));
                let blacklist = std::fs::canonicalize(parent)?.join(
                    blacklist
                        .file_name()
                        .ok_or_else(|| anyhow::anyhow!("blacklist path needs a file name"))?,
                );
                if !blacklist.starts_with(&data) && !blacklist.starts_with(&uploads) {
                    anyhow::bail!(
                        "external blacklist policy needs a coordinated inventory participant"
                    );
                }
                if state.config.lore.enabled
                    || state
                        .addon_switches
                        .try_read()
                        .map_err(|_| anyhow::anyhow!("addon state is not drained"))?
                        .resolve("lore", Some("WABI_LORE_ENABLED"), false)
                {
                    anyhow::bail!("enabled Lore needs an external-store checkpoint participant");
                }
                #[cfg(feature = "wabi-lore")]
                if state
                    .lore_service
                    .try_read()
                    .map_err(|_| anyhow::anyhow!("Lore state is not drained"))?
                    .is_some()
                {
                    anyhow::bail!(
                        "active Lore service needs an external-store checkpoint participant"
                    );
                }
                // The logging appender/pruner is not an admitted canonical
                // writer. Never silently copy a changing log subtree as state.
                let log_dir = std::env::var("WABI_LOG_DIR").unwrap_or_else(|_| "./logs".into());
                if let Ok(logs) = std::fs::canonicalize(log_dir) {
                    if logs.starts_with(&data) || logs.starts_with(&uploads) {
                        anyhow::bail!(
                            "logs inside a state root need an explicit inventory classification"
                        );
                    }
                }
                let metadata = crate::instance_archive::LiveCheckpointMetadata {
                    schema_version: 1,
                    captured_at_unix_ms: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)?
                        .as_millis()
                        .try_into()?,
                    applied_commit_seq: seq,
                    commit_prefix_fingerprint: prefix.to_owned(),
                    bootstrap_fingerprint: state.wdb.engine().replica_fingerprint(),
                    node_id: state.config.node_id.clone(),
                    server_config: serde_json::to_value(&state.config)?,
                    excluded_runtime_paths: [
                        "data/.lock",
                        "data/wabidb/.lock",
                        "data/.wabi-secret-publication.lock",
                        "data/wabidb/.wabi-secret-publication.lock",
                        "data/tailcat/addr.txt",
                    ]
                    .into_iter()
                    .map(str::to_owned)
                    .collect(),
                    active_key_substitutions: ["data/jwt_secret", "data/wabidb/root_key"]
                        .into_iter()
                        .map(str::to_owned)
                        .collect(),
                    external_state_verified: false,
                    full_instance_ready: false,
                };
                crate::instance_archive::export_frozen(
                    crate::instance_archive::FrozenExport {
                        data: std::path::Path::new(&state.config.data_dir),
                        uploads: std::path::Path::new(&state.config.uploads_dir),
                        jwt_secret: &state.config.jwt_secret,
                        root_key: state.wdb.engine().bootstrap_key(),
                        metadata,
                    },
                    &recipient,
                    &output,
                    limits,
                )
            })();
            result.map_err(|error| wabidb::error::WabiError::Validation {
                command: "live_checkpoint_export".into(),
                reason: error.to_string(),
            })
        })
    }

    /// Own all guards inside blocking I/O, including the projection snapshot
    /// writer lock held by with_projection_checkpoint. Cancelling the caller
    /// or aborting a started blocking JoinHandle cannot resume writers early.
    /// `copy` must perform synchronous file work, never call admitted handlers,
    /// database writes or another snapshot. Its caller still owns the complete
    /// path inventory, encryption, cleanup and restore acceptance contract.
    pub fn with_files<T, F>(self, copy: F) -> JoinHandle<wabidb::error::Result<T>>
    where
        T: Send + 'static,
        F: FnOnce(&AppState, u64, &str) -> wabidb::error::Result<T> + Send + 'static,
    {
        tokio::task::spawn_blocking(move || {
            self.database.with_projection_checkpoint(|| {
                copy(&self.state, self.applied_seq(), self.prefix_fingerprint())
            })
        })
    }
}
