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

use anyhow::{bail, Context, Result};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::sync::RwLock;

/// Persisted record for one bot account.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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
#[serde(deny_unknown_fields)]
struct BotRegistryData {
    bots: HashMap<u64, BotRecord>,
}

#[derive(Clone)]
pub struct BotRegistry {
    data_path: PathBuf,
    inner: Arc<RwLock<BotRegistryData>>,
    healthy: Arc<AtomicBool>,
    operations: crate::instance_operations::InstanceOperations,
}

/// A successful content admission retains this reader until its durable write
/// finishes; credential rotation/disable cannot overtake that publication.
pub(crate) struct BotCredentialGuard {
    _guard: tokio::sync::OwnedRwLockReadGuard<BotRegistryData>,
}

impl BotCredentialGuard {
    /// Registry classification under the reader already retained by admission.
    /// Disabled registrations remain bot identities.
    pub(crate) fn is_bot_user(&self, user_id: u64) -> bool {
        self._guard.bots.contains_key(&user_id)
    }
}

impl std::fmt::Debug for BotRegistry {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("BotRegistry")
            .field("data_path", &self.data_path)
            .field("healthy", &self.healthy.load(Ordering::Acquire))
            .finish_non_exhaustive()
    }
}

impl BotRegistry {
    /// Missing means first boot. Existing malformed credentials are a startup
    /// error; they must never be silently replaced by an empty registry.
    pub fn new_persistent(data_dir: impl Into<PathBuf>) -> Result<Self> {
        Self::new_persistent_with_operations(data_dir, Default::default())
    }

    pub(crate) fn new_persistent_with_operations(
        data_dir: impl Into<PathBuf>,
        operations: crate::instance_operations::InstanceOperations,
    ) -> Result<Self> {
        let directory = data_dir.into();
        std::fs::create_dir_all(&directory).context("create bot registry directory")?;
        let data_path = directory.join("bots.json");
        let data = match std::fs::symlink_metadata(&data_path) {
            Ok(metadata) => {
                if !metadata.is_file()
                    || metadata.file_type().is_symlink()
                    || metadata.len() > 64 * 1024 * 1024
                {
                    bail!("bot registry must be a bounded regular file");
                }
                let data: BotRegistryData = serde_json::from_slice(&std::fs::read(&data_path)?)
                    .context("invalid bot registry; refusing to reset credentials")?;
                for (id, record) in &data.bots {
                    let valid_hash = record.token_hash.len() == 64
                        && record
                            .token_hash
                            .bytes()
                            .all(|byte| byte.is_ascii_hexdigit());
                    if *id == 0
                        || *id != record.bot_user_id
                        || (!valid_hash && (record.enabled || !record.token_hash.is_empty()))
                    {
                        bail!("invalid bot credential record");
                    }
                }
                data
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                BotRegistryData::default()
            }
            Err(error) => return Err(error).context("inspect bot registry"),
        };
        Ok(Self {
            data_path,
            inner: Arc::new(RwLock::new(data)),
            healthy: Arc::new(AtomicBool::new(true)),
            operations,
        })
    }

    /// Generate a fresh opaque bot token.
    pub fn new_token() -> String {
        let mut buf = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut buf);
        format!("wbt_{}", hex::encode(&buf))
    }

    pub(crate) fn hash_token(token: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(token.as_bytes());
        hex::encode(hasher.finalize())
    }

    /// Register a new bot for `bot_user_id`. Returns the plaintext token
    /// (returned to the caller exactly once) plus the persisted record.
    pub async fn create(&self, bot_user_id: u64) -> Result<(String, BotRecord)> {
        if bot_user_id == 0 {
            bail!("invalid bot account");
        }
        let token = Self::new_token();
        let record = BotRecord {
            bot_user_id,
            token_hash: Self::hash_token(&token),
            created_at_micros: now_micros(),
            rotated_at_micros: None,
            enabled: true,
        };
        self.mutate(move |data| {
            if data.bots.contains_key(&bot_user_id) {
                bail!("bot account already registered");
            }
            data.bots.insert(bot_user_id, record.clone());
            Ok((token, record))
        })
        .await
    }

    /// Replace a bot's token with a fresh one. Returns the new plaintext
    /// token, or None if no such bot exists.
    pub async fn rotate(&self, bot_user_id: u64) -> Result<Option<String>> {
        let token = Self::new_token();
        let hash = Self::hash_token(&token);
        self.mutate(move |data| {
            let Some(record) = data.bots.get_mut(&bot_user_id) else {
                return Ok(None);
            };
            record.token_hash = hash;
            record.rotated_at_micros = Some(now_micros());
            record.enabled = true;
            Ok(Some(token))
        })
        .await
    }

    /// Revoke a bot's token and mark it disabled. Returns false if the bot
    /// is unknown.
    pub async fn disable(&self, bot_user_id: u64) -> Result<bool> {
        self.mutate(move |data| {
            Ok(match data.bots.get_mut(&bot_user_id) {
                Some(record) => {
                    record.token_hash.clear();
                    record.enabled = false;
                    true
                }
                None => false,
            })
        })
        .await
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
        if !self.healthy.load(Ordering::Acquire) {
            return None;
        }
        for (user_id, record) in guard.bots.iter() {
            if record.enabled && !record.token_hash.is_empty() && record.token_hash == hash {
                return Some(*user_id);
            }
        }
        None
    }

    pub(crate) async fn admit_fingerprint(
        &self,
        user_id: u64,
        fingerprint: &str,
    ) -> Option<BotCredentialGuard> {
        let guard = self.inner.clone().read_owned().await;
        if !self.healthy.load(Ordering::Acquire) || fingerprint.len() != 64 {
            return None;
        }
        let record = guard.bots.get(&user_id)?;
        if !record.enabled || record.token_hash != fingerprint {
            return None;
        }
        Some(BotCredentialGuard { _guard: guard })
    }

    #[cfg(test)]
    pub(crate) fn ownership_count(&self) -> usize {
        Arc::strong_count(&self.inner)
    }

    #[cfg(test)]
    pub(crate) fn credential_write_blocked(&self) -> bool {
        self.inner.try_write().is_err()
    }

    /// A caller disappearing must not cancel a published credential change.
    async fn mutate<T, F>(&self, change: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut BotRegistryData) -> Result<T> + Send + 'static,
    {
        let registry = self.clone();
        self.operations.spawn(async move {
            let mut guard = registry.inner.write().await;
            if !registry.healthy.load(Ordering::Acquire) {
                bail!("bot registry publication is uncertain; restart and inspect persisted state");
            }
            let mut candidate = guard.clone();
            let response = change(&mut candidate)?;
            registry.persist(&candidate)?;
            *guard = candidate;
            Ok(response)
        }).await.context("bot credential publication task failed")?
    }

    fn persist(&self, data: &BotRegistryData) -> Result<()> {
        let temporary = self
            .data_path
            .with_file_name(format!(".bots-{}.tmp", uuid::Uuid::new_v4()));
        let mut renamed = false;
        let result = (|| -> Result<()> {
            let bytes = serde_json::to_vec_pretty(data)?;
            if bytes.len() > 64 * 1024 * 1024 {
                bail!("bot registry exceeds size limit");
            }
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options
                .open(&temporary)
                .context("create bot credential update")?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            std::fs::rename(&temporary, &self.data_path)
                .context("publish bot credential update")?;
            renamed = true;
            #[cfg(unix)]
            std::fs::File::open(self.data_path.parent().expect("registry has a directory"))?
                .sync_all()?;
            Ok(())
        })();
        if result.is_err() {
            if renamed {
                // The rename happened but its directory could not be synced.
                // Neither old nor new credentials may be trusted in RAM.
                self.healthy.store(false, Ordering::Release);
            } else {
                let _ = std::fs::remove_file(temporary);
            }
        }
        result
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
    async fn failed_bot_revocation_does_not_publish_a_successful_ram_only_change() {
        let directory = tempfile::tempdir().unwrap();
        let reg = BotRegistry::new_persistent(directory.path()).unwrap();
        let (token, _) = reg.create(7).await.unwrap();
        let path = directory.path().join("bots.json");
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(reg.disable(7).await.is_err());
        assert_eq!(
            reg.authenticate(&token).await,
            Some(7),
            "a failed durable revoke must leave the previous view intact and report failure"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn registry_token_hashes_are_persisted_with_owner_only_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let reg = BotRegistry::new_persistent(directory.path()).unwrap();
        let _ = reg.create(7).await.unwrap();
        assert_eq!(
            std::fs::metadata(directory.path().join("bots.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[tokio::test]
    async fn create_rotate_disable_lifecycle() {
        let directory = tempfile::tempdir().unwrap();
        let reg = BotRegistry::new_persistent(directory.path()).unwrap();
        let (token, record) = reg.create(7).await.unwrap();
        assert_eq!(record.bot_user_id, 7);
        assert!(record.enabled);
        assert_eq!(reg.authenticate(&token).await, Some(7));
        assert!(reg.is_bot(7).await);

        let rotated = reg.rotate(7).await.unwrap().unwrap();
        assert_ne!(rotated, token);
        assert_eq!(reg.authenticate(&token).await, None);
        assert_eq!(reg.authenticate(&rotated).await, Some(7));

        assert!(reg.disable(7).await.unwrap());
        assert_eq!(reg.authenticate(&rotated).await, None);
        assert!(reg.rotate(999).await.unwrap().is_none());
        assert!(!reg.disable(999).await.unwrap());
    }

    #[tokio::test]
    async fn unknown_token_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let reg = BotRegistry::new_persistent(directory.path()).unwrap();
        assert_eq!(reg.authenticate("wbt_not_a_real_token").await, None);
        assert!(!reg.is_bot(42).await);
    }

    #[tokio::test]
    async fn durable_bot_rotation_and_disable_survive_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let reg = BotRegistry::new_persistent(directory.path()).unwrap();
        let (old, _) = reg.create(42).await.unwrap();
        let new = reg.rotate(42).await.unwrap().unwrap();
        drop(reg);
        let reopened = BotRegistry::new_persistent(directory.path()).unwrap();
        assert_eq!(reopened.authenticate(&old).await, None);
        assert_eq!(reopened.authenticate(&new).await, Some(42));
        reopened.disable(42).await.unwrap();
        drop(reopened);
        let reopened = BotRegistry::new_persistent(directory.path()).unwrap();
        assert_eq!(reopened.authenticate(&new).await, None);
        assert!(reopened.is_bot(42).await);
    }

    #[test]
    fn malformed_or_nonregular_registry_is_a_startup_error() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("bots.json");
        for data in [
            "not-json",
            r#"{"bots":{},"unexpected":1}"#,
            r#"{"bots":{"7":{"botUserId":8,"tokenHash":"","enabled":false,"createdAtMicros":1,"rotatedAtMicros":null}}}"#,
        ] {
            std::fs::write(&file, data).unwrap();
            assert!(BotRegistry::new_persistent(directory.path()).is_err());
        }
        std::fs::remove_file(&file).unwrap();
        std::fs::create_dir(&file).unwrap();
        assert!(BotRegistry::new_persistent(directory.path()).is_err());
    }

    #[tokio::test]
    async fn aborted_caller_does_not_cancel_a_queued_bot_revocation() {
        let directory = tempfile::tempdir().unwrap();
        let reg = BotRegistry::new_persistent(directory.path()).unwrap();
        let (token, _) = reg.create(42).await.unwrap();
        let guard = reg.inner.read().await;
        let before = Arc::strong_count(&reg.inner);
        let worker = reg.clone();
        let caller = tokio::spawn(async move { worker.disable(42).await });
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while Arc::strong_count(&reg.inner) < before + 2 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
        drop(guard);
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while reg.authenticate(&token).await.is_some() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            BotRegistry::new_persistent(directory.path())
                .unwrap()
                .authenticate(&token)
                .await,
            None
        );
    }
}
