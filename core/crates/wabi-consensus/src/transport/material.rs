//! Opt-in checkpoint byte worker, behind the fixed authenticated voter roster.
//! Only local signed bytes are certified; no quorum or writer permit is added.
use super::{Config, Error, Result};
use crate::{
    material::{
        CheckpointManifest, LocalCheckpointReceipt, MaterialError, MaterialKind, MaterialStore,
        ObjectRef,
    },
    model::identifier_valid,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};

const OBJECT_BYTES: usize = 64 * 1024;
const MANIFEST_BYTES: usize = 256 * 1024;
mod availability;
pub(super) mod client;
pub use availability::{
    CheckpointAvailabilityProposal, CheckpointAvailabilityRound, CommittedCheckpointObservation,
};
pub use client::{AuthenticatedCheckpointAck, CheckpointClient};

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum MaterialRequest {
    ControlFormat {
        probe_version: u8,
    },
    PutCheckpointObject {
        object: ObjectRef,
        bytes_hex: String,
    },
    CertifyCheckpoint {
        manifest: CheckpointManifest,
    },
    CheckpointReceipt {
        manifest_sha256: String,
    },
    ReadCheckpointManifest {
        manifest_sha256: String,
    },
    ReadCheckpointObject {
        manifest_sha256: String,
        index: usize,
    },
}
#[derive(Debug, Serialize)]
#[serde(tag = "operation", content = "payload", rename_all = "snake_case")]
pub(super) enum MaterialReply {
    ControlFormat {
        probe_version: u8,
        maximum_control_schema: u8,
    },
    Object(ObjectRef),
    Checkpoint(LocalCheckpointReceipt),
    Manifest(CheckpointManifest),
    Bytes {
        object: ObjectRef,
        bytes_hex: String,
    },
}

/// Optional service configuration; construction compares the actual immutable
/// disk binding, not a separately supplied description of that disk store.
#[derive(Clone)]
pub struct MaterialService {
    pub(super) io: MaterialIo,
    binding: crate::model::StoreBinding,
    roster_digest: String,
}
impl MaterialService {
    pub fn new(
        store: MaterialStore,
        config: &Config,
        source_node: String,
        workers: usize,
    ) -> Result<Self> {
        if store.binding() != &config.binding {
            return Err(Error::Authentication);
        }
        Ok(Self {
            binding: store.binding().clone(),
            roster_digest: config.roster_digest(),
            io: MaterialIo::new(store, source_node, workers)?,
        })
    }
    pub(super) fn matches(&self, config: &Config) -> bool {
        self.binding == config.binding
            && self.roster_digest == config.roster_digest()
            && self.io.store.binding() == &config.binding
    }
}

fn canonical_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn object_bytes(object: &ObjectRef, encoded: &str) -> Result<Vec<u8>> {
    // Charge encoded and decoded length before allocating the decoded buffer.
    if object.bytes == 0 || object.bytes > OBJECT_BYTES as u64 || encoded.len() > OBJECT_BYTES * 2 {
        return Err(Error::Budget);
    }
    if object.kind != MaterialKind::CheckpointChunk
        || !canonical_hash(&object.sha256)
        || encoded.len() != object.bytes as usize * 2
        || !encoded
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(Error::Protocol);
    }
    let bytes = hex::decode(encoded).map_err(|_| Error::Protocol)?;
    if hex::encode(Sha256::digest(&bytes)) != object.sha256 {
        return Err(Error::Protocol);
    }
    Ok(bytes)
}
fn storage_error(error: MaterialError) -> Error {
    match error {
        MaterialError::Budget => Error::Budget,
        MaterialError::Deadline => Error::Deadline,
        MaterialError::Context => Error::Authentication,
        // Paths and underlying filesystem errors never become wire errors.
        _ => Error::Refused,
    }
}
#[derive(Default)]
struct State {
    active: usize,
    closing: bool,
}
struct WorkState {
    state: Mutex<State>,
    changed: Notify,
}
struct Completion {
    work: Arc<WorkState>,
    // Both this permit and the store captured by the blocking closure remain
    // owned until actual synchronous work returns, despite caller cancellation.
    _permit: OwnedSemaphorePermit,
}
impl Drop for Completion {
    fn drop(&mut self) {
        let mut state = self.work.state.lock().unwrap_or_else(|e| e.into_inner());
        state.active -= 1;
        drop(state);
        self.work.changed.notify_waiters();
    }
}
#[derive(Clone)]
pub(super) struct MaterialIo {
    store: MaterialStore,
    source_node: String,
    permits: Arc<Semaphore>,
    work: Arc<WorkState>,
}
impl MaterialIo {
    pub(super) fn new(store: MaterialStore, source_node: String, workers: usize) -> Result<Self> {
        if !identifier_valid(&source_node) {
            return Err(Error::Authentication);
        }
        if !(1..=8).contains(&workers) {
            return Err(Error::Budget);
        }
        Ok(Self {
            store,
            source_node,
            permits: Arc::new(Semaphore::new(workers)),
            work: Arc::new(WorkState {
                state: Mutex::new(State::default()),
                changed: Notify::new(),
            }),
        })
    }
    pub(super) async fn execute(&self, request: MaterialRequest) -> Result<MaterialReply> {
        match request {
            MaterialRequest::ControlFormat { probe_version } => {
                if probe_version != 1 {
                    return Err(Error::Protocol);
                }
                // Code-format support only. This does not certify active
                // voter status, retained bytes, or Authority readiness.
                self.run(|_store| {
                    Ok(MaterialReply::ControlFormat {
                        probe_version: 1,
                        maximum_control_schema: 2,
                    })
                })
                .await
            }
            MaterialRequest::PutCheckpointObject { object, bytes_hex } => {
                let bytes = object_bytes(&object, &bytes_hex)?;
                self.run(move |store| {
                    store.put_object(&object, &bytes).map_err(storage_error)?;
                    Ok(MaterialReply::Object(object))
                })
                .await
            }
            MaterialRequest::CertifyCheckpoint { manifest } => {
                if manifest.objects.len() > 1024
                    || serde_json::to_vec(&manifest)
                        .map_err(|_| Error::Protocol)?
                        .len()
                        > MANIFEST_BYTES
                {
                    return Err(Error::Budget);
                }
                let source_node = self.source_node.clone();
                // MaterialStore independently validates approved community,
                // partition, source signature and every required byte on disk.
                self.run(move |store| {
                    store
                        .certify_checkpoint(&manifest, &source_node)
                        .map(MaterialReply::Checkpoint)
                        .map_err(storage_error)
                })
                .await
            }
            MaterialRequest::CheckpointReceipt { manifest_sha256 } => {
                if !canonical_hash(&manifest_sha256) {
                    return Err(Error::Protocol);
                }
                let source_node = self.source_node.clone();
                self.run(move |store| {
                    store
                        .checkpoint_receipt(&manifest_sha256, &source_node)
                        .map(MaterialReply::Checkpoint)
                        .map_err(storage_error)
                })
                .await
            }
            MaterialRequest::ReadCheckpointManifest { manifest_sha256 } => {
                if !canonical_hash(&manifest_sha256) {
                    return Err(Error::Protocol);
                }
                let source_node = self.source_node.clone();
                self.run(move |store| {
                    store
                        .read_checkpoint_manifest(&manifest_sha256, &source_node)
                        .map(MaterialReply::Manifest)
                        .map_err(storage_error)
                })
                .await
            }
            MaterialRequest::ReadCheckpointObject {
                manifest_sha256,
                index,
            } => {
                if !canonical_hash(&manifest_sha256) || index >= 1024 {
                    return Err(Error::Protocol);
                }
                let source_node = self.source_node.clone();
                self.run(move |store| {
                    let (object, bytes) = store
                        .read_checkpoint_object(&manifest_sha256, &source_node, index)
                        .map_err(storage_error)?;
                    Ok(MaterialReply::Bytes {
                        object,
                        bytes_hex: hex::encode(bytes),
                    })
                })
                .await
            }
        }
    }
    // Private synchronous closures only. Never expose arbitrary callbacks or
    // request-selected paths/keys; a callback must not detach descendant IO.
    async fn run<T: Send + 'static>(
        &self,
        operation: impl FnOnce(MaterialStore) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let permit = self
            .permits
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Budget)?;
        let completion = {
            let mut state = self.work.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.closing {
                return Err(Error::Refused);
            }
            state.active += 1;
            Completion {
                work: self.work.clone(),
                _permit: permit,
            }
        };
        let store = self.store.clone();
        // A dropped JoinHandle does not abort an already queued/started
        // blocking operation. No abort handle is exposed to the network task.
        tokio::task::spawn_blocking(move || {
            let _completion = completion;
            operation(store)
        })
        .await
        .map_err(|_| Error::Refused)?
    }
    /// Stop new admission, then drain known work. A stuck filesystem syscall
    /// can delay this drain: do not invent a successful shutdown deadline.
    pub(super) async fn close(&self) {
        self.work
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .closing = true;
        loop {
            let notified = self.work.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self
                .work
                .state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .active
                == 0
            {
                break;
            }
            notified.await;
        }
    }
}

#[cfg(test)]
mod tests;
