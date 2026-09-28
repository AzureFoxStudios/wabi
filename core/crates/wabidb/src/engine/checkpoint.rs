//! Temporary engine boundary for a coordinated whole-instance checkpoint.
//! This never changes the persisted writer fence or authorizes promotion.
use super::*;
use tokio::sync::{OwnedMutexGuard, OwnedRwLockWriteGuard};

/// Holds both mutation paths and keeps the engine alive. Moving this guard
/// into a blocking copy task keeps writers held after its caller disconnects.
pub struct PausedEngine {
    applied_seq: u64,
    prefix_fingerprint: String,
    _writer: OwnedRwLockWriteGuard<bool>,
    _ingest: OwnedMutexGuard<()>,
    engine: Arc<WabiDbEngine>,
}

impl std::fmt::Debug for PausedEngine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PausedEngine")
            .field("applied_seq", &self.applied_seq)
            .field("prefix_fingerprint", &self.prefix_fingerprint)
            .finish_non_exhaustive()
    }
}

impl PausedEngine {
    pub fn applied_seq(&self) -> u64 {
        self.applied_seq
    }

    pub fn prefix_fingerprint(&self) -> &str {
        &self.prefix_fingerprint
    }

    /// Save a projection checkpoint and hold its file writer through `copy`.
    /// A dispatcher checkpoint can start after its application acknowledgment;
    /// holding this lock also drains/blocks that otherwise independent writer.
    /// This is synchronous work: move the entire pause into a blocking task so
    /// caller cancellation cannot release it while the copy continues.
    pub fn with_projection_checkpoint<T>(&self, copy: impl FnOnce() -> Result<T>) -> Result<T> {
        self.engine
            .projection_state
            .with_checkpoint_snapshot(&self.engine.data_dir, copy)
    }
}

impl WabiDbEngine {
    /// Stop local commit windows and inbound ingestion at an applied boundary.
    /// Acquire in the ingestion path's lock order to avoid a writer/ingest
    /// inversion. The local sequencer read guard already spans segment/index
    /// fsync, whole-commit application and acknowledgment.
    ///
    /// A caller must first drain its application/sidecar operations. Commands
    /// still waiting outside a commit window have no success acknowledgment and
    /// remain pending until release. Other files are outside this engine guard.
    pub async fn pause_for_checkpoint(self: &Arc<Self>) -> Result<PausedEngine> {
        let ingest = Arc::clone(&self.replication_ingest).lock_owned().await;
        let writer = Arc::clone(&self.write_fence).write_owned().await;
        if !self.is_healthy() || self.replication_poisoned.load(Ordering::Acquire) {
            return Err(checkpoint_error(
                "engine has incomplete or halted application",
            ));
        }
        let batcher = self
            .replication_batcher
            .as_ref()
            .ok_or_else(|| checkpoint_error("engine has no running commit batcher"))?;
        batcher.flush_now().await?;
        let entries = crate::commit_index::batcher::read_all_entries(
            &self.data_dir.join("global/commit-index"),
        )?;
        let applied_seq = self.barrier.current();
        let indexed_seq = entries.last().map(|entry| entry.commit_seq).unwrap_or(0);
        if indexed_seq != applied_seq || self.projection_state.applied_commit_seq() != applied_seq {
            return Err(checkpoint_error(
                "commit index and applied position disagree",
            ));
        }
        let prefix_fingerprint =
            crate::replication::commit_prefix_fingerprint(&entries, applied_seq);
        Ok(PausedEngine {
            applied_seq,
            prefix_fingerprint,
            _writer: writer,
            _ingest: ingest,
            engine: Arc::clone(self),
        })
    }
}

fn checkpoint_error(reason: &str) -> WabiError {
    WabiError::Validation {
        command: "checkpoint_boundary".into(),
        reason: reason.into(),
    }
}

#[cfg(test)]
mod tests;
