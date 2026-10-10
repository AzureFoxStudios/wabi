//! Web Push subscription store + VAPID key management.
//!
//! Persists under `<data_dir>/web_push.json` (subscriptions + VAPID keys).
//! Payload policy: metadata-friendly; callers choose title/body.

use base64::{engine::general_purpose::{URL_SAFE_NO_PAD, STANDARD}, Engine as _};
use p256::ecdsa::SigningKey;
use p256::pkcs8::{EncodePrivateKey, LineEnding};
use p256::PublicKey;
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{info, warn};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushSubscriptionRecord {
    pub user_id: i64,
    pub device_id: String,
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
    pub platform: String,
    pub user_agent: Option<String>,
    pub updated_at_ms: i64,
}

/// Account-level switches: which kinds of event may push to this account's
/// devices at all.
///
/// Server channels have no account-level switch: they are gated solely by the
/// per-channel opt-in list in `push_channels` (see below), so `direct_messages`
/// and `calls` act only on their own kinds — a DM follows this switch and
/// ignores the channel list, a call rings from `calls` alone (a missed call is
/// the whole point of push). Anything broader, such as mentions in shared
/// channels or followed-channel activity, is opt-in and is added here only
/// together with the dispatcher that honours it, so no toggle ever exists
/// without working behind it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushPreferences {
    #[serde(default = "enabled")]
    pub direct_messages: bool,
    #[serde(default = "enabled")]
    pub calls: bool,
}

fn enabled() -> bool {
    true
}

impl Default for PushPreferences {
    fn default() -> Self {
        Self { direct_messages: true, calls: true }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct WebPushFile {
    /// account id -> delivery preferences (absent = defaults)
    #[serde(default)]
    preferences: HashMap<i64, PushPreferences>,
    /// account id -> server channels (anything but DMs) the account
    /// explicitly turned message push on for. Opt-in: an absent entry means
    /// that account gets no channel message push at all, which is the promise
    /// the settings list makes. DMs never live here; they follow the
    /// account-level switch.
    #[serde(default)]
    push_channels: HashMap<i64, BTreeSet<String>>,
    /// PKCS8 PEM private key
    vapid_private_pem: Option<String>,
    /// Uncompressed public key, URL-safe base64 (no pad) — browser applicationServerKey
    vapid_public_b64: Option<String>,
    /// mailto: or https: contact for VAPID claims
    vapid_subject: Option<String>,
    /// endpoint -> subscription
    subscriptions: HashMap<String, PushSubscriptionRecord>,
}

#[derive(Clone)]
pub struct WebPushStore {
    path: PathBuf,
    inner: Arc<RwLock<WebPushFile>>,
}

impl WebPushStore {
    pub fn new_persistent(data_dir: impl AsRef<Path>) -> Self {
        let path = data_dir.as_ref().join("web_push.json");
        let mut data = match std::fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<WebPushFile>(&text) {
                Ok(data) => data,
                Err(err) => {
                    // Never silently replace a file we cannot read: fresh VAPID
                    // keys would strand every existing subscription. Keep the
                    // evidence for the operator and start clean.
                    let aside = path.with_extension(format!("json.corrupt-{}", now_ms()));
                    warn!(
                        "web_push.json is unreadable ({err}); moving it to {} and starting fresh",
                        aside.display()
                    );
                    let _ = std::fs::rename(&path, &aside);
                    WebPushFile::default()
                }
            },
            Err(_) => WebPushFile::default(),
        };

        if data.vapid_private_pem.is_none() || data.vapid_public_b64.is_none() {
            // Ensure the directory exists before writing the key file.
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            match generate_vapid_keypair() {
                Ok((pem, pub_b64)) => {
                    data.vapid_private_pem = Some(pem);
                    data.vapid_public_b64 = Some(pub_b64);
                    data.vapid_subject = Some(
                        std::env::var("WABI_VAPID_SUBJECT")
                            .unwrap_or_else(|_| "mailto:admin@localhost".into()),
                    );
                    match serde_json::to_string_pretty(&data)
                        .map_err(anyhow::Error::from)
                        .and_then(|json| write_private_atomic(&path, json.as_bytes()))
                    {
                        Ok(()) => info!("Generated Web Push VAPID keypair at {}", path.display()),
                        Err(err) => warn!(
                            "Generated a Web Push VAPID keypair but could not save it to {}: {err}",
                            path.display()
                        ),
                    }
                }
                Err(err) => {
                    warn!("Failed to generate VAPID keys: {err}");
                }
            }
        }

        Self {
            path,
            inner: Arc::new(RwLock::new(data)),
        }
    }

    pub async fn public_key(&self) -> Option<String> {
        self.inner.read().await.vapid_public_b64.clone()
    }

    pub async fn subject(&self) -> String {
        self.inner
            .read()
            .await
            .vapid_subject
            .clone()
            .unwrap_or_else(|| "mailto:admin@localhost".into())
    }

    pub async fn private_pem(&self) -> Option<String> {
        self.inner.read().await.vapid_private_pem.clone()
    }

    /// Register or refresh a device. A device re-subscribing with a new endpoint
    /// replaces its old one, and an account never keeps more than
    /// `max_per_user` devices (the least recently registered are evicted), so
    /// stored push secrets stay bounded.
    pub async fn upsert(&self, record: PushSubscriptionRecord, max_per_user: usize) -> anyhow::Result<()> {
        let mut guard = self.inner.write().await;
        let (user_id, device_id) = (record.user_id, record.device_id.clone());
        guard
            .subscriptions
            .retain(|endpoint, existing| {
                *endpoint == record.endpoint
                    || !(existing.user_id == user_id && existing.device_id == device_id)
            });
        guard.subscriptions.insert(record.endpoint.clone(), record);
        let mut owned: Vec<(i64, String)> = guard
            .subscriptions
            .iter()
            .filter(|(_, r)| r.user_id == user_id)
            .map(|(endpoint, r)| (r.updated_at_ms, endpoint.clone()))
            .collect();
        if owned.len() > max_per_user.max(1) {
            owned.sort();
            for (_, endpoint) in owned.iter().take(owned.len() - max_per_user.max(1)) {
                guard.subscriptions.remove(endpoint);
            }
        }
        self.persist_locked(&guard)?;
        Ok(())
    }

    /// Remove an endpoint only when it belongs to the authenticated account.
    ///
    /// Endpoints are bearer-like opaque URLs supplied by push providers. Knowing
    /// another device's endpoint must never be sufficient to unsubscribe it.
    /// Returns `true` when an owned subscription was removed and `false` when
    /// the endpoint is absent or belongs to another user.
    pub async fn remove_endpoint_for_user(
        &self,
        user_id: i64,
        endpoint: &str,
    ) -> anyhow::Result<bool> {
        let mut guard = self.inner.write().await;
        let owned = guard
            .subscriptions
            .get(endpoint)
            .map(|record| record.user_id == user_id)
            .unwrap_or(false);
        if !owned {
            return Ok(false);
        }
        guard.subscriptions.remove(endpoint);
        self.persist_locked(&guard)?;
        Ok(true)
    }

    pub async fn remove_user_device(&self, user_id: i64, device_id: &str) -> anyhow::Result<()> {
        let mut guard = self.inner.write().await;
        guard.subscriptions.retain(|_, r| !(r.user_id == user_id && r.device_id == device_id));
        self.persist_locked(&guard)?;
        Ok(())
    }

    pub async fn preferences_for(&self, user_id: i64) -> PushPreferences {
        self.inner.read().await.preferences.get(&user_id).copied().unwrap_or_default()
    }

    pub async fn set_preferences(&self, user_id: i64, preferences: PushPreferences) -> anyhow::Result<()> {
        let mut guard = self.inner.write().await;
        if preferences == PushPreferences::default() {
            guard.preferences.remove(&user_id);
        } else {
            guard.preferences.insert(user_id, preferences);
        }
        self.persist_locked(&guard)?;
        Ok(())
    }

    /// Server channels this account explicitly switched message push on for.
    /// Opt-in: an account that never chose has none, so no channel pushes.
    pub async fn push_channels_for(&self, user_id: i64) -> BTreeSet<String> {
        self.inner
            .read()
            .await
            .push_channels
            .get(&user_id)
            .cloned()
            .unwrap_or_default()
    }

    /// True only when the account turned this specific channel on.
    pub async fn push_channel_enabled(&self, user_id: i64, channel_id: &str) -> bool {
        self.inner
            .read()
            .await
            .push_channels
            .get(&user_id)
            .map(|channels| channels.contains(channel_id))
            .unwrap_or(false)
    }

    /// Replace an account's opt-in list. An empty list drops the entry so an
    /// account that turned everything back off leaves no stored state behind.
    pub async fn set_push_channels(&self, user_id: i64, channels: BTreeSet<String>) -> anyhow::Result<()> {
        let mut guard = self.inner.write().await;
        if channels.is_empty() {
            guard.push_channels.remove(&user_id);
        } else {
            guard.push_channels.insert(user_id, channels);
        }
        self.persist_locked(&guard)?;
        Ok(())
    }

    pub async fn list_for_user(&self, user_id: i64) -> Vec<PushSubscriptionRecord> {
        self.inner
            .read()
            .await
            .subscriptions
            .values()
            .filter(|r| r.user_id == user_id)
            .cloned()
            .collect()
    }

    fn persist_locked(&self, data: &WebPushFile) -> anyhow::Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(data)?;
        write_private_atomic(&self.path, json.as_bytes())
    }
}

/// The file holds the VAPID private key and every device's push secrets, so it
/// is owner-readable only and replaced atomically (a crash cannot leave a
/// half-written key file that regenerates keys and strands every subscription).
fn write_private_atomic(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    use std::io::Write;
    let tmp = path.with_extension("json.tmp");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&tmp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&tmp, path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // An older file may predate the restriction; tighten it either way.
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}


fn generate_vapid_keypair() -> anyhow::Result<(String, String)> {
    let signing_key = SigningKey::random(&mut OsRng);
    let pem = signing_key
        .to_pkcs8_pem(LineEnding::LF)
        .map_err(|e| anyhow::anyhow!("pkcs8 encode: {e}"))?
        .to_string();
    let verifying = signing_key.verifying_key();
    let public = PublicKey::from(verifying);
    // Uncompressed point 0x04 || x || y
    let encoded = public.to_sec1_bytes();
    let pub_b64 = URL_SAFE_NO_PAD.encode(encoded.as_ref());
    // silence unused STANDARD if any
    let _ = STANDARD;
    Ok((pem, pub_b64))
}

/// Build a minimal Web Push request body helper — actual HTTP send lives in api/push.rs
pub fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_dir(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("wabi-push-{name}-{nonce}"))
    }

    fn subscription(user_id: i64, endpoint: &str, device_id: &str) -> PushSubscriptionRecord {
        PushSubscriptionRecord {
            user_id,
            device_id: device_id.into(),
            endpoint: endpoint.into(),
            p256dh: "p256dh".into(),
            auth: "auth".into(),
            platform: "test".into(),
            user_agent: None,
            updated_at_ms: now_ms(),
        }
    }

    #[tokio::test]
    async fn endpoint_unsubscribe_cannot_remove_another_users_device() {
        let dir = test_dir("ownership");
        std::fs::create_dir_all(&dir).unwrap();
        let store = WebPushStore::new_persistent(&dir);
        store.upsert(subscription(7, "https://push.example/device", "phone"), 10).await.unwrap();

        let removed = store
            .remove_endpoint_for_user(8, "https://push.example/device")
            .await
            .unwrap();
        assert!(!removed);
        assert_eq!(store.list_for_user(7).await.len(), 1);

        let removed = store
            .remove_endpoint_for_user(7, "https://push.example/device")
            .await
            .unwrap();
        assert!(removed);
        assert!(store.list_for_user(7).await.is_empty());

        let _ = std::fs::remove_dir_all(dir);
    }

    fn subscription_at(user_id: i64, endpoint: &str, device_id: &str, at: i64) -> PushSubscriptionRecord {
        PushSubscriptionRecord { updated_at_ms: at, ..subscription(user_id, endpoint, device_id) }
    }

    #[tokio::test]
    async fn a_device_that_resubscribes_replaces_its_old_endpoint() {
        let dir = test_dir("resubscribe");
        let store = WebPushStore::new_persistent(&dir);
        store.upsert(subscription(1, "https://push.example/old", "phone"), 10).await.unwrap();
        store.upsert(subscription(1, "https://push.example/new", "phone"), 10).await.unwrap();
        let subs = store.list_for_user(1).await;
        assert_eq!(subs.len(), 1);
        assert_eq!(subs[0].endpoint, "https://push.example/new");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn an_account_cannot_accumulate_unbounded_devices() {
        let dir = test_dir("cap");
        let store = WebPushStore::new_persistent(&dir);
        for n in 0..5 {
            store
                .upsert(subscription_at(1, &format!("https://push.example/{n}"), &format!("d{n}"), 100 + n), 3)
                .await
                .unwrap();
        }
        store.upsert(subscription_at(2, "https://push.example/other", "x", 1), 3).await.unwrap();
        let mut kept: Vec<_> = store.list_for_user(1).await.into_iter().map(|s| s.device_id).collect();
        kept.sort();
        assert_eq!(kept, ["d2", "d3", "d4"], "the oldest registrations are evicted");
        assert_eq!(store.list_for_user(2).await.len(), 1, "another account is untouched");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn preferences_default_on_persist_and_collapse_back_to_default() {
        let dir = test_dir("prefs");
        let store = WebPushStore::new_persistent(&dir);
        assert_eq!(store.preferences_for(5).await, PushPreferences { direct_messages: true, calls: true });
        store
            .set_preferences(5, PushPreferences { direct_messages: false, calls: true })
            .await
            .unwrap();
        let reopened = WebPushStore::new_persistent(&dir);
        assert!(!reopened.preferences_for(5).await.direct_messages);
        assert!(reopened.preferences_for(5).await.calls);
        assert!(reopened.preferences_for(6).await.direct_messages, "other accounts keep defaults");
        reopened.set_preferences(5, PushPreferences::default()).await.unwrap();
        assert!(!std::fs::read_to_string(dir.join("web_push.json")).unwrap().contains("\"5\""));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn message_push_is_opt_in_per_channel_and_collapses_back() {
        let dir = test_dir("channels");
        let store = WebPushStore::new_persistent(&dir);
        assert!(
            store.push_channels_for(5).await.is_empty(),
            "an untouched account starts with nothing enabled"
        );
        assert!(!store.push_channel_enabled(5, "ch_general").await);

        store
            .set_push_channels(
                5,
                BTreeSet::from(["ch_general".into(), "group-a".into()]),
            )
            .await
            .unwrap();
        assert!(store.push_channel_enabled(5, "ch_general").await);
        assert!(store.push_channel_enabled(5, "group-a").await);
        assert!(
            !store.push_channel_enabled(6, "ch_general").await,
            "the opt-in is per account"
        );

        let reopened = WebPushStore::new_persistent(&dir);
        assert!(
            reopened.push_channel_enabled(5, "group-a").await,
            "choices survive a restart"
        );

        reopened.set_push_channels(5, BTreeSet::new()).await.unwrap();
        assert!(!reopened.push_channel_enabled(5, "group-a").await);
        assert!(
            !std::fs::read_to_string(dir.join("web_push.json")).unwrap().contains("\"5\""),
            "an emptied choice drops the entry entirely"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn keys_survive_a_restart_so_subscriptions_stay_valid() {
        let dir = test_dir("keys");
        let first = WebPushStore::new_persistent(&dir).public_key().await.unwrap();
        let second = WebPushStore::new_persistent(&dir).public_key().await.unwrap();
        assert_eq!(first, second);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_key_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = test_dir("perms");
        let store = WebPushStore::new_persistent(&dir);
        store.upsert(subscription(1, "https://push.example/a", "d"), 10).await.unwrap();
        let mode = std::fs::metadata(dir.join("web_push.json")).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn an_unreadable_file_is_kept_aside_not_silently_replaced() {
        let dir = test_dir("corrupt");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("web_push.json"), "{ this is not json").unwrap();
        let store = WebPushStore::new_persistent(&dir);
        assert!(store.public_key().await.is_some(), "usable keys are generated");
        let preserved = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().contains("corrupt"));
        assert!(preserved, "the unreadable original must be preserved for the operator");
        let _ = std::fs::remove_dir_all(dir);
    }
}
