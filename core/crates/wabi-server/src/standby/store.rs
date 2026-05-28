//! Encrypted snapshot persistence.
//!
//! The store only accepts age-encrypted snapshot envelopes. It validates the
//! envelope before writing anything, verifies the encrypted payload hash, and
//! refuses obvious plaintext JSON payloads even when they are base64-wrapped.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use thiserror::Error;

use super::manifest::{EncryptedSnapshotEnvelope, SnapshotValidationError};
use super::SNAPSHOT_ENCRYPTION_ALGORITHM;

const AGE_V1_HEADER: &[u8] = b"age-encryption.org/v1";

#[derive(Clone, Debug)]
pub struct SnapshotStore {
    root: PathBuf,
}

#[derive(Debug, Error)]
pub enum SnapshotStoreError {
    #[error("invalid encrypted snapshot envelope: {0}")]
    Validation(#[from] SnapshotValidationError),
    #[error("encrypted snapshot payload is not valid base64: {0}")]
    InvalidBase64(String),
    #[error("snapshot payload is not an age encrypted file")]
    UnsupportedEncryption,
    #[error("snapshot encryption algorithm mismatch: expected {expected}, got {actual}")]
    AlgorithmMismatch { expected: String, actual: String },
    #[error("snapshot payload hash mismatch")]
    PayloadHashMismatch,
    #[error("snapshot id contains unsafe path characters")]
    UnsafeSnapshotId,
    #[error("snapshot persistence failed: {0}")]
    Persistence(String),
}

impl SnapshotStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn for_data_dir(data_dir: impl AsRef<Path>) -> Self {
        Self::new(data_dir.as_ref().join("standby_snapshots"))
    }

    pub async fn store_encrypted(
        &self,
        envelope: &EncryptedSnapshotEnvelope,
    ) -> Result<PathBuf, SnapshotStoreError> {
        self.validate_encrypted(envelope)?;
        tokio::fs::create_dir_all(&self.root)
            .await
            .map_err(|error| SnapshotStoreError::Persistence(error.to_string()))?;

        let path = self.snapshot_path(&envelope.manifest.snapshot_id)?;
        let content = serde_json::to_vec_pretty(envelope)
            .map_err(|error| SnapshotStoreError::Persistence(error.to_string()))?;
        tokio::fs::write(&path, content)
            .await
            .map_err(|error| SnapshotStoreError::Persistence(error.to_string()))?;
        Ok(path)
    }

    pub fn validate_encrypted(
        &self,
        envelope: &EncryptedSnapshotEnvelope,
    ) -> Result<(), SnapshotStoreError> {
        envelope.validate_fail_closed()?;
        if envelope.manifest.encryption.algorithm != SNAPSHOT_ENCRYPTION_ALGORITHM {
            return Err(SnapshotStoreError::AlgorithmMismatch {
                expected: SNAPSHOT_ENCRYPTION_ALGORITHM.to_string(),
                actual: envelope.manifest.encryption.algorithm.clone(),
            });
        }

        let encrypted = BASE64
            .decode(&envelope.encrypted_payload_b64)
            .map_err(|error| SnapshotStoreError::InvalidBase64(error.to_string()))?;
        if !encrypted.starts_with(AGE_V1_HEADER) {
            return Err(SnapshotStoreError::UnsupportedEncryption);
        }

        let actual_hash = hex::encode(Sha256::digest(&encrypted));
        if actual_hash != envelope.manifest.payload_sha256 {
            return Err(SnapshotStoreError::PayloadHashMismatch);
        }
        Ok(())
    }

    fn snapshot_path(&self, snapshot_id: &str) -> Result<PathBuf, SnapshotStoreError> {
        if snapshot_id.is_empty()
            || !snapshot_id
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
        {
            return Err(SnapshotStoreError::UnsafeSnapshotId);
        }
        Ok(self.root.join(format!("{snapshot_id}.json")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::standby::{
        encrypt_to_recipient_b64, generate_standby_identity, recipient_to_string, SnapshotManifest,
    };

    fn encrypted_fixture() -> EncryptedSnapshotEnvelope {
        let identity = generate_standby_identity();
        let recipient = recipient_to_string(&identity);
        let encrypted_payload_b64 = encrypt_to_recipient_b64(b"{\"tables\":{}}", &recipient)
            .expect("encrypt snapshot fixture");
        let encrypted = BASE64
            .decode(&encrypted_payload_b64)
            .expect("fixture base64 decodes");
        let manifest = SnapshotManifest::new_live_state(
            "authority-test",
            "standby-test",
            &encrypted,
            SNAPSHOT_ENCRYPTION_ALGORITHM,
        );
        EncryptedSnapshotEnvelope {
            manifest,
            encrypted_payload_b64,
        }
    }

    #[tokio::test]
    async fn store_accepts_only_valid_encrypted_age_envelopes() {
        let temp = std::env::temp_dir().join(format!("wabi-standby-test-{}", uuid::Uuid::new_v4()));
        let store = SnapshotStore::new(&temp);
        let envelope = encrypted_fixture();

        let path = store
            .store_encrypted(&envelope)
            .await
            .expect("store encrypted envelope");
        assert!(path.exists());
        assert!(path.ends_with(format!("{}.json", envelope.manifest.snapshot_id)));

        let _ = std::fs::remove_dir_all(temp);
    }

    #[test]
    fn store_refuses_base64_wrapped_plaintext_json() {
        let store = SnapshotStore::new(std::env::temp_dir());
        let plaintext = b"{\"tables\":{\"state_message\":[]}}";
        let encrypted_payload_b64 = BASE64.encode(plaintext);
        let manifest = SnapshotManifest::new_live_state(
            "authority-test",
            "standby-test",
            plaintext,
            SNAPSHOT_ENCRYPTION_ALGORITHM,
        );
        let envelope = EncryptedSnapshotEnvelope {
            manifest,
            encrypted_payload_b64,
        };

        assert!(matches!(
            store.validate_encrypted(&envelope),
            Err(SnapshotStoreError::UnsupportedEncryption)
        ));
    }

    #[test]
    fn store_refuses_hash_mismatch() {
        let store = SnapshotStore::new(std::env::temp_dir());
        let mut envelope = encrypted_fixture();
        envelope.manifest.payload_sha256 = "00".repeat(32);

        assert!(matches!(
            store.validate_encrypted(&envelope),
            Err(SnapshotStoreError::PayloadHashMismatch)
        ));
    }
}
