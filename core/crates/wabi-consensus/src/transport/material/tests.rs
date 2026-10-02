//! Codec/ownership fixtures below are opaque synthetic bytes, not an Authority
//! export. Actual encrypted producer integration lives in the server suite.
use super::*;
use crate::{material::MaterialLimits, model::StoreBinding, source_context::tests::fixture};
use std::{fs, os::unix::fs::PermissionsExt, time::Duration};

pub(super) fn setup(
    workers: usize,
) -> (tempfile::TempDir, MaterialIo, CheckpointManifest, Vec<u8>) {
    let root = tempfile::tempdir().unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let bytes = b"opaque transport worker fixture, not a real capture".to_vec();
    let source = fixture(&bytes);
    let store = MaterialStore::open(
        root.path(),
        StoreBinding {
            community_id: source.claims.community_id.clone(),
            partition_id: "community/root".into(),
            node_id: 2,
        },
        MaterialLimits {
            min_free_bytes: 1,
            ..Default::default()
        },
    )
    .unwrap();
    let object = ObjectRef {
        kind: MaterialKind::CheckpointChunk,
        sha256: hex::encode(Sha256::digest(&bytes)),
        bytes: bytes.len() as u64,
    };
    let manifest = CheckpointManifest {
        schema_version: 2,
        partition_id: "community/root".into(),
        source,
        objects: vec![object],
    };
    (
        root,
        MaterialIo::new(store, "node-1".into(), workers).unwrap(),
        manifest,
        bytes,
    )
}

pub(super) fn configs(community: &str) -> Vec<super::super::Config> {
    super::super::tests::fixture()
        .into_iter()
        .map(|base| {
            let mut binding = base.binding.clone();
            binding.community_id = community.into();
            binding.partition_id = "community/root".into();
            let mut peers = base.peers.clone();
            for peer in peers.values_mut() {
                peer.community_id = community.into();
            }
            super::super::Config::new(binding, peers, base.identity.clone(), base.limits.clone())
                .unwrap()
        })
        .collect()
}

#[test]
fn service_refuses_actual_store_identity_mismatch_before_network_admission() {
    let (_root, io, manifest, _bytes) = setup(1);
    let cfg = configs(&manifest.source.claims.community_id);
    assert!(MaterialService::new(io.store.clone(), &cfg[0], "node-1".into(), 1).is_err());
    assert!(MaterialService::new(io.store.clone(), &cfg[1], "node-1".into(), 1).is_ok());
    let mut wrong = cfg[1].clone();
    wrong.binding.partition_id = "another/root".into();
    assert!(MaterialService::new(io.store.clone(), &wrong, "node-1".into(), 1).is_err());
    wrong.binding = cfg[1].binding.clone();
    wrong.binding.community_id = "cd".repeat(32);
    assert!(MaterialService::new(io.store.clone(), &wrong, "node-1".into(), 1).is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_noise_sockets_transfer_read_reseed_and_refuse_corruption() {
    use crate::transport::{serve_checkpoint, Config};
    let (root, io, manifest, bytes) = setup(2);
    let bases = configs(&manifest.source.claims.community_id);
    let listeners = futures_free_listeners().await;
    let peers = bases[0]
        .peers
        .iter()
        .map(|(id, peer)| {
            let mut peer = peer.clone();
            peer.rpc_address = listeners[*id as usize - 1]
                .local_addr()
                .unwrap()
                .to_string();
            (*id, peer)
        })
        .collect::<std::collections::BTreeMap<_, _>>();
    let configs: Vec<_> = bases
        .iter()
        .map(|base| {
            Arc::new(
                Config::new(
                    base.binding.clone(),
                    peers.clone(),
                    base.identity.clone(),
                    base.limits.clone(),
                )
                .unwrap(),
            )
        })
        .collect();
    let mut listeners = listeners.into_iter();
    drop(listeners.next().unwrap());
    let listener = listeners.next().unwrap();
    drop(listeners.next().unwrap());
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let service = MaterialService::new(io.store.clone(), &configs[1], "node-1".into(), 2).unwrap();
    let cfg = configs[1].clone();
    let server =
        tokio::spawn(async move { serve_checkpoint(listener, cfg, stopped, service).await });
    let client = CheckpointClient::new(configs[0].clone(), 2, "node-1".into()).unwrap();
    assert!(client.certify(&manifest).await.is_err());
    client
        .put_object(manifest.objects[0].clone(), &bytes)
        .await
        .unwrap();
    let ack = client.certify(&manifest).await.unwrap();
    assert_eq!(ack.target_node_id(), 2);
    assert_eq!(ack.roster_digest(), configs[0].roster_digest());
    let id = manifest.sha256().unwrap();
    let retrieved = client.read_manifest(&id).await.unwrap();
    assert_eq!(retrieved, manifest);
    assert_eq!(client.read_object(&retrieved, 0).await.unwrap(), bytes);
    assert!(client.read_object(&retrieved, 1).await.is_err());
    assert!(client.read_manifest(&"ef".repeat(32)).await.is_err());
    let fresh = client.fresh_receipt(&manifest).await.unwrap();
    assert_eq!(fresh.manifest_sha256(), id);

    let reseed = tempfile::tempdir().unwrap();
    fs::set_permissions(reseed.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let store = MaterialStore::open(
        reseed.path(),
        configs[2].binding.clone(),
        MaterialLimits {
            min_free_bytes: 1,
            ..Default::default()
        },
    )
    .unwrap();
    for (index, object) in retrieved.objects.iter().enumerate() {
        let bytes = client.read_object(&retrieved, index).await.unwrap();
        store.put_object(object, &bytes).unwrap();
    }
    let local = store.certify_checkpoint(&retrieved, "node-1").unwrap();
    assert_eq!(local.manifest_sha256(), id);
    assert_eq!(serde_json::to_value(local).unwrap()["nodeId"], 3);

    // Approved endpoint still needs its pinned key: wrong local key fails KK.
    let mut wrong = (*configs[0]).clone();
    wrong.identity = Arc::new(crate::transport::Identity::generate().unwrap());
    let wrong = CheckpointClient::new(Arc::new(wrong), 2, "node-1".into()).unwrap();
    assert!(wrong.read_manifest(&id).await.is_err());
    let mut wrong_roster = (*configs[0]).clone();
    wrong_roster.roster_digest[0] ^= 1;
    let wrong = CheckpointClient::new(Arc::new(wrong_roster), 2, "node-1".into()).unwrap();
    assert!(wrong.read_manifest(&id).await.is_err());

    fs::write(
        root.path()
            .join(format!("{}.blob", manifest.objects[0].sha256)),
        b"damaged",
    )
    .unwrap();
    assert!(client.fresh_receipt(&manifest).await.is_err());
    assert!(client.read_object(&manifest, 0).await.is_err());
    // Signed metadata remains readable, but is explicitly not byte availability.
    assert_eq!(client.read_manifest(&id).await.unwrap(), manifest);
    stop.send(()).unwrap();
    let report = tokio::time::timeout(Duration::from_secs(3), server)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(report.authenticated_rpcs >= 10);
    assert!(report.refused_connections >= 2);
    assert_eq!(io.work.state.lock().unwrap().active, 0);
    drop(io);
    drop(store);
    reseed.close().unwrap();
    root.close().unwrap();
}

async fn futures_free_listeners() -> Vec<tokio::net::TcpListener> {
    let mut listeners = Vec::new();
    for _ in 0..3 {
        listeners.push(tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap());
    }
    listeners
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn serving_shutdown_waits_for_cancelled_blocking_worker_and_preserves_lock_inode() {
    use crate::transport::serve_checkpoint;
    use std::os::unix::fs::MetadataExt;
    let (root, initial, manifest, bytes) = setup(1);
    let cfg = configs(&manifest.source.claims.community_id).remove(1);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let config = Arc::new(
        cfg.with_bind_address(listener.local_addr().unwrap())
            .unwrap(),
    );
    let service = MaterialService::new(initial.store.clone(), &config, "node-1".into(), 1).unwrap();
    let io = service.io.clone();
    let lock_before = fs::metadata(root.path().join(".lock")).unwrap();
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, blocked) = std::sync::mpsc::channel();
    let caller = io.clone();
    let object = manifest.objects[0].clone();
    let worker = tokio::spawn(async move {
        caller
            .run(move |store| {
                started.send(()).unwrap();
                blocked.recv_timeout(Duration::from_secs(5)).unwrap();
                store.put_object(&object, &bytes).map_err(storage_error)
            })
            .await
    });
    tokio::time::timeout(Duration::from_secs(2), ready)
        .await
        .unwrap()
        .unwrap();
    worker.abort();
    assert!(worker.await.unwrap_err().is_cancelled());
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let server =
        tokio::spawn(async move { serve_checkpoint(listener, config, stopped, service).await });
    stop.send(()).unwrap();
    let mut server = std::pin::pin!(server);
    assert!(tokio::time::timeout(Duration::from_millis(30), &mut server)
        .await
        .is_err());
    assert_eq!(io.work.state.lock().unwrap().active, 1);
    assert_eq!(io.permits.available_permits(), 0);
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(2), &mut server)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(io.work.state.lock().unwrap().active, 0);
    let lock_after = fs::metadata(root.path().join(".lock")).unwrap();
    assert_eq!(
        (lock_before.dev(), lock_before.ino()),
        (lock_after.dev(), lock_after.ino())
    );
    initial
        .store
        .certify_checkpoint(&manifest, "node-1")
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn authenticated_socket_reply_cannot_substitute_another_voter_or_writer_grant() {
    use crate::transport::Config;
    let (_root, io, manifest, bytes) = setup(1);
    io.store.put_object(&manifest.objects[0], &bytes).unwrap();
    let receipt =
        serde_json::to_value(io.store.certify_checkpoint(&manifest, "node-1").unwrap()).unwrap();
    for (key, value) in [
        ("nodeId", serde_json::json!(3)),
        ("canonicalWriterPermitted", serde_json::json!(true)),
        ("requiredBytes", serde_json::json!(bytes.len() + 1)),
        ("sourceContextSha256", serde_json::json!("cd".repeat(32))),
    ] {
        let mut bases = configs(&manifest.source.claims.community_id);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let mut peers = bases[0].peers.clone();
        peers.get_mut(&2).unwrap().rpc_address = address.to_string();
        let client_config = Arc::new(
            Config::new(
                bases[0].binding.clone(),
                peers.clone(),
                bases[0].identity.clone(),
                bases[0].limits.clone(),
            )
            .unwrap(),
        );
        let base = bases.remove(1);
        let server_config = Config::new(base.binding, peers, base.identity, base.limits).unwrap();
        let mut changed = receipt.clone();
        changed[key] = value;
        let response = serde_json::to_vec(&serde_json::json!({"kind":"material", "payload":{"operation":"checkpoint", "payload":changed}})).unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (_, mut peer) = server_config.accept(stream).await.unwrap();
            peer.receive().await.unwrap();
            peer.send(&response).await.unwrap();
        });
        let client = CheckpointClient::new(client_config, 2, "node-1".into()).unwrap();
        assert_eq!(
            client.fresh_receipt(&manifest).await.unwrap_err(),
            Error::Authentication,
            "{key}"
        );
        tokio::time::timeout(Duration::from_secs(2), server)
            .await
            .unwrap()
            .unwrap();
    }
}
#[test]
fn strict_complete_object_codec_refuses_before_storage() {
    let (_root, _io, manifest, bytes) = setup(1);
    let original = &manifest.objects[0];
    assert_eq!(object_bytes(original, &hex::encode(&bytes)).unwrap(), bytes);
    for fault in ["uppercase", "odd", "hash", "length", "kind", "oversized"] {
        let mut object = original.clone();
        let mut encoded = hex::encode(&bytes);
        match fault {
            "uppercase" => encoded = encoded.to_uppercase(),
            "odd" => {
                encoded.pop();
            }
            "hash" => object.sha256 = "ab".repeat(32),
            "length" => object.bytes += 1,
            "kind" => object.kind = MaterialKind::BlobChunk,
            _ => {
                object.bytes = OBJECT_BYTES as u64 + 1;
                encoded = "00".repeat(OBJECT_BYTES + 1);
            }
        }
        assert!(object_bytes(&object, &encoded).is_err(), "{fault}");
    }
    for encoded in [
        r#"{"operation":"checkpoint_receipt","manifest_sha256":"aa","writer":true}"#,
        r#"{"operation":"checkpoint_receipt","manifest_sha256":"aa","manifest_sha256":"bb"}"#,
    ] {
        assert!(serde_json::from_str::<MaterialRequest>(encoded).is_err());
    }
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn signed_bytes_receipt_is_fresh_and_corruption_refuses_after_success() {
    let (root, io, manifest, bytes) = setup(1);
    let object = manifest.objects[0].clone();
    assert!(io
        .execute(MaterialRequest::CertifyCheckpoint {
            manifest: manifest.clone()
        })
        .await
        .is_err());
    assert!(
        matches!(io.execute(MaterialRequest::PutCheckpointObject{object:object.clone(),bytes_hex:hex::encode(&bytes)}).await.unwrap(),MaterialReply::Object(actual) if actual==object)
    );
    let reply = io
        .execute(MaterialRequest::CertifyCheckpoint {
            manifest: manifest.clone(),
        })
        .await
        .unwrap();
    let id = manifest.sha256().unwrap();
    let receipt = match reply {
        MaterialReply::Checkpoint(receipt) => receipt,
        _ => panic!("wrong reply"),
    };
    assert_eq!(receipt.manifest_sha256(), id);
    let encoded = serde_json::to_value(&receipt).unwrap();
    for key in [
        "quorumAvailable",
        "fullInstanceReady",
        "canonicalWriterPermitted",
        "inactiveReplayVerified",
        "payloadEncryptionVerified",
        "sourceRoleVerified",
    ] {
        assert_eq!(encoded[key], false);
    }
    let fresh = io
        .execute(MaterialRequest::CheckpointReceipt {
            manifest_sha256: id.clone(),
        })
        .await
        .unwrap();
    assert_eq!(serde_json::to_value(fresh).unwrap()["payload"], encoded);
    let mut changed = manifest.clone();
    changed.partition_id = "wrong".into();
    assert!(io
        .execute(MaterialRequest::CertifyCheckpoint { manifest: changed })
        .await
        .is_err());
    fs::write(
        root.path().join(format!("{}.blob", object.sha256)),
        b"damaged",
    )
    .unwrap();
    assert!(io
        .execute(MaterialRequest::CheckpointReceipt {
            manifest_sha256: id
        })
        .await
        .is_err());
    io.close().await;
    assert_eq!(
        io.execute(MaterialRequest::PutCheckpointObject {
            object,
            bytes_hex: hex::encode(bytes)
        })
        .await
        .unwrap_err(),
        Error::Refused
    );
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_caller_retains_admission_store_and_drained_work() {
    let (_root, io, manifest, bytes) = setup(1);
    let object = manifest.objects[0].clone();
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, blocked) = std::sync::mpsc::channel();
    let caller = io.clone();
    let expected = object.clone();
    let task = tokio::spawn(async move {
        caller
            .run(move |store| {
                started.send(()).unwrap();
                blocked.recv_timeout(Duration::from_secs(3)).unwrap();
                store.put_object(&expected, &bytes).map_err(storage_error)
            })
            .await
    });
    tokio::time::timeout(Duration::from_secs(2), ready)
        .await
        .unwrap()
        .unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert_eq!(
        io.execute(MaterialRequest::CheckpointReceipt {
            manifest_sha256: manifest.sha256().unwrap()
        })
        .await
        .unwrap_err(),
        Error::Budget
    );
    let closing = io.clone();
    let drain = tokio::spawn(async move { closing.close().await });
    tokio::task::yield_now().await;
    assert!(!drain.is_finished());
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(2), drain)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(io.work.state.lock().unwrap().active, 0);
    assert_eq!(io.permits.available_permits(), 1);
    // The cancelled caller received no success. Actual bytes completed once;
    // a later independent store verification can certify them locally.
    let receipt = io.store.certify_checkpoint(&manifest, "node-1").unwrap();
    assert_eq!(receipt.manifest_sha256(), manifest.sha256().unwrap());
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn worker_panic_releases_exact_admission_without_a_success_receipt() {
    let (_root, io, _manifest, _bytes) = setup(1);
    assert_eq!(
        io.run::<()>(|_| panic!("owned synthetic worker failure"))
            .await
            .unwrap_err(),
        Error::Refused
    );
    assert_eq!(io.work.state.lock().unwrap().active, 0);
    assert_eq!(io.permits.available_permits(), 1);
    io.close().await;
}
