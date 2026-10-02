//! Fresh, fixed-roster byte observations for an UNCOMMITTED availability
//! proposal. The durable command/application, replay and activation bridge
//! remain separate. No serialized caller receipt can enter this collector.
use super::{
    client::manifest_context, MaterialIo, MaterialReply, MaterialRequest, MaterialService,
};
use crate::{
    material::CheckpointManifest,
    source_context::AllocationKnowledge,
    store::Store,
    transport::{AuthenticatedCheckpointAck, CheckpointClient, Config, Error, Result},
    LogId, Membership,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    sync::Arc,
    time::{Duration, Instant},
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum ObservationOrigin {
    LocalDurableRead,
    AuthenticatedPeer,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Observation {
    node_id: u64,
    origin: ObservationOrigin,
    receipt_sha256: String,
}
/// An immutable candidate for a subsequent durable consensus command. There
/// is deliberately no Deserialize, committed log ID or activation permission.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointAvailabilityProposal {
    schema_version: u8,
    scope: &'static str,
    operation_id: String,
    community_id: String,
    partition_id: String,
    membership_log_id: LogId,
    roster_digest: String,
    manifest_sha256: String,
    source_context_sha256: String,
    source_archive_sha256: String,
    source_inventory_sha256: String,
    applied_commit_seq: u64,
    required_objects: usize,
    required_bytes: u64,
    observations: Vec<Observation>,
    allocation: AllocationKnowledge,
    committed: bool,
    source_role_verified: bool,
    payload_encryption_verified: bool,
    inactive_replay_verified: bool,
    quorum_available: bool,
    full_instance_ready: bool,
    canonical_writer_permitted: bool,
}
impl CheckpointAvailabilityProposal {
    pub fn operation_id(&self) -> &str {
        &self.operation_id
    }
    pub fn manifest_sha256(&self) -> &str {
        &self.manifest_sha256
    }
    pub fn observed_voters(&self) -> Vec<u64> {
        self.observations
            .iter()
            .map(|observation| observation.node_id)
            .collect()
    }
    pub fn sha256(&self) -> Result<String> {
        let mut hash = Sha256::new();
        hash.update(b"wabi-checkpoint-availability-proposal/v1\0");
        hash.update(serde_json::to_vec(self).map_err(|_| Error::Protocol)?);
        Ok(hex::encode(hash.finalize()))
    }
}

/// Shares the existing MaterialService's owned IO admission. Every public
/// refresh performs a fresh disk/Noise request itself; callers cannot supply
/// an old ACK, serialized receipt, advertised helper or arbitrary voter list.
pub struct CheckpointAvailabilityRound {
    config: Arc<Config>,
    control: Store,
    local: MaterialIo,
    membership: Membership,
    membership_log_id: LogId,
    manifest: CheckpointManifest,
    manifest_sha256: String,
    source_context_sha256: String,
    source_node: String,
    operation_id: String,
    deadline: Instant,
    observations: BTreeMap<u64, Observation>,
}
fn operation_id_valid(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn membership_bound(config: &Config, state: &crate::model::ControlState) -> Result<LogId> {
    let membership = state.membership.membership();
    let voters: Vec<_> = membership.voter_ids().collect();
    if membership.get_joint_config().len() != 1
        || voters != config.peers.keys().copied().collect::<Vec<_>>()
        || membership.nodes().collect::<BTreeMap<_, _>>()
            != config.peers.iter().collect::<BTreeMap<_, _>>()
    {
        return Err(Error::Authentication);
    }
    let position = (*state.membership.log_id()).ok_or(Error::Authentication)?;
    if !state
        .last_applied
        .is_some_and(|last| position.index <= last.index && position <= last)
    {
        return Err(Error::Authentication);
    }
    Ok(position)
}
impl CheckpointAvailabilityRound {
    pub async fn begin(
        config: Arc<Config>,
        control: Store,
        service: &MaterialService,
        operation_id: String,
        manifest: &CheckpointManifest,
        timeout: Duration,
    ) -> Result<Self> {
        let started = Instant::now();
        if timeout.is_zero() || timeout > Duration::from_secs(30) {
            return Err(Error::Budget);
        }
        if !operation_id_valid(&operation_id)
            || control.binding() != &config.binding
            || !service.matches(&config)
        {
            return Err(Error::Authentication);
        }
        let source_node = service.io.source_node.clone();
        let source = manifest_context(&config, &source_node, manifest)?;
        let state = control.control_state().await.map_err(|_| Error::Refused)?;
        let membership_log_id = membership_bound(&config, &state)?;
        if state.operations.contains_key(&operation_id) {
            return Err(Error::Refused);
        }
        let deadline = started.checked_add(timeout).ok_or(Error::Budget)?;
        if Instant::now() >= deadline {
            return Err(Error::Deadline);
        }
        Ok(Self {
            config,
            control,
            local: service.io.clone(),
            membership: state.membership,
            membership_log_id,
            manifest: manifest.clone(),
            manifest_sha256: manifest.sha256().map_err(|_| Error::Protocol)?,
            source_context_sha256: source.sha256().into(),
            source_node,
            operation_id,
            deadline,
            observations: BTreeMap::new(),
        })
    }
    fn in_time(&self) -> Result<()> {
        if Instant::now() >= self.deadline {
            Err(Error::Deadline)
        } else {
            Ok(())
        }
    }
    async fn current_membership(&self) -> Result<()> {
        self.in_time()?;
        let state = self
            .control
            .control_state()
            .await
            .map_err(|_| Error::Refused)?;
        if state.membership != self.membership
            || membership_bound(&self.config, &state)? != self.membership_log_id
            || state.operations.contains_key(&self.operation_id)
        {
            return Err(Error::Authentication);
        }
        self.in_time()
    }
    fn observe_peer(&mut self, ack: AuthenticatedCheckpointAck) -> Result<()> {
        self.in_time()?;
        let node = ack.target_node_id();
        if node == self.config.node_id()
            || !self.config.peers.contains_key(&node)
            || ack.manifest_sha256() != self.manifest_sha256
            || ack.roster_digest() != self.config.roster_digest()
        {
            return Err(Error::Authentication);
        }
        let bytes = serde_json::to_vec(&ack).map_err(|_| Error::Protocol)?;
        self.observations.insert(
            node,
            Observation {
                node_id: node,
                origin: ObservationOrigin::AuthenticatedPeer,
                receipt_sha256: hex::encode(Sha256::digest(bytes)),
            },
        );
        Ok(())
    }
    pub async fn refresh(&mut self, node: u64) -> Result<()> {
        // A failed fresh recheck must remove this round's previous success.
        // Repeating one voter never increases distinct-voter arithmetic.
        self.observations.remove(&node);
        if !self.config.peers.contains_key(&node) {
            return Err(Error::Authentication);
        }
        self.current_membership().await?;
        if node == self.config.node_id() {
            let receipt = match self
                .local
                .execute(MaterialRequest::CheckpointReceipt {
                    manifest_sha256: self.manifest_sha256.clone(),
                })
                .await?
            {
                MaterialReply::Checkpoint(receipt) => receipt,
                _ => return Err(Error::Protocol),
            };
            self.current_membership().await?;
            if receipt.manifest_sha256() != self.manifest_sha256
                || receipt.source_context_sha256() != self.source_context_sha256
            {
                return Err(Error::Authentication);
            }
            self.observations.insert(
                node,
                Observation {
                    node_id: node,
                    origin: ObservationOrigin::LocalDurableRead,
                    receipt_sha256: hex::encode(Sha256::digest(
                        serde_json::to_vec(&receipt).map_err(|_| Error::Protocol)?,
                    )),
                },
            );
        } else {
            let client =
                CheckpointClient::new(self.config.clone(), node, self.source_node.clone())?;
            let ack = client.fresh_receipt(&self.manifest).await?;
            self.current_membership().await?;
            self.observe_peer(ack)?;
        }
        Ok(())
    }
    pub async fn finish(self) -> Result<CheckpointAvailabilityProposal> {
        // Shared service IO is NOT closed here: unrelated service calls retain
        // their lifecycle. This round has no detached job or unawaited success.
        self.current_membership().await?;
        if self.observations.len() < 2 || self.observations.len() > 3 {
            return Err(Error::Refused);
        }
        let claims = &self.manifest.source.claims;
        Ok(CheckpointAvailabilityProposal {
            schema_version: 1,
            scope: "uncommitted_checkpoint_availability_proposal",
            operation_id: self.operation_id,
            community_id: self.config.binding.community_id.clone(),
            partition_id: self.config.binding.partition_id.clone(),
            membership_log_id: self.membership_log_id,
            roster_digest: self.config.roster_digest(),
            manifest_sha256: self.manifest_sha256,
            source_context_sha256: self.source_context_sha256,
            source_archive_sha256: claims.archive_sha256.clone(),
            source_inventory_sha256: claims.inventory_sha256.clone(),
            applied_commit_seq: claims.applied_commit_seq,
            required_objects: self.manifest.objects.len(),
            required_bytes: claims.ciphertext_bytes,
            observations: self.observations.into_values().collect(),
            allocation: AllocationKnowledge::Unknown,
            committed: false,
            source_role_verified: false,
            payload_encryption_verified: false,
            inactive_replay_verified: false,
            quorum_available: false,
            full_instance_ready: false,
            canonical_writer_permitted: false,
        })
    }
}

#[cfg(test)]
mod tests;
