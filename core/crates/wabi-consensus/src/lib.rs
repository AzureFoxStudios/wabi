//! Experimental durable consensus foundation for explicitly trusted recovery
//! peers. A committed control record is not permission to run a Wabi writer;
//! canonical command/publication and encryption allocation integration is
//! required before recovery or regional authority can be activated.

#[cfg(target_os = "linux")]
pub mod availability_control;
#[cfg(target_os = "linux")]
pub mod material;
pub mod model;
#[cfg(target_os = "linux")]
pub mod runtime;
pub mod snapshot;
pub mod source_context;
pub mod store;
pub mod transport;
pub mod trust;

openraft::declare_raft_types!(
    pub ConsensusTypes:
        D = model::ControlData,
        R = model::ControlReply,
        NodeId = u64,
        Node = model::RecoveryPeer,
        SnapshotData = snapshot::BoundedSnapshot,
);

pub type Entry = openraft::Entry<ConsensusTypes>;
pub type Membership = openraft::StoredMembership<u64, model::RecoveryPeer>;
pub type LogId = openraft::LogId<u64>;
// Pinned public control-store integration types. Consumers of Store already
// use this trait and these entry/membership types; no writer API is added.
pub use openraft::{
    storage::RaftStateMachine, CommittedLeaderId, Config as RaftConfig, EntryPayload,
    Membership as VoterMembership, Raft, ServerState,
};
