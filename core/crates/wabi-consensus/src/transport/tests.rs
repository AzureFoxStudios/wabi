use super::*;
use crate::model::CONTROL_PROTOCOL;

pub(super) fn fixture() -> Vec<Config> {
    let identities: Vec<_> = (0..3)
        .map(|_| Arc::new(Identity::generate().unwrap()))
        .collect();
    let peers: BTreeMap<_, _> = (1..=3)
        .map(|id| {
            (
                id,
                RecoveryPeer {
                    protocol: CONTROL_PROTOCOL,
                    community_id: "ab".repeat(32),
                    site_id: format!("site-{id}"),
                    public_key: identities[id as usize - 1].public_hex(),
                    rpc_address: format!("127.0.0.1:{}", 13000 + id),
                },
            )
        })
        .collect();
    (1..=3)
        .map(|node_id| {
            Config::new(
                StoreBinding {
                    community_id: "ab".repeat(32),
                    partition_id: "community/control".into(),
                    node_id,
                },
                peers.clone(),
                identities[node_id as usize - 1].clone(),
                Limits::default(),
            )
            .unwrap()
        })
        .collect()
}

#[test]
fn identity_roster_limits_and_debug_are_strict() {
    let config = fixture().remove(0);
    assert_eq!(
        format!("{:?}", config),
        "RecoveryTransportConfig([REDACTED])"
    );
    assert_eq!(
        format!("{:?}", config.identity),
        "RecoveryIdentity([REDACTED])"
    );
    assert!(Config::new(
        config.binding.clone(),
        config.peers.clone(),
        Arc::new(Identity::generate().unwrap()),
        Limits::default()
    )
    .is_err());
    let mut zero = config.peers.clone();
    zero.get_mut(&2).unwrap().public_key = "00".repeat(32);
    assert!(Config::new(
        config.binding.clone(),
        zero,
        config.identity.clone(),
        Limits::default()
    )
    .is_err());
    let mut limits = Limits::default();
    limits.max_rpc_bytes = usize::MAX;
    assert!(matches!(
        Config::new(
            config.binding.clone(),
            config.peers.clone(),
            config.identity.clone(),
            limits
        ),
        Err(Error::Budget)
    ));
    let mut limits = Limits::default();
    limits.inbound_connections = 33;
    assert!(Config::new(
        config.binding.clone(),
        config.peers.clone(),
        config.identity.clone(),
        limits
    )
    .is_err());
    for value in [0, 17] {
        let mut limits = Limits::default();
        limits.outbound_connections = value;
        assert!(matches!(
            Config::new(
                config.binding.clone(),
                config.peers.clone(),
                config.identity.clone(),
                limits
            ),
            Err(Error::Budget)
        ));
    }
}

#[test]
fn authenticated_sender_and_initial_membership_bind_every_rpc() {
    use openraft::{EntryPayload, Vote};
    let config = fixture().remove(1);
    let vote = rpc::Request::Vote(openraft::raft::VoteRequest {
        vote: Vote::new(7, 1),
        last_log_id: None,
    });
    config.request_valid(1, 2, &vote).unwrap();
    assert_eq!(
        config.request_valid(3, 2, &vote),
        Err(Error::Authentication)
    );
    assert_eq!(
        config.request_valid(1, 1, &vote),
        Err(Error::Authentication)
    );
    let mut peers = config.peers.clone();
    peers.get_mut(&3).unwrap().public_key = Identity::generate().unwrap().public_hex();
    let rpc = rpc::Request::Append(openraft::raft::AppendEntriesRequest {
        vote: Vote::new_committed(7, 1),
        prev_log_id: None,
        leader_commit: None,
        entries: vec![crate::Entry {
            log_id: crate::LogId::new(openraft::CommittedLeaderId::new(7, 1), 0),
            payload: EntryPayload::Membership(openraft::Membership::new(
                vec![[1, 2, 3].into()],
                peers,
            )),
        }],
    });
    assert_eq!(config.request_valid(1, 2, &rpc), Err(Error::Authentication));
}

#[tokio::test]
async fn changed_discovered_endpoint_is_never_dialed() {
    use openraft::{RaftNetwork, RaftNetworkFactory};
    let config = Arc::new(fixture().remove(0));
    let mut peer = config.peers[&2].clone();
    peer.rpc_address = "127.0.0.1:1".into();
    let raft_config = openraft::Config {
        max_payload_entries: 64,
        snapshot_max_chunk_size: 64 * 1024,
        ..Default::default()
    };
    let mut network = Network::new(config.clone(), &raft_config).unwrap();
    assert!(Network::new(config, &openraft::Config::default()).is_err());
    let mut client = network.new_client(2, &peer).await;
    let response = client
        .vote(
            openraft::raft::VoteRequest {
                vote: openraft::Vote::new(7, 1),
                last_log_id: None,
            },
            openraft::network::RPCOption::new(Duration::from_secs(1)),
        )
        .await;
    assert!(response.is_err());
    assert!(!format!("{:?}", response).contains("127.0.0.1"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn outgoing_budget_is_shared_before_dial_and_cancellation_releases_the_slot() {
    use openraft::{RaftNetwork, RaftNetworkFactory};
    use tokio::io::AsyncReadExt;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut base = fixture().remove(0);
    base.peers.get_mut(&2).unwrap().rpc_address = listener.local_addr().unwrap().to_string();
    let mut limits = Limits::default();
    limits.outbound_connections = 1;
    limits.rpc_deadline = Duration::from_secs(2);
    let config = Arc::new(
        Config::new(
            base.binding.clone(),
            base.peers.clone(),
            base.identity.clone(),
            limits,
        )
        .unwrap(),
    );
    let options = openraft::Config {
        max_payload_entries: 64,
        snapshot_max_chunk_size: 64 * 1024,
        ..Default::default()
    };
    let mut factory = Network::new(config.clone(), &options).unwrap();
    let mut first = factory.new_client(2, &config.peers[&2]).await;
    let mut second = factory.clone().new_client(2, &config.peers[&2]).await;
    let mut third = factory.clone().new_client(2, &config.peers[&2]).await;
    let (one, ready_one) = tokio::sync::oneshot::channel();
    let (two, ready_two) = tokio::sync::oneshot::channel();
    let (three, ready_three) = tokio::sync::oneshot::channel();
    let acceptor = tokio::spawn(async move {
        let mut accepted = 0;
        for ready in [one, two, three] {
            let (mut stream, _) = tokio::time::timeout(Duration::from_secs(3), listener.accept())
                .await
                .unwrap()
                .unwrap();
            accepted += 1;
            ready.send(()).unwrap();
            // Deliberately never complete the Noise handshake. Only a bounded
            // public hello/handshake can be sent before application bytes.
            let read = async {
                let mut total = 0;
                let mut buffer = [0; 1024];
                loop {
                    let n = stream.read(&mut buffer).await.unwrap();
                    if n == 0 {
                        break;
                    }
                    total += n;
                    assert!(total <= 1024);
                }
            };
            tokio::time::timeout(Duration::from_secs(3), read)
                .await
                .unwrap();
        }
        accepted
    });
    let request = || openraft::raft::VoteRequest {
        vote: openraft::Vote::new(7, 1),
        last_log_id: None,
    };
    let options = || openraft::network::RPCOption::new(Duration::from_secs(2));
    let waiting = tokio::spawn(async move { first.vote(request(), options()).await });
    tokio::time::timeout(Duration::from_secs(1), ready_one)
        .await
        .unwrap()
        .unwrap();
    let refusal = tokio::time::timeout(
        Duration::from_millis(100),
        second.vote(request(), options()),
    )
    .await
    .unwrap();
    assert!(refusal.is_err());
    assert!(format!("{:?}", refusal).contains("budget exceeded"));
    assert_eq!(config.outbound.available_permits(), 0);
    waiting.abort();
    assert!(waiting.await.unwrap_err().is_cancelled());
    assert_eq!(config.outbound.available_permits(), 1);
    let waiting = tokio::spawn(async move { third.vote(request(), options()).await });
    tokio::time::timeout(Duration::from_secs(1), ready_two)
        .await
        .unwrap()
        .unwrap();
    let deadline = tokio::time::timeout(Duration::from_secs(3), waiting)
        .await
        .unwrap()
        .unwrap();
    assert!(deadline.is_err());
    assert!(format!("{:?}", deadline).contains("deadline exceeded"));
    assert_eq!(config.outbound.available_permits(), 1);
    let mut fourth = factory.new_client(2, &config.peers[&2]).await;
    let waiting = tokio::spawn(async move { fourth.vote(request(), options()).await });
    tokio::time::timeout(Duration::from_secs(1), ready_three)
        .await
        .unwrap()
        .unwrap();
    waiting.abort();
    assert!(waiting.await.unwrap_err().is_cancelled());
    assert_eq!(config.outbound.available_permits(), 1);
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), acceptor)
            .await
            .unwrap()
            .unwrap(),
        3
    );
}

#[test]
fn private_identity_persists_without_overwrite_regeneration_or_symlink_fallback() {
    let root = tempfile::Builder::new()
        .prefix("wabi-consensus-key-")
        .tempdir()
        .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    assert!(Identity::load(root.path()).is_err());
    assert!(!root.path().join("recovery.key").exists());
    let identity = Identity::generate().unwrap();
    identity.persist_new(root.path()).unwrap();
    assert_eq!(
        Identity::load(root.path()).unwrap().public_hex(),
        identity.public_hex()
    );
    assert!(Identity::generate()
        .unwrap()
        .persist_new(root.path())
        .is_err());
    assert_eq!(
        Identity::load(root.path()).unwrap().public_hex(),
        identity.public_hex()
    );
    std::fs::write(root.path().join("recovery.key"), [0; 31]).unwrap();
    assert!(Identity::load(root.path()).is_err());
    assert_eq!(
        std::fs::metadata(root.path().join("recovery.key"))
            .unwrap()
            .len(),
        31
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::{symlink, PermissionsExt};
        std::fs::remove_file(root.path().join("recovery.key")).unwrap();
        let elsewhere = tempfile::NamedTempFile::new().unwrap();
        symlink(elsewhere.path(), root.path().join("recovery.key")).unwrap();
        assert!(Identity::load(root.path()).is_err());
        assert!(identity.persist_new(root.path()).is_err());
        std::fs::remove_file(root.path().join("recovery.key")).unwrap();
        identity.persist_new(root.path()).unwrap();
        let duplicate = root.path().join("duplicate.key");
        std::fs::hard_link(root.path().join("recovery.key"), &duplicate).unwrap();
        assert!(Identity::load(root.path()).is_err());
        std::fs::remove_file(duplicate).unwrap();
        assert_eq!(
            Identity::load(root.path()).unwrap().public_hex(),
            identity.public_hex()
        );
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(Identity::load(root.path()).is_err());
        assert!(Identity::generate()
            .unwrap()
            .persist_new(root.path())
            .is_err());
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::set_permissions(
            root.path().join("recovery.key"),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        assert!(Identity::load(root.path()).is_err());
    }
}

/// One actual listening RPC handler and durable store. The Raft node is never
/// initialized as a community leader; tests submit only bounded peer RPCs.
struct HandlerFixture {
    root: tempfile::TempDir,
    store: crate::store::Store,
    raft: openraft::Raft<crate::ConsensusTypes>,
    clients: Vec<Config>,
    address: std::net::SocketAddr,
    stop: tokio::sync::oneshot::Sender<()>,
    task: tokio::task::JoinHandle<Result<ServerReport>>,
}
impl HandlerFixture {
    async fn start(deadline: Duration, inbound: usize) -> Self {
        let root = tempfile::Builder::new()
            .prefix("wabi-consensus-handler-")
            .tempdir()
            .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let clients = fixture();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let mut server = clients[1].clone().with_bind_address(address).unwrap();
        server.limits.rpc_deadline = deadline;
        server.limits.inbound_connections = inbound;
        let server = Arc::new(server);
        let raft_config = Arc::new(
            openraft::Config {
                max_payload_entries: 64,
                snapshot_max_chunk_size: 64 * 1024,
                ..Default::default()
            }
            .validate()
            .unwrap(),
        );
        let store = crate::store::Store::open(
            root.path(),
            server.binding.clone(),
            crate::store::StoreLimits::default(),
        )
        .unwrap();
        let raft = openraft::Raft::new(
            2,
            raft_config.clone(),
            Network::new(server.clone(), &raft_config).unwrap(),
            store.clone(),
            store.clone(),
        )
        .await
        .unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let actor = raft.clone();
        let task = tokio::spawn(async move { serve(listener, actor, server, stopped).await });
        Self {
            root,
            store,
            raft,
            clients,
            address,
            stop,
            task,
        }
    }
    async fn connect(&self, source: usize) -> channel::Channel<tokio::net::TcpStream> {
        let stream = tokio::net::TcpStream::connect(self.address).await.unwrap();
        tokio::time::timeout(
            Duration::from_secs(1),
            self.clients[source].connect(stream, 2),
        )
        .await
        .unwrap()
        .unwrap()
    }
    async fn finish(self) -> ServerReport {
        let Self {
            root,
            store,
            raft,
            clients,
            address,
            stop,
            task,
        } = self;
        let _ = stop.send(());
        let report = tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), raft.shutdown())
            .await
            .unwrap()
            .unwrap();
        drop(raft);
        drop(store);
        drop(clients);
        // No handler can retain the owned listener after serve returns.
        assert!(tokio::net::TcpStream::connect(address).await.is_err());
        root.close().unwrap();
        report
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actual_handler_rejects_authenticated_forged_sender_and_changed_membership_before_raft() {
    use openraft::{storage::RaftLogStorage, EntryPayload, Vote};
    let mut server = HandlerFixture::start(Duration::from_secs(2), 4).await;
    let requests = [
        rpc::Request::Vote(openraft::raft::VoteRequest {
            vote: Vote::new(7, 3),
            last_log_id: None,
        }),
        {
            let mut peers = server.clients[0].peers.clone();
            peers.get_mut(&3).unwrap().public_key = Identity::generate().unwrap().public_hex();
            rpc::Request::Append(openraft::raft::AppendEntriesRequest {
                vote: Vote::new_committed(7, 1),
                prev_log_id: None,
                leader_commit: None,
                entries: vec![crate::Entry {
                    log_id: crate::LogId::new(openraft::CommittedLeaderId::new(7, 1), 0),
                    payload: EntryPayload::Membership(openraft::Membership::new(
                        vec![[1, 2, 3].into()],
                        peers,
                    )),
                }],
            })
        },
        rpc::Request::Append(openraft::raft::AppendEntriesRequest {
            vote: Vote::new_committed(7, 1),
            prev_log_id: None,
            leader_commit: None,
            entries: vec![crate::Entry {
                log_id: crate::LogId::new(openraft::CommittedLeaderId::new(7, 1), 0),
                payload: EntryPayload::Normal(crate::model::ControlCommand {
                    operation_id: "01".repeat(16),
                    partition_id: "room:fixture".into(),
                    expected_epoch: u64::MAX,
                    proposed_writer: 1,
                    checkpoint_inventory_sha256: "cd".repeat(32),
                }),
            }],
        }),
        rpc::Request::Snapshot(openraft::raft::InstallSnapshotRequest {
            vote: Vote::new_committed(7, 1),
            meta: openraft::SnapshotMeta {
                last_log_id: None,
                last_membership: openraft::StoredMembership::new(
                    None,
                    openraft::Membership::new(
                        vec![[1, 2, 3].into()],
                        server.clients[0].peers.clone(),
                    ),
                ),
                snapshot_id: "handler-fixture".into(),
            },
            offset: 0,
            data: vec![0; 64 * 1024 + 1],
            done: false,
        }),
    ];
    for request in requests {
        let mut peer = server.connect(0).await;
        peer.send(&serde_json::to_vec(&request).unwrap())
            .await
            .unwrap();
        assert!(tokio::time::timeout(Duration::from_secs(1), peer.receive())
            .await
            .unwrap()
            .is_err());
        // Identity authentication succeeded; denial at the actual handler
        // must still leave Raft's durable vote/log state untouched.
        assert!(server.store.read_vote().await.unwrap().is_none());
        assert!(server
            .store
            .get_log_state()
            .await
            .unwrap()
            .last_log_id
            .is_none());
    }
    let report = server.finish().await;
    assert_eq!(report.authenticated_rpcs, 0);
    assert_eq!(report.refused_connections, 4);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actual_handler_accepts_only_key_bound_raft_sender_and_refuses_plaintext_probe() {
    use openraft::{storage::RaftLogStorage, Vote};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut server = HandlerFixture::start(Duration::from_secs(2), 4).await;
    let mut probe = tokio::net::TcpStream::connect(server.address)
        .await
        .unwrap();
    probe.write_all(&[b'x'; 118]).await.unwrap();
    probe.shutdown().await.unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), probe.read(&mut [0]))
            .await
            .unwrap()
            .unwrap(),
        0
    );
    drop(probe);
    let mut peer = server.connect(0).await;
    let request = rpc::Request::Vote(openraft::raft::VoteRequest {
        vote: Vote::new(7, 1),
        last_log_id: None,
    });
    peer.send(&serde_json::to_vec(&request).unwrap())
        .await
        .unwrap();
    let bytes = tokio::time::timeout(Duration::from_secs(1), peer.receive())
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        serde_json::from_slice::<rpc::RemoteResponse>(&bytes).unwrap(),
        rpc::RemoteResponse::Vote(_)
    ));
    assert_eq!(
        server.store.read_vote().await.unwrap(),
        Some(Vote::new(7, 1))
    );
    // One RPC per connection: wait for the actual task's stream drop rather
    // than assume that receiving its response also observed task completion.
    assert!(tokio::time::timeout(Duration::from_secs(1), peer.receive())
        .await
        .unwrap()
        .is_err());
    drop(peer);
    let report = server.finish().await;
    assert_eq!(report.authenticated_rpcs, 1);
    assert_eq!(report.refused_connections, 1);
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ordinary_raft_listener_refuses_checkpoint_service_without_any_store_write() {
    use openraft::storage::RaftLogStorage;
    let mut server = HandlerFixture::start(Duration::from_secs(2), 4).await;
    let mut peer = server.connect(0).await;
    let request = rpc::Request::Material(material::MaterialRequest::CheckpointReceipt {
        manifest_sha256: "ab".repeat(32),
    });
    peer.send(&serde_json::to_vec(&request).unwrap())
        .await
        .unwrap();
    let bytes = tokio::time::timeout(Duration::from_secs(1), peer.receive())
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        serde_json::from_slice::<rpc::RemoteResponse>(&bytes).unwrap(),
        rpc::RemoteResponse::Refused
    ));
    assert!(server.store.read_vote().await.unwrap().is_none());
    assert!(server
        .store
        .get_log_state()
        .await
        .unwrap()
        .last_log_id
        .is_none());
    assert_eq!(server.finish().await.authenticated_rpcs, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actual_handler_caps_stalled_connections_and_shutdown_drains_owned_tasks() {
    use tokio::io::AsyncReadExt;
    let server = HandlerFixture::start(Duration::from_secs(2), 2).await;
    let mut clients = Vec::new();
    for _ in 0..8 {
        clients.push(
            tokio::net::TcpStream::connect(server.address)
                .await
                .unwrap(),
        );
    }
    // Observe an actual excess-connection close before shutting down instead
    // of depending on a guessed scheduling delay for the accept loop.
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), clients[2].read(&mut [0]))
            .await
            .unwrap()
            .unwrap(),
        0
    );
    let report = server.finish().await;
    assert_eq!(report.authenticated_rpcs, 0);
    assert!(report.budget_drops >= 1);
    assert_eq!(report.aborted_connections, 2);
    drop(clients);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actual_handler_expires_incomplete_handshake_without_any_raft_write() {
    use openraft::storage::RaftLogStorage;
    use tokio::io::AsyncReadExt;
    let mut server = HandlerFixture::start(Duration::from_millis(80), 2).await;
    let mut client = tokio::net::TcpStream::connect(server.address)
        .await
        .unwrap();
    let mut byte = [0];
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), client.read(&mut byte))
            .await
            .unwrap()
            .unwrap(),
        0
    );
    assert!(server.store.read_vote().await.unwrap().is_none());
    assert!(server
        .store
        .get_log_state()
        .await
        .unwrap()
        .last_log_id
        .is_none());
    drop(client);
    let report = server.finish().await;
    assert_eq!(report.refused_connections, 1);
    assert_eq!(report.authenticated_rpcs, 0);
}
