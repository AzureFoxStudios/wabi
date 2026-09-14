//! Persistent, transport-neutral voice-channel policy.
//!
//! Voice policy belongs to the Wabi Authority, not LiveKit/mediasoup/P2P.  The
//! current WabiDB Channel record does not yet carry voice-specific settings, so
//! this small authority-owned registry makes the existing settings real and
//! restart-safe without coupling the media work to a storage-schema migration.
//! A future WabiDB migration can preserve this JSON contract unchanged.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    sync::{OnceLock, RwLock},
};

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

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VoicePolicyFile {
    #[serde(default)]
    channels: HashMap<String, VoiceChannelPolicy>,
}

type StoreCache = HashMap<PathBuf, VoicePolicyFile>;

fn cache() -> &'static RwLock<StoreCache> {
    static CACHE: OnceLock<RwLock<StoreCache>> = OnceLock::new();
    CACHE.get_or_init(|| RwLock::new(HashMap::new()))
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
}
