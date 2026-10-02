//! Transactional OpenRaft storage. Votes, log IO, applied state and snapshot
//! installation use immediate redb durability and one owned IO lane. No WabiDB
//! file, key, marker, projection or runtime is opened by this module.
use crate::{model::*, snapshot::BoundedSnapshot, ConsensusTypes, Entry, LogId, Membership};
use fs4::fs_std::FileExt;
use openraft::{
    storage::LogFlushed, EntryPayload, LogState, RaftLogReader, RaftSnapshotBuilder, Snapshot,
    SnapshotMeta, StorageError, StorageIOError, Vote,
};
use redb::{Database, Durability, ReadableTable, ReadableTableMetadata, TableDefinition};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    ops::{Bound, RangeBounds},
    path::{Path, PathBuf},
    sync::Arc,
};

const META: TableDefinition<&str, &[u8]> = TableDefinition::new("control_metadata_v1");
const LOGS: TableDefinition<u64, &[u8]> = TableDefinition::new("raft_log_v1");
const FORMAT: &str = "wabi-control-v1/openraft-0.9.25-json";
const FORMAT_V2: &str = "wabi-control-v2/openraft-0.9.25-json";
const MAX_ENTRY_BYTES: usize = 1024 * 1024;
const MAX_BATCH_ENTRIES: usize = 1024;
const MAX_BATCH_BYTES: usize = 8 * 1024 * 1024;
const MAX_OPERATIONS: usize = 16384;
const MAX_PARTITIONS: usize = 4096;

fn entry_preflight(entry: &Entry) -> Result<()> {
    let bounded = match &entry.payload {
        EntryPayload::Blank => true,
        EntryPayload::Normal(ControlData::Legacy(command)) => {
            command.operation_id.len() <= 32
                && command.partition_id.len() <= 128
                && command.checkpoint_inventory_sha256.len() <= 64
        }
        #[cfg(target_os = "linux")]
        EntryPayload::Normal(ControlData::Checkpoint(command)) => command.bounds(),
        EntryPayload::Membership(membership) => {
            membership.nodes().count() <= 64
                && membership.get_joint_config().len() <= 2
                && membership
                    .get_joint_config()
                    .iter()
                    .all(|set| set.len() <= 64)
                && membership.nodes().all(|(_, peer)| {
                    peer.community_id.len() <= 64
                        && peer.site_id.len() <= 128
                        && peer.public_key.len() <= 64
                        && peer.rpc_address.len() <= 128
                })
        }
    };
    if bounded {
        Ok(())
    } else {
        Err(StoreError::Budget)
    }
}

#[derive(Clone, Debug)]
pub struct StoreLimits {
    pub max_log_entries: u64,
    pub max_log_bytes: u64,
    pub max_snapshot_bytes: u64,
    pub max_database_bytes: u64,
    pub min_free_bytes: u64,
}
impl Default for StoreLimits {
    fn default() -> Self {
        Self {
            max_log_entries: 100_000,
            max_log_bytes: 64 * 1024 * 1024,
            max_snapshot_bytes: 16 * 1024 * 1024,
            max_database_bytes: 256 * 1024 * 1024,
            min_free_bytes: 64 * 1024 * 1024,
        }
    }
}
impl StoreLimits {
    fn valid(&self) -> bool {
        self.max_log_entries > 0
            && self.max_log_entries <= 100_000
            && self.max_log_bytes > 0
            && self.max_log_bytes <= 64 * 1024 * 1024
            && self.max_snapshot_bytes > 0
            && self.max_snapshot_bytes <= 16 * 1024 * 1024
            && self.max_database_bytes >= 16 * 1024 * 1024
            && self.max_database_bytes <= 1024 * 1024 * 1024
            && self.min_free_bytes > 0
    }
}

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("invalid consensus store format or binding")]
    Format,
    #[error("consensus store resource budget exceeded")]
    Budget,
    #[error("consensus store already owned or unsafe")]
    Ownership,
    #[error("consensus store IO failed")]
    Io,
}
type Result<T> = std::result::Result<T, StoreError>;
fn io<T>(value: std::result::Result<T, impl std::fmt::Display>) -> Result<T> {
    value.map_err(|_| StoreError::Io)
}
fn encode(value: &impl Serialize) -> Result<Vec<u8>> {
    serde_json::to_vec(value).map_err(|_| StoreError::Format)
}
fn decode<T: DeserializeOwned>(bytes: &[u8]) -> Result<T> {
    if bytes.len() > 16 * 1024 * 1024 {
        return Err(StoreError::Budget);
    }
    serde_json::from_slice(bytes).map_err(|_| StoreError::Format)
}
fn read_error(error: StoreError) -> StorageError<u64> {
    StorageIOError::read(&error).into()
}
fn write_error(error: StoreError) -> StorageError<u64> {
    StorageIOError::write(&error).into()
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DatabaseIdentity {
    schema_version: u8,
    format: String,
    binding: StoreBinding,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EntryEnvelope {
    schema_version: u8,
    entry: Entry,
}
fn entry_schema(entry: &Entry) -> u8 {
    match &entry.payload {
        EntryPayload::Normal(data) => data.schema(),
        _ => CONTROL_SCHEMA,
    }
}
fn schema_supported(schema: u8) -> bool {
    schema == CONTROL_SCHEMA || (cfg!(target_os = "linux") && schema == 2)
}
fn identity_valid(identity: &DatabaseIdentity, binding: &StoreBinding) -> bool {
    identity.binding == *binding
        && match identity.schema_version {
            1 => identity.format == FORMAT,
            2 => cfg!(target_os = "linux") && identity.format == FORMAT_V2,
            _ => false,
        }
}

struct Inner {
    db: Database,
    // Field ordering closes redb before releasing the persistent lock inode.
    _lock: File,
    root: PathBuf,
    binding: StoreBinding,
    limits: StoreLimits,
    #[cfg(unix)]
    root_identity: (u64, u64),
    #[cfg(unix)]
    database_identity: (u64, u64),
    // Optional process-local lease. Destroy it AFTER redb and the original
    // advisory lock, including when the last owner is a detached IO task.
    _runtime_owner: Option<Arc<dyn Send + Sync>>,
}
#[derive(Clone)]
pub struct Store {
    inner: Arc<Inner>,
    lane: Arc<tokio::sync::Mutex<()>>,
}

fn meta<T: DeserializeOwned>(transaction: &redb::ReadTransaction, key: &str) -> Result<T> {
    let table = io(transaction.open_table(META))?;
    let value = io(table.get(key))?.ok_or(StoreError::Format)?;
    decode(value.value())
}
fn writable_meta<T: DeserializeOwned>(
    transaction: &redb::WriteTransaction,
    key: &str,
) -> Result<T> {
    let table = io(transaction.open_table(META))?;
    let value = io(table.get(key))?.ok_or(StoreError::Format)?;
    decode(value.value())
}
fn put(transaction: &redb::WriteTransaction, key: &str, value: &impl Serialize) -> Result<()> {
    let bytes = encode(value)?;
    io(io(transaction.open_table(META))?.insert(key, bytes.as_slice()))?;
    Ok(())
}
fn read_state(inner: &Inner, transaction: &redb::ReadTransaction) -> Result<ControlState> {
    let table = io(transaction.open_table(META))?;
    let value = io(table.get("state"))?.ok_or(StoreError::Format)?;
    if value.value().len() as u64 > inner.limits.max_snapshot_bytes {
        return Err(StoreError::Budget);
    }
    let envelope = decode_state(value.value())?;
    validate_state(inner, &envelope)?;
    let identity: DatabaseIdentity = meta(transaction, "identity")?;
    if !identity_valid(&identity, &inner.binding)
        || envelope.schema_version > identity.schema_version
    {
        return Err(StoreError::Format);
    }
    Ok(envelope.state)
}
fn decode_state(bytes: &[u8]) -> Result<StateEnvelope> {
    let state: StateEnvelope = decode(bytes)?;
    if state.schema_version == 2 && encode(&state)?.as_slice() != bytes {
        return Err(StoreError::Format);
    }
    Ok(state)
}
fn validate_state(inner: &Inner, envelope: &StateEnvelope) -> Result<()> {
    let used = envelope.state.operations.len();
    #[cfg(target_os = "linux")]
    let used = used.saturating_add(envelope.state.checkpoints.len());
    #[cfg(target_os = "linux")]
    if (!envelope.state.checkpoints.is_empty() && envelope.schema_version != 2)
        || !envelope
            .state
            .checkpoints_coherent(&inner.binding.community_id, &inner.binding.partition_id)
    {
        return Err(StoreError::Format);
    }
    if !schema_supported(envelope.schema_version)
        || envelope.community_id != inner.binding.community_id
        || envelope.partition_id != inner.binding.partition_id
        || used > MAX_OPERATIONS
        || envelope.state.intents.len() > MAX_PARTITIONS
        || !envelope.state.coherent()
        || envelope.state.operations.iter().any(|(id, record)| {
            id != &record.command.operation_id
                || !record.command.valid()
                || record.reply.canonical_writer_permitted
        })
        || envelope.state.intents.iter().any(|(partition, record)| {
            !identifier_valid(partition)
                || record.epoch == 0
                || record.proposed_writer == 0
                || !digest_valid(&record.checkpoint_inventory_sha256)
        })
    {
        return Err(StoreError::Format);
    }
    Ok(())
}
fn envelope(inner: &Inner, state: ControlState, schema: u8) -> StateEnvelope {
    StateEnvelope {
        schema_version: schema,
        community_id: inner.binding.community_id.clone(),
        partition_id: inner.binding.partition_id.clone(),
        state,
    }
}
fn current_schema(inner: &Inner) -> Result<u8> {
    let identity: DatabaseIdentity = meta(&io(inner.db.begin_read())?, "identity")?;
    if !identity_valid(&identity, &inner.binding) {
        return Err(StoreError::Format);
    }
    Ok(identity.schema_version)
}
fn snapshot_id(schema: u8, bytes: &[u8]) -> String {
    format!("v{schema}-{}", hex::encode(Sha256::digest(bytes)))
}
// Upgrade identity and any existing snapshot in the SAME transaction as the
// first V2 log/state publication. Truncation never rolls the format back.
fn upgrade_format(inner: &Inner, transaction: &redb::WriteTransaction, required: u8) -> Result<()> {
    let mut identity: DatabaseIdentity = writable_meta(transaction, "identity")?;
    if !identity_valid(&identity, &inner.binding) || !schema_supported(required) {
        return Err(StoreError::Format);
    }
    if required <= identity.schema_version {
        return Ok(());
    }
    let saved = {
        let table = io(transaction.open_table(META))?;
        let bytes = io(table.get("snapshotBytes"))?;
        if bytes
            .as_ref()
            .is_some_and(|v| v.value().len() as u64 > inner.limits.max_snapshot_bytes)
        {
            return Err(StoreError::Budget);
        }
        let bytes = bytes.map(|v| v.value().to_vec());
        let meta = io(table.get("snapshotMeta"))?.map(|v| v.value().to_vec());
        (bytes, meta)
    };
    match saved {
        (None, None) => (),
        (Some(bytes), Some(meta)) => {
            let mut state = decode_state(&bytes)?;
            validate_state(inner, &state)?;
            let mut metadata: SnapshotMeta<u64, RecoveryPeer> = decode(&meta)?;
            if metadata.last_log_id != state.state.last_applied
                || metadata.last_membership != state.state.membership
                || metadata.snapshot_id != snapshot_id(state.schema_version, &bytes)
            {
                return Err(StoreError::Format);
            }
            state.schema_version = required;
            let upgraded = encode(&state)?;
            if upgraded.len() as u64 > inner.limits.max_snapshot_bytes {
                return Err(StoreError::Budget);
            }
            metadata.snapshot_id = snapshot_id(required, &upgraded);
            put(transaction, "snapshotMeta", &metadata)?;
            io(io(transaction.open_table(META))?.insert("snapshotBytes", upgraded.as_slice()))?;
        }
        _ => return Err(StoreError::Format),
    }
    identity.schema_version = required;
    identity.format = FORMAT_V2.into();
    put(transaction, "identity", &identity)
}
fn transaction(inner: &Inner, reserve: u64) -> Result<redb::WriteTransaction> {
    inner.verify_lock()?;
    let size = io(fs::metadata(inner.root.join("consensus.redb")))?.len();
    if size
        .checked_add(reserve)
        .is_none_or(|n| n > inner.limits.max_database_bytes)
        || io(fs4::available_space(&inner.root))?
            < inner.limits.min_free_bytes.saturating_add(reserve)
    {
        return Err(StoreError::Budget);
    }
    let mut transaction = io(inner.db.begin_write())?;
    transaction.set_durability(Durability::Immediate);
    Ok(transaction)
}
impl Inner {
    fn verify_lock(&self) -> Result<()> {
        let named = io(fs::symlink_metadata(self.root.join(".lock")))?;
        if !named.is_file() || named.file_type().is_symlink() {
            return Err(StoreError::Ownership);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            let held = io(self._lock.metadata())?;
            if (named.dev(), named.ino()) != (held.dev(), held.ino()) || held.nlink() != 1 {
                return Err(StoreError::Ownership);
            }
            let directory = io(fs::symlink_metadata(&self.root))?;
            let database = io(fs::symlink_metadata(self.root.join("consensus.redb")))?;
            if !directory.is_dir()
                || directory.file_type().is_symlink()
                || (directory.dev(), directory.ino()) != self.root_identity
                || directory.permissions().mode() & 0o077 != 0
                || !database.is_file()
                || database.file_type().is_symlink()
                || (database.dev(), database.ino()) != self.database_identity
                || database.nlink() != 1
                || database.permissions().mode() & 0o077 != 0
            {
                return Err(StoreError::Ownership);
            }
        }
        Ok(())
    }
}
impl Store {
    /// Requires a private, existing directory. A different node/community or
    /// format never silently reuses or resets an existing consensus database.
    pub fn open(root: &Path, binding: StoreBinding, limits: StoreLimits) -> Result<Self> {
        if !binding.valid() || !limits.valid() {
            return Err(StoreError::Format);
        }
        let directory = io(fs::symlink_metadata(root))?;
        if !directory.is_dir() || directory.file_type().is_symlink() {
            return Err(StoreError::Ownership);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if directory.permissions().mode() & 0o077 != 0 {
                return Err(StoreError::Ownership);
            }
        }
        let root = io(fs::canonicalize(root))?;
        let lock_path = root.join(".lock");
        if let Ok(metadata) = fs::symlink_metadata(&lock_path) {
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err(StoreError::Ownership);
            }
        }
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let lock = io(options.open(&lock_path))?;
        if !lock
            .try_lock_exclusive()
            .map_err(|_| StoreError::Ownership)?
        {
            return Err(StoreError::Ownership);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let held = io(lock.metadata())?;
            let named = io(fs::symlink_metadata(&lock_path))?;
            if held.nlink() != 1
                || named.file_type().is_symlink()
                || (held.dev(), held.ino()) != (named.dev(), named.ino())
            {
                return Err(StoreError::Ownership);
            }
        }
        let db_path = root.join("consensus.redb");
        let mut options = OpenOptions::new();
        options.read(true).write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let (file, new) = match options.open(&db_path) {
            Ok(file) => (file, true),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let metadata = io(fs::symlink_metadata(&db_path))?;
                if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() == 0 {
                    return Err(StoreError::Ownership);
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::{MetadataExt, PermissionsExt};
                    if metadata.nlink() != 1 || metadata.permissions().mode() & 0o077 != 0 {
                        return Err(StoreError::Ownership);
                    }
                }
                if metadata.len() > limits.max_database_bytes {
                    return Err(StoreError::Budget);
                }
                (
                    io(OpenOptions::new().read(true).write(true).open(&db_path))?,
                    false,
                )
            }
            Err(_) => return Err(StoreError::Io),
        };
        #[cfg(unix)]
        let database_identity = {
            use std::os::unix::fs::MetadataExt;
            let metadata = io(file.metadata())?;
            (metadata.dev(), metadata.ino())
        };
        let db = io(Database::builder()
            .set_cache_size(16 * 1024 * 1024)
            .create_file(file))?;
        let inner = Arc::new(Inner {
            db,
            _lock: lock,
            root,
            binding,
            limits,
            #[cfg(unix)]
            root_identity: {
                use std::os::unix::fs::MetadataExt;
                (directory.dev(), directory.ino())
            },
            #[cfg(unix)]
            database_identity,
            _runtime_owner: None,
        });
        inner.verify_lock()?;
        if new {
            let transaction = transaction(&inner, 1024 * 1024)?;
            {
                io(transaction.open_table(META))?;
                io(transaction.open_table(LOGS))?;
            }
            put(
                &transaction,
                "identity",
                &DatabaseIdentity {
                    schema_version: CONTROL_SCHEMA,
                    format: FORMAT.into(),
                    binding: inner.binding.clone(),
                },
            )?;
            put(
                &transaction,
                "state",
                &envelope(&inner, ControlState::default(), CONTROL_SCHEMA),
            )?;
            put(&transaction, "vote", &None::<Vote<u64>>)?;
            put(&transaction, "committed", &None::<LogId>)?;
            put(&transaction, "purged", &None::<LogId>)?;
            put(&transaction, "logBytes", &0u64)?;
            io(transaction.commit())?;
            io(File::open(&inner.root))?
                .sync_all()
                .map_err(|_| StoreError::Io)?;
        }
        let transaction = io(inner.db.begin_read())?;
        let identity: DatabaseIdentity = meta(&transaction, "identity")?;
        if !identity_valid(&identity, &inner.binding) {
            return Err(StoreError::Format);
        }
        read_state(&inner, &transaction)?;
        let _: Option<Vote<u64>> = meta(&transaction, "vote")?;
        let _: Option<LogId> = meta(&transaction, "committed")?;
        let _: Option<LogId> = meta(&transaction, "purged")?;
        let bytes: u64 = meta(&transaction, "logBytes")?;
        let logs = io(transaction.open_table(LOGS))?;
        let mut observed = 0u64;
        let mut prior_index: Option<u64> = None;
        if io(logs.len())? > inner.limits.max_log_entries {
            return Err(StoreError::Budget);
        }
        for entry in io(logs.iter())? {
            let (index, value) = io(entry)?;
            if value.value().len() > MAX_ENTRY_BYTES {
                return Err(StoreError::Budget);
            }
            let record: EntryEnvelope = decode(value.value())?;
            entry_preflight(&record.entry)?;
            if record.schema_version != entry_schema(&record.entry)
                || record.schema_version > identity.schema_version
                || record.entry.log_id.index != index.value()
            {
                return Err(StoreError::Format);
            }
            if prior_index.is_some_and(|previous| previous.checked_add(1) != Some(index.value())) {
                return Err(StoreError::Format);
            }
            prior_index = Some(index.value());
            observed = observed
                .checked_add(value.value().len() as u64)
                .ok_or(StoreError::Budget)?;
        }
        if bytes != observed || bytes > inner.limits.max_log_bytes {
            return Err(StoreError::Format);
        }
        drop(logs);
        drop(transaction);
        Ok(Self {
            inner,
            lane: Arc::new(tokio::sync::Mutex::new(())),
        })
    }

    // The blocking task owns the lane and database after caller cancellation.
    // No next write can pass it until the actual immediate commit has finished.
    async fn run<T: Send + 'static>(
        &self,
        operation: impl FnOnce(&Inner) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let guard = self.lane.clone().lock_owned().await;
        let inner = self.inner.clone();
        tokio::task::spawn_blocking(move || {
            let _guard = guard;
            inner.verify_lock()?;
            operation(&inner)
        })
        .await
        .map_err(|_| StoreError::Io)?
    }
    pub async fn control_state(&self) -> Result<ControlState> {
        self.run(|inner| read_state(inner, &io(inner.db.begin_read())?))
            .await
    }
    /// Immutable binding of the actual opened control store. This is not a
    /// membership, availability or writer-permission verdict.
    pub fn binding(&self) -> &StoreBinding {
        &self.inner.binding
    }
    /// Attach only before this fresh store is cloned or supplied to Raft.
    /// The lease must not contain a Store/Inner reference (ownership cycle).
    /// Every log reader/snapshot builder and blocking IO already holds Inner.
    #[cfg(target_os = "linux")]
    pub(crate) fn with_runtime_owner(mut self, owner: Arc<dyn Send + Sync>) -> Result<Self> {
        let inner = Arc::get_mut(&mut self.inner).ok_or(StoreError::Ownership)?;
        if inner._runtime_owner.is_some() {
            return Err(StoreError::Ownership);
        }
        inner._runtime_owner = Some(owner);
        Ok(self)
    }
    /// Runtime admission, listeners, local jobs and Raft Core MUST already be
    /// stopped. No Store/Weak<Inner> escapes that owner. Count one then proves
    /// only this original Store remains: actual SM/snapshot/log-reader owners
    /// and cancelled callers' blocking Inner captures have all ceased.
    /// Do not time out or release the lease while that work remains alive.
    #[cfg(target_os = "linux")]
    pub(crate) async fn await_runtime_owners(&self) -> Result<()> {
        if self.inner._runtime_owner.is_none() {
            return Err(StoreError::Ownership);
        }
        while Arc::strong_count(&self.inner) != 1 {
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
        self.inner.verify_lock()
    }
    async fn read_value<T: DeserializeOwned + Send + 'static>(
        &self,
        key: &'static str,
    ) -> Result<T> {
        self.run(move |inner| meta(&io(inner.db.begin_read())?, key))
            .await
    }
}

#[cfg(test)]
mod tests;

impl RaftLogReader<ConsensusTypes> for Store {
    async fn try_get_log_entries<RB>(
        &mut self,
        range: RB,
    ) -> std::result::Result<Vec<Entry>, StorageError<u64>>
    where
        RB: RangeBounds<u64> + Clone + std::fmt::Debug + openraft::OptionalSend,
    {
        let bounds = (range.start_bound().cloned(), range.end_bound().cloned());
        self.run(move |inner| {
            let transaction = io(inner.db.begin_read())?;
            let table = io(transaction.open_table(LOGS))?;
            let mut result = Vec::new();
            let identity: DatabaseIdentity = meta(&transaction, "identity")?;
            if !identity_valid(&identity, &inner.binding) {
                return Err(StoreError::Format);
            }
            for entry in io(table.range(bounds))? {
                let (index, bytes) = io(entry)?;
                if bytes.value().len() > MAX_ENTRY_BYTES {
                    return Err(StoreError::Budget);
                }
                let record: EntryEnvelope = decode(bytes.value())?;
                entry_preflight(&record.entry)?;
                if record.schema_version != entry_schema(&record.entry)
                    || record.schema_version > identity.schema_version
                    || record.entry.log_id.index != index.value()
                {
                    return Err(StoreError::Format);
                }
                result.push(record.entry);
                if result.len() as u64 > inner.limits.max_log_entries {
                    return Err(StoreError::Budget);
                }
            }
            Ok(result)
        })
        .await
        .map_err(read_error)
    }
}

impl openraft::storage::RaftLogStorage<ConsensusTypes> for Store {
    type LogReader = Store;
    async fn get_log_state(
        &mut self,
    ) -> std::result::Result<LogState<ConsensusTypes>, StorageError<u64>> {
        self.run(|inner| {
            let transaction = io(inner.db.begin_read())?;
            let purged: Option<LogId> = meta(&transaction, "purged")?;
            let table = io(transaction.open_table(LOGS))?;
            let last = match io(table.last())? {
                Some((_, bytes)) => Some(decode::<EntryEnvelope>(bytes.value())?.entry.log_id),
                None => purged,
            };
            Ok(LogState {
                last_purged_log_id: purged,
                last_log_id: last,
            })
        })
        .await
        .map_err(read_error)
    }
    async fn get_log_reader(&mut self) -> Store {
        self.clone()
    }
    async fn save_vote(&mut self, vote: &Vote<u64>) -> std::result::Result<(), StorageError<u64>> {
        let vote = *vote;
        self.run(move |inner| {
            let transaction = transaction(inner, MAX_ENTRY_BYTES as u64)?;
            let prior: Option<Vote<u64>> = writable_meta(&transaction, "vote")?;
            if prior.is_some_and(|old| {
                !matches!(
                    vote.partial_cmp(&old),
                    Some(std::cmp::Ordering::Equal | std::cmp::Ordering::Greater)
                )
            }) {
                return Err(StoreError::Format);
            }
            put(&transaction, "vote", &Some(vote))?;
            io(transaction.commit())
        })
        .await
        .map_err(write_error)
    }
    async fn read_vote(&mut self) -> std::result::Result<Option<Vote<u64>>, StorageError<u64>> {
        self.read_value("vote").await.map_err(read_error)
    }
    async fn save_committed(
        &mut self,
        committed: Option<LogId>,
    ) -> std::result::Result<(), StorageError<u64>> {
        self.run(move |inner| {
            let transaction = transaction(inner, MAX_ENTRY_BYTES as u64)?;
            let prior: Option<LogId> = writable_meta(&transaction, "committed")?;
            if prior
                .is_some_and(|old| committed.is_none_or(|new| new.index < old.index || new < old))
            {
                return Err(StoreError::Format);
            }
            put(&transaction, "committed", &committed)?;
            io(transaction.commit())
        })
        .await
        .map_err(write_error)
    }
    async fn read_committed(&mut self) -> std::result::Result<Option<LogId>, StorageError<u64>> {
        self.read_value("committed").await.map_err(read_error)
    }
    async fn append<I>(
        &mut self,
        entries: I,
        callback: LogFlushed<ConsensusTypes>,
    ) -> std::result::Result<(), StorageError<u64>>
    where
        I: IntoIterator<Item = Entry> + openraft::OptionalSend,
        I::IntoIter: openraft::OptionalSend,
    {
        let mut prepared = Vec::new();
        let mut total = 0usize;
        for entry in entries {
            entry_preflight(&entry).map_err(write_error)?;
            if prepared.len() >= MAX_BATCH_ENTRIES {
                return Err(write_error(StoreError::Budget));
            }
            let index = entry.log_id.index;
            let bytes = encode(&EntryEnvelope {
                schema_version: entry_schema(&entry),
                entry,
            })
            .map_err(write_error)?;
            total = total
                .checked_add(bytes.len())
                .ok_or_else(|| write_error(StoreError::Budget))?;
            if bytes.len() > MAX_ENTRY_BYTES || total > MAX_BATCH_BYTES {
                return Err(write_error(StoreError::Budget));
            }
            prepared.push((index, bytes));
        }
        if prepared
            .windows(2)
            .any(|pair| pair[0].0.checked_add(1) != Some(pair[1].0))
        {
            return Err(write_error(StoreError::Format));
        }
        let result = self
            .run(move |inner| {
                let transaction =
                    transaction(inner, (total as u64).saturating_mul(4).max(1024 * 1024))?;
                let mut count_bytes: u64 = writable_meta(&transaction, "logBytes")?;
                let mut required_schema = CONTROL_SCHEMA;
                {
                    let mut table = io(transaction.open_table(LOGS))?;
                    let purged: Option<LogId> = writable_meta(&transaction, "purged")?;
                    let committed: Option<LogId> = writable_meta(&transaction, "committed")?;
                    let mut prepared = prepared;
                    if let Some(prefix) = purged {
                        // OpenRaft's storage recovery may resubmit already
                        // compacted entries. Superseded old-prefix IO is a
                        // no-op; never resurrect it or overwrite its snapshot.
                        // A later term claiming a compacted index is invalid.
                        for (index, bytes) in &prepared {
                            if *index <= prefix.index
                                && decode::<EntryEnvelope>(bytes)?.entry.log_id > prefix
                            {
                                return Err(StoreError::Format);
                            }
                        }
                        prepared.retain(|(index, _)| *index > prefix.index);
                    }
                    if let (Some((start, _)), Some((end, _))) = (prepared.first(), prepared.last())
                    {
                        let first = io(table.first())?.map(|(id, _)| id.value());
                        let last = io(table.last())?.map(|(id, _)| id.value());
                        if purged.is_some_and(|id| *start <= id.index)
                            || last.is_some_and(|id| *start > id.saturating_add(1))
                            || first.is_some_and(|id| end.saturating_add(1) < id)
                            || (last.is_none()
                                && purged.is_some_and(|id| id.index.checked_add(1) != Some(*start)))
                        {
                            return Err(StoreError::Format);
                        }
                    }
                    for (index, bytes) in prepared {
                        required_schema =
                            required_schema.max(decode::<EntryEnvelope>(&bytes)?.schema_version);
                        let prior = io(table.get(index))?;
                        if committed.is_some_and(|id| index <= id.index)
                            && prior
                                .as_ref()
                                .is_none_or(|entry| entry.value() != bytes.as_slice())
                        {
                            return Err(StoreError::Format);
                        }
                        let prior_len = prior.map(|entry| entry.value().len() as u64).unwrap_or(0);
                        count_bytes = count_bytes
                            .checked_sub(prior_len)
                            .and_then(|n| n.checked_add(bytes.len() as u64))
                            .ok_or(StoreError::Format)?;
                        if count_bytes > inner.limits.max_log_bytes {
                            return Err(StoreError::Budget);
                        }
                        io(table.insert(index, bytes.as_slice()))?;
                        if io(table.len())? > inner.limits.max_log_entries {
                            return Err(StoreError::Budget);
                        }
                    }
                }
                upgrade_format(inner, &transaction, required_schema)?;
                put(&transaction, "logBytes", &count_bytes)?;
                io(transaction.commit())
            })
            .await;
        match result {
            Ok(()) => {
                callback.log_io_completed(Ok(()));
                Ok(())
            }
            Err(error) => {
                callback.log_io_completed(Err(std::io::Error::other(error.to_string())));
                Err(write_error(error))
            }
        }
    }
    async fn truncate(&mut self, log: LogId) -> std::result::Result<(), StorageError<u64>> {
        self.remove_logs(log, false).await.map_err(write_error)
    }
    async fn purge(&mut self, log: LogId) -> std::result::Result<(), StorageError<u64>> {
        self.remove_logs(log, true).await.map_err(write_error)
    }
}
impl Store {
    async fn remove_logs(&self, log: LogId, purge: bool) -> Result<()> {
        self.run(move |inner| {
            let transaction = transaction(inner, MAX_ENTRY_BYTES as u64)?;
            let mut bytes: u64 = writable_meta(&transaction, "logBytes")?;
            let committed: Option<LogId> = writable_meta(&transaction, "committed")?;
            let purged: Option<LogId> = writable_meta(&transaction, "purged")?;
            if (!purge && committed.is_some_and(|id| log.index <= id.index))
                || (purge && purged.is_some_and(|id| log.index < id.index))
            {
                return Err(StoreError::Format);
            }
            {
                let mut table = io(transaction.open_table(LOGS))?;
                let bounds = if purge {
                    (Bound::Unbounded, Bound::Included(log.index))
                } else {
                    (Bound::Included(log.index), Bound::Unbounded)
                };
                let keys = io(table.range(bounds))?
                    .map(|entry| {
                        let (index, value) = io(entry)?;
                        Ok((index.value(), value.value().len() as u64))
                    })
                    .collect::<Result<Vec<_>>>()?;
                for (key, length) in keys {
                    io(table.remove(key))?;
                    bytes = bytes.checked_sub(length).ok_or(StoreError::Format)?;
                }
            }
            put(&transaction, "logBytes", &bytes)?;
            if purge {
                put(&transaction, "purged", &Some(log))?;
            }
            io(transaction.commit())
        })
        .await
    }
}

impl RaftSnapshotBuilder<ConsensusTypes> for Store {
    async fn build_snapshot(
        &mut self,
    ) -> std::result::Result<Snapshot<ConsensusTypes>, StorageError<u64>> {
        self.run(|inner| {
            let state = read_state(inner, &io(inner.db.begin_read())?)?;
            let schema = current_schema(inner)?;
            let bytes = encode(&envelope(inner, state.clone(), schema))?;
            if bytes.len() as u64 > inner.limits.max_snapshot_bytes {
                return Err(StoreError::Budget);
            }
            let meta = SnapshotMeta {
                last_log_id: state.last_applied,
                last_membership: state.membership,
                snapshot_id: snapshot_id(schema, &bytes),
            };
            let transaction = transaction(
                inner,
                (bytes.len() as u64).saturating_mul(4).max(1024 * 1024),
            )?;
            put(&transaction, "snapshotMeta", &meta)?;
            io(io(transaction.open_table(META))?.insert("snapshotBytes", bytes.as_slice()))?;
            io(transaction.commit())?;
            Ok(Snapshot {
                meta,
                snapshot: Box::new(io(BoundedSnapshot::from_bytes(
                    bytes,
                    inner.limits.max_snapshot_bytes,
                ))?),
            })
        })
        .await
        .map_err(write_error)
    }
}
impl openraft::storage::RaftStateMachine<ConsensusTypes> for Store {
    type SnapshotBuilder = Store;
    async fn applied_state(
        &mut self,
    ) -> std::result::Result<(Option<LogId>, Membership), StorageError<u64>> {
        let state = self.control_state().await.map_err(read_error)?;
        Ok((state.last_applied, state.membership))
    }
    async fn apply<I>(
        &mut self,
        entries: I,
    ) -> std::result::Result<Vec<ControlReply>, StorageError<u64>>
    where
        I: IntoIterator<Item = Entry> + openraft::OptionalSend,
        I::IntoIter: openraft::OptionalSend,
    {
        let mut prepared = Vec::new();
        let mut size = 0usize;
        for entry in entries {
            entry_preflight(&entry).map_err(write_error)?;
            if prepared.len() >= MAX_BATCH_ENTRIES {
                return Err(write_error(StoreError::Budget));
            }
            size = size
                .checked_add(encode(&entry).map_err(write_error)?.len())
                .ok_or_else(|| write_error(StoreError::Budget))?;
            if size > MAX_BATCH_BYTES {
                return Err(write_error(StoreError::Budget));
            }
            prepared.push(entry);
        }
        self.run(move |inner| {
            let mut state = read_state(inner, &io(inner.db.begin_read())?)?;
            let mut replies = Vec::with_capacity(prepared.len());
            let mut schema = current_schema(inner)?;
            for entry in prepared {
                schema = schema.max(entry_schema(&entry));
                if state
                    .last_applied
                    .is_some_and(|prior| prior.index >= entry.log_id.index)
                {
                    return Err(StoreError::Format);
                }
                let reply = match entry.payload {
                    EntryPayload::Blank => ControlReply::default(),
                    EntryPayload::Membership(membership) => {
                        state.membership = Membership::new(Some(entry.log_id), membership);
                        ControlReply::default()
                    }
                    EntryPayload::Normal(ControlData::Legacy(command)) => state.apply_command(
                        command,
                        entry.log_id,
                        &inner.binding.community_id,
                        MAX_OPERATIONS,
                        MAX_PARTITIONS,
                    ),
                    #[cfg(target_os = "linux")]
                    EntryPayload::Normal(ControlData::Checkpoint(command)) => state
                        .apply_checkpoint(
                            command,
                            entry.log_id,
                            &inner.binding.community_id,
                            &inner.binding.partition_id,
                            MAX_OPERATIONS,
                        ),
                };
                state.last_applied = Some(entry.log_id);
                replies.push(reply);
            }
            let next = envelope(inner, state, schema);
            validate_state(inner, &next)?;
            let bytes = encode(&next)?;
            if bytes.len() as u64 > inner.limits.max_snapshot_bytes {
                return Err(StoreError::Budget);
            }
            let transaction = transaction(
                inner,
                (bytes.len() as u64).saturating_mul(4).max(1024 * 1024),
            )?;
            upgrade_format(inner, &transaction, schema)?;
            io(io(transaction.open_table(META))?.insert("state", bytes.as_slice()))?;
            io(transaction.commit())?;
            Ok(replies)
        })
        .await
        .map_err(write_error)
    }
    async fn get_snapshot_builder(&mut self) -> Store {
        self.clone()
    }
    async fn begin_receiving_snapshot(
        &mut self,
    ) -> std::result::Result<Box<BoundedSnapshot>, StorageError<u64>> {
        Ok(Box::new(BoundedSnapshot::new(
            self.inner.limits.max_snapshot_bytes,
        )))
    }
    async fn install_snapshot(
        &mut self,
        meta: &SnapshotMeta<u64, RecoveryPeer>,
        snapshot: Box<BoundedSnapshot>,
    ) -> std::result::Result<(), StorageError<u64>> {
        let meta = meta.clone();
        let bytes = snapshot.into_bytes();
        self.run(move |inner| {
            if bytes.len() as u64 > inner.limits.max_snapshot_bytes {
                return Err(StoreError::Budget);
            }
            let state = decode_state(&bytes)?;
            validate_state(inner, &state)?;
            if state.state.last_applied != meta.last_log_id
                || state.state.membership != meta.last_membership
                || meta.snapshot_id != snapshot_id(state.schema_version, &bytes)
            {
                return Err(StoreError::Format);
            }
            let prior = read_state(inner, &io(inner.db.begin_read())?)?;
            // A later snapshot may advance ownership, but it cannot erase or
            // replace acknowledged outcomes in the global operation namespace.
            if prior
                .operations
                .iter()
                .any(|(id, receipt)| state.state.operations.get(id) != Some(receipt))
            {
                return Err(StoreError::Format);
            }
            #[cfg(target_os = "linux")]
            if prior
                .checkpoints
                .iter()
                .any(|(id, receipt)| state.state.checkpoints.get(id) != Some(receipt))
            {
                return Err(StoreError::Format);
            }
            if prior.last_applied.is_some_and(|old| {
                meta.last_log_id
                    .is_none_or(|new| new.index < old.index || new < old)
            }) || (prior.last_applied == meta.last_log_id && state.state != prior)
            {
                return Err(StoreError::Format);
            }
            let transaction = transaction(
                inner,
                (bytes.len() as u64).saturating_mul(4).max(1024 * 1024),
            )?;
            let schema = current_schema(inner)?.max(state.schema_version);
            let state = StateEnvelope {
                schema_version: schema,
                ..state
            };
            let bytes = encode(&state)?;
            let mut meta = meta;
            meta.snapshot_id = snapshot_id(schema, &bytes);
            upgrade_format(inner, &transaction, schema)?;
            put(&transaction, "state", &state)?;
            put(&transaction, "snapshotMeta", &meta)?;
            io(io(transaction.open_table(META))?.insert("snapshotBytes", bytes.as_slice()))?;
            io(transaction.commit())
        })
        .await
        .map_err(write_error)
    }
    async fn get_current_snapshot(
        &mut self,
    ) -> std::result::Result<Option<Snapshot<ConsensusTypes>>, StorageError<u64>> {
        self.run(|inner| {
            let transaction = io(inner.db.begin_read())?;
            let table = io(transaction.open_table(META))?;
            match (
                io(table.get("snapshotMeta"))?,
                io(table.get("snapshotBytes"))?,
            ) {
                (None, None) => Ok(None),
                (Some(meta), Some(bytes)) => {
                    if bytes.value().len() as u64 > inner.limits.max_snapshot_bytes {
                        return Err(StoreError::Budget);
                    }
                    let meta: SnapshotMeta<u64, RecoveryPeer> = decode(meta.value())?;
                    let envelope = decode_state(bytes.value())?;
                    validate_state(inner, &envelope)?;
                    let identity: DatabaseIdentity = self::meta(&transaction, "identity")?;
                    if !identity_valid(&identity, &inner.binding)
                        || envelope.schema_version > identity.schema_version
                    {
                        return Err(StoreError::Format);
                    }
                    if envelope.state.last_applied != meta.last_log_id
                        || envelope.state.membership != meta.last_membership
                        || meta.snapshot_id != snapshot_id(envelope.schema_version, bytes.value())
                    {
                        return Err(StoreError::Format);
                    }
                    Ok(Some(Snapshot {
                        meta,
                        snapshot: Box::new(io(BoundedSnapshot::from_bytes(
                            bytes.value().to_vec(),
                            inner.limits.max_snapshot_bytes,
                        ))?),
                    }))
                }
                _ => Err(StoreError::Format),
            }
        })
        .await
        .map_err(read_error)
    }
}
