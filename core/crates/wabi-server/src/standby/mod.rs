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
    encrypt_to_recipient_b64, SNAPSHOT_ENCRYPTION_ALGORITHM,
};
pub use manifest::{
    EncryptedSnapshotEnvelope, LiveStateSnapshotPayload, SnapshotManifest,
};
pub use store::{SnapshotStore, SnapshotStoreError};
