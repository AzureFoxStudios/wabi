//! Explicitly configured control/material node lifecycle. This owns real
//! stores, Raft and the authenticated listener; it never opens WabiDB or an
//! Authority. Server publication journals and activation remain separate.
use crate::{
    material::{CheckpointManifest, ChunkingLimits, MaterialLimits, MaterialStore},
    model::{ControlState, RecoveryPeer, StoreBinding},
    source_context::SignedSourceContext,
    store::{Store, StoreLimits},
    transport::{
        self, CheckpointAvailabilityRound, CommittedCheckpointObservation, Config, Identity,
        Limits, MaterialService, Network, ServerReport,
    },
    ConsensusTypes,
};
use fs4::fs_std::FileExt;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    future::Future,
    io::{Read, Write},
    net::SocketAddr,
    os::{
        fd::AsRawFd,
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tokio::{net::TcpListener, sync::oneshot, task::JoinHandle};

const NOFOLLOW: i32 = 0o400000;
const DIRECTORY: i32 = 0o200000;
const ENROLLMENT: &str = "runtime.enrollment.json";
const OWNER_LOCK: &str = ".runtime.lock";
const MAX_ENROLLMENT_BYTES: u64 = 32 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum RuntimeError {
    #[error("recovery runtime configuration refused")]
    Configuration,
    #[error("recovery runtime ownership refused")]
    Ownership,
    #[error("recovery runtime unavailable")]
    Unavailable,
    #[error("recovery runtime already owns a job")]
    Busy,
    #[error("recovery runtime admission closed")]
    Closed,
    #[error("recovery runtime job refused; inspect the original operation")]
    Refused,
    #[error("recovery runtime deadline elapsed; inspect the original operation")]
    Deadline,
}
pub type Result<T> = std::result::Result<T, RuntimeError>;

enum CaptureInput {
    Path(PathBuf),
    File(File),
}

/// Trusted operator input, not a network payload. Roots must already exist;
/// identity generation, enrollment changes and existing-store migration are
/// deliberately not implicit. Initialize only once, on the lowest roster ID.
#[derive(Clone)]
pub struct RuntimePolicy {
    pub binding: StoreBinding,
    pub peers: BTreeMap<u64, RecoveryPeer>,
    pub source_node_id: String,
    pub identity_directory: PathBuf,
    pub control_directory: PathBuf,
    pub material_directory: PathBuf,
    pub bind_address: Option<SocketAddr>,
    pub initialize: bool,
    pub control_limits: StoreLimits,
    pub material_limits: MaterialLimits,
    pub transport_limits: Limits,
    pub work_timeout: Duration,
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Enrollment {
    schema_version: u8,
    binding: StoreBinding,
    peers: BTreeMap<u64, RecoveryPeer>,
    source_node_id: String,
    identity_directory: PathBuf,
    material_directory: PathBuf,
    bind_address: SocketAddr,
}

struct Root {
    path: PathBuf,
    directory: File,
}
impl Root {
    fn open(path: &Path) -> Result<Self> {
        if !path.is_absolute()
            || path
                .components()
                .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
        {
            return Err(RuntimeError::Ownership);
        }
        for ancestor in path.ancestors() {
            if fs::symlink_metadata(ancestor)
                .map_err(|_| RuntimeError::Ownership)?
                .file_type()
                .is_symlink()
            {
                return Err(RuntimeError::Ownership);
            }
        }
        let directory = OpenOptions::new()
            .read(true)
            .custom_flags(NOFOLLOW | DIRECTORY)
            .open(path)
            .map_err(|_| RuntimeError::Ownership)?;
        let root = Self {
            path: path.to_path_buf(),
            directory,
        };
        root.verify()?;
        Ok(root)
    }
    fn relative(&self, name: &str) -> PathBuf {
        PathBuf::from(format!("/proc/self/fd/{}", self.directory.as_raw_fd())).join(name)
    }
    fn verify(&self) -> Result<()> {
        let held = self
            .directory
            .metadata()
            .map_err(|_| RuntimeError::Ownership)?;
        let named = fs::symlink_metadata(&self.path).map_err(|_| RuntimeError::Ownership)?;
        let uid = fs::metadata("/proc/self")
            .map_err(|_| RuntimeError::Ownership)?
            .uid();
        if !named.is_dir()
            || named.file_type().is_symlink()
            || named.mode() & 0o077 != 0
            || named.uid() != uid
            || (held.dev(), held.ino()) != (named.dev(), named.ino())
        {
            return Err(RuntimeError::Ownership);
        }
        Ok(())
    }
    fn check_file(&self, name: &str, held: &File) -> Result<()> {
        self.verify()?;
        let named =
            fs::symlink_metadata(self.relative(name)).map_err(|_| RuntimeError::Ownership)?;
        let opened = held.metadata().map_err(|_| RuntimeError::Ownership)?;
        if !named.is_file()
            || named.file_type().is_symlink()
            || named.nlink() != 1
            || named.mode() & 0o077 != 0
            || named.uid()
                != self
                    .directory
                    .metadata()
                    .map_err(|_| RuntimeError::Ownership)?
                    .uid()
            || (named.dev(), named.ino()) != (opened.dev(), opened.ino())
        {
            return Err(RuntimeError::Ownership);
        }
        Ok(())
    }
    fn lock(&self) -> Result<File> {
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(NOFOLLOW)
            .open(self.relative(OWNER_LOCK))
            .map_err(|_| RuntimeError::Ownership)?;
        self.check_file(OWNER_LOCK, &lock)?;
        if !lock
            .try_lock_exclusive()
            .map_err(|_| RuntimeError::Ownership)?
        {
            return Err(RuntimeError::Ownership);
        }
        self.directory
            .sync_all()
            .map_err(|_| RuntimeError::Unavailable)?;
        Ok(lock)
    }
    fn enroll(&self, expected: &Enrollment, material: &Root) -> Result<()> {
        let bytes = serde_json::to_vec(expected).map_err(|_| RuntimeError::Configuration)?;
        if bytes.len() > MAX_ENROLLMENT_BYTES as usize {
            return Err(RuntimeError::Configuration);
        }
        self.verify()?;
        let existing = OpenOptions::new()
            .read(true)
            .custom_flags(NOFOLLOW)
            .open(self.relative(ENROLLMENT));
        match existing {
            Ok(file) => {
                self.check_file(ENROLLMENT, &file)?;
                if file.metadata().map_err(|_| RuntimeError::Ownership)?.len()
                    > MAX_ENROLLMENT_BYTES
                {
                    return Err(RuntimeError::Configuration);
                }
                let mut saved = Vec::new();
                file.take(MAX_ENROLLMENT_BYTES + 1)
                    .read_to_end(&mut saved)
                    .map_err(|_| RuntimeError::Unavailable)?;
                // Exact serialization also rejects duplicate keys/noncanonical
                // rosters without silently normalizing operator-private input.
                let record: Enrollment =
                    serde_json::from_slice(&saved).map_err(|_| RuntimeError::Configuration)?;
                if record != *expected || saved != bytes {
                    return Err(RuntimeError::Configuration);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // No implicit adoption of earlier fixture/production stores.
                for entry in fs::read_dir(self.relative("")).map_err(|_| RuntimeError::Ownership)? {
                    if entry.map_err(|_| RuntimeError::Ownership)?.file_name() != OWNER_LOCK {
                        return Err(RuntimeError::Configuration);
                    }
                }
                if fs::read_dir(material.relative(""))
                    .map_err(|_| RuntimeError::Ownership)?
                    .next()
                    .is_some()
                {
                    return Err(RuntimeError::Configuration);
                }
                let mut file = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .custom_flags(NOFOLLOW)
                    .open(self.relative(ENROLLMENT))
                    .map_err(|_| RuntimeError::Ownership)?;
                // A crash/failed write can leave a partial record. Restart
                // refuses it; it never regenerates a different enrollment.
                file.write_all(&bytes)
                    .and_then(|_| file.sync_all())
                    .map_err(|_| RuntimeError::Unavailable)?;
                self.check_file(ENROLLMENT, &file)?;
                self.directory
                    .sync_all()
                    .map_err(|_| RuntimeError::Unavailable)?;
            }
            Err(_) => return Err(RuntimeError::Ownership),
        }
        self.verify()?;
        material.verify()
    }
}

struct Opened {
    control: Store,
    material: MaterialStore,
    config: Arc<Config>,
    source_node: String,
    peers: BTreeMap<u64, RecoveryPeer>,
    lease: Arc<RuntimeLease>,
}
// No Store or runtime handle is held by the lease, preventing a cycle.
struct RuntimeLease {
    roots: [Root; 3],
    owner: File,
}
impl RuntimeLease {
    fn verify(&self) -> Result<()> {
        for root in &self.roots {
            root.verify()?;
        }
        self.roots[0].check_file(OWNER_LOCK, &self.owner)
    }
}
impl Opened {
    fn open(policy: &RuntimePolicy) -> Result<Self> {
        if !crate::model::identifier_valid(&policy.source_node_id)
            || policy.work_timeout.is_zero()
            || policy.work_timeout > Duration::from_secs(30)
            || (policy.initialize
                && policy.peers.keys().next().copied() != Some(policy.binding.node_id))
        {
            return Err(RuntimeError::Configuration);
        }
        let roots = [
            Root::open(&policy.control_directory)?,
            Root::open(&policy.material_directory)?,
            Root::open(&policy.identity_directory)?,
        ];
        for a in 0..3 {
            for b in a + 1..3 {
                let left = roots[a]
                    .directory
                    .metadata()
                    .map_err(|_| RuntimeError::Ownership)?;
                let right = roots[b]
                    .directory
                    .metadata()
                    .map_err(|_| RuntimeError::Ownership)?;
                if roots[a].path.starts_with(&roots[b].path)
                    || roots[b].path.starts_with(&roots[a].path)
                    || (left.dev(), left.ino()) == (right.dev(), right.ino())
                {
                    return Err(RuntimeError::Ownership);
                }
            }
        }
        let identity = Identity::load(&roots[2].path).map_err(|_| RuntimeError::Configuration)?;
        roots[2].verify()?;
        let mut config = Config::new(
            policy.binding.clone(),
            policy.peers.clone(),
            Arc::new(identity),
            policy.transport_limits.clone(),
        )
        .map_err(|_| RuntimeError::Configuration)?;
        if let Some(address) = policy.bind_address {
            config = config
                .with_bind_address(address)
                .map_err(|_| RuntimeError::Configuration)?;
        }
        let owner = roots[0].lock()?;
        roots[0].enroll(
            &Enrollment {
                schema_version: 1,
                binding: policy.binding.clone(),
                peers: policy.peers.clone(),
                source_node_id: policy.source_node_id.clone(),
                identity_directory: roots[2].path.clone(),
                material_directory: roots[1].path.clone(),
                bind_address: config.local_address(),
            },
            &roots[1],
        )?;
        // Existing advisory lock files are checked, never chmodded/unlinked.
        for root in &roots[..2] {
            match OpenOptions::new()
                .read(true)
                .custom_flags(NOFOLLOW)
                .open(root.relative(".lock"))
            {
                Ok(file) => root.check_file(".lock", &file)?,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                Err(_) => return Err(RuntimeError::Ownership),
            }
        }
        let lease = Arc::new(RuntimeLease { roots, owner });
        let control = Store::open(
            &lease.roots[0].path,
            policy.binding.clone(),
            policy.control_limits.clone(),
        )
        .map_err(|_| RuntimeError::Unavailable)?
        .with_runtime_owner(lease.clone())
        .map_err(|_| RuntimeError::Ownership)?;
        let material = MaterialStore::open(
            &lease.roots[1].path,
            policy.binding.clone(),
            policy.material_limits.clone(),
        )
        .map_err(|_| RuntimeError::Unavailable)?;
        let result = Self {
            control,
            material,
            config: Arc::new(config),
            source_node: policy.source_node_id.clone(),
            peers: policy.peers.clone(),
            lease,
        };
        result.verify()?;
        Ok(result)
    }
    fn verify(&self) -> Result<()> {
        self.lease.verify()
    }
}

fn membership_matches(state: &crate::Membership, peers: &BTreeMap<u64, RecoveryPeer>) -> bool {
    let membership = state.membership();
    membership.get_joint_config().len() == 1
        && membership.voter_ids().collect::<Vec<_>>() == peers.keys().copied().collect::<Vec<_>>()
        && membership.nodes().collect::<BTreeMap<_, _>>()
            == peers.iter().collect::<BTreeMap<_, _>>()
}
fn pristine(state: &ControlState) -> bool {
    state.last_applied.is_none()
        && state.membership == crate::Membership::default()
        && state.intents.is_empty()
        && state.operations.is_empty()
        && state.checkpoints.is_empty()
}
fn raft_options() -> Result<Arc<openraft::Config>> {
    let options = openraft::Config {
        cluster_name: "wabi-recovery-control".into(),
        heartbeat_interval: 250,
        election_timeout_min: 1000,
        election_timeout_max: 2000,
        max_payload_entries: 64,
        snapshot_max_chunk_size: 64 * 1024,
        install_snapshot_timeout: 10_000,
        send_snapshot_timeout: 10_000,
        ..Default::default()
    }
    .validate()
    .map_err(|_| RuntimeError::Configuration)?;
    Ok(Arc::new(options))
}

struct Inner {
    raft: openraft::Raft<ConsensusTypes>,
    service: MaterialService,
    closed: AtomicBool,
    worker: Mutex<Option<JoinHandle<()>>>,
    stop: Mutex<Option<oneshot::Sender<()>>>,
    timeout: Duration,
    // Drop stores and the runtime owner lock only after Raft/service handles.
    opened: Opened,
}
impl Inner {
    fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        if let Some(stop) = self.stop.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = stop.send(());
        }
    }
}
struct JobGuard {
    inner: Arc<Inner>,
    completed: bool,
}
impl Drop for JobGuard {
    fn drop(&mut self) {
        if !self.completed {
            self.inner.close();
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub accepting: bool,
    pub membership_ready: bool,
    pub leader_node_id: Option<u64>,
    pub full_instance_ready: bool,
    pub canonical_writer_permitted: bool,
}

/// One owner. Dropping it requests shutdown; explicit shutdown awaits actual
/// listener, worker and Raft completion. The supervisor retains every lock
/// until that drain finishes. Blocking IO is owned, not forcibly interruptible.
pub struct RecoveryRuntime {
    inner: Arc<Inner>,
    supervisor: Option<JoinHandle<Result<ServerReport>>>,
}
impl Drop for RecoveryRuntime {
    fn drop(&mut self) {
        self.inner.close();
    }
}
impl RecoveryRuntime {
    pub async fn start(policy: RuntimePolicy) -> Result<Self> {
        // Cancellation of the caller cannot strand a partially started actor.
        // An unobserved successful result drops its owner and requests drain.
        tokio::spawn(Self::start_owned(policy))
            .await
            .map_err(|_| RuntimeError::Unavailable)?
    }
    async fn start_owned(policy: RuntimePolicy) -> Result<Self> {
        let deadline = Instant::now()
            .checked_add(policy.work_timeout)
            .ok_or(RuntimeError::Configuration)?;
        let opening_policy = policy.clone();
        let opened = tokio::task::spawn_blocking(move || Opened::open(&opening_policy))
            .await
            .map_err(|_| RuntimeError::Unavailable)??;
        if Instant::now() >= deadline {
            return Err(RuntimeError::Deadline);
        }
        let state = opened
            .control
            .control_state()
            .await
            .map_err(|_| RuntimeError::Unavailable)?;
        if (!pristine(&state) && !membership_matches(&state.membership, &opened.peers))
            || (policy.initialize && !pristine(&state))
        {
            return Err(RuntimeError::Configuration);
        }
        let options = raft_options()?;
        let network = Network::new(opened.config.clone(), &options)
            .map_err(|_| RuntimeError::Configuration)?;
        let service = MaterialService::new(
            opened.material.clone(),
            &opened.config,
            opened.source_node.clone(),
            1,
        )
        .map_err(|_| RuntimeError::Configuration)?;
        let listener = TcpListener::bind(opened.config.local_address())
            .await
            .map_err(|_| RuntimeError::Unavailable)?;
        let raft = openraft::Raft::new(
            opened.config.node_id(),
            options,
            network,
            opened.control.clone(),
            opened.control.clone(),
        )
        .await
        .map_err(|_| RuntimeError::Unavailable)?;
        let (stop, stopped) = oneshot::channel();
        let inner = Arc::new(Inner {
            opened,
            raft,
            service,
            closed: AtomicBool::new(false),
            worker: Mutex::new(None),
            stop: Mutex::new(Some(stop)),
            timeout: policy.work_timeout,
        });
        let task_inner = inner.clone();
        let supervisor =
            tokio::spawn(async move { supervise(task_inner, listener, stopped).await });
        let runtime = Self {
            inner,
            supervisor: Some(supervisor),
        };
        if Instant::now() >= deadline {
            runtime.shutdown().await?;
            return Err(RuntimeError::Deadline);
        }
        if policy.initialize {
            let initialized = tokio::time::timeout_at(
                deadline.into(),
                runtime.inner.raft.initialize(policy.peers),
            )
            .await;
            if !matches!(initialized, Ok(Ok(()))) {
                runtime.shutdown().await?;
                return Err(RuntimeError::Refused);
            }
        }
        Ok(runtime)
    }
    pub fn status(&self) -> RuntimeStatus {
        let metrics = self.inner.raft.metrics();
        let metrics = metrics.borrow();
        RuntimeStatus {
            accepting: !self.inner.closed.load(Ordering::SeqCst),
            membership_ready: membership_matches(
                &metrics.membership_config,
                &self.inner.opened.peers,
            ),
            leader_node_id: metrics.current_leader,
            full_instance_ready: false,
            canonical_writer_permitted: false,
        }
    }
    pub async fn control_state(&self) -> Result<ControlState> {
        if self.inner.closed.load(Ordering::SeqCst) {
            return Err(RuntimeError::Closed);
        }
        if let Err(error) = self.inner.opened.verify() {
            self.inner.close();
            return Err(error);
        }
        self.inner
            .opened
            .control
            .control_state()
            .await
            .map_err(|_| RuntimeError::Unavailable)
    }
    async fn run_job<T, F>(&self, work: F) -> Result<T>
    where
        T: Send + 'static,
        F: Future<Output = Result<T>> + Send + 'static,
    {
        let (sender, receiver) = oneshot::channel();
        {
            let mut worker = self.inner.worker.lock().unwrap_or_else(|e| e.into_inner());
            if self.inner.closed.load(Ordering::SeqCst) {
                return Err(RuntimeError::Closed);
            }
            if worker.as_ref().is_some_and(|worker| !worker.is_finished()) {
                return Err(RuntimeError::Busy);
            }
            let mut guard = JobGuard {
                inner: self.inner.clone(),
                completed: false,
            };
            *worker = Some(tokio::spawn(async move {
                let result = work.await;
                if matches!(
                    result,
                    Err(RuntimeError::Closed | RuntimeError::Ownership | RuntimeError::Unavailable)
                ) {
                    guard.inner.close();
                }
                guard.completed = true;
                let _ = sender.send(result);
            }));
        }
        receiver.await.map_err(|_| RuntimeError::Closed)?
    }
    /// Locally provisioned signed capture, under owned blocking admission.
    /// Storage peers receive ciphertext only; no recipient identity is needed.
    pub async fn ingest_capture(
        &self,
        path: PathBuf,
        context: SignedSourceContext,
    ) -> Result<CheckpointManifest> {
        self.ingest_capture_input(CaptureInput::Path(path), context)
            .await
    }
    /// Trusted local handle only. Directory/name provenance belongs to the
    /// caller; the runtime retains the File and actual blocking/store owners
    /// until work completes, even if the awaiting caller is cancelled.
    pub async fn ingest_capture_file(
        &self,
        input: File,
        context: SignedSourceContext,
    ) -> Result<CheckpointManifest> {
        self.ingest_capture_input(CaptureInput::File(input), context)
            .await
    }
    async fn ingest_capture_input(
        &self,
        input: CaptureInput,
        context: SignedSourceContext,
    ) -> Result<CheckpointManifest> {
        let source = context
            .verify(
                &self.inner.opened.control.binding().community_id,
                &self.inner.opened.source_node,
            )
            .map_err(|_| RuntimeError::Refused)?;
        let inner = self.inner.clone();
        self.run_job(async move {
            let timeout = inner.timeout;
            let material = inner.opened.material.clone();
            let owner = inner.clone();
            tokio::task::spawn_blocking(move || {
                owner.opened.verify()?;
                let result = match input {
                    CaptureInput::Path(path) => {
                        material.ingest_checkpoint(&path, &source, ChunkingLimits { timeout })
                    }
                    CaptureInput::File(file) => {
                        material.ingest_checkpoint_file(file, &source, ChunkingLimits { timeout })
                    }
                }
                .map(|(manifest, _)| manifest)
                .map_err(|_| RuntimeError::Refused);
                // Input refusal must not hide loss of the runtime's own roots.
                // This same final ownership check applies to both inputs.
                owner.opened.verify()?;
                result
            })
            .await
            .map_err(|_| RuntimeError::Closed)?
        })
        .await
    }
    /// No deserialized ACKs enter this path. Committed observations remain
    /// historical; timeout is indeterminate and retains the original ID.
    /// Inspect control_state before deciding whether that operation can retry.
    pub async fn observe_checkpoint(
        &self,
        operation_id: String,
        manifest: CheckpointManifest,
    ) -> Result<CommittedCheckpointObservation> {
        let inner = self.inner.clone();
        self.run_job(async move {
            inner.opened.verify()?;
            let mut round = CheckpointAvailabilityRound::begin(
                inner.opened.config.clone(),
                inner.opened.control.clone(),
                &inner.service,
                operation_id,
                &manifest,
                inner.timeout,
            )
            .await
            .map_err(runtime_transport_error)?;
            round
                .refresh(inner.opened.config.node_id())
                .await
                .map_err(runtime_transport_error)?;
            for node in inner.opened.peers.keys().copied() {
                if node != inner.opened.config.node_id() {
                    let _ = round.refresh(node).await;
                }
            }
            round
                .commit_observation(&inner.raft)
                .await
                .map_err(runtime_transport_error)
        })
        .await
    }
    pub async fn shutdown(mut self) -> Result<ServerReport> {
        self.inner.close();
        self.supervisor
            .take()
            .ok_or(RuntimeError::Closed)?
            .await
            .map_err(|_| RuntimeError::Unavailable)?
    }
}
fn runtime_transport_error(error: transport::Error) -> RuntimeError {
    match error {
        transport::Error::Deadline => RuntimeError::Deadline,
        _ => RuntimeError::Refused,
    }
}
async fn supervise(
    inner: Arc<Inner>,
    listener: TcpListener,
    mut stopped: oneshot::Receiver<()>,
) -> Result<ServerReport> {
    let (listener_stop, listener_stopped) = oneshot::channel();
    let mut listener = tokio::spawn(transport::serve_with_material(
        listener,
        inner.raft.clone(),
        inner.opened.config.clone(),
        listener_stopped,
        inner.service.clone(),
    ));
    let mut metrics = inner.raft.metrics();
    let mut listener_result = None;
    let mut fatal = false;
    loop {
        tokio::select! {
            biased;
            _ = &mut stopped => break,
            result = &mut listener => { listener_result = Some(result); fatal = true; break; },
            changed = metrics.changed() => {
                if changed.is_err() { fatal = true; break; }
                let observed = metrics.borrow();
                if observed.running_state.is_err() || observed.state == openraft::ServerState::Shutdown
                    || (observed.membership_config.log_id().is_some()
                        && !membership_matches(&observed.membership_config, &inner.opened.peers)) {
                    fatal = true; break;
                }
            }
        }
    }
    inner.closed.store(true, Ordering::SeqCst);
    let _ = listener_stop.send(());
    let listener_result = match listener_result {
        Some(result) => result,
        None => listener.await,
    };
    // Close inbound admission, drain its actual blocking work, then local jobs
    // and Raft. All stores/locks remain owned even during a slow filesystem IO.
    let worker = inner
        .worker
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
    if let Some(worker) = worker {
        if worker.await.is_err() {
            fatal = true;
        }
    }
    if inner.raft.shutdown().await.is_err() {
        fatal = true;
    }
    // Pinned OpenRaft shutdown joins Core/ticker, not all SM/snapshot workers.
    // Wait on EVERY actual store owner on success and fatal paths alike. Their
    // Inner lease also pins runtime roots/lock if a caller abandons its wait.
    if inner.opened.control.await_runtime_owners().await.is_err() {
        fatal = true;
    }
    inner.opened.verify()?;
    if fatal {
        return Err(RuntimeError::Unavailable);
    }
    listener_result
        .map_err(|_| RuntimeError::Unavailable)?
        .map_err(|_| RuntimeError::Unavailable)
}

#[cfg(test)]
mod tests;
