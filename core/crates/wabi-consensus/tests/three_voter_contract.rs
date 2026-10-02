//! Actual OpenRaft nodes and durable stores with a controllable in-process
//! transport. This does not validate an authenticated physical network or Wabi
//! canonical writers, sidecar publication, encryption or client reconnection.
use openraft::{
    error::{ClientWriteError, InstallSnapshotError, RPCError, RaftError, RemoteError, Unreachable},
    network::RPCOption,
    raft::{
        AppendEntriesRequest, AppendEntriesResponse, InstallSnapshotRequest,
        InstallSnapshotResponse, VoteRequest, VoteResponse,
    },
    Raft, RaftNetwork, RaftNetworkFactory,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
    time::Duration,
};
use tokio::sync::RwLock;
use wabi_consensus::{
    model::*,
    store::{Store, StoreLimits},
    ConsensusTypes,
};

type Node = Raft<ConsensusTypes>;
#[derive(Default)]
struct Links {
    nodes: BTreeMap<u64, Node>,
    cuts: BTreeSet<(u64, u64)>,
}
#[derive(Clone)]
struct Network {
    from: u64,
    shared: Arc<RwLock<Links>>,
}
struct Client {
    from: u64,
    target: u64,
    shared: Arc<RwLock<Links>>,
}
impl RaftNetworkFactory<ConsensusTypes> for Network {
    type Network = Client;
    async fn new_client(&mut self, target: u64, _node: &RecoveryPeer) -> Client {
        Client {
            from: self.from,
            target,
            shared: self.shared.clone(),
        }
    }
}
impl Client {
    async fn peer(&self) -> Option<Node> {
        let network = self.shared.read().await;
        if network.cuts.contains(&(self.from, self.target)) {
            None
        } else {
            network.nodes.get(&self.target).cloned()
        }
    }
}
impl RaftNetwork<ConsensusTypes> for Client {
    async fn append_entries(
        &mut self,
        rpc: AppendEntriesRequest<ConsensusTypes>,
        _option: RPCOption,
    ) -> Result<AppendEntriesResponse<u64>, RPCError<u64, RecoveryPeer, RaftError<u64>>> {
        let Some(peer) = self.peer().await else {
            return Err(RPCError::Unreachable(Unreachable::new(
                &std::io::Error::other("test link unavailable"),
            )));
        };
        peer.append_entries(rpc)
            .await
            .map_err(|error| RPCError::RemoteError(RemoteError::new(self.target, error)))
    }
    async fn install_snapshot(
        &mut self,
        rpc: InstallSnapshotRequest<ConsensusTypes>,
        _option: RPCOption,
    ) -> Result<
        InstallSnapshotResponse<u64>,
        RPCError<u64, RecoveryPeer, RaftError<u64, InstallSnapshotError>>,
    > {
        let Some(peer) = self.peer().await else {
            return Err(RPCError::Unreachable(Unreachable::new(
                &std::io::Error::other("test link unavailable"),
            )));
        };
        peer.install_snapshot(rpc)
            .await
            .map_err(|error| RPCError::RemoteError(RemoteError::new(self.target, error)))
    }
    async fn vote(
        &mut self,
        rpc: VoteRequest<u64>,
        _option: RPCOption,
    ) -> Result<VoteResponse<u64>, RPCError<u64, RecoveryPeer, RaftError<u64>>> {
        let Some(peer) = self.peer().await else {
            return Err(RPCError::Unreachable(Unreachable::new(
                &std::io::Error::other("test link unavailable"),
            )));
        };
        peer.vote(rpc)
            .await
            .map_err(|error| RPCError::RemoteError(RemoteError::new(self.target, error)))
    }
}
fn binding(id: u64) -> StoreBinding {
    StoreBinding {
        community_id: "ab".repeat(32),
        partition_id: "community/control".into(),
        node_id: id,
    }
}
fn peers() -> BTreeMap<u64, RecoveryPeer> {
    (1..=3)
        .map(|id| {
            (
                id,
                RecoveryPeer {
                    protocol: CONTROL_PROTOCOL,
                    community_id: binding(id).community_id,
                    site_id: format!("site-{id}"),
                    public_key: format!("{id:064x}"),
                    rpc_address: format!("127.0.0.1:{}", 12000 + id),
                },
            )
        })
        .collect()
}
fn command(id: u64, epoch: u64, writer: u64) -> ControlCommand {
    ControlCommand {
        operation_id: format!("{id:032x}"),
        partition_id: "room:fixture".into(),
        expected_epoch: epoch,
        proposed_writer: writer,
        checkpoint_inventory_sha256: "cd".repeat(32),
    }
}
struct Cluster {
    root: tempfile::TempDir,
    shared: Arc<RwLock<Links>>,
    stores: BTreeMap<u64, Store>,
    nodes: BTreeMap<u64, Node>,
}
impl Cluster {
    async fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let shared = Arc::new(RwLock::new(Links::default()));
        let mut cluster = Self {
            root,
            shared,
            stores: BTreeMap::new(),
            nodes: BTreeMap::new(),
        };
        for id in 1..=3 {
            let path = cluster.root.path().join(format!("node-{id}"));
            std::fs::create_dir(&path).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
            }
            cluster.start(id).await;
        }
        cluster.nodes[&1].initialize(peers()).await.unwrap();
        cluster
    }
    async fn start(&mut self, id: u64) {
        wabi_consensus::trust::validate_three_voter_roster(&binding(id), &peers()).unwrap();
        let store = Store::open(
            &self.root.path().join(format!("node-{id}")),
            binding(id),
            StoreLimits::default(),
        )
        .unwrap();
        let config = openraft::Config {
            cluster_name: "wabi-consensus-contract".into(),
            heartbeat_interval: 50,
            election_timeout_min: 150,
            election_timeout_max: 300,
            snapshot_policy: openraft::SnapshotPolicy::LogsSinceLast(10),
            snapshot_max_chunk_size: 64 * 1024,
            max_in_snapshot_log_to_keep: 0,
            purge_batch_size: 1,
            ..Default::default()
        }
        .validate()
        .unwrap();
        let raft = Raft::new(
            id,
            Arc::new(config),
            Network {
                from: id,
                shared: self.shared.clone(),
            },
            store.clone(),
            store.clone(),
        )
        .await
        .unwrap();
        self.shared.write().await.nodes.insert(id, raft.clone());
        self.nodes.insert(id, raft);
        self.stores.insert(id, store);
    }
    async fn stop(&mut self, id: u64) {
        self.shared.write().await.nodes.remove(&id);
        if let Some(node) = self.nodes.remove(&id) {
            node.shutdown().await.unwrap();
            drop(node);
        }
        self.stores.remove(&id);
    }
    async fn leader(&self, eligible: &[u64]) -> u64 {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                for id in eligible {
                    if self.nodes.get(id).is_some_and(|node| {
                        node.metrics().borrow().state == openraft::ServerState::Leader
                    }) {
                        return *id;
                    }
                }
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
        })
        .await
        .expect("durable consensus leader deadline")
    }
    async fn wait_epoch(&self, ids: &[u64], epoch: u64) {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let mut match_all = true;
                for id in ids {
                    let state = self.stores[id].control_state().await.unwrap();
                    match_all &= state
                        .intents
                        .get("room:fixture")
                        .is_some_and(|value| value.epoch == epoch);
                }
                if match_all {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
        })
        .await
        .expect("durable consensus application deadline");
    }
    async fn write(&self, leader: u64, command: ControlCommand) -> ControlReply {
        tokio::time::timeout(Duration::from_secs(5), async {
            let mut target = leader;
            loop {
                match self.nodes[&target].client_write(command.clone()).await {
                    Ok(response) => return response.data,
                    Err(RaftError::APIError(ClientWriteError::ForwardToLeader(forward))) => {
                        tokio::time::sleep(Duration::from_millis(30)).await;
                        let links = self.shared.read().await;
                        let eligible = |id: &u64| {
                            self.nodes.contains_key(id)
                                && !links.cuts.contains(&(leader, *id))
                                && !links.cuts.contains(&(*id, leader))
                        };
                        target = forward
                            .leader_id
                            .filter(eligible)
                            .or_else(|| {
                                self.nodes.iter().find_map(|(id, node)| {
                                    (eligible(id)
                                        && node.metrics().borrow().state
                                            == openraft::ServerState::Leader)
                                        .then_some(*id)
                                })
                            })
                            .unwrap_or(target);
                    }
                    Err(error) => panic!("durable consensus proposal failed: {error:?}"),
                }
            }
        })
        .await
        .expect("durable consensus proposal deadline")
    }
    async fn finish(&mut self) {
        for id in [1, 2, 3] {
            self.stop(id).await;
        }
        assert!(self.shared.read().await.nodes.is_empty());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn three_durable_voters_survive_each_node_loss_full_restart_and_duplicate_retry() {
    let mut cluster = Cluster::new().await;
    let mut epoch = 0;
    let leader = cluster.leader(&[1, 2, 3]).await;
    let first = cluster.write(leader, command(1, 0, leader)).await;
    assert_eq!(first.outcome, Outcome::Accepted);
    assert!(!first.canonical_writer_permitted);
    epoch += 1;
    cluster.wait_epoch(&[1, 2, 3], epoch).await;
    for lost in [1, 2, 3] {
        cluster.stop(lost).await;
        let remaining: Vec<_> = (1..=3).filter(|id| *id != lost).collect();
        let leader = cluster.leader(&remaining).await;
        let reply = cluster
            .write(leader, command(10 + lost, epoch, leader))
            .await;
        assert_eq!(reply.outcome, Outcome::Accepted);
        epoch += 1;
        cluster.wait_epoch(&remaining, epoch).await;
        cluster.start(lost).await;
        cluster.wait_epoch(&[1, 2, 3], epoch).await;
    }
    for id in [1, 2, 3] {
        cluster.stop(id).await;
    }
    for id in [1, 2, 3] {
        cluster.start(id).await;
    }
    let leader = cluster.leader(&[1, 2, 3]).await;
    cluster.wait_epoch(&[1, 2, 3], epoch).await;
    let retry = cluster
        .write(
            leader,
            command(1, 0, first.committed_at.unwrap().leader_id.node_id),
        )
        .await;
    assert_eq!(retry, first);
    cluster.wait_epoch(&[1, 2, 3], epoch).await;
    cluster.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn one_versus_two_partition_prevents_minority_ack_and_rejoins_without_divergent_intent() {
    let mut cluster = Cluster::new().await;
    let old = cluster.leader(&[1, 2, 3]).await;
    assert_eq!(
        cluster.write(old, command(1, 0, old)).await.outcome,
        Outcome::Accepted
    );
    cluster.wait_epoch(&[1, 2, 3], 1).await;
    let majority: Vec<_> = (1..=3).filter(|id| *id != old).collect();
    {
        let mut links = cluster.shared.write().await;
        for id in &majority {
            links.cuts.insert((old, *id));
            links.cuts.insert((*id, old));
        }
    }
    let new = cluster.leader(&majority).await;
    let minority = tokio::time::timeout(
        Duration::from_millis(500),
        cluster.nodes[&old].client_write(command(99, 1, old)),
    )
    .await;
    assert!(
        !matches!(minority, Ok(Ok(_))),
        "isolated voter acknowledged a quorum write"
    );
    assert_eq!(
        cluster.write(new, command(2, 1, new)).await.outcome,
        Outcome::Accepted
    );
    cluster.wait_epoch(&majority, 2).await;
    assert_eq!(
        cluster.stores[&old].control_state().await.unwrap().intents["room:fixture"].epoch,
        1
    );
    cluster.shared.write().await.cuts.clear();
    cluster.wait_epoch(&[1, 2, 3], 2).await;
    for store in cluster.stores.values() {
        assert!(!store
            .control_state()
            .await
            .unwrap()
            .operations
            .contains_key(&format!("{:032x}", 99)));
    }
    cluster.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn offline_voter_catches_up_through_durable_snapshot_after_log_purge() {
    use openraft::storage::RaftStateMachine;
    let mut cluster = Cluster::new().await;
    let leader = cluster.leader(&[1, 2, 3]).await;
    let missing = (1..=3).find(|id| *id != leader).unwrap();
    assert_eq!(
        cluster.write(leader, command(1, 0, leader)).await.outcome,
        Outcome::Accepted
    );
    cluster.wait_epoch(&[1, 2, 3], 1).await;
    cluster.stop(missing).await;
    let majority: Vec<_> = (1..=3).filter(|id| *id != missing).collect();
    for epoch in 1..=30 {
        let leader = cluster.leader(&majority).await;
        let reply = cluster
            .write(leader, command(100 + epoch, epoch, leader))
            .await;
        assert_eq!(reply.outcome, Outcome::Accepted);
        assert_eq!(reply.epoch, epoch + 1);
    }
    cluster.wait_epoch(&majority, 31).await;
    // Ensure the follower's former prefix is actually unavailable from log IO,
    // requiring the receiver's real snapshot-install path rather than replay.
    tokio::time::timeout(Duration::from_secs(10), async {
        use openraft::storage::RaftLogStorage;
        loop {
            let leader = cluster.leader(&majority).await;
            let mut store = cluster.stores[&leader].clone();
            if store
                .get_log_state()
                .await
                .unwrap()
                .last_purged_log_id
                .is_some_and(|log| log.index > 4)
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .expect("actual log-purge deadline");
    cluster.start(missing).await;
    cluster.wait_epoch(&[1, 2, 3], 31).await;
    let mut recovered = cluster.stores[&missing].clone();
    assert!(recovered.get_current_snapshot().await.unwrap().is_some());
    let state = recovered.control_state().await.unwrap();
    assert_eq!(state.operations.len(), 31);
    assert!(state
        .operations
        .values()
        .all(|operation| !operation.reply.canonical_writer_permitted));
    drop(recovered);
    cluster.stop(missing).await;
    cluster.start(missing).await;
    cluster.wait_epoch(&[1, 2, 3], 31).await;
    cluster.finish().await;
}
