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
