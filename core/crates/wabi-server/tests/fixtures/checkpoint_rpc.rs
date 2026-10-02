//! Actual producer ciphertext over fixed-roster loopback sockets. This is not
//! three physical sites, a process reboot, inactive replay or writer activation.
use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::Path,
    sync::Arc,
    time::Duration,
};
use tokio::{net::TcpListener, sync::oneshot};
use wabi_consensus::{
    material::{CheckpointManifest, MaterialLimits, MaterialStore},
    model::{RecoveryPeer, StoreBinding, CONTROL_PROTOCOL},
    transport::{
        serve_checkpoint, CheckpointAvailabilityRound, CheckpointClient, Config, Identity, Limits,
        MaterialService,
    },
};

pub async fn transfer_reseed(
    root: &Path,
    producer: &MaterialStore,
    manifest: &CheckpointManifest,
    source: &wabi_server::instance_archive::LiveArchiveReceipt,
    identity: &Path,
) {
    let source_node = manifest.source.claims.source_node_id.clone();
    let identities: Vec<_> = (0..3)
        .map(|_| Arc::new(Identity::generate().unwrap()))
        .collect();
    let mut listeners = Vec::new();
    for _ in 0..3 {
        listeners.push(TcpListener::bind("127.0.0.1:0").await.unwrap());
    }
    let peers: BTreeMap<_, _> = (1..=3)
        .map(|id| {
            (
                id,
                RecoveryPeer {
                    protocol: CONTROL_PROTOCOL,
                    community_id: producer.binding().community_id.clone(),
                    site_id: format!("loopback-site-{id}"),
                    public_key: identities[id as usize - 1].public_hex(),
                    rpc_address: listeners[id as usize - 1].local_addr().unwrap().to_string(),
                },
            )
        })
        .collect();
    let configs: Vec<_> = (1..=3)
        .map(|id| {
            Arc::new(
                Config::new(
                    StoreBinding {
                        node_id: id,
                        ..producer.binding().clone()
                    },
                    peers.clone(),
                    identities[id as usize - 1].clone(),
                    Limits::default(),
                )
                .unwrap(),
            )
        })
        .collect();
    let mut stores = Vec::new();
    for id in [2, 3] {
        let path = root.join(format!("rpc-material-{id}"));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        stores.push(
            MaterialStore::open(
                &path,
                StoreBinding {
                    node_id: id,
                    ..producer.binding().clone()
                },
                MaterialLimits {
                    min_free_bytes: 1,
                    ..Default::default()
                },
            )
            .unwrap(),
        );
    }
    let mut listeners = listeners.into_iter();
    drop(listeners.next().unwrap());
    let mut tasks = Vec::new();
    let mut stops = Vec::new();
    for (index, listener) in listeners.enumerate() {
        let (stop, stopped) = oneshot::channel();
        let config = configs[index + 1].clone();
        let service =
            MaterialService::new(stores[index].clone(), &config, source_node.clone(), 1).unwrap();
        tasks.push(tokio::spawn(async move {
            serve_checkpoint(listener, config, stopped, service).await
        }));
        stops.push(stop);
    }
    let to_two = CheckpointClient::new(configs[0].clone(), 2, source_node.clone()).unwrap();
    let to_three = CheckpointClient::new(configs[0].clone(), 3, source_node.clone()).unwrap();
    let id = manifest.sha256().unwrap();
    assert!(to_two.certify(manifest).await.is_err());
    let mut transfer_bytes = 0u64;
    for (index, object) in manifest.objects.iter().enumerate() {
        let (actual, bytes) = producer
            .read_checkpoint_object(&id, &source_node, index)
            .unwrap();
        assert_eq!(&actual, object);
        transfer_bytes += bytes.len() as u64;
        to_two.put_object(actual, &bytes).await.unwrap();
    }
    assert_eq!(transfer_bytes, manifest.source.claims.ciphertext_bytes);
    let two = to_two.certify(manifest).await.unwrap();
    assert_eq!(two.target_node_id(), 2);
    assert_eq!(two.manifest_sha256(), id);
    let retrieved = to_two.read_manifest(&id).await.unwrap();
    assert_eq!(&retrieved, manifest);
    to_two.fresh_receipt(&retrieved).await.unwrap();
    for (index, object) in retrieved.objects.iter().enumerate() {
        let bytes = to_two.read_object(&retrieved, index).await.unwrap();
        to_three.put_object(object.clone(), &bytes).await.unwrap();
    }
    let three = to_three.certify(&retrieved).await.unwrap();
    assert_eq!(three.target_node_id(), 3);
    for ack in [two, three] {
        let wire = serde_json::to_value(ack).unwrap();
        for flag in [
            "sourceRoleVerified",
            "payloadEncryptionVerified",
            "inactiveReplayVerified",
            "quorumAvailable",
            "fullInstanceReady",
            "canonicalWriterPermitted",
        ] {
            assert_eq!(wire["receipt"][flag], false);
        }
        assert_eq!(wire["receipt"]["allocation"]["kind"], "unknown");
    }
    // Actual applied control membership, actual producer bytes and fresh Noise
    // receipts. This builds a proposal ONLY; no availability command is logged.
    use wabi_consensus::{EntryPayload, RaftStateMachine};
    let control_path = root.join("rpc-availability-control");
    fs::create_dir(&control_path).unwrap();
    fs::set_permissions(&control_path, fs::Permissions::from_mode(0o700)).unwrap();
    let mut control = wabi_consensus::store::Store::open(
        &control_path,
        producer.binding().clone(),
        wabi_consensus::store::StoreLimits::default(),
    )
    .unwrap();
    let position = wabi_consensus::LogId::new(wabi_consensus::CommittedLeaderId::new(1, 1), 1);
    control
        .apply([wabi_consensus::Entry {
            log_id: position,
            payload: EntryPayload::Membership(wabi_consensus::VoterMembership::new(
                vec![[1, 2, 3].into()],
                peers,
            )),
        }])
        .await
        .unwrap();
    let local_service =
        MaterialService::new(producer.clone(), &configs[0], source_node.clone(), 1).unwrap();
    let mut round = CheckpointAvailabilityRound::begin(
        configs[0].clone(),
        control.clone(),
        &local_service,
        "c0".repeat(16),
        manifest,
        Duration::from_secs(30),
    )
    .await
    .unwrap();
    round.refresh(1).await.unwrap();
    round.refresh(2).await.unwrap();
    let proposal = round.finish().await.unwrap();
    assert_eq!(proposal.observed_voters(), [1, 2]);
    assert_eq!(proposal.manifest_sha256(), id);
    let wire = serde_json::to_value(proposal).unwrap();
    for flag in [
        "committed",
        "quorumAvailable",
        "fullInstanceReady",
        "canonicalWriterPermitted",
    ] {
        assert_eq!(wire[flag], false);
    }
    assert!(control.control_state().await.unwrap().operations.is_empty());
    assert_eq!(
        control.control_state().await.unwrap().last_applied,
        Some(position)
    );
    let mut surviving = CheckpointAvailabilityRound::begin(
        configs[0].clone(),
        control,
        &local_service,
        "c1".repeat(16),
        manifest,
        Duration::from_secs(30),
    )
    .await
    .unwrap();
    surviving.refresh(1).await.unwrap();
    surviving.refresh(2).await.unwrap();
    // Stop only the owned copy endpoint and await its IO drain. Lose its exact
    // immutable ciphertext/manifest files; preserve binding/key/lock inode.
    stops.remove(0).send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(3), tasks.remove(0))
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(to_two.fresh_receipt(manifest).await.is_err());
    // Failed fresh recheck removes the earlier node-2 success; the remaining
    // real local copy and node3 can supply distinct fresh observations.
    assert!(surviving.refresh(2).await.is_err());
    surviving.refresh(3).await.unwrap();
    assert_eq!(surviving.finish().await.unwrap().observed_voters(), [1, 3]);
    let node_two = root.join("rpc-material-2");
    let lock_before = fs::metadata(node_two.join(".lock")).unwrap();
    let unique: std::collections::BTreeSet<_> = manifest
        .objects
        .iter()
        .map(|object| &object.sha256)
        .collect();
    for hash in unique {
        fs::remove_file(node_two.join(format!("{hash}.blob"))).unwrap();
    }
    fs::remove_file(node_two.join(format!("{id}.checkpoint.json"))).unwrap();
    assert!(stores[0].checkpoint_receipt(&id, &source_node).is_err());
    let listener = TcpListener::bind(configs[1].local_address()).await.unwrap();
    let (stop, stopped) = oneshot::channel();
    let config = configs[1].clone();
    let service = MaterialService::new(stores[0].clone(), &config, source_node.clone(), 1).unwrap();
    let restarted =
        tokio::spawn(async move { serve_checkpoint(listener, config, stopped, service).await });
    assert!(to_two.fresh_receipt(manifest).await.is_err());
    let survived = to_three.read_manifest(&id).await.unwrap();
    to_three.fresh_receipt(&survived).await.unwrap();
    for (index, object) in survived.objects.iter().enumerate() {
        to_two
            .put_object(
                object.clone(),
                &to_three.read_object(&survived, index).await.unwrap(),
            )
            .await
            .unwrap();
    }
    to_two.certify(&survived).await.unwrap();
    to_two.fresh_receipt(manifest).await.unwrap();
    let lock_after = fs::metadata(node_two.join(".lock")).unwrap();
    assert_eq!(
        (lock_before.dev(), lock_before.ino()),
        (lock_after.dev(), lock_after.ino())
    );
    stop.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(3), restarted)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    stops.remove(0).send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(3), tasks.remove(0))
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    drop(stores);
    commit_producer_observation(root, producer, manifest, source, identity).await;
}

/// Genuine encrypted Authority output on three actual disk-backed Raft nodes.
/// Historical observation only; no inactive replay, Wabi HA or writer grant.
async fn commit_producer_observation(
    root: &Path,
    producer: &MaterialStore,
    manifest: &CheckpointManifest,
    source: &wabi_server::instance_archive::LiveArchiveReceipt,
    identity: &Path,
) {
    use wabi_consensus::{
        store::{Store, StoreLimits},
        transport::{serve_with_material, Network},
        ConsensusTypes,
    };
    let mut listeners = Vec::new();
    let mut identities = Vec::new();
    for _ in 0..3 {
        listeners.push(TcpListener::bind("127.0.0.1:0").await.unwrap());
        identities.push(Arc::new(Identity::generate().unwrap()));
    }
    let source_node = manifest.source.claims.source_node_id.clone();
    let peers: BTreeMap<_, _> = (1..=3)
        .map(|id| {
            (
                id,
                RecoveryPeer {
                    protocol: CONTROL_PROTOCOL,
                    community_id: producer.binding().community_id.clone(),
                    site_id: format!("raft-loopback-site-{id}"),
                    public_key: identities[id as usize - 1].public_hex(),
                    rpc_address: listeners[id as usize - 1].local_addr().unwrap().to_string(),
                },
            )
        })
        .collect();
    let options = Arc::new(
        wabi_consensus::RaftConfig {
            cluster_name: "wabi-producer-observation-contract".into(),
            heartbeat_interval: 100,
            election_timeout_min: 400,
            election_timeout_max: 800,
            max_payload_entries: 64,
            snapshot_max_chunk_size: 64 * 1024,
            ..Default::default()
        }
        .validate()
        .unwrap(),
    );
    let mut configs = BTreeMap::new();
    let mut controls = BTreeMap::new();
    let mut materials = BTreeMap::new();
    let mut services = BTreeMap::new();
    let mut rafts = BTreeMap::new();
    let mut stops = BTreeMap::new();
    let mut servers = BTreeMap::new();
    for (index, listener) in listeners.into_iter().enumerate() {
        let id = index as u64 + 1;
        let binding = StoreBinding {
            node_id: id,
            ..producer.binding().clone()
        };
        let config = Arc::new(
            Config::new(
                binding.clone(),
                peers.clone(),
                identities[index].clone(),
                Limits::default(),
            )
            .unwrap(),
        );
        let control_path = root.join(format!("rpc-committed-control-{id}"));
        fs::create_dir(&control_path).unwrap();
        fs::set_permissions(&control_path, fs::Permissions::from_mode(0o700)).unwrap();
        let control = Store::open(&control_path, binding.clone(), StoreLimits::default()).unwrap();
        let material = if id == 1 {
            producer.clone()
        } else {
            let path = root.join(format!("rpc-committed-material-{id}"));
            fs::create_dir(&path).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            MaterialStore::open(
                &path,
                binding,
                MaterialLimits {
                    min_free_bytes: 1,
                    ..Default::default()
                },
            )
            .unwrap()
        };
        let service =
            MaterialService::new(material.clone(), &config, source_node.clone(), 2).unwrap();
        let raft = wabi_consensus::Raft::<ConsensusTypes>::new(
            id,
            options.clone(),
            Network::new(config.clone(), &options).unwrap(),
            control.clone(),
            control.clone(),
        )
        .await
        .unwrap();
        let (stop, stopped) = oneshot::channel();
        let actor = raft.clone();
        let cfg = config.clone();
        let worker = service.clone();
        servers.insert(
            id,
            tokio::spawn(async move {
                serve_with_material(listener, actor, cfg, stopped, worker).await
            }),
        );
        stops.insert(id, stop);
        configs.insert(id, config);
        controls.insert(id, control);
        materials.insert(id, material);
        services.insert(id, service);
        rafts.insert(id, raft);
    }
    rafts[&1].initialize(peers.clone()).await.unwrap();
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
                if let Some((&id, _)) = rafts.iter().find(|(_, raft)| {
                    raft.metrics().borrow().state == wabi_consensus::ServerState::Leader
                }) {
                    break id;
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    let hash = manifest.sha256().unwrap();
    for id in [2, 3] {
        let client = CheckpointClient::new(configs[&1].clone(), id, source_node.clone()).unwrap();
        for (index, object) in manifest.objects.iter().enumerate() {
            let (actual, bytes) = producer
                .read_checkpoint_object(&hash, &source_node, index)
                .unwrap();
            assert_eq!(&actual, object);
            client.put_object(actual, &bytes).await.unwrap();
        }
        client.certify(manifest).await.unwrap();
    }
    // An enrolled Raft service without the format/material capability must
    // refuse the INITIAL transition, even though two real copies are healthy.
    // This tests an unsupported service, not a separately compiled V1 binary.
    let unsupported = if leader == 2 { 3 } else { 2 };
    let healthy = (1..=3)
        .find(|id| *id != leader && *id != unsupported)
        .unwrap();
    for enabled in [false, true] {
        stops.remove(&unsupported).unwrap().send(()).unwrap();
        tokio::time::timeout(
            Duration::from_secs(5),
            servers.remove(&unsupported).unwrap(),
        )
        .await
        .unwrap()
        .unwrap()
        .unwrap();
        let listener = TcpListener::bind(configs[&unsupported].local_address())
            .await
            .unwrap();
        let (stop, stopped) = oneshot::channel();
        let actor = rafts[&unsupported].clone();
        let cfg = configs[&unsupported].clone();
        if enabled {
            // Stopping the first material listener drains and permanently
            // closes its shared generation. A clone is not a restarted worker.
            // Keep the old generation's refusal, then construct a new service
            // over the same bound store instead of reopening its admission.
            let mut closed_round = CheckpointAvailabilityRound::begin(
                configs[&unsupported].clone(),
                controls[&unsupported].clone(),
                &services[&unsupported],
                "ce".repeat(16),
                manifest,
                Duration::from_secs(10),
            )
            .await
            .unwrap();
            assert!(matches!(
                closed_round.refresh(unsupported).await,
                Err(wabi_consensus::transport::Error::Refused)
            ));
            services.insert(
                unsupported,
                MaterialService::new(
                    materials[&unsupported].clone(),
                    &configs[&unsupported],
                    source_node.clone(),
                    2,
                )
                .unwrap(),
            );
        }
        let worker = services[&unsupported].clone();
        servers.insert(
            unsupported,
            tokio::spawn(async move {
                if enabled {
                    serve_with_material(listener, actor, cfg, stopped, worker).await
                } else {
                    wabi_consensus::transport::serve(listener, actor, cfg, stopped).await
                }
            }),
        );
        stops.insert(unsupported, stop);
        if !enabled {
            let mut unsupported_round = CheckpointAvailabilityRound::begin(
                configs[&leader].clone(),
                controls[&leader].clone(),
                &services[&leader],
                "cf".repeat(16),
                manifest,
                Duration::from_secs(10),
            )
            .await
            .unwrap();
            unsupported_round.refresh(leader).await.unwrap();
            unsupported_round.refresh(healthy).await.unwrap();
            assert!(unsupported_round
                .commit_observation(&rafts[&leader])
                .await
                .is_err());
            assert!(!controls[&leader]
                .control_state()
                .await
                .unwrap()
                .checkpoints
                .contains_key(&"cf".repeat(16)));
        }
    }
    let operation = "d0".repeat(16);
    let mut round = CheckpointAvailabilityRound::begin(
        configs[&leader].clone(),
        controls[&leader].clone(),
        &services[&leader],
        operation.clone(),
        manifest,
        Duration::from_secs(30),
    )
    .await
    .unwrap();
    round.refresh(1).await.unwrap();
    round.refresh(2).await.unwrap();
    let receipt = round.commit_observation(&rafts[&leader]).await.unwrap();
    let receipt = serde_json::to_value(receipt).unwrap();
    assert_eq!(receipt["metadataCommitted"], true);
    assert_eq!(receipt["manifestSha256"], hash);
    for flag in [
        "quorumAvailable",
        "fullInstanceReady",
        "canonicalWriterPermitted",
    ] {
        assert_eq!(receipt[flag], false);
    }
    let original = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let mut records = Vec::new();
            for control in controls.values() {
                if let Some(record) = control
                    .control_state()
                    .await
                    .unwrap()
                    .checkpoints
                    .get(&operation)
                {
                    records.push(record.clone());
                }
            }
            if records.len() == 3 && records.iter().all(|r| r == &records[0]) {
                break records.remove(0);
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(original.command.manifest_sha256(), hash);
    assert_eq!(
        original.command.fingerprint().unwrap(),
        receipt["commandFingerprint"].as_str().unwrap()
    );
    assert_eq!(
        serde_json::to_value(original.reply.committed_at.unwrap()).unwrap(),
        receipt["committedAt"]
    );
    // A retry through the actual Raft returns the ORIGINAL durable position.
    let retry = rafts[&leader]
        .client_write(wabi_consensus::model::ControlData::Checkpoint(
            original.command.clone(),
        ))
        .await
        .unwrap();
    assert_eq!(retry.data, original.reply);
    // Recover from authenticated peer bytes, independently of the source's
    // live data tree. This core-only verifier cannot promote the restored copy.
    // Nodes 2/3 received the capture over Noise; never fetch this proof from
    // the producer's original local material store at node 1.
    let recovery_peer = (2..=3).find(|id| *id != leader).unwrap();
    let recovery =
        CheckpointClient::new(configs[&leader].clone(), recovery_peer, source_node.clone())
            .unwrap();
    super::checkpoint_peer_verify::verify(&recovery, manifest, source, identity).await;
    // Lose exact owned remote bytes after a successful earlier observation.
    // A fresh submission refuses and leaves its operation ID unresolved.
    let lost = if leader == 2 { 3 } else { 2 };
    let mut round = CheckpointAvailabilityRound::begin(
        configs[&leader].clone(),
        controls[&leader].clone(),
        &services[&leader],
        "d1".repeat(16),
        manifest,
        Duration::from_secs(30),
    )
    .await
    .unwrap();
    round.refresh(leader).await.unwrap();
    round.refresh(lost).await.unwrap();
    let blob = root
        .join(format!("rpc-committed-material-{lost}"))
        .join(format!("{}.blob", manifest.objects[0].sha256));
    fs::remove_file(&blob).unwrap();
    assert!(round.commit_observation(&rafts[&leader]).await.is_err());
    assert!(!controls[&leader]
        .control_state()
        .await
        .unwrap()
        .checkpoints
        .contains_key(&"d1".repeat(16)));
    let (_, bytes) = producer
        .read_checkpoint_object(&hash, &source_node, 0)
        .unwrap();
    materials[&lost]
        .put_object(&manifest.objects[0], &bytes)
        .unwrap();
    // Metadata already committed above does not by itself recreate the bytes.
    materials[&lost]
        .checkpoint_receipt(&hash, &source_node)
        .unwrap();
    // One Raft voter is unavailable. The remaining two must commit through
    // actual consensus after the durable format transition, with fresh bytes.
    rafts[&lost].shutdown().await.unwrap();
    let survivor = (1..=3).find(|id| *id != lost && *id != leader).unwrap();
    let mut round = CheckpointAvailabilityRound::begin(
        configs[&leader].clone(),
        controls[&leader].clone(),
        &services[&leader],
        "d3".repeat(16),
        manifest,
        Duration::from_secs(10),
    )
    .await
    .unwrap();
    round.refresh(leader).await.unwrap();
    round.refresh(survivor).await.unwrap();
    let majority = round.commit_observation(&rafts[&leader]).await.unwrap();
    assert_eq!(
        serde_json::to_value(majority).unwrap()["metadataCommitted"],
        true
    );
    // Leave byte endpoints alive but shut down both OTHER actual Raft actors.
    // All authenticated format/byte checks can succeed; a minority still
    // cannot commit a new control record.
    rafts[&survivor].shutdown().await.unwrap();
    let mut round = CheckpointAvailabilityRound::begin(
        configs[&leader].clone(),
        controls[&leader].clone(),
        &services[&leader],
        "d2".repeat(16),
        manifest,
        Duration::from_secs(2),
    )
    .await
    .unwrap();
    round.refresh(leader).await.unwrap();
    round.refresh(lost).await.unwrap();
    assert!(round.commit_observation(&rafts[&leader]).await.is_err());
    for control in controls.values() {
        assert!(!control
            .control_state()
            .await
            .unwrap()
            .checkpoints
            .contains_key(&"d2".repeat(16)));
    }
    for (_, stop) in stops {
        let _ = stop.send(());
    }
    for (_, task) in servers {
        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }
    rafts[&leader].shutdown().await.unwrap();
    drop(rafts);
    drop(controls);
    drop(materials);
    drop(services);
}
