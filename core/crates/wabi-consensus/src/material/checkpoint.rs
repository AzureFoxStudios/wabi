//! Versioned signed-checkpoint bytes, with no assigned-nonce fiction.
use super::*;
use crate::source_context::{
    AllocationKnowledge, SignedSourceContext, SourceError, VerifiedSourceContext,
};
use serde::{Deserialize, Serialize};
use std::{
    path::Component,
    time::{Duration, Instant},
};
pub const TRANSFER_OBJECT_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckpointManifest {
    pub schema_version: u8,
    pub partition_id: String,
    pub source: SignedSourceContext,
    /// Repeated chunks are valid; order and lengths remain significant.
    pub objects: Vec<ObjectRef>,
}
impl CheckpointManifest {
    pub fn sha256(&self) -> Result<String> {
        Ok(digest(&encode(self)?))
    }
}
fn encode(manifest: &CheckpointManifest) -> Result<Vec<u8>> {
    if manifest.objects.len() > 1024 {
        return Err(MaterialError::Budget);
    }
    let bytes = serde_json::to_vec(manifest).map_err(|_| MaterialError::Format)?;
    if bytes.len() > MAX_CHECKPOINT_JSON {
        return Err(MaterialError::Budget);
    }
    Ok(bytes)
}
fn source_error(error: SourceError) -> MaterialError {
    match error {
        SourceError::Binding => MaterialError::Context,
        SourceError::Budget => MaterialError::Budget,
        _ => MaterialError::Format,
    }
}
fn check_deadline(deadline: Option<Instant>) -> Result<()> {
    if deadline.is_some_and(|end| Instant::now() >= end) {
        return Err(MaterialError::Deadline);
    }
    Ok(())
}
/// Community-key signature and exact local bytes only. No current source-role,
/// encryption/replay, majority, full-instance or writer/nonce certification.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalCheckpointReceipt {
    schema_version: u8,
    scope: &'static str,
    node_id: u64,
    community_id: String,
    partition_id: String,
    manifest_sha256: String,
    source_context_sha256: String,
    source_archive_sha256: String,
    source_inventory_sha256: String,
    applied_commit_seq: u64,
    required_objects: usize,
    required_bytes: u64,
    allocation: AllocationKnowledge,
    community_signature_verified: bool,
    source_role_verified: bool,
    payload_encryption_verified: bool,
    inactive_replay_verified: bool,
    quorum_available: bool,
    full_instance_ready: bool,
    canonical_writer_permitted: bool,
}
impl LocalCheckpointReceipt {
    pub fn manifest_sha256(&self) -> &str {
        &self.manifest_sha256
    }
    pub fn source_context_sha256(&self) -> &str {
        &self.source_context_sha256
    }
    fn new(
        binding: &StoreBinding,
        manifest: &CheckpointManifest,
        source: &VerifiedSourceContext,
        id: String,
    ) -> Self {
        let claims = source.claims();
        Self {
            schema_version: 2,
            scope: "local_signed_checkpoint_bytes_only",
            node_id: binding.node_id,
            community_id: binding.community_id.clone(),
            partition_id: binding.partition_id.clone(),
            manifest_sha256: id,
            source_context_sha256: source.sha256().into(),
            source_archive_sha256: claims.archive_sha256.clone(),
            source_inventory_sha256: claims.inventory_sha256.clone(),
            applied_commit_seq: claims.applied_commit_seq,
            required_objects: manifest.objects.len(),
            required_bytes: claims.ciphertext_bytes,
            allocation: AllocationKnowledge::Unknown,
            community_signature_verified: true,
            source_role_verified: false,
            payload_encryption_verified: false,
            inactive_replay_verified: false,
            quorum_available: false,
            full_instance_ready: false,
            canonical_writer_permitted: false,
        }
    }
}
#[derive(Clone, Copy, Debug)]
pub struct ChunkingLimits {
    pub timeout: Duration,
}
impl Default for ChunkingLimits {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(60),
        }
    }
}
impl MaterialStore {
    fn checkpoint_metadata(
        &self,
        manifest: &CheckpointManifest,
        expected_source_node: &str,
    ) -> Result<VerifiedSourceContext> {
        self.inner.verify()?;
        encode(manifest)?;
        if manifest.schema_version != 2 {
            return Err(MaterialError::Format);
        }
        if manifest.partition_id != self.inner.binding.partition_id {
            return Err(MaterialError::Context);
        }
        let source = manifest
            .source
            .verify(&self.inner.binding.community_id, expected_source_node)
            .map_err(source_error)?;
        if manifest.objects.is_empty() || manifest.objects.len() > self.inner.limits.max_objects {
            return Err(MaterialError::Budget);
        }
        let mut total = 0u64;
        for object in &manifest.objects {
            object.validate(&self.inner.limits)?;
            if object.kind != MaterialKind::CheckpointChunk {
                return Err(MaterialError::Format);
            }
            if object.bytes > TRANSFER_OBJECT_BYTES as u64 {
                return Err(MaterialError::Budget);
            }
            total = total
                .checked_add(object.bytes)
                .ok_or(MaterialError::Budget)?;
        }
        if total > self.inner.limits.max_stored_bytes {
            return Err(MaterialError::Budget);
        }
        if total != source.claims().ciphertext_bytes {
            return Err(MaterialError::Format);
        }
        Ok(source)
    }
    fn load_checkpoint(&self, id: &str, expected_source_node: &str) -> Result<CheckpointManifest> {
        self.inner.verify()?;
        if !canonical_hex(id) {
            return Err(MaterialError::Format);
        }
        let bytes =
            self.inner
                .read_json_cap(&format!("{id}.checkpoint.json"), 1, MAX_CHECKPOINT_JSON)?;
        if digest(&bytes) != id {
            return Err(MaterialError::Format);
        }
        let manifest: CheckpointManifest =
            serde_json::from_slice(&bytes).map_err(|_| MaterialError::Format)?;
        if encode(&manifest)? != bytes {
            return Err(MaterialError::Format);
        }
        self.checkpoint_metadata(&manifest, expected_source_node)?;
        Ok(manifest)
    }
    /// Read signed, content-addressed metadata. This is not an availability
    /// receipt: callers independently retrieve/hash bytes and certify locally.
    pub fn read_checkpoint_manifest(
        &self,
        id: &str,
        source_node: &str,
    ) -> Result<CheckpointManifest> {
        let _lane = self
            .inner
            .lane
            .lock()
            .map_err(|_| MaterialError::Ownership)?;
        self.load_checkpoint(id, source_node)
    }
    /// Only objects referenced at the exact index of a valid signed manifest
    /// can be read. Orphan blobs and request-selected filesystem paths cannot.
    pub fn read_checkpoint_object(
        &self,
        id: &str,
        source_node: &str,
        index: usize,
    ) -> Result<(ObjectRef, Vec<u8>)> {
        let _lane = self
            .inner
            .lane
            .lock()
            .map_err(|_| MaterialError::Ownership)?;
        let manifest = self.load_checkpoint(id, source_node)?;
        let object = manifest
            .objects
            .get(index)
            .ok_or(MaterialError::Format)?
            .clone();
        let file = self
            .inner
            .private_file(&format!("{}.blob", object.sha256), 1)?;
        if io(file.metadata())?.len() != object.bytes {
            return Err(MaterialError::Format);
        }
        let mut bytes = Vec::new();
        io(file.take(object.bytes + 1).read_to_end(&mut bytes))?;
        if bytes.len() as u64 != object.bytes || digest(&bytes) != object.sha256 {
            return Err(MaterialError::Format);
        }
        self.inner.verify()?;
        Ok((object, bytes))
    }
    fn validate_checkpoint(
        &self,
        manifest: &CheckpointManifest,
        expected_source_node: &str,
        deadline: Option<Instant>,
    ) -> Result<VerifiedSourceContext> {
        let source = self.checkpoint_metadata(manifest, expected_source_node)?;
        let mut total = 0u64;
        let mut hash = Sha256::new();
        for object in &manifest.objects {
            check_deadline(deadline)?;
            if object.kind != MaterialKind::CheckpointChunk {
                return Err(MaterialError::Format);
            }
            if object.bytes > TRANSFER_OBJECT_BYTES as u64 {
                return Err(MaterialError::Budget);
            }
            total = total
                .checked_add(object.bytes)
                .ok_or(MaterialError::Budget)?;
            if total > self.inner.limits.max_stored_bytes {
                return Err(MaterialError::Budget);
            }
            self.inner.verify_object(object, Some(&mut hash))?;
            check_deadline(deadline)?;
        }
        if total != source.claims().ciphertext_bytes
            || hex::encode(hash.finalize()) != source.claims().archive_sha256
        {
            return Err(MaterialError::Format);
        }
        Ok(source)
    }
    pub fn certify_checkpoint(
        &self,
        manifest: &CheckpointManifest,
        expected_source_node: &str,
    ) -> Result<LocalCheckpointReceipt> {
        self.certify_checkpoint_hook(manifest, expected_source_node, |_| {})
    }
    fn certify_checkpoint_hook(
        &self,
        manifest: &CheckpointManifest,
        expected_source_node: &str,
        hook: impl FnMut(Point),
    ) -> Result<LocalCheckpointReceipt> {
        self.certify_checkpoint_deadline(manifest, expected_source_node, None, hook)
    }
    fn certify_checkpoint_deadline(
        &self,
        manifest: &CheckpointManifest,
        expected_source_node: &str,
        deadline: Option<Instant>,
        hook: impl FnMut(Point),
    ) -> Result<LocalCheckpointReceipt> {
        let _lane = self
            .inner
            .lane
            .lock()
            .map_err(|_| MaterialError::Ownership)?;
        // A synchronous lane or filesystem syscall cannot be preempted. Work
        // stays owned; a late result never becomes a successful receipt.
        check_deadline(deadline)?;
        let source = self.validate_checkpoint(manifest, expected_source_node, deadline)?;
        let encoded = encode(manifest)?;
        let id = digest(&encoded);
        let name = format!("{id}.checkpoint.json");
        check_deadline(deadline)?;
        match fs::symlink_metadata(self.inner.relative(&name)) {
            Ok(_) => {
                if self.inner.read_json_cap(&name, 1, MAX_CHECKPOINT_JSON)? != encoded {
                    return Err(MaterialError::Format);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let (_, count, _) = self.inner.inventory()?;
                if count >= self.inner.limits.max_manifests {
                    return Err(MaterialError::Budget);
                }
                check_deadline(deadline)?;
                self.inner.publish(&name, &encoded, hook)?;
            }
            Err(_) => return Err(MaterialError::Io),
        }
        io(self.inner.private_file(&name, 1)?.sync_all())?;
        io(self.inner.directory.sync_all())?;
        self.inner.verify()?;
        check_deadline(deadline)?;
        Ok(LocalCheckpointReceipt::new(
            &self.inner.binding,
            manifest,
            &source,
            id,
        ))
    }
    pub fn checkpoint_receipt(
        &self,
        id: &str,
        expected_source_node: &str,
    ) -> Result<LocalCheckpointReceipt> {
        let _lane = self
            .inner
            .lane
            .lock()
            .map_err(|_| MaterialError::Ownership)?;
        self.inner.verify()?;
        if !canonical_hex(id) {
            return Err(MaterialError::Format);
        }
        let name = format!("{id}.checkpoint.json");
        let bytes = self.inner.read_json_cap(&name, 1, MAX_CHECKPOINT_JSON)?;
        if digest(&bytes) != id {
            return Err(MaterialError::Format);
        }
        let manifest: CheckpointManifest =
            serde_json::from_slice(&bytes).map_err(|_| MaterialError::Format)?;
        if encode(&manifest)? != bytes {
            return Err(MaterialError::Format);
        }
        let source = self.validate_checkpoint(&manifest, expected_source_node, None)?;
        io(self.inner.private_file(&name, 1)?.sync_all())?;
        io(self.inner.directory.sync_all())?;
        self.inner.verify()?;
        Ok(LocalCheckpointReceipt::new(
            &self.inner.binding,
            &manifest,
            &source,
            id.into(),
        ))
    }
    /// Synchronous work; an async caller must retain its admission/store in an
    /// owned blocking lane. Failed ingestion leaves valid quota-charged chunks
    /// but no new receipt. Never delete shared immutable objects speculatively.
    pub fn ingest_checkpoint(
        &self,
        path: &Path,
        source: &VerifiedSourceContext,
        limits: ChunkingLimits,
    ) -> Result<(CheckpointManifest, LocalCheckpointReceipt)> {
        if limits.timeout.is_zero()
            || limits.timeout > Duration::from_secs(300)
            || !path.is_absolute()
            || path
                .components()
                .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
        {
            return Err(MaterialError::Format);
        }
        if source.claims().community_id != self.inner.binding.community_id {
            return Err(MaterialError::Context);
        }
        if source.claims().ciphertext_bytes > self.inner.limits.max_stored_bytes {
            return Err(MaterialError::Budget);
        }
        let deadline = Instant::now()
            .checked_add(limits.timeout)
            .ok_or(MaterialError::Format)?;
        let mut ancestor = path.parent();
        while let Some(parent) = ancestor {
            if io(fs::symlink_metadata(parent))?.file_type().is_symlink() {
                return Err(MaterialError::Ownership);
            }
            ancestor = parent.parent();
        }
        let named = io(fs::symlink_metadata(path))?;
        let uid = io(fs::metadata("/proc/self"))?.uid();
        if !named.is_file()
            || named.file_type().is_symlink()
            || named.nlink() != 1
            || named.mode() & 0o077 != 0
            || named.uid() != uid
        {
            return Err(MaterialError::Ownership);
        }
        if named.len() != source.claims().ciphertext_bytes {
            return Err(MaterialError::Format);
        }
        let mut input = io(OpenOptions::new()
            .read(true)
            .custom_flags(NOFOLLOW)
            .open(path))?;
        let held = io(input.metadata())?;
        if (named.dev(), named.ino()) != (held.dev(), held.ino()) {
            return Err(MaterialError::Ownership);
        }
        let mut objects = Vec::new();
        let mut hash = Sha256::new();
        let mut total = 0u64;
        loop {
            if Instant::now() >= deadline {
                return Err(MaterialError::Deadline);
            }
            let mut bytes = vec![0u8; TRANSFER_OBJECT_BYTES];
            let mut used = 0;
            while used < bytes.len() {
                let n = io(input.read(&mut bytes[used..]))?;
                if n == 0 {
                    break;
                }
                used += n;
            }
            if used == 0 {
                break;
            }
            bytes.truncate(used);
            total = total
                .checked_add(used as u64)
                .ok_or(MaterialError::Budget)?;
            if total > source.claims().ciphertext_bytes
                || objects.len() >= self.inner.limits.max_objects
            {
                return Err(MaterialError::Budget);
            }
            hash.update(&bytes);
            let object = ObjectRef {
                kind: MaterialKind::CheckpointChunk,
                sha256: digest(&bytes),
                bytes: used as u64,
            };
            self.put_object(&object, &bytes)?;
            objects.push(object);
        }
        if total != source.claims().ciphertext_bytes
            || hex::encode(hash.finalize()) != source.claims().archive_sha256
        {
            return Err(MaterialError::Format);
        }
        let current = io(fs::symlink_metadata(path))?;
        let held = io(input.metadata())?;
        if (current.dev(), current.ino()) != (named.dev(), named.ino())
            || (held.dev(), held.ino()) != (named.dev(), named.ino())
            || current.len() != total
            || current.nlink() != 1
            || current.mode() & 0o077 != 0
            || current.uid() != uid
        {
            return Err(MaterialError::Ownership);
        }
        if Instant::now() >= deadline {
            return Err(MaterialError::Deadline);
        }
        let manifest = CheckpointManifest {
            schema_version: 2,
            partition_id: self.inner.binding.partition_id.clone(),
            source: source.signed().clone(),
            objects,
        };
        let receipt = self.certify_checkpoint_deadline(
            &manifest,
            &source.claims().source_node_id,
            Some(deadline),
            |_| {},
        )?;
        Ok((manifest, receipt))
    }
}
#[cfg(test)]
mod tests;
