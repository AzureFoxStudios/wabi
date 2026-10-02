//! Real TCP and Noise with actual disk-backed Raft nodes. Proxies cut only
//! owned fixture connections; no firewall/interface or production service is
//! changed. This is local network evidence, not three physical uplinks.
use openraft::{Raft, ServerState};
use std::{
    collections::{BTreeMap, BTreeSet},
    net::SocketAddr,
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpSocket, TcpStream},
    sync::{oneshot, RwLock},
    task::{JoinHandle, JoinSet},
};
use wabi_consensus::{
    model::*,
    store::{Store, StoreError, StoreLimits},
    transport::{self, Config, Identity, Limits, Network, ServerReport},
    ConsensusTypes,
};

type Node = Raft<ConsensusTypes>;
type Cuts = Arc<RwLock<BTreeSet<(u64, u64)>>>;
struct Proxy {
    stop: oneshot::Sender<()>,
    task: JoinHandle<()>,
}
impl Proxy {
    fn start(listener: TcpListener, target: u64, upstream: SocketAddr, cuts: Cuts) -> Self {
        let (stop, mut stopped) = oneshot::channel();
        let task = tokio::spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    _ = &mut stopped => break,
                    _ = connections.join_next(), if !connections.is_empty() => (),
                    connection = listener.accept() => {
                        let (mut client, _) = connection.unwrap();
                        let cuts = cuts.clone();
                        if connections.len() >= 32 { drop(client); continue; }
                        connections.spawn(async move {
                            let _ = tokio::time::timeout(Duration::from_secs(5), async {
                                let mut hello = [0; 118];
                                client.read_exact(&mut hello).await?;
                                let source = u64::from_be_bytes(hello[6..14].try_into().unwrap());
                                if cuts.read().await.contains(&(source, target)) { return Ok::<(), std::io::Error>(()); }
                                let mut server = TcpStream::connect(upstream).await?;
                                server.write_all(&hello).await?;
                                tokio::io::copy_bidirectional(&mut client, &mut server).await?;
                                Ok(())
                            }).await;
                        });
                    }
                }
            }
            drop(listener);
            connections.abort_all();
            while connections.join_next().await.is_some() {}
        });
        Self { stop, task }
    }
    async fn finish(self) {
        let _ = self.stop.send(());
        self.task.await.unwrap();
    }
}
struct Server {
    stop: oneshot::Sender<()>,
    task: JoinHandle<transport::Result<ServerReport>>,
}
struct Cluster {
    root: tempfile::TempDir,
    nodes: BTreeMap<u64, Node>,
    stores: BTreeMap<u64, Store>,
    configs: BTreeMap<u64, Arc<Config>>,
    servers: BTreeMap<u64, Server>,
    proxies: Vec<Proxy>,
    peers: BTreeMap<u64, RecoveryPeer>,
    cuts: Cuts,
    reports: Vec<ServerReport>,
}
fn binding(node_id: u64) -> StoreBinding {
    StoreBinding {
        community_id: "ab".repeat(32),
        partition_id: "community/control".into(),
        node_id,
    }
}
fn raft_config() -> openraft::Config {
    openraft::Config {
        cluster_name: "wabi-encrypted-tcp-contract".into(),
        heartbeat_interval: 100,
        election_timeout_min: 400,
        election_timeout_max: 800,
        max_payload_entries: 64,
        snapshot_max_chunk_size: 64 * 1024,
        install_snapshot_timeout: 2000,
        send_snapshot_timeout: 2000,
        snapshot_policy: openraft::SnapshotPolicy::LogsSinceLast(10),
        max_in_snapshot_log_to_keep: 0,
        purge_batch_size: 1,
        ..Default::default()
    }
    .validate()
    .unwrap()
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
fn listen(address: SocketAddr) -> TcpListener {
    let socket = TcpSocket::new_v4().unwrap();
    socket.set_reuseaddr(true).unwrap();
    socket.bind(address).unwrap();
    socket.listen(128).unwrap()
}
impl Cluster {
    async fn new() -> Self {
        let root = tempfile::Builder::new()
            .prefix("wabi-consensus-tcp-")
            .tempdir()
            .unwrap();
        let cuts = Arc::new(RwLock::new(BTreeSet::new()));
        let mut advertised = BTreeMap::new();
        let mut listeners = BTreeMap::new();
        let mut identities = BTreeMap::new();
        let mut peers = BTreeMap::new();
        for id in 1..=3 {
            let proxy = listen("127.0.0.1:0".parse().unwrap());
            let backend = listen("127.0.0.1:0".parse().unwrap());
            let identity = Arc::new(Identity::generate().unwrap());
            peers.insert(
                id,
                RecoveryPeer {
                    protocol: CONTROL_PROTOCOL,
                    community_id: binding(id).community_id,
                    site_id: format!("fixture-site-{id}"),
                    public_key: identity.public_hex(),
                    rpc_address: proxy.local_addr().unwrap().to_string(),
                },
            );
            advertised.insert(id, proxy);
            listeners.insert(id, backend);
            identities.insert(id, identity);
            let path = root.path().join(format!("node-{id}"));
            std::fs::create_dir(&path).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
            }
        }
        let mut cluster = Self {
            root,
            nodes: BTreeMap::new(),
            stores: BTreeMap::new(),
            configs: BTreeMap::new(),
            servers: BTreeMap::new(),
            proxies: Vec::new(),
            peers,
            cuts,
            reports: Vec::new(),
        };
        for id in 1..=3 {
            let listener = listeners.remove(&id).unwrap();
            let backend = listener.local_addr().unwrap();
            let config = Arc::new(
                Config::new(
                    binding(id),
                    cluster.peers.clone(),
                    identities.remove(&id).unwrap(),
                    Limits::default(),
                )
                .unwrap()
                .with_bind_address(backend)
                .unwrap(),
            );
            cluster.configs.insert(id, config);
            cluster.proxies.push(Proxy::start(
                advertised.remove(&id).unwrap(),
                id,
                backend,
                cluster.cuts.clone(),
            ));
            cluster.start_with_listener(id, listener).await;
        }
        cluster.nodes[&1]
            .initialize(cluster.peers.clone())
            .await
            .unwrap();
        cluster
    }
    async fn start_with_listener(&mut self, id: u64, listener: TcpListener) {
        let root = self.root.path().join(format!("node-{id}"));
        let store = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                match Store::open(&root, binding(id), StoreLimits::default()) {
                    Ok(store) => break store,
                    Err(StoreError::Ownership) => {
                        tokio::time::sleep(Duration::from_millis(10)).await
                    }
                    Err(error) => panic!("store reopen failed: {error}"),
                }
            }
        })
        .await
        .unwrap();
        let options = Arc::new(raft_config());
        let config = self.configs[&id].clone();
        let raft = Raft::new(
            id,
            options.clone(),
            Network::new(config.clone(), &options).unwrap(),
            store.clone(),
            store.clone(),
        )
        .await
        .unwrap();
        let (stop, stopped) = oneshot::channel();
        let actor = raft.clone();
        let task =
            tokio::spawn(async move { transport::serve(listener, actor, config, stopped).await });
        self.servers.insert(id, Server { stop, task });
        self.nodes.insert(id, raft);
        self.stores.insert(id, store);
    }
    async fn start(&mut self, id: u64) {
        self.start_with_listener(id, listen(self.configs[&id].local_address()))
            .await;
    }
    async fn stop(&mut self, id: u64) {
        if let Some(server) = self.servers.remove(&id) {
            let _ = server.stop.send(());
            self.reports.push(
                tokio::time::timeout(Duration::from_secs(5), server.task)
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap(),
            );
        }
        if let Some(node) = self.nodes.remove(&id) {
            node.shutdown().await.unwrap();
        }
        self.stores.remove(&id);
    }
    async fn leader(&self, ids: &[u64]) -> u64 {
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                for id in ids {
                    if self.nodes[id].metrics().borrow().state == ServerState::Leader {
                        return *id;
                    }
                }
                tokio::time::sleep(Duration::from_millis(40)).await;
            }
        })
        .await
        .expect("TCP leader deadline")
    }
    async fn wait_epoch(&self, ids: &[u64], epoch: u64) {
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let mut ready = true;
                for id in ids {
                    ready &= self.stores[id]
                        .control_state()
                        .await
                        .unwrap()
                        .intents
                        .get("room:fixture")
                        .is_some_and(|intent| intent.epoch == epoch);
                }
                if ready {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(40)).await;
            }
        })
        .await
        .expect("TCP applied-state deadline");
    }
    async fn write(&self, leader: u64, request: ControlCommand) -> ControlReply {
        tokio::time::timeout(
            Duration::from_secs(5),
            self.nodes[&leader].client_write(request.into()),
        )
        .await
        .unwrap()
        .unwrap()
        .data
    }
    async fn finish(&mut self) {
        for id in [1, 2, 3] {
            self.stop(id).await;
        }
        for proxy in std::mem::take(&mut self.proxies) {
            proxy.finish().await;
        }
        assert!(self.nodes.is_empty() && self.stores.is_empty() && self.servers.is_empty());
        assert!(
            self.reports
                .iter()
                .map(|report| report.authenticated_rpcs)
                .sum::<u64>()
                > 0
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn encrypted_tcp_voters_recover_each_node_and_retain_idempotency_after_full_restart() {
    let mut cluster = Cluster::new().await;
    let leader = cluster.leader(&[1, 2, 3]).await;
    let original = command(1, 0, leader);
    let result = cluster.write(leader, original.clone()).await;
    assert_eq!(result.outcome, Outcome::Accepted);
    assert!(!result.canonical_writer_permitted);
    cluster.wait_epoch(&[1, 2, 3], 1).await;
    let mut epoch = 1;
    for lost in [1, 2, 3] {
        cluster.stop(lost).await;
        let remaining: Vec<_> = (1..=3).filter(|id| *id != lost).collect();
        let leader = cluster.leader(&remaining).await;
        assert_eq!(
            cluster
                .write(leader, command(10 + lost, epoch, leader))
                .await
                .outcome,
            Outcome::Accepted
        );
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
    assert_eq!(cluster.write(leader, original).await, result);
    cluster.wait_epoch(&[1, 2, 3], epoch).await;
    cluster.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn encrypted_tcp_partition_cannot_ack_minority_and_heals_without_divergent_receipt() {
    let mut cluster = Cluster::new().await;
    let old = cluster.leader(&[1, 2, 3]).await;
    assert_eq!(
        cluster.write(old, command(1, 0, old)).await.outcome,
        Outcome::Accepted
    );
    cluster.wait_epoch(&[1, 2, 3], 1).await;
    let majority: Vec<_> = (1..=3).filter(|id| *id != old).collect();
    {
        let mut cuts = cluster.cuts.write().await;
        for id in &majority {
            cuts.insert((old, *id));
            cuts.insert((*id, old));
        }
    }
    let new = cluster.leader(&majority).await;
    let rejected = tokio::time::timeout(
        Duration::from_millis(700),
        cluster.nodes[&old].client_write(command(99, 1, old).into()),
    )
    .await;
    assert!(!matches!(rejected, Ok(Ok(_))));
    assert_eq!(
        cluster.write(new, command(2, 1, new)).await.outcome,
        Outcome::Accepted
    );
    cluster.wait_epoch(&majority, 2).await;
    assert_eq!(
        cluster.stores[&old].control_state().await.unwrap().intents["room:fixture"].epoch,
        1
    );
    cluster.cuts.write().await.clear();
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
async fn encrypted_tcp_snapshot_catchup_survives_restart_after_purged_log_prefix() {
    use openraft::storage::{RaftLogStorage, RaftStateMachine};
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
        assert_eq!(
            cluster
                .write(leader, command(100 + epoch, epoch, leader))
                .await
                .outcome,
            Outcome::Accepted
        );
    }
    cluster.wait_epoch(&majority, 31).await;
    tokio::time::timeout(Duration::from_secs(10), async {
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
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
    })
    .await
    .unwrap();
    cluster.start(missing).await;
    cluster.wait_epoch(&[1, 2, 3], 31).await;
    assert!(cluster
        .stores
        .get_mut(&missing)
        .unwrap()
        .get_current_snapshot()
        .await
        .unwrap()
        .is_some());
    cluster.stop(missing).await;
    cluster.start(missing).await;
    cluster.wait_epoch(&[1, 2, 3], 31).await;
    assert_eq!(
        cluster.stores[&missing]
            .control_state()
            .await
            .unwrap()
            .operations
            .len(),
        31
    );
    cluster.finish().await;
}

// Linux/Unix process rehearsal. The private Unix socket is a fixture-only
// control channel, never a network administration endpoint. No extra binary
// target is exposed until the pending test and transport are deliberately wired.
#[cfg(unix)]
mod processes {
    use super::*;
    use openraft::storage::RaftLogStorage;
    use serde::{Deserialize, Serialize};
    use sha2::{Digest, Sha256};
    use std::{
        io::{Read, Write},
        os::unix::fs::{MetadataExt, PermissionsExt},
        path::{Path, PathBuf},
        process::{Child, Command, Stdio},
    };
    use tokio::net::{UnixListener, UnixStream};

    #[derive(Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct WorkerConfig {
        binding: StoreBinding,
        peers: BTreeMap<u64, RecoveryPeer>,
        bind_address: SocketAddr,
        owner: String,
        #[serde(default)]
        raft_timing: Option<WorkerTiming>,
    }
    #[derive(Clone, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct WorkerTiming {
        heartbeat_ms: u64,
        election_min_ms: u64,
        election_max_ms: u64,
        snapshot_timeout_ms: u64,
    }
    #[derive(Clone, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct BootstrapConfig {
        schema_version: u8,
        node_id: u64,
        owner: String,
    }
    #[derive(Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct PublicIdentity {
        schema_version: u8,
        node_id: u64,
        public_key: String,
    }
    #[derive(Serialize, Deserialize)]
    #[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
    enum Request {
        Status,
        Receipt { operation_id: String },
        Initialize,
        Propose { command: ControlCommand },
        Stop,
    }
    #[derive(Debug, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Reply {
        result: String,
        node_id: u64,
        is_leader: bool,
        current_term: u64,
        leader_hint: Option<u64>,
        durable_applied_index: Option<u64>,
        observed_snapshot_index: Option<u64>,
        observed_purged_index: Option<u64>,
        operations_sha256: String,
        epoch: u64,
        operations: usize,
        minority_operation_present: bool,
        control: Option<ControlReply>,
        /// Hash the actual persisted command, never an echoed retry payload.
        control_command_sha256: Option<String>,
        canonical_writer_permitted: bool,
    }
    fn private_file<T: Serialize>(path: &Path, value: &T) {
        use std::os::unix::fs::OpenOptionsExt;
        let bytes = serde_json::to_vec(value).unwrap();
        assert!(bytes.len() <= 16 * 1024);
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(path)
            .unwrap();
        file.write_all(&bytes).unwrap();
        file.sync_all().unwrap();
        std::fs::File::open(path.parent().unwrap())
            .unwrap()
            .sync_all()
            .unwrap();
    }
    fn read_private_configuration<T: serde::de::DeserializeOwned>(root: &Path) -> T {
        assert!(root.is_absolute());
        assert!(!root
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir)));
        for ancestor in root.ancestors() {
            let metadata = std::fs::symlink_metadata(ancestor).unwrap();
            assert!(metadata.is_dir() && !metadata.file_type().is_symlink());
        }
        let metadata = std::fs::symlink_metadata(root).unwrap();
        assert!(metadata.is_dir() && !metadata.file_type().is_symlink());
        assert_eq!(metadata.permissions().mode() & 0o077, 0);
        let root_uid = metadata.uid();
        let file = root.join("fixture.json");
        let metadata = std::fs::symlink_metadata(&file).unwrap();
        assert!(
            metadata.is_file() && !metadata.file_type().is_symlink() && metadata.len() <= 16 * 1024
        );
        assert_eq!(metadata.permissions().mode() & 0o077, 0);
        assert_eq!(metadata.nlink(), 1);
        assert_eq!(metadata.uid(), root_uid);
        let file = std::fs::File::open(&file).unwrap();
        let held = file.metadata().unwrap();
        assert_eq!((held.dev(), held.ino()), (metadata.dev(), metadata.ino()));
        assert!(held.is_file() && held.len() <= 16 * 1024 && held.nlink() == 1);
        assert_eq!(held.permissions().mode() & 0o077, 0);
        assert_eq!(held.uid(), root_uid);
        // A file growing after metadata inspection cannot trigger an
        // unbounded std::fs::read allocation in this disposable worker.
        let mut bytes = Vec::new();
        (&file).take(16 * 1024 + 1).read_to_end(&mut bytes).unwrap();
        assert!(!bytes.is_empty() && bytes.len() <= 16 * 1024);
        let after = file.metadata().unwrap();
        assert_eq!(
            (
                after.dev(),
                after.ino(),
                after.len(),
                after.mtime(),
                after.mtime_nsec(),
                after.ctime(),
                after.ctime_nsec()
            ),
            (
                held.dev(),
                held.ino(),
                held.len(),
                held.mtime(),
                held.mtime_nsec(),
                held.ctime(),
                held.ctime_nsec()
            )
        );
        let named = std::fs::symlink_metadata(root.join("fixture.json")).unwrap();
        assert_eq!((named.dev(), named.ino()), (held.dev(), held.ino()));
        serde_json::from_slice(&bytes).unwrap()
    }
    fn read_config(root: &Path, expected_owner: &str) -> WorkerConfig {
        let config: WorkerConfig = read_private_configuration(root);
        assert_eq!(expected_owner, config.owner);
        assert!(digest_valid(&config.owner));
        wabi_consensus::trust::validate_three_voter_roster(&config.binding, &config.peers).unwrap();
        worker_raft_config(config.raft_timing.as_ref());
        config
    }

    fn worker_raft_config(timing: Option<&WorkerTiming>) -> openraft::Config {
        let mut config = raft_config();
        if let Some(timing) = timing {
            assert!((100..=2000).contains(&timing.heartbeat_ms));
            assert!((1000..=10000).contains(&timing.election_min_ms));
            assert!(timing.election_min_ms >= timing.heartbeat_ms * 3);
            assert!(
                timing.election_max_ms > timing.election_min_ms && timing.election_max_ms <= 20000
            );
            assert!((5000..=20000).contains(&timing.snapshot_timeout_ms));
            config.heartbeat_interval = timing.heartbeat_ms;
            config.election_timeout_min = timing.election_min_ms;
            config.election_timeout_max = timing.election_max_ms;
            config.install_snapshot_timeout = timing.snapshot_timeout_ms;
            config.send_snapshot_timeout = timing.snapshot_timeout_ms;
        }
        config.validate().unwrap()
    }

    #[test]
    fn physical_worker_timing_is_explicit_bounded_and_local_defaults_are_preserved() {
        assert_eq!(worker_raft_config(None).heartbeat_interval, 100);
        let timing = WorkerTiming {
            heartbeat_ms: 500,
            election_min_ms: 2500,
            election_max_ms: 5000,
            snapshot_timeout_ms: 10000,
        };
        let config = worker_raft_config(Some(&timing));
        assert_eq!(config.heartbeat_interval, 500);
        assert_eq!(config.election_timeout_min, 2500);
        assert_eq!(config.election_timeout_max, 5000);
        assert_eq!(config.install_snapshot_timeout, 10000);
        for invalid in [
            WorkerTiming {
                heartbeat_ms: 0,
                ..timing.clone()
            },
            WorkerTiming {
                heartbeat_ms: 2001,
                ..timing.clone()
            },
            WorkerTiming {
                election_min_ms: 1000,
                ..timing.clone()
            },
            WorkerTiming {
                election_max_ms: 2500,
                ..timing.clone()
            },
            WorkerTiming {
                election_max_ms: 20001,
                ..timing.clone()
            },
            WorkerTiming {
                snapshot_timeout_ms: 4999,
                ..timing.clone()
            },
        ] {
            assert!(std::panic::catch_unwind(|| worker_raft_config(Some(&invalid))).is_err());
        }
    }

    /// Explicit fixture bootstrap only, before any supervisor/store/listener.
    /// The trusted operator must exclusively own this private staging tree.
    /// A key (even damaged) or any unexpected entry vetoes generation.
    fn create_private_identity(root: &Path, expected_owner: &str) -> PublicIdentity {
        let config: BootstrapConfig = read_private_configuration(root);
        assert!(config.schema_version == 1 && (1..=3).contains(&config.node_id));
        assert!(digest_valid(expected_owner) && config.owner == expected_owner);
        let original = std::fs::symlink_metadata(root).unwrap();
        for entry in std::fs::read_dir(root).unwrap() {
            let entry = entry.unwrap();
            assert!(matches!(
                entry.file_name().to_str(),
                Some("fixture.json" | "probe.bin")
            ));
            let metadata = std::fs::symlink_metadata(entry.path()).unwrap();
            assert!(metadata.is_file() && !metadata.file_type().is_symlink());
            assert!(metadata.nlink() == 1 && metadata.uid() == original.uid());
            assert_eq!(metadata.permissions().mode() & 0o077, 0);
        }
        let identity = Identity::generate().unwrap();
        let current = std::fs::symlink_metadata(root).unwrap();
        assert_eq!(
            (current.dev(), current.ino()),
            (original.dev(), original.ino())
        );
        identity.persist_new(root).unwrap();
        PublicIdentity {
            schema_version: 1,
            node_id: config.node_id,
            public_key: identity.public_hex(),
        }
    }

    #[test]
    #[ignore = "explicit owned private node-key bootstrap invoked by parent/operator only"]
    fn separate_process_identity_bootstrap() {
        let root = PathBuf::from(std::env::var("WABI_RPC_FIXTURE_ROOT").unwrap());
        let owner = std::env::var("WABI_RPC_FIXTURE_OWNER").unwrap();
        let public = create_private_identity(&root, &owner);
        // This fixed record contains only public enrollment material. Never
        // serialize Identity or include the owner/root/configuration in output.
        println!(
            "WABI_RPC_NODE_PUBLIC_V1 {}",
            serde_json::to_string(&public).unwrap()
        );
    }
    #[test]
    fn worker_config_is_private_bounded_and_bound_to_its_existing_owner() {
        let root = tempfile::Builder::new()
            .prefix("wabi-consensus-config-")
            .tempdir()
            .unwrap();
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let owner = "ef".repeat(32);
        let config = WorkerConfig {
            binding: binding(1),
            peers: (1..=3)
                .map(|id| {
                    (
                        id,
                        RecoveryPeer {
                            protocol: CONTROL_PROTOCOL,
                            community_id: binding(id).community_id,
                            site_id: format!("config-site-{id}"),
                            public_key: format!("{id:02x}").repeat(32),
                            rpc_address: format!("127.0.0.1:{}", 16000 + id),
                        },
                    )
                })
                .collect(),
            bind_address: "127.0.0.1:16001".parse().unwrap(),
            owner: owner.clone(),
            raft_timing: None,
        };
        let path = root.path().join("fixture.json");
        private_file(&path, &config);
        assert_eq!(read_config(root.path(), &owner).binding, binding(1));
        assert!(std::panic::catch_unwind(|| read_config(root.path(), &"00".repeat(32))).is_err());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(std::panic::catch_unwind(|| read_config(root.path(), &owner)).is_err());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let duplicate = root.path().join("duplicate.json");
        std::fs::hard_link(&path, &duplicate).unwrap();
        assert!(std::panic::catch_unwind(|| read_config(root.path(), &owner)).is_err());
        std::fs::remove_file(duplicate).unwrap();
        std::fs::write(&path, vec![b'x'; 16 * 1024 + 1]).unwrap();
        assert!(std::panic::catch_unwind(|| read_config(root.path(), &owner)).is_err());
        std::fs::remove_file(&path).unwrap();
        private_file(&path, &config);
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(std::panic::catch_unwind(|| read_config(root.path(), &owner)).is_err());
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::rename(&path, root.path().join("original.json")).unwrap();
        std::os::unix::fs::symlink(root.path().join("original.json"), &path).unwrap();
        assert!(std::panic::catch_unwind(|| read_config(root.path(), &owner)).is_err());
        assert_eq!(
            std::fs::metadata(root.path().join("original.json"))
                .unwrap()
                .nlink(),
            1
        );
        root.close().unwrap();
    }
    async fn receive<T: serde::de::DeserializeOwned>(stream: &mut UnixStream) -> T {
        let length = stream.read_u32().await.unwrap() as usize;
        assert!((1..=4096).contains(&length));
        let mut bytes = vec![0; length];
        stream.read_exact(&mut bytes).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }
    async fn send(stream: &mut UnixStream, value: &impl Serialize) {
        let bytes = serde_json::to_vec(value).unwrap();
        assert!((1..=4096).contains(&bytes.len()));
        stream.write_u32(bytes.len() as u32).await.unwrap();
        stream.write_all(&bytes).await.unwrap();
        stream.flush().await.unwrap();
    }
    fn command_sha256(command: &ControlCommand) -> String {
        hex::encode(Sha256::digest(serde_json::to_vec(command).unwrap()))
    }
    #[test]
    fn control_command_fingerprint_matches_pinned_python_wire_order() {
        let value = ControlCommand {
            checkpoint_inventory_sha256: "ab".repeat(32),
            ..command(1, 0, 1)
        };
        assert_eq!(
            command_sha256(&value),
            "5c7ee9597c941f9f8cf1b3eb1400f815242cbbbc27824b86f2510b116f0f5b3a"
        );
        let mut changed = value.clone();
        changed.proposed_writer = 2;
        assert_ne!(command_sha256(&value), command_sha256(&changed));
    }
    async fn status(
        raft: &Node,
        store: &Store,
        node_id: u64,
        result: &str,
        control: Option<ControlReply>,
        operation_id: Option<&str>,
    ) -> Reply {
        let state = store.control_state().await.unwrap();
        let metrics = raft.metrics().borrow().clone();
        Reply {
            result: result.into(),
            node_id,
            is_leader: metrics.state == ServerState::Leader,
            current_term: metrics.current_term,
            leader_hint: metrics.current_leader,
            durable_applied_index: state.last_applied.map(|log| log.index),
            observed_snapshot_index: metrics.snapshot.map(|log| log.index),
            observed_purged_index: metrics.purged.map(|log| log.index),
            operations_sha256: hex::encode(Sha256::digest(
                serde_json::to_vec(&state.operations).unwrap(),
            )),
            epoch: state
                .intents
                .get("room:fixture")
                .map_or(0, |intent| intent.epoch),
            operations: state.operations.len(),
            minority_operation_present: state.operations.contains_key(&format!("{:032x}", 99)),
            control,
            control_command_sha256: operation_id.and_then(|id| {
                state
                    .operations
                    .get(id)
                    .map(|receipt| command_sha256(&receipt.command))
            }),
            canonical_writer_permitted: false,
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "owned child process invoked by the parent contract only"]
    async fn separate_process_recovery_worker() {
        // An independent OS thread bounds the child even if its async runtime
        // or blocking store lane stalls after the controller disappears.
        // Normal shutdown cancels and joins it. At expiry it terminates only
        // this disposable worker; recovery must reopen its durable store.
        let watchdog_state = Arc::new((std::sync::Mutex::new(false), std::sync::Condvar::new()));
        let watched = watchdog_state.clone();
        let watchdog = std::thread::Builder::new()
            .name("rpc-fixture-lifetime".into())
            .stack_size(64 * 1024)
            .spawn(move || {
                let (flag, changed) = &*watched;
                let (done, _) = changed
                    .wait_timeout_while(flag.lock().unwrap(), Duration::from_secs(100), |done| {
                        !*done
                    })
                    .unwrap();
                if !*done {
                    std::process::exit(124);
                }
            })
            .unwrap();
        let root = PathBuf::from(std::env::var("WABI_RPC_FIXTURE_ROOT").unwrap());
        let owner = std::env::var("WABI_RPC_FIXTURE_OWNER").unwrap();
        let config = read_config(&root, &owner);
        let id = config.binding.node_id;
        let identity = Arc::new(Identity::load(&root).unwrap());
        let transport = Arc::new(
            Config::new(
                config.binding.clone(),
                config.peers.clone(),
                identity,
                Limits::default(),
            )
            .unwrap()
            .with_bind_address(config.bind_address)
            .unwrap(),
        );
        let store = Store::open(&root, config.binding.clone(), StoreLimits::default()).unwrap();
        let options = Arc::new(worker_raft_config(config.raft_timing.as_ref()));
        let raft = Node::new(
            id,
            options.clone(),
            Network::new(transport.clone(), &options).unwrap(),
            store.clone(),
            store.clone(),
        )
        .await
        .unwrap();
        let listener = listen(config.bind_address);
        let actor = raft.clone();
        let (stop, stopped) = oneshot::channel();
        let server =
            tokio::spawn(
                async move { transport::serve(listener, actor, transport, stopped).await },
            );
        let socket = root.join("control.sock");
        // A previous SIGKILL can leave only this fixture socket name. It is
        // not a writer lock and cannot authorize store ownership; open above
        // must already have obtained the persistent OS lock before removing it.
        if let Ok(metadata) = std::fs::symlink_metadata(&socket) {
            use std::os::unix::fs::FileTypeExt;
            assert!(metadata.file_type().is_socket());
            std::fs::remove_file(&socket).unwrap();
        }
        let control = UnixListener::bind(&socket).unwrap();
        std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600)).unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(90);
        let mut commands = 0;
        loop {
            let Ok(connection) = tokio::time::timeout_at(deadline, control.accept()).await else {
                break;
            };
            let (mut stream, _) = connection.unwrap();
            commands += 1;
            assert!(commands <= 512);
            let request: Request = tokio::time::timeout_at(
                deadline.min(tokio::time::Instant::now() + Duration::from_secs(3)),
                receive(&mut stream),
            )
            .await
            .unwrap();
            let mut stopped = false;
            let mut outcome = None;
            let mut receipt_id = None;
            let result = match request {
                Request::Status => "status",
                Request::Receipt { operation_id } => {
                    if operation_id.len() != 32
                        || !operation_id.bytes().all(|byte| byte.is_ascii_hexdigit())
                    {
                        "refused"
                    } else {
                        receipt_id = Some(operation_id.clone());
                        let state = tokio::time::timeout_at(
                            deadline.min(tokio::time::Instant::now() + Duration::from_secs(3)),
                            store.control_state(),
                        )
                        .await
                        .expect("worker receipt deadline")
                        .unwrap();
                        outcome = state
                            .operations
                            .get(&operation_id)
                            .map(|receipt| receipt.reply.clone());
                        "receipt"
                    }
                }
                Request::Initialize => {
                    let initialize = async {
                        let mut log = store.clone();
                        if id != 1
                            || log.read_vote().await.unwrap().is_some()
                            || log.get_log_state().await.unwrap().last_log_id.is_some()
                        {
                            "refused"
                        } else if raft.initialize(config.peers.clone()).await.is_ok() {
                            "initialized"
                        } else {
                            "refused"
                        }
                    };
                    tokio::time::timeout_at(
                        deadline.min(tokio::time::Instant::now() + Duration::from_secs(3)),
                        initialize,
                    )
                    .await
                    .unwrap_or("indeterminate")
                }
                Request::Propose { command } => {
                    if !command.valid() {
                        "refused"
                    } else {
                        receipt_id = Some(command.operation_id.clone());
                        match tokio::time::timeout_at(
                            deadline.min(tokio::time::Instant::now() + Duration::from_secs(3)),
                            raft.client_write(command.into()),
                        )
                        .await
                        {
                            Ok(Ok(reply)) => {
                                outcome = Some(reply.data);
                                "committed"
                            }
                            Ok(Err(_)) => "refused",
                            // Timeout is indeterminate: status/receipt checks
                            // after recovery, not this label, establish fate.
                            Err(_) => "indeterminate",
                        }
                    }
                }
                Request::Stop => {
                    stopped = true;
                    "stopped"
                }
            };
            let reply = tokio::time::timeout_at(
                deadline.min(tokio::time::Instant::now() + Duration::from_secs(3)),
                status(&raft, &store, id, result, outcome, receipt_id.as_deref()),
            )
            .await
            .expect("worker status deadline");
            tokio::time::timeout_at(
                deadline.min(tokio::time::Instant::now() + Duration::from_secs(3)),
                send(&mut stream, &reply),
            )
            .await
            .unwrap();
            if stopped {
                break;
            }
        }
        drop(control);
        std::fs::remove_file(socket).unwrap();
        let _ = stop.send(());
        tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), raft.shutdown())
            .await
            .unwrap()
            .unwrap();
        drop(raft);
        drop(store);
        {
            let (flag, changed) = &*watchdog_state;
            *flag.lock().unwrap() = true;
            changed.notify_all();
        }
        watchdog.join().unwrap();
    }

    struct Process {
        child: Child,
        node_id: u64,
        root: PathBuf,
        owner: String,
        reaped: bool,
    }
    impl Process {
        fn start(node_id: u64, root: PathBuf, owner: String) -> Self {
            let child = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "processes::separate_process_recovery_worker",
                    "--ignored",
                    "--test-threads=1",
                ])
                .env_clear()
                .env("WABI_RPC_FIXTURE_ROOT", &root)
                .env("WABI_RPC_FIXTURE_OWNER", &owner)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            Self {
                child,
                node_id,
                root,
                owner,
                reaped: false,
            }
        }
        async fn call(&mut self, request: Request) -> Reply {
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    assert!(
                        self.child.try_wait().unwrap().is_none(),
                        "fixture worker exited before control reply"
                    );
                    match UnixStream::connect(self.root.join("control.sock")).await {
                        Ok(mut stream) => {
                            send(&mut stream, &request).await;
                            let reply: Reply = receive(&mut stream).await;
                            assert_eq!(reply.node_id, self.node_id);
                            assert!(!reply.canonical_writer_permitted);
                            assert!(digest_valid(&reply.operations_sha256));
                            return reply;
                        }
                        Err(_) => tokio::time::sleep(Duration::from_millis(10)).await,
                    }
                }
            })
            .await
            .expect("owned worker control deadline")
        }
        async fn kill_and_reap(&mut self) {
            self.child.kill().unwrap();
            tokio::time::timeout(Duration::from_secs(5), async {
                while self.child.try_wait().unwrap().is_none() {
                    tokio::time::sleep(Duration::from_millis(10)).await
                }
            })
            .await
            .expect("owned child reap deadline");
            self.reaped = true;
        }
        async fn expect_startup_refusal(&mut self) {
            let exit = tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    if let Some(status) = self.child.try_wait().unwrap() {
                        return status;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("unsafe fixture identity must refuse before serving");
            self.reaped = true;
            assert!(!exit.success());
            for path in ["consensus.redb", ".lock", "control.sock"] {
                assert!(
                    !self.root.join(path).exists(),
                    "refusal must precede durable store/listener creation"
                );
            }
        }
        async fn finish(&mut self) {
            assert_eq!(self.call(Request::Stop).await.result, "stopped");
            let exit = tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    if let Some(status) = self.child.try_wait().unwrap() {
                        return status;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await
                }
            })
            .await
            .expect("owned worker shutdown deadline");
            self.reaped = true;
            assert!(exit.success());
        }
    }
    impl Drop for Process {
        fn drop(&mut self) {
            if !self.reaped {
                let _ = self.child.kill();
                // Backstop for a panicking test parent: this known direct child
                // is reaped before TempDir removes its fixture. No raw PID kill.
                let _ = self.child.wait();
            }
        }
    }
    async fn bootstrap_child(
        root: &Path,
        node_id: u64,
        owner: &str,
    ) -> (bool, Option<PublicIdentity>) {
        let child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "processes::separate_process_identity_bootstrap",
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env_clear()
            .env("WABI_RPC_FIXTURE_ROOT", root)
            .env("WABI_RPC_FIXTURE_OWNER", owner)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        // Reuse the direct-child drop backstop: a deadline/panicking parent
        // cannot leave this known child alive when its TempDir is removed.
        let mut process = Process {
            child,
            node_id,
            root: root.to_path_buf(),
            owner: owner.into(),
            reaped: false,
        };
        let exit = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(exit) = process.child.try_wait().unwrap() {
                    break exit;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("private bootstrap child deadline");
        process.reaped = true;
        let mut bytes = Vec::new();
        process
            .child
            .stdout
            .take()
            .unwrap()
            .take(4097)
            .read_to_end(&mut bytes)
            .unwrap();
        assert!(bytes.len() <= 4096);
        let text = String::from_utf8(bytes).unwrap();
        assert!(!text.contains(owner) && !text.contains(&root.display().to_string()));
        let prefix = "WABI_RPC_NODE_PUBLIC_V1 ";
        let records: Vec<_> = text
            .lines()
            .filter_map(|line| line.split_once(prefix).map(|(_, value)| value))
            .collect();
        if !exit.success() {
            assert!(records.is_empty());
            return (false, None);
        }
        assert_eq!(records.len(), 1);
        let public: PublicIdentity = serde_json::from_str(records[0]).unwrap();
        assert!(
            public.schema_version == 1
                && public.node_id == node_id
                && digest_valid(&public.public_key)
        );
        (true, Some(public))
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn process_bootstrap_creates_independent_private_keys_once_without_store_or_listener() {
        let mut publics = Vec::new();
        for node_id in 1..=3 {
            let root = tempfile::Builder::new()
                .prefix("wabi-consensus-bootstrap-")
                .tempdir()
                .unwrap();
            std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
            let owner = "ef".repeat(32);
            private_file(
                &root.path().join("fixture.json"),
                &BootstrapConfig {
                    schema_version: 1,
                    node_id,
                    owner: owner.clone(),
                },
            );
            let (accepted, public) = bootstrap_child(root.path(), node_id, &owner).await;
            assert!(accepted);
            let public = public.unwrap();
            let key = std::fs::symlink_metadata(root.path().join("recovery.key")).unwrap();
            assert!(key.is_file() && key.len() == 32 && key.nlink() == 1);
            assert_eq!(key.permissions().mode() & 0o077, 0);
            assert_eq!(
                Identity::load(root.path()).unwrap().public_hex(),
                public.public_key
            );
            let (accepted, _) = bootstrap_child(root.path(), node_id, &owner).await;
            assert!(!accepted);
            let after = std::fs::symlink_metadata(root.path().join("recovery.key")).unwrap();
            assert_eq!(
                (
                    key.dev(),
                    key.ino(),
                    key.len(),
                    key.mtime(),
                    key.mtime_nsec()
                ),
                (
                    after.dev(),
                    after.ino(),
                    after.len(),
                    after.mtime(),
                    after.mtime_nsec()
                )
            );
            assert_eq!(
                Identity::load(root.path()).unwrap().public_hex(),
                public.public_key
            );
            assert!(!root.path().join("consensus.redb").exists());
            assert!(!root.path().join(".lock").exists());
            assert!(!root.path().join("control.sock").exists());
            publics.push(public.public_key);
            root.close().unwrap();
        }
        assert_eq!(
            publics
                .into_iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len(),
            3
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn process_bootstrap_refuses_unsafe_input_without_creating_or_regenerating_keys() {
        for variant in [
            "wrong_owner",
            "bad_schema",
            "bad_node",
            "unknown_field",
            "public_config",
            "linked_config",
            "symlink_config",
            "unexpected_file",
            "public_root",
            "corrupt_key",
        ] {
            let root = tempfile::Builder::new()
                .prefix("wabi-consensus-bootstrap-refusal-")
                .tempdir()
                .unwrap();
            std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
            let owner = "ef".repeat(32);
            let mut config = BootstrapConfig {
                schema_version: 1,
                node_id: 1,
                owner: owner.clone(),
            };
            match variant {
                "wrong_owner" => config.owner = "ab".repeat(32),
                "bad_schema" => config.schema_version = 2,
                "bad_node" => config.node_id = 4,
                _ => (),
            }
            let path = root.path().join("fixture.json");
            if variant == "unknown_field" {
                let mut value = serde_json::to_value(&config).unwrap();
                value["unknown"] = serde_json::json!(true);
                private_file(&path, &value);
            } else {
                private_file(&path, &config);
            }
            match variant {
                "public_config" => {
                    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap()
                }
                "linked_config" => {
                    std::fs::hard_link(&path, root.path().join("linked.json")).unwrap()
                }
                "symlink_config" => {
                    std::fs::rename(&path, root.path().join("original.json")).unwrap();
                    std::os::unix::fs::symlink(root.path().join("original.json"), &path).unwrap();
                }
                "unexpected_file" => {
                    std::fs::write(root.path().join("unexpected.bin"), b"synthetic").unwrap()
                }
                "public_root" => {
                    std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o755))
                        .unwrap()
                }
                "corrupt_key" => {
                    std::fs::write(root.path().join("recovery.key"), [0u8; 31]).unwrap()
                }
                _ => (),
            }
            let original = (variant == "corrupt_key")
                .then(|| std::fs::symlink_metadata(root.path().join("recovery.key")).unwrap());
            let (accepted, _) = bootstrap_child(root.path(), 1, &owner).await;
            assert!(!accepted);
            if let Some(original) = original {
                let after = std::fs::symlink_metadata(root.path().join("recovery.key")).unwrap();
                assert_eq!(
                    (
                        original.dev(),
                        original.ino(),
                        original.len(),
                        original.mtime(),
                        original.mtime_nsec()
                    ),
                    (
                        after.dev(),
                        after.ino(),
                        after.len(),
                        after.mtime(),
                        after.mtime_nsec()
                    )
                );
            } else {
                assert!(!root.path().join("recovery.key").exists());
            }
            assert!(!root.path().join("consensus.redb").exists());
            assert!(!root.path().join(".lock").exists());
            assert!(!root.path().join("control.sock").exists());
            root.close().unwrap();
        }
    }
    async fn leader(nodes: &mut BTreeMap<u64, Process>, ids: &[u64]) -> u64 {
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                for id in ids {
                    if nodes
                        .get_mut(id)
                        .unwrap()
                        .call(Request::Status)
                        .await
                        .is_leader
                    {
                        return *id;
                    }
                }
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
        })
        .await
        .expect("process leader deadline")
    }
    async fn wait_epoch(nodes: &mut BTreeMap<u64, Process>, ids: &[u64], epoch: u64) {
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let mut ready = true;
                for id in ids {
                    ready &= nodes.get_mut(id).unwrap().call(Request::Status).await.epoch == epoch
                }
                if ready {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(30)).await;
            }
        })
        .await
        .expect("process applied-state deadline")
    }
    async fn write(
        nodes: &mut BTreeMap<u64, Process>,
        id: u64,
        request: ControlCommand,
    ) -> ControlReply {
        let expected_command_sha = command_sha256(&request);
        let reply = nodes
            .get_mut(&id)
            .unwrap()
            .call(Request::Propose { command: request })
            .await;
        assert_eq!(reply.result, "committed");
        assert!(!reply.canonical_writer_permitted);
        assert_eq!(reply.control_command_sha256, Some(expected_command_sha));
        let result = reply.control.unwrap();
        assert!(!result.canonical_writer_permitted);
        result
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn process_worker_refuses_unsafe_identity_before_store_or_listener_creation() {
        for variant in ["absent", "truncated", "mismatched", "public", "linked"] {
            let root = tempfile::Builder::new()
                .prefix("wabi-consensus-startup-refusal-")
                .tempdir()
                .unwrap();
            std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
            let owner = hex::encode(Sha256::digest(root.path().as_os_str().as_encoded_bytes()));
            let identities: Vec<_> = (0..3).map(|_| Identity::generate().unwrap()).collect();
            let mut peers = BTreeMap::new();
            let mut endpoints = Vec::new();
            for id in 1..=3 {
                let listener = listen("127.0.0.1:0".parse().unwrap());
                peers.insert(
                    id,
                    RecoveryPeer {
                        protocol: CONTROL_PROTOCOL,
                        community_id: binding(id).community_id,
                        site_id: format!("startup-fixture-{id}"),
                        public_key: identities[id as usize - 1].public_hex(),
                        rpc_address: listener.local_addr().unwrap().to_string(),
                    },
                );
                endpoints.push(listener);
            }
            let bind_address = endpoints[0].local_addr().unwrap();
            private_file(
                &root.path().join("fixture.json"),
                &WorkerConfig {
                    binding: binding(1),
                    peers,
                    bind_address,
                    owner: owner.clone(),
                    raft_timing: None,
                },
            );
            if variant != "absent" {
                let identity = if variant == "mismatched" {
                    &identities[1]
                } else {
                    &identities[0]
                };
                identity.persist_new(root.path()).unwrap();
                let key = root.path().join("recovery.key");
                match variant {
                    "truncated" => std::fs::write(key, [0u8; 31]).unwrap(),
                    "public" => {
                        std::fs::set_permissions(key, std::fs::Permissions::from_mode(0o644))
                            .unwrap()
                    }
                    "linked" => std::fs::hard_link(key, root.path().join("linked.key")).unwrap(),
                    _ => (),
                }
            }
            drop(endpoints);
            let mut worker = Process::start(1, root.path().to_path_buf(), owner);
            worker.expect_startup_refusal().await;
            drop(worker);
            root.close().unwrap();
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn encrypted_process_sigkill_restart_and_minority_rejoin_keep_only_majority_outcomes() {
        let root = tempfile::Builder::new()
            .prefix("wabi-consensus-process-")
            .tempdir()
            .unwrap();
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let owner = hex::encode(Sha256::digest(root.path().as_os_str().as_encoded_bytes()));
        let cuts = Arc::new(RwLock::new(BTreeSet::new()));
        let mut peers = BTreeMap::new();
        let mut binds = BTreeMap::new();
        let mut ingress = BTreeMap::new();
        for id in 1..=3 {
            let ingress_listener = listen("127.0.0.1:0".parse().unwrap());
            let bind_listener = listen("127.0.0.1:0".parse().unwrap());
            binds.insert(id, bind_listener.local_addr().unwrap());
            drop(bind_listener);
            let node_root = root.path().join(format!("node-{id}"));
            std::fs::create_dir(&node_root).unwrap();
            std::fs::set_permissions(&node_root, std::fs::Permissions::from_mode(0o700)).unwrap();
            let identity = Identity::generate().unwrap();
            identity.persist_new(&node_root).unwrap();
            peers.insert(
                id,
                RecoveryPeer {
                    protocol: CONTROL_PROTOCOL,
                    community_id: binding(id).community_id,
                    site_id: format!("process-fixture-{id}"),
                    public_key: identity.public_hex(),
                    rpc_address: ingress_listener.local_addr().unwrap().to_string(),
                },
            );
            ingress.insert(id, ingress_listener);
        }
        let mut proxies = Vec::new();
        let mut nodes = BTreeMap::new();
        for id in 1..=3 {
            let node_root = root.path().join(format!("node-{id}"));
            private_file(
                &node_root.join("fixture.json"),
                &WorkerConfig {
                    binding: binding(id),
                    peers: peers.clone(),
                    bind_address: binds[&id],
                    owner: owner.clone(),
                    raft_timing: None,
                },
            );
            proxies.push(Proxy::start(
                ingress.remove(&id).unwrap(),
                id,
                binds[&id],
                cuts.clone(),
            ));
            nodes.insert(id, Process::start(id, node_root, owner.clone()));
        }
        assert_eq!(
            nodes
                .get_mut(&1)
                .unwrap()
                .call(Request::Initialize)
                .await
                .result,
            "initialized"
        );
        let initial = leader(&mut nodes, &[1, 2, 3]).await;
        let original = command(1, 0, initial);
        let receipt = write(&mut nodes, initial, original.clone()).await;
        assert_eq!(receipt.outcome, Outcome::Accepted);
        wait_epoch(&mut nodes, &[1, 2, 3], 1).await;
        let mut epoch = 1;
        for lost in [1, 2, 3] {
            let mut node = nodes.remove(&lost).unwrap();
            node.kill_and_reap().await;
            let remaining: Vec<_> = (1..=3).filter(|id| *id != lost).collect();
            let live = leader(&mut nodes, &remaining).await;
            assert_eq!(
                write(&mut nodes, live, command(10 + lost, epoch, live))
                    .await
                    .outcome,
                Outcome::Accepted
            );
            epoch += 1;
            wait_epoch(&mut nodes, &remaining, epoch).await;
            nodes.insert(
                lost,
                Process::start(lost, node.root.clone(), node.owner.clone()),
            );
            wait_epoch(&mut nodes, &[1, 2, 3], epoch).await;
        }
        for node in nodes.values_mut() {
            node.kill_and_reap().await
        }
        for id in [1, 2, 3] {
            let node = nodes.remove(&id).unwrap();
            nodes.insert(
                id,
                Process::start(id, node.root.clone(), node.owner.clone()),
            );
        }
        let old = leader(&mut nodes, &[1, 2, 3]).await;
        assert_eq!(write(&mut nodes, old, original.clone()).await, receipt);
        // A reused ID with changed contents cannot borrow the original
        // operation's outcome. Receipt fingerprints come from stored state.
        let mut changed = original.clone();
        changed.proposed_writer = (old % 3) + 1;
        if changed.proposed_writer == original.proposed_writer {
            changed.proposed_writer = (changed.proposed_writer % 3) + 1;
        }
        let changed_reply = nodes
            .get_mut(&old)
            .unwrap()
            .call(Request::Propose {
                command: changed.clone(),
            })
            .await;
        assert_eq!(changed_reply.result, "committed");
        assert_eq!(changed_reply.control.unwrap().outcome, Outcome::Refused);
        assert_eq!(
            changed_reply.control_command_sha256,
            Some(command_sha256(&original))
        );
        assert_ne!(command_sha256(&changed), command_sha256(&original));
        let majority: Vec<_> = (1..=3).filter(|id| *id != old).collect();
        {
            let mut links = cuts.write().await;
            for id in &majority {
                links.insert((old, *id));
                links.insert((*id, old));
            }
        }
        let live = leader(&mut nodes, &majority).await;
        let rejected = nodes
            .get_mut(&old)
            .unwrap()
            .call(Request::Propose {
                command: command(99, epoch, old),
            })
            .await;
        assert_ne!(rejected.result, "committed");
        assert!(rejected.control.is_none());
        assert_eq!(
            write(&mut nodes, live, command(2, epoch, live))
                .await
                .outcome,
            Outcome::Accepted
        );
        epoch += 1;
        wait_epoch(&mut nodes, &majority, epoch).await;
        cuts.write().await.clear();
        wait_epoch(&mut nodes, &[1, 2, 3], epoch).await;
        let mut fingerprints = BTreeSet::new();
        for node in nodes.values_mut() {
            let status = node.call(Request::Status).await;
            assert!(!status.minority_operation_present);
            assert_eq!(status.operations, 5);
            assert!(status.durable_applied_index.is_some());
            assert!(status.current_term > 0);
            fingerprints.insert(status.operations_sha256);
            let original_readback = node
                .call(Request::Receipt {
                    operation_id: format!("{:032x}", 1),
                })
                .await;
            assert_eq!(original_readback.control, Some(receipt.clone()));
            assert_eq!(
                original_readback.control_command_sha256,
                Some(command_sha256(&original))
            );
        }
        assert_eq!(
            fingerprints.len(),
            1,
            "equal counts must also have equal durable receipt contents"
        );
        // Exercise the snapshot path across independently killed/reopened
        // processes, after proving the minority's uncommitted intent absent.
        // A copied log prefix or equal receipt counts cannot stand in for an
        // actual snapshot install after the surviving log prefix is purged.
        let live = leader(&mut nodes, &[1, 2, 3]).await;
        let missing = (1..=3).find(|id| *id != live).unwrap();
        let mut absent = nodes.remove(&missing).unwrap();
        absent.kill_and_reap().await;
        let majority: Vec<_> = (1..=3).filter(|id| *id != missing).collect();
        for sequence in 0..30 {
            let live = leader(&mut nodes, &majority).await;
            assert_eq!(
                write(&mut nodes, live, command(100 + sequence, epoch, live))
                    .await
                    .outcome,
                Outcome::Accepted
            );
            epoch += 1;
        }
        wait_epoch(&mut nodes, &majority, epoch).await;
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let live = leader(&mut nodes, &majority).await;
                if nodes
                    .get_mut(&live)
                    .unwrap()
                    .call(Request::Status)
                    .await
                    .observed_purged_index
                    .is_some_and(|index| index > 10)
                {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(40)).await;
            }
        })
        .await
        .expect("process fixture must actually purge its missing prefix");
        nodes.insert(
            missing,
            Process::start(missing, absent.root.clone(), absent.owner.clone()),
        );
        wait_epoch(&mut nodes, &[1, 2, 3], epoch).await;
        assert!(nodes
            .get_mut(&missing)
            .unwrap()
            .call(Request::Status)
            .await
            .observed_snapshot_index
            .is_some_and(|index| index > 10));
        let mut returned = nodes.remove(&missing).unwrap();
        returned.kill_and_reap().await;
        nodes.insert(
            missing,
            Process::start(missing, returned.root.clone(), returned.owner.clone()),
        );
        wait_epoch(&mut nodes, &[1, 2, 3], epoch).await;
        let mut fingerprints = BTreeSet::new();
        for node in nodes.values_mut() {
            let status = node.call(Request::Status).await;
            assert_eq!(status.operations, 35);
            assert!(!status.minority_operation_present);
            fingerprints.insert(status.operations_sha256);
            let original_readback = node
                .call(Request::Receipt {
                    operation_id: format!("{:032x}", 1),
                })
                .await;
            assert_eq!(original_readback.control, Some(receipt.clone()));
            assert_eq!(
                original_readback.control_command_sha256,
                Some(command_sha256(&original))
            );
        }
        assert_eq!(fingerprints.len(), 1);
        for node in nodes.values_mut() {
            node.finish().await
        }
        drop(nodes);
        for proxy in proxies {
            proxy.finish().await
        }
        root.close().unwrap();
    }
}
