//! Engine startup and bootstrap.
//!
//! The `WabiDbEngine` is the main entry point for the storage engine.
//! Opening an engine involves: validating the data directory, acquiring
//! a lock file, loading the bootstrap key, reading/writing the storage
//! manifest, and initializing the commit sequencer, projection dispatcher,
//! and linearizability barrier.

pub mod locks;
pub mod replay;
pub mod wabi_store;

use crate::commit_index::batcher::{new_batcher, BatcherHandle};
use crate::commit_index::record::CommitIndexEntry;
use crate::crypto::bootstrap::{load_bootstrap_key, BootstrapSource};
use crate::crypto::stream_key_registry::StreamKeyRegistry;
use crate::engine::locks::{spawn_projection_dispatcher, ProjectionState, SequencerPermit};
use crate::error::{ErrorCategory, Result, WabiError};
use crate::projections::barrier::LinearizabilityBarrier;
use crate::projections::handler::DispatchTable;
use crate::replication::{new_noop_transport, SyncTransport};
use crate::sequencer::run_command::{run_command as submit_command_inner, CommitSequencer};
use crate::engine::locks::DispatchItem;
use crate::sequencer::types::{CommandCommit, CommandOutcome};
use crate::storage::fsync::fsync_dir;
use crate::subscription::engine::SubscriptionEngine;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::{broadcast, mpsc, Semaphore};

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
    /// a background sync worker that periodically pulls/pushes commit index
    /// entries with the configured peer.
    pub replication_config: Option<crate::replication::config::ReplicationConfig>,

    /// Transport implementation for replication. `None` = `NoopTransport`
    /// (single-node mode). Set to `Some(...)` with an HTTP-based transport
    /// for multi-node sync.
    pub sync_transport: Option<std::sync::Arc<dyn SyncTransport>>,
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
        }
    }
}

/// The main WabiDB engine. Holds all runtime components: sequencer,
/// projection state, dispatcher, subscription engine, and lock-file tracking.
pub struct WabiDbEngine {
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
    /// Join handle for the background sync worker.
    _sync_handle: Option<tokio::task::JoinHandle<()>>,
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
        let data_dir = &config.data_dir;

        // 1. Validate / create data directory
        if !data_dir.exists() {
            if config.allow_init {
                tokio::fs::create_dir_all(data_dir).await.map_err(|e| {
                    WabiError::Corrupt {
                        location: format!("data dir create: {}", data_dir.display()),
                        detail: format!("create_dir_all failed: {e}"),
                    }
                })?;
            } else {
                return Err(WabiError::Corrupt {
                    location: format!("data dir: {}", data_dir.display()),
                    detail: "does not exist; pass allow_init=true to create".into(),
                });
            }
        }

        // 2. Lock file: write PID, fsync file + parent directory
        let lock_path = data_dir.join(".lock");
        if lock_path.exists() {
            return Err(WabiError::AlreadyRunning);
        }
        let pid = std::process::id();
        tokio::fs::write(&lock_path, pid.to_string()).await.map_err(|e| {
            WabiError::Io(std::io::Error::new(e.kind(), format!("lock file write: {e}")))
        })?;
        {
            let f = tokio::fs::File::open(&lock_path).await.map_err(WabiError::Io)?;
            f.sync_all().await.map_err(WabiError::Io)?;
        }
        fsync_dir(data_dir).await?;

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
            tokio::fs::write(&manifest_path, &manifest_bytes).await.map_err(WabiError::Io)?;
            {
                let f = tokio::fs::File::open(&manifest_path).await.map_err(WabiError::Io)?;
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
        let projection_state = if let Some((state, _watermark)) =
            ProjectionState::load_snapshot(data_dir)?
        {
            Arc::new(state)
        } else {
            Arc::new(ProjectionState::new())
        };
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

        // 7.2 Replay events after the snapshot watermark
        replay::replay_projections(
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
        tokio::fs::create_dir_all(&commit_index_dir).await.map_err(WabiError::Io)?;
        let (batcher, batcher_fut) = new_batcher(commit_index_dir, None, None);
        let replication_batcher = Some(batcher.clone());
        tokio::spawn(batcher_fut);

        // 9. Create command channel and acquire the sequencer permit
        let (cmd_tx, cmd_rx) = mpsc::channel::<CommandCommit>(1024);
        let sem = Arc::new(Semaphore::new(1));
        let permit = SequencerPermit::acquire(&sem).await?;

        // 10. Spawn the sequencer task
        let data_dir_clone = data_dir.clone();
        let barrier_clone = Arc::clone(&barrier);
        let key_registry_for_engine = Arc::clone(&key_registry);
        let sequencer_handle = tokio::spawn(async move {
            crate::sequencer::run(
                permit,
                key_registry,
                batcher,
                dispatcher_tx,
                barrier_clone,
                cmd_rx,
                data_dir_clone,
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
            let commit_index_dir = data_dir.join("global").join("commit-index");
            let peer_endpoint = rep_config.peer_endpoint.clone();
            let interval = Duration::from_micros(rep_config.sync_interval_micros);
            let handle = tokio::spawn(async move {
                // Track the last commit_seq we've ingested from the peer.
                let mut last_peer_seq: u64 = 0u64;
                loop {
                    tokio::time::sleep(interval).await;

                    // Pull new entries from the peer (since last_peer_seq).
                    // Pulled entries carry hashes but not segment data, so
                    // ingestion requires a separate fetch call (not yet
                    // implemented in this session). We track the watermark
                    // for future use.
                    if let Ok(entries) = sync_transport
                        .pull(&peer_endpoint, last_peer_seq)
                        .await
                    {
                        if !entries.is_empty() {
                            last_peer_seq = entries.last().unwrap().commit_seq;
                            tracing::info!(
                                "replication: pulled {} entries from peer (up to seq {})",
                                entries.len(),
                                last_peer_seq,
                            );
                        }
                    }

                    // Push local entries to the peer (segment shipping).
                    if let Ok(local) = crate::commit_index::batcher::read_all_entries(
                        &commit_index_dir,
                    ) {
                        if !local.is_empty() {
                            tracing::info!(
                                "replication: pushing {} entries to peer",
                                local.len()
                            );
                            let _ = sync_transport
                                .push(&peer_endpoint, local)
                                .await;
                        }
                    }
                }
            });
            Some(handle)
        } else {
            None
        };

        tracing::info!("WabiDbEngine opened at {}", data_dir.display());

        Ok(Self {
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
            _sync_handle: sync_handle,
        })
    }

    /// The data directory this engine is bound to.
    pub fn data_dir(&self) -> &std::path::Path {
        &self.data_dir
    }

    /// The bootstrap key (32 bytes). Held in memory only.
    pub fn bootstrap_key(&self) -> &[u8; 32] {
        &self.bootstrap_key
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
    pub async fn register_stream_key(
        &self,
        stream_id: &str,
        key_material: [u8; 32],
    ) -> Result<()> {
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

    /// Ingest a replicated commit from a peer (segment shipping model).
    ///
    /// Writes each segment file to the correct stream events directory, then
    /// submits the `CommitIndexEntry` to the batcher and fsyncs.
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

        // Write each segment file
        for (stream_id, stream_kind, segment_id, data) in &segments {
            let kind_dir = crate::sequencer::stream_kind_dir_name(*stream_kind);
            let seg_dir = self
                .data_dir
                .join("streams")
                .join(kind_dir)
                .join(stream_id)
                .join("events");
            tokio::fs::create_dir_all(&seg_dir).await.map_err(WabiError::Io)?;

            let seg_path = seg_dir.join(format!("{segment_id:08}.wseg"));
            let mut file = tokio::fs::File::create(&seg_path).await.map_err(WabiError::Io)?;
            file.write_all(data).await.map_err(WabiError::Io)?;
            file.sync_all().await.map_err(WabiError::Io)?;
        }

        // Submit entry to batcher and flush
        match &self.replication_batcher {
            Some(batcher) => {
                batcher.submit(entry)?;
                batcher.flush_now().await
            }
            None => Err(WabiError::InternalInvariantViolated {
                invariant: "engine has no replication batcher (not fully opened)".into(),
            }),
        }
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
        let matches = self.subscription_engine.lock().await.deliver(stream_id, &item);
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
            data_dir,
            bootstrap_key: [0u8; 32],
            dispatch_table: Arc::new(DispatchTable::new(vec![]).unwrap()),
            projection_state: Arc::new(ProjectionState::new()),
            barrier: Arc::new(LinearizabilityBarrier::new(Arc::new(ProjectionState::new()))),
            sequencer: None,
            _sequencer_handle: None,
            key_registry: Arc::new(tokio::sync::Mutex::new(StreamKeyRegistry::new())),
            _lock_file_path: None,
            subscription_engine: tokio::sync::Mutex::new(SubscriptionEngine::new()),
            delivery_tx,
            sync_transport: new_noop_transport(),
            replication_batcher: None,
            _sync_handle: None,
        }
    }

    /// The error category of any future engine-open errors.
    #[allow(dead_code)]
    fn _category() -> ErrorCategory {
        ErrorCategory::Sequencer
    }
}

impl Drop for WabiDbEngine {
    fn drop(&mut self) {
        // Persist projection state snapshot before shutdown.
        if !self.data_dir.as_os_str().is_empty() {
            let _ = self.projection_state.save_snapshot(&self.data_dir);
        }

        // Zero the bootstrap key before dropping.
        use zeroize::Zeroize;
        self.bootstrap_key.zeroize();

        if let Some(ref lock_path) = self._lock_file_path {
            let _ = std::fs::remove_file(lock_path);
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
    use crate::projections::channels::ChannelProjection;
    use crate::projections::channel_members::ChannelMembersProjection;
    use crate::projections::dm_identities::DmIdentitiesProjection;
    use crate::projections::dm_message_recipients::DmMessageRecipientsProjection;
    use crate::projections::dm_messages::DmMessagesProjection;
    use crate::projections::call_participants::CallParticipantsProjection;
    use crate::projections::call_sessions::CallSessionsProjection;
    use crate::projections::call_signals::CallSignalsProjection;
    use crate::projections::emotes::EmotesProjection;
    use crate::projections::forum::ForumProjection;
    use crate::projections::incidents::IncidentProjection;
    use crate::projections::layouts::LayoutsProjection;
    use crate::projections::lore::{LoreCommitProjection, LoreRepoProjection};
    use crate::projections::messages::MessagesProjection;
    use crate::projections::noop::NoopProjection;
    use crate::projections::reactions::ReactionsProjection;
    use crate::projections::registry::{ProjectionRegistration, TypeRegistry};
    use crate::projections::users::UsersProjection;
    use crate::projections::owner::OwnerProjection;
    use crate::projections::webhooks::WebhooksProjection;
    use crate::projections::wiki::WikiProjection;
    use std::sync::Arc;

    let entries = vec![
        ProjectionRegistration {
            event_types: &["role_assigned", "role_removed", "channel_settings_updated"],
            handler: Arc::new(AuditProjection),
            index_name: "audit",
            record_type_name: "wabidb::projections::audit::AuditEntry",
        },
        ProjectionRegistration {
            event_types: &["message_created", "message_edited", "message_deleted"],
            handler: Arc::new(MessagesProjection),
            index_name: "messages",
            record_type_name: "wabidb::projections::messages::MessageRecord",
        },
        ProjectionRegistration {
            event_types: &["reaction_added"],
            handler: Arc::new(ReactionsProjection),
            index_name: "reactions",
            record_type_name: "wabidb::projections::reactions::Reaction",
        },
        ProjectionRegistration {
            event_types: &["channel_member_added"],
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
            event_types: &["user_registered"],
            handler: Arc::new(UsersProjection),
            index_name: "users",
            record_type_name: "wabidb::projections::users::UserRecord",
        },
        ProjectionRegistration {
            event_types: &["owner_claimed"],
            handler: Arc::new(OwnerProjection),
            index_name: "server_meta",
            record_type_name: "wabidb::projections::owner::OwnerRecord",
        },
        ProjectionRegistration {
            event_types: &["emote_upserted"],
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
            event_types: &["channel_created"],
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
            event_types: &["forum_thread_created", "forum_post_created", "forum_post_edited", "forum_post_deleted"],
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
            index_name: "albums",
            record_type_name: "wabidb::projections::albums::AlbumRecord",
        },
        ProjectionRegistration {
            event_types: &["album_item_added", "album_item_updated", "album_item_removed"],
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
            event_types: &["lore_commit"],
            handler: Arc::new(LoreCommitProjection),
            index_name: "lore_commits",
            record_type_name: "wabidb::projections::lore::LoreCommitRecord",
        },
        ProjectionRegistration {
            event_types: &["reaction_removed", "member_joined", "member_left", "channel_renamed"],
            handler: Arc::new(NoopProjection),
            index_name: "",
            record_type_name: "",
        },
    ];
    TypeRegistry::new(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

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
        };
        let engine = WabiDbEngine::open(config).await.unwrap();
        assert_eq!(engine.bootstrap_key(), &[0xABu8; 32]);
        assert_eq!(engine.data_dir(), dir.path());
        assert!(engine.sequencer.is_some());
        assert!(engine._lock_file_path.is_some());
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
        };
        let err = WabiDbEngine::open(config).await.unwrap_err();
        assert!(
            matches!(err, WabiError::Corrupt { .. }),
            "got {err:?}"
        );
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
        };
        let err = WabiDbEngine::open(config).await.unwrap_err();
        assert!(
            matches!(err, WabiError::KeychainUnavailable),
            "got {err:?}"
        );
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
        };
        let engine = WabiDbEngine::open(config).await.unwrap();
        let lock_path = dir.path().join(".lock");
        assert!(lock_path.exists(), "lock file should exist");
        let pid_str = std::fs::read_to_string(&lock_path).unwrap();
        let pid: u32 = pid_str.trim().parse().unwrap();
        assert_eq!(pid, std::process::id());
        // Cleanup (Drop handles it, but verify it doesn't error)
        drop(engine);
        assert!(!lock_path.exists(), "lock file should be cleaned up on drop");
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
        };
        let _engine = WabiDbEngine::open(config).await.unwrap();
        let cidx_dir = dir.path().join("global").join("commit-index");
        assert!(cidx_dir.exists(), "commit index dir should exist");
    }
}
