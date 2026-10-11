use super::{Config, Error, Result};
use crate::{model::RecoveryPeer, ConsensusTypes};
use openraft::{
    error::{InstallSnapshotError, RPCError, RaftError, Unreachable},
    network::RPCOption,
    raft::{
        AppendEntriesRequest, AppendEntriesResponse, InstallSnapshotRequest,
        InstallSnapshotResponse, VoteRequest, VoteResponse,
    },
    EntryPayload, RaftNetwork, RaftNetworkFactory,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::net::TcpStream;

#[derive(Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "payload",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub(super) enum Request {
    Append(AppendEntriesRequest<ConsensusTypes>),
    Vote(VoteRequest<u64>),
    Snapshot(InstallSnapshotRequest<ConsensusTypes>),
    #[cfg(target_os = "linux")]
    Material(super::material::MaterialRequest),
}
#[derive(Debug, Serialize)]
#[serde(
    tag = "kind",
    content = "payload",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub(super) enum Response {
    Append(AppendEntriesResponse<u64>),
    Vote(VoteResponse<u64>),
    Snapshot(InstallSnapshotResponse<u64>),
    #[cfg(target_os = "linux")]
    Material(super::material::MaterialReply),
    Refused,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "kind",
    content = "payload",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub(super) enum RemoteResponse {
    Append(AppendEntriesResponse<u64>),
    Vote(VoteResponse<u64>),
    Snapshot(InstallSnapshotResponse<u64>),
    #[cfg(target_os = "linux")]
    Material(super::material::client::WireMaterialReply),
    Refused,
}

impl Config {
    pub(super) fn request_valid(&self, source: u64, target: u64, request: &Request) -> Result<()> {
        let vote = match request {
            #[cfg(target_os = "linux")]
            Request::Material(_) => {
                return if source != target
                    && self.peers.contains_key(&source)
                    && self.peers.contains_key(&target)
                {
                    Ok(())
                } else {
                    Err(Error::Authentication)
                };
            }
            Request::Append(rpc) => {
                if rpc.entries.len() > self.limits.max_append_entries {
                    return Err(Error::Budget);
                }
                for entry in &rpc.entries {
                    match &entry.payload {
                        EntryPayload::Blank => (),
                        EntryPayload::Normal(crate::model::ControlData::Legacy(command)) => {
                            if !command.valid()
                                || !self.peers.contains_key(&command.proposed_writer)
                            {
                                return Err(Error::Protocol);
                            }
                        }
                        #[cfg(target_os = "linux")]
                        EntryPayload::Normal(crate::model::ControlData::Checkpoint(command)) => {
                            if !command.valid() || !command.config_matches(self) {
                                return Err(Error::Protocol);
                            }
                        }
                        EntryPayload::Membership(membership) => {
                            // Membership changes require a separate reviewed
                            // majority enrollment protocol. This fixed-roster
                            // transport admits only the approved initial set.
                            if membership.get_joint_config().len() != 1
                                || membership.voter_ids().collect::<Vec<_>>()
                                    != self.peers.keys().copied().collect::<Vec<_>>()
                                || membership.nodes().count() != self.peers.len()
                                || membership
                                    .nodes()
                                    .any(|(id, peer)| self.peers.get(id) != Some(peer))
                            {
                                return Err(Error::Authentication);
                            }
                        }
                    }
                }
                rpc.vote
            }
            Request::Vote(rpc) => rpc.vote,
            Request::Snapshot(rpc) => {
                if rpc.data.len() > self.limits.max_snapshot_chunk
                    || rpc.meta.snapshot_id.len() > 128
                    || rpc
                        .offset
                        .checked_add(rpc.data.len() as u64)
                        .is_none_or(|end| end > 16 * 1024 * 1024)
                {
                    return Err(Error::Budget);
                }
                if rpc
                    .meta
                    .last_membership
                    .membership()
                    .get_joint_config()
                    .len()
                    != 1
                    || rpc
                        .meta
                        .last_membership
                        .membership()
                        .voter_ids()
                        .collect::<Vec<_>>()
                        != self.peers.keys().copied().collect::<Vec<_>>()
                    || rpc.meta.last_membership.membership().nodes().count() != self.peers.len()
                    || rpc
                        .meta
                        .last_membership
                        .membership()
                        .nodes()
                        .any(|(id, peer)| self.peers.get(id) != Some(peer))
                {
                    return Err(Error::Authentication);
                }
                rpc.vote
            }
        };
        if source == target
            || vote.leader_id.node_id != source
            || !self.peers.contains_key(&source)
            || !self.peers.contains_key(&target)
        {
            return Err(Error::Authentication);
        }
        Ok(())
    }
}

#[derive(Clone)]
pub struct Network {
    config: Arc<Config>,
}
impl Network {
    pub fn new(config: Arc<Config>, raft_config: &openraft::Config) -> Result<Self> {
        raft_config
            .clone()
            .validate()
            .map_err(|_| Error::Protocol)?;
        if raft_config.max_payload_entries > config.limits.max_append_entries as u64
            || raft_config.snapshot_max_chunk_size > config.limits.max_snapshot_chunk as u64
        {
            return Err(Error::Budget);
        }
        Ok(Self { config })
    }
}
pub struct Client {
    config: Arc<Config>,
    target: u64,
    approved: bool,
}
impl RaftNetworkFactory<ConsensusTypes> for Network {
    type Network = Client;
    async fn new_client(&mut self, target: u64, node: &RecoveryPeer) -> Client {
        Client {
            config: self.config.clone(),
            target,
            approved: self.config.peers.get(&target) == Some(node),
        }
    }
}
impl Client {
    async fn exchange(&self, request: Request, option: RPCOption) -> Result<RemoteResponse> {
        if !self.approved || self.target == self.config.node_id() {
            return Err(Error::Authentication);
        }
        self.config
            .request_valid(self.config.node_id(), self.target, &request)?;
        // All factories/clients for this node share the same budget. Refuse
        // overload before serialization or dialing; no unbounded waiter queue.
        // Caller cancellation drops the stream and releases this client slot.
        let _permit = self
            .config
            .outbound
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Budget)?;
        let bytes = serde_json::to_vec(&request).map_err(|_| Error::Protocol)?;
        if bytes.len() > self.config.limits.max_rpc_bytes {
            return Err(Error::Budget);
        }
        let ttl = option.hard_ttl().min(self.config.limits.rpc_deadline);
        let address = self.config.peers[&self.target]
            .rpc_address
            .parse::<std::net::SocketAddr>()
            .map_err(|_| Error::Authentication)?;
        tokio::time::timeout(ttl, async {
            let stream = TcpStream::connect(address).await.map_err(|_| Error::Io)?;
            stream.set_nodelay(true).map_err(|_| Error::Io)?;
            let mut channel = self.config.connect(stream, self.target).await?;
            channel.send(&bytes).await?;
            let reply = channel.receive().await?;
            serde_json::from_slice(&reply).map_err(|_| Error::Protocol)
        })
        .await
        .map_err(|_| Error::Deadline)?
    }
}
#[cfg(target_os = "linux")]
impl Config {
    pub(super) async fn exchange(
        self: &Arc<Self>,
        target: u64,
        request: Request,
    ) -> Result<RemoteResponse> {
        Client {
            config: self.clone(),
            target,
            approved: self.peers.contains_key(&target),
        }
        .exchange(request, RPCOption::new(self.limits.rpc_deadline))
        .await
    }
}
fn unavailable<E>(error: Error) -> RPCError<u64, RecoveryPeer, E>
where
    E: std::error::Error,
{
    RPCError::Unreachable(Unreachable::new(&error))
}
impl RaftNetwork<ConsensusTypes> for Client {
    async fn append_entries(
        &mut self,
        rpc: AppendEntriesRequest<ConsensusTypes>,
        option: RPCOption,
    ) -> std::result::Result<AppendEntriesResponse<u64>, RPCError<u64, RecoveryPeer, RaftError<u64>>>
    {
        match self
            .exchange(Request::Append(rpc), option)
            .await
            .map_err(unavailable)?
        {
            RemoteResponse::Append(result) => Ok(result),
            RemoteResponse::Refused => Err(unavailable(Error::Refused)),
            _ => Err(unavailable(Error::Protocol)),
        }
    }
    async fn vote(
        &mut self,
        rpc: VoteRequest<u64>,
        option: RPCOption,
    ) -> std::result::Result<VoteResponse<u64>, RPCError<u64, RecoveryPeer, RaftError<u64>>> {
        match self
            .exchange(Request::Vote(rpc), option)
            .await
            .map_err(unavailable)?
        {
            RemoteResponse::Vote(result) => Ok(result),
            RemoteResponse::Refused => Err(unavailable(Error::Refused)),
            _ => Err(unavailable(Error::Protocol)),
        }
    }
    async fn install_snapshot(
        &mut self,
        rpc: InstallSnapshotRequest<ConsensusTypes>,
        option: RPCOption,
    ) -> std::result::Result<
        InstallSnapshotResponse<u64>,
        RPCError<u64, RecoveryPeer, RaftError<u64, InstallSnapshotError>>,
    > {
        match self
            .exchange(Request::Snapshot(rpc), option)
            .await
            .map_err(unavailable)?
        {
            RemoteResponse::Snapshot(result) => Ok(result),
            RemoteResponse::Refused => Err(unavailable(Error::Refused)),
            _ => Err(unavailable(Error::Protocol)),
        }
    }
}
