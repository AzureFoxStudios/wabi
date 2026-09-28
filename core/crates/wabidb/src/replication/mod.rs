pub mod anti_entropy;
pub mod config;
pub mod failover;
pub mod observability;
pub mod rate_limit;
pub mod snapshot_shipping;
pub mod state_machine;
pub mod sync_protocol;
pub mod sync_worker;

use crate::commit_index::record::CommitIndexEntry;
use crate::engine::locks::ProjectionState;
use crate::error::Result;
use std::fmt::Debug;
use std::sync::Arc;

/// Applied position plus a digest of every commit-index entry through it.
/// A matching root key and sequence alone cannot prove a restored prefix.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerPosition {
    pub applied_seq: u64,
    pub prefix_fingerprint: String,
}

/// Transport abstraction for replication. The library defines this trait;
/// the server (wabi-server) implements it using `reqwest`.
#[async_trait::async_trait]
pub trait SyncTransport: Debug + Send + Sync {
    /// Pull entries from a peer that were committed after `since_commit_seq`.
    async fn pull(&self, peer_endpoint: &str, since: u64) -> Result<Vec<CommitIndexEntry>>;

    /// Push local entries to a peer. The entries should be already-sorted
    /// new entries the peer may be missing.
    async fn push(&self, peer_endpoint: &str, entries: Vec<CommitIndexEntry>) -> Result<()>;

    /// Get the peer's applied position and commit-prefix fingerprint.
    async fn latest_position(&self, peer_endpoint: &str) -> Result<PeerPosition>;

    /// Reconcile external assets after the database prefix is caught up.
    /// Transports that only ship WabiDB records intentionally do nothing.
    async fn sync_auxiliary(
        &self,
        _peer_endpoint: &str,
        _projections: &ProjectionState,
    ) -> Result<()> {
        Ok(())
    }
}

/// Default no-op implementation — for single-node deployments.
#[derive(Debug)]
pub struct NoopTransport;

#[async_trait::async_trait]
impl SyncTransport for NoopTransport {
    async fn pull(&self, _peer: &str, _since: u64) -> Result<Vec<CommitIndexEntry>> {
        Ok(Vec::new())
    }
    async fn push(&self, _peer: &str, _entries: Vec<CommitIndexEntry>) -> Result<()> {
        Ok(())
    }
    async fn latest_position(&self, _peer: &str) -> Result<PeerPosition> {
        Ok(PeerPosition {
            applied_seq: 0,
            prefix_fingerprint: commit_prefix_fingerprint(&[], 0),
        })
    }
}

/// Create a default no-op transport.
pub fn new_noop_transport() -> Arc<dyn SyncTransport> {
    Arc::new(NoopTransport)
}

/// Bind development replication peers to the same WabiDB root key without
/// revealing that key. This is a peer-consistency check, not an auth token.
pub fn replica_fingerprint(root_key: &[u8; 32]) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"wabi-replica-root-v1");
    hasher.update(root_key);
    hex::encode(hasher.finalize().as_bytes())
}

/// Fingerprint the canonical commit-index prefix. This detects a divergent
/// stopped baseline before the sender skips past it. It is not a proof of
/// complete file/sidecar state or the contents of referenced segment files.
pub fn commit_prefix_fingerprint(entries: &[CommitIndexEntry], through_seq: u64) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"wabi-commit-prefix-v1\0");
    for entry in entries
        .iter()
        .take_while(|entry| entry.commit_seq <= through_seq)
    {
        hasher.update(&entry.encode());
    }
    hex::encode(hasher.finalize().as_bytes())
}
