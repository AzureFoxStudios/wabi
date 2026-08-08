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
use std::collections::HashMap;
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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct WebPushFile {
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
        let mut data = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<WebPushFile>(&s).ok())
            .unwrap_or_default();

        if data.vapid_private_pem.is_none() || data.vapid_public_b64.is_none() {
            match generate_vapid_keypair() {
                Ok((pem, pub_b64)) => {
                    data.vapid_private_pem = Some(pem);
                    data.vapid_public_b64 = Some(pub_b64);
                    data.vapid_subject = Some(
                        std::env::var("WABI_VAPID_SUBJECT")
                            .unwrap_or_else(|_| "mailto:admin@localhost".into()),
                    );
                    if let Ok(json) = serde_json::to_string_pretty(&data) {
                        let _ = std::fs::write(&path, json);
                    }
                    info!("Generated Web Push VAPID keypair at {}", path.display());
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

    pub async fn upsert(&self, record: PushSubscriptionRecord) -> anyhow::Result<()> {
        let mut guard = self.inner.write().await;
        guard.subscriptions.insert(record.endpoint.clone(), record);
        self.persist_locked(&guard)?;
        Ok(())
    }

    pub async fn remove_endpoint(&self, endpoint: &str) -> anyhow::Result<()> {
        let mut guard = self.inner.write().await;
        guard.subscriptions.remove(endpoint);
        self.persist_locked(&guard)?;
        Ok(())
    }

    pub async fn remove_user_device(&self, user_id: i64, device_id: &str) -> anyhow::Result<()> {
        let mut guard = self.inner.write().await;
        guard.subscriptions.retain(|_, r| !(r.user_id == user_id && r.device_id == device_id));
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
        std::fs::write(&self.path, json)?;
        Ok(())
    }
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
