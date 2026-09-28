//! Engine startup and bootstrap.
//!
//! The `WabiDbEngine` is the main entry point for the storage engine.
//! Opening an engine involves: validating the data directory, acquiring
//! a lock file, loading the bootstrap key, reading/writing the storage
//! manifest, and initializing the commit sequencer, projection dispatcher,
//! and linearizability barrier.

pub mod locks;
pub mod checkpoint;
mod membership_repair;
pub mod node_identity;
pub mod replay;
pub mod wabi_store;

use crate::commit_index::batcher::{new_batcher, BatcherHandle};
use crate::commit_index::record::CommitIndexEntry;
use crate::crypto::bootstrap::{load_bootstrap_key, BootstrapSource};
use crate::crypto::stream_key_registry::StreamKeyRegistry;
use crate::engine::locks::DispatchItem;
use crate::engine::locks::{spawn_projection_dispatcher, ProjectionState, SequencerPermit};
use crate::error::{ErrorCategory, Result, WabiError};
use crate::projections::barrier::LinearizabilityBarrier;
use crate::projections::handler::DispatchTable;
use crate::replication::{new_noop_transport, SyncTransport};
use crate::sequencer::run_command::{run_command as submit_command_inner, CommitSequencer};
use crate::sequencer::types::{CommandCommit, CommandOutcome};
use crate::storage::fsync::fsync_dir;
use crate::subscription::engine::SubscriptionEngine;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::{broadcast, mpsc, RwLock, Semaphore};

const WRITER_FENCE_MARKER: &str = "writer-fenced-v1";
const ACTIVATION_PENDING_MARKER: &str = "activation-pending-v1";
pub const LIVE_CHECKPOINT_MARKER: &str = "live-checkpoint-v1";

/// A single subscription delivery: a `consumer_id` matched to a commit event.
#[derive(Debug, Clone)]
pub struct SubscriptionDelivery {
    pub consumer_id: String,
    pub event_type: String,
    pub stream_id: String,
    pub commit_seq: u64,
    pub payload: Vec<u8>,
}

/// Configuration for opening a `WabiDbEngine`.
#[derive(Debug, Clone)]
pub struct WabiDbConfig {
    /// The data directory. Will be created if it doesn't exist.
    pub data_dir: PathBuf,

    /// Where to load the bootstrap key from.
    pub bootstrap_source: BootstrapSource,

    /// The Argon2id salt (for passphrase-based bootstrap). If `None`, a fresh
    /// salt is generated when the data dir is empty.
    pub bootstrap_salt: Option<[u8; 16]>,

    /// If `true`, allow the engine to start with an empty data dir (initializing
    /// a fresh manifest). If `false`, refuse to start on an empty data dir.
    pub allow_init: bool,

    /// Optional replication configuration. When `Some`, the engine will spawn
    /// a background sync worker that periodically sends missing commits to a
    /// fenced peer after checking its applied position.
    pub replication_config: Option<crate::replication::config::ReplicationConfig>,

    /// Transport implementation for replication. Required when
    /// `replication_config` is set; `None` is single-node mode.
    pub sync_transport: Option<std::sync::Arc<dyn SyncTransport>>,

    /// Test hook: override the "boot wallclock" used by stale-lock detection.
    /// Lock files with mtime at-or-before this instant are considered left
    /// behind by a previous process incarnation. `None` (default) captures
    /// the wallclock on first lock acquisition. Tests set an explicit future
    /// instant so synthetic locks count as pre-boot regardless of mtime
    /// granularity. Ignored in release builds? No — kept unconditional: it is
    /// a pure input to the steal decision and costs nothing.
    #[doc(hidden)]
    pub test_boot_wallclock_override: Option<std::time::SystemTime>,
}

impl WabiDbConfig {
    /// Create a config with all defaults.
    pub fn new(data_dir: PathBuf, bootstrap_source: BootstrapSource) -> Self {
        Self {
            data_dir,
            bootstrap_source,
            bootstrap_salt: None,
            allow_init: false,
            replication_config: None,
            sync_transport: None,
            test_boot_wallclock_override: None,
        }
    }

    /// Create a config that uses the env-var bootstrap source.
    pub fn from_env_var(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            bootstrap_source: BootstrapSource::EnvVar,
            bootstrap_salt: None,
            allow_init: false,
            replication_config: None,
            sync_transport: None,
            test_boot_wallclock_override: None,
        }
    }

    /// Create a config that uses the passphrase bootstrap source.
    pub fn from_passphrase(data_dir: PathBuf, passphrase: String, salt: [u8; 16]) -> Self {
        Self {
            data_dir,
            bootstrap_source: BootstrapSource::Passphrase { passphrase, salt },
            bootstrap_salt: Some(salt),
            allow_init: false,
            replication_config: None,
            sync_transport: None,
            test_boot_wallclock_override: None,
        }
    }
}

/// The main WabiDB engine. Holds all runtime components: sequencer,
/// projection state, dispatcher, subscription engine, and lock-file tracking.
pub struct WabiDbEngine {
    /// Selected and validated before startup; commands cannot replace it.
    local_node_id: String,
    /// The data directory path.
    data_dir: PathBuf,
    /// The loaded bootstrap key (32 bytes). Held in memory only; never persisted.
    bootstrap_key: [u8; 32],
    /// Dispatch table mapping event types to projection handlers.
    dispatch_table: Arc<DispatchTable>,
    /// Projection state (lock-free skip maps for each index).
    projection_state: Arc<ProjectionState>,
    /// Linearizability barrier for read-after-write consistency.
    barrier: Arc<LinearizabilityBarrier>,
    /// Sequencer handle for submitting commands.
    sequencer: Option<CommitSequencer>,
    /// Join handle for the sequencer task. Kept alive for the engine's lifetime.
    _sequencer_handle: Option<tokio::task::JoinHandle<Result<()>>>,
    /// Stream key registry. Shared between the sequencer task and external
    /// code (so callers can register keys for new streams).
    key_registry: Arc<tokio::sync::Mutex<StreamKeyRegistry>>,
    /// Path to the lock file (for cleanup on drop).
    _lock_file_path: Option<PathBuf>,
    /// Subscription engine: topic-based pub/sub for real-time push.
    subscription_engine: tokio::sync::Mutex<SubscriptionEngine>,
    /// Broadcast channel sender for subscription deliveries. Server-side
    /// code receives a receiver via `subscribe_stream()` and processes
    /// matched deliveries in a background task.
    delivery_tx: broadcast::Sender<SubscriptionDelivery>,
    /// Replication transport (noop in single-node mode).
    sync_transport: Arc<dyn SyncTransport>,
    /// Batcher handle for replicated entries (segment shipping from peers).
    replication_batcher: Option<BatcherHandle>,
    /// Serialize inbound commits and stop after an on-disk commit cannot be
    /// applied in memory; a restart must replay before receiving more data.
    replication_ingest: Arc<tokio::sync::Mutex<()>>,
    replication_poisoned: AtomicBool,
    /// Join handle for the background sync worker.
    _sync_handle: Option<tokio::task::JoinHandle<()>>,
    /// Held across each complete local commit window; an operator fence takes
    /// the write lock and waits for all earlier acknowledgments to settle.
    write_fence: Arc<RwLock<bool>>,
    /// Set only after the writer-fenced marker has been observed at startup
    /// or its file and parent directory have synced successfully.
    durable_writer_fence: AtomicBool,
}

impl std::fmt::Debug for WabiDbEngine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WabiDbEngine")
            .field("data_dir", &self.data_dir)
            .field("bootstrap_key", &"[redacted]")
            .field("dispatch_table", &self.dispatch_table)
            .field("projection_state", &self.projection_state)
            .field("barrier", &self.barrier)
            .field("sequencer", &self.sequencer)
            .field("delivery_tx", &self.delivery_tx)
            .finish_non_exhaustive()
    }
}

impl WabiDbEngine {
    /// Open the engine.
    ///
    /// Performs, in order:
    /// 1. Validates / creates the data directory.
    /// 2. Acquires a lock file (`$DATA_DIR/.lock`) with the engine's PID.
    /// 3. Loads the bootstrap key.
    /// 4. Reads or writes a minimal storage manifest.
    /// 5. Initializes the stream key registry (empty; persistence deferred).
    /// 6. Builds the projection dispatch table.
    /// 7. Creates the projection state, barrier, and dispatcher.
    /// 8. Creates the commit-index batcher.
    /// 9. Spawns the sequencer task with all components wired together.
    ///
    /// # Errors
    ///
    /// - `WabiError::Io` if filesystem operations fail.
    /// - `WabiError::AlreadyRunning` if the data dir is locked by another instance.
    /// - `WabiError::KeychainUnavailable` if OS keychain is requested (stub).
    /// - `WabiError::Validation` if the bootstrap source is invalid.
    pub async fn open(config: WabiDbConfig) -> Result<Self> {
        Self::open_with_node_id(config, node_identity::DEFAULT_NODE_ID.into()).await
    }

    /// Select the local writer identity before any file mutation, replay or
    /// worker startup. Keep this operator-configured identity stable across
    /// restarts; it does not grant a distributed lease or enable another writer.
    pub async fn open_with_node_id(config: WabiDbConfig, local_node_id: String) -> Result<Self> {
        node_identity::validate(&local_node_id)?;
        if config.replication_config.is_some() && config.sync_transport.is_none() {
            return Err(WabiError::Validation {
                command: "open_replicated_engine".into(),
                reason: "replication configuration requires an explicit transport".into(),
            });
        }
        let data_dir = &config.data_dir;

        // 1. Validate / create data directory
        if !data_dir.exists() {
            if config.allow_init {
                tokio::fs::create_dir_all(data_dir)
                    .await
                    .map_err(|e| WabiError::Corrupt {
                        location: format!("data dir create: {}", data_dir.display()),
                        detail: format!("create_dir_all failed: {e}"),
                    })?;
            } else {
                return Err(WabiError::Corrupt {
                    location: format!("data dir: {}", data_dir.display()),
                    detail: "does not exist; pass allow_init=true to create".into(),
                });
            }
        }

        // 2. Lock file: atomically create (O_EXCL), write PID, fsync file +
        // parent directory. A stale lock left by a dead process is stolen;
        // a lock held by a LIVE process refuses to start.
        let lock_path = data_dir.join(".lock");
        let pid = std::process::id();
        acquire_lock_file(&lock_path, pid, config.test_boot_wallclock_override).await?;
        // Failed open (including replay failure) must release our own lock.
        let mut opening_lock = OpeningLock(Some(lock_path.clone()));
        fsync_dir(data_dir).await?;

        // Any marker, including one left by an interrupted fence write,
        // disables local commits. A restored copy of a fenced node must not
        // silently become writable merely because it starts on a new host.
        let mut initially_fenced = false;
        let mut durable_writer_fence = false;
        for marker in [WRITER_FENCE_MARKER, ACTIVATION_PENDING_MARKER, LIVE_CHECKPOINT_MARKER] {
            match tokio::fs::symlink_metadata(data_dir.join(marker)).await {
                Ok(metadata) => {
                    initially_fenced = true;
                    if marker == WRITER_FENCE_MARKER
                        && metadata.is_file()
                        && !metadata.file_type().is_symlink()
                    {
                        durable_writer_fence = true;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(WabiError::Io(error)),
            }
        }
        let write_fence = Arc::new(RwLock::new(initially_fenced));

        // 3. Load the bootstrap key
        let bootstrap_key = load_bootstrap_key(&config.bootstrap_source)?;

        // 4. Storage manifest: create if not present
        let manifest_path = data_dir.join("storage-manifest.json");
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_micros() as i64;
        if !manifest_path.exists() {
            let manifest = serde_json::json!({
                "schema_version": 1,
                "format_version": 1,
                "engine_version": "0.1.0",
                "created_at_micros": now,
                "highest_commit_seq": 0,
            });
            let manifest_bytes = serde_json::to_vec_pretty(&manifest).map_err(|e| {
                WabiError::InternalInvariantViolated {
                    invariant: format!("manifest serialize: {e}"),
                }
            })?;
            tokio::fs::write(&manifest_path, &manifest_bytes)
                .await
                .map_err(WabiError::Io)?;
            {
                let f = tokio::fs::File::open(&manifest_path)
                    .await
                    .map_err(WabiError::Io)?;
                f.sync_all().await.map_err(WabiError::Io)?;
            }
            fsync_dir(data_dir).await?;
        }

        // 5. Initialize stream key registry (empty; key persistence is a future concern)
        let key_registry = Arc::new(tokio::sync::Mutex::new(StreamKeyRegistry::new()));

        // 6. Build type registry and projection dispatch table with all registered handlers
        let type_registry = build_type_registry()?;
        let dispatch_table = type_registry.dispatch_table().clone();

        // 7. Load projection state (with optional snapshot)
        let projection_state =
            if let Some((state, _watermark)) = ProjectionState::load_snapshot(data_dir)? {
                Arc::new(state)
            } else {
                Arc::new(ProjectionState::new())
            };
        // Older snapshots may lack derived ID lookups. Rebuild them before
        // the dispatcher or sequencer can use the state; validate message
        // pointers even when their count matches the primary index.
        let rebuilt_albums =
            crate::projections::albums::AlbumProjection::rebuild_id_index(&projection_state)?;
        let rebuilt_messages = crate::projections::message_lookup::rebuild(&projection_state)?;
        if rebuilt_albums > 0 || rebuilt_messages > 0 {
            projection_state.save_snapshot(data_dir)?;
        }
        let snapshot_watermark = projection_state.applied_commit_seq();

        // 7.1 Create barrier and dispatcher
        let barrier = Arc::new(LinearizabilityBarrier::new(Arc::clone(&projection_state)));
        let dispatcher_handle = spawn_projection_dispatcher(
            Arc::clone(&projection_state),
            Arc::clone(&dispatch_table),
            None,
            Some(data_dir.clone()),
            Some(1000),
        )?;
        let dispatcher_tx = dispatcher_handle.sender;

        // 7.2 Replay events after the snapshot watermark.
        // Returns the highest commit_seq observed on disk (orphans included).
        let replay_high_seq = replay::replay_projections(
            data_dir,
            &key_registry,
            &bootstrap_key,
            &projection_state,
            &dispatch_table,
            &barrier,
            snapshot_watermark,
        )
        .await?;

        // 8. Create commit-index batcher
        let commit_index_dir = data_dir.join("global").join("commit-index");
        tokio::fs::create_dir_all(&commit_index_dir)
            .await
            .map_err(WabiError::Io)?;
        let (batcher, batcher_fut) = new_batcher(commit_index_dir, None, None);
        let replication_batcher = Some(batcher.clone());
        tokio::spawn(batcher_fut);

        // 8.1 Recover the sequencer's high-water mark: the max commit_seq
        // across the commit index, the on-disk segments (replay scan), and
        // the snapshot watermark. The sequencer continues ABOVE this number
        // so a restart never reuses a commit_seq that a prior incarnation
        // already encrypted with the same derived stream key (nonce reuse,
        // Council Review #1 §1.1) or recorded in the commit index.
        let index_high_seq = crate::commit_index::batcher::read_all_entries(
            &data_dir.join("global").join("commit-index"),
        )
        .map(|entries| entries.iter().map(|e| e.commit_seq).max().unwrap_or(0))
        .unwrap_or(0);
        let recovered_high_seq = replay_high_seq.max(index_high_seq).max(snapshot_watermark);
        if recovered_high_seq > 0 {
            tracing::info!(
                "sequencer continuing above commit_seq {recovered_high_seq} \
                 (segments={replay_high_seq} index={index_high_seq} snapshot={snapshot_watermark})"
            );
            // Keep the manifest's recorded high-water mark current (best-effort).
            update_manifest_high_seq(data_dir, recovered_high_seq);
        }

        // 9. Create command channel and acquire the sequencer permit
        let (cmd_tx, cmd_rx) = mpsc::channel::<CommandCommit>(1024);
        let sem = Arc::new(Semaphore::new(1));
        let permit = SequencerPermit::acquire(&sem).await?;

        // 10. Spawn the sequencer task
        let data_dir_clone = data_dir.clone();
        let key_registry_for_engine = Arc::clone(&key_registry);
        let sequencer_write_fence = Arc::clone(&write_fence);
        let sequencer_projection_state = Arc::clone(&projection_state);
        let sequencer_node_id = local_node_id.clone();
        let sequencer_handle = tokio::spawn(async move {
            crate::sequencer::run(
                permit,
                key_registry,
                batcher,
                dispatcher_tx,
                cmd_rx,
                data_dir_clone,
                recovered_high_seq,
                sequencer_write_fence,
                sequencer_projection_state,
                sequencer_node_id,
            )
            .await
        });

        // 11. Create CommitSequencer for public API
        let sequencer = CommitSequencer::new(cmd_tx);

        // 12. Initialize subscription engine + delivery broadcast channel
        let (delivery_tx, _) = broadcast::channel::<SubscriptionDelivery>(1024);
        let subscription_engine = tokio::sync::Mutex::new(SubscriptionEngine::new());

        // 13. Spawn background sync worker if replication is configured
        let transport_for_sync: Arc<dyn SyncTransport> = config
            .sync_transport
            .clone()
            .unwrap_or_else(new_noop_transport);
        let sync_handle = if let Some(ref rep_config) = config.replication_config {
            rep_config.validate()?;
            let sync_transport = Arc::clone(&transport_for_sync);
            let sync_writer_fence = Arc::clone(&write_fence);
            let sync_projection_state = Arc::clone(&projection_state);
            let commit_index_dir = data_dir.join("global").join("commit-index");
            let peer_endpoint = rep_config.peer_endpoint.clone();
            let interval = Duration::from_micros(rep_config.sync_interval_micros);
            let handle = tokio::spawn(async move {
                loop {
                    tokio::time::sleep(interval).await;
                    if *sync_writer_fence.read().await {
                        continue;
                    }
                    // A peer's applied position is meaningful only after the
                    // transport verifies the root-key fingerprint. The old
                    // metadata-only pull advanced a false progress watermark.
                    let peer_position = match sync_transport.latest_position(&peer_endpoint).await {
                        Ok(position) => position,
                        Err(error) => {
                            tracing::warn!(%error, "replication: peer applied position unavailable");
                            continue;
                        }
                    };
                    let mut peer_applied = peer_position.applied_seq;
                    let local = match crate::commit_index::batcher::read_all_entries(
                        &commit_index_dir,
                    ) {
                        Ok(entries) => entries,
                        Err(error) => {
                            tracing::warn!(%error, "replication: local commit index unavailable");
                            continue;
                        }
                    };
                    let local_high = local.last().map(|entry| entry.commit_seq).unwrap_or(0);
                    if peer_applied > local_high {
                        tracing::warn!(
                            peer_applied,
                            local_high,
                            "replication: peer is ahead of this Authority"
                        );
                        continue;
                    }
                    let local_prefix =
                        crate::replication::commit_prefix_fingerprint(&local, peer_applied);
                    if local_prefix != peer_position.prefix_fingerprint {
                        tracing::warn!(
                            peer_applied,
                            "replication: peer commit prefix diverges from this Authority"
                        );
                        continue;
                    }
                    let pending: Vec<_> = local
                        .into_iter()
                        .filter(|entry| entry.commit_seq > peer_applied)
                        .collect();
                    for batch in pending.chunks(32).take(32) {
                        if *sync_writer_fence.read().await {
                            break;
                        }
                        if let Err(error) =
                            sync_transport.push(&peer_endpoint, batch.to_vec()).await
                        {
                            tracing::warn!(%error, peer_applied, "replication: batch push failed");
                            break;
                        }
                        peer_applied = batch.last().unwrap().commit_seq;
                        tracing::info!(
                            peer_applied,
                            sent = batch.len(),
                            "replication: peer applied batch"
                        );
                    }
                    if peer_applied == local_high && !*sync_writer_fence.read().await {
                        if let Err(error) = sync_transport
                            .sync_auxiliary(&peer_endpoint, &sync_projection_state)
                            .await
                        {
                            tracing::warn!(%error, "replication: external asset sync failed");
                        }
                    }
                }
            });
            Some(handle)
        } else {
            None
        };

        tracing::info!("WabiDbEngine opened at {}", data_dir.display());

        opening_lock.0.take(); // ownership transfers to the engine's Drop
        Ok(Self {
            local_node_id,
            data_dir: data_dir.clone(),
            bootstrap_key,
            dispatch_table,
            projection_state,
            barrier,
            sequencer: Some(sequencer),
            _sequencer_handle: Some(sequencer_handle),
            key_registry: key_registry_for_engine,
            _lock_file_path: Some(lock_path),
            subscription_engine,
            delivery_tx,
            sync_transport: transport_for_sync,
            replication_batcher,
            replication_ingest: Arc::new(tokio::sync::Mutex::new(())),
            replication_poisoned: AtomicBool::new(false),
            _sync_handle: sync_handle,
            write_fence,
            durable_writer_fence: AtomicBool::new(durable_writer_fence),
        })
    }

    /// The data directory this engine is bound to.
    pub fn data_dir(&self) -> &std::path::Path {
        &self.data_dir
    }

    /// Immutable identity of this runtime, also held by its sequencer.
    pub fn local_node_id(&self) -> &str {
        &self.local_node_id
    }

    /// Access the stream key registry for retention operations.
    pub fn key_registry(&self) -> &Arc<tokio::sync::Mutex<StreamKeyRegistry>> {
        &self.key_registry
    }

    /// The bootstrap key (32 bytes). Held in memory only.
    pub fn bootstrap_key(&self) -> &[u8; 32] {
        &self.bootstrap_key
    }

    /// Peer-consistency fingerprint of this engine's root key. It does not
    /// grant access or prove that the complete Wabi instance is replicated.
    pub fn replica_fingerprint(&self) -> String {
        crate::replication::replica_fingerprint(&self.bootstrap_key)
    }

    /// The dispatch table mapping event types to projection handlers.
    pub fn dispatch_table(&self) -> &Arc<DispatchTable> {
        &self.dispatch_table
    }

    /// Register an encryption key for a stream. Required before any write
    /// to the stream can succeed (writes will fail with `UnknownStreamKey`
    /// otherwise).
    ///
    /// In production, `wabi-server` calls this when provisioning a new
    /// channel. Tests call this in setup to enable round-trip verification.
    pub async fn register_stream_key(&self, stream_id: &str, key_material: [u8; 32]) -> Result<()> {
        let mut registry = self.key_registry.lock().await;
        registry.create_stream(stream_id, key_material)
    }

    /// Ensure a stream key exists, deriving one from the bootstrap key if
    /// needed. Safe to call before every write — the registry short-circuits
    /// if the stream already has a key.
    pub async fn get_or_create_stream_key(&self, stream_id: &str) -> Result<()> {
        let mut registry = self.key_registry.lock().await;
        if registry.has_stream(stream_id) {
            return Ok(());
        }
        // Derive a deterministic stream key from the bootstrap key via BLAKE3.
        let mut hasher = blake3::Hasher::new();
        hasher.update(b"wabi-stream-key-v1");
        hasher.update(stream_id.as_bytes());
        hasher.update(&self.bootstrap_key);
        let key_material = *hasher.finalize().as_bytes();
        registry.create_stream(stream_id, key_material)
    }

    /// Submit a command to the sequencer and await its durable outcome.
    ///
    /// Returns an error if the engine was not fully initialized (e.g.,
    /// `new_for_tests`).
    pub async fn run_command(&self, command: CommandCommit) -> Result<CommandOutcome> {
        match &self.sequencer {
            Some(seq) => submit_command_inner(command, seq).await,
            None => Err(WabiError::InternalInvariantViolated {
                invariant: "engine not fully initialized (sequencer not running".into(),
            }),
        }
    }

    /// Durably stop local canonical commits. Returns only after any commit
    /// window already in progress has reached its normal acknowledgment path.
    /// There is deliberately no automatic unfence: promotion needs a separate
    /// quorum/epoch protocol and a full state reconciliation contract.
    pub async fn fence_local_writer(&self) -> Result<()> {
        use tokio::io::AsyncWriteExt;

        let mut fenced = self.write_fence.write().await;
        *fenced = true; // Fail closed in this process even if persistence fails.
        let marker = self.data_dir.join(WRITER_FENCE_MARKER);
        let mut options = tokio::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            options.mode(0o600);
        }
        match options.open(&marker).await {
            Ok(mut file) => {
                file.write_all(b"fenced\n").await.map_err(WabiError::Io)?;
                file.sync_all().await.map_err(WabiError::Io)?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let metadata = tokio::fs::symlink_metadata(&marker).await?;
                if !metadata.is_file() || metadata.file_type().is_symlink() {
                    return Err(replication_validation(
                        "writer fence marker is not a regular file",
                    ));
                }
            }
            Err(error) => return Err(WabiError::Io(error)),
        }
        fsync_dir(&self.data_dir).await?;
        self.durable_writer_fence.store(true, Ordering::SeqCst);
        Ok(())
    }

    /// Whether this engine refuses local canonical commits.
    pub async fn local_writer_fenced(&self) -> bool {
        *self.write_fence.read().await
    }

    /// Whether the local writer fence has a durable marker. An in-memory
    /// fail-closed fence after an I/O error is insufficient for replication.
    pub fn durable_writer_fenced(&self) -> bool {
        self.durable_writer_fence.load(Ordering::SeqCst)
    }

    /// Ingest a replicated commit from a peer (segment shipping model).
    ///
    /// Accepts only on a locally fenced engine. Validates every referenced
    /// encrypted record before appending segment bytes, durably indexes the
    /// commit, and applies its events to live projections in index order.
    ///
    /// # Segment shipping model
    ///
    /// The push endpoint receives encrypted segment bytes alongside each
    /// commit entry. This method writes those bytes to `.wseg` files in the
    /// correct stream directory, matching the paths the sequencer would have
    /// used if the commit had originated locally.
    pub async fn ingest_replicated_commit(
        &self,
        entry: CommitIndexEntry,
        segments: Vec<(String, u8, u64, Vec<u8>)>,
    ) -> Result<()> {
        use tokio::io::AsyncWriteExt;
        let _ingest = self.replication_ingest.lock().await;
        if !*self.write_fence.read().await {
            return Err(replication_validation(
                "receiving engine is still a local writer",
            ));
        }
        if !self.durable_writer_fenced() {
            return Err(replication_validation(
                "receiving engine has no durable writer fence",
            ));
        }
        if self.replication_poisoned.load(Ordering::SeqCst) {
            return Err(replication_validation(
                "previous replicated commit needs restart and replay",
            ));
        }
        let index_dir = self.data_dir.join("global").join("commit-index");
        let indexed = crate::commit_index::batcher::read_all_entries(&index_dir)?;
        if indexed
            .iter()
            .any(|candidate| candidate.commit_seq > self.barrier.current())
        {
            self.replication_poisoned.store(true, Ordering::SeqCst);
            return Err(replication_validation(
                "indexed commit is not applied; restart and replay before receiving more data",
            ));
        }
        let duplicate = if let Some(existing) = indexed
            .iter()
            .find(|candidate| candidate.commit_seq == entry.commit_seq)
        {
            if existing != &entry {
                return Err(replication_validation(
                    "commit sequence conflicts with a local entry",
                ));
            }
            true
        } else {
            false
        };
        if !duplicate
            && indexed
                .iter()
                .any(|candidate| candidate.commit_seq >= entry.commit_seq)
        {
            return Err(replication_validation(
                "replicated commit arrived out of order",
            ));
        }
        let events = self.validate_replicated_events(&entry, &segments).await?;

        // Preflight every target before writing any bytes. An existing segment
        // may be an identical/longer copy, or an exact prefix to extend. Never
        // truncate it: the same segment can contain several later commits.
        let mut writes = Vec::with_capacity(segments.len());
        for (stream_id, stream_kind, segment_id, data) in &segments {
            let kind_dir = crate::sequencer::stream_kind_dir_name(*stream_kind);
            let seg_dir = self
                .data_dir
                .join("streams")
                .join(kind_dir)
                .join(stream_id)
                .join("events");
            let seg_path = seg_dir.join(format!("{segment_id:08}.wseg"));
            let (existing_len, exists) = match tokio::fs::symlink_metadata(&seg_path).await {
                Ok(metadata) => {
                    if !metadata.is_file() || metadata.file_type().is_symlink() {
                        return Err(replication_validation(
                            "segment target is not a regular file",
                        ));
                    }
                    let old = tokio::fs::read(&seg_path).await?;
                    if data.starts_with(&old) {
                        (old.len(), true)
                    } else if old.starts_with(data) {
                        (data.len(), true)
                    } else {
                        return Err(replication_validation(
                            "replicated segment conflicts with stored bytes",
                        ));
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => (0, false),
                Err(error) => return Err(WabiError::Io(error)),
            };
            writes.push((seg_dir, seg_path, existing_len, exists));
        }
        for ((_, _, _, data), (seg_dir, seg_path, existing_len, exists)) in
            segments.iter().zip(writes)
        {
            tokio::fs::create_dir_all(&seg_dir).await?;
            if existing_len == data.len() {
                continue;
            }
            let mut options = tokio::fs::OpenOptions::new();
            options.write(true);
            if !exists {
                options.create_new(true);
            } else {
                options.append(true);
            }
            let mut file = options.open(&seg_path).await?;
            file.write_all(&data[existing_len..]).await?;
            file.sync_all().await?;
            fsync_dir(&seg_dir).await?;
        }
        if duplicate {
            return Ok(());
        }

        // Commit index publication follows durable segment bytes. A crash
        // before this point leaves only orphan bytes, which replay ignores.
        match &self.replication_batcher {
            Some(batcher) => {
                batcher.submit(entry.clone())?;
                if let Err(error) = batcher.flush_now().await {
                    self.replication_poisoned.store(true, Ordering::SeqCst);
                    return Err(error);
                }
            }
            None => {
                return Err(WabiError::InternalInvariantViolated {
                    invariant: "engine has no replication batcher (not fully opened)".into(),
                })
            }
        };
        let applied = (|| {
            for event in events {
                if let Some(handler) = self.dispatch_table.get(&event.event_type) {
                    handler.apply(&event, &self.projection_state)?;
                } else {
                    self.projection_state.insert(
                        "events",
                        event.event_type.as_bytes().to_vec(),
                        event.payload,
                        event.commit_seq,
                    );
                }
            }
            self.barrier.advance(entry.commit_seq)
        })();
        if applied.is_err() {
            self.replication_poisoned.store(true, Ordering::SeqCst);
        }
        applied
    }

    async fn validate_replicated_events(
        &self,
        entry: &CommitIndexEntry,
        segments: &[(String, u8, u64, Vec<u8>)],
    ) -> Result<Vec<crate::projections::handler::DurableEvent>> {
        use crate::format::record::{RecordHeader, HEADER_LEN};
        use crate::sequencer::types::ReplayEnvelope;
        use std::collections::HashSet;

        if entry.event_refs.len() != entry.payload_hashes.len() {
            return Err(replication_validation(
                "event reference and payload hash counts differ",
            ));
        }
        let mut seen = HashSet::new();
        for (stream_id, stream_kind, segment_id, data) in segments {
            if stream_id.is_empty()
                || matches!(stream_id.as_str(), "." | "..")
                || stream_id.chars().any(|character| {
                    matches!(character, '/' | '\\' | '\0') || character.is_control()
                })
                || data.len() > 128 * 1024 * 1024
            {
                return Err(replication_validation(
                    "invalid replicated segment identity or size",
                ));
            }
            if !seen.insert((stream_id, stream_kind, segment_id)) {
                return Err(replication_validation("duplicate replicated segment"));
            }
            let hash = crate::stream_identity::stream_id_hash(stream_id);
            if !entry.event_refs.iter().any(|reference| {
                reference.stream_id_hash == hash
                    && reference.stream_kind == *stream_kind
                    && reference.segment_id == *segment_id
            }) {
                return Err(replication_validation(
                    "segment is not referenced by its commit",
                ));
            }
        }
        let mut events = Vec::with_capacity(entry.event_refs.len());
        for (reference, expected_hash) in entry.event_refs.iter().zip(&entry.payload_hashes) {
            let (stream_id, _, _, data) = segments
                .iter()
                .find(|(stream_id, kind, id, _)| {
                    crate::stream_identity::stream_id_hash(stream_id) == reference.stream_id_hash
                        && *kind == reference.stream_kind
                        && *id == reference.segment_id
                })
                .ok_or_else(|| replication_validation("commit is missing a referenced segment"))?;
            let start = reference.offset as usize;
            let end = start
                .checked_add(reference.length as usize)
                .ok_or_else(|| replication_validation("record reference overflows"))?;
            if end > data.len() || reference.length < HEADER_LEN as u32 {
                return Err(replication_validation(
                    "record reference is outside segment",
                ));
            }
            let record = &data[start..end];
            let header = RecordHeader::decode(&record[..HEADER_LEN as usize])?;
            if header.commit_seq != entry.commit_seq
                || header.stream_id_hash != reference.stream_id_hash
                || header.total_size() != record.len()
            {
                return Err(replication_validation(
                    "record header does not match commit reference",
                ));
            }
            let payload_end = HEADER_LEN as usize + header.payload_len as usize;
            let ciphertext = &record[HEADER_LEN as usize..payload_end];
            if record[payload_end..].iter().any(|byte| *byte != 0) {
                return Err(replication_validation(
                    "replicated record has nonzero padding",
                ));
            }
            header.verify_payload_crc(ciphertext)?;
            if blake3::hash(ciphertext).as_bytes() != expected_hash {
                return Err(replication_validation("replicated payload hash mismatch"));
            }
            self.get_or_create_stream_key(stream_id).await?;
            let key = self
                .key_registry
                .lock()
                .await
                .get_active_key(stream_id, entry.commit_seq)?
                .key_material;
            let plaintext = crate::crypto::aes_gcm_record::decrypt_record(
                &key,
                entry.commit_seq,
                &header.encode(),
                ciphertext,
            )?;
            let envelope: ReplayEnvelope = serde_json::from_slice(&plaintext).map_err(|_| {
                replication_validation("replicated payload is not a replay envelope")
            })?;
            if envelope.stream_id != *stream_id {
                return Err(replication_validation(
                    "replicated envelope names a different stream",
                ));
            }
            events.push(crate::projections::handler::DurableEvent {
                commit_seq: entry.commit_seq,
                stream_id: envelope.stream_id,
                event_type: envelope.event_type,
                payload: envelope.payload,
            });
        }
        Ok(events)
    }

    /// Deliver an event to all matching subscribers and broadcast results
    /// on the delivery channel. Called by the adapter after a successful
    /// `run_command`.
    pub async fn deliver_event(
        &self,
        stream_id: &str,
        event_type: &str,
        payload: &[u8],
        commit_seq: u64,
    ) {
        let item = DispatchItem {
            commit_seq,
            event_type: event_type.into(),
            stream_id: stream_id.into(),
            payload: payload.to_vec(),
        };
        let matches = self
            .subscription_engine
            .lock()
            .await
            .deliver(stream_id, &item);
        for (consumer_id, _item) in matches {
            let delivery = SubscriptionDelivery {
                consumer_id,
                event_type: event_type.into(),
                stream_id: stream_id.into(),
                commit_seq,
                payload: payload.to_vec(),
            };
            let _ = self.delivery_tx.send(delivery);
        }
    }

    /// Subscribe a consumer to a topic. Returns a `broadcast::Receiver`
    /// that the server can use to receive push deliveries.
    pub async fn subscribe_stream(
        &self,
        consumer_id: &str,
        topic: &str,
        since: u64,
    ) -> broadcast::Receiver<SubscriptionDelivery> {
        self.subscription_engine
            .lock()
            .await
            .subscribe(consumer_id, topic, since);
        self.delivery_tx.subscribe()
    }

    /// Unsubscribe a consumer from a topic.
    pub async fn unsubscribe_stream(&self, consumer_id: &str, topic: &str) -> bool {
        self.subscription_engine
            .lock()
            .await
            .unsubscribe(consumer_id, topic)
    }

    /// Get a receiver for the delivery broadcast channel. Used by server-side
    /// bridge tasks to receive subscription deliveries.
    pub fn delivery_receiver(&self) -> broadcast::Receiver<SubscriptionDelivery> {
        self.delivery_tx.subscribe()
    }

    /// A reference to the projection state, for read queries.
    pub fn projection_state(&self) -> &Arc<ProjectionState> {
        &self.projection_state
    }

    /// Ready to accept writes and serve projections without a known apply gap.
    pub fn is_healthy(&self) -> bool {
        self.projection_state.is_healthy() && self.is_writer_running()
    }

    /// Whether the sequencer still accepts commands and its task is alive.
    /// This is runtime liveness, not an acknowledgement of any particular write.
    pub fn is_writer_running(&self) -> bool {
        self.sequencer
            .as_ref()
            .is_some_and(|s| !s.sender().is_closed())
            && self
                ._sequencer_handle
                .as_ref()
                .is_some_and(|h| !h.is_finished())
    }

    /// A reference to the linearizability barrier.
    pub fn barrier(&self) -> &Arc<LinearizabilityBarrier> {
        &self.barrier
    }

    /// A reference to the commit sequencer handle.
    pub fn sequencer(&self) -> Option<&CommitSequencer> {
        self.sequencer.as_ref()
    }

    /// Create a minimal engine instance for testing (avoids async open).
    ///
    /// Uses a temporary data dir and a zeroed bootstrap key. The sequencer
    /// is not running; callers that need a real sequencer must use `open()`.
    pub fn new_for_tests() -> Self {
        let mut data_dir = std::env::temp_dir();
        data_dir.push(format!("wabidb-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&data_dir);
        let (delivery_tx, _) = broadcast::channel::<SubscriptionDelivery>(1024);
        Self {
            local_node_id: node_identity::DEFAULT_NODE_ID.into(),
            data_dir,
            bootstrap_key: [0u8; 32],
            dispatch_table: Arc::new(DispatchTable::new(vec![]).unwrap()),
            projection_state: Arc::new(ProjectionState::new()),
            barrier: Arc::new(LinearizabilityBarrier::new(
                Arc::new(ProjectionState::new()),
            )),
            sequencer: None,
            _sequencer_handle: None,
            key_registry: Arc::new(tokio::sync::Mutex::new(StreamKeyRegistry::new())),
            _lock_file_path: None,
            subscription_engine: tokio::sync::Mutex::new(SubscriptionEngine::new()),
            delivery_tx,
            sync_transport: new_noop_transport(),
            replication_batcher: None,
            replication_ingest: Arc::new(tokio::sync::Mutex::new(())),
            replication_poisoned: AtomicBool::new(false),
            _sync_handle: None,
            write_fence: Arc::new(RwLock::new(false)),
            durable_writer_fence: AtomicBool::new(false),
        }
    }

    /// The error category of any future engine-open errors.
    #[allow(dead_code)]
    fn _category() -> ErrorCategory {
        ErrorCategory::Sequencer
    }
}

fn replication_validation(reason: &str) -> WabiError {
    WabiError::Validation {
        command: "ingest_replicated_commit".into(),
        reason: reason.into(),
    }
}

/// Boot wallclock, captured on first use: locks whose mtime predates this
/// instant were written by a previous process incarnation, never this one.
static BOOT_WALLCLOCK: std::sync::OnceLock<std::time::SystemTime> = std::sync::OnceLock::new();

/// Lock paths currently held by LIVE engines of THIS process. Used to
/// distinguish "second engine in this process" (genuine AlreadyRunning)
/// from "same-PID stale lock left by a previous container incarnation"
/// (steal): inside a Docker PID namespace every run is PID 1, so the
/// holder PID alone cannot make that call.
static HELD_LOCKS: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashSet<std::path::PathBuf>>,
> = std::sync::OnceLock::new();

fn held_locks() -> &'static std::sync::Mutex<std::collections::HashSet<std::path::PathBuf>> {
    HELD_LOCKS.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
}

/// Atomically acquire the engine lock file (O_EXCL semantics).
///
/// - Free path: `create_new` succeeds → we own the lock; write our PID.
/// - Held by a live process: `WabiError::AlreadyRunning`.
/// - Held by a DEAD process (crash / kill -9 left the file behind): steal
///   the lock. This removes the manual "rm the lock files" deploy step for
///   the common case; an operator can still delete the file by hand if the
///   PID is somehow wrong.
async fn acquire_lock_file(
    lock_path: &std::path::Path,
    pid: u32,
    boot_wallclock_override: Option<std::time::SystemTime>,
) -> Result<()> {
    use tokio::io::AsyncWriteExt;

    for attempt in 0..2 {
        // Same-process double-open must ALWAYS be refused, even though the
        // on-disk holder PID equals ours (the mtime/steal arms below cannot
        // distinguish it from a previous container incarnation).
        if held_locks()
            .lock()
            .map(|g| g.contains(lock_path))
            .unwrap_or(false)
        {
            return Err(WabiError::AlreadyRunning);
        }
        match tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(lock_path)
            .await
        {
            Ok(mut f) => {
                f.write_all(pid.to_string().as_bytes()).await.map_err(|e| {
                    WabiError::Io(std::io::Error::new(
                        e.kind(),
                        format!("lock file write: {e}"),
                    ))
                })?;
                f.sync_all().await.map_err(WabiError::Io)?;
                if let Ok(mut g) = held_locks().lock() {
                    g.insert(lock_path.to_path_buf());
                }
                return Ok(());
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                if attempt > 0 {
                    return Err(WabiError::AlreadyRunning);
                }
                // Inspect the holder. A dead PID means a stale lock: steal it.
                //
                // Container caveat: inside a Docker PID namespace every run is
                // PID 1, so a lock left by a PREVIOUS container run carries the
                // same PID we now have. `process_alive(1)` in our namespace
                // probes OUR OWN /proc/1 — which always exists while we are
                // booting, and would exist for any init-style process anyway.
                // The correct liveness question for pid N in a private
                // namespace is "is something ELSE with that PID running my
                // engine?" which we cannot answer from inside. So: when
                // holder == pid AND the lock file predates our own start
                // (mtime strictly before this boot attempt), treat it as
                // stale-from-a-past-life and steal it. A genuine concurrent
                // sibling still loses only if it wrote its lock before us —
                // in which case IT is the one that must yield, and our steal
                // attempt races its create_new exactly once (the retry loop
                // re-checks). Same-host non-container deployments keep the
                // strict rule via the mtime guard being satisfied trivially:
                // a live sibling's lock was written before we booted too, but
                // its holder != our pid there, so the dead-holder branch
                // already refused us before reaching this arm.
                let holder_pid = tokio::fs::read_to_string(lock_path)
                    .await
                    .ok()
                    .and_then(|s| s.trim().parse::<u32>().ok());
                let lock_mtime_before_boot = tokio::fs::metadata(lock_path)
                    .await
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .map(|t| {
                        let boot = boot_wallclock_override.unwrap_or_else(|| {
                            *BOOT_WALLCLOCK.get_or_init(std::time::SystemTime::now)
                        });
                        t <= boot
                    });
                let steal = match (holder_pid, lock_mtime_before_boot) {
                    // Dead holder on the same host: classic stale lock.
                    (Some(holder), _) if holder != pid && !process_alive(holder) => true,
                    // Same PID as us + lock written before this boot started:
                    // previous incarnation of ourselves (container restart,
                    // kill -9). The file cannot be ours from THIS run — we
                    // have not created it yet.
                    (Some(holder), Some(true)) if holder == pid => true,
                    // Unparseable/empty lock file: nothing defensible holds it.
                    (None, _) => true,
                    _ => false,
                };
                if !steal {
                    return Err(WabiError::AlreadyRunning);
                }
                tracing::warn!(
                    "engine lock held by dead/stale holder {:?} (mtime_pre_boot={:?}); removing stale lock",
                    holder_pid,
                    lock_mtime_before_boot
                );
                let _ = tokio::fs::remove_file(lock_path).await;
                // loop retries the create_new exactly once
            }
            Err(e) => {
                return Err(WabiError::Io(std::io::Error::new(
                    e.kind(),
                    format!("lock file open: {e}"),
                )));
            }
        }
    }
    Err(WabiError::AlreadyRunning)
}

/// Whether a PID is alive on this host.
///
/// Linux: `/proc/<pid>` exists iff the process is alive. On platforms
/// without `/proc`, report `true` (conservative — never steal a lock from
/// a holder we cannot probe).
fn process_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        let proc_root = std::path::Path::new("/proc");
        if !proc_root.exists() {
            return true;
        }
        proc_root.join(pid.to_string()).exists()
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        true
    }
}

/// Best-effort update of the manifest's `highest_commit_seq` so the backup
/// artifact reflects reality. Failures are logged by the caller's context
/// and never block engine startup.
fn update_manifest_high_seq(data_dir: &std::path::Path, high: u64) {
    if high == 0 {
        return;
    }
    let path = data_dir.join("storage-manifest.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return;
    };
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return;
    };
    let current = value
        .get("highest_commit_seq")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    if current >= high {
        return;
    }
    if let Some(obj) = value.as_object_mut() {
        obj.insert("highest_commit_seq".to_string(), serde_json::json!(high));
        if let Ok(bytes) = serde_json::to_vec_pretty(&value) {
            if let Err(e) = std::fs::write(&path, bytes) {
                tracing::warn!("manifest highest_commit_seq update failed: {e}");
            }
        }
    }
}

struct OpeningLock(Option<PathBuf>);

impl Drop for OpeningLock {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = std::fs::remove_file(&path);
            if let Ok(mut locks) = held_locks().lock() {
                locks.remove(&path);
            }
        }
    }
}

impl Drop for WabiDbEngine {
    fn drop(&mut self) {
        // A failed replicated projection may have applied only part of a
        // committed batch. Restart must replay the prior safe snapshot.
        if !self.data_dir.as_os_str().is_empty()
            && !self.replication_poisoned.load(Ordering::SeqCst)
        {
            let _ = self.projection_state.save_snapshot(&self.data_dir);
        }

        // Zero the bootstrap key before dropping.
        use zeroize::Zeroize;
        self.bootstrap_key.zeroize();

        if let Some(ref lock_path) = self._lock_file_path {
            let _ = std::fs::remove_file(lock_path);
            if let Ok(mut g) = held_locks().lock() {
                g.remove(lock_path);
            }
            if let Some(parent) = lock_path.parent() {
                // Best-effort directory fsync; errors are non-fatal during cleanup.
                let _ = std::fs::File::open(parent).and_then(|f| f.sync_all());
            }
        }
    }
}

/// Build the type registry with all registered projection handlers.
fn build_type_registry() -> Result<crate::projections::registry::TypeRegistry> {
    use crate::projections::album_items::AlbumItemsProjection;
    use crate::projections::albums::AlbumProjection;
    use crate::projections::audit::AuditProjection;
    use crate::projections::badges::BadgesProjection;
    use crate::projections::call_participants::CallParticipantsProjection;
    use crate::projections::call_sessions::CallSessionsProjection;
    use crate::projections::call_signals::CallSignalsProjection;
    use crate::projections::channel_members::ChannelMembersProjection;
    use crate::projections::channels::ChannelProjection;
    use crate::projections::dm_identities::DmIdentitiesProjection;
    use crate::projections::dm_message_recipients::DmMessageRecipientsProjection;
    use crate::projections::dm_messages::DmMessagesProjection;
    use crate::projections::emotes::EmotesProjection;
    use crate::projections::forum::ForumProjection;
    use crate::projections::gallery::{GalleryFeedbackProjection, GalleryWorkProjection};
    use crate::projections::incidents::IncidentProjection;
    use crate::projections::layouts::LayoutsProjection;
    use crate::projections::lore::{
        LoreBindingProjection, LoreCommitProjection, LoreFileChangeProjection,
        LorePromoteProjection, LoreRepoProjection, LoreTokenProjection,
    };
    use crate::projections::messages::MessagesProjection;
    use crate::projections::noop::NoopProjection;
    use crate::projections::owner::OwnerProjection;
    use crate::projections::payments::PaymentsProjection;
    use crate::projections::project_tasks::ProjectTaskProjection;
    use crate::projections::project_runs::ProjectRunProjection;
    use crate::projections::reactions::ReactionsProjection;
    use crate::projections::registry::{ProjectionRegistration, TypeRegistry};
    use crate::projections::user_deletion::UserDeletionProjection;
    use crate::projections::users::UsersProjection;
    use crate::projections::webhooks::WebhooksProjection;
    use crate::projections::whiteboard_docs::WhiteboardDocsProjection;
    use crate::projections::wiki::{WikiProjection, WikiRevisionProjection};
    use std::sync::Arc;

    let entries = vec![
        ProjectionRegistration {
            event_types: &["role_assigned", "role_removed", "channel_settings_updated"],
            handler: Arc::new(AuditProjection),
            index_name: "audit",
            record_type_name: "wabidb::projections::audit::AuditEntry",
        },
        ProjectionRegistration {
            event_types: &[
                "message_created",
                "message_edited",
                "message_deleted",
                "channel_messages_cleared",
            ],
            handler: Arc::new(MessagesProjection),
            index_name: "messages,message_by_id_v1",
            record_type_name: "wabidb::projections::messages::MessageRecord",
        },
        ProjectionRegistration {
            event_types: &["reaction_added"],
            handler: Arc::new(ReactionsProjection),
            index_name: "reactions",
            record_type_name: "wabidb::projections::reactions::Reaction",
        },
        ProjectionRegistration {
            event_types: &[
                "channel_member_added",
                "channel_member_removed",
                "channel_members_changed",
            ],
            handler: Arc::new(ChannelMembersProjection),
            index_name: "channel_members",
            record_type_name: "wabidb::projections::channel_members::ChannelMemberRecord",
        },
        ProjectionRegistration {
            event_types: &["dm_message_created"],
            handler: Arc::new(DmMessagesProjection),
            index_name: "dm_messages",
            record_type_name: "wabidb::projections::dm_messages::DmMessageRecord",
        },
        ProjectionRegistration {
            event_types: &["dm_message_recipient_added"],
            handler: Arc::new(DmMessageRecipientsProjection),
            index_name: "dm_message_recipients",
            record_type_name: "wabidb::projections::dm_message_recipients::DmRecipientRecord",
        },
        ProjectionRegistration {
            event_types: &["dm_identity_registered", "dm_onetime_prekey_consumed"],
            handler: Arc::new(DmIdentitiesProjection),
            index_name: "dm_identities",
            record_type_name: "wabidb::projections::dm_identities::DmIdentityRecord",
        },
        ProjectionRegistration {
            event_types: &["user_registered", "user_updated"],
            handler: Arc::new(UsersProjection),
            index_name: "users",
            record_type_name: "wabidb::projections::users::UserRecord",
        },
        // Guest tombstone. One handler per event type is enforced, so this
        // projection owns `user_deleted` and cascades removal across the
        // users / channel_members / dm_identities indexes itself.
        ProjectionRegistration {
            event_types: &["user_deleted"],
            handler: Arc::new(UserDeletionProjection),
            index_name: "users",
            record_type_name: "wabidb::domain::UserDeleted",
        },
        ProjectionRegistration {
            event_types: &["owner_claimed"],
            handler: Arc::new(OwnerProjection),
            index_name: "server_meta",
            record_type_name: "wabidb::projections::owner::OwnerRecord",
        },
        ProjectionRegistration {
            event_types: &["emote_upserted", "emote_deleted"],
            handler: Arc::new(EmotesProjection),
            index_name: "emotes",
            record_type_name: "wabidb::domain::Emote",
        },
        ProjectionRegistration {
            event_types: &["webhook_upserted"],
            handler: Arc::new(WebhooksProjection),
            index_name: "webhooks",
            record_type_name: "wabidb::domain::Webhook",
        },
        ProjectionRegistration {
            event_types: &["whiteboard_doc_upserted"],
            handler: Arc::new(WhiteboardDocsProjection),
            index_name: "whiteboard_docs",
            record_type_name: "wabidb::domain::WhiteboardDoc",
        },
        ProjectionRegistration {
            event_types: &["user_layout_upserted"],
            handler: Arc::new(LayoutsProjection),
            index_name: "user_layouts",
            record_type_name: "wabidb::domain::UserLayout",
        },
        ProjectionRegistration {
            event_types: &["call_session_created", "call_session_ended"],
            handler: Arc::new(CallSessionsProjection),
            index_name: "call_sessions",
            record_type_name: "wabidb::projections::call_sessions::CallSession",
        },
        ProjectionRegistration {
            event_types: &["call_participant_joined"],
            handler: Arc::new(CallParticipantsProjection),
            index_name: "call_participants",
            record_type_name: "wabidb::projections::call_participants::CallParticipant",
        },
        ProjectionRegistration {
            event_types: &["call_signal_emitted"],
            handler: Arc::new(CallSignalsProjection),
            index_name: "call_signals",
            record_type_name: "wabidb::projections::call_signals::CallSignal",
        },
        ProjectionRegistration {
            event_types: &["channel_created", "channel_updated", "channel_deleted"],
            handler: Arc::new(ChannelProjection),
            index_name: "channels",
            record_type_name: "wabidb::projections::channels::Channel",
        },
        ProjectionRegistration {
            event_types: &["wiki_page_created", "wiki_page_edited", "wiki_page_deleted"],
            handler: Arc::new(WikiProjection),
            index_name: "wiki_pages",
            record_type_name: "wabidb::projections::wiki::WikiPageRecord",
        },
        ProjectionRegistration {
            event_types: &["wiki_revision_created"],
            handler: Arc::new(WikiRevisionProjection),
            index_name: "wiki_revisions",
            record_type_name: "wabidb::projections::wiki::WikiRevisionRecord",
        },
        ProjectionRegistration {
            event_types: &["project_run_updated"], handler: Arc::new(ProjectRunProjection),
            index_name: "project_runs", record_type_name: "wabidb::projections::project_runs::ProjectRun",
        },
        ProjectionRegistration {
            event_types: &["project_task_created", "project_task_updated"],
            handler: Arc::new(ProjectTaskProjection),
            index_name: "project_tasks",
            record_type_name: "wabidb::projections::project_tasks::ProjectTaskRecord",
        },
        ProjectionRegistration {
            event_types: &[
                "forum_thread_created",
                "forum_post_created",
                "forum_post_edited",
                "forum_post_deleted",
            ],
            handler: Arc::new(ForumProjection),
            index_name: "forum_posts",
            record_type_name: "wabidb::projections::forum::ForumPostRecord",
        },
        ProjectionRegistration {
            event_types: &["incident_created", "incident_updated", "incident_resolved"],
            handler: Arc::new(IncidentProjection),
            index_name: "incidents",
            record_type_name: "wabidb::projections::incidents::IncidentRecord",
        },
        ProjectionRegistration {
            event_types: &["album_created", "album_updated", "album_deleted"],
            handler: Arc::new(AlbumProjection),
            index_name: "albums,album_by_id",
            record_type_name: "wabidb::projections::albums::AlbumRecord",
        },
        ProjectionRegistration {
            event_types: &[
                "album_item_added",
                "album_item_updated",
                "album_item_removed",
            ],
            handler: Arc::new(AlbumItemsProjection),
            index_name: "album_items",
            record_type_name: "wabidb::projections::album_items::AlbumItemRecord",
        },
        ProjectionRegistration {
            event_types: &["lore_repo_registered", "lore_repo_deleted"],
            handler: Arc::new(LoreRepoProjection),
            index_name: "lore_repos",
            record_type_name: "wabidb::projections::lore::LoreRepoRecord",
        },
        ProjectionRegistration {
            event_types: &["lore_binding_set", "lore_binding_removed"],
            handler: Arc::new(LoreBindingProjection),
            index_name: "lore_bindings",
            record_type_name: "wabidb::projections::lore::LoreBindingRecord",
        },
        ProjectionRegistration {
            event_types: &["lore_promoted"],
            handler: Arc::new(LorePromoteProjection),
            index_name: "lore_promotes",
            record_type_name: "wabidb::projections::lore::LorePromoteRecord",
        },
        ProjectionRegistration {
            event_types: &["lore_commit"],
            handler: Arc::new(LoreCommitProjection),
            index_name: "lore_commits",
            record_type_name: "wabidb::projections::lore::LoreCommitRecord",
        },
        ProjectionRegistration {
            event_types: &["lore_file_change"],
            handler: Arc::new(LoreFileChangeProjection),
            index_name: "lore_file_changes",
            record_type_name: "wabidb::projections::lore::LoreFileChangeRecord",
        },
        ProjectionRegistration {
            event_types: &["lore_token_minted", "lore_token_revoked"],
            handler: Arc::new(LoreTokenProjection),
            index_name: "lore_tokens",
            record_type_name: "wabidb::projections::lore::LoreTokenRecord",
        },
        ProjectionRegistration {
            event_types: &[
                "gallery_work_uploaded",
                "gallery_work_edited",
                "gallery_work_deleted",
            ],
            handler: Arc::new(GalleryWorkProjection),
            index_name: "gallery_works",
            record_type_name: "wabidb::projections::gallery::GalleryWorkRecord",
        },
        ProjectionRegistration {
            event_types: &["gallery_feedback_added", "gallery_feedback_deleted"],
            handler: Arc::new(GalleryFeedbackProjection),
            index_name: "gallery_feedback",
            record_type_name: "wabidb::projections::gallery::GalleryFeedbackRecord",
        },
        ProjectionRegistration {
            event_types: &[
                "payment_account_link_upserted",
                "payment_account_link_deleted",
                "payment_intent_created",
                "payment_intent_confirmed",
                "payment_intent_rejected",
                "payment_policy_upserted",
                "payment_user_block_upserted",
                "payment_user_block_deleted",
            ],
            handler: Arc::new(PaymentsProjection),
            index_name:
                "payment_account_links,payment_intents,payment_policies,payment_user_blocks",
            record_type_name: "wabidb::projections::payments",
        },
        ProjectionRegistration {
            event_types: &[crate::projections::service_access::EVENT],
            handler: Arc::new(crate::projections::service_access::ServiceAccessProjection),
            index_name: crate::projections::service_access::INDEX,
            record_type_name: "wabidb::projections::service_access::ServiceAccess",
        },
        ProjectionRegistration {
            event_types: &[crate::projections::community_roster::EVENT],
            handler: Arc::new(crate::projections::community_roster::CommunityRosterProjection),
            index_name: crate::projections::community_roster::INDEX,
            record_type_name: "wabidb::projections::community_roster::CommunityRosterRecord",
        },
        ProjectionRegistration {
            event_types: &[
                crate::projections::room_placement::EVENT,
                crate::projections::room_placement::INIT_EVENT,
            ],
            handler: Arc::new(crate::projections::room_placement::RoomPlacementProjection),
            index_name: crate::projections::room_placement::INDEX,
            record_type_name: "wabidb::projections::room_placement::RoomPlacementRecord",
        },
        ProjectionRegistration {
            event_types: &[crate::projections::upload_revocations::EVENT],
            handler: Arc::new(crate::projections::upload_revocations::UploadRevocationsProjection),
            index_name: crate::projections::upload_revocations::INDEX,
            record_type_name: "wabidb::projections::upload_revocations::RevokedUploadRecord",
        },
        ProjectionRegistration {
            event_types: &[crate::projections::auth_revocations::EVENT],
            handler: Arc::new(crate::projections::auth_revocations::AuthRevocationsProjection),
            index_name: crate::projections::auth_revocations::INDEX,
            record_type_name: "wabidb::projections::auth_revocations::Value",
        },
        ProjectionRegistration {
            event_types: &[crate::projections::recovery_codes::EVENT],
            handler: Arc::new(crate::projections::recovery_codes::RecoveryCodesProjection),
            index_name: crate::projections::recovery_codes::INDEX,
            record_type_name: "wabidb::projections::recovery_codes::Value",
        },
        ProjectionRegistration {
            event_types: &[crate::projections::upload_assets::EVENT],
            handler: Arc::new(crate::projections::upload_assets::UploadAssetsProjection),
            index_name: crate::projections::upload_assets::INDEX,
            record_type_name: "wabidb::projections::upload_assets::UploadAssetRecord",
        },
        ProjectionRegistration {
            event_types: &[crate::projections::friends::EVENT],
            handler: Arc::new(crate::projections::friends::FriendsProjection),
            index_name: crate::projections::friends::INDEX,
            record_type_name: "wabidb::projections::friends::FriendRelationship",
        },
        ProjectionRegistration {
            event_types: &[crate::projections::game_profiles::EVENT],
            handler: Arc::new(crate::projections::game_profiles::GameProfilesProjection),
            index_name: crate::projections::game_profiles::INDEX,
            record_type_name: "wabidb::projections::game_profiles::GameProfileRecord",
        },
        ProjectionRegistration {
            event_types: &["badge_assigned", "badge_removed"],
            handler: Arc::new(BadgesProjection),
            index_name: "user_badges",
            record_type_name: "wabidb::projections::badges::UserBadgeRecord",
        },
        ProjectionRegistration {
            event_types: &[
                "reaction_removed",
                "member_joined",
                "member_left",
                "channel_renamed",
            ],
            handler: Arc::new(NoopProjection),
            index_name: "",
            record_type_name: "",
        },
    ];
    TypeRegistry::new(entries)
}

#[cfg(test)]
mod message_admission_tests;

#[cfg(test)]
mod node_identity_tests;

#[cfg(test)]
mod workspace_admission_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::record::RecordKind;
    use crate::sequencer::types::{CommandCommit, EventToWrite};
    use tempfile::tempdir;

    fn replica_test_config(path: &std::path::Path) -> WabiDbConfig {
        let mut config =
            WabiDbConfig::new(path.to_path_buf(), BootstrapSource::Provided([0xAB; 32]));
        config.allow_init = true;
        config
    }

    #[tokio::test]
    async fn open_backfills_album_id_index_from_legacy_snapshot() {
        use crate::projections::albums::{encode_record, AlbumProjection, AlbumRecord, ID_INDEX};

        let dir = tempdir().unwrap();
        let engine = WabiDbEngine::open(replica_test_config(dir.path()))
            .await
            .unwrap();
        let stream = "albums:user:1";
        engine.get_or_create_stream_key(stream).await.unwrap();
        let mut album = AlbumRecord {
            album_id: String::new(),
            scope_type: "user".into(),
            scope_id: "1".into(),
            name: "Legacy album".into(),
            description: String::new(),
            owner_user_id: 1,
            cover_url: String::new(),
            created_at_micros: 1,
            updated_at_micros: 1,
            is_deleted: false,
        };
        let (response_tx, _response_rx) = tokio::sync::oneshot::channel();
        let outcome = engine
            .run_command(CommandCommit {
                room_owner_precondition: None,
                caller_user_id: 1,
                caller_device_id: "album-migration-test".into(),
                command_name: "create_album".into(),
                idempotency_key: None,
                events: vec![EventToWrite {
                    stream_id: stream.into(),
                    event_type: "album_created".into(),
                    stream_kind: 6,
                    record_kind: RecordKind::Event,
                    plaintext: encode_record(&album),
                }],
                essential: true,
                response_tx,
            })
            .await
            .unwrap();
        album.album_id = format!("alb_{:x}", outcome.commit_seq);
        assert_eq!(
            AlbumProjection::get_album_by_id(&engine.projection_state(), &album.album_id)
                .unwrap(),
            Some(album.clone())
        );
        drop(engine);

        // Remove only the derived lookup to reproduce an older snapshot.
        let (legacy, watermark) = ProjectionState::load_snapshot(dir.path()).unwrap().unwrap();
        assert_eq!(watermark, outcome.commit_seq);
        legacy.remove(ID_INDEX, album.album_id.as_bytes());
        legacy.save_snapshot(dir.path()).unwrap();

        let restarted = WabiDbEngine::open(replica_test_config(dir.path()))
            .await
            .unwrap();
        let state = restarted.projection_state();
        assert_eq!(state.applied_commit_seq(), watermark);
        assert_eq!(state.index_len(ID_INDEX), 1);
        assert_eq!(
            AlbumProjection::get_album_by_id(&state, &album.album_id).unwrap(),
            Some(album)
        );
        let (persisted, persisted_watermark) =
            ProjectionState::load_snapshot(dir.path()).unwrap().unwrap();
        assert_eq!(persisted_watermark, watermark);
        assert_eq!(persisted.index_len(ID_INDEX), 1);
    }

    #[tokio::test]
    async fn call_creation_preflight_preserves_parent_for_queued_creates_and_replay() {
        use crate::domain::CallSession;
        use crate::projections::call_sessions::{decode_value, INDEX_NAME};
        use crate::sequencer::types::RoomOwnerPrecondition;

        let dir = tempdir().unwrap();
        let engine = WabiDbEngine::open_with_node_id(replica_test_config(dir.path()), "site-a".into())
            .await
            .unwrap();
        let stream = "call_session:queued-call";
        engine.get_or_create_stream_key(stream).await.unwrap();
        let make = |room: &str| {
            let (response_tx, response_rx) = tokio::sync::oneshot::channel();
            (
                CommandCommit {
                    room_owner_precondition: Some(RoomOwnerPrecondition {
                        channel_id: room.into(),
                        owner_node_id: "site-a".into(),
                        expected_epoch: None,
                    }),
                    caller_user_id: 1,
                    caller_device_id: "call-parent-test".into(),
                    command_name: "create_call_session".into(),
                    idempotency_key: None,
                    events: vec![EventToWrite {
                        stream_id: stream.into(),
                        event_type: "call_session_created".into(),
                        stream_kind: 6,
                        record_kind: RecordKind::Event,
                        plaintext: serde_json::to_vec(&CallSession::new(
                            "queued-call",
                            room,
                            "audio-call",
                            1,
                            10,
                            "webrtc",
                        ))
                        .unwrap(),
                    }],
                    essential: true,
                    response_tx,
                },
                response_rx,
            )
        };
        let sender = engine.sequencer().unwrap().sender().clone();
        let (first, first_rx) = make("ch_first");
        let (rebind, rebind_rx) = make("ch_different");
        // Both commands are ready before the current-thread runtime yields.
        sender.try_send(first).unwrap();
        sender.try_send(rebind).unwrap();
        let accepted = first_rx.await.unwrap().unwrap();
        assert!(
            matches!(rebind_rx.await.unwrap(), Err(WabiError::Validation { command, .. })
            if command == "room_owner_precondition")
        );
        assert_eq!(engine.barrier().current(), accepted.commit_seq);
        let entries =
            crate::commit_index::batcher::read_all_entries(&dir.path().join("global/commit-index"))
                .unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(
            decode_value(
                &engine
                    .projection_state()
                    .get(INDEX_NAME, b"queued-call")
                    .unwrap()
            )
            .unwrap()
            .channel_id,
            "ch_first"
        );
        drop(sender);
        drop(engine);
        std::fs::remove_file(dir.path().join("projections/snapshot.json")).unwrap();
        let reopened = WabiDbEngine::open_with_node_id(replica_test_config(dir.path()), "site-a".into())
            .await
            .unwrap();
        assert_eq!(reopened.barrier().current(), accepted.commit_seq);
        assert_eq!(
            decode_value(
                &reopened
                    .projection_state()
                    .get(INDEX_NAME, b"queued-call")
                    .unwrap()
            )
            .unwrap()
            .channel_id,
            "ch_first"
        );
    }

    #[tokio::test]
    async fn room_placement_event_is_projected_and_restored_after_restart() {
        use crate::projections::room_placement::{
            decode, stream_id, RoomPlacementRecord, EVENT, INDEX,
        };

        let dir = tempdir().unwrap();
        let engine = WabiDbEngine::open(replica_test_config(dir.path()))
            .await
            .unwrap();
        let channel_id = "ch_placement_restart";
        let stream = stream_id(channel_id);
        engine.get_or_create_stream_key(&stream).await.unwrap();
        let placement = RoomPlacementRecord {
            schema_version: 1,
            channel_id: channel_id.into(),
            epoch: 1,
            owner_node_id: "site-a".into(),
            replica_node_ids: vec!["site-b".into()],
        };
        let (response_tx, _response_rx) = tokio::sync::oneshot::channel();
        engine
            .run_command(CommandCommit {
                room_owner_precondition: None,
                caller_user_id: 1,
                caller_device_id: "placement-test".into(),
                command_name: "record_room_placement".into(),
                idempotency_key: None,
                events: vec![EventToWrite {
                    stream_id: stream,
                    event_type: EVENT.into(),
                    stream_kind: 6,
                    record_kind: RecordKind::Event,
                    plaintext: serde_json::to_vec(&placement).unwrap(),
                }],
                essential: true,
                response_tx,
            })
            .await
            .unwrap();
        assert_eq!(
            decode(
                &engine
                    .projection_state()
                    .get(INDEX, channel_id.as_bytes())
                    .unwrap()
            )
            .unwrap(),
            placement
        );
        drop(engine);

        // Exercise event replay even if shutdown created a projection snapshot.
        let snapshot = dir.path().join("projections/snapshot.json");
        if snapshot.exists() {
            std::fs::remove_file(snapshot).unwrap();
        }

        let restarted = WabiDbEngine::open(replica_test_config(dir.path()))
            .await
            .unwrap();
        assert_eq!(
            decode(
                &restarted
                    .projection_state()
                    .get(INDEX, channel_id.as_bytes())
                    .unwrap()
            )
            .unwrap(),
            placement
        );
    }

    #[tokio::test]
    async fn room_placement_preflight_rejects_queued_duplicate_and_stale_write() {
        use crate::projections::room_placement::{
            decode, stream_id, RoomPlacementRecord, EVENT, INDEX,
        };
        use crate::sequencer::types::RoomOwnerPrecondition;

        let dir = tempdir().unwrap();
        let engine = WabiDbEngine::open_with_node_id(replica_test_config(dir.path()), "site-a".into())
            .await
            .unwrap();
        let channel_id = "ch_queued_placement";
        let stream = stream_id(channel_id);
        engine.get_or_create_stream_key(&stream).await.unwrap();
        engine
            .get_or_create_stream_key("room-write-probe")
            .await
            .unwrap();
        let sender = engine.sequencer.as_ref().unwrap().sender().clone();
        let make_command = |epoch| {
            let (response_tx, response_rx) = tokio::sync::oneshot::channel();
            let placement = RoomPlacementRecord {
                schema_version: 1,
                channel_id: channel_id.into(),
                epoch,
                owner_node_id: "site-a".into(),
                replica_node_ids: vec![],
            };
            (
                CommandCommit {
                    room_owner_precondition: None,
                    caller_user_id: 1,
                    caller_device_id: "placement-preflight-test".into(),
                    command_name: "record_room_placement".into(),
                    idempotency_key: None,
                    events: vec![EventToWrite {
                        stream_id: stream.clone(),
                        event_type: EVENT.into(),
                        stream_kind: 6,
                        record_kind: RecordKind::Event,
                        plaintext: serde_json::to_vec(&placement).unwrap(),
                    }],
                    essential: true,
                    response_tx,
                },
                response_rx,
            )
        };
        let (first, first_rx) = make_command(1);
        let (duplicate, duplicate_rx) = make_command(1);
        let (stale_tx, stale_rx) = tokio::sync::oneshot::channel();
        let stale_room_write = CommandCommit {
            room_owner_precondition: Some(RoomOwnerPrecondition {
                channel_id: channel_id.into(),
                owner_node_id: "site-a".into(),
                expected_epoch: None,
            }),
            caller_user_id: 1,
            caller_device_id: "placement-preflight-test".into(),
            command_name: "stale_room_write".into(),
            idempotency_key: None,
            events: vec![EventToWrite {
                stream_id: "room-write-probe".into(),
                event_type: "room_write_probe".into(),
                stream_kind: 6,
                record_kind: RecordKind::Event,
                plaintext: vec![],
            }],
            essential: true,
            response_tx: stale_tx,
        };
        sender.send(first).await.unwrap();
        sender.send(duplicate).await.unwrap();
        sender.send(stale_room_write).await.unwrap();
        first_rx.await.unwrap().unwrap();
        assert!(duplicate_rx.await.unwrap().is_err());
        assert!(stale_rx.await.unwrap().is_err());
        let entries =
            crate::commit_index::batcher::read_all_entries(&dir.path().join("global/commit-index"))
                .unwrap();
        assert_eq!(entries.len(), 1, "rejected placement must not be durable");
        assert_eq!(
            decode(
                &engine
                    .projection_state()
                    .get(INDEX, channel_id.as_bytes())
                    .unwrap()
            )
            .unwrap()
            .epoch,
            1
        );

        let (second, second_rx) = make_command(2);
        sender.send(second).await.unwrap();
        second_rx.await.unwrap().unwrap();
        assert_eq!(
            decode(
                &engine
                    .projection_state()
                    .get(INDEX, channel_id.as_bytes())
                    .unwrap()
            )
            .unwrap()
            .epoch,
            2
        );
    }

    #[tokio::test]
    async fn fenced_replica_validates_and_applies_ordered_segment_extensions() {
        let source_dir = tempdir().unwrap();
        let replica_dir = tempdir().unwrap();
        let source = WabiDbEngine::open(replica_test_config(source_dir.path()))
            .await
            .unwrap();
        let stream_id = "channel:regional-probe";
        source.get_or_create_stream_key(stream_id).await.unwrap();
        let commit = |payload: &[u8]| {
            let (response_tx, _response_rx) = tokio::sync::oneshot::channel();
            CommandCommit {
                room_owner_precondition: None,
                caller_user_id: 1,
                caller_device_id: "regional-device".into(),
                command_name: "regional_probe".into(),
                idempotency_key: None,
                events: vec![EventToWrite {
                    stream_id: stream_id.into(),
                    event_type: "regional_probe_event".into(),
                    stream_kind: 1,
                    record_kind: RecordKind::Event,
                    plaintext: payload.to_vec(),
                }],
                essential: true,
                response_tx,
            }
        };
        source.run_command(commit(b"first")).await.unwrap();
        let index_dir = source_dir.path().join("global/commit-index");
        let first_entry = crate::commit_index::batcher::read_all_entries(&index_dir)
            .unwrap()
            .remove(0);
        let segment_path = source_dir
            .path()
            .join("streams/channel/channel:regional-probe/events/00000001.wseg");
        let first_segment = tokio::fs::read(&segment_path).await.unwrap();

        source.run_command(commit(b"second")).await.unwrap();
        let entries = crate::commit_index::batcher::read_all_entries(&index_dir).unwrap();
        let second_entry = entries[1].clone();
        let extended_segment = tokio::fs::read(&segment_path).await.unwrap();
        assert!(extended_segment.starts_with(&first_segment));

        tokio::fs::write(replica_dir.path().join(WRITER_FENCE_MARKER), b"fenced\n")
            .await
            .unwrap();
        let replica = WabiDbEngine::open(replica_test_config(replica_dir.path()))
            .await
            .unwrap();
        assert!(replica.local_writer_fenced().await);
        assert!(replica.durable_writer_fenced());
        let first = (stream_id.into(), 1, 1, first_segment.clone());
        replica
            .ingest_replicated_commit(first_entry.clone(), vec![first])
            .await
            .unwrap();
        assert_eq!(replica.barrier().current(), first_entry.commit_seq);
        assert_eq!(
            replica
                .projection_state()
                .get("events", b"regional_probe_event"),
            Some(b"first".to_vec())
        );

        let mut corrupt = extended_segment.clone();
        corrupt[second_entry.event_refs[0].offset as usize
            + crate::format::record::HEADER_LEN as usize] ^= 1;
        assert!(replica
            .ingest_replicated_commit(
                second_entry.clone(),
                vec![(stream_id.into(), 1, 1, corrupt)]
            )
            .await
            .is_err());
        let replica_segment = replica_dir
            .path()
            .join("streams/channel/channel:regional-probe/events/00000001.wseg");
        assert_eq!(
            tokio::fs::read(&replica_segment).await.unwrap(),
            first_segment
        );

        let second = (stream_id.into(), 1, 1, extended_segment.clone());
        replica
            .ingest_replicated_commit(second_entry.clone(), vec![second.clone()])
            .await
            .unwrap();
        replica
            .ingest_replicated_commit(second_entry.clone(), vec![second])
            .await
            .unwrap();
        assert_eq!(
            tokio::fs::read(&replica_segment).await.unwrap(),
            extended_segment
        );
        assert_eq!(replica.barrier().current(), second_entry.commit_seq);
        assert_eq!(
            replica
                .projection_state()
                .get("events", b"regional_probe_event"),
            Some(b"second".to_vec())
        );
        assert_eq!(
            crate::commit_index::batcher::read_all_entries(
                &replica_dir.path().join("global/commit-index")
            )
            .unwrap()
            .len(),
            2
        );

        assert!(source
            .ingest_replicated_commit(second_entry.clone(), vec![])
            .await
            .is_err());
        *source.write_fence.write().await = true;
        assert!(!source.durable_writer_fenced());
        assert!(source
            .ingest_replicated_commit(second_entry, vec![])
            .await
            .is_err());
        drop(replica);
        let restarted = WabiDbEngine::open(replica_test_config(replica_dir.path()))
            .await
            .unwrap();
        assert!(restarted.local_writer_fenced().await);
        assert_eq!(
            restarted
                .projection_state()
                .get("events", b"regional_probe_event"),
            Some(b"second".to_vec())
        );
    }

    #[tokio::test]
    async fn open_with_provided_key() {
        let dir = tempdir().unwrap();
        let config = WabiDbConfig {
            data_dir: dir.path().to_path_buf(),
            bootstrap_source: BootstrapSource::Provided([0xABu8; 32]),
            bootstrap_salt: None,
            allow_init: true,
            replication_config: None,
            sync_transport: None,
            test_boot_wallclock_override: None,
        };
        let engine = WabiDbEngine::open(config).await.unwrap();
        assert_eq!(engine.bootstrap_key(), &[0xABu8; 32]);
        assert_eq!(engine.data_dir(), dir.path());
        assert!(engine.sequencer.is_some());
        assert!(engine.is_writer_running());
        assert!(engine.is_healthy());
        assert!(engine._lock_file_path.is_some());
    }

    #[test]
    fn projection_only_test_engine_does_not_claim_a_live_writer() {
        let engine = WabiDbEngine::new_for_tests();
        assert!(engine.projection_state().is_healthy());
        assert!(!engine.is_writer_running());
        assert!(!engine.is_healthy());
    }

    #[tokio::test]
    async fn open_with_missing_dir_requires_allow_init() {
        let dir = tempdir().unwrap();
        let missing = dir.path().join("nope");
        let config = WabiDbConfig {
            data_dir: missing,
            bootstrap_source: BootstrapSource::Provided([0u8; 32]),
            bootstrap_salt: None,
            allow_init: false,
            replication_config: None,
            sync_transport: None,
            test_boot_wallclock_override: None,
        };
        let err = WabiDbEngine::open(config).await.unwrap_err();
        assert!(matches!(err, WabiError::Corrupt { .. }), "got {err:?}");
    }

    #[tokio::test]
    async fn open_with_allow_init_creates_dir() {
        let dir = tempdir().unwrap();
        let new_dir = dir.path().join("new");
        let config = WabiDbConfig {
            data_dir: new_dir.clone(),
            bootstrap_source: BootstrapSource::Provided([0u8; 32]),
            bootstrap_salt: None,
            allow_init: true,
            replication_config: None,
            sync_transport: None,
            test_boot_wallclock_override: None,
        };
        let engine = WabiDbEngine::open(config).await.unwrap();
        assert!(new_dir.exists());
        assert_eq!(engine.data_dir(), new_dir);
    }

    #[tokio::test]
    async fn open_with_keychain_errors() {
        let dir = tempdir().unwrap();
        let config = WabiDbConfig {
            data_dir: dir.path().to_path_buf(),
            bootstrap_source: BootstrapSource::Keychain,
            bootstrap_salt: None,
            allow_init: true,
            replication_config: None,
            sync_transport: None,
            test_boot_wallclock_override: None,
        };
        let err = WabiDbEngine::open(config).await.unwrap_err();
        assert!(matches!(err, WabiError::KeychainUnavailable), "got {err:?}");
    }

    #[tokio::test]
    async fn open_creates_lock_file() {
        let dir = tempdir().unwrap();
        let config = WabiDbConfig {
            data_dir: dir.path().to_path_buf(),
            bootstrap_source: BootstrapSource::Provided([0u8; 32]),
            bootstrap_salt: None,
            allow_init: true,
            replication_config: None,
            sync_transport: None,
            test_boot_wallclock_override: None,
        };
        let engine = WabiDbEngine::open(config).await.unwrap();
        let lock_path = dir.path().join(".lock");
        assert!(lock_path.exists(), "lock file should exist");
        let pid_str = std::fs::read_to_string(&lock_path).unwrap();
        let pid: u32 = pid_str.trim().parse().unwrap();
        assert_eq!(pid, std::process::id());
        // Cleanup (Drop handles it, but verify it doesn't error)
        drop(engine);
        assert!(
            !lock_path.exists(),
            "lock file should be cleaned up on drop"
        );
    }

    #[tokio::test]
    async fn open_creates_storage_manifest() {
        let dir = tempdir().unwrap();
        let config = WabiDbConfig {
            data_dir: dir.path().to_path_buf(),
            bootstrap_source: BootstrapSource::Provided([0u8; 32]),
            bootstrap_salt: None,
            allow_init: true,
            replication_config: None,
            sync_transport: None,
            test_boot_wallclock_override: None,
        };
        let _engine = WabiDbEngine::open(config).await.unwrap();
        let manifest_path = dir.path().join("storage-manifest.json");
        assert!(manifest_path.exists(), "manifest file should exist");
        let text = std::fs::read_to_string(&manifest_path).unwrap();
        assert!(text.contains("\"schema_version\": 1"));
        assert!(text.contains("\"engine_version\": \"0.1.0\""));
    }

    #[tokio::test]
    async fn lock_file_prevents_second_engine() {
        let dir = tempdir().unwrap();
        let config = WabiDbConfig {
            data_dir: dir.path().to_path_buf(),
            bootstrap_source: BootstrapSource::Provided([0u8; 32]),
            bootstrap_salt: None,
            allow_init: true,
            replication_config: None,
            sync_transport: None,
            test_boot_wallclock_override: None,
        };
        let _engine = WabiDbEngine::open(config.clone()).await.unwrap();

        // Second open on the same dir should fail with AlreadyRunning
        let err = WabiDbEngine::open(config).await.unwrap_err();
        assert!(
            matches!(err, WabiError::AlreadyRunning),
            "expected AlreadyRunning, got {err:?}"
        );
    }

    #[tokio::test]
    async fn open_creates_commit_index_dir() {
        let dir = tempdir().unwrap();
        let config = WabiDbConfig {
            data_dir: dir.path().to_path_buf(),
            bootstrap_source: BootstrapSource::Provided([0u8; 32]),
            bootstrap_salt: None,
            allow_init: true,
            replication_config: None,
            sync_transport: None,
            test_boot_wallclock_override: None,
        };
        let _engine = WabiDbEngine::open(config).await.unwrap();
        let cidx_dir = dir.path().join("global").join("commit-index");
        assert!(cidx_dir.exists(), "commit index dir should exist");
    }

    #[tokio::test]
    async fn stale_same_pid_lock_is_stolen_container_restart() {
        // Container restart scenario: the previous run (same PID in a fresh
        // PID namespace — Docker containers always boot at PID 1) crashed
        // leaving its .lock behind. The new boot must steal it, not refuse.
        let dir = tempdir().unwrap();
        let lock_path = dir.path().join(".lock");

        // Simulate the previous incarnation's lock: same PID as ours,
        // mtime in the past relative to the (overridden) boot wallclock.
        std::fs::write(&lock_path, std::process::id().to_string()).unwrap();

        let config = WabiDbConfig {
            data_dir: dir.path().to_path_buf(),
            bootstrap_source: BootstrapSource::Provided([0u8; 32]),
            bootstrap_salt: None,
            allow_init: true,
            replication_config: None,
            sync_transport: None,
            // Boot "before" the lock was written: exactly the container
            // restart situation, deterministic regardless of mtime precision.
            test_boot_wallclock_override: Some(std::time::SystemTime::now()),
        };
        // Must succeed: the stale same-PID lock is recognized and stolen.
        let engine = WabiDbEngine::open(config).await.unwrap();
        assert_eq!(engine.data_dir(), dir.path());
    }

    #[tokio::test]
    async fn fresh_live_sibling_lock_is_respected() {
        // A lock written AFTER our boot wallclock with a live-looking PID is
        // a genuine concurrent sibling: must still be refused. We simulate by
        // writing a different PID and then rewinding the file mtime is not
        // possible portably — instead write a DIFFERENT live PID (our own +1
        // may not exist; use a PID that exists: our own) but set mtime to now
        // via a touch after BOOT_WALLCLOCK was captured... simplest portable
        // proof: holder == pid + mtime >= boot wallclock cannot happen for a
        // file we did not create this run, so exercise the OTHER arm: a
        // different, definitely-dead PID must be stolen too (existing rule),
        // while an ALIVE different PID is refused.
        //
        // Find a PID that exists but is not us: read any /proc entry != ours.
        let other_alive: Option<u32> = {
            #[cfg(unix)]
            {
                std::fs::read_dir("/proc").ok().and_then(|entries| {
                    entries.filter_map(|e| e.ok()).find_map(|e| {
                        e.file_name()
                            .to_str()?
                            .parse::<u32>()
                            .ok()
                            .filter(|p| *p != std::process::id())
                    })
                })
            }
            #[cfg(not(unix))]
            {
                None
            }
        };
        let Some(other) = other_alive else {
            // No other process to test against (shouldn't happen on Linux);
            // nothing to assert here.
            return;
        };

        let dir = tempdir().unwrap();
        let lock_path = dir.path().join(".lock");
        std::fs::write(&lock_path, other.to_string()).unwrap();

        let config = WabiDbConfig {
            data_dir: dir.path().to_path_buf(),
            bootstrap_source: BootstrapSource::Provided([0u8; 32]),
            bootstrap_salt: None,
            allow_init: true,
            replication_config: None,
            sync_transport: None,
            test_boot_wallclock_override: None,
        };
        let err = WabiDbEngine::open(config).await.unwrap_err();
        assert!(
            matches!(err, WabiError::AlreadyRunning),
            "a LIVE different-pid holder must keep its lock; got {err:?}"
        );
    }
}
