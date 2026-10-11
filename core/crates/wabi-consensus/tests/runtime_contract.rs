//! Real managed Raft/material runtime lifecycle with synthetic signed opaque
//! bytes. This is not a genuine Wabi export, three uplinks or activation proof.
#![cfg(target_os = "linux")]
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use wabi_consensus::{
    material::MaterialLimits,
    model::{Outcome, RecoveryPeer, StoreBinding, CONTROL_PROTOCOL},
    runtime::{RecoveryRuntime, RuntimeError, RuntimePolicy},
    source_context::{
        signing_input, AllocationKnowledge, SignedSourceContext, SourceClaims, SOURCE_PROFILE,
    },
    store::StoreLimits,
    transport::{CheckpointClient, Config, Identity, Limits},
};

fn private(path: &Path) {
    fs::create_dir(path).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}
fn source(bytes: &[u8]) -> SignedSourceContext {
    let key = SigningKey::from_slice(&[9; 32]).unwrap();
    let public_key = hex::encode(key.verifying_key().to_encoded_point(false).as_bytes());
    let claims = SourceClaims {
        schema_version: 1,
        support_profile: SOURCE_PROFILE.into(),
        community_id: hex::encode(Sha256::digest(hex::decode(&public_key).unwrap())),
        source_node_id: "fixture-authority".into(),
        archive_sha256: hex::encode(Sha256::digest(bytes)),
        inventory_sha256: "ab".repeat(32),
        ciphertext_bytes: bytes.len() as u64,
        applied_commit_seq: 7,
        commit_prefix_fingerprint: "cd".repeat(32),
        bootstrap_fingerprint: "ef".repeat(32),
        allocation: AllocationKnowledge::Unknown,
    };
    let signature: Signature = key.sign(&signing_input(&claims).unwrap());
    SignedSourceContext {
        claims,
        public_key,
        signature: hex::encode(signature.normalize_s().unwrap_or(signature).to_bytes()),
    }
}
fn policies(root: &Path, context: &SignedSourceContext) -> Vec<RuntimePolicy> {
    let mut peers = BTreeMap::new();
    let mut reservations = Vec::new();
    for id in 1..=3 {
        let node = root.join(format!("node-{id}"));
        private(&node);
        for name in ["control", "material", "identity"] {
            private(&node.join(name));
        }
        let identity = Identity::generate().unwrap();
        identity.persist_new(&node.join("identity")).unwrap();
        let address = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        peers.insert(
            id,
            RecoveryPeer {
                protocol: CONTROL_PROTOCOL,
                community_id: context.claims.community_id.clone(),
                site_id: format!("fixture-site-{id}"),
                public_key: identity.public_hex(),
                rpc_address: address.local_addr().unwrap().to_string(),
            },
        );
        reservations.push(address);
    }
    (1..=3)
        .map(|id| {
            let node = root.join(format!("node-{id}"));
            RuntimePolicy {
                binding: StoreBinding {
                    community_id: context.claims.community_id.clone(),
                    partition_id: "community/control".into(),
                    node_id: id,
                },
                peers: peers.clone(),
                source_node_id: context.claims.source_node_id.clone(),
                identity_directory: node.join("identity"),
                control_directory: node.join("control"),
                material_directory: node.join("material"),
                bind_address: None,
                initialize: id == 1,
                control_limits: StoreLimits {
                    min_free_bytes: 1,
                    ..Default::default()
                },
                material_limits: MaterialLimits {
                    min_free_bytes: 1,
                    ..Default::default()
                },
                transport_limits: Limits {
                    rpc_deadline: Duration::from_secs(1),
                    ..Default::default()
                },
                work_timeout: Duration::from_secs(10),
            }
        })
        .collect()
}
fn client(policy: &RuntimePolicy, target: u64) -> CheckpointClient {
    let config = Config::new(
        policy.binding.clone(),
        policy.peers.clone(),
        Arc::new(Identity::load(&policy.identity_directory).unwrap()),
        policy.transport_limits.clone(),
    )
    .unwrap();
    CheckpointClient::new(Arc::new(config), target, policy.source_node_id.clone()).unwrap()
}
async fn leader(nodes: &BTreeMap<u64, RecoveryRuntime>) -> u64 {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            for (id, node) in nodes {
                let state = node.status();
                if state.accepting
                    && state.membership_ready
                    && state.leader_node_id == Some(*id)
                    && nodes.values().all(|node| {
                        node.status().membership_ready && node.status().leader_node_id == Some(*id)
                    })
                {
                    return *id;
                }
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("managed runtime leader/membership did not converge")
}
fn inodes(policy: &RuntimePolicy) -> Vec<(PathBuf, u64)> {
    [
        policy.control_directory.join(".runtime.lock"),
        policy.control_directory.join(".lock"),
        policy.material_directory.join(".lock"),
        policy.identity_directory.join("recovery.key"),
    ]
    .into_iter()
    .map(|path| {
        let inode = fs::metadata(&path).unwrap().ino();
        (path, inode)
    })
    .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn managed_nodes_commit_reopen_material_and_control_with_original_identities_then_majority() {
    let root = tempfile::tempdir().unwrap();
    let bytes = vec![61; 130_123];
    let context = source(&bytes);
    let mut policies = policies(root.path(), &context);
    let mut nodes = BTreeMap::new();
    // Followers first, then explicitly initialize the one approved bootstrap node.
    for index in [1, 2, 0] {
        nodes.insert(
            index as u64 + 1,
            RecoveryRuntime::start(policies[index].clone())
                .await
                .unwrap(),
        );
    }
    let first_leader = leader(&nodes).await;
    let archive = root.path().join("capture.age");
    fs::write(&archive, &bytes).unwrap();
    fs::set_permissions(&archive, fs::Permissions::from_mode(0o600)).unwrap();
    let manifest = nodes[&1]
        .ingest_capture(archive.clone(), context.clone())
        .await
        .unwrap();
    assert_eq!(manifest.objects.len(), 2);
    for id in [2, 3] {
        let sender = client(&policies[0], id);
        for (index, object) in manifest.objects.iter().enumerate() {
            let offset = index * 64 * 1024;
            let data = &bytes[offset..offset + object.bytes as usize];
            sender.put_object(object.clone(), data).await.unwrap();
        }
        sender.certify(&manifest).await.unwrap();
    }
    let operation = "11".repeat(16);
    let receipt = nodes[&first_leader]
        .observe_checkpoint(operation.clone(), manifest.clone())
        .await
        .unwrap();
    let wire = serde_json::to_value(receipt).unwrap();
    assert_eq!(wire["metadataCommitted"], true);
    for flag in [
        "quorumAvailable",
        "fullInstanceReady",
        "canonicalWriterPermitted",
    ] {
        assert_eq!(wire[flag], false);
    }
    let saved = nodes[&first_leader]
        .control_state()
        .await
        .unwrap()
        .checkpoints[&operation]
        .clone();
    assert_eq!(saved.reply.outcome, Outcome::Accepted);
    assert!(!saved.reply.canonical_writer_permitted);
    // Reuse cannot re-collect a different receipt under the old identity.
    assert!(nodes[&first_leader]
        .observe_checkpoint(operation.clone(), manifest.clone())
        .await
        .is_err());
    let protected: Vec<_> = policies.iter().flat_map(inodes).collect();
    for (_, node) in std::mem::take(&mut nodes) {
        node.shutdown().await.unwrap();
    }
    for policy in &mut policies {
        policy.initialize = false;
    }
    for policy in &policies {
        nodes.insert(
            policy.binding.node_id,
            RecoveryRuntime::start(policy.clone()).await.unwrap(),
        );
    }
    let second_leader = leader(&nodes).await;
    assert_eq!(
        nodes[&second_leader]
            .control_state()
            .await
            .unwrap()
            .checkpoints[&operation],
        saved
    );
    let fresh = client(&policies[0], 2);
    assert_eq!(
        fresh
            .read_manifest(&manifest.sha256().unwrap())
            .await
            .unwrap(),
        manifest
    );
    fresh.fresh_receipt(&manifest).await.unwrap();
    for (path, inode) in &protected {
        assert_eq!(fs::metadata(path).unwrap().ino(), *inode);
    }

    let stopped = *nodes.keys().find(|id| **id != second_leader).unwrap();
    nodes.remove(&stopped).unwrap().shutdown().await.unwrap();
    let majority_leader = leader(&nodes).await;
    nodes[&majority_leader]
        .observe_checkpoint("22".repeat(16), manifest.clone())
        .await
        .unwrap();
    let mut unsupported = context.clone();
    unsupported.claims.source_node_id = "other-source".into();
    assert_eq!(
        nodes[&majority_leader]
            .ingest_capture(archive.clone(), unsupported)
            .await
            .unwrap_err(),
        RuntimeError::Refused
    );
    let index = stopped as usize - 1;
    nodes.insert(
        stopped,
        RecoveryRuntime::start(policies[index].clone())
            .await
            .unwrap(),
    );
    leader(&nodes).await;
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if nodes[&stopped]
                .control_state()
                .await
                .unwrap()
                .checkpoints
                .contains_key(&"22".repeat(16))
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        nodes[&stopped].control_state().await.unwrap().checkpoints[&"22".repeat(16)]
            .reply
            .outcome,
        Outcome::Accepted
    );
    for (_, node) in nodes {
        node.shutdown().await.unwrap();
    }
    for (path, inode) in protected {
        assert_eq!(fs::metadata(path).unwrap().ino(), inode);
    }
}

async fn job_finished(node: &RecoveryRuntime) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while node.local_job_active() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("actual local worker did not finish");
}
fn historical(wire: &serde_json::Value) {
    assert_eq!(wire["metadataCommitted"], true);
    for flag in [
        "quorumAvailable",
        "fullInstanceReady",
        "canonicalWriterPermitted",
    ] {
        assert_eq!(wire[flag], false);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn owned_publication_distributes_journals_reopens_original_receipt_and_uses_surviving_majority(
) {
    use wabi_consensus::runtime::PublicationStage;
    let root = tempfile::Builder::new()
        .permissions(fs::Permissions::from_mode(0o700))
        .tempdir()
        .unwrap();
    let bytes = vec![41; 130_123];
    let context = source(&bytes);
    let mut policies = policies(root.path(), &context);
    let mut nodes = BTreeMap::new();
    for index in [1, 2, 0] {
        nodes.insert(
            index as u64 + 1,
            RecoveryRuntime::start(policies[index].clone())
                .await
                .unwrap(),
        );
    }
    let publisher = leader(&nodes).await;
    let archive = root.path().join("original.age");
    fs::write(&archive, &bytes).unwrap();
    fs::set_permissions(&archive, fs::Permissions::from_mode(0o600)).unwrap();
    let operation = "31".repeat(16);
    // Follower publication is explicit unavailable and creates no intent.
    let follower = *nodes.keys().find(|id| **id != publisher).unwrap();
    assert_eq!(
        nodes[&follower]
            .publish_capture_file(
                "30".repeat(16),
                fs::File::open(&archive).unwrap(),
                context.clone()
            )
            .await
            .unwrap_err(),
        RuntimeError::NotLeader
    );
    job_finished(&nodes[&follower]).await;
    assert!(nodes[&follower]
        .publication_operations()
        .await
        .unwrap()
        .is_empty());
    job_finished(&nodes[&follower]).await;
    let receipt = serde_json::to_value(
        nodes[&publisher]
            .publish_capture_file(
                operation.clone(),
                fs::File::open(&archive).unwrap(),
                context.clone(),
            )
            .await
            .unwrap(),
    )
    .unwrap();
    job_finished(&nodes[&publisher]).await;
    historical(&receipt);
    let publisher_policy = &policies[publisher as usize - 1];
    let mut originals = Vec::new();
    for phase in ["capture", "manifest", "prepared"] {
        let path = publisher_policy
            .control_directory
            .join(format!("publication-{operation}-{phase}.json"));
        let meta = fs::metadata(&path).unwrap();
        assert_eq!(meta.mode() & 0o077, 0);
        assert_eq!(meta.nlink(), 1);
        originals.push((path.clone(), meta.ino(), fs::read(path).unwrap()));
    }
    let saved = nodes[&publisher].control_state().await.unwrap().checkpoints[&operation].clone();
    assert_eq!(
        saved.command.fingerprint().unwrap(),
        receipt["commandFingerprint"]
    );
    assert_eq!(saved.reply.outcome, Outcome::Accepted);
    let manifest_record: serde_json::Value = serde_json::from_slice(&originals[1].2).unwrap();
    let manifest: wabi_consensus::material::CheckpointManifest =
        serde_json::from_value(manifest_record["body"]["payload"].clone()).unwrap();
    let listed = nodes[&publisher].publication_operations().await.unwrap();
    job_finished(&nodes[&publisher]).await;
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].operation_id, operation);
    assert_eq!(listed[0].stage, PublicationStage::Prepared);
    // Journal phase is not an ACK: inspect actual Noise-served durable bytes.
    for id in nodes.keys().copied().filter(|id| *id != publisher) {
        let peer = client(publisher_policy, id);
        assert_eq!(
            peer.read_manifest(&manifest.sha256().unwrap())
                .await
                .unwrap(),
            manifest
        );
        peer.fresh_receipt(&manifest).await.unwrap();
    }
    let conflicting = source(b"another valid signed capture");
    assert_eq!(
        nodes[&publisher]
            .publish_capture_file(
                operation.clone(),
                fs::File::open(&archive).unwrap(),
                conflicting
            )
            .await
            .unwrap_err(),
        RuntimeError::Refused
    );
    job_finished(&nodes[&publisher]).await;
    for (path, inode, bytes) in &originals {
        assert_eq!(fs::metadata(path).unwrap().ino(), *inode);
        assert_eq!(&fs::read(path).unwrap(), bytes);
    }
    // Actual input refusal after durable intent: restarting from that stage
    // requires the exact original signed bytes, rather than invented metadata.
    let early_id = "33".repeat(16);
    let incorrect = root.path().join("incorrect.age");
    fs::write(&incorrect, vec![42; bytes.len()]).unwrap();
    fs::set_permissions(&incorrect, fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(
        nodes[&publisher]
            .publish_capture_file(
                early_id.clone(),
                fs::File::open(&incorrect).unwrap(),
                context.clone()
            )
            .await
            .unwrap_err(),
        RuntimeError::Refused
    );
    job_finished(&nodes[&publisher]).await;
    assert!(publisher_policy
        .control_directory
        .join(format!("publication-{early_id}-capture.json"))
        .is_file());
    assert!(!publisher_policy
        .control_directory
        .join(format!("publication-{early_id}-manifest.json"))
        .exists());
    assert_eq!(
        nodes[&publisher]
            .resume_publication(early_id.clone())
            .await
            .unwrap_err(),
        RuntimeError::CaptureRequired
    );
    job_finished(&nodes[&publisher]).await;
    // A separate early refusal is reoffered on the actual original leader
    // before restart, so positive original-capture retry is unconditional.
    let reoffer_id = "34".repeat(16);
    assert_eq!(
        nodes[&publisher]
            .publish_capture_file(
                reoffer_id.clone(),
                fs::File::open(&incorrect).unwrap(),
                context.clone()
            )
            .await
            .unwrap_err(),
        RuntimeError::Refused
    );
    job_finished(&nodes[&publisher]).await;
    historical(
        &serde_json::to_value(
            nodes[&publisher]
                .publish_capture_file(
                    reoffer_id,
                    fs::File::open(&archive).unwrap(),
                    context.clone(),
                )
                .await
                .unwrap(),
        )
        .unwrap(),
    );
    job_finished(&nodes[&publisher]).await;
    let protected: Vec<_> = policies.iter().flat_map(inodes).collect();
    for (_, node) in std::mem::take(&mut nodes) {
        node.shutdown().await.unwrap();
    }
    for policy in &mut policies {
        policy.initialize = false;
    }
    for policy in &policies {
        nodes.insert(
            policy.binding.node_id,
            RecoveryRuntime::start(policy.clone()).await.unwrap(),
        );
    }
    let restarted_leader = leader(&nodes).await;
    // The original publisher can be a follower now. Historical exact durable
    // readback does not need new bytes, ACKs, or a replacement operation ID.
    let resumed = serde_json::to_value(
        nodes[&publisher]
            .resume_publication(operation.clone())
            .await
            .unwrap(),
    )
    .unwrap();
    job_finished(&nodes[&publisher]).await;
    assert_eq!(resumed, receipt);
    assert_eq!(
        nodes[&publisher].control_state().await.unwrap().checkpoints[&operation],
        saved
    );
    for (path, inode, bytes) in &originals {
        assert_eq!(fs::metadata(path).unwrap().ino(), *inode);
        assert_eq!(&fs::read(path).unwrap(), bytes);
    }
    assert_eq!(
        nodes[&publisher]
            .resume_publication(early_id.clone())
            .await
            .unwrap_err(),
        RuntimeError::CaptureRequired
    );
    job_finished(&nodes[&publisher]).await;
    if restarted_leader == publisher {
        historical(
            &serde_json::to_value(
                nodes[&publisher]
                    .publish_capture_file(
                        early_id.clone(),
                        fs::File::open(&archive).unwrap(),
                        context.clone(),
                    )
                    .await
                    .unwrap(),
            )
            .unwrap(),
        );
    } else {
        assert_eq!(
            nodes[&publisher]
                .publish_capture_file(
                    early_id.clone(),
                    fs::File::open(&archive).unwrap(),
                    context.clone()
                )
                .await
                .unwrap_err(),
            RuntimeError::NotLeader
        );
        assert!(!nodes[&publisher]
            .control_state()
            .await
            .unwrap()
            .checkpoints
            .contains_key(&early_id));
    }
    job_finished(&nodes[&publisher]).await;
    let stopped = *nodes.keys().find(|id| **id != restarted_leader).unwrap();
    nodes.remove(&stopped).unwrap().shutdown().await.unwrap();
    let survivor_leader = leader(&nodes).await;
    let second = "32".repeat(16);
    let receipt = serde_json::to_value(
        nodes[&survivor_leader]
            .publish_capture_file(second.clone(), fs::File::open(&archive).unwrap(), context)
            .await
            .unwrap(),
    )
    .unwrap();
    job_finished(&nodes[&survivor_leader]).await;
    historical(&receipt);
    let record = nodes[&survivor_leader]
        .control_state()
        .await
        .unwrap()
        .checkpoints[&second]
        .clone();
    assert_eq!(
        record.command.fingerprint().unwrap(),
        receipt["commandFingerprint"]
    );
    nodes.insert(
        stopped,
        RecoveryRuntime::start(policies[stopped as usize - 1].clone())
            .await
            .unwrap(),
    );
    leader(&nodes).await;
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if nodes[&stopped]
                .control_state()
                .await
                .unwrap()
                .checkpoints
                .get(&second)
                == Some(&record)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap();
    for (_, node) in nodes {
        node.shutdown().await.unwrap();
    }
    for (path, inode) in protected {
        assert_eq!(fs::metadata(path).unwrap().ino(), inode);
    }
}
