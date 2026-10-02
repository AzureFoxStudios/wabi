use super::{canonical_hash, object_bytes, MaterialRequest, MANIFEST_BYTES, OBJECT_BYTES};
use crate::{
    material::{CheckpointManifest, MaterialKind, ObjectRef},
    source_context::{AllocationKnowledge, VerifiedSourceContext},
    transport::{
        rpc::{RemoteResponse, Request},
        Config, Error, Result,
    },
};
use serde::{Deserialize, Serialize};
use std::{sync::Arc, time::Instant};

/// Untrusted wire data. Never deserialize into a locally constructed receipt
/// or writer permit. Every field is checked against the exact requested bytes.
#[derive(Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::transport) struct WireCheckpointReceipt {
    schema_version: u8,
    scope: String,
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_remote_ack_claim_is_strictly_bound_and_no_readiness_can_be_forged() {
        let (_root, io, manifest, bytes) = super::super::tests::setup(1);
        io.store.put_object(&manifest.objects[0], &bytes).unwrap();
        let receipt = io.store.certify_checkpoint(&manifest, "node-1").unwrap();
        let encoded = serde_json::to_value(receipt).unwrap();
        let configs = super::super::tests::configs(&manifest.source.claims.community_id);
        let client =
            CheckpointClient::new(Arc::new(configs[0].clone()), 2, "node-1".into()).unwrap();
        client
            .acknowledge(&manifest, serde_json::from_value(encoded.clone()).unwrap())
            .unwrap();
        for (key, original) in encoded.as_object().unwrap() {
            let mut changed = encoded.clone();
            changed[key] = match original {
                serde_json::Value::Bool(b) => serde_json::json!(!b),
                serde_json::Value::Number(n) => serde_json::json!(n.as_u64().unwrap() + 1),
                serde_json::Value::String(s) => serde_json::json!(format!("{s}x")),
                _ => serde_json::json!({"kind":"unknown", "writer":true}),
            };
            let wire = serde_json::from_value::<WireCheckpointReceipt>(changed);
            assert!(
                wire.is_err() || client.acknowledge(&manifest, wire.unwrap()).is_err(),
                "{key}"
            );
        }
        let mut extra = encoded.clone();
        extra["secretWriterGrant"] = serde_json::json!(true);
        assert!(serde_json::from_value::<WireCheckpointReceipt>(extra).is_err());
        let mut duplicate = serde_json::to_string(&encoded).unwrap();
        duplicate.pop();
        duplicate.push_str(",\"nodeId\":2}");
        assert!(serde_json::from_str::<WireCheckpointReceipt>(&duplicate).is_err());
        let wrong =
            CheckpointClient::new(Arc::new(configs[0].clone()), 3, "node-1".into()).unwrap();
        assert!(wrong
            .acknowledge(&manifest, serde_json::from_value(encoded).unwrap())
            .is_err());
    }
}
/// Synthetic internal field-checking fixture ONLY. This does not represent a
/// Noise exchange or certify that a remote node actually stores these bytes.
#[cfg(test)]
pub(super) fn synthetic_test_ack(
    config: Arc<Config>,
    target: u64,
    manifest: &CheckpointManifest,
    local: crate::material::LocalCheckpointReceipt,
) -> AuthenticatedCheckpointAck {
    let mut wire = serde_json::to_value(local).unwrap();
    wire["nodeId"] = serde_json::json!(target);
    CheckpointClient::new(
        config,
        target,
        manifest.source.claims.source_node_id.clone(),
    )
    .unwrap()
    .acknowledge(manifest, serde_json::from_value(wire).unwrap())
    .unwrap()
}
#[derive(Debug, Deserialize)]
#[serde(
    tag = "operation",
    content = "payload",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub(in crate::transport) enum WireMaterialReply {
    Object(ObjectRef),
    Checkpoint(WireCheckpointReceipt),
    Manifest(CheckpointManifest),
    Bytes {
        object: ObjectRef,
        bytes_hex: String,
    },
}

/// An exact reply received from the configured target on a completed Noise KK
/// channel. Not a committed availability vote, writer permit or durable quorum.
/// Private fields and no Deserialize prevent constructing this from remote JSON.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticatedCheckpointAck {
    target_node_id: u64,
    roster_digest: String,
    receipt: WireCheckpointReceipt,
}
impl AuthenticatedCheckpointAck {
    pub fn target_node_id(&self) -> u64 {
        self.target_node_id
    }
    pub fn manifest_sha256(&self) -> &str {
        &self.receipt.manifest_sha256
    }
    pub fn roster_digest(&self) -> &str {
        &self.roster_digest
    }
}

pub(super) fn manifest_context(
    config: &Config,
    source_node: &str,
    manifest: &CheckpointManifest,
) -> Result<VerifiedSourceContext> {
    if manifest.objects.is_empty()
        || manifest.objects.len() > 1024
        || serde_json::to_vec(manifest)
            .map_err(|_| Error::Protocol)?
            .len()
            > MANIFEST_BYTES
    {
        return Err(Error::Budget);
    }
    if manifest.schema_version != 2 || manifest.partition_id != config.binding.partition_id {
        return Err(Error::Authentication);
    }
    let source = manifest
        .source
        .verify(&config.binding.community_id, source_node)
        .map_err(|_| Error::Authentication)?;
    let mut total = 0u64;
    for object in &manifest.objects {
        if object.kind != MaterialKind::CheckpointChunk
            || !canonical_hash(&object.sha256)
            || object.bytes == 0
            || object.bytes > OBJECT_BYTES as u64
        {
            return Err(Error::Protocol);
        }
        total = total.checked_add(object.bytes).ok_or(Error::Budget)?;
    }
    if total != source.claims().ciphertext_bytes {
        return Err(Error::Protocol);
    }
    Ok(source)
}

/// Dial only an immutable, explicitly approved recovery voter address. The
/// client shares outbound admission with Raft. No account/helper key admission.
#[derive(Clone)]
pub struct CheckpointClient {
    config: Arc<Config>,
    target: u64,
    source_node: String,
}
impl CheckpointClient {
    pub fn new(config: Arc<Config>, target: u64, source_node: String) -> Result<Self> {
        if target == config.node_id()
            || !config.peers.contains_key(&target)
            || !crate::model::identifier_valid(&source_node)
        {
            return Err(Error::Authentication);
        }
        Ok(Self {
            config,
            target,
            source_node,
        })
    }
    async fn request(&self, request: MaterialRequest) -> Result<WireMaterialReply> {
        let started = Instant::now();
        let response = self
            .config
            .exchange(self.target, Request::Material(request))
            .await?;
        // A delayed wake cannot turn an expired material operation into an ACK.
        if started.elapsed() >= self.config.limits.rpc_deadline {
            return Err(Error::Deadline);
        }
        match response {
            RemoteResponse::Material(reply) => Ok(reply),
            RemoteResponse::Refused => Err(Error::Refused),
            _ => Err(Error::Protocol),
        }
    }
    pub async fn put_object(&self, object: ObjectRef, bytes: &[u8]) -> Result<()> {
        if bytes.len() > OBJECT_BYTES {
            return Err(Error::Budget);
        }
        let bytes_hex = hex::encode(bytes);
        object_bytes(&object, &bytes_hex)?;
        match self
            .request(MaterialRequest::PutCheckpointObject {
                object: object.clone(),
                bytes_hex,
            })
            .await?
        {
            WireMaterialReply::Object(actual) if actual == object => Ok(()),
            _ => Err(Error::Protocol),
        }
    }
    fn acknowledge(
        &self,
        manifest: &CheckpointManifest,
        receipt: WireCheckpointReceipt,
    ) -> Result<AuthenticatedCheckpointAck> {
        let source = manifest_context(&self.config, &self.source_node, manifest)?;
        let expected = WireCheckpointReceipt {
            schema_version: 2,
            scope: "local_signed_checkpoint_bytes_only".into(),
            node_id: self.target,
            community_id: self.config.binding.community_id.clone(),
            partition_id: self.config.binding.partition_id.clone(),
            manifest_sha256: manifest.sha256().map_err(|_| Error::Protocol)?,
            source_context_sha256: source.sha256().into(),
            source_archive_sha256: source.claims().archive_sha256.clone(),
            source_inventory_sha256: source.claims().inventory_sha256.clone(),
            applied_commit_seq: source.claims().applied_commit_seq,
            required_objects: manifest.objects.len(),
            required_bytes: source.claims().ciphertext_bytes,
            allocation: AllocationKnowledge::Unknown,
            community_signature_verified: true,
            source_role_verified: false,
            payload_encryption_verified: false,
            inactive_replay_verified: false,
            quorum_available: false,
            full_instance_ready: false,
            canonical_writer_permitted: false,
        };
        if receipt != expected {
            return Err(Error::Authentication);
        }
        Ok(AuthenticatedCheckpointAck {
            target_node_id: self.target,
            roster_digest: self.config.roster_digest(),
            receipt,
        })
    }
    pub async fn certify(
        &self,
        manifest: &CheckpointManifest,
    ) -> Result<AuthenticatedCheckpointAck> {
        manifest_context(&self.config, &self.source_node, manifest)?;
        match self
            .request(MaterialRequest::CertifyCheckpoint {
                manifest: manifest.clone(),
            })
            .await?
        {
            WireMaterialReply::Checkpoint(receipt) => self.acknowledge(manifest, receipt),
            _ => Err(Error::Protocol),
        }
    }
    pub async fn fresh_receipt(
        &self,
        manifest: &CheckpointManifest,
    ) -> Result<AuthenticatedCheckpointAck> {
        manifest_context(&self.config, &self.source_node, manifest)?;
        match self
            .request(MaterialRequest::CheckpointReceipt {
                manifest_sha256: manifest.sha256().map_err(|_| Error::Protocol)?,
            })
            .await?
        {
            WireMaterialReply::Checkpoint(receipt) => self.acknowledge(manifest, receipt),
            _ => Err(Error::Protocol),
        }
    }
    /// Metadata retrieval alone makes no byte-availability assertion.
    pub async fn read_manifest(&self, id: &str) -> Result<CheckpointManifest> {
        if !canonical_hash(id) {
            return Err(Error::Protocol);
        }
        match self
            .request(MaterialRequest::ReadCheckpointManifest {
                manifest_sha256: id.into(),
            })
            .await?
        {
            WireMaterialReply::Manifest(manifest) => {
                manifest_context(&self.config, &self.source_node, &manifest)?;
                if manifest.sha256().map_err(|_| Error::Protocol)? != id {
                    return Err(Error::Protocol);
                }
                Ok(manifest)
            }
            _ => Err(Error::Protocol),
        }
    }
    /// Each copied object is checked independently. Final local certification
    /// must verify the whole ordered archive; this method is not a reseed ACK.
    pub async fn read_object(
        &self,
        manifest: &CheckpointManifest,
        index: usize,
    ) -> Result<Vec<u8>> {
        manifest_context(&self.config, &self.source_node, manifest)?;
        let expected = manifest.objects.get(index).ok_or(Error::Protocol)?;
        match self
            .request(MaterialRequest::ReadCheckpointObject {
                manifest_sha256: manifest.sha256().map_err(|_| Error::Protocol)?,
                index,
            })
            .await?
        {
            WireMaterialReply::Bytes { object, bytes_hex } if &object == expected => {
                object_bytes(&object, &bytes_hex)
            }
            _ => Err(Error::Protocol),
        }
    }
}
