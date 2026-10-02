//! Actual redb applied membership and private byte-store checks, with explicitly
//! synthetic peer observations for model invariants. The separately named Raft
//! contract below uses actual Noise sockets with opaque test bytes, not an
//! encrypted Authority export, physical sites or Wabi HA acceptance.
use super::*;
use crate::{
    model::{ControlCommand, CONTROL_PROTOCOL},
    store::StoreLimits,
    transport::material::{
        client::synthetic_test_ack,
        tests::{configs, setup},
    },
    Entry,
};
use openraft::{storage::RaftStateMachine, EntryPayload};
use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
};

fn log(index: u64) -> LogId {
    LogId::new(openraft::CommittedLeaderId::new(1, 1), index)
}
async fn install(store: &mut Store, config: &Config, index: u64) {
    store
        .apply([Entry {
            log_id: log(index),
            payload: EntryPayload::Membership(openraft::Membership::new(
                vec![[1, 2, 3].into()],
                config.peers.clone(),
            )),
        }])
        .await
        .unwrap();
}
struct Fixture {
    _material_root: tempfile::TempDir,
    _control_root: tempfile::TempDir,
    config: Arc<Config>,
    control: Store,
    service: MaterialService,
    manifest: CheckpointManifest,
    bytes: Vec<u8>,
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actual_raft_commits_checkpoint_observations_and_surviving_majority_without_third_endpoint()
{
    use crate::{
        material::{MaterialLimits, MaterialStore},
        transport::{serve_with_material, Network},
        ConsensusTypes,
    };
    use tokio::{net::TcpListener, sync::oneshot};
    let (_seed_root, seed, manifest, bytes) = setup(2);
    let bases = configs(&manifest.source.claims.community_id);
    let mut roots = Vec::new();
    let mut listeners = Vec::new();
    for _ in 0..3 {
        listeners.push(TcpListener::bind("127.0.0.1:0").await.unwrap());
    }
    let mut peers = bases[0].peers.clone();
    for (&id, peer) in &mut peers {
        peer.rpc_address = listeners[id as usize - 1].local_addr().unwrap().to_string();
    }
    let options = Arc::new(
        openraft::Config {
            cluster_name: "wabi-checkpoint-control-unit-contract".into(),
            heartbeat_interval: 100,
            election_timeout_min: 400,
            election_timeout_max: 800,
            max_payload_entries: 64,
            snapshot_max_chunk_size: 64 * 1024,
            snapshot_policy: openraft::SnapshotPolicy::LogsSinceLast(1),
            max_in_snapshot_log_to_keep: 0,
            purge_batch_size: 1,
            ..Default::default()
        }
        .validate()
        .unwrap(),
    );
    let mut configurations = BTreeMap::new();
    let mut controls = BTreeMap::new();
    let mut control_paths = BTreeMap::new();
    let mut services = BTreeMap::new();
    let mut nodes = BTreeMap::new();
    let mut stops = BTreeMap::new();
    let mut servers = BTreeMap::new();
    for (index, listener) in listeners.into_iter().enumerate() {
        let id = index as u64 + 1;
        let config = Arc::new(
            Config::new(
                bases[index].binding.clone(),
                peers.clone(),
                bases[index].identity.clone(),
                bases[index].limits.clone(),
            )
            .unwrap(),
        );
        let control_root = tempfile::tempdir().unwrap();
        fs::set_permissions(control_root.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let control = Store::open(
            control_root.path(),
            config.binding.clone(),
            StoreLimits::default(),
        )
        .unwrap();
        control_paths.insert(id, control_root.path().to_path_buf());
        roots.push(control_root);
        let material = if id == 2 {
            seed.store.clone()
        } else {
            let root = tempfile::tempdir().unwrap();
            fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
            let material = MaterialStore::open(
                root.path(),
                config.binding.clone(),
                MaterialLimits {
                    min_free_bytes: 1,
                    ..Default::default()
                },
            )
            .unwrap();
            roots.push(root);
            material
        };
        material.put_object(&manifest.objects[0], &bytes).unwrap();
        material.certify_checkpoint(&manifest, "node-1").unwrap();
        let service = MaterialService::new(material, &config, "node-1".into(), 2).unwrap();
        let node = openraft::Raft::<ConsensusTypes>::new(
            id,
            options.clone(),
            Network::new(config.clone(), &options).unwrap(),
            control.clone(),
            control.clone(),
        )
        .await
        .unwrap();
        let (stop, stopped) = oneshot::channel();
        let actor = node.clone();
        let cfg = config.clone();
        let worker = service.clone();
        servers.insert(
            id,
            tokio::spawn(async move {
                serve_with_material(listener, actor, cfg, stopped, worker).await
            }),
        );
        stops.insert(id, stop);
        nodes.insert(id, node);
        services.insert(id, service);
        controls.insert(id, control);
        configurations.insert(id, config);
    }
    nodes[&1].initialize(peers).await.unwrap();
    let leader = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let mut ready = true;
            for control in controls.values() {
                let state = control.control_state().await.unwrap();
                ready &= state
                    .membership
                    .membership()
                    .voter_ids()
                    .collect::<Vec<_>>()
                    == [1, 2, 3];
                ready &= state.membership.membership().get_joint_config().len() == 1;
            }
            if ready {
                if let Some((&id, _)) = nodes.iter().find(|(_, node)| {
                    node.metrics().borrow().state == openraft::ServerState::Leader
                }) {
                    break id;
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let failed = (1..=3).find(|id| *id != leader).unwrap();
    let survivor = (1..=3).find(|id| *id != leader && *id != failed).unwrap();
    let mut round = CheckpointAvailabilityRound::begin(
        configurations[&leader].clone(),
        controls[&leader].clone(),
        &services[&leader],
        "a1".repeat(16),
        &manifest,
        Duration::from_secs(10),
    )
    .await
    .unwrap();
    round.refresh(leader).await.unwrap();
    round.refresh(failed).await.unwrap();
    let receipt =
        serde_json::to_value(round.commit_observation(&nodes[&leader]).await.unwrap()).unwrap();
    assert_eq!(receipt["metadataCommitted"], true);
    for flag in [
        "quorumAvailable",
        "fullInstanceReady",
        "canonicalWriterPermitted",
    ] {
        assert_eq!(receipt[flag], false);
    }
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let mut records = Vec::new();
            for control in controls.values() {
                if let Some(record) = control
                    .control_state()
                    .await
                    .unwrap()
                    .checkpoints
                    .get(&"a1".repeat(16))
                {
                    records.push(record.clone());
                }
            }
            if records.len() == 3 && records.iter().all(|record| record == &records[0]) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    // Remove both the owned third listener and its actual Raft actor. Neither
    // byte ACK nor format response from that node can help the next operation.
    stops.remove(&failed).unwrap().send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), servers.remove(&failed).unwrap())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    nodes.remove(&failed).unwrap().shutdown().await.unwrap();
    let mut round = CheckpointAvailabilityRound::begin(
        configurations[&leader].clone(),
        controls[&leader].clone(),
        &services[&leader],
        "a2".repeat(16),
        &manifest,
        Duration::from_secs(10),
    )
    .await
    .unwrap();
    round.refresh(leader).await.unwrap();
    round.refresh(survivor).await.unwrap();
    assert_eq!(
        serde_json::to_value(round.commit_observation(&nodes[&leader]).await.unwrap()).unwrap()
            ["metadataCommitted"],
        true
    );
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if controls[&survivor]
                .control_state()
                .await
                .unwrap()
                .checkpoints
                .contains_key(&"a2".repeat(16))
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert!(!controls[&failed]
        .control_state()
        .await
        .unwrap()
        .checkpoints
        .contains_key(&"a2".repeat(16)));
    // Force the returning node to receive the V2 state snapshot, rather than
    // merely replaying the new checkpoint entry from a retained log prefix.
    // The owned redb store itself is closed/reopened on each restart.
    use openraft::storage::{RaftLogStorage, RaftStateMachine};
    let expected = controls[&leader].control_state().await.unwrap().checkpoints;
    let required_position = expected[&"a2".repeat(16)].reply.committed_at.unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let mut store = controls[&leader].clone();
            if store
                .get_log_state()
                .await
                .unwrap()
                .last_purged_log_id
                .is_some_and(|position| position.index >= required_position.index)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let lock = fs::metadata(control_paths[&failed].join(".lock")).unwrap();
    for _ in 0..2 {
        if let Some(stop) = stops.remove(&failed) {
            stop.send(()).unwrap();
            tokio::time::timeout(Duration::from_secs(5), servers.remove(&failed).unwrap())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
        }
        if let Some(node) = nodes.remove(&failed) {
            node.shutdown().await.unwrap();
        }
        drop(controls.remove(&failed).unwrap());
        let control = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match Store::open(
                    &control_paths[&failed],
                    configurations[&failed].binding.clone(),
                    StoreLimits::default(),
                ) {
                    Ok(store) => break store,
                    Err(crate::store::StoreError::Ownership) => {
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                    Err(error) => panic!("checkpoint voter reopen failed: {error}"),
                }
            }
        })
        .await
        .unwrap();
        let after = fs::metadata(control_paths[&failed].join(".lock")).unwrap();
        assert_eq!((lock.dev(), lock.ino()), (after.dev(), after.ino()));
        let config = configurations[&failed].clone();
        let node = openraft::Raft::<ConsensusTypes>::new(
            failed,
            options.clone(),
            Network::new(config.clone(), &options).unwrap(),
            control.clone(),
            control.clone(),
        )
        .await
        .unwrap();
        let listener = TcpListener::bind(config.local_address()).await.unwrap();
        let (stop, stopped) = oneshot::channel();
        let actor = node.clone();
        let worker = services[&failed].clone();
        servers.insert(
            failed,
            tokio::spawn(async move {
                serve_with_material(listener, actor, config, stopped, worker).await
            }),
        );
        stops.insert(failed, stop);
        nodes.insert(failed, node);
        controls.insert(failed, control);
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let state = controls[&failed].control_state().await.unwrap();
                let mut store = controls[&failed].clone();
                let snapshot = store.get_current_snapshot().await.unwrap();
                if state.checkpoints == expected
                    && snapshot.is_some_and(|snapshot| {
                        snapshot.meta.snapshot_id.starts_with("v2-")
                            && snapshot
                                .meta
                                .last_log_id
                                .is_some_and(|position| position.index >= required_position.index)
                    })
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        assert!(controls[&failed]
            .control_state()
            .await
            .unwrap()
            .checkpoints
            .values()
            .all(|record| !record.reply.canonical_writer_permitted));
    }
    for (_, stop) in stops {
        let _ = stop.send(());
    }
    for (_, server) in servers {
        tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }
    for id in [leader, survivor, failed] {
        nodes[&id].shutdown().await.unwrap();
    }
    drop(nodes);
    drop(controls);
    drop(services);
    drop(roots);
}
impl Fixture {
    async fn new() -> Self {
        let (material_root, io, manifest, bytes) = setup(1);
        io.store.put_object(&manifest.objects[0], &bytes).unwrap();
        io.store.certify_checkpoint(&manifest, "node-1").unwrap();
        let config = Arc::new(configs(&manifest.source.claims.community_id)[1].clone());
        let control_root = tempfile::tempdir().unwrap();
        fs::set_permissions(control_root.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let mut control = Store::open(
            control_root.path(),
            config.binding.clone(),
            StoreLimits::default(),
        )
        .unwrap();
        install(&mut control, &config, 1).await;
        let service = MaterialService::new(io.store, &config, "node-1".into(), 1).unwrap();
        Self {
            _material_root: material_root,
            _control_root: control_root,
            config,
            control,
            service,
            manifest,
            bytes,
        }
    }
    async fn round(&self) -> CheckpointAvailabilityRound {
        CheckpointAvailabilityRound::begin(
            self.config.clone(),
            self.control.clone(),
            &self.service,
            "ab".repeat(16),
            &self.manifest,
            Duration::from_secs(30),
        )
        .await
        .unwrap()
    }
    fn peer(&self, node: u64) -> AuthenticatedCheckpointAck {
        synthetic_test_ack(
            self.config.clone(),
            node,
            &self.manifest,
            self.service
                .io
                .store
                .checkpoint_receipt(&self.manifest.sha256().unwrap(), "node-1")
                .unwrap(),
        )
    }
}

#[tokio::test]
async fn two_distinct_observations_bind_exact_proposal_and_grant_no_permission() {
    let fixture = Fixture::new().await;
    let mut round = fixture.round().await;
    round.refresh(2).await.unwrap();
    round.observe_peer(fixture.peer(1)).unwrap();
    let proposal = round.finish().await.unwrap();
    assert_eq!(proposal.observed_voters(), [1, 2]);
    assert_eq!(
        proposal.manifest_sha256(),
        fixture.manifest.sha256().unwrap()
    );
    assert_eq!(proposal.operation_id(), "ab".repeat(16));
    let wire = serde_json::to_value(&proposal).unwrap();
    assert_eq!(
        wire["scope"],
        "uncommitted_checkpoint_availability_proposal"
    );
    assert_eq!(
        wire["membershipLogId"],
        serde_json::to_value(log(1)).unwrap()
    );
    assert_eq!(
        wire["sourceArchiveSha256"],
        fixture.manifest.source.claims.archive_sha256
    );
    assert_eq!(
        wire["sourceInventorySha256"],
        fixture.manifest.source.claims.inventory_sha256
    );
    assert_eq!(wire["requiredBytes"], fixture.bytes.len());
    assert_eq!(wire["allocation"]["kind"], "unknown");
    for flag in [
        "committed",
        "sourceRoleVerified",
        "payloadEncryptionVerified",
        "inactiveReplayVerified",
        "quorumAvailable",
        "fullInstanceReady",
        "canonicalWriterPermitted",
    ] {
        assert_eq!(wire[flag], false);
    }
    let unchanged = fixture.control.control_state().await.unwrap();
    assert!(unchanged.operations.is_empty() && unchanged.intents.is_empty());
    assert_eq!(unchanged.last_applied, Some(log(1)));
    assert_eq!(proposal.sha256().unwrap(), proposal.sha256().unwrap());
}

#[tokio::test]
async fn repeating_a_voter_never_counts_twice_or_finishes_a_minority() {
    let fixture = Fixture::new().await;
    let mut round = fixture.round().await;
    round.observe_peer(fixture.peer(1)).unwrap();
    round.observe_peer(fixture.peer(1)).unwrap();
    assert_eq!(round.observations.len(), 1);
    assert!(matches!(round.finish().await, Err(Error::Refused)));
}

#[tokio::test]
async fn failed_fresh_local_read_removes_earlier_success_and_preserves_lock() {
    use std::os::unix::fs::MetadataExt;
    let fixture = Fixture::new().await;
    let mut round = fixture.round().await;
    round.refresh(2).await.unwrap();
    round.observe_peer(fixture.peer(1)).unwrap();
    let lock = fixture._material_root.path().join(".lock");
    let before = fs::metadata(&lock).unwrap();
    let blob = fixture
        ._material_root
        .path()
        .join(format!("{}.blob", fixture.manifest.objects[0].sha256));
    // Owned test corruption; do not bypass writer admission or unlink a lock.
    fs::write(&blob, b"corruption").unwrap();
    assert!(round.refresh(2).await.is_err());
    assert!(!round.observations.contains_key(&2));
    assert!(matches!(round.finish().await, Err(Error::Refused)));
    let after = fs::metadata(lock).unwrap();
    assert_eq!((before.dev(), before.ino()), (after.dev(), after.ino()));
}

#[tokio::test]
async fn actual_applied_membership_change_invalidates_previously_observed_bytes() {
    let fixture = Fixture::new().await;
    let mut round = fixture.round().await;
    round.refresh(2).await.unwrap();
    round.observe_peer(fixture.peer(1)).unwrap();
    let mut control = fixture.control.clone();
    // Same voter values at a NEW applied membership log position still refuse
    // the original proposal; membership identity is not just voter arithmetic.
    install(&mut control, &fixture.config, 2).await;
    assert!(matches!(round.finish().await, Err(Error::Authentication)));
}

#[tokio::test]
async fn expired_round_never_returns_late_success_or_creates_an_operation() {
    let fixture = Fixture::new().await;
    let mut round = fixture.round().await;
    round.refresh(2).await.unwrap();
    round.observe_peer(fixture.peer(1)).unwrap();
    round.deadline = Instant::now() - Duration::from_millis(1);
    assert!(matches!(round.finish().await, Err(Error::Deadline)));
    assert!(fixture
        .control
        .control_state()
        .await
        .unwrap()
        .operations
        .is_empty());
}

#[tokio::test]
async fn strict_binding_operation_and_membership_admission_refuses_before_io() {
    let fixture = Fixture::new().await;
    for id in [
        "",
        "ABABABABABABABABABABABABABABABAB",
        "ab",
        "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
    ] {
        assert!(CheckpointAvailabilityRound::begin(
            fixture.config.clone(),
            fixture.control.clone(),
            &fixture.service,
            id.into(),
            &fixture.manifest,
            Duration::from_secs(30)
        )
        .await
        .is_err());
    }
    for timeout in [Duration::ZERO, Duration::from_secs(31)] {
        assert!(CheckpointAvailabilityRound::begin(
            fixture.config.clone(),
            fixture.control.clone(),
            &fixture.service,
            "ab".repeat(16),
            &fixture.manifest,
            timeout
        )
        .await
        .is_err());
    }
    let mut wrong = (*fixture.config).clone();
    wrong.binding.node_id = 1;
    assert!(CheckpointAvailabilityRound::begin(
        Arc::new(wrong),
        fixture.control.clone(),
        &fixture.service,
        "ab".repeat(16),
        &fixture.manifest,
        Duration::from_secs(30)
    )
    .await
    .is_err());
    let mut wrong = (*fixture.config).clone();
    wrong.peers.get_mut(&3).unwrap().site_id = "changed-site".into();
    // Config's stored digest cannot substitute for comparison with actual
    // applied member records (this direct mutation is internal test-only).
    assert!(CheckpointAvailabilityRound::begin(
        Arc::new(wrong),
        fixture.control.clone(),
        &fixture.service,
        "ab".repeat(16),
        &fixture.manifest,
        Duration::from_secs(30)
    )
    .await
    .is_err());
    let mut changed = fixture.manifest.clone();
    changed.partition_id = "other/root".into();
    assert!(CheckpointAvailabilityRound::begin(
        fixture.config.clone(),
        fixture.control.clone(),
        &fixture.service,
        "ab".repeat(16),
        &changed,
        Duration::from_secs(30)
    )
    .await
    .is_err());
}

#[tokio::test]
async fn joint_membership_learners_and_uninitialized_membership_refuse() {
    let fixture = Fixture::new().await;
    for (index, groups, nodes) in [
        (
            2,
            vec![[1, 2, 3].into(), [1, 2].into()],
            fixture.config.peers.clone(),
        ),
        (3, vec![[1, 2].into()], fixture.config.peers.clone()),
    ] {
        let mut control = fixture.control.clone();
        control
            .apply([Entry {
                log_id: log(index),
                payload: EntryPayload::Membership(openraft::Membership::new(groups, nodes)),
            }])
            .await
            .unwrap();
        assert!(CheckpointAvailabilityRound::begin(
            fixture.config.clone(),
            control,
            &fixture.service,
            "ab".repeat(16),
            &fixture.manifest,
            Duration::from_secs(30)
        )
        .await
        .is_err());
    }
    let mut extra = fixture.config.peers.clone();
    let mut learner = extra[&3].clone();
    learner.site_id = "learner4".into();
    learner.protocol = CONTROL_PROTOCOL;
    extra.insert(4, learner);
    let mut control = fixture.control.clone();
    control
        .apply([Entry {
            log_id: log(4),
            payload: EntryPayload::Membership(openraft::Membership::new(
                vec![[1, 2, 3].into()],
                extra,
            )),
        }])
        .await
        .unwrap();
    assert!(CheckpointAvailabilityRound::begin(
        fixture.config.clone(),
        control,
        &fixture.service,
        "ab".repeat(16),
        &fixture.manifest,
        Duration::from_secs(30)
    )
    .await
    .is_err());
    let empty = tempfile::tempdir().unwrap();
    fs::set_permissions(empty.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let store = Store::open(
        empty.path(),
        fixture.config.binding.clone(),
        StoreLimits::default(),
    )
    .unwrap();
    assert!(CheckpointAvailabilityRound::begin(
        fixture.config.clone(),
        store,
        &fixture.service,
        "ab".repeat(16),
        &fixture.manifest,
        Duration::from_secs(30)
    )
    .await
    .is_err());
}

#[tokio::test]
async fn a_different_command_using_the_operation_identity_invalidates_finish() {
    let fixture = Fixture::new().await;
    let mut round = fixture.round().await;
    round.refresh(2).await.unwrap();
    round.observe_peer(fixture.peer(1)).unwrap();
    let mut control = fixture.control.clone();
    control
        .apply([Entry {
            log_id: log(2),
            payload: EntryPayload::Normal(
                ControlCommand {
                    operation_id: "ab".repeat(16),
                    partition_id: "room:example".into(),
                    expected_epoch: 0,
                    proposed_writer: 2,
                    checkpoint_inventory_sha256: "cd".repeat(32),
                }
                .into(),
            ),
        }])
        .await
        .unwrap();
    assert!(matches!(round.finish().await, Err(Error::Authentication)));
    assert!(CheckpointAvailabilityRound::begin(
        fixture.config.clone(),
        control,
        &fixture.service,
        "ab".repeat(16),
        &fixture.manifest,
        Duration::from_secs(30)
    )
    .await
    .is_err());
}

#[tokio::test]
async fn even_typed_observations_from_a_different_roster_or_manifest_refuse() {
    let fixture = Fixture::new().await;
    let mut round = fixture.round().await;
    let other = Arc::new(configs(&fixture.manifest.source.claims.community_id)[1].clone());
    let local = fixture
        .service
        .io
        .store
        .checkpoint_receipt(&fixture.manifest.sha256().unwrap(), "node-1")
        .unwrap();
    let ack = synthetic_test_ack(other, 1, &fixture.manifest, local);
    assert!(matches!(
        round.observe_peer(ack),
        Err(Error::Authentication)
    ));
    // An immutable round owns the manifest captured at begin. Even a valid
    // typed ACK is refused if its content differs from that captured identity.
    let ack = fixture.peer(1);
    round.manifest_sha256 = "de".repeat(32); // internal test-only mutation
    assert!(matches!(
        round.observe_peer(ack),
        Err(Error::Authentication)
    ));
    assert!(round.observations.is_empty());
}
