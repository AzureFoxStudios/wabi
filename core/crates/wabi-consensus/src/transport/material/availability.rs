//! Fresh, fixed-roster observations and opt-in historical control submission.
//! Independent replay and activation remain separate. No serialized caller
//! receipt can enter this collector or grant current availability permission.
use super::{
    client::manifest_context, MaterialIo, MaterialReply, MaterialRequest, MaterialService,
};
use crate::{
    availability_control::{
        CheckpointObservationCommand, Observation, ObservationOrigin, ProposalWire,
    },
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

/// An immutable candidate for a subsequent durable consensus command. There
/// is deliberately no Deserialize, committed log ID or activation permission.
#[derive(Debug, Serialize)]
#[serde(transparent)]
pub struct CheckpointAvailabilityProposal(pub(crate) ProposalWire);
impl CheckpointAvailabilityProposal {
    pub fn operation_id(&self) -> &str {
        &self.0.operation_id
    }
    pub fn manifest_sha256(&self) -> &str {
        &self.0.manifest_sha256
    }
    pub fn observed_voters(&self) -> Vec<u64> {
        self.0
            .observations
            .iter()
            .map(|observation| observation.node_id)
            .collect()
    }
    pub fn sha256(&self) -> Result<String> {
        self.0.sha256().ok_or(Error::Protocol)
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
        if state.operations.contains_key(&operation_id)
            || state.checkpoints.contains_key(&operation_id)
        {
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
            || state.checkpoints.contains_key(&self.operation_id)
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
        Ok(CheckpointAvailabilityProposal(ProposalWire {
            schema_version: 1,
            scope: "uncommitted_checkpoint_availability_proposal".into(),
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
        }))
    }
}

/// Immutable historical metadata outcome. Loss of bytes after observation
/// invalidates any future readiness check; this receipt grants no serving or
/// writer permission. MaterialStore has no automatic byte garbage collection.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommittedCheckpointObservation {
    schema_version: u8,
    scope: &'static str,
    operation_id: String,
    manifest_sha256: String,
    command_fingerprint: String,
    committed_at: LogId,
    metadata_committed: bool,
    quorum_available: bool,
    full_instance_ready: bool,
    canonical_writer_permitted: bool,
}
impl CheckpointAvailabilityRound {
    /// Refresh live observations, then submit through the actual local Raft.
    /// A timeout is indeterminate: inspect the original operation ID before
    /// deciding whether to retry. Never manufacture a new ID for that retry.
    pub async fn commit_observation(
        self,
        raft: &openraft::Raft<crate::ConsensusTypes>,
    ) -> Result<CommittedCheckpointObservation> {
        tokio::time::timeout_at(self.deadline.into(), self.commit_inner(raft))
            .await
            .map_err(|_| Error::Deadline)?
    }
    async fn commit_inner(
        mut self,
        raft: &openraft::Raft<crate::ConsensusTypes>,
    ) -> Result<CommittedCheckpointObservation> {
        self.current_membership().await?;
        if raft.metrics().borrow().id != self.config.node_id() || self.observations.len() < 2 {
            return Err(Error::Authentication);
        }
        // The initial transition requires all enrolled code formats. Once an
        // accepted observation under this exact membership is durable, V2
        // replay is sticky and a healthy majority need not wait for the third
        // node. Actual Raft commit still determines participation/quorum.
        let state = self
            .control
            .control_state()
            .await
            .map_err(|_| Error::Refused)?;
        let transitioned = state.checkpoints.values().any(|record| {
            record.reply.outcome == crate::model::Outcome::Accepted
                && record.command.config_matches(&self.config)
                && record.command.membership_log_id() == self.membership_log_id
        });
        for node in self.config.peers.keys().copied().collect::<Vec<_>>() {
            if node != self.config.node_id()
                && (!transitioned || self.observations.contains_key(&node))
            {
                CheckpointClient::new(self.config.clone(), node, self.source_node.clone())?
                    .require_control_v2()
                    .await?;
                self.current_membership().await?;
            }
        }
        for node in self.observations.keys().copied().collect::<Vec<_>>() {
            self.refresh(node).await?;
        }
        let config = self.config.clone();
        let control = self.control.clone();
        let deadline = self.deadline;
        let manifest = self.manifest.clone();
        let proposal = self.finish().await?;
        let command = CheckpointObservationCommand::collected(
            config.node_id(),
            config.peers.clone(),
            proposal.0,
            manifest,
        )
        .ok_or(Error::Protocol)?;
        let fingerprint = command.fingerprint().ok_or(Error::Protocol)?;
        if Instant::now() >= deadline {
            return Err(Error::Deadline);
        }
        let response = tokio::time::timeout_at(
            deadline.into(),
            raft.client_write(crate::model::ControlData::Checkpoint(command.clone())),
        )
        .await
        .map_err(|_| Error::Deadline)?
        .map_err(|_| Error::Refused)?;
        if response.data.outcome != crate::model::Outcome::Accepted
            || response.data.committed_at != Some(response.log_id)
            || response.data.canonical_writer_permitted
        {
            return Err(Error::Refused);
        }
        let state = control.control_state().await.map_err(|_| Error::Refused)?;
        if Instant::now() >= deadline {
            return Err(Error::Deadline);
        }
        // A same-ID Raft attached to another store cannot produce success.
        let record = state
            .checkpoints
            .get(command.operation_id())
            .ok_or(Error::Refused)?;
        if record.command != command || record.reply != response.data {
            return Err(Error::Refused);
        }
        Ok(CommittedCheckpointObservation {
            schema_version: 2,
            scope: "committed_historical_checkpoint_observation",
            operation_id: command.operation_id().into(),
            manifest_sha256: command.manifest_sha256().into(),
            command_fingerprint: fingerprint,
            committed_at: response.log_id,
            metadata_committed: true,
            quorum_available: false,
            full_instance_ready: false,
            canonical_writer_permitted: false,
        })
    }
}

#[cfg(test)]
mod tests;
