//! Experimental private-room encryption registry.
//!
//! The server never receives room keys or device private keys. It stores only
//! public device identity keys, room epoch metadata and room keys wrapped to
//! participant devices. Message bodies remain opaque `wabi-e2ee-v1:` envelopes.
//! This is deliberately separate from WabiDB at-rest encryption: possession of
//! server data + server-held keys must not be sufficient to recover plaintext.

use axum::{
    extract::{Path, State},
    http::StatusCode,
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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct E2eeData {
    devices: Vec<DeviceBundle>,
    rooms: HashMap<String, RoomState>,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
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

pub(super) fn room_is_enabled(data_dir: &str, channel_id: &str) -> Result<bool> {
    Ok(read_data(data_dir)?.rooms.get(channel_id).is_some_and(|room| room.enabled))
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
        .with_state(state)
}

async fn list_my_devices(State(state): State<Arc<AppState>>, auth: AuthUser) -> Result<Json<serde_json::Value>> {
    if auth.is_guest { return Err(AppError::Forbidden("Guests cannot register E2EE devices".into())); }
    let data = read_data(&state.config.data_dir)?;
    let devices: Vec<_> = data.devices.into_iter().filter(|d| d.user_id == auth.user_id).collect();
    Ok(Json(json!({ "devices": devices })))
}

async fn register_device(
    State(state): State<Arc<AppState>>, auth: AuthUser, Json(mut input): Json<RegisterDeviceInput>,
) -> Result<Json<serde_json::Value>> {
    if auth.is_guest { return Err(AppError::Forbidden("Guests cannot register E2EE devices".into())); }
    input.device_id = input.device_id.trim().to_string();
    input.encryption_public_key = input.encryption_public_key.trim().to_string();
    input.signing_public_key = input.signing_public_key.trim().to_string();
    if !valid_device_id(&input.device_id) || !valid_key(&input.encryption_public_key) || !valid_key(&input.signing_public_key) {
        return Err(AppError::BadRequest("Invalid E2EE device bundle".into()));
    }
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
}

async fn revoke_device(
    State(state): State<Arc<AppState>>, auth: AuthUser, Path(device_id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    if auth.is_guest { return Err(AppError::Forbidden("Guests do not have E2EE devices".into())); }
    let now = chrono::Utc::now().to_rfc3339();
    mutate_data(&state.config.data_dir, |data| {
        let device = data.devices.iter_mut().find(|d| d.user_id == auth.user_id && d.device_id == device_id)
            .ok_or_else(|| AppError::NotFound("E2EE device not found".into()))?;
        if device.revoked_at.is_none() { device.revoked_at = Some(now.clone()); }
        Ok(())
    })?;
    Ok(Json(json!({ "success": true, "deviceId": device_id, "rekeyRequired": true })))
}

async fn room_status(
    State(state): State<Arc<AppState>>, auth: AuthUser, Path(channel_id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    if auth.is_guest { return Err(AppError::Forbidden("Guests cannot use E2EE rooms".into())); }
    let (members, current_revision) = private_room_members(&state, auth.user_id, &channel_id).await?;
    let data = read_data(&state.config.data_dir)?;
    let devices: Vec<DeviceBundle> = active_devices(&data, &members).into_iter().cloned().collect();
    let missing_user_ids: Vec<i64> = members.iter().copied().filter(|uid| !devices.iter().any(|d| d.user_id == *uid)).collect();
    let room = data.rooms.get(&channel_id).filter(|r| r.enabled).cloned();
    let expected = device_pairs(devices.iter());
    let actual = room.as_ref().map(|r| envelope_pairs(&r.envelopes)).unwrap_or_default();
    let needs_rekey = room.as_ref().is_some_and(|r| r.membership_revision != current_revision || expected != actual);
    let my_envelopes: Vec<WrappedRoomKey> = room.as_ref().map(|r| r.envelopes.iter().filter(|e| e.recipient_user_id == auth.user_id).cloned().collect()).unwrap_or_default();
    Ok(Json(json!({
        "enabled": room.is_some(),
        "epoch": room.as_ref().map(|r| r.epoch).unwrap_or(0),
        "membershipRevision": room.as_ref().map(|r| r.membership_revision.to_string()).unwrap_or_else(|| current_revision.to_string()),
        "currentMembershipRevision": current_revision.to_string(),
        "needsRekey": needs_rekey,
        "devices": devices,
        "missingUserIds": missing_user_ids,
        "keyEnvelopes": my_envelopes,
        "downgradeAllowed": false,
    })))
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
    state: &AppState, auth: &AuthUser, channel_id: &str, input: SetRoomInput, rekey: bool,
) -> Result<RoomState> {
    if auth.is_guest { return Err(AppError::Forbidden("Guests cannot enable E2EE".into())); }
    let (members, current_revision) = private_room_members(state, auth.user_id, channel_id).await?;
    let requested_revision = input.membership_revision.parse::<u64>()
        .map_err(|_| AppError::BadRequest("Invalid E2EE membership revision".into()))?;
    if requested_revision != current_revision {
        return Err(AppError::Conflict("Conversation membership changed. Refresh participants and rekey before sending encrypted messages.".into()));
    }
    let now = chrono::Utc::now().to_rfc3339();
    let room = mutate_data(&state.config.data_dir, |data| {
        let devices: Vec<&DeviceBundle> = active_devices(data, &members);
        let missing: Vec<_> = members.iter().filter(|uid| !devices.iter().any(|d| d.user_id == **uid)).copied().collect();
        if !missing.is_empty() {
            return Err(AppError::Conflict(format!("Every participant needs an E2EE device before this room can be encrypted. Missing user IDs: {}", missing.iter().map(ToString::to_string).collect::<Vec<_>>().join(", "))));
        }
        let sender = data.devices.iter().find(|d| d.user_id == auth.user_id && d.device_id == input.sender_device_id && d.revoked_at.is_none())
            .ok_or_else(|| AppError::Forbidden("The sender E2EE device is not registered to this account".into()))?;
        let _ = sender;
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
        match data.rooms.get(channel_id) {
            Some(existing) if !rekey => return Err(AppError::Conflict("This conversation is already E2EE. Downgrades are not supported; rotate the key instead.".into())),
            None if rekey => return Err(AppError::Conflict("E2EE is not enabled for this conversation yet".into())),
            Some(existing) if rekey && input.epoch != existing.epoch.saturating_add(1) => {
                return Err(AppError::Conflict(format!("Next E2EE epoch must be {}", existing.epoch.saturating_add(1))))
            }
            None if !rekey && input.epoch != 1 => return Err(AppError::BadRequest("The first E2EE epoch must be 1".into())),
            _ => {}
        }
        let enabled_at = data.rooms.get(channel_id).map(|r| r.enabled_at.clone()).unwrap_or_else(|| now.clone());
        let next = RoomState {
            channel_id: channel_id.to_string(),
            enabled: true,
            epoch: input.epoch,
            membership_revision: current_revision,
            enabled_by_user_id: data.rooms.get(channel_id).map(|r| r.enabled_by_user_id).unwrap_or(auth.user_id),
            enabled_at,
            rekeyed_at: now.clone(),
            envelopes: input.envelopes.clone(),
        };
        data.rooms.insert(channel_id.to_string(), next.clone());
        Ok(next)
    })?;
    if let Some(io) = state.sio.read().await.clone() {
        let _ = io.to(channel_id.to_string()).emit("e2ee-room-updated", &json!({
            "channelId": channel_id,
            "enabled": true,
            "epoch": room.epoch,
            "membershipRevision": room.membership_revision.to_string(),
        })).await;
    }
    Ok(room)
}

async fn enable_room(
    State(state): State<Arc<AppState>>, auth: AuthUser, Path(channel_id): Path<String>, Json(input): Json<SetRoomInput>,
) -> Result<Json<serde_json::Value>> {
    let room = set_room(&state, &auth, &channel_id, input, false).await?;
    Ok(Json(json!({ "room": room })))
}

async fn rekey_room(
    State(state): State<Arc<AppState>>, auth: AuthUser, Path(channel_id): Path<String>, Json(input): Json<SetRoomInput>,
) -> Result<Json<serde_json::Value>> {
    let room = set_room(&state, &auth, &channel_id, input, true).await?;
    Ok(Json(json!({ "room": room })))
}

pub fn is_ciphertext(content: &str) -> bool { content.starts_with(MESSAGE_PREFIX) }

fn parse_message(content: &str) -> Option<MessageEnvelope> {
    let raw = content.strip_prefix(MESSAGE_PREFIX)?;
    if raw.len() > 2 * 1024 * 1024 { return None; }
    serde_json::from_str(raw).ok()
}

/// Enforce the private-room content boundary before any server-side content
/// processing. Returns true when this room is E2EE and the opaque envelope is
/// valid for the current epoch. Signature verification is intentionally an
/// endpoint responsibility: the server has no private identity key and cannot
/// make itself an end-to-end authenticity authority.
pub async fn validate_outbound_message(
    state: &AppState, channel_id: &str, user_id: i64, content: &str,
) -> std::result::Result<bool, String> {
    let data = read_data(&state.config.data_dir).map_err(|_| REGISTRY_UNAVAILABLE.to_string())?;
    let room = data.rooms.get(channel_id).filter(|r| r.enabled).cloned();
    let Some(room) = room else {
        if is_ciphertext(content) { return Err("E2EE envelopes are only accepted in an E2EE conversation".into()); }
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
            assert!(room_is_enabled(dir, "dm-test").is_err());
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
        assert!(room_is_enabled(dir, "dm-test").unwrap());
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
}
