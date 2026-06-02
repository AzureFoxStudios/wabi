//! Privacy-first warm standby snapshot primitives.
//!
//! Helper Phase 6 deliberately uses encrypted live-state snapshots, not an
//! append-only event log. Snapshots represent current retained state only and
//! must be encrypted before being written to disk or sent to a standby node.

pub mod crypto;
pub mod manifest;
pub mod store;
pub mod tables;

pub use crypto::{
    decrypt_from_identity_b64, encrypt_to_recipient_b64, generate_standby_identity,
    identity_to_string, recipient_to_string, SnapshotCryptoError, SNAPSHOT_ENCRYPTION_ALGORITHM,
};
pub use manifest::{
    EncryptedSnapshotEnvelope, LiveStateSnapshotPayload, SnapshotEncryption, SnapshotKind,
    SnapshotManifest, SnapshotValidationError,
};
pub use store::{SnapshotStore, SnapshotStoreError};
pub use tables::{
    is_excluded_snapshot_table, is_live_state_snapshot_table, EXCLUDED_SNAPSHOT_TABLES,
    LIVE_STATE_SNAPSHOT_TABLES,
};
