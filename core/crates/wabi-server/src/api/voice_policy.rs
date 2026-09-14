//! Persistent, transport-neutral voice-channel policy plus volatile admission state.
//!
//! Voice policy belongs to the Wabi Authority, not LiveKit/mediasoup/P2P. The
//! current WabiDB Channel record does not yet carry voice-specific settings, so
//! this small authority-owned registry makes the existing settings real and
//! restart-safe without coupling the media work to a storage-schema migration.
//! Admission state is intentionally NOT persisted: it is bound to a live
//! Socket.IO connection and exists only to authorize realtime transports.

use axum::{
    extract::{Path as AxumPath, State},
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, OnceLock, RwLock},
};
use wabidb::engine::wabi_store::WabiStore;

use crate::{auth_extractor::AuthUser, error::AppError, state::AppState};

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VoiceEntryMode {
    #[default]
    Open,
    /// Join the room but begin suppressed. The user may unmute themselves unless
    /// another server-side moderation rule also forbids publication.
    Muted,
    /// Audience/listener admission. The Authority must not grant microphone,
    /// camera, or screen publication to this admission.
    ListenOnly,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VoiceChannelPolicy {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bitrate_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_limit: Option<u32>,
    #[serde(default)]
    pub force_solo: bool,
    #[serde(default)]
    pub entry_mode: VoiceEntryMode,
}

/// Authoritative result of one Socket.IO voice admission. The HTTP/SFU broker
/// must match channel + user + socket; account identity alone is insufficient
/// because one account can have several devices with different admission modes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VoiceAdmission {
    pub user_id: i64,
    pub socket_id: String,
    pub listening_only: bool,
    pub muted_on_entry: bool,
    pub server_muted: bool,
    pub server_deafened: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VoicePolicyFile {
    #[serde(default)]
    channels: HashMap<String, VoiceChannelPolicy>,
}

type StoreCache = HashMap<PathBuf, VoicePolicyFile>;
type AdmissionMap = HashMap<String, HashMap<String, VoiceAdmission>>;

fn cache() -> &'static RwLock<StoreCache> {
    static CACHE: OnceLock<RwLock<StoreCache>> = OnceLock::new();
    CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

fn admissions() -> &'static RwLock<AdmissionMap> {
    static ADMISSIONS: OnceLock<RwLock<AdmissionMap>> = OnceLock::new();
    ADMISSIONS.get_or_init(|| RwLock::new(HashMap::new()))
}

pub fn record_admission(channel_id: &str, admission: VoiceAdmission) {
    admissions()
        .write()
        .expect("voice admission registry")
        .entry(channel_id.to_string())
        .or_default()
        .insert(admission.socket_id.clone(), admission);
}

pub fn remove_admission(channel_id: &str, socket_id: &str) {
    let mut guard = admissions().write().expect("voice admission registry");
    if let Some(channel) = guard.get_mut(channel_id) {
        channel.remove(socket_id);
        if channel.is_empty() {
            guard.remove(channel_id);
        }
    }
}

pub fn remove_socket_admissions(socket_id: &str) {
    let mut guard = admissions().write().expect("voice admission registry");
    guard.retain(|_, channel| {
        channel.remove(socket_id);
        !channel.is_empty()
    });
}

pub fn admission_for(channel_id: &str, user_id: i64, socket_id: &str) -> Option<VoiceAdmission> {
    admissions()
        .read()
        .expect("voice admission registry")
        .get(channel_id)
        .and_then(|channel| channel.get(socket_id))
        .filter(|admission| admission.user_id == user_id)
        .cloned()
}

fn store_path(data_dir: &str) -> PathBuf {
    PathBuf::from(data_dir).join("voice_policies.json")
}

fn load(path: &Path) -> VoicePolicyFile {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<VoicePolicyFile>(&raw).ok())
        .unwrap_or_default()
}

fn with_store<R>(data_dir: &str, f: impl FnOnce(&VoicePolicyFile) -> R) -> R {
    let path = store_path(data_dir);
    if let Some(existing) = cache().read().expect("voice policy cache").get(&path).cloned() {
        return f(&existing);
    }
    let loaded = load(&path);
    cache()
        .write()
        .expect("voice policy cache")
        .entry(path)
        .or_insert_with(|| loaded.clone());
    f(&loaded)
}

pub fn get(data_dir: &str, channel_id: &str) -> VoiceChannelPolicy {
    with_store(data_dir, |store| {
        store.channels.get(channel_id).cloned().unwrap_or_default()
    })
}

pub fn set(
    data_dir: &str,
    channel_id: &str,
    policy: VoiceChannelPolicy,
) -> Result<VoiceChannelPolicy, String> {
    if channel_id.trim().is_empty() {
        return Err("channel id is required".into());
    }
    validate(&policy)?;
    let path = store_path(data_dir);
    let mut guard = cache().write().map_err(|_| "voice policy cache poisoned".to_string())?;
    let store = guard.entry(path.clone()).or_insert_with(|| load(&path));
    store.channels.insert(channel_id.to_string(), policy.clone());
    persist(&path, store)?;
    Ok(policy)
}

/// Merge the frontend's existing `voiceSettings` object into the persistent
/// Wabi policy. Missing fields keep their previous value; explicit null clears
/// optional values. Unknown fields are ignored so older/newer clients can
/// interoperate during rolling upgrades.
pub fn update_from_value(
    data_dir: &str,
    channel_id: &str,
    value: &Value,
) -> Result<VoiceChannelPolicy, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "voiceSettings must be an object".to_string())?;
    let mut next = get(data_dir, channel_id);

    if let Some(raw) = object.get("bitrateMode") {
        next.bitrate_mode = if raw.is_null() {
            None
        } else {
            let mode = raw
                .as_str()
                .ok_or_else(|| "bitrateMode must be a string or null".to_string())?
                .trim()
                .to_ascii_lowercase();
            if !matches!(mode.as_str(), "auto" | "low" | "standard" | "high") {
                return Err("unsupported bitrateMode".into());
            }
            Some(mode)
        };
    }

    if let Some(raw) = object.get("userLimit") {
        next.user_limit = if raw.is_null() {
            None
        } else {
            let limit = raw
                .as_u64()
                .ok_or_else(|| "userLimit must be an integer or null".to_string())?;
            if !(1..=99).contains(&limit) {
                return Err("userLimit must be between 1 and 99".into());
            }
            Some(limit as u32)
        };
    }

    if let Some(raw) = object.get("forceSolo") {
        next.force_solo = raw
            .as_bool()
            .ok_or_else(|| "forceSolo must be a boolean".to_string())?;
    }

    if let Some(raw) = object.get("entryMode") {
        let mode = raw
            .as_str()
            .ok_or_else(|| "entryMode must be a string".to_string())?;
        next.entry_mode = match mode {
            "open" => VoiceEntryMode::Open,
            "muted" => VoiceEntryMode::Muted,
            "listen_only" | "listen-only" => VoiceEntryMode::ListenOnly,
            _ => return Err("entryMode must be open, muted, or listen_only".into()),
        };
    }

    set(data_dir, channel_id, next)
}

pub fn remove(data_dir: &str, channel_id: &str) -> Result<(), String> {
    let path = store_path(data_dir);
    let mut guard = cache().write().map_err(|_| "voice policy cache poisoned".to_string())?;
    let store = guard.entry(path.clone()).or_insert_with(|| load(&path));
    if store.channels.remove(channel_id).is_some() {
        persist(&path, store)?;
    }
    Ok(())
}

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/{channel_id}", get(get_policy_route).put(put_policy_route))
        .with_state(state)
}

async fn get_policy_route(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    AxumPath(channel_id): AxumPath<String>,
) -> Result<Json<Value>, AppError> {
    let channel = crate::channel_access::require_access(&state, auth.user_id, &channel_id).await?;
    if channel.channel_kind != wabidb::domain::ChannelKind::Voice {
        return Err(AppError::BadRequest("voice policy only applies to voice channels".into()));
    }
    let policy = get(&state.config.data_dir, &channel_id);
    Ok(Json(json!({ "channelId": channel_id, "voiceSettings": policy })))
}

async fn put_policy_route(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    AxumPath(channel_id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, AppError> {
    if !state.is_admin(auth.user_id).await {
        return Err(AppError::Unauthorized("only admins can change voice policy".into()));
    }
    let channel = state
        .wdb
        .get_channel(&channel_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Channel {channel_id} not found")))?;
    if channel.channel_kind != wabidb::domain::ChannelKind::Voice {
        return Err(AppError::BadRequest("voice policy only applies to voice channels".into()));
    }
    let settings = body.get("voiceSettings").unwrap_or(&body);
    let policy = update_from_value(&state.config.data_dir, &channel_id, settings)
        .map_err(AppError::BadRequest)?;

    if let Some(io) = state.sio.read().await.clone() {
        let _ = io
            .broadcast()
            .emit(
                "channel-updated",
                &json!({ "channelId": channel_id, "voiceSettings": policy }),
            )
            .await;
    }
    Ok(Json(json!({ "channelId": channel_id, "voiceSettings": policy })))
}

fn validate(policy: &VoiceChannelPolicy) -> Result<(), String> {
    if let Some(limit) = policy.user_limit {
        if !(1..=99).contains(&limit) {
            return Err("userLimit must be between 1 and 99".into());
        }
    }
    if let Some(mode) = policy.bitrate_mode.as_deref() {
        if !matches!(mode, "auto" | "low" | "standard" | "high") {
            return Err("unsupported bitrateMode".into());
        }
    }
    Ok(())
}

fn persist(path: &Path, store: &VoicePolicyFile) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("create voice policy directory: {error}"))?;
    }
    let bytes = serde_json::to_vec_pretty(store)
        .map_err(|error| format!("serialize voice policies: {error}"))?;
    let temp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4().simple()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temp)
        .map_err(|error| format!("create voice policy temp file: {error}"))?;
    let result = (|| -> Result<(), String> {
        file.write_all(&bytes)
            .map_err(|error| format!("write voice policies: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("sync voice policies: {error}"))?;
        drop(file);
        std::fs::rename(&temp, path)
            .map_err(|error| format!("replace voice policies: {error}"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

#[cfg(test)]
pub fn clear_cache_for_tests() {
    cache().write().expect("voice policy cache").clear();
    admissions().write().expect("voice admission registry").clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_round_trips_and_survives_cache_reload() {
        let root = std::env::temp_dir().join(format!("wabi-voice-policy-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let dir = root.to_string_lossy().to_string();
        let stored = update_from_value(
            &dir,
            "voice-a",
            &serde_json::json!({
                "bitrateMode": "high",
                "userLimit": 25,
                "forceSolo": false,
                "entryMode": "muted"
            }),
        )
        .unwrap();
        assert_eq!(stored.entry_mode, VoiceEntryMode::Muted);
        assert_eq!(stored.user_limit, Some(25));

        clear_cache_for_tests();
        let reopened = get(&dir, "voice-a");
        assert_eq!(reopened, stored);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn listen_only_and_invalid_limits_are_distinct() {
        let root = std::env::temp_dir().join(format!("wabi-voice-policy-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let dir = root.to_string_lossy().to_string();
        let stored = update_from_value(
            &dir,
            "voice-a",
            &serde_json::json!({ "entryMode": "listen_only" }),
        )
        .unwrap();
        assert_eq!(stored.entry_mode, VoiceEntryMode::ListenOnly);
        assert!(update_from_value(&dir, "voice-a", &serde_json::json!({ "userLimit": 0 })).is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn admission_is_bound_to_exact_user_and_socket() {
        clear_cache_for_tests();
        record_admission(
            "voice-a",
            VoiceAdmission {
                user_id: 7,
                socket_id: "sock-a".into(),
                listening_only: true,
                muted_on_entry: false,
                server_muted: false,
                server_deafened: false,
            },
        );
        assert!(admission_for("voice-a", 7, "sock-a").is_some());
        assert!(admission_for("voice-a", 8, "sock-a").is_none());
        assert!(admission_for("voice-a", 7, "sock-b").is_none());
        remove_admission("voice-a", "sock-a");
        assert!(admission_for("voice-a", 7, "sock-a").is_none());
    }
}
