use super::{canonical_hex, MaterialError, Result};
use crate::model::StoreBinding;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug)]
pub struct MaterialLimits {
    pub max_object_bytes: u64,
    pub max_stored_bytes: u64,
    pub max_objects: usize,
    pub max_manifests: usize,
    pub min_free_bytes: u64,
}
impl Default for MaterialLimits {
    fn default() -> Self {
        Self {
            max_object_bytes: 1024 * 1024,
            max_stored_bytes: 64 * 1024 * 1024,
            max_objects: 1024,
            max_manifests: 128,
            min_free_bytes: 64 * 1024 * 1024,
        }
    }
}
impl MaterialLimits {
    pub(super) fn valid(&self) -> bool {
        self.max_object_bytes > 0
            && self.max_object_bytes <= 1024 * 1024
            && self.max_stored_bytes >= self.max_object_bytes
            && self.max_stored_bytes <= 1024 * 1024 * 1024
            && (1..=1024).contains(&self.max_objects)
            && (1..=128).contains(&self.max_manifests)
            && self.min_free_bytes > 0
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MaterialKind {
    CheckpointChunk,
    CommittedTailChunk,
    BlobChunk,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObjectRef {
    pub kind: MaterialKind,
    pub sha256: String,
    pub bytes: u64,
}
impl ObjectRef {
    pub(super) fn validate(&self, limits: &MaterialLimits) -> Result<()> {
        if !canonical_hex(&self.sha256) {
            return Err(MaterialError::Format);
        }
        if self.bytes == 0 || self.bytes > limits.max_object_bytes {
            return Err(MaterialError::Budget);
        }
        Ok(())
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MaterialManifest {
    pub schema_version: u8,
    pub community_id: String,
    pub partition_id: String,
    pub source_archive_sha256: String,
    pub source_inventory_sha256: String,
    pub key_context_sha256: String,
    pub checkpoint_applied_seq: u64,
    pub required_through_seq: u64,
    pub assigned_sequence_high_water: u64,
    /// Checkpoint chunks are concatenated in this order for the archive digest.
    pub objects: Vec<ObjectRef>,
}
impl MaterialManifest {
    pub(super) fn validate(&self, binding: &StoreBinding, limits: &MaterialLimits) -> Result<()> {
        if self.schema_version != 1
            || ![
                &self.community_id,
                &self.source_archive_sha256,
                &self.source_inventory_sha256,
                &self.key_context_sha256,
            ]
            .into_iter()
            .all(|s| canonical_hex(s))
            || self.checkpoint_applied_seq > self.required_through_seq
            || self.required_through_seq > self.assigned_sequence_high_water
        {
            return Err(MaterialError::Format);
        }
        if self.community_id != binding.community_id || self.partition_id != binding.partition_id {
            return Err(MaterialError::Context);
        }
        if self.objects.is_empty() || self.objects.len() > limits.max_objects {
            return Err(MaterialError::Budget);
        }
        let mut seen = std::collections::BTreeSet::new();
        let mut total = 0u64;
        let mut checkpoint = false;
        let mut tail = false;
        for object in &self.objects {
            object.validate(limits)?;
            if !seen.insert(&object.sha256) {
                return Err(MaterialError::Format);
            }
            total = total
                .checked_add(object.bytes)
                .ok_or(MaterialError::Budget)?;
            checkpoint |= object.kind == MaterialKind::CheckpointChunk;
            tail |= object.kind == MaterialKind::CommittedTailChunk;
        }
        if !checkpoint || (self.required_through_seq > self.checkpoint_applied_seq && !tail) {
            return Err(MaterialError::Format);
        }
        if total > limits.max_stored_bytes {
            return Err(MaterialError::Budget);
        }
        Ok(())
    }
}
/// Local required bytes only. No source/engine/crypto verification, quorum,
/// global availability, complete-instance readiness or activation certificate.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalByteReceipt {
    schema_version: u8,
    scope: &'static str,
    node_id: u64,
    community_id: String,
    partition_id: String,
    manifest_sha256: String,
    source_archive_sha256: String,
    source_inventory_sha256: String,
    key_context_sha256: String,
    required_through_seq: u64,
    required_objects: usize,
    required_bytes: u64,
    source_authenticity_verified: bool,
    payload_encryption_verified: bool,
    inactive_replay_verified: bool,
    quorum_available: bool,
    full_instance_ready: bool,
    canonical_writer_permitted: bool,
}
impl LocalByteReceipt {
    pub fn manifest_sha256(&self) -> &str {
        &self.manifest_sha256
    }
    pub(super) fn new(binding: &StoreBinding, manifest: &MaterialManifest, id: String) -> Self {
        Self {
            schema_version: 1,
            scope: "local_required_bytes_only",
            node_id: binding.node_id,
            community_id: binding.community_id.clone(),
            partition_id: binding.partition_id.clone(),
            manifest_sha256: id,
            source_archive_sha256: manifest.source_archive_sha256.clone(),
            source_inventory_sha256: manifest.source_inventory_sha256.clone(),
            key_context_sha256: manifest.key_context_sha256.clone(),
            required_through_seq: manifest.required_through_seq,
            required_objects: manifest.objects.len(),
            required_bytes: manifest.objects.iter().map(|o| o.bytes).sum(),
            source_authenticity_verified: false,
            payload_encryption_verified: false,
            inactive_replay_verified: false,
            quorum_available: false,
            full_instance_ready: false,
            canonical_writer_permitted: false,
        }
    }
}
