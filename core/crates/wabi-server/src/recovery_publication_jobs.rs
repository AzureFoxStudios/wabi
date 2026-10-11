//! Owned publication of an existing Ready capture. This module never captures
//! new plaintext, changes a retry identity, or activates an Authority writer.
//! Startup/HTTP registration is a separate, default-off integration candidate.
#![cfg(target_os = "linux")]
use crate::{
    checkpoint_jobs::{HeldReadyCapture, ReadyCaptureGuard},
    config::ServerRole,
    instance_archive::source_context::valid_job_id,
    state::{ensure_authority_not_fenced, AppState},
};
use anyhow::{ensure, Context, Result};
use serde::Serialize;
use std::{
    collections::VecDeque,
    sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{sync::oneshot, task::JoinHandle};
use wabi_consensus::{
    runtime::{PublicationOperation, PublicationStage, RecoveryRuntime, RuntimePolicy},
    transport::CommittedCheckpointObservation,
};

const HISTORY: usize = 128;
const MAX_CAPTURE_BYTES: u64 = 64 * 1024 * 1024;

fn operation_id(capture: &str) -> Result<String> {
    ensure!(valid_job_id(capture), "invalid original capture UUID");
    let uuid = uuid::Uuid::parse_str(capture)?;
    let operation = uuid.simple().to_string();
    ensure!(uuid::Uuid::parse_str(&operation)?.to_string() == capture,
        "original capture identity differs");
    Ok(operation)
}
fn remaining(deadline: Instant) -> Result<Duration> {
    deadline.checked_duration_since(Instant::now())
        .filter(|value| !value.is_zero()).context("publication deadline elapsed")
}

#[derive(Debug, PartialEq, Eq)]
enum OriginalAction { Capture, Resume }
fn original_action(operation: &str, records: &[PublicationOperation]) -> Result<OriginalAction> {
    ensure!(records.len() <= HISTORY, "publication inventory exceeds budget");
    ensure!(uuid::Uuid::parse_str(operation)?.simple().to_string() == operation,
        "original operation is not canonical");
    let mut saved = records.iter().filter(|record| record.operation_id == operation);
    let first = saved.next();
    ensure!(saved.next().is_none(), "duplicate original publication operation");
    Ok(match first.map(|record| record.stage) {
        Some(PublicationStage::Manifest | PublicationStage::Prepared) => OriginalAction::Resume,
        Some(PublicationStage::Capture) | None => OriginalAction::Capture,
    })
}
fn historical_wire(receipt: CommittedCheckpointObservation, operation: &str) -> Result<serde_json::Value> {
    let wire = serde_json::to_value(receipt)?;
    ensure!(wire["operationId"] == operation
        && wire["metadataCommitted"] == true && wire["quorumAvailable"] == false
        && wire["fullInstanceReady"] == false && wire["canonicalWriterPermitted"] == false,
        "historical receipt differs");
    Ok(wire)
}

/// Journal IDs are the sole restart identities. No replacement UUID is
/// generated, and this conversion does not authorize a source or writer.
fn original_capture(operation: &str) -> Result<String> {
    let capture = uuid::Uuid::parse_str(operation)?.to_string();
    ensure!(operation_id(&capture)? == operation, "restart identity is not canonical");
    Ok(capture)
}

#[derive(Default)]
struct RestartState {
    authority: Option<std::sync::Weak<AppState>>,
    worker: Option<JoinHandle<Result<()>>>,
}

struct Supervision {
    handle: Option<JoinHandle<Result<()>>>,
    // Process-only result. Cancellation leaves the real handle in this owner.
    terminal: Option<std::result::Result<(), String>>,
}
impl Supervision {
    async fn drain(&mut self) -> Result<()> {
        if let Some(result) = &self.terminal {
            return result.clone().map_err(anyhow::Error::msg);
        }
        let waited = self.handle.as_mut().context("publication supervisor missing")?.await;
        self.handle.take();
        let result = match waited {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => Err(error.to_string()),
            Err(error) => Err(format!("publication supervisor failed: {error}")),
        };
        self.terminal = Some(result.clone());
        result.map_err(anyhow::Error::msg)
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PublicationPhase { Queued, Reconciling, Reading, Publishing, Checking, Historical, Failed }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublicationJob {
    capture_job_id: String,
    operation_id: String,
    phase: PublicationPhase,
    failure_code: Option<&'static str>,
    historical_receipt: Option<serde_json::Value>,
    full_instance_ready: bool,
    canonical_writer_permitted: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PublicationStatus {
    enabled: bool,
    accepting: bool,
    status_lifetime: &'static str,
    active_capture_id: Option<String>,
    jobs: Vec<PublicationJob>,
    full_instance_ready: bool,
    canonical_writer_permitted: bool,
}
#[derive(Debug, thiserror::Error)]
pub(crate) enum StartError {
    #[error("publication admission closed")] Closed,
    #[error("publication already owns a job")] Busy,
    #[error("publication source binding refused")] Refused,
    #[error("original publication admission is indeterminate; inspect the original job")] Indeterminate,
}
#[derive(Default)]
struct Jobs {
    active: Option<String>,
    history: VecDeque<PublicationJob>,
    worker: Option<JoinHandle<()>>,
}
struct Inner {
    community: String,
    source_node: String,
    collector_node: u64,
    restart: Mutex<RestartState>,
    budget: Duration,
    closed: AtomicBool,
    stop: Mutex<Option<oneshot::Sender<()>>>,
    jobs: Mutex<Jobs>,
    runtime: tokio::sync::Mutex<Option<RecoveryRuntime>>,
    // Retain handles IN the owner while awaiting by mutable reference. Panic
    // cannot drop a local handle and hide its still-running verification.
    initial_read: tokio::sync::Mutex<Option<JoinHandle<Result<HeldReadyCapture>>>>,
    final_read: tokio::sync::Mutex<Option<JoinHandle<Result<()>>>>,
    ready: Mutex<Option<ReadyCaptureGuard>>,
    // This deliberate transient cycle is cleared after actual drain. It pins
    // the Authority and its WabiDB lifetime even after a publication panic.
    authority: Mutex<Option<Arc<AppState>>>,
    // Cycle-free original Authority storage lease. Production startup always
    // supplies it; only a synthetic no-runtime supervision fixture uses None.
    // Supervisor owns Inner throughout actual runtime/read/guard drain.
    _authority_storage: Option<Arc<crate::adapter::WdbAdapter>>,
}
impl Inner {
    fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        if let Some(stop) = self.stop.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = stop.send(());
        }
    }
    fn phase(&self, id: &str, phase: PublicationPhase) {
        let mut jobs = self.jobs.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(job) = jobs.history.iter_mut().find(|job| job.capture_job_id == id) {
            job.phase = phase;
        }
    }
}
struct JobGuard { inner: Arc<Inner>, completed: bool }
impl Drop for JobGuard {
    fn drop(&mut self) {
        if !self.completed { self.inner.close(); }
    }
}
pub(crate) struct PublicationJobs {
    inner: Arc<Inner>,
    supervisor: tokio::sync::Mutex<Supervision>,
}
impl Drop for PublicationJobs {
    fn drop(&mut self) { self.inner.close(); }
}
impl PublicationJobs {
    /// Trusted startup policy loaded through the existing private operator
    /// loader. Call only after checking configured source support and the
    /// actual Authority community/source identity. No request accepts policy.
    pub(crate) async fn open(
        policy: RuntimePolicy, community: String, source_node: String,
        authority_storage: Arc<crate::adapter::WdbAdapter>,
    ) -> Result<Self> {
        ensure!(policy.binding.community_id == community && policy.source_node_id == source_node,
            "publication startup binding differs");
        let collector_node = policy.binding.node_id;
        let budget = policy.work_timeout.checked_mul(3).context("invalid publication budget")?;
        ensure!(!budget.is_zero() && budget <= Duration::from_secs(90),
            "invalid publication budget");
        // An unobserved successful owner drops and requests supervised drain.
        tokio::spawn(async move {
            let (stop, stopped) = oneshot::channel();
            let inner = Arc::new(Inner {
                community, source_node, collector_node, restart: Mutex::new(RestartState::default()),
                budget, closed: AtomicBool::new(false),
                stop: Mutex::new(Some(stop)), jobs: Mutex::new(Jobs::default()),
                runtime: tokio::sync::Mutex::new(None),
                initial_read: tokio::sync::Mutex::new(None),
                final_read: tokio::sync::Mutex::new(None), ready: Mutex::new(None),
                authority: Mutex::new(None),
                _authority_storage: Some(authority_storage),
            });
            // Transfer original storage ownership before any runtime startup.
            // Ordinary startup errors await the actual runtime startup result.
            let runtime = RecoveryRuntime::start(policy).await?;
            *inner.runtime.lock().await = Some(runtime);
            let owner = inner.clone();
            let supervisor = tokio::spawn(async move { supervise(owner, stopped).await });
            Ok::<_, anyhow::Error>(Self { inner, supervisor: tokio::sync::Mutex::new(
                Supervision { handle: Some(supervisor), terminal: None }) })
        }).await.context("publication startup worker failed")?
    }
    /// Attach exactly once after the actual Authority has an Arc owner.
    /// Idle scheduling keeps only weak Authority/publisher references. The
    /// existing supervisor owns and joins the actual restart worker.
    pub(crate) fn attach(self: &Arc<Self>, state: &Arc<AppState>) {
        if !state.recovery_publication.as_ref().is_some_and(|owner| Arc::ptr_eq(owner, self)) {
            self.inner.close();
            tracing::error!("recovery restart attachment has a different publisher owner");
            return;
        }
        let authority = Arc::downgrade(state);
        let mut restart = self.inner.restart.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(original) = &restart.authority {
            if !std::sync::Weak::ptr_eq(original, &authority) {
                self.inner.close();
                tracing::error!("recovery restart attachment has a different Authority owner");
            }
            return;
        }
        if self.inner.closed.load(Ordering::SeqCst) { return; }
        restart.authority = Some(authority.clone());
        restart.worker = Some(tokio::spawn(reconcile_pending(Arc::downgrade(self), authority)));
    }
    pub(crate) fn status(&self) -> PublicationStatus {
        let jobs = self.inner.jobs.lock().unwrap_or_else(|e| e.into_inner());
        PublicationStatus {
            enabled: true, accepting: !self.inner.closed.load(Ordering::SeqCst),
            status_lifetime: "current_process", active_capture_id: jobs.active.clone(),
            jobs: jobs.history.iter().cloned().collect(),
            full_instance_ready: false, canonical_writer_permitted: false,
        }
    }
    /// Caller must enforce operator loopback+secret admission before this
    /// trusted method. It supplies ONLY the original canonical Ready UUID.
    pub(crate) async fn start(&self, capture: String, state: Arc<AppState>)
        -> std::result::Result<PublicationJob, StartError>
    {
        let operation = operation_id(&capture).map_err(|_| StartError::Refused)?;
        if state.config.server_role != ServerRole::Authority
            || state.community_roster.community_id() != self.inner.community
            || state.config.node_id != self.inner.source_node
            || !state.checkpoint_jobs.source_publication_enabled()
        { return Err(StartError::Refused); }
        let deadline = Instant::now().checked_add(self.inner.budget).ok_or(StartError::Refused)?;
        let (admitted, admission) = oneshot::channel();
        let job;
        {
        let mut jobs = self.inner.jobs.lock().unwrap_or_else(|e| e.into_inner());
        if self.inner.closed.load(Ordering::SeqCst) { return Err(StartError::Closed); }
        if jobs.worker.as_ref().is_some_and(|worker| !worker.is_finished())
            || jobs.active.is_some() { return Err(StartError::Busy); }
        job = PublicationJob {
            capture_job_id: capture.clone(), operation_id: operation.clone(),
            phase: PublicationPhase::Queued, failure_code: None, historical_receipt: None,
            full_instance_ready: false, canonical_writer_permitted: false,
        };
        jobs.history.retain(|old| old.capture_job_id != capture);
        if jobs.history.len() == HISTORY { jobs.history.pop_front(); }
        jobs.history.push_back(job.clone());
        jobs.active = Some(capture.clone());
        *self.inner.authority.lock().unwrap_or_else(|e| e.into_inner()) = Some(state.clone());
        let inner = self.inner.clone();
        let operations = state.instance_operations.clone();
        jobs.worker = Some(operations.spawn(async move {
            let mut guard = JobGuard { inner: inner.clone(), completed: false };
            let result = publish(inner.clone(), state, &capture, operation, deadline, admitted).await;
            let mut jobs = inner.jobs.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(job) = jobs.history.iter_mut().find(|job| job.capture_job_id == capture) {
                match result {
                    Ok(receipt) => { job.phase = PublicationPhase::Historical; job.historical_receipt = Some(receipt); }
                    Err(_) => { job.phase = PublicationPhase::Failed; job.failure_code = Some("publication_indeterminate"); }
                }
            }
            jobs.active = None;
            if inner.closed.load(Ordering::SeqCst) {
                // Supervisor retains every remaining handle/guard/Authority
                // until runtime and blocking owners have actually drained.
            } else {
                inner.authority.lock().unwrap_or_else(|e| e.into_inner()).take();
            }
            guard.completed = true;
        }));
        }
        // Cancellation drops only this waiter. The supervisor retains the
        // actual worker, Authority and source admission through journal IO.
        // The original deadline bounds the HTTP waiter even while actual
        // admission is queued behind a pause. Refusal never aborts or drops
        // the supervisor's queued/IO owner or invents a replacement UUID.
        let acknowledged = tokio::time::timeout_at(deadline.into(), admission).await;
        if self.inner.closed.load(Ordering::SeqCst)
            || !matches!(acknowledged, Ok(Ok(()))) || remaining(deadline).is_err() {
            self.inner.close();
            return Err(StartError::Indeterminate);
        }
        Ok(job)
    }
    pub(crate) async fn shutdown(&self) -> Result<()> {
        self.inner.close();
        self.supervisor.lock().await.drain().await
    }
}

async fn actual_authority(state: &AppState, inner: &Inner) -> Result<()> {
    ensure!(state.config.server_role == ServerRole::Authority
        && state.community_roster.community_id() == inner.community
        && state.config.node_id == inner.source_node
        && state.instance_operations.healthy_for_checkpoint(), "Authority publication admission refused");
    ensure_authority_not_fenced(&state.config.data_dir)?;
    ensure!(!state.wdb.engine().local_writer_fenced().await, "Authority became fenced");
    Ok(())
}
async fn publish(inner: Arc<Inner>, state: Arc<AppState>, capture: &str,
    operation: String, deadline: Instant, admitted: oneshot::Sender<()>) -> Result<serde_json::Value>
{
    let result = publish_inner(inner.clone(), state, capture, operation, deadline, admitted).await;
    // Every error is treated as potentially indeterminate. Close publication
    // admission and drain actual runtime owners before releasing source guards.
    if result.is_err() { inner.close(); }
    result
}
async fn publish_inner(inner: Arc<Inner>, state: Arc<AppState>, capture: &str,
    operation: String, deadline: Instant, admitted: oneshot::Sender<()>) -> Result<serde_json::Value>
{
    remaining(deadline)?;
    actual_authority(&state, &inner).await?;
    remaining(deadline)?;
    inner.phase(capture, PublicationPhase::Reconciling);
    let mut runtime = inner.runtime.lock().await;
    let node = runtime.as_mut().context("publication runtime drained")?;
    let records = node.publication_operations().await;
    while node.local_job_active() { tokio::time::sleep(Duration::from_millis(1)).await; }
    remaining(deadline)?;
    actual_authority(&state, &inner).await?;
    remaining(deadline)?;
    if original_action(&operation, &records?)? == OriginalAction::Resume {
        // The private manifest/prepared journal owns original signed context,
        // actual retained bytes and exact command. Do not reacquire, replace
        // or re-encrypt an archive, nor invent another retry identity.
        // Inventory has verified the durable original manifest/prepared
        // journal. Acknowledge that original intent, never a writer grant.
        // A missing waiter must not cancel the owned reconciliation.
        let confirmed = node.confirm_publication_intent(operation.clone()).await;
        while node.local_job_active() { tokio::time::sleep(Duration::from_millis(1)).await; }
        confirmed?;
        remaining(deadline)?;
        actual_authority(&state, &inner).await?;
        remaining(deadline)?;
        ensure!(node.status().accepting, "publication runtime admission closed");
        let _ = admitted.send(());
        let result = node.resume_publication(operation.clone()).await;
        while node.local_job_active() { tokio::time::sleep(Duration::from_millis(1)).await; }
        remaining(deadline)?;
        let receipt = result?;
        drop(runtime);
        actual_authority(&state, &inner).await?;
        remaining(deadline)?;
        return historical_wire(receipt, &operation);
    }
    // No durable manifest: obtain only the original private Ready capture.
    // Capture intent conflicts are checked by the unchanged runtime journal.
    drop(runtime);
    inner.phase(capture, PublicationPhase::Reading);
    let reader_state = state.clone();
    let id = capture.to_string();
    let timeout = remaining(deadline)?.min(Duration::from_secs(30));
    let mut read = inner.initial_read.lock().await;
    ensure!(read.is_none(), "original source-read handle already owned");
    *read = Some(state.instance_operations.spawn(async move {
        reader_state.checkpoint_jobs.held_ready_capture(id,
            reader_state.community_roster.community_id().into(), reader_state.config.node_id.clone(),
            MAX_CAPTURE_BYTES, timeout).await
    }));
    let value = read.as_mut().context("source-read handle missing")?.await;
    read.take(); drop(read);
    // The handle is terminal before any refusal drops an observed source guard.
    let held = value.context("source-read worker failed")??;
    *inner.ready.lock().unwrap_or_else(|e| e.into_inner()) = Some(held.guard);
    remaining(deadline)?;
    actual_authority(&state, &inner).await?;
    remaining(deadline)?;
    inner.phase(capture, PublicationPhase::Publishing);
    let mut runtime = inner.runtime.lock().await;
    let node = runtime.as_mut().context("publication runtime drained")?;
    // Keep the actual File, Ready guard, permit and Authority in this owned
    // worker while the unchanged journal synchronizes file and directory.
    // The IO result proves the journal call completed; overall runtime
    // terminal ownership still belongs to its retained supervisor handles.
    let intent = node.record_capture_intent(operation.clone(), held.context.clone()).await;
    while node.local_job_active() { tokio::time::sleep(Duration::from_millis(1)).await; }
    intent?;
    remaining(deadline)?;
    actual_authority(&state, &inner).await?;
    remaining(deadline)?;
    ensure!(node.status().accepting, "publication runtime admission closed");
    let _ = admitted.send(());
    let value = node.publish_capture_file(operation.clone(), held.file, held.context).await;
    // Await actual local worker completion, including after deadline. Never
    // convert timeout or a sent response into proof that IO has stopped.
    while node.local_job_active() { tokio::time::sleep(Duration::from_millis(1)).await; }
    remaining(deadline)?;
    let receipt = value?;
    drop(runtime);
    inner.phase(capture, PublicationPhase::Checking);
    let guard = inner.ready.lock().unwrap_or_else(|e| e.into_inner()).take()
        .context("original Ready guard missing")?;
    let owner_state = state.clone();
    let mut final_read = inner.final_read.lock().await;
    ensure!(final_read.is_none(), "final source-read handle already owned");
    *final_read = Some(state.instance_operations.spawn(async move {
        let checked = tokio::task::spawn_blocking(move || {
            // Keep the actual Authority, source guard and permit in this
            // blocking owner, even if its async waiter fails or disappears.
            let _authority = owner_state;
            let pre = remaining(deadline);
            let result = guard.verify();
            remaining(deadline)?;
            pre?;
            result
        }).await.context("final source-read worker failed")?;
        checked
    }));
    let value = final_read.as_mut().context("final source-read handle missing")?.await;
    final_read.take(); drop(final_read);
    remaining(deadline)?;
    actual_authority(&state, &inner).await?;
    remaining(deadline)?;
    value.context("final source-read task failed")??;
    historical_wire(receipt, &operation)
}

/// One serial owned scheduler for original local intents. Preflight waiting
/// and Busy use capped polling; every ambiguous IO/publication failure closes
/// admission and requires original-operation inspection. It never activates
/// another Authority, substitutes a collector or silently creates a new ID.
async fn reconcile_pending(publisher: std::sync::Weak<PublicationJobs>,
    authority: std::sync::Weak<AppState>) -> Result<()>
{
    let mut delay = Duration::from_millis(250);
    loop {
        let Some(owner) = publisher.upgrade() else { return Ok(()); };
        if owner.inner.closed.load(Ordering::SeqCst) || authority.strong_count() == 0 {
            return Ok(());
        }
        let busy = {
            let jobs = owner.inner.jobs.lock().unwrap_or_else(|e| e.into_inner());
            jobs.active.is_some() || jobs.worker.as_ref().is_some_and(|worker| !worker.is_finished())
        };
        if !busy {
            let next = async {
                let runtime = owner.inner.runtime.lock().await;
                let node = runtime.as_ref().ok_or(wabi_consensus::runtime::RuntimeError::Closed)?;
                let view = node.status();
                if owner.inner.closed.load(Ordering::SeqCst) {
                    return Err(wabi_consensus::runtime::RuntimeError::Closed);
                }
                if !view.accepting {
                    return Err(wabi_consensus::runtime::RuntimeError::Closed);
                }
                if !view.membership_ready || view.leader_node_id != Some(owner.inner.collector_node) {
                    return Ok(None);
                }
                let result = node.pending_publication_operations().await;
                // This diagnostic alone is not overall runtime terminal proof.
                // The original supervisor retains the runtime and drains it.
                while node.local_job_active() { tokio::time::sleep(Duration::from_millis(1)).await; }
                result.map(|records| records.into_iter().next().map(|record| record.operation_id))
            }.await;
            match next {
                Ok(Some(operation)) => {
                    let capture = match original_capture(&operation) {
                        Ok(capture) => capture,
                        Err(error) => { owner.inner.close(); return Err(error); }
                    };
                    let Some(state) = authority.upgrade() else { return Ok(()); };
                    match owner.start(capture, state).await {
                        Ok(_) => delay = Duration::from_millis(250),
                        Err(StartError::Busy) => delay = (delay * 2).min(Duration::from_secs(2)),
                        Err(StartError::Closed) => return Ok(()),
                        Err(error) => {
                            owner.inner.close();
                            return Err(anyhow::Error::new(error));
                        }
                    }
                }
                Ok(None) => delay = (delay * 2).min(Duration::from_secs(2)),
                Err(wabi_consensus::runtime::RuntimeError::Busy) => {
                    delay = (delay * 2).min(Duration::from_secs(2));
                }
                Err(wabi_consensus::runtime::RuntimeError::Closed)
                    if owner.inner.closed.load(Ordering::SeqCst) => return Ok(()),
                Err(error) => { owner.inner.close(); return Err(anyhow::Error::new(error)); }
            }
        }
        // No strong Authority or publisher reference survives this idle wait.
        drop(owner);
        tokio::time::sleep(delay).await;
    }
}

async fn supervise(inner: Arc<Inner>, mut stopped: oneshot::Receiver<()>) -> Result<()> {
    loop {
        tokio::select! {
            _ = &mut stopped => break,
            _ = tokio::time::sleep(Duration::from_millis(100)) => {
                if inner.restart.lock().unwrap_or_else(|e| e.into_inner()).worker
                    .as_ref().is_some_and(|worker| worker.is_finished()) { break; }
                if let Ok(runtime) = inner.runtime.try_lock() {
                    if runtime.as_ref().is_none_or(|node| !node.status().accepting) { break; }
                }
            }
        }
    }
    inner.closed.store(true, Ordering::SeqCst);
    let restart = inner.restart.lock().unwrap_or_else(|e| e.into_inner()).worker.take();
    let mut failed = false;
    if let Some(restart) = restart { failed |= !matches!(restart.await, Ok(Ok(()))); }
    let worker = inner.jobs.lock().unwrap_or_else(|e| e.into_inner()).worker.take();
    if let Some(worker) = worker { failed |= worker.await.is_err(); }
    // Source reader is independently tracked. A publisher panic cannot turn
    // its still-running blocking IO into a completed shutdown.
    if let Some(reader) = inner.initial_read.lock().await.take() {
        match reader.await {
            Ok(Ok(held)) => {
                *inner.ready.lock().unwrap_or_else(|e| e.into_inner()) = Some(held.guard);
            }
            _ => failed = true,
        }
    }
    // Drain actual Raft/store/local blocking owners BEFORE leftover source
    // guard/permit release on every refusal, timeout and fatal path.
    if let Some(node) = inner.runtime.lock().await.take() {
        failed |= node.shutdown().await.is_err();
    }
    if let Some(reader) = inner.final_read.lock().await.take() {
        failed |= !matches!(reader.await, Ok(Ok(())));
    }
    let ready = inner.ready.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(ready) = ready {
        failed |= !matches!(tokio::task::spawn_blocking(move || ready.verify()).await, Ok(Ok(())));
    }
    inner.authority.lock().unwrap_or_else(|e| e.into_inner()).take();
    ensure!(!failed, "publication owned drain failed");
    Ok(())
}

#[cfg(test)]
mod tests;
