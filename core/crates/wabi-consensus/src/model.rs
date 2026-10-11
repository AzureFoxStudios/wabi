//! Versioned control metadata. No member content, secret key or writer permit.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const CONTROL_SCHEMA: u8 = 1;
pub const CONTROL_PROTOCOL: u16 = 1;

#[derive(Clone, Default, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryPeer {
    pub protocol: u16,
    pub community_id: String,
    pub site_id: String,
    pub public_key: String,
    pub rpc_address: String,
}

pub fn digest_valid(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|c| c.is_ascii_hexdigit())
}
pub fn identifier_valid(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-:/".contains(&c))
}

impl RecoveryPeer {
    /// Bootstrap enrollment is an operator-reviewed recovery roster, never the
    /// existing helper registry. Network endpoint/key authentication follows
    /// the same binding; this validation alone does not establish a connection.
    pub fn valid_for(&self, community: &str) -> bool {
        self.protocol == CONTROL_PROTOCOL
            && self.community_id == community
            && digest_valid(community)
            && identifier_valid(&self.site_id)
            && digest_valid(&self.public_key)
            && self
                .rpc_address
                .parse::<std::net::SocketAddr>()
                .is_ok_and(|address| {
                    address.port() != 0
                        && !address.ip().is_unspecified()
                        && !address.ip().is_multicast()
                        && !matches!(address.ip(), std::net::IpAddr::V4(ip) if ip.is_broadcast())
                })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoreBinding {
    pub community_id: String,
    pub partition_id: String,
    pub node_id: u64,
}
impl StoreBinding {
    pub fn valid(&self) -> bool {
        digest_valid(&self.community_id)
            && identifier_valid(&self.partition_id)
            && self.node_id != 0
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlCommand {
    pub operation_id: String,
    pub partition_id: String,
    pub expected_epoch: u64,
    pub proposed_writer: u64,
    /// Authenticated source inventory fingerprint; it is not a readiness
    /// certificate and does not activate an engine or grant a writer key.
    pub checkpoint_inventory_sha256: String,
}
impl ControlCommand {
    pub fn valid(&self) -> bool {
        self.operation_id.len() == 32
            && self.operation_id.bytes().all(|c| c.is_ascii_hexdigit())
            && identifier_valid(&self.partition_id)
            && self.proposed_writer != 0
            && digest_valid(&self.checkpoint_inventory_sha256)
            && self.expected_epoch != u64::MAX
    }
}

/// Legacy commands retain their exact flat JSON. The separate strict V2
/// branch cannot decode as an old inventory-only ownership request.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ControlData {
    Legacy(ControlCommand),
    #[cfg(target_os = "linux")]
    Checkpoint(crate::availability_control::CheckpointObservationCommand),
}
impl From<ControlCommand> for ControlData {
    fn from(command: ControlCommand) -> Self {
        Self::Legacy(command)
    }
}
impl ControlData {
    pub(crate) fn schema(&self) -> u8 {
        match self {
            Self::Legacy(_) => 1,
            #[cfg(target_os = "linux")]
            Self::Checkpoint(_) => 2,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Accepted,
    Conflict,
    Refused,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlReply {
    pub outcome: Outcome,
    pub epoch: u64,
    pub committed_at: Option<crate::LogId>,
    pub canonical_writer_permitted: bool,
}
impl Default for ControlReply {
    fn default() -> Self {
        Self {
            outcome: Outcome::Refused,
            epoch: 0,
            committed_at: None,
            canonical_writer_permitted: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnershipIntent {
    pub epoch: u64,
    pub proposed_writer: u64,
    pub checkpoint_inventory_sha256: String,
    pub committed_at: crate::LogId,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationReceipt {
    pub command: ControlCommand,
    pub reply: ControlReply,
}

#[derive(Clone, Default, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlState {
    pub last_applied: Option<crate::LogId>,
    pub membership: crate::Membership,
    pub intents: BTreeMap<String, OwnershipIntent>,
    pub operations: BTreeMap<String, OperationReceipt>,
    #[cfg(target_os = "linux")]
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub checkpoints: BTreeMap<String, crate::availability_control::CheckpointOperationReceipt>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StateEnvelope {
    pub schema_version: u8,
    pub community_id: String,
    pub partition_id: String,
    pub state: ControlState,
}

impl ControlState {
    /// Check deterministic receipt/intent relationships after decoding a local
    /// state record or receiving a snapshot. A matching digest authenticates
    /// bytes, but cannot make an internally inconsistent state safe to install.
    pub(crate) fn coherent(&self) -> bool {
        let covered = |position: crate::LogId| {
            self.last_applied
                .is_some_and(|last| position.index <= last.index && position <= last)
        };
        if self
            .membership
            .log_id()
            .is_some_and(|position| !covered(position))
        {
            return false;
        }
        let mut accepted: BTreeMap<&str, BTreeMap<u64, &OperationReceipt>> = BTreeMap::new();
        for receipt in self.operations.values() {
            let Some(position) = receipt.reply.committed_at else {
                return false;
            };
            if !covered(position) || receipt.reply.canonical_writer_permitted {
                return false;
            }
            if receipt.reply.outcome == Outcome::Accepted {
                if receipt.command.expected_epoch.checked_add(1) != Some(receipt.reply.epoch)
                    || accepted
                        .entry(&receipt.command.partition_id)
                        .or_default()
                        .insert(receipt.reply.epoch, receipt)
                        .is_some()
                {
                    return false;
                }
            }
        }
        if accepted.len() != self.intents.len() {
            return false;
        }
        for (partition, intent) in &self.intents {
            let Some(history) = accepted.get(partition.as_str()) else {
                return false;
            };
            if history.len() as u64 != intent.epoch || !covered(intent.committed_at) {
                return false;
            }
            let mut previous: Option<crate::LogId> = None;
            for (expected, (epoch, receipt)) in (1u64..).zip(history) {
                let position = receipt.reply.committed_at.unwrap();
                if expected != *epoch
                    || previous.is_some_and(|old| position.index <= old.index || position <= old)
                {
                    return false;
                }
                previous = Some(position);
            }
            let last = history.last_key_value().unwrap().1;
            if last.command.proposed_writer != intent.proposed_writer
                || last.command.checkpoint_inventory_sha256 != intent.checkpoint_inventory_sha256
                || last.reply.committed_at != Some(intent.committed_at)
            {
                return false;
            }
        }
        true
    }

    pub(crate) fn apply_command(
        &mut self,
        command: ControlCommand,
        log: crate::LogId,
        community: &str,
        max_operations: usize,
        max_partitions: usize,
    ) -> ControlReply {
        let epoch = self
            .intents
            .get(&command.partition_id)
            .map_or(0, |record| record.epoch);
        let refused = ControlReply {
            epoch,
            ..Default::default()
        };
        if !command.valid() {
            return refused;
        }
        #[cfg(target_os = "linux")]
        if self.checkpoints.contains_key(&command.operation_id) {
            return refused;
        }
        if let Some(prior) = self.operations.get(&command.operation_id) {
            return if prior.command == command {
                prior.reply.clone()
            } else {
                refused
            };
        }
        let used = self.operations.len();
        #[cfg(target_os = "linux")]
        let used = used.saturating_add(self.checkpoints.len());
        if used >= max_operations {
            return refused;
        }
        let membership = self.membership.membership();
        let eligible = membership
            .voter_ids()
            .any(|id| id == command.proposed_writer)
            && membership
                .get_node(&command.proposed_writer)
                .is_some_and(|peer| peer.valid_for(community));
        let outcome = if !eligible || (epoch == 0 && self.intents.len() >= max_partitions) {
            Outcome::Refused
        } else if command.expected_epoch != epoch {
            Outcome::Conflict
        } else {
            Outcome::Accepted
        };
        let result_epoch = if outcome == Outcome::Accepted {
            epoch + 1
        } else {
            epoch
        };
        if outcome == Outcome::Accepted {
            self.intents.insert(
                command.partition_id.clone(),
                OwnershipIntent {
                    epoch: result_epoch,
                    proposed_writer: command.proposed_writer,
                    checkpoint_inventory_sha256: command.checkpoint_inventory_sha256.clone(),
                    committed_at: log,
                },
            );
        }
        let reply = ControlReply {
            outcome,
            epoch: result_epoch,
            committed_at: Some(log),
            canonical_writer_permitted: false,
        };
        self.operations.insert(
            command.operation_id.clone(),
            OperationReceipt {
                command,
                reply: reply.clone(),
            },
        );
        reply
    }
}
