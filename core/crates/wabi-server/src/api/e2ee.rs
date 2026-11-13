//! Experimental private-room encryption registry.
//!
//! The server never receives room keys or device private keys. It stores only
//! public device identity keys, room epoch metadata and room keys wrapped to
//! participant devices. Message bodies remain opaque `wabi-e2ee-v1:` envelopes.
//! This is deliberately separate from WabiDB at-rest encryption: possession of
//! server data + server-held keys must not be sufficient to recover plaintext.

use axum::{
    extract::{Path, State},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::{BTreeSet, HashMap},
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
};

use crate::{auth_extractor::AuthUser, error::{AppError, Result}, state::AppState};
use wabidb::engine::wabi_store::WabiStore;
use wabidb::projections::room_encryption::{
    self as marker, RoomEncryptionMode as MarkerMode, RoomEncryptionRecord,
};

pub const MESSAGE_PREFIX: &str = "wabi-e2ee-v1:";
const MAX_DEVICES_PER_USER: usize = 8;
const MAX_KEY_FIELD: usize = 4096;
const MAX_WRAPPED_KEY: usize = 8192;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceBundle {
    pub user_id: i64,
    pub device_id: String,
    pub label: Option<String>,
    pub encryption_public_key: String,
    pub signing_public_key: String,
    pub created_at: String,
    pub last_seen_at: String,
    pub revoked_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WrappedRoomKey {
    pub recipient_user_id: i64,
    pub recipient_device_id: String,
    pub ephemeral_public_key: String,
    pub salt: String,
    pub iv: String,
    pub ciphertext: String,
    pub sender_device_id: String,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomState {
    pub channel_id: String,
    pub enabled: bool,
    pub epoch: u64,
    pub membership_revision: u64,
    pub enabled_by_user_id: i64,
    pub enabled_at: String,
    pub rekeyed_at: String,
    pub envelopes: Vec<WrappedRoomKey>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum NewRoomMode {
    PendingEncryption,
    ServerReadable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NewRoomPolicy {
    mode: NewRoomMode,
    created_at: String,
    chosen_by_user_id: Option<i64>,
    #[serde(default)]
    consenting_user_ids: BTreeSet<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct E2eeData {
    devices: Vec<DeviceBundle>,
    rooms: HashMap<String, RoomState>,
    // Added to the JSON sidecar, never to postcard channel/message records.
    // Old rooms without an entry retain their existing server-readable mode.
    #[serde(default)]
    new_room_policies: HashMap<String, NewRoomPolicy>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterDeviceInput {
    device_id: String,
    label: Option<String>,
    encryption_public_key: String,
    signing_public_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetRoomInput {
    sender_device_id: String,
    epoch: u64,
    membership_revision: String,
    envelopes: Vec<WrappedRoomKey>,
}

/// Exactly the fields the shipped client signs (`frontend/src/lib/e2ee.ts`).
/// Extra fields (a readable "preview", "plaintext", ...) are refused, never
/// stored beside the ciphertext.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageEnvelope {
    pub v: u8,
    pub room: String,
    pub epoch: u64,
    pub membership_revision: String,
    pub sender_device_id: String,
    pub iv: String,
    pub ciphertext: String,
    pub signature: String,
}

fn disk_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn store_path(data_dir: &str) -> PathBuf {
    PathBuf::from(data_dir).join("e2ee_state.json")
}

const REGISTRY_UNAVAILABLE: &str = "Encryption state could not be read. Sending and key changes are paused; ask the operator to restore the encryption registry.";

fn read_unlocked(data_dir: &str) -> Result<E2eeData> {
    match std::fs::read(store_path(data_dir)) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|_| AppError::Internal(REGISTRY_UNAVAILABLE.into())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(E2eeData::default()),
        Err(_) => Err(AppError::Internal(REGISTRY_UNAVAILABLE.into())),
    }
}

fn read_data(data_dir: &str) -> Result<E2eeData> {
    let _guard = disk_lock().lock().unwrap_or_else(|p| p.into_inner());
    read_unlocked(data_dir)
}

/// Whether `channel_id` has experimental encryption enabled, according to the
/// registry or the database marker (either is enough: this is a label, and a
/// registry behind the marker must not make an encrypted room look readable).
pub(super) async fn room_is_enabled(state: &AppState, channel_id: &str) -> Result<bool> {
    let data = read_data(&state.config.data_dir)?;
    let marker = read_marker(state, channel_id)
        .map_err(|_| AppError::Internal(MARKER_UNAVAILABLE.into()))?;
    Ok(data.rooms.get(channel_id).is_some_and(|room| room.enabled)
        || marker.is_some_and(|m| m.mode == MarkerMode::Enabled))
}

/// Whether the server must not write its own readable content (for example
/// an integration announcement) into `channel_id`. A registry that does not
/// cover the database marker blocks it.
pub(super) async fn room_blocks_server_content(state: &AppState, channel_id: &str) -> Result<bool> {
    let data = match read_checked(state, channel_id).await {
        Ok(data) => data,
        Err(Refusal::Unavailable(reason)) => return Err(AppError::Internal(reason.into())),
        Err(Refusal::Behind(_)) => return Ok(true),
    };
    Ok(data.rooms.get(channel_id).is_some_and(|room| room.enabled)
        || data.new_room_policies.get(channel_id).is_some_and(|policy| policy.mode == NewRoomMode::PendingEncryption))
}

/// Called before a newly-created DM/group is made visible in WabiDB. The
/// database marker is written first, then the registry entry (see
/// "Write order" below). An orphaned marker or policy after a failed create
/// is harmless: it only refuses readable content in a room that does not
/// exist, and a later create of the same id marks it again. The opposite
/// ordering could briefly accept a plaintext message in a new private room.
pub async fn mark_new_room_pending(state: &AppState, channel_id: &str) -> Result<()> {
    let _policy_guard = state.retention_policy_lock.lock().await;
    let data_dir = &state.config.data_dir;
    let registry_room = read_data(data_dir)?.rooms.get(channel_id).filter(|r| r.enabled).map(|r| r.epoch);
    // A room id that was encrypted before (stable DM ids are reused after
    // deletion) stays encrypted in both stores; never mark it pending.
    let target = match registry_room {
        Some(epoch) => enabled_record(channel_id, epoch),
        None => mode_record(channel_id, MarkerMode::Pending),
    };
    commit_marker_if_changed(state, &target).await?;
    mutate_data(data_dir, |data| {
        if !data.rooms.contains_key(channel_id) {
            data.new_room_policies.insert(channel_id.to_string(), NewRoomPolicy {
                mode: NewRoomMode::PendingEncryption,
                created_at: chrono::Utc::now().to_rfc3339(),
                chosen_by_user_id: None,
                consenting_user_ids: BTreeSet::new(),
            });
        }
        Ok(())
    })
}

// ---------------------------------------------------------------------------
// Durable room marker (WabiDB) versus the registry sidecar
// ---------------------------------------------------------------------------
//
// The registry (`e2ee_state.json`) is the only home of device public keys and
// wrapped room keys, so it cannot move into WabiDB. But on its own it cannot
// tell "this room was never encrypted" from "the file is missing or an older
// copy was restored". WabiDB therefore keeps a small marker per conversation
// (`room_encryption` projection): pending, server-readable chosen, or enabled
// at a key epoch.
//
// Write order: every transition commits the marker to WabiDB first and then
// writes the registry, under `retention_policy_lock`.
// - Crash after the marker, before the registry: the marker is ahead. The
//   registry does not cover it, so every readable write in that room is
//   refused, and room status reports the marker's state. The room stays
//   closed until a participant's client completes setup (enable, rekey, or an
//   explicit server-readable choice), which writes both again. Safe.
// - The registry ahead of the marker cannot come from this order. It can come
//   from a data directory restored older than its registry, or from rooms
//   that existed before markers did. The registry is then the stricter
//   source, it is used, and the marker is brought up to it (at startup, and
//   whenever a decision sees it).
//
// Every decision that reads the registry for a conversation goes through
// `read_checked`, which refuses (fails closed) when the registry has no entry,
// an older epoch, or a weaker mode than the marker. Nothing ever "repairs"
// that by trusting the weaker source; there is no reset-to-readable switch.

const MARKER_UNAVAILABLE: &str = "Encryption state in the database could not be read. Sending and key changes are paused; the operator should check the server log.";

/// What the registry says about one conversation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RegistryRoom {
    /// No entry: the earlier server-readable policy.
    Earlier,
    ServerReadable,
    Pending,
    Enabled(u64),
}

fn registry_room(data: &E2eeData, channel_id: &str) -> RegistryRoom {
    if let Some(room) = data.rooms.get(channel_id).filter(|room| room.enabled) {
        return RegistryRoom::Enabled(room.epoch);
    }
    match data.new_room_policies.get(channel_id).map(|policy| policy.mode) {
        Some(NewRoomMode::PendingEncryption) => RegistryRoom::Pending,
        Some(NewRoomMode::ServerReadable) => RegistryRoom::ServerReadable,
        None => RegistryRoom::Earlier,
    }
}

fn mode_record(channel_id: &str, mode: MarkerMode) -> RoomEncryptionRecord {
    RoomEncryptionRecord { channel_id: channel_id.to_string(), mode, epoch: 0, consenting_user_ids: vec![] }
}

fn enabled_record(channel_id: &str, epoch: u64) -> RoomEncryptionRecord {
    RoomEncryptionRecord { channel_id: channel_id.to_string(), mode: MarkerMode::Enabled, epoch, consenting_user_ids: vec![] }
}

fn readable_record(channel_id: &str, consenting: impl IntoIterator<Item = i64>) -> RoomEncryptionRecord {
    let mut ids: Vec<u64> = consenting.into_iter().filter_map(|id| u64::try_from(id).ok()).filter(|id| *id > 0).collect();
    ids.sort_unstable();
    ids.dedup();
    RoomEncryptionRecord { consenting_user_ids: ids, ..mode_record(channel_id, MarkerMode::ServerReadable) }
}

/// Why the registry's entry for `channel_id` cannot be the source of a
/// marker (an enabled room without a valid key set, consent from an invalid
/// id, a mismatched id). Such an entry never moves a marker; it is logged.
fn registry_entry_problem(data: &E2eeData, channel_id: &str) -> Option<&'static str> {
    if let Some(room) = data.rooms.get(channel_id).filter(|room| room.enabled) {
        let device_known = |e: &WrappedRoomKey| {
            data.devices.iter().any(|d| {
                d.user_id == e.recipient_user_id && d.device_id == e.recipient_device_id
                    && valid_key(&d.encryption_public_key) && valid_key(&d.signing_public_key)
            })
        };
        if room.channel_id != channel_id
            || room.epoch == 0
            || room.envelopes.is_empty()
            || !room.envelopes.iter().all(|e| validate_wrapped_key(e, &e.sender_device_id) && device_known(e))
        {
            return Some("encrypted room entry without a valid epoch and key set");
        }
    }
    if data.new_room_policies.get(channel_id).is_some_and(|p| p.consenting_user_ids.iter().any(|id| *id <= 0)) {
        return Some("server-readable choice from an invalid user id");
    }
    None
}

fn read_marker(state: &AppState, channel_id: &str) -> wabidb::error::Result<Option<RoomEncryptionRecord>> {
    marker::get(state.wdb.engine().projection_state(), channel_id)
}

enum Coverage {
    /// The registry is at least as strict as the marker.
    Covered,
    /// The registry is ahead; the marker should be brought up to this.
    RegistryAhead(RoomEncryptionRecord),
    /// The registry is missing or behind the marker: refuse, with this reason.
    Behind(String),
}

const RESTORE_HINT: &str = "Readable content is refused in this conversation. Operator: stop the Authority and restore the e2ee_state.json saved with this data directory.";

/// Compare the marker with the registry. Pure; see the module notes above.
fn coverage(channel_id: &str, marker: Option<&RoomEncryptionRecord>, registry: RegistryRoom) -> Coverage {
    use RegistryRoom as R;
    let Some(marker) = marker else {
        return match registry {
            R::Earlier => Coverage::Covered,
            R::Pending => Coverage::RegistryAhead(mode_record(channel_id, MarkerMode::Pending)),
            R::ServerReadable => Coverage::RegistryAhead(mode_record(channel_id, MarkerMode::ServerReadable)),
            R::Enabled(epoch) => Coverage::RegistryAhead(enabled_record(channel_id, epoch)),
        };
    };
    match (marker.mode, registry) {
        (MarkerMode::Enabled, R::Enabled(epoch)) if epoch > marker.epoch => {
            Coverage::RegistryAhead(enabled_record(channel_id, epoch))
        }
        (MarkerMode::Enabled, R::Enabled(epoch)) if epoch == marker.epoch => Coverage::Covered,
        (MarkerMode::Enabled, R::Enabled(epoch)) => Coverage::Behind(format!(
            "The encryption registry (e2ee_state.json) is older than the database: it has key epoch {epoch} for this conversation, the database records epoch {}. {RESTORE_HINT} Without that copy, members' updated clients set up new keys (rekey) and continue at a higher epoch; older encrypted messages stay readable only on devices that kept their keys.",
            marker.epoch
        )),
        (MarkerMode::Enabled, _) => Coverage::Behind(format!(
            "The database records experimental encryption for this conversation (key epoch {}), but the encryption registry (e2ee_state.json) has no encrypted entry for it: the file is missing or an older copy was restored. {RESTORE_HINT} The server never held the room keys, so they cannot be recreated; without that copy, members' updated clients set up new keys (rekey) and continue at a higher epoch, and older encrypted messages stay readable only on devices that kept their keys.",
            marker.epoch
        )),
        (_, R::Enabled(epoch)) => Coverage::RegistryAhead(enabled_record(channel_id, epoch)),
        (MarkerMode::Pending, R::Pending) => Coverage::Covered,
        (MarkerMode::Pending, R::Earlier | R::ServerReadable) => Coverage::Behind(format!(
            "The database records this new conversation as waiting for experimental encryption, but the encryption registry (e2ee_state.json) does not: the file is missing or an older copy was restored. {RESTORE_HINT} Without that copy, participants can finish encryption setup from an updated client, or each sender can choose server-readable messages again on their own device."
        )),
        (MarkerMode::ServerReadable, R::ServerReadable | R::Pending) => Coverage::Covered,
        (MarkerMode::ServerReadable, R::Earlier) => Coverage::Behind(format!(
            "The database records that each sender in this new conversation must choose server-readable messages on their own device, but the encryption registry (e2ee_state.json) has no entry for it: the file is missing or an older copy was restored. {RESTORE_HINT} Without that copy, each sender can choose server-readable messages again, or participants can set up encryption."
        )),
    }
}

/// Why a conversation's encryption state refuses readable content.
enum Refusal {
    /// The registry or marker could not be read at all.
    Unavailable(&'static str),
    /// The registry is missing or behind the marker.
    Behind(String),
}

impl Refusal {
    fn reason(self) -> String {
        match self {
            Refusal::Unavailable(reason) => reason.to_string(),
            Refusal::Behind(reason) => reason,
        }
    }
}

/// The registry, checked against the database marker for `channel_id`. Every
/// decision about readable content in a conversation reads through this.
async fn read_checked(state: &AppState, channel_id: &str) -> std::result::Result<E2eeData, Refusal> {
    let mut data = read_data(&state.config.data_dir).map_err(|_| Refusal::Unavailable(REGISTRY_UNAVAILABLE))?;
    let mut marker = read_marker(state, channel_id).map_err(|error| {
        tracing::error!("[e2ee] room encryption marker unreadable: {error}");
        Refusal::Unavailable(MARKER_UNAVAILABLE)
    })?;
    match coverage(channel_id, marker.as_ref(), registry_room(&data, channel_id)) {
        Coverage::Covered => {}
        Coverage::RegistryAhead(record) => {
            // The registry is the stricter source here and decides. Bringing
            // the marker up is best effort: a failure leaves it behind, which
            // the next decision or startup retries.
            match catch_up_target(state.wdb.as_ref(), &data, channel_id, record).await {
                Some(record) => match commit_marker(state.wdb.engine(), &record, 0).await {
                    Ok(()) => marker = read_marker(state, channel_id).ok().flatten(),
                    Err(error) => tracing::warn!("[e2ee] could not bring a room encryption marker up to the registry: {error}"),
                },
                None => {}
            }
        }
        Coverage::Behind(reason) => {
            tracing::warn!("[e2ee] encryption registry is behind the database for a conversation; readable content refused");
            return Err(Refusal::Behind(reason));
        }
    }
    // Per-sender consent counts only where the registry and the marker agree:
    // a registry (older, or from another data directory) that lists a sender
    // the marker does not is not trusted for that sender.
    if let (Some(m), Some(policy)) = (marker.as_ref(), data.new_room_policies.get_mut(channel_id)) {
        if m.mode == MarkerMode::ServerReadable {
            let before = policy.consenting_user_ids.len();
            policy.consenting_user_ids.retain(|id| u64::try_from(*id).is_ok_and(|id| m.consenting_user_ids.binary_search(&id).is_ok()));
            if policy.consenting_user_ids.len() != before {
                tracing::warn!("[e2ee] the encryption registry lists server-readable choices the database does not record; those senders must choose again");
            }
        }
    }
    Ok(data)
}

/// The marker to write when the registry is ahead of it, or `None` when the
/// registry entry must not move a marker: the id is not an existing DM or
/// group (a registry may name any id), or the entry does not validate.
async fn catch_up_target(
    wdb: &crate::adapter::WdbAdapter,
    data: &E2eeData,
    channel_id: &str,
    mut record: RoomEncryptionRecord,
) -> Option<RoomEncryptionRecord> {
    let conversation = matches!(
        wdb.get_channel(channel_id).await,
        Ok(Some(channel)) if crate::channel_access::is_conversation(channel.channel_kind)
    );
    if !conversation {
        tracing::warn!("[e2ee] e2ee_state.json names {channel_id}, which is not an existing DM or group; no marker written for it");
        return None;
    }
    if let Some(problem) = registry_entry_problem(data, channel_id) {
        tracing::warn!("[e2ee] e2ee_state.json entry for {channel_id} is not used for the database marker: {problem}");
        return None;
    }
    if record.mode == MarkerMode::ServerReadable {
        // Only a room with no marker at all gets here (one from before
        // markers existed): its registry consent is the only record of it.
        record = readable_record(channel_id, data.new_room_policies.get(channel_id).map(|p| p.consenting_user_ids.clone()).unwrap_or_default());
    }
    Some(record)
}

async fn commit_marker(
    engine: &wabidb::engine::WabiDbEngine,
    record: &RoomEncryptionRecord,
    actor_user_id: i64,
) -> wabidb::error::Result<()> {
    use wabidb::{format::record::RecordKind, sequencer::types::{CommandCommit, EventToWrite}};
    let payload = marker::encode_record(record);
    marker::decode_record(&payload)?;
    engine.get_or_create_stream_key(marker::STREAM).await?;
    engine
        .run_command(CommandCommit {
            room_owner_precondition: None,
            caller_user_id: u64::try_from(actor_user_id).unwrap_or(0),
            caller_device_id: "primary".into(),
            command_name: marker::EVENT.into(),
            idempotency_key: None,
            essential: true,
            response_tx: tokio::sync::oneshot::channel().0,
            events: vec![EventToWrite {
                stream_id: marker::STREAM.into(),
                stream_kind: 6,
                event_type: marker::EVENT.into(),
                record_kind: RecordKind::Event,
                plaintext: payload,
            }],
        })
        .await?;
    Ok(())
}

/// Commit `target` unless the marker already says exactly that. The
/// projection never moves a room out of `Enabled`, whatever is committed.
async fn commit_marker_if_changed(state: &AppState, target: &RoomEncryptionRecord) -> Result<()> {
    let current = read_marker(state, &target.channel_id)
        .map_err(|_| AppError::Internal(MARKER_UNAVAILABLE.into()))?;
    let next = current.as_ref().map(|c| c.merged(target)).unwrap_or_else(|| target.clone());
    if current.as_ref() == Some(&next) {
        return Ok(());
    }
    commit_marker(state.wdb.engine(), target, 0)
        .await
        .map_err(|e| AppError::Internal(format!("persist room encryption marker: {e}")))
}

/// Authority startup, while a readable registry exists: give every room the
/// registry lists a marker at least as strong as its entry (one-time and
/// idempotent; later starts write nothing). A registry behind an existing
/// marker is left alone and logged; it never weakens the marker. A damaged
/// registry is skipped: it already refuses every conversation decision.
pub async fn reconcile_room_markers(wdb: &crate::adapter::WdbAdapter, data_dir: &str) -> anyhow::Result<()> {
    let engine = wdb.engine();
    let data = match read_data(data_dir) {
        Ok(data) => data,
        Err(_) => {
            tracing::warn!("[e2ee] encryption registry unreadable at startup; room markers not reconciled");
            return Ok(());
        }
    };
    let mut ids: BTreeSet<String> = data.rooms.keys().cloned().collect();
    ids.extend(data.new_room_policies.keys().cloned());
    engine.projection_state().for_each(marker::INDEX, |key, _| {
        if let Ok(id) = std::str::from_utf8(key) {
            ids.insert(id.to_string());
        }
    });
    let (mut written, mut behind) = (0usize, 0usize);
    for channel_id in &ids {
        let current = marker::get(engine.projection_state(), channel_id)?;
        match coverage(channel_id, current.as_ref(), registry_room(&data, channel_id)) {
            Coverage::Covered => {}
            Coverage::RegistryAhead(record) => {
                if let Some(record) = catch_up_target(wdb, &data, channel_id, record).await {
                    commit_marker(engine, &record, 0).await?;
                    written += 1;
                }
            }
            Coverage::Behind(_) => behind += 1,
        }
    }
    if written > 0 {
        tracing::info!("[e2ee] wrote {written} room encryption marker(s) from the registry");
    }
    if behind > 0 {
        tracing::warn!(
            "[e2ee] the encryption registry is missing or behind the database for {behind} conversation(s); they refuse readable content until e2ee_state.json is restored or members set up encryption again"
        );
    }
    Ok(())
}

fn write_unlocked(data_dir: &str, data: &E2eeData) -> anyhow::Result<()> {
    use std::io::Write;
    let path = store_path(data_dir);
    let parent = path.parent().ok_or_else(|| anyhow::anyhow!("E2EE state path has no parent"))?;
    std::fs::create_dir_all(parent)?;
    let bytes = serde_json::to_vec_pretty(data)?;
    let temporary = parent.join(format!(".e2ee-state-{}.tmp", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    let result = (|| -> anyhow::Result<()> {
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, &path)?;
        // The pending-room policy is written before WabiDB exposes a new
        // channel. Sync the rename too, or power loss could leave a durable
        // channel without its fail-closed privacy boundary.
        #[cfg(unix)]
        std::fs::File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() { let _ = std::fs::remove_file(&temporary); }
    result
}

fn mutate_data<T>(data_dir: &str, f: impl FnOnce(&mut E2eeData) -> Result<T>) -> Result<T> {
    let _guard = disk_lock().lock().unwrap_or_else(|p| p.into_inner());
    let mut data = read_unlocked(data_dir)?;
    let out = f(&mut data)?;
    write_unlocked(data_dir, &data)
        .map_err(|e| AppError::Internal(format!("persist E2EE state: {e}")))?;
    Ok(out)
}

fn valid_device_id(value: &str) -> bool {
    let len = value.len();
    (8..=128).contains(&len)
        && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

fn valid_key(value: &str) -> bool {
    (40..=MAX_KEY_FIELD).contains(&value.len())
        && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=' | '-' | '_'))
}

fn clean_label(value: Option<String>) -> Option<String> {
    value.map(|s| s.trim().chars().take(80).collect::<String>()).filter(|s| !s.is_empty())
}

fn active_devices<'a>(data: &'a E2eeData, user_ids: &BTreeSet<i64>) -> Vec<&'a DeviceBundle> {
    data.devices.iter().filter(|d| d.revoked_at.is_none() && user_ids.contains(&d.user_id)).collect()
}

fn device_pairs<'a>(items: impl IntoIterator<Item = &'a DeviceBundle>) -> BTreeSet<(i64, String)> {
    items.into_iter().map(|d| (d.user_id, d.device_id.clone())).collect()
}

fn envelope_pairs(items: &[WrappedRoomKey]) -> BTreeSet<(i64, String)> {
    items.iter().map(|e| (e.recipient_user_id, e.recipient_device_id.clone())).collect()
}

async fn private_room_members(state: &AppState, user_id: i64, channel_id: &str) -> Result<(BTreeSet<i64>, u64)> {
    if user_id <= 0 { return Err(AppError::Forbidden("Registered account required for E2EE".into())); }
    crate::channel_access::require_access(state, user_id, channel_id).await?;
    let channel = state.wdb.get_channel(channel_id).await?
        .ok_or_else(|| AppError::NotFound("Conversation not found".into()))?;
    if !crate::channel_access::is_conversation(channel.channel_kind) {
        return Err(AppError::BadRequest("E2EE v1 is limited to DMs and private groups".into()));
    }
    let members = state.wdb.list_channel_members(channel_id).await?;
    let ids: BTreeSet<i64> = members.into_iter().filter_map(|m| i64::try_from(m.user_id).ok()).collect();
    if !ids.contains(&user_id) { return Err(AppError::Forbidden("Conversation membership required".into())); }
    let revision = wabidb::projections::channel_members::ChannelMembersProjection::revision(
        &state.wdb.engine().projection_state(), channel_id,
    )?;
    Ok((ids, revision))
}

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/devices", axum::routing::get(list_my_devices).post(register_device))
        .route("/devices/{device_id}", axum::routing::delete(revoke_device))
        .route("/channels/{channel_id}", axum::routing::get(room_status))
        .route("/channels/{channel_id}/enable", axum::routing::post(enable_room))
        .route("/channels/{channel_id}/rekey", axum::routing::post(rekey_room))
        .route("/channels/{channel_id}/allow-server-readable", axum::routing::post(allow_server_readable))
        .with_state(state)
}

async fn list_my_devices(State(state): State<Arc<AppState>>, auth: AuthUser) -> Result<Json<serde_json::Value>> {
    if auth.is_guest { return Err(AppError::Forbidden("Guests cannot register E2EE devices".into())); }
    let data = read_data(&state.config.data_dir)?;
    let devices: Vec<_> = data.devices.into_iter().filter(|d| d.user_id == auth.user_id).collect();
    Ok(Json(json!({ "devices": devices })))
}

async fn register_device(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Json(mut input): Json<RegisterDeviceInput>,
) -> Result<Json<serde_json::Value>> {
    if auth.is_guest {
        return Err(AppError::Forbidden(
            "Guests cannot register E2EE devices".into(),
        ));
    }
    input.device_id = input.device_id.trim().to_string();
    input.encryption_public_key = input.encryption_public_key.trim().to_string();
    input.signing_public_key = input.signing_public_key.trim().to_string();
    if !valid_device_id(&input.device_id)
        || !valid_key(&input.encryption_public_key)
        || !valid_key(&input.signing_public_key)
    {
        return Err(AppError::BadRequest("Invalid E2EE device bundle".into()));
    }
    let admission = auth.admit_current(&state).await?;
    let operation_state = state.clone();
    admission.run(&operation_state, async move {
    let now = chrono::Utc::now().to_rfc3339();
    let device = mutate_data(&state.config.data_dir, |data| {
        if let Some(existing) = data.devices.iter_mut().find(|d| d.user_id == auth.user_id && d.device_id == input.device_id) {
            if existing.encryption_public_key != input.encryption_public_key || existing.signing_public_key != input.signing_public_key {
                return Err(AppError::Conflict("This device ID is already pinned to different public keys. Create a new device identity instead of replacing it silently.".into()));
            }
            if existing.revoked_at.is_some() {
                return Err(AppError::Conflict("This device identity was revoked and cannot be silently restored. Create a new device identity.".into()));
            }
            existing.label = clean_label(input.label.clone());
            existing.last_seen_at = now.clone();
            return Ok(existing.clone());
        }
        let active_count = data.devices.iter().filter(|d| d.user_id == auth.user_id && d.revoked_at.is_none()).count();
        if active_count >= MAX_DEVICES_PER_USER {
            return Err(AppError::BadRequest(format!("E2EE devices are limited to {MAX_DEVICES_PER_USER} active devices per account")));
        }
        let bundle = DeviceBundle {
            user_id: auth.user_id,
            device_id: input.device_id.clone(),
            label: clean_label(input.label.clone()),
            encryption_public_key: input.encryption_public_key.clone(),
            signing_public_key: input.signing_public_key.clone(),
            created_at: now.clone(),
            last_seen_at: now.clone(),
            revoked_at: None,
        };
        data.devices.push(bundle.clone());
        Ok(bundle)
    })?;
    Ok(Json(json!({ "device": device })))
    }).await
}

async fn revoke_device(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(device_id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    if auth.is_guest {
        return Err(AppError::Forbidden(
            "Guests do not have E2EE devices".into(),
        ));
    }
    let admission = auth.admit_current(&state).await?;
    let operation_state = state.clone();
    admission
        .run(&operation_state, async move {
            let now = chrono::Utc::now().to_rfc3339();
            mutate_data(&state.config.data_dir, |data| {
                let device = data
                    .devices
                    .iter_mut()
                    .find(|d| d.user_id == auth.user_id && d.device_id == device_id)
                    .ok_or_else(|| AppError::NotFound("E2EE device not found".into()))?;
                if device.revoked_at.is_none() {
                    device.revoked_at = Some(now.clone());
                }
                Ok(())
            })?;
            Ok(Json(
                json!({ "success": true, "deviceId": device_id, "rekeyRequired": true }),
            ))
        })
        .await
}

async fn room_status(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    let _membership = state.membership_gate.read().await;
    let _authorization = auth.admit_current(&state).await?;
    if auth.is_guest {
        return Err(AppError::Forbidden("Guests cannot use E2EE rooms".into()));
    }
    let (members, current_revision) =
        private_room_members(&state, auth.user_id, &channel_id).await?;
    // A registry behind the database marker still answers: the status shows
    // the marker's state (encrypted at its epoch, or pending), so updated
    // clients run setup again instead of treating the room as readable.
    // Under the policy lock: a catch-up commit here must not race a
    // server-readable choice or an enable.
    let checked = {
        let _policy_guard = state.retention_policy_lock.lock().await;
        read_checked(&state, &channel_id).await
    };
    let (data, behind) = match checked {
        Ok(data) => (data, None),
        Err(Refusal::Unavailable(reason)) => return Err(AppError::Internal(reason.into())),
        Err(Refusal::Behind(reason)) => (read_data(&state.config.data_dir)?, Some(reason)),
    };
    let marker = read_marker(&state, &channel_id)
        .map_err(|_| AppError::Internal(MARKER_UNAVAILABLE.into()))?;
    let marker_epoch = marker.as_ref().filter(|m| m.mode == MarkerMode::Enabled).map(|m| m.epoch);
    let devices: Vec<DeviceBundle> = active_devices(&data, &members)
        .into_iter()
        .cloned()
        .collect();
    let missing_user_ids: Vec<i64> = members
        .iter()
        .copied()
        .filter(|uid| !devices.iter().any(|d| d.user_id == *uid))
        .collect();
    // Keys from a registry entry behind the marker belong to an old epoch.
    let room = data.rooms.get(&channel_id).filter(|r| r.enabled && behind.is_none()).cloned();
    let enabled = room.is_some() || marker_epoch.is_some();
    let epoch = room.as_ref().map(|r| r.epoch).or(marker_epoch).unwrap_or(0);
    let mode = if behind.is_some() {
        marker.as_ref().and_then(|m| match m.mode {
            MarkerMode::Pending => Some(NewRoomMode::PendingEncryption),
            MarkerMode::ServerReadable => Some(NewRoomMode::ServerReadable),
            MarkerMode::Enabled => None,
        })
    } else {
        data.new_room_policies.get(&channel_id).map(|policy| policy.mode)
    };
    let server_readable_allowed_by_me = behind.is_none()
        && data.new_room_policies.get(&channel_id).is_some_and(|policy| {
            policy.mode == NewRoomMode::ServerReadable
                && policy.consenting_user_ids.contains(&auth.user_id)
        });
    let expected = device_pairs(devices.iter());
    let actual = room
        .as_ref()
        .map(|r| envelope_pairs(&r.envelopes))
        .unwrap_or_default();
    let needs_rekey = (enabled && room.is_none())
        || room
            .as_ref()
            .is_some_and(|r| r.membership_revision != current_revision || expected != actual);
    let my_envelopes: Vec<WrappedRoomKey> = room
        .as_ref()
        .map(|r| {
            r.envelopes
                .iter()
                .filter(|e| e.recipient_user_id == auth.user_id)
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    Ok(Json(json!({
        "enabled": enabled,
        "pendingDefault": !enabled && mode == Some(NewRoomMode::PendingEncryption),
        "serverReadableSelected": !enabled && mode == Some(NewRoomMode::ServerReadable),
        "serverReadableAllowedByMe": server_readable_allowed_by_me,
        "epoch": epoch,
        "membershipRevision": room.as_ref().map(|r| r.membership_revision.to_string()).unwrap_or_else(|| current_revision.to_string()),
        "currentMembershipRevision": current_revision.to_string(),
        "needsRekey": needs_rekey,
        "devices": devices,
        "missingUserIds": missing_user_ids,
        "keyEnvelopes": my_envelopes,
        "downgradeAllowed": false,
        "registryBehind": behind,
    })))
}

async fn allow_server_readable(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    let admission = crate::channel_access::admit_mutation(&state, &auth).await?;
    let operation_state = state.clone();
    admission
        .run(&operation_state, async move {
            if auth.is_guest {
                return Err(AppError::Forbidden(
                    "Guests cannot choose private-room mode".into(),
                ));
            }
            private_room_members(&state, auth.user_id, &channel_id).await?;
            // Serialize the explicit choice with messages and room enable/rekey. Once
            // encryption is enabled, this endpoint can never downgrade it.
            let _policy_guard = state.retention_policy_lock.lock().await;
            let marker = read_marker(&state, &channel_id)
                .map_err(|_| AppError::Internal(MARKER_UNAVAILABLE.into()))?;
            let registry = registry_room(&read_data(&state.config.data_dir)?, &channel_id);
            if matches!(registry, RegistryRoom::Enabled(_))
                || marker.as_ref().is_some_and(|m| m.mode == MarkerMode::Enabled)
            {
                return Err(AppError::Conflict(
                    "This conversation is already encrypted and cannot be downgraded".into(),
                ));
            }
            // The database marker counts as a new-room policy too: with the
            // registry entry lost, each sender can make the choice again.
            let marker_mode = marker.as_ref().map(|m| m.mode);
            if registry == RegistryRoom::Earlier && marker_mode.is_none() {
                return Err(AppError::BadRequest(
                    "This conversation uses the earlier server-readable policy".into(),
                ));
            }
            // Consent recorded before the room was pending (an older registry
            // copy, a recreated conversation) is not carried over: the first
            // choice after pending starts a fresh consent set.
            let starts_fresh = marker_mode == Some(MarkerMode::Pending)
                || registry == RegistryRoom::Pending
                || (registry == RegistryRoom::Earlier && marker_mode == Some(MarkerMode::ServerReadable));
            // The marker records who chose, so a registry listing more
            // consenting senders cannot widen it.
            commit_marker_if_changed(&state, &readable_record(&channel_id, [auth.user_id])).await?;
            mutate_data(&state.config.data_dir, |data| {
                if data.rooms.get(&channel_id).is_some_and(|room| room.enabled) {
                    return Err(AppError::Conflict(
                        "This conversation is already encrypted and cannot be downgraded".into(),
                    ));
                }
                let policy = data.new_room_policies.entry(channel_id.clone()).or_insert_with(|| NewRoomPolicy {
                    mode: NewRoomMode::PendingEncryption,
                    created_at: chrono::Utc::now().to_rfc3339(),
                    chosen_by_user_id: None,
                    consenting_user_ids: BTreeSet::new(),
                });
                if starts_fresh || policy.mode == NewRoomMode::PendingEncryption {
                    policy.mode = NewRoomMode::ServerReadable;
                    policy.chosen_by_user_id = Some(auth.user_id);
                    policy.consenting_user_ids.clear();
                }
                policy.consenting_user_ids.insert(auth.user_id);
                Ok(())
            })?;
            Ok(Json(json!({ "serverReadableSelected": true })))
        })
        .await
}

fn validate_wrapped_key(envelope: &WrappedRoomKey, sender_device_id: &str) -> bool {
    envelope.sender_device_id == sender_device_id
        && valid_device_id(&envelope.recipient_device_id)
        && valid_device_id(&envelope.sender_device_id)
        && valid_key(&envelope.ephemeral_public_key)
        && !envelope.salt.is_empty() && envelope.salt.len() <= MAX_KEY_FIELD
        && !envelope.iv.is_empty() && envelope.iv.len() <= MAX_KEY_FIELD
        && !envelope.ciphertext.is_empty() && envelope.ciphertext.len() <= MAX_WRAPPED_KEY
        && !envelope.signature.is_empty() && envelope.signature.len() <= MAX_KEY_FIELD
}

async fn set_room(
    state: Arc<AppState>,
    auth: AuthUser,
    channel_id: String,
    input: SetRoomInput,
    rekey: bool,
) -> Result<RoomState> {
    if auth.is_guest {
        return Err(AppError::Forbidden("Guests cannot enable E2EE".into()));
    }
    let admission = crate::channel_access::admit_mutation(&state, &auth).await?;
    let operation_state = state.clone();
    admission.run(&operation_state, async move {
    let _policy_guard = state.retention_policy_lock.lock().await;
    let (members, current_revision) = private_room_members(&state, auth.user_id, &channel_id).await?;
    let requested_revision = input.membership_revision.parse::<u64>()
        .map_err(|_| AppError::BadRequest("Invalid E2EE membership revision".into()))?;
    if requested_revision != current_revision {
        return Err(AppError::Conflict("Conversation membership changed. Refresh participants and rekey before sending encrypted messages.".into()));
    }
    let now = chrono::Utc::now().to_rfc3339();
    // The marker's epoch counts as the room's even when the registry lost it,
    // so a rekey after registry loss continues above every epoch ever used.
    let marker_epoch = read_marker(&state, &channel_id)
        .map_err(|_| AppError::Internal(MARKER_UNAVAILABLE.into()))?
        .filter(|m| m.mode == MarkerMode::Enabled)
        .map(|m| m.epoch);
    let apply = |data: &mut E2eeData| -> Result<RoomState> {
        let devices: Vec<&DeviceBundle> = active_devices(data, &members);
        let missing: Vec<_> = members.iter().filter(|uid| !devices.iter().any(|d| d.user_id == **uid)).copied().collect();
        if !missing.is_empty() {
            return Err(AppError::Conflict(format!("Every participant needs an E2EE device before this room can be encrypted. Missing user IDs: {}", missing.iter().map(ToString::to_string).collect::<Vec<_>>().join(", "))));
        }
        data.devices.iter().find(|d| d.user_id == auth.user_id && d.device_id == input.sender_device_id && d.revoked_at.is_none())
            .ok_or_else(|| AppError::Forbidden("The sender E2EE device is not registered to this account".into()))?;
        if input.envelopes.len() != devices.len() || input.envelopes.iter().any(|e| !validate_wrapped_key(e, &input.sender_device_id)) {
            return Err(AppError::BadRequest("Invalid or incomplete wrapped room-key set".into()));
        }
        let expected = device_pairs(devices.iter().copied());
        let actual = envelope_pairs(&input.envelopes);
        if expected != actual {
            return Err(AppError::Conflict("Room keys must be wrapped to every active participant device, with no extra recipients".into()));
        }
        for envelope in &input.envelopes {
            let valid_recipient = devices.iter().any(|d| d.user_id == envelope.recipient_user_id && d.device_id == envelope.recipient_device_id);
            if !valid_recipient { return Err(AppError::BadRequest("Wrapped room key names a device outside this conversation".into())); }
        }
        let registry_epoch = data.rooms.get(&channel_id).map(|r| r.epoch);
        let known_epoch = registry_epoch.max(marker_epoch);
        match known_epoch {
            Some(_) if !rekey => return Err(AppError::Conflict("This conversation is already E2EE. Downgrades are not supported; rotate the key instead.".into())),
            None if rekey => return Err(AppError::Conflict("E2EE is not enabled for this conversation yet".into())),
            Some(epoch) if input.epoch != epoch.saturating_add(1) => {
                return Err(AppError::Conflict(format!("Next E2EE epoch must be {}", epoch.saturating_add(1))))
            }
            None if input.epoch != 1 => return Err(AppError::BadRequest("The first E2EE epoch must be 1".into())),
            _ => {}
        }
        let enabled_at = data.rooms.get(&channel_id).map(|r| r.enabled_at.clone()).unwrap_or_else(|| now.clone());
        let next = RoomState {
            channel_id: channel_id.to_string(),
            enabled: true,
            epoch: input.epoch,
            membership_revision: current_revision,
            enabled_by_user_id: data.rooms.get(&channel_id).map(|r| r.enabled_by_user_id).unwrap_or(auth.user_id),
            enabled_at,
            rekeyed_at: now.clone(),
            envelopes: input.envelopes.clone(),
        };
        data.rooms.insert(channel_id.to_string(), next.clone());
        Ok(next)
    };
    // Validate against the current registry without writing, so a refused
    // request never moves the marker. Then marker first, registry second.
    // Between the two, only the registry can change under us (device
    // registration does not take the policy lock); if the second pass then
    // refuses, the marker is ahead and the room stays closed to readable
    // content until another setup succeeds: the safe direction.
    let mut preview = read_data(&state.config.data_dir)?;
    let planned = apply(&mut preview)?;
    commit_marker_if_changed(&state, &enabled_record(&channel_id, planned.epoch)).await?;
    let room = mutate_data(&state.config.data_dir, apply)?;
    if let Some(io) = state.socket_io() {
        let _ = io.to(channel_id.to_string()).emit("e2ee-room-updated", &json!({
            "channelId": channel_id,
            "enabled": true,
            "epoch": room.epoch,
            "membershipRevision": room.membership_revision.to_string(),
        })).await;
    }
    Ok(room)
    }).await
}

async fn enable_room(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<String>,
    Json(input): Json<SetRoomInput>,
) -> Result<Json<serde_json::Value>> {
    let room = set_room(state, auth, channel_id, input, false).await?;
    Ok(Json(json!({ "room": room })))
}

async fn rekey_room(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<String>,
    Json(input): Json<SetRoomInput>,
) -> Result<Json<serde_json::Value>> {
    let room = set_room(state, auth, channel_id, input, true).await?;
    Ok(Json(json!({ "room": room })))
}

pub fn is_ciphertext(content: &str) -> bool { content.starts_with(MESSAGE_PREFIX) }

fn parse_message(content: &str) -> Option<MessageEnvelope> {
    let raw = content.strip_prefix(MESSAGE_PREFIX)?;
    if raw.len() > 2 * 1024 * 1024 { return None; }
    serde_json::from_str(raw).ok()
}

/// The new-room policy for readable text from `user_id` in a room that is not
/// (yet) encrypted: refused while pending, and after a server-readable choice
/// refused for every sender who has not made that choice themselves.
fn new_room_plaintext_refusal(data: &E2eeData, channel_id: &str, user_id: i64) -> Option<&'static str> {
    match data.new_room_policies.get(channel_id) {
        Some(policy) if policy.mode == NewRoomMode::PendingEncryption => Some(
            "Encryption is pending for this new conversation. Wait for participants to prepare encryption, or explicitly choose server-readable messages.",
        ),
        Some(policy) if !policy.consenting_user_ids.contains(&user_id) => Some(
            "A participant chose server-readable chat. Confirm server-readable messages on your own device before sending.",
        ),
        _ => None,
    }
}

/// Features with no encrypted form (forum, wiki, albums, gallery, incidents,
/// whiteboards) store server-readable text. They follow the same boundary as a
/// plaintext chat message: refused in a room with experimental encryption
/// enabled or pending, and after a server-readable choice only accepted from
/// a sender who made that choice. Call under `retention_policy_lock`, like a
/// send; `feature` names what is unavailable, e.g. "Wiki pages".
async fn require_server_readable_text(state: &AppState, channel_id: &str, user_id: i64, feature: &str) -> Result<()> {
    let data = read_checked(state, channel_id)
        .await
        .map_err(|refusal| AppError::Forbidden(refusal.reason()))?;
    if data.rooms.get(channel_id).is_some_and(|room| room.enabled) {
        return Err(AppError::Forbidden(format!(
            "This conversation uses experimental encryption. {feature} store server-readable text, so they are not available here."
        )));
    }
    match new_room_plaintext_refusal(&data, channel_id, user_id) {
        Some(refusal) => Err(AppError::Forbidden(refusal.into())),
        None => Ok(()),
    }
}

/// Admission for a write of server-readable text into `channel_id`, whose
/// persisted kind the caller already loaded (`require_participation`).
/// Ordinary rooms can never be encrypted: no lock, no registry read. In a DM
/// or group the encryption-policy lock is returned and must be held through
/// the durable write, so the room cannot become encrypted in between.
pub async fn admit_readable_text<'a>(
    state: &'a AppState,
    channel: &wabidb::domain::Channel,
    user_id: i64,
    feature: &str,
) -> Result<Option<tokio::sync::MutexGuard<'a, ()>>> {
    if !crate::channel_access::is_conversation(channel.channel_kind) {
        return Ok(None);
    }
    let guard = state.retention_policy_lock.lock().await;
    require_server_readable_text(state, &channel.channel_id, user_id, feature).await?;
    Ok(Some(guard))
}

/// A bot cannot confirm server-readable mode on a device of its own, and the
/// server does not record who added it to a conversation. So in a new room
/// that a participant switched to server-readable, a bot may post only once
/// every current human member has made that choice themselves; while the room
/// is pending or encrypted, never. Call under `retention_policy_lock`.
pub async fn require_bot_post_allowed(state: &AppState, channel_id: &str) -> Result<()> {
    let data = read_checked(state, channel_id).await.map_err(|refusal| match refusal {
        Refusal::Unavailable(reason) => AppError::Internal(reason.into()),
        Refusal::Behind(reason) => AppError::BadRequest(reason),
    })?;
    if data.rooms.get(channel_id).is_some_and(|room| room.enabled)
        || data.new_room_policies.get(channel_id).is_some_and(|policy| policy.mode == NewRoomMode::PendingEncryption)
    {
        return Err(AppError::BadRequest(
            "Bot sends are unavailable while private-room encryption is pending or enabled".into(),
        ));
    }
    let Some(policy) = data.new_room_policies.get(channel_id) else { return Ok(()) };
    for member in state.wdb.list_channel_members(channel_id).await? {
        let Ok(user_id) = i64::try_from(member.user_id) else { continue };
        if !state.bot_registry.is_bot(member.user_id).await && !policy.consenting_user_ids.contains(&user_id) {
            return Err(AppError::BadRequest(
                "Bots can post in this conversation only after every member has confirmed server-readable messages on their own device.".into(),
            ));
        }
    }
    Ok(())
}

/// The shape of a file the shipped client encrypted before upload
/// (`frontend/src/lib/e2ee.ts`): a random `e2ee-<uuid>.wabi` name and
/// `application/octet-stream`. Nothing about the original file is in it.
pub fn is_opaque_encrypted_upload(file_name: &str, mime_type: &str) -> bool {
    mime_type == "application/octet-stream"
        && file_name
            .strip_prefix("e2ee-")
            .and_then(|rest| rest.strip_suffix(".wabi"))
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
}

/// Admission for an upload bound to a conversation. Where readable text is
/// refused, only the opaque encrypted-upload shape is accepted, so no original
/// file name or plaintext bytes are stored. A damaged registry refuses all.
pub async fn admit_channel_upload<'a>(
    state: &'a AppState,
    channel: &wabidb::domain::Channel,
    user_id: i64,
    file_name: &str,
    mime_type: &str,
) -> Result<Option<tokio::sync::MutexGuard<'a, ()>>> {
    if !crate::channel_access::is_conversation(channel.channel_kind) {
        return Ok(None);
    }
    let guard = state.retention_policy_lock.lock().await;
    let opaque = is_opaque_encrypted_upload(file_name, mime_type);
    match read_checked(state, &channel.channel_id).await {
        // Unreadable state refuses every upload.
        Err(Refusal::Unavailable(reason)) => Err(AppError::Forbidden(reason.into())),
        // A registry behind the database marker: the room is encrypted or
        // pending there, so only the opaque encrypted shape is admitted.
        Err(Refusal::Behind(_)) if opaque => Ok(Some(guard)),
        Err(Refusal::Behind(reason)) => Err(AppError::Forbidden(reason)),
        Ok(_) => match require_server_readable_text(state, &channel.channel_id, user_id, "Plaintext file uploads").await {
            Ok(()) => Ok(Some(guard)),
            Err(_) if opaque => Ok(Some(guard)),
            Err(_) => Err(AppError::Forbidden(
                "Plaintext files cannot be attached to this conversation: it uses experimental encryption or is waiting for it. Send the file from an updated Wabi client, which encrypts it first.".into(),
            )),
        },
    }
}

/// Enforce the private-room content boundary before any server-side content
/// processing. Returns true when this room is E2EE and the opaque envelope is
/// valid for the current epoch. Signature verification is intentionally an
/// endpoint responsibility: the server has no private identity key and cannot
/// make itself an end-to-end authenticity authority.
pub async fn validate_outbound_message(
    state: &AppState, channel_id: &str, user_id: i64, content: &str,
) -> std::result::Result<bool, String> {
    let data = read_checked(state, channel_id).await.map_err(Refusal::reason)?;
    let room = data.rooms.get(channel_id).filter(|r| r.enabled).cloned();
    let Some(room) = room else {
        if is_ciphertext(content) { return Err("E2EE envelopes are only accepted in an E2EE conversation".into()); }
        if let Some(refusal) = new_room_plaintext_refusal(&data, channel_id, user_id) {
            return Err(refusal.into());
        }
        return Ok(false);
    };
    let envelope = parse_message(content).ok_or_else(|| "This E2EE conversation requires a valid encrypted message envelope".to_string())?;
    if envelope.v != 1 || envelope.room != channel_id || envelope.epoch != room.epoch {
        return Err("Encrypted message belongs to the wrong room or key epoch".into());
    }
    let envelope_revision = envelope.membership_revision.parse::<u64>().map_err(|_| "Invalid encrypted membership revision".to_string())?;
    let current_revision = wabidb::projections::channel_members::ChannelMembersProjection::revision(
        &state.wdb.engine().projection_state(), channel_id,
    ).map_err(|e| format!("Could not verify encrypted membership revision: {e}"))?;
    let member_ids: BTreeSet<i64> = state.wdb.list_channel_members(channel_id).await
        .map_err(|e| format!("Could not verify encrypted recipients: {e}"))?
        .into_iter().filter_map(|m| i64::try_from(m.user_id).ok()).collect();
    let expected_devices = device_pairs(active_devices(&data, &member_ids));
    if room.membership_revision != current_revision || envelope_revision != current_revision || envelope_revision != room.membership_revision || envelope.membership_revision != current_revision.to_string() {
        return Err("Conversation membership changed. Rekey this E2EE room before sending more messages.".into());
    }
    if expected_devices != envelope_pairs(&room.envelopes) {
        return Err("E2EE device set changed. Rekey this room before sending more messages.".into());
    }
    let registered_sender = data.devices.iter().any(|d| d.user_id == user_id && d.device_id == envelope.sender_device_id && d.revoked_at.is_none());
    if !registered_sender { return Err("Encrypted message came from an unregistered or revoked device".into()); }
    if envelope.iv.is_empty() || envelope.iv.len() > MAX_KEY_FIELD || envelope.ciphertext.is_empty() || envelope.signature.is_empty() || envelope.signature.len() > MAX_KEY_FIELD {
        return Err("Malformed encrypted message envelope".into());
    }
    // The client's AES-GCM/ECDSA-P256 output: a 12-byte IV, ciphertext with
    // at least its 16-byte tag, a 64-byte signature, all standard base64. A
    // readable value in any of these fields does not decode to that shape.
    let decoded_len = |value: &str| {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.decode(value).ok().map(|bytes| bytes.len())
    };
    if decoded_len(&envelope.iv) != Some(12)
        || decoded_len(&envelope.ciphertext).is_none_or(|len| len < 16)
        || decoded_len(&envelope.signature) != Some(64)
    {
        return Err("Malformed encrypted message envelope".into());
    }
    Ok(true)
}

#[cfg(test)]
mod registry_tests {
    use super::*;

    #[test]
    fn missing_registry_is_a_fresh_instance_but_corrupt_registry_is_preserved() {
        let directory = tempfile::tempdir().unwrap();
        let dir = directory.path().to_str().unwrap();
        assert!(read_data(dir).unwrap().rooms.is_empty());
        for invalid in [b"{".as_slice(), b"{}", b"null", b"{\"devices\":[],\"rooms\":[]}", b"private-canary"] {
            std::fs::write(store_path(dir), invalid).unwrap();
            let error = read_data(dir).unwrap_err().to_string();
            assert!(!error.contains("private-canary"));
            assert!(read_data(dir).is_err());
            let mut invoked = false;
            assert!(mutate_data(dir, |_| { invoked = true; Ok(()) }).is_err());
            assert!(!invoked);
            assert_eq!(std::fs::read(store_path(dir)).unwrap(), invalid);
        }
    }

    #[test]
    fn unreadable_registry_is_not_replaced() {
        let directory = tempfile::tempdir().unwrap();
        let dir = directory.path().to_str().unwrap();
        std::fs::create_dir(store_path(dir)).unwrap();
        assert!(read_data(dir).is_err());
        assert!(mutate_data(dir, |_| Ok(())).is_err());
        assert!(store_path(dir).is_dir());
    }

    #[test]
    fn valid_existing_room_survives_registry_update() {
        let directory = tempfile::tempdir().unwrap();
        let dir = directory.path().to_str().unwrap();
        let room = RoomState {
            channel_id: "dm-test".into(), enabled: true, epoch: 3,
            membership_revision: 9, enabled_by_user_id: 1,
            enabled_at: "2026-09-15".into(), rekeyed_at: "2026-09-15".into(),
            envelopes: vec![],
        };
        mutate_data(dir, |data| { data.rooms.insert(room.channel_id.clone(), room.clone()); Ok(()) }).unwrap();
        assert!(read_data(dir).unwrap().rooms["dm-test"].enabled);
        mutate_data(dir, |_| Ok(())).unwrap();
        let after = read_data(dir).unwrap();
        assert_eq!(serde_json::to_value(&after.rooms["dm-test"]).unwrap(), serde_json::to_value(&room).unwrap());
    }
    async fn make_test_state() -> (tempfile::TempDir, Arc<AppState>) {
        // Keep the TempDir alive for the whole test: dropping it deletes the
        // data dir out from under AppState and the first engine write panics
        // with NotFound. Callers must bind the returned TempDir.
        let data_dir = tempfile::tempdir().unwrap();
        let uploads_dir = data_dir.path().join("uploads");
        std::fs::create_dir_all(&uploads_dir).unwrap();
        let config = crate::config::ServerConfig {
            host: "127.0.0.1".into(),
            port: 3001,
            data_dir: data_dir.path().to_string_lossy().to_string(),
            uploads_dir: uploads_dir.to_string_lossy().to_string(),
            jwt_secret: "test-secret".into(),
            turn_enabled: false,
            turn_uri: None,
            turn_secret: None,
            node_id: "test-node".into(),
            is_primary: true,
            server_role: crate::config::ServerRole::Authority,
            authority_url: None,
            admin_user_ids: vec![],
            blacklist_file: data_dir.path().join("blacklist.txt").to_string_lossy().to_string(),
            max_body_size: None,
            mesh_enabled: false,
            mesh_peers: vec![],
            lore: Default::default(),
        };
        (data_dir, Arc::new(AppState::new(config).await.unwrap()))
    }

    #[tokio::test]
    async fn corrupt_registry_blocks_plaintext_before_content_processing() {
        let (directory, state) = make_test_state().await;
        let original = b"{broken-registry";
        std::fs::write(directory.path().join("e2ee_state.json"), original).unwrap();
        let result = validate_outbound_message(&state, "dm-test", 1, "plain-message-canary").await;
        assert_eq!(result.unwrap_err(), REGISTRY_UNAVAILABLE);
        assert_eq!(std::fs::read(directory.path().join("e2ee_state.json")).unwrap(), original);
    }

    #[tokio::test]
    async fn new_room_requires_each_sender_to_choose_plaintext_and_recreation_resets_it() {
        let (directory, state) = make_test_state().await;
        let dir = directory.path().to_str().unwrap();
        mark_new_room_pending(&state, "dm-test").await.unwrap();
        assert!(validate_outbound_message(&state, "dm-test", 1, "private-canary").await.is_err());
        assert!(validate_outbound_message(&state, "dm-test", 2, "private-canary").await.is_err());

        mutate_data(dir, |data| {
            let policy = data.new_room_policies.get_mut("dm-test").unwrap();
            policy.mode = NewRoomMode::ServerReadable;
            policy.chosen_by_user_id = Some(1);
            policy.consenting_user_ids.insert(1);
            Ok(())
        }).unwrap();
        // A registry weakened on its own, behind the database marker, is refused.
        assert!(validate_outbound_message(&state, "dm-test", 1, "private-canary").await
            .unwrap_err().contains("e2ee_state.json"));
        // The real transition writes the marker first.
        commit_marker(state.wdb.engine(), &readable_record("dm-test", [1]), 1).await.unwrap();
        assert!(!validate_outbound_message(&state, "dm-test", 1, "private-canary").await.unwrap());
        assert!(validate_outbound_message(&state, "dm-test", 2, "private-canary").await
            .unwrap_err().contains("your own device"));

        // Stable DM IDs can be reused after deletion. The new conversation
        // must not inherit the previous conversation's plaintext choice.
        mark_new_room_pending(&state, "dm-test").await.unwrap();
        assert!(validate_outbound_message(&state, "dm-test", 1, "private-canary").await.is_err());
        assert_eq!(read_data(dir).unwrap().new_room_policies["dm-test"].mode, NewRoomMode::PendingEncryption);
    }

    async fn test_group(state: &AppState, id: &str) -> String {
        let a = state.wdb.create_user(&format!("{id}-a"), None, "hash").await.unwrap();
        let b = state.wdb.create_user(&format!("{id}-b"), None, "hash").await.unwrap();
        let ch = format!("group-{id}");
        state.wdb.create_group(&ch, id, a, &[a, b]).await.unwrap();
        ch
    }

    /// A registry room entry that validates: two devices and keys wrapped to both.
    fn valid_enabled_entry(data: &mut E2eeData, ch: &str, epoch: u64) {
        let key = || format!("{}AAAAAAAAAAAA", uuid::Uuid::new_v4().simple());
        let mut envelopes = vec![];
        for uid in [1i64, 2] {
            let device = format!("device-{uid}-1");
            data.devices.push(DeviceBundle {
                user_id: uid, device_id: device.clone(), label: None,
                encryption_public_key: key(), signing_public_key: key(),
                created_at: String::new(), last_seen_at: String::new(), revoked_at: None,
            });
            envelopes.push(WrappedRoomKey {
                recipient_user_id: uid, recipient_device_id: device,
                ephemeral_public_key: key(), salt: "c2FsdA".into(), iv: "aXY".into(),
                ciphertext: "wrapped".into(), sender_device_id: "device-1-1".into(), signature: "c2ln".into(),
            });
        }
        data.rooms.insert(ch.into(), RoomState {
            channel_id: ch.into(), enabled: true, epoch, membership_revision: 0,
            enabled_by_user_id: 1, enabled_at: String::new(), rekeyed_at: String::new(), envelopes,
        });
    }

    fn marker_of(state: &AppState, ch: &str) -> Option<RoomEncryptionRecord> {
        read_marker(state, ch).unwrap()
    }

    /// The privacy label follows the marker when the registry lost the room.
    #[tokio::test]
    async fn room_is_enabled_follows_the_marker_without_a_registry_entry() {
        let (_directory, state) = make_test_state().await;
        let ch = test_group(&state, "label").await;
        assert!(!room_is_enabled(&state, &ch).await.unwrap());
        commit_marker(state.wdb.engine(), &enabled_record(&ch, 2), 0).await.unwrap();
        assert!(room_is_enabled(&state, &ch).await.unwrap());
    }

    /// Integration announcements (Lore) are server-written readable text: a
    /// registry behind the marker blocks them.
    #[tokio::test]
    async fn server_content_is_blocked_when_the_registry_is_behind_the_marker() {
        let (_directory, state) = make_test_state().await;
        for (id, record) in [("blocks-p", None), ("blocks-e", Some(2u64))] {
            let ch = test_group(&state, id).await;
            assert!(!room_blocks_server_content(&state, &ch).await.unwrap());
            let marker = match record {
                Some(epoch) => enabled_record(&ch, epoch),
                None => readable_record(&ch, [1]),
            };
            commit_marker(state.wdb.engine(), &marker, 0).await.unwrap();
            assert!(room_blocks_server_content(&state, &ch).await.unwrap(), "{id}");
        }
    }

    /// A decision (not startup) that sees the registry ahead brings the
    /// marker up, for an existing conversation only.
    #[tokio::test]
    async fn a_decision_brings_the_marker_up_to_a_registry_ahead_of_it() {
        let (directory, state) = make_test_state().await;
        let dir = directory.path().to_str().unwrap();
        let ch = test_group(&state, "catch-up").await;
        mutate_data(dir, |data| {
            data.new_room_policies.insert(ch.clone(), NewRoomPolicy {
                mode: NewRoomMode::PendingEncryption, created_at: String::new(),
                chosen_by_user_id: None, consenting_user_ids: BTreeSet::new(),
            });
            Ok(())
        }).unwrap();
        assert!(marker_of(&state, &ch).is_none());
        assert!(validate_outbound_message(&state, &ch, 1, "plain").await.is_err());
        assert_eq!(marker_of(&state, &ch).map(|m| m.mode), Some(MarkerMode::Pending));
        // An enabled entry ahead of a pending marker brings it to Enabled.
        mutate_data(dir, |data| { valid_enabled_entry(data, &ch, 3); Ok(()) }).unwrap();
        assert!(validate_outbound_message(&state, &ch, 1, "plain").await.is_err());
        assert_eq!(marker_of(&state, &ch), Some(enabled_record(&ch, 3)));
        // Not for an id that is not a conversation (M1), nor from an entry
        // that does not validate (M2).
        let public = state.wdb.create_channel("public", wabidb::domain::ChannelKind::Text, 1, false).await.unwrap();
        let ghost = "group-never-created".to_string();
        let broken = test_group(&state, "broken").await;
        mutate_data(dir, |data| {
            for id in [&public, &ghost] {
                data.new_room_policies.insert(id.to_string(), NewRoomPolicy {
                    mode: NewRoomMode::PendingEncryption, created_at: String::new(),
                    chosen_by_user_id: None, consenting_user_ids: BTreeSet::new(),
                });
            }
            valid_enabled_entry(data, &broken, 0);
            Ok(())
        }).unwrap();
        for id in [&public, &ghost, &broken] {
            let _ = validate_outbound_message(&state, id, 1, "plain").await;
            assert!(marker_of(&state, id).is_none(), "{id}");
        }
        // Startup reconcile skips them too, and does not stop.
        reconcile_room_markers(&state.wdb, dir).await.unwrap();
        for id in [&public, &ghost, &broken] {
            assert!(marker_of(&state, id).is_none(), "{id}");
        }
    }

    /// A conversation id that was encrypted before (stable DM ids come back
    /// after deletion) is never marked pending.
    #[tokio::test]
    async fn a_previously_encrypted_id_is_not_marked_pending() {
        let (directory, state) = make_test_state().await;
        let dir = directory.path().to_str().unwrap();
        let ch = "dm-user-1-user-2";
        mutate_data(dir, |data| { valid_enabled_entry(data, ch, 4); Ok(()) }).unwrap();
        mark_new_room_pending(&state, ch).await.unwrap();
        assert_eq!(marker_of(&state, ch), Some(enabled_record(ch, 4)));
        assert!(!read_data(dir).unwrap().new_room_policies.contains_key(ch));
    }

    /// Writing the marker it already holds commits nothing.
    #[tokio::test]
    async fn an_unchanged_marker_is_not_committed_again() {
        let (_directory, state) = make_test_state().await;
        let ch = test_group(&state, "unchanged").await;
        commit_marker_if_changed(&state, &readable_record(&ch, [5, 9])).await.unwrap();
        let applied = state.wdb.engine().projection_state().applied_commit_seq();
        commit_marker_if_changed(&state, &readable_record(&ch, [9])).await.unwrap();
        commit_marker_if_changed(&state, &readable_record(&ch, [5, 9])).await.unwrap();
        assert_eq!(state.wdb.engine().projection_state().applied_commit_seq(), applied);
        commit_marker_if_changed(&state, &readable_record(&ch, [7])).await.unwrap();
        assert_eq!(state.wdb.engine().projection_state().applied_commit_seq(), applied + 1);
    }

    #[test]
    fn legacy_registry_without_new_room_policy_remains_readable() {
        let directory = tempfile::tempdir().unwrap();
        let dir = directory.path().to_str().unwrap();
        std::fs::write(store_path(dir), br#"{"devices":[],"rooms":{}}"#).unwrap();
        let data = read_data(dir).unwrap();
        assert!(data.new_room_policies.is_empty());
    }
}
