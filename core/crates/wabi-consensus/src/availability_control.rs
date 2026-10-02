//! Versioned historical checkpoint observations. Neither a byte-retention
//! lease nor a Wabi writer permit. Live submission/retention checks stay in
//! the owned collector; this module validates replicated deterministic data.
use crate::{
    material::{CheckpointManifest, MaterialKind},
    model::{ControlReply, ControlState, Outcome, RecoveryPeer},
    source_context::AllocationKnowledge,
    LogId,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ObservationOrigin {
    LocalDurableRead,
    AuthenticatedPeer,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Observation {
    pub(crate) node_id: u64,
    pub(crate) origin: ObservationOrigin,
    pub(crate) receipt_sha256: String,
}
// Field order intentionally preserves the already accepted proposal hash.
// This internal wire decoder is not a public fresh submission capability.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProposalWire {
    pub(crate) schema_version: u8,
    pub(crate) scope: String,
    pub(crate) operation_id: String,
    pub(crate) community_id: String,
    pub(crate) partition_id: String,
    pub(crate) membership_log_id: LogId,
    pub(crate) roster_digest: String,
    pub(crate) manifest_sha256: String,
    pub(crate) source_context_sha256: String,
    pub(crate) source_archive_sha256: String,
    pub(crate) source_inventory_sha256: String,
    pub(crate) applied_commit_seq: u64,
    pub(crate) required_objects: usize,
    pub(crate) required_bytes: u64,
    pub(crate) observations: Vec<Observation>,
    pub(crate) allocation: AllocationKnowledge,
    pub(crate) committed: bool,
    pub(crate) source_role_verified: bool,
    pub(crate) payload_encryption_verified: bool,
    pub(crate) inactive_replay_verified: bool,
    pub(crate) quorum_available: bool,
    pub(crate) full_instance_ready: bool,
    pub(crate) canonical_writer_permitted: bool,
}
impl ProposalWire {
    pub(crate) fn sha256(&self) -> Option<String> {
        let mut hash = Sha256::new();
        hash.update(b"wabi-checkpoint-availability-proposal/v1\0");
        hash.update(serde_json::to_vec(self).ok()?);
        Some(hex::encode(hash.finalize()))
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum CommandKind {
    CheckpointObservation,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckpointObservationCommand {
    #[serde(deserialize_with = "schema_two")]
    schema_version: u8,
    kind: CommandKind,
    collector_node_id: u64,
    #[serde(deserialize_with = "unique_peers")]
    peers: BTreeMap<u64, RecoveryPeer>,
    proposal: ProposalWire,
    proposal_sha256: String,
    manifest: CheckpointManifest,
}
fn schema_two<'de, D>(deserializer: D) -> Result<u8, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let schema = u8::deserialize(deserializer)?;
    if schema != 2 {
        return Err(serde::de::Error::custom(
            "unsupported checkpoint control schema",
        ));
    }
    Ok(schema)
}
fn unique_peers<'de, D>(deserializer: D) -> Result<BTreeMap<u64, RecoveryPeer>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct Visitor;
    impl<'de> serde::de::Visitor<'de> for Visitor {
        type Value = BTreeMap<u64, RecoveryPeer>;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("exactly three distinct enrolled peers")
        }
        fn visit_map<M: serde::de::MapAccess<'de>>(
            self,
            mut map: M,
        ) -> Result<Self::Value, M::Error> {
            let mut peers = BTreeMap::new();
            // Untagged application data uses Serde's buffered content decoder,
            // which lacks serde_json's special integer map-key conversion.
            // Parse the canonical JSON string key explicitly in both paths.
            while let Some((key, peer)) = map.next_entry::<String, RecoveryPeer>()? {
                let id = key
                    .parse::<u64>()
                    .map_err(|_| serde::de::Error::custom("invalid peer ID"))?;
                if id == 0 || key != id.to_string() {
                    return Err(serde::de::Error::custom("noncanonical peer ID"));
                }
                if peers.len() >= 3 || peers.insert(id, peer).is_some() {
                    return Err(serde::de::Error::custom(
                        "duplicate or oversized peer roster",
                    ));
                }
            }
            Ok(peers)
        }
    }
    deserializer.deserialize_map(Visitor)
}
fn lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
pub(crate) fn roster_digest(peers: &BTreeMap<u64, RecoveryPeer>) -> Option<String> {
    let mut hash = Sha256::new();
    hash.update(b"wabi-recovery-roster/noise-kk-v1\0");
    hash.update(serde_json::to_vec(peers).ok()?);
    Some(hex::encode(hash.finalize()))
}
impl CheckpointObservationCommand {
    pub(crate) fn collected(
        collector_node_id: u64,
        peers: BTreeMap<u64, RecoveryPeer>,
        proposal: ProposalWire,
        manifest: CheckpointManifest,
    ) -> Option<Self> {
        let command = Self {
            schema_version: 2,
            kind: CommandKind::CheckpointObservation,
            collector_node_id,
            proposal_sha256: proposal.sha256()?,
            peers,
            proposal,
            manifest,
        };
        command.valid().then_some(command)
    }
    pub fn operation_id(&self) -> &str {
        &self.proposal.operation_id
    }
    pub fn manifest_sha256(&self) -> &str {
        &self.proposal.manifest_sha256
    }
    pub(crate) fn membership_log_id(&self) -> LogId {
        self.proposal.membership_log_id
    }
    pub fn fingerprint(&self) -> Option<String> {
        if !self.bounds() {
            return None;
        }
        let mut hash = Sha256::new();
        hash.update(b"wabi-checkpoint-observation-command/v2\0");
        hash.update(serde_json::to_vec(self).ok()?);
        Some(hex::encode(hash.finalize()))
    }
    pub(crate) fn bounds(&self) -> bool {
        let p = &self.proposal;
        self.schema_version == 2
            && self.peers.len() == 3
            && p.operation_id.len() <= 32
            && p.community_id.len() <= 64
            && p.partition_id.len() <= 128
            && p.scope.len() <= 64
            && p.observations.len() <= 3
            && self.manifest.objects.len() <= 1024
            && self.manifest.partition_id.len() <= 128
            && [
                &p.roster_digest,
                &p.manifest_sha256,
                &p.source_context_sha256,
                &p.source_archive_sha256,
                &p.source_inventory_sha256,
                &self.proposal_sha256,
            ]
            .into_iter()
            .all(|s| s.len() <= 64)
            && self.manifest.source.public_key.len() <= 130
            && self.manifest.source.signature.len() <= 128
            && self.manifest.source.claims.source_node_id.len() <= 128
            && self.manifest.source.claims.support_profile.len() <= 64
            && [
                &self.manifest.source.claims.community_id,
                &self.manifest.source.claims.archive_sha256,
                &self.manifest.source.claims.inventory_sha256,
                &self.manifest.source.claims.commit_prefix_fingerprint,
                &self.manifest.source.claims.bootstrap_fingerprint,
            ]
            .into_iter()
            .all(|s| s.len() <= 64)
            && self
                .manifest
                .objects
                .iter()
                .all(|object| object.sha256.len() <= 64)
            && self.peers.values().all(|peer| {
                peer.community_id.len() <= 64
                    && peer.site_id.len() <= 128
                    && peer.public_key.len() <= 64
                    && peer.rpc_address.len() <= 128
            })
            && p.observations.iter().all(|o| o.receipt_sha256.len() <= 64)
    }
    pub(crate) fn valid(&self) -> bool {
        let p = &self.proposal;
        if !self.bounds()
            || self.schema_version != 2
            || p.schema_version != 1
            || p.scope != "uncommitted_checkpoint_availability_proposal"
            || !lower_hex(&p.operation_id, 32)
            || !lower_hex(&p.community_id, 64)
            || !crate::model::identifier_valid(&p.partition_id)
            || !self.peers.contains_key(&self.collector_node_id)
            || self.peers.keys().any(|id| *id == 0)
            || self
                .peers
                .values()
                .any(|peer| !peer.valid_for(&p.community_id))
            || roster_digest(&self.peers).as_deref() != Some(&p.roster_digest)
            || self.proposal.sha256().as_deref() != Some(&self.proposal_sha256)
            || [
                p.committed,
                p.source_role_verified,
                p.payload_encryption_verified,
                p.inactive_replay_verified,
                p.quorum_available,
                p.full_instance_ready,
                p.canonical_writer_permitted,
            ]
            .into_iter()
            .any(|flag| flag)
            || p.allocation != AllocationKnowledge::Unknown
            || p.observations.len() < 2
            || p.observations
                .windows(2)
                .any(|pair| pair[0].node_id >= pair[1].node_id)
            || p.observations.iter().any(|o| {
                !self.peers.contains_key(&o.node_id)
                    || !lower_hex(&o.receipt_sha256, 64)
                    || (o.origin == ObservationOrigin::LocalDurableRead)
                        != (o.node_id == self.collector_node_id)
            })
            || self.manifest.schema_version != 2
            || self.manifest.partition_id != p.partition_id
            || self.manifest.sha256().ok().as_deref() != Some(&p.manifest_sha256)
        {
            return false;
        }
        let Ok(source) = self
            .manifest
            .source
            .verify(&p.community_id, &self.manifest.source.claims.source_node_id)
        else {
            return false;
        };
        let unique = |items: Vec<String>| {
            items
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                == 3
        };
        if !unique(self.peers.values().map(|p| p.site_id.clone()).collect())
            || !unique(
                self.peers
                    .values()
                    .map(|p| p.public_key.to_ascii_lowercase())
                    .collect(),
            )
            || !unique(
                self.peers
                    .values()
                    .map(|p| {
                        p.rpc_address
                            .parse::<std::net::SocketAddr>()
                            .unwrap()
                            .to_string()
                    })
                    .collect(),
            )
        {
            return false;
        }
        let claims = source.claims();
        let mut total = 0u64;
        for object in &self.manifest.objects {
            if object.kind != MaterialKind::CheckpointChunk
                || !lower_hex(&object.sha256, 64)
                || object.bytes == 0
                || object.bytes > 64 * 1024
            {
                return false;
            }
            let Some(next) = total.checked_add(object.bytes) else {
                return false;
            };
            total = next;
        }
        p.source_context_sha256 == source.sha256()
            && p.source_archive_sha256 == claims.archive_sha256
            && p.source_inventory_sha256 == claims.inventory_sha256
            && p.applied_commit_seq == claims.applied_commit_seq
            && p.required_objects == self.manifest.objects.len()
            && p.required_bytes == claims.ciphertext_bytes
            && total == p.required_bytes
            && total <= 64 * 1024 * 1024
    }
    pub(crate) fn binding_matches(&self, community: &str, partition: &str) -> bool {
        self.proposal.community_id == community && self.proposal.partition_id == partition
    }
    pub(crate) fn config_matches(&self, config: &crate::transport::Config) -> bool {
        config.checkpoint_roster_matches(
            &self.proposal.community_id,
            &self.proposal.partition_id,
            &self.peers,
        )
    }
    fn current_membership(&self, state: &ControlState) -> bool {
        let membership = state.membership.membership();
        state.membership.log_id() == &Some(self.proposal.membership_log_id)
            && state.last_applied.is_some_and(|last| {
                self.proposal.membership_log_id.index <= last.index
                    && self.proposal.membership_log_id <= last
            })
            && membership.get_joint_config().len() == 1
            && membership.voter_ids().collect::<Vec<_>>()
                == self.peers.keys().copied().collect::<Vec<_>>()
            && membership.nodes().collect::<BTreeMap<_, _>>()
                == self.peers.iter().collect::<BTreeMap<_, _>>()
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckpointOperationReceipt {
    pub command: CheckpointObservationCommand,
    pub reply: ControlReply,
}
impl ControlState {
    pub(crate) fn apply_checkpoint(
        &mut self,
        command: CheckpointObservationCommand,
        log: LogId,
        community: &str,
        partition: &str,
        max_operations: usize,
    ) -> ControlReply {
        let refused = ControlReply::default();
        if !command.valid()
            || !command.binding_matches(community, partition)
            || self.operations.contains_key(command.operation_id())
        {
            return refused;
        }
        if let Some(prior) = self.checkpoints.get(command.operation_id()) {
            return if prior.command == command {
                prior.reply.clone()
            } else {
                refused
            };
        }
        if self.operations.len().saturating_add(self.checkpoints.len()) >= max_operations {
            return refused;
        }
        if !self.last_applied.is_some_and(|last| {
            command.proposal.membership_log_id.index <= last.index
                && command.proposal.membership_log_id <= last
        }) || command.proposal.membership_log_id.index >= log.index
            || command.proposal.membership_log_id >= log
        {
            return refused;
        }
        let outcome = if command.current_membership(self)
            && command.proposal.membership_log_id.index < log.index
            && command.proposal.membership_log_id < log
        {
            Outcome::Accepted
        } else {
            Outcome::Refused
        };
        let reply = ControlReply {
            outcome,
            epoch: 0,
            committed_at: Some(log),
            canonical_writer_permitted: false,
        };
        self.checkpoints.insert(
            command.operation_id().to_owned(),
            CheckpointOperationReceipt {
                command,
                reply: reply.clone(),
            },
        );
        reply
    }
    pub(crate) fn checkpoints_coherent(&self, community: &str, partition: &str) -> bool {
        let mut positions = self
            .operations
            .values()
            .filter_map(|r| r.reply.committed_at)
            .collect::<std::collections::BTreeSet<_>>();
        self.checkpoints.iter().all(|(id, receipt)| {
            let Some(position) = receipt.reply.committed_at else {
                return false;
            };
            id == receipt.command.operation_id()
                && positions.insert(position)
                && !self.operations.contains_key(id)
                && receipt.command.valid()
                && receipt.command.binding_matches(community, partition)
                && receipt.reply.epoch == 0
                && !receipt.reply.canonical_writer_permitted
                && receipt.reply.outcome != Outcome::Conflict
                && self
                    .last_applied
                    .is_some_and(|last| position.index <= last.index && position <= last)
                && receipt.command.proposal.membership_log_id.index < position.index
                && receipt.command.proposal.membership_log_id < position
        })
    }
}

#[cfg(test)]
pub(crate) mod tests;
