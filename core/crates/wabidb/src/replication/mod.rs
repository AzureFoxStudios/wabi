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
use crate::error::Result;
use std::fmt::Debug;
use std::sync::Arc;

/// Transport abstraction for replication. The library defines this trait;
/// the server (wabi-server) implements it using `reqwest`.
#[async_trait::async_trait]
pub trait SyncTransport: Debug + Send + Sync {
    /// Pull entries from a peer that were committed after `since_commit_seq`.
    async fn pull(&self, peer_endpoint: &str, since: u64) -> Result<Vec<CommitIndexEntry>>;

    /// Push local entries to a peer. The entries should be already-sorted
    /// new entries the peer may be missing.
    async fn push(&self, peer_endpoint: &str, entries: Vec<CommitIndexEntry>) -> Result<()>;

    /// Get the peer's latest commit_seq.
    async fn latest_seq(&self, peer_endpoint: &str) -> Result<u64>;
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
    async fn latest_seq(&self, _peer: &str) -> Result<u64> {
        Ok(0)
    }
}

/// Create a default no-op transport.
pub fn new_noop_transport() -> Arc<dyn SyncTransport> {
    Arc::new(NoopTransport)
}
