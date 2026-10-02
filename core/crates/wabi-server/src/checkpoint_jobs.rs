//! Local operator control for owned, bounded encrypted core checkpoint jobs.
//! This module is outside normal operation admission; it never promotes a copy.
use std::{
    collections::VecDeque,
    fs::{self, OpenOptions},
    io::Write,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use crate::{
    config::ServerConfig,
    instance_archive::source_context::{valid_job_id, validate_receipt, SourceDirectory},
    instance_archive::{LiveArchiveReceipt, LiveExportLimits},
    instance_checkpoint::InstanceCheckpointBoundary,
    state::AppState,
};
use anyhow::{bail, ensure, Context, Result};
use axum::{
    extract::{ConnectInfo, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const HISTORY: usize = 16;
const MAX_DIRECTORY_ENTRIES: usize = 512;
const MAX_RECORD_BYTES: u64 = 64 * 1024;

/// Trusted local startup configuration; no request can select a key or path.
#[derive(Clone)]
pub struct CheckpointPolicy {
    pub directory: PathBuf,
    pub recipient: String,
    pub drain_timeout: Duration,
    pub export_limits: LiveExportLimits,
    pub max_stored_bytes: u64,
    pub min_free_bytes: u64,
}
impl CheckpointPolicy {
    fn validate(&self, config: &ServerConfig) -> Result<()> {
        self.recipient
            .parse::<age::x25519::Recipient>()
            .map_err(|_| {
                anyhow::anyhow!("checkpoint recipient must be an age X25519 public recipient")
            })?;
        ensure!(
            !self.drain_timeout.is_zero(),
            "checkpoint drain timeout must be positive"
        );
        ensure!(
            !self.export_limits.copy_timeout.is_zero()
                && self.export_limits.max_entries >= 4
                && self.export_limits.max_entries <= 10_000_000
                && self.export_limits.max_plaintext_bytes > 0
                && self.export_limits.max_inventory_path_bytes > 0,
            "invalid checkpoint limits"
        );
        ensure!(
            self.max_stored_bytes > 0,
            "checkpoint storage budget must be positive"
        );
        let metadata = fs::symlink_metadata(&self.directory)?;
        ensure!(
            metadata.is_dir() && !metadata.file_type().is_symlink(),
            "checkpoint output must be a real directory"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            ensure!(
                metadata.permissions().mode() & 0o077 == 0,
                "checkpoint output directory must be private (mode 0700)"
            );
        }
        let root = fs::canonicalize(&self.directory)?;
        let data = fs::canonicalize(&config.data_dir)?;
        let uploads = fs::canonicalize(&config.uploads_dir)?;
        ensure!(
            !root.starts_with(&data)
                && !root.starts_with(&uploads)
                && !data.starts_with(&root)
                && !uploads.starts_with(&root),
            "checkpoint output must be separate from state roots"
        );
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CheckpointPhase {
    Queued,
    Draining,
    Copying,
    Ready,
    Failed,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckpointJob {
    pub schema_version: u8,
    pub id: String,
    pub phase: CheckpointPhase,
    pub started_at_unix_ms: u64,
    pub finished_at_unix_ms: Option<u64>,
    pub receipt: Option<LiveArchiveReceipt>,
    /// Fixed code only: export errors can contain operator paths/configuration.
    pub failure_code: Option<String>,
}
#[derive(Default)]
struct JobState {
    active: Option<String>,
    history: VecDeque<CheckpointJob>,
}
struct Inner {
    policy: Option<CheckpointPolicy>,
    source_directory: Option<Arc<SourceDirectory>>,
    source_reads: Arc<tokio::sync::Semaphore>,
    jobs: Mutex<JobState>,
}
#[derive(Clone)]
pub struct CheckpointJobs(Arc<Inner>);
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointStatus {
    pub enabled: bool,
    pub full_instance_ready: bool,
    pub active_job_id: Option<String>,
    pub jobs: Vec<CheckpointJob>,
}
#[derive(Debug)]
pub enum StartError {
    Disabled,
    Busy,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
fn number(name: &str, default: u64) -> Result<u64> {
    match std::env::var(name) {
        Ok(value) => value
            .parse::<u64>()
            .with_context(|| format!("invalid {name}")),
        Err(std::env::VarError::NotPresent) => Ok(default),
        Err(_) => bail!("invalid {name}"),
    }
}

impl CheckpointJobs {
    pub fn from_environment(config: &ServerConfig) -> Result<Self> {
        let directory = std::env::var_os("WABI_CHECKPOINT_DIR");
        let recipient = std::env::var("WABI_CHECKPOINT_RECIPIENT").ok();
        let policy = match (directory, recipient) {
            (None, None) => None,
            (Some(directory), Some(recipient)) => Some(CheckpointPolicy {
                directory: directory.into(),
                recipient,
                drain_timeout: Duration::from_secs(number("WABI_CHECKPOINT_DRAIN_SECONDS", 15)?),
                export_limits: LiveExportLimits {
                    max_entries: number("WABI_CHECKPOINT_MAX_ENTRIES", 100_000)?,
                    max_plaintext_bytes: number("WABI_CHECKPOINT_MAX_BYTES", 1024 * 1024 * 1024)?,
                    max_inventory_path_bytes: number(
                        "WABI_CHECKPOINT_MAX_PATH_BYTES",
                        16 * 1024 * 1024,
                    )?,
                    copy_timeout: Duration::from_secs(number("WABI_CHECKPOINT_COPY_SECONDS", 30)?),
                },
                max_stored_bytes: number("WABI_CHECKPOINT_STORAGE_BYTES", 4 * 1024 * 1024 * 1024)?,
                min_free_bytes: number("WABI_CHECKPOINT_MIN_FREE_BYTES", 1024 * 1024 * 1024)?,
            }),
            _ => bail!("configure both WABI_CHECKPOINT_DIR and WABI_CHECKPOINT_RECIPIENT"),
        };
        let source_context = match std::env::var("WABI_CHECKPOINT_SOURCE_CONTEXT") {
            Err(std::env::VarError::NotPresent) => false,
            Ok(value) if value == "0" => false,
            Ok(value) if value == "1" => true,
            _ => bail!("WABI_CHECKPOINT_SOURCE_CONTEXT must be 0 or 1"),
        };
        Self::open_with_source_context(policy, config, source_context)
    }

    pub fn open(policy: Option<CheckpointPolicy>, config: &ServerConfig) -> Result<Self> {
        Self::open_with_source_context(policy, config, false)
    }

    /// Separate startup opt-in; old V2/receipt/job schemas are unchanged.
    pub fn open_with_source_context(
        mut policy: Option<CheckpointPolicy>,
        config: &ServerConfig,
        enabled: bool,
    ) -> Result<Self> {
        ensure!(
            !enabled || policy.is_some(),
            "source context requires configured checkpoints"
        );
        let mut jobs = JobState::default();
        let mut source_directory = None;
        if let Some(policy) = &mut policy {
            policy.validate(config)?;
            policy.directory = fs::canonicalize(&policy.directory)?;
            if enabled {
                source_directory = Some(Arc::new(SourceDirectory::open(&policy.directory)?));
            }
            let files = directory_files(policy)?;
            for path in &files {
                if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
                    if name.ends_with(".json") {
                        ensure!(
                            name.strip_suffix(".source-context.json")
                                .is_some_and(valid_job_id)
                                || name.strip_suffix(".json").is_some_and(valid_job_id),
                            "invalid checkpoint JSON filename"
                        );
                    }
                }
            }
            for path in files.into_iter().filter(|path| {
                path.file_name()
                    .and_then(|s| s.to_str())
                    .is_some_and(|name| {
                        // Sidecars stay quota-counted, but are not job records.
                        name.strip_suffix(".json").is_some_and(valid_job_id)
                    })
            }) {
                ensure!(
                    fs::metadata(&path)?.len() <= MAX_RECORD_BYTES,
                    "checkpoint record is oversized"
                );
                let mut job: CheckpointJob = serde_json::from_slice(&fs::read(&path)?)?;
                ensure!(
                    job.schema_version == 1
                        && uuid::Uuid::parse_str(&job.id).is_ok()
                        && path.file_stem().is_some_and(|stem| stem == job.id.as_str()),
                    "invalid checkpoint record identity"
                );
                if !matches!(job.phase, CheckpointPhase::Ready | CheckpointPhase::Failed) {
                    job.phase = CheckpointPhase::Failed;
                    job.failure_code = Some("process_interrupted".into());
                    job.finished_at_unix_ms = Some(now_ms());
                    persist(policy, &job)?;
                } else if job.phase == CheckpointPhase::Ready {
                    ensure!(
                        job.receipt
                            .as_ref()
                            .is_some_and(|receipt| receipt.schema_version == 1
                                && !receipt.full_instance_ready),
                        "invalid completed checkpoint receipt"
                    );
                    if verify_recorded_archive(policy, &job).is_err() {
                        job.phase = CheckpointPhase::Failed;
                        job.failure_code = Some("recorded_archive_unavailable".into());
                        persist(policy, &job)?;
                    }
                }
                jobs.history.push_back(job);
            }
            jobs.history
                .make_contiguous()
                .sort_by_key(|job| job.started_at_unix_ms);
            while jobs.history.len() > HISTORY {
                jobs.history.pop_front();
            }
        }
        Ok(Self(Arc::new(Inner {
            policy,
            source_directory,
            source_reads: Arc::new(tokio::sync::Semaphore::new(1)),
            jobs: Mutex::new(jobs),
        })))
    }

    pub fn status(&self) -> CheckpointStatus {
        let jobs = self.0.jobs.lock().unwrap_or_else(|e| e.into_inner());
        CheckpointStatus {
            enabled: self.0.policy.is_some(),
            full_instance_ready: false,
            active_job_id: jobs.active.clone(),
            jobs: jobs.history.iter().cloned().collect(),
        }
    }

    /// Owned blocking read: caller cancellation cannot drop its descriptor or
    /// pretend that completed byte verification has already stopped.
    async fn source_context(
        &self,
        id: String,
        community: String,
        node: String,
    ) -> Result<wabi_consensus::source_context::SignedSourceContext> {
        ensure!(valid_job_id(&id), "invalid checkpoint job ID");
        let directory = self
            .0
            .source_directory
            .clone()
            .context("source context disabled")?;
        let policy = self.0.policy.clone().context("checkpoints disabled")?;
        let job = self
            .0
            .jobs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .history
            .iter()
            .find(|job| job.id == id)
            .cloned()
            .context("unknown checkpoint job")?;
        ensure!(
            job.phase == CheckpointPhase::Ready && job.failure_code.is_none(),
            "checkpoint not ready"
        );
        let receipt = job.receipt.clone().context("missing export receipt")?;
        let permit = self
            .0
            .source_reads
            .clone()
            .try_acquire_owned()
            .map_err(|_| anyhow::anyhow!("source read already active"))?;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            ensure!(
                serde_json::to_vec(&directory.job(&id)?)? == serde_json::to_vec(&job)?,
                "persisted checkpoint job differs"
            );
            let context = directory.read(&id)?;
            validate_receipt(&context, &receipt, &community, &node)?;
            directory.verify_archive(
                &id,
                &receipt,
                policy.max_stored_bytes,
                policy.export_limits.copy_timeout,
            )?;
            ensure!(
                serde_json::to_vec(&directory.job(&id)?)? == serde_json::to_vec(&job)?,
                "persisted checkpoint job changed"
            );
            Ok(context)
        })
        .await?
    }

    /// The ordinary spawned task deliberately inherits no admission task-local.
    /// Disconnecting the HTTP caller cannot cancel the drain or blocking copy.
    pub fn start(&self, state: Arc<AppState>) -> std::result::Result<CheckpointJob, StartError> {
        let policy = self.0.policy.clone().ok_or(StartError::Disabled)?;
        let job = CheckpointJob {
            schema_version: 1,
            id: uuid::Uuid::new_v4().to_string(),
            phase: CheckpointPhase::Queued,
            started_at_unix_ms: now_ms(),
            finished_at_unix_ms: None,
            receipt: None,
            failure_code: None,
        };
        {
            let mut jobs = self.0.jobs.lock().unwrap_or_else(|e| e.into_inner());
            if jobs.active.is_some() {
                return Err(StartError::Busy);
            }
            jobs.active = Some(job.id.clone());
            if jobs.history.len() == HISTORY {
                jobs.history.pop_front();
            }
            jobs.history.push_back(job.clone());
        }
        let manager = self.clone();
        let running = job.clone();
        tokio::spawn(async move {
            let worker_manager = manager.clone();
            let worker_job = running.clone();
            let worker_policy = policy.clone();
            let result = tokio::spawn(async move {
                execute(worker_manager, state, worker_policy, worker_job).await
            })
            .await;
            let mut finished = running;
            finished.finished_at_unix_ms = Some(now_ms());
            match result {
                Ok(Ok(receipt)) => {
                    finished.phase = CheckpointPhase::Ready;
                    finished.receipt = Some(receipt);
                }
                Ok(Err(code)) => {
                    finished.phase = CheckpointPhase::Failed;
                    finished.failure_code = Some(code.into());
                }
                Err(_) => {
                    finished.phase = CheckpointPhase::Failed;
                    finished.failure_code = Some("worker_interrupted".into());
                }
            }
            // No journal was allocated when the initial resource reserve was
            // refused. Persisting those refusals would itself bypass the disk
            // and directory ceilings with an unlimited stream of failed jobs.
            if finished.failure_code.as_deref() != Some("storage_budget_failed") {
                let persisted = finished.clone();
                if !tokio::task::spawn_blocking(move || persist(&policy, &persisted))
                    .await
                    .is_ok_and(|result| result.is_ok())
                {
                    finished.phase = CheckpointPhase::Failed;
                    finished.failure_code = Some("receipt_persistence_failed".into());
                }
            }
            let mut jobs = manager.0.jobs.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(slot) = jobs.history.iter_mut().find(|job| job.id == finished.id) {
                *slot = finished;
            }
            jobs.active = None;
        });
        Ok(job)
    }

    async fn phase(
        &self,
        policy: CheckpointPolicy,
        mut job: CheckpointJob,
        phase: CheckpointPhase,
    ) -> std::result::Result<(), &'static str> {
        job.phase = phase;
        let persisted = job.clone();
        tokio::task::spawn_blocking(move || persist(&policy, &persisted))
            .await
            .map_err(|_| "receipt_persistence_failed")?
            .map_err(|_| "receipt_persistence_failed")?;
        let mut jobs = self.0.jobs.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(slot) = jobs.history.iter_mut().find(|slot| slot.id == job.id) {
            *slot = job;
        }
        Ok(())
    }
}

async fn execute(
    manager: CheckpointJobs,
    state: Arc<AppState>,
    policy: CheckpointPolicy,
    job: CheckpointJob,
) -> std::result::Result<LiveArchiveReceipt, &'static str> {
    let budget_policy = policy.clone();
    let source_enabled = manager.0.source_directory.is_some();
    tokio::task::spawn_blocking(move || {
        let files = directory_files(&budget_policy)?;
        ensure!(
            files.len() + if source_enabled { 5 } else { 3 } <= MAX_DIRECTORY_ENTRIES,
            "checkpoint directory is full"
        );
        let used = files.iter().try_fold(0u64, |total, path| {
            total
                .checked_add(fs::metadata(path)?.len())
                .context("checkpoint storage size overflow")
        })?;
        // Conservative reserve for age framing, paths, entry/footer data and
        // metadata. The export still enforces its independent source limits.
        let limits = &budget_policy.export_limits;
        let reserve = limits
            .max_plaintext_bytes
            .checked_add(limits.max_plaintext_bytes / 50)
            .and_then(|n| n.checked_add(limits.max_inventory_path_bytes))
            .and_then(|n| {
                limits
                    .max_entries
                    .checked_mul(64)
                    .and_then(|extra| n.checked_add(extra))
            })
            .and_then(|n| n.checked_add(2 * 1024 * 1024))
            .and_then(|n| {
                n.checked_add(if source_enabled {
                    wabi_consensus::source_context::MAX_SOURCE_CONTEXT_BYTES as u64
                } else {
                    0
                })
            })
            .context("checkpoint reserve overflow")?;
        ensure!(
            used.checked_add(reserve)
                .is_some_and(|n| n <= budget_policy.max_stored_bytes),
            "checkpoint storage budget exhausted; retain or remove archives explicitly"
        );
        ensure!(
            fs4::available_space(&budget_policy.directory)?
                >= reserve
                    .checked_add(budget_policy.min_free_bytes)
                    .context("checkpoint free-space reserve overflow")?,
            "checkpoint disk headroom is insufficient"
        );
        Ok::<_, anyhow::Error>(())
    })
    .await
    .map_err(|_| "storage_budget_failed")?
    .map_err(|_| "storage_budget_failed")?;
    manager
        .phase(policy.clone(), job.clone(), CheckpointPhase::Draining)
        .await?;
    let boundary =
        InstanceCheckpointBoundary::prepare_with_timeout(state.clone(), policy.drain_timeout)
            .await
            .map_err(|_| "checkpoint_drain_failed")?;
    manager
        .phase(policy.clone(), job.clone(), CheckpointPhase::Copying)
        .await?;
    let source = manager
        .0
        .source_directory
        .as_ref()
        .map(|_| boundary.source_identity());
    let receipt = boundary
        .export_encrypted(
            policy.recipient,
            policy.directory.join(format!("{}.age", job.id)),
            policy.export_limits,
        )
        .await
        .map_err(|_| "checkpoint_copy_failed")?
        .map_err(|_| "checkpoint_copy_failed")?;
    if let (Some(source), Some(directory)) = (source, manager.0.source_directory.clone()) {
        // The completed export is tied to the identity captured under both
        // guards. No caller can supply its own claims or signing bytes.
        let context = state
            .community_roster
            .sign_checkpoint_source(&source, &receipt)
            .map_err(|_| "source_context_signing_failed")?;
        let id = job.id;
        tokio::task::spawn_blocking(move || directory.publish(&id, &context))
            .await
            .map_err(|_| "source_context_publication_failed")?
            .map_err(|_| "source_context_publication_failed")?;
    }
    Ok(receipt)
}

fn directory_files(policy: &CheckpointPolicy) -> Result<Vec<PathBuf>> {
    let metadata = fs::symlink_metadata(&policy.directory)?;
    ensure!(
        metadata.is_dir() && !metadata.file_type().is_symlink(),
        "invalid checkpoint directory"
    );
    let mut files = Vec::new();
    for entry in fs::read_dir(&policy.directory)? {
        ensure!(
            files.len() < MAX_DIRECTORY_ENTRIES,
            "checkpoint directory entry limit exceeded"
        );
        let entry = entry?;
        let metadata = fs::symlink_metadata(entry.path())?;
        ensure!(
            metadata.is_file() && !metadata.file_type().is_symlink(),
            "checkpoint directory contains unsupported entries"
        );
        files.push(entry.path());
    }
    Ok(files)
}

fn verify_recorded_archive(policy: &CheckpointPolicy, job: &CheckpointJob) -> Result<()> {
    use std::io::Read;
    let receipt = job.receipt.as_ref().context("checkpoint receipt missing")?;
    let path = policy.directory.join(format!("{}.age", job.id));
    let metadata = fs::symlink_metadata(&path)?;
    ensure!(
        metadata.is_file()
            && !metadata.file_type().is_symlink()
            && metadata.len() == receipt.ciphertext_bytes
            && metadata.len() <= policy.max_stored_bytes,
        "checkpoint archive size/type differs"
    );
    let deadline = std::time::Instant::now()
        .checked_add(policy.export_limits.copy_timeout)
        .context("checkpoint verification deadline out of range")?;
    let mut file = fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut bytes = [0u8; 64 * 1024];
    loop {
        ensure!(
            std::time::Instant::now() < deadline,
            "checkpoint verification deadline elapsed"
        );
        let count = file.read(&mut bytes)?;
        if count == 0 {
            break;
        }
        hash.update(&bytes[..count]);
    }
    ensure!(
        hex::encode(hash.finalize()) == receipt.encrypted_archive_sha256,
        "checkpoint archive digest differs"
    );
    Ok(())
}

fn persist(policy: &CheckpointPolicy, job: &CheckpointJob) -> Result<()> {
    let temporary = policy
        .directory
        .join(format!(".receipt-{}", uuid::Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options.open(&temporary)?;
        file.write_all(&serde_json::to_vec_pretty(job)?)?;
        file.sync_all()?;
        fs::rename(
            &temporary,
            policy.directory.join(format!("{}.json", job.id)),
        )?;
        #[cfg(unix)]
        fs::File::open(&policy.directory)?.sync_all()?;
        Ok(())
    })();
    let _ = fs::remove_file(&temporary);
    result
}

async fn status(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    peer: ConnectInfo<SocketAddr>,
) -> Response {
    if let Err(response) = crate::api::operator::operator_auth(&headers, peer) {
        return response;
    }
    Json(state.checkpoint_jobs.status()).into_response()
}
async fn start(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    peer: ConnectInfo<SocketAddr>,
) -> Response {
    if let Err(response) = crate::api::operator::operator_auth(&headers, peer) {
        return response;
    }
    match state.checkpoint_jobs.start(Arc::clone(&state)) {
        Ok(job) => (StatusCode::ACCEPTED, Json(job)).into_response(),
        Err(StartError::Disabled) => (
            StatusCode::SERVICE_UNAVAILABLE,
            "Checkpoint export is not configured",
        )
            .into_response(),
        Err(StartError::Busy) => {
            (StatusCode::CONFLICT, "A checkpoint job is already running").into_response()
        }
    }
}
async fn source_context(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    headers: HeaderMap,
    peer: ConnectInfo<SocketAddr>,
) -> Response {
    if let Err(response) = crate::api::operator::operator_auth(&headers, peer) {
        return response;
    }
    match state
        .checkpoint_jobs
        .source_context(
            id,
            state.community_roster.community_id().into(),
            state.config.node_id.clone(),
        )
        .await
    {
        Ok(context) => Json(context).into_response(),
        Err(_) => (
            StatusCode::NOT_FOUND,
            "Checkpoint source context is unavailable",
        )
            .into_response(),
    }
}
pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/operator/checkpoints", get(status).post(start))
        .route("/api/operator/checkpoints/", get(status).post(start))
        .route(
            "/api/operator/checkpoints/{id}/source-context",
            get(source_context),
        )
        .layer(axum::middleware::from_fn(
            |request: axum::extract::Request, next: axum::middleware::Next| async move {
                let mut response = next.run(request).await;
                response.headers_mut().insert(
                    axum::http::header::CACHE_CONTROL,
                    axum::http::HeaderValue::from_static("no-store, private"),
                );
                response
            },
        ))
}
