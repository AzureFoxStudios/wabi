//! Snapshot manifest and envelope types.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::tables::{EXCLUDED_SNAPSHOT_TABLES, LIVE_STATE_SNAPSHOT_TABLES};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LiveStateSnapshotPayload {
    /// Plaintext rows grouped by table. This value must only exist in memory
    /// between WDB export and encryption. Do not write it to disk.
    pub tables: std::collections::BTreeMap<String, Vec<serde_json::Value>>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SnapshotKind {
    LiveState,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotEncryption {
    pub version: u32,
    pub algorithm: String,
    pub recipient_node_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotManifest {
    pub snapshot_id: String,
    pub authority_node_id: String,
    pub created_at: DateTime<Utc>,
    pub schema_version: u32,
    pub snapshot_kind: SnapshotKind,
    pub retention_applied_at: DateTime<Utc>,
    pub included_tables: Vec<String>,
    pub excluded_tables: Vec<String>,
    pub payload_sha256: String,
    pub encryption: SnapshotEncryption,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedSnapshotEnvelope {
    pub manifest: SnapshotManifest,
    /// Encrypted bytes, base64 encoded. This must never contain plaintext JSON rows.
    pub encrypted_payload_b64: String,
}

impl SnapshotManifest {
    pub fn new_live_state(
        authority_node_id: impl Into<String>,
        recipient_node_id: impl Into<String>,
        encrypted_payload: &[u8],
        algorithm: impl Into<String>,
    ) -> Self {
        let now = Utc::now();
        let payload_sha256 = hex::encode(Sha256::digest(encrypted_payload));
        Self {
            snapshot_id: format!("snap-{}", Uuid::new_v4()),
            authority_node_id: authority_node_id.into(),
            created_at: now,
            schema_version: 1,
            snapshot_kind: SnapshotKind::LiveState,
            retention_applied_at: now,
            included_tables: LIVE_STATE_SNAPSHOT_TABLES
                .iter()
                .map(|table| (*table).to_string())
                .collect(),
            excluded_tables: EXCLUDED_SNAPSHOT_TABLES
                .iter()
                .map(|table| (*table).to_string())
                .collect(),
            payload_sha256,
            encryption: SnapshotEncryption {
                version: 1,
                algorithm: algorithm.into(),
                recipient_node_id: recipient_node_id.into(),
            },
        }
    }

    #[allow(dead_code)]
    pub fn includes_table(&self, table: &str) -> bool {
        self.included_tables
            .iter()
            .any(|candidate| candidate == table)
    }

    #[allow(dead_code)]
    pub fn excludes_table(&self, table: &str) -> bool {
        self.excluded_tables
            .iter()
            .any(|candidate| candidate == table)
    }
}

impl EncryptedSnapshotEnvelope {
    pub fn validate_fail_closed(&self) -> Result<(), SnapshotValidationError> {
        if self.encrypted_payload_b64.trim().is_empty() {
            return Err(SnapshotValidationError::MissingEncryptedPayload);
        }
        if self.manifest.payload_sha256.trim().is_empty() {
            return Err(SnapshotValidationError::MissingPayloadHash);
        }
        if self.manifest.encryption.algorithm.trim().is_empty() {
            return Err(SnapshotValidationError::MissingEncryptionAlgorithm);
        }
        if self.manifest.included_tables.iter().any(|table| {
            EXCLUDED_SNAPSHOT_TABLES
                .iter()
                .any(|excluded| excluded == table)
        }) {
            return Err(SnapshotValidationError::ExcludedTableIncluded);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
pub enum SnapshotValidationError {
    #[error("encrypted snapshot payload is required")]
    MissingEncryptedPayload,
    #[error("snapshot payload hash is required")]
    MissingPayloadHash,
    #[error("snapshot encryption algorithm is required")]
    MissingEncryptionAlgorithm,
    #[error("snapshot included an excluded/transient table")]
    ExcludedTableIncluded,
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_ALGORITHM: &str = "test-only";

    #[test]
    fn live_state_manifest_excludes_transient_and_history_tables() {
        let manifest = SnapshotManifest::new_live_state(
            "authority-test",
            "standby-test",
            b"encrypted",
            TEST_ALGORITHM,
        );

        assert!(manifest.includes_table("state_message"));
        assert!(manifest.includes_table("state_user_encryption_key"));
        assert!(manifest.excludes_table("ingested_event"));
        assert!(manifest.excludes_table("state_presence_lease"));
        assert!(manifest.excludes_table("state_call_signal"));
        assert!(!manifest.includes_table("ingested_event"));
    }

    #[test]
    fn snapshot_envelope_requires_encrypted_payload() {
        let manifest = SnapshotManifest::new_live_state(
            "authority-test",
            "standby-test",
            b"encrypted",
            TEST_ALGORITHM,
        );
        let envelope = EncryptedSnapshotEnvelope {
            manifest,
            encrypted_payload_b64: "".to_string(),
        };

        assert_eq!(
            envelope.validate_fail_closed(),
            Err(SnapshotValidationError::MissingEncryptedPayload)
        );
    }

    #[test]
    fn snapshot_envelope_rejects_excluded_tables_in_included_list() {
        let mut manifest = SnapshotManifest::new_live_state(
            "authority-test",
            "standby-test",
            b"encrypted",
            TEST_ALGORITHM,
        );
        manifest
            .included_tables
            .push("state_presence_lease".to_string());
        let envelope = EncryptedSnapshotEnvelope {
            manifest,
            encrypted_payload_b64: "not-plaintext-json".to_string(),
        };

        assert_eq!(
            envelope.validate_fail_closed(),
            Err(SnapshotValidationError::ExcludedTableIncluded)
        );
    }
}
