//! Bot account registry.
//!
//! Bots are server-owner-managed service accounts that authenticate with an
//! opaque `Bot <token>` credential instead of a password or JWT. This module
//! owns the full token lifecycle: create, rotate, disable.
//!
//! Tokens are high-entropy random strings; only their SHA-256 hashes are
//! persisted (in `<data_dir>/bots.json`), so a leaked data file never
//! exposes a usable credential. A bot token only ever authenticates as its
//! own bot user_id — there is no impersonation of other accounts.

use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;

/// Persisted record for one bot account.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BotRecord {
    pub bot_user_id: u64,
    /// SHA-256 hex hash of the opaque token. The plaintext token is only ever
    /// returned once at creation/rotation time.
    pub token_hash: String,
    pub created_at_micros: i64,
    pub rotated_at_micros: Option<i64>,
    /// Disabled bots reject authentication with their token.
    pub enabled: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct BotRegistryData {
    bots: HashMap<u64, BotRecord>,
}

#[derive(Debug, Clone)]
pub struct BotRegistry {
    data_path: PathBuf,
    inner: Arc<RwLock<BotRegistryData>>,
}

impl BotRegistry {
    /// Load the registry from `<data_dir>/bots.json`, falling back to empty.
    pub fn new_persistent(data_dir: impl Into<PathBuf>) -> Self {
        let data_path: PathBuf = data_dir.into().join("bots.json");
        let data = std::fs::read_to_string(&data_path)
            .ok()
            .and_then(|s| serde_json::from_str::<BotRegistryData>(&s).ok())
            .unwrap_or_default();
        Self {
            data_path,
            inner: Arc::new(RwLock::new(data)),
        }
    }

    /// Generate a fresh opaque bot token.
    pub fn new_token() -> String {
        let mut buf = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut buf);
        format!("wbt_{}", hex::encode(&buf))
    }

    fn hash_token(token: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(token.as_bytes());
        format!("{:x}", hasher.finalize())
    }

    /// Register a new bot for `bot_user_id`. Returns the plaintext token
    /// (returned to the caller exactly once) plus the persisted record.
    pub async fn create(&self, bot_user_id: u64) -> (String, BotRecord) {
        let token = Self::new_token();
        let record = BotRecord {
            bot_user_id,
            token_hash: Self::hash_token(&token),
            created_at_micros: now_micros(),
            rotated_at_micros: None,
            enabled: true,
        };
        {
            let mut guard = self.inner.write().await;
            guard.bots.insert(bot_user_id, record.clone());
        }
        self.save().await;
        (token, record)
    }

    /// Replace a bot's token with a fresh one. Returns the new plaintext
    /// token, or None if no such bot exists.
    pub async fn rotate(&self, bot_user_id: u64) -> Option<String> {
        let token = Self::new_token();
        let hash = Self::hash_token(&token);
        {
            let mut guard = self.inner.write().await;
            let record = guard.bots.get_mut(&bot_user_id)?;
            record.token_hash = hash;
            record.rotated_at_micros = Some(now_micros());
            record.enabled = true;
        }
        self.save().await;
        Some(token)
    }

    /// Revoke a bot's token and mark it disabled. Returns false if the bot
    /// is unknown.
    pub async fn disable(&self, bot_user_id: u64) -> bool {
        let changed = {
            let mut guard = self.inner.write().await;
            match guard.bots.get_mut(&bot_user_id) {
                Some(record) => {
                    record.token_hash.clear();
                    record.enabled = false;
                    true
                }
                None => false,
            }
        };
        if changed {
            self.save().await;
        }
        changed
    }

    /// True if `bot_user_id` has a bot account (enabled or disabled).
    pub async fn is_bot(&self, bot_user_id: u64) -> bool {
        self.inner.read().await.bots.contains_key(&bot_user_id)
    }

    /// Resolve an opaque `Bot <token>` credential to its bot user_id.
    /// Returns None for unknown, rotated-out, or disabled tokens.
    pub async fn authenticate(&self, token: &str) -> Option<u64> {
        let hash = Self::hash_token(token);
        let guard = self.inner.read().await;
        for (user_id, record) in guard.bots.iter() {
            if record.enabled && !record.token_hash.is_empty() && record.token_hash == hash {
                return Some(*user_id);
            }
        }
        None
    }

    async fn save(&self) {
        let guard = self.inner.read().await;
        if let Ok(s) = serde_json::to_string_pretty(&*guard) {
            let _ = std::fs::write(&self.data_path, s);
        }
    }
}

fn now_micros() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_micros() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_has_prefix_and_uniqueness() {
        let a = BotRegistry::new_token();
        let b = BotRegistry::new_token();
        assert!(a.starts_with("wbt_"));
        assert!(b.starts_with("wbt_"));
        assert_ne!(a, b);
    }

    #[test]
    fn hash_token_is_stable_and_one_way() {
        let h1 = BotRegistry::hash_token("secret-token");
        let h2 = BotRegistry::hash_token("secret-token");
        assert_eq!(h1, h2);
        assert_ne!(h1, "secret-token");
        assert_eq!(h1.len(), 64);
    }

    #[tokio::test]
    async fn create_rotate_disable_lifecycle() {
        let reg = BotRegistry::new_persistent(std::env::temp_dir().join("bots_test_lifecycle"));
        let (token, record) = reg.create(7).await;
        assert_eq!(record.bot_user_id, 7);
        assert!(record.enabled);
        assert_eq!(reg.authenticate(&token).await, Some(7));
        assert!(reg.is_bot(7).await);

        let rotated = reg.rotate(7).await.unwrap();
        assert_ne!(rotated, token);
        assert_eq!(reg.authenticate(&token).await, None);
        assert_eq!(reg.authenticate(&rotated).await, Some(7));

        assert!(reg.disable(7).await);
        assert_eq!(reg.authenticate(&rotated).await, None);
        assert!(reg.rotate(999).await.is_none());
        assert!(!reg.disable(999).await);
    }

    #[tokio::test]
    async fn unknown_token_rejected() {
        let reg = BotRegistry::new_persistent(std::env::temp_dir().join("bots_test_unknown"));
        assert_eq!(reg.authenticate("wbt_not_a_real_token").await, None);
        assert!(!reg.is_bot(42).await);
    }
}
