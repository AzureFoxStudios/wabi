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
    transport::{serve_checkpoint, CheckpointAvailabilityRound, CheckpointClient, Config, Identity, Limits, MaterialService},
};

pub async fn transfer_reseed(root: &Path, producer: &MaterialStore, manifest: &CheckpointManifest) {
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
    use wabi_consensus::{RaftStateMachine, EntryPayload};
    let control_path = root.join("rpc-availability-control");
    fs::create_dir(&control_path).unwrap();
    fs::set_permissions(&control_path, fs::Permissions::from_mode(0o700)).unwrap();
    let mut control = wabi_consensus::store::Store::open(
        &control_path, producer.binding().clone(), wabi_consensus::store::StoreLimits::default(),
    ).unwrap();
    let position = wabi_consensus::LogId::new(wabi_consensus::CommittedLeaderId::new(1, 1), 1);
    control.apply([wabi_consensus::Entry { log_id: position,
        payload: EntryPayload::Membership(wabi_consensus::VoterMembership::new(vec![[1,2,3].into()], peers)),
    }]).await.unwrap();
    let local_service = MaterialService::new(producer.clone(), &configs[0], source_node.clone(), 1).unwrap();
    let mut round = CheckpointAvailabilityRound::begin(configs[0].clone(), control.clone(), &local_service,
        "c0".repeat(16), manifest, Duration::from_secs(30)).await.unwrap();
    round.refresh(1).await.unwrap();
    round.refresh(2).await.unwrap();
    let proposal = round.finish().await.unwrap();
    assert_eq!(proposal.observed_voters(), [1,2]);
    assert_eq!(proposal.manifest_sha256(), id);
    let wire = serde_json::to_value(proposal).unwrap();
    for flag in ["committed", "quorumAvailable", "fullInstanceReady", "canonicalWriterPermitted"] {
        assert_eq!(wire[flag], false);
    }
    assert!(control.control_state().await.unwrap().operations.is_empty());
    assert_eq!(control.control_state().await.unwrap().last_applied, Some(position));
    let mut surviving = CheckpointAvailabilityRound::begin(configs[0].clone(), control, &local_service,
        "c1".repeat(16), manifest, Duration::from_secs(30)).await.unwrap();
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
    assert_eq!(surviving.finish().await.unwrap().observed_voters(), [1,3]);
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
}
