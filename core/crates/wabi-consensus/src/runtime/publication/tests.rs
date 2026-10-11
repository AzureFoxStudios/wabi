use super::*;
use crate::availability_control::{Observation, ObservationOrigin, ProposalWire};
use std::os::unix::fs::{symlink, PermissionsExt};

fn setup() -> (
    tempfile::TempDir,
    RuntimePolicy,
    Opened,
    SignedSourceContext,
) {
    let root = tempfile::Builder::new()
        .permissions(fs::Permissions::from_mode(0o700))
        .tempdir()
        .unwrap();
    let source = crate::source_context::tests::fixture(b"original opaque capture");
    let policy = super::super::tests::signed_capture_policy(root.path(), &source);
    let opened = Opened::open(&policy).unwrap();
    (root, policy, opened, source)
}
fn archive(root: &Path, opened: &Opened, source: &SignedSourceContext) -> CheckpointManifest {
    let path = root.join("original.age");
    fs::write(&path, b"original opaque capture").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    opened
        .material
        .ingest_checkpoint_file(
            File::open(path).unwrap(),
            &source
                .verify(&opened.control.binding().community_id, &opened.source_node)
                .unwrap(),
            ChunkingLimits {
                timeout: Duration::from_secs(5),
            },
        )
        .unwrap()
        .0
}
fn synthetic_command(
    opened: &Opened,
    operation: &str,
    manifest: &CheckpointManifest,
) -> CheckpointObservationCommand {
    // Journal format fixture only: these synthetic observations are NOT fresh
    // network/durability evidence and are never submitted to Raft by this test.
    let verified = manifest
        .source
        .verify(&opened.control.binding().community_id, &opened.source_node)
        .unwrap();
    let claims = &manifest.source.claims;
    let proposal = ProposalWire {
        schema_version: 1,
        scope: "uncommitted_checkpoint_availability_proposal".into(),
        operation_id: operation.into(),
        community_id: opened.control.binding().community_id.clone(),
        partition_id: opened.control.binding().partition_id.clone(),
        membership_log_id: crate::LogId::new(crate::CommittedLeaderId::new(1, 1), 1),
        roster_digest: opened.config.roster_digest(),
        manifest_sha256: manifest.sha256().unwrap(),
        source_context_sha256: verified.sha256().into(),
        source_archive_sha256: claims.archive_sha256.clone(),
        source_inventory_sha256: claims.inventory_sha256.clone(),
        applied_commit_seq: claims.applied_commit_seq,
        required_objects: manifest.objects.len(),
        required_bytes: claims.ciphertext_bytes,
        observations: vec![
            Observation {
                node_id: 1,
                origin: ObservationOrigin::LocalDurableRead,
                receipt_sha256: "aa".repeat(32),
            },
            Observation {
                node_id: 2,
                origin: ObservationOrigin::AuthenticatedPeer,
                receipt_sha256: "bb".repeat(32),
            },
        ],
        allocation: crate::source_context::AllocationKnowledge::Unknown,
        committed: false,
        source_role_verified: false,
        payload_encryption_verified: false,
        inactive_replay_verified: false,
        quorum_available: false,
        full_instance_ready: false,
        canonical_writer_permitted: false,
    };
    CheckpointObservationCommand::collected(
        opened.config.node_id(),
        opened.peers.clone(),
        proposal,
        manifest.clone(),
    )
    .unwrap()
}

#[test]
fn durable_prefix_is_private_append_only_and_reopens_original_identity() {
    let (root, policy, opened, source) = setup();
    let id = "11".repeat(16);
    let owner_inode = fs::metadata(policy.control_directory.join(OWNER_LOCK))
        .unwrap()
        .ino();
    publish(&opened, &id, Payload::Capture(source.clone())).unwrap();
    assert!(inventory(&opened).unwrap()[&id].manifest.is_none());
    let manifest = archive(root.path(), &opened, &source);
    publish(&opened, &id, Payload::Manifest(manifest.clone())).unwrap();
    let command = synthetic_command(&opened, &id, &manifest);
    let fingerprint = command.fingerprint().unwrap();
    let prepared = Payload::Prepared {
        command: command.clone(),
        fingerprint: fingerprint.clone(),
    };
    publish(&opened, &id, prepared.clone()).unwrap();
    let path = policy.control_directory.join(filename(&id, "prepared"));
    let before = fs::read(&path).unwrap();
    let inode = fs::metadata(&path).unwrap().ino();
    publish(&opened, &id, prepared).unwrap();
    assert_eq!(fs::metadata(&path).unwrap().ino(), inode);
    assert_eq!(fs::read(&path).unwrap(), before);
    assert_eq!(fs::metadata(&path).unwrap().mode() & 0o077, 0);
    assert_eq!(fs::metadata(&path).unwrap().nlink(), 1);
    assert_eq!(
        inventory(&opened).unwrap()[&id].prepared.as_ref(),
        Some(&command)
    );
    // No metadata receipt or runtime serving permission was fabricated.
    drop(opened);
    let reopened = Opened::open(&policy).unwrap();
    assert_eq!(
        inventory(&reopened).unwrap()[&id]
            .prepared
            .as_ref()
            .unwrap()
            .fingerprint()
            .unwrap(),
        fingerprint
    );
    assert_eq!(
        fs::metadata(policy.control_directory.join(OWNER_LOCK))
            .unwrap()
            .ino(),
        owner_inode
    );
}

#[test]
fn changed_capture_manifest_and_prepared_command_never_replace_original() {
    let (root, _policy, opened, source) = setup();
    let id = "22".repeat(16);
    publish(&opened, &id, Payload::Capture(source.clone())).unwrap();
    let different = crate::source_context::tests::fixture(b"different valid signed bytes");
    assert!(context_valid(&opened, &different));
    assert_eq!(
        publish(&opened, &id, Payload::Capture(different)),
        Err(RuntimeError::Refused)
    );
    let manifest = archive(root.path(), &opened, &source);
    publish(&opened, &id, Payload::Manifest(manifest.clone())).unwrap();
    let mut changed_manifest = manifest.clone();
    changed_manifest.objects[0].sha256 = "ee".repeat(32);
    assert!(manifest_valid(&opened, &changed_manifest));
    assert_eq!(
        publish(&opened, &id, Payload::Manifest(changed_manifest)),
        Err(RuntimeError::Refused)
    );
    let command = synthetic_command(&opened, &id, &manifest);
    publish(
        &opened,
        &id,
        Payload::Prepared {
            fingerprint: command.fingerprint().unwrap(),
            command: command.clone(),
        },
    )
    .unwrap();
    let path = opened.lease.roots[0].relative(&filename(&id, "prepared"));
    let before = fs::read(&path).unwrap();
    assert_eq!(
        publish(
            &opened,
            &id,
            Payload::Prepared {
                command,
                fingerprint: "ff".repeat(32)
            }
        ),
        Err(RuntimeError::Refused)
    );
    assert_eq!(fs::read(path).unwrap(), before);
}

#[test]
fn missing_parent_phase_invalid_ids_and_budget_refuse_before_creation() {
    let (root, _policy, opened, source) = setup();
    let id = "33".repeat(16);
    let manifest = archive(root.path(), &opened, &source);
    assert_eq!(
        publish(&opened, &id, Payload::Manifest(manifest)),
        Err(RuntimeError::Refused)
    );
    assert_eq!(
        publish(&opened, "../outside", Payload::Capture(source.clone())),
        Err(RuntimeError::Refused)
    );
    for n in 0..OPERATIONS {
        publish(
            &opened,
            &format!("{n:032x}"),
            Payload::Capture(source.clone()),
        )
        .unwrap();
    }
    assert_eq!(inventory(&opened).unwrap().len(), OPERATIONS);
    assert_eq!(
        publish(&opened, &"ff".repeat(16), Payload::Capture(source)),
        Err(RuntimeError::Refused)
    );
    assert!(!opened.lease.roots[0]
        .relative(&filename(&"ff".repeat(16), "capture"))
        .exists());
}

#[test]
fn partial_or_unsafe_record_is_retained_and_refuses_reopen() {
    for fault in 0..5 {
        let (_root, policy, opened, source) = setup();
        let id = "44".repeat(16);
        publish(&opened, &id, Payload::Capture(source)).unwrap();
        let path = policy.control_directory.join(filename(&id, "capture"));
        match fault {
            0 => {
                fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
            }
            1 => {
                fs::hard_link(&path, policy.control_directory.join("preserved-alias")).unwrap();
            }
            2 => {
                fs::remove_file(&path).unwrap();
                symlink("runtime.enrollment.json", &path).unwrap();
            }
            3 => {
                fs::write(&path, b"{partial original record").unwrap();
            }
            _ => {
                let stage = policy
                    .control_directory
                    .join(format!(".publication-{id}-manifest.pending"));
                fs::write(&stage, b"uncertain phase bytes").unwrap();
                fs::set_permissions(&stage, fs::Permissions::from_mode(0o600)).unwrap();
            }
        }
        assert_eq!(verify_existing(&opened), Err(RuntimeError::Ownership));
        drop(opened);
        assert!(matches!(
            Opened::open(&policy),
            Err(RuntimeError::Ownership)
        ));
        assert!(fs::symlink_metadata(path).is_ok());
    }
}

#[test]
fn malformed_duplicate_and_foreign_bindings_refuse_without_normalization() {
    for fault in 0..5 {
        let (_root, _policy, opened, source) = setup();
        let id = "55".repeat(16);
        publish(&opened, &id, Payload::Capture(source)).unwrap();
        let path = opened.lease.roots[0].relative(&filename(&id, "capture"));
        let mut bytes = fs::read(&path).unwrap();
        if fault == 0 {
            bytes.pop();
            bytes.extend_from_slice(b",\"schemaVersion\":1}");
        } else if fault == 4 {
            bytes = vec![b'x'; RECORD_BYTES + 1];
        } else {
            let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            match fault {
                1 => value["binding"]["nodeId"] = serde_json::json!(99),
                2 => value["rosterDigest"] = serde_json::json!("ff".repeat(32)),
                _ => value["schemaVersion"] = serde_json::json!(2),
            }
            bytes = serde_json::to_vec(&value).unwrap();
        }
        fs::write(&path, &bytes).unwrap();
        assert_eq!(verify_existing(&opened), Err(RuntimeError::Ownership));
        assert_eq!(fs::read(path).unwrap(), bytes);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_journal_job_retains_blocking_owner_through_actual_write_and_shutdown() {
    // Exercises the owned journal IO boundary, not a public publisher network
    // race or SIGKILL. A blocking owner is deliberately held before its write.
    let root = tempfile::Builder::new()
        .permissions(fs::Permissions::from_mode(0o700))
        .tempdir()
        .unwrap();
    let source = crate::source_context::tests::fixture(b"opaque journal intent");
    let policy = super::super::tests::signed_capture_policy(root.path(), &source);
    let runtime = Arc::new(RecoveryRuntime::start(policy.clone()).await.unwrap());
    let inode = fs::metadata(policy.control_directory.join(OWNER_LOCK))
        .unwrap()
        .ino();
    let id = "66".repeat(16);
    let (entered, entered_rx) = oneshot::channel();
    let (release, released) = std::sync::mpsc::channel();
    let owner = runtime.clone();
    let original = source.clone();
    let operation = id.clone();
    let caller = tokio::spawn(async move {
        let inner = owner.inner.clone();
        owner
            .run_job(async move {
                tokio::task::spawn_blocking(move || {
                    inner.opened.verify()?;
                    entered.send(()).unwrap();
                    released.recv().unwrap();
                    publish(&inner.opened, &operation, Payload::Capture(original))
                })
                .await
                .map_err(|_| RuntimeError::Closed)?
            })
            .await
    });
    entered_rx.await.unwrap();
    assert!(runtime.local_job_active());
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    assert_eq!(
        runtime.publication_operations().await.unwrap_err(),
        RuntimeError::Busy
    );
    let runtime = Arc::try_unwrap(runtime).ok().unwrap();
    let shutdown = tokio::spawn(runtime.shutdown());
    tokio::task::yield_now().await;
    assert!(!shutdown.is_finished());
    assert!(matches!(
        Opened::open(&policy),
        Err(RuntimeError::Ownership)
    ));
    release.send(()).unwrap();
    shutdown.await.unwrap().unwrap();
    let reopened = Opened::open(&policy).unwrap();
    let saved = inventory(&reopened).unwrap();
    assert_eq!(saved[&id].capture.as_ref(), Some(&source));
    assert!(saved[&id].manifest.is_none());
    assert!(saved[&id].prepared.is_none());
    assert_eq!(
        fs::metadata(policy.control_directory.join(OWNER_LOCK))
            .unwrap()
            .ino(),
        inode
    );
}

async fn cluster_leader(nodes: &BTreeMap<u64, RecoveryRuntime>) -> u64 {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            for (&id, node) in nodes {
                let status = node.status();
                if status.accepting
                    && status.membership_ready
                    && status.leader_node_id == Some(id)
                    && nodes.values().all(|other| {
                        other.status().membership_ready && other.status().leader_node_id == Some(id)
                    })
                {
                    return id;
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap()
}
async fn worker_finished(node: &RecoveryRuntime) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while node.local_job_active() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}
fn cluster_policies(root: &Path, context: &SignedSourceContext) -> Vec<RuntimePolicy> {
    let mut peers = BTreeMap::new();
    let mut reservations = Vec::new();
    for id in 1..=3 {
        let node = root.join(format!("node-{id}"));
        fs::create_dir(&node).unwrap();
        fs::set_permissions(&node, fs::Permissions::from_mode(0o700)).unwrap();
        for name in ["control", "material", "identity"] {
            fs::create_dir(node.join(name)).unwrap();
            fs::set_permissions(node.join(name), fs::Permissions::from_mode(0o700)).unwrap();
        }
        let identity = Identity::generate().unwrap();
        identity.persist_new(&node.join("identity")).unwrap();
        let address = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        peers.insert(
            id,
            RecoveryPeer {
                protocol: crate::model::CONTROL_PROTOCOL,
                community_id: context.claims.community_id.clone(),
                site_id: format!("fixture-{id}"),
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn actual_pre_admission_manifest_and_prepared_prefixes_resume_identical_command_after_reopen()
{
    // Deterministic pre-admission cut points, NOT SIGKILL, genuine export,
    // automatic leader selection, or Authority writer recovery acceptance.
    let root = tempfile::Builder::new()
        .permissions(fs::Permissions::from_mode(0o700))
        .tempdir()
        .unwrap();
    let bytes = b"original pre-admission opaque capture";
    let context = crate::source_context::tests::fixture(bytes);
    let mut policies = cluster_policies(root.path(), &context);
    let path = root.path().join("original.age");
    fs::write(&path, bytes).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let mut nodes = BTreeMap::new();
    for index in [1, 2, 0] {
        nodes.insert(
            index as u64 + 1,
            RecoveryRuntime::start(policies[index].clone())
                .await
                .unwrap(),
        );
    }
    let collector = cluster_leader(&nodes).await;
    let seed = "70".repeat(16);
    nodes[&collector]
        .publish_capture_file(seed.clone(), File::open(&path).unwrap(), context.clone())
        .await
        .unwrap();
    worker_finished(&nodes[&collector]).await;
    let manifest_id = "71".repeat(16);
    let prepared_id = "72".repeat(16);
    let mut exact = None;
    for (operation, prepare) in [(manifest_id.clone(), false), (prepared_id.clone(), true)] {
        let inner = nodes[&collector].inner.clone();
        let source = context.clone();
        let input = File::open(&path).unwrap();
        let result = nodes[&collector]
            .run_job(async move {
                let deadline = Instant::now() + inner.timeout;
                leader_only(&inner)?;
                save(
                    inner.clone(),
                    operation.clone(),
                    Payload::Capture(source.clone()),
                )
                .await?;
                let owner = inner.clone();
                let manifest = tokio::task::spawn_blocking(move || {
                    owner.opened.verify()?;
                    let verified = source
                        .verify(
                            &owner.opened.control.binding().community_id,
                            &owner.opened.source_node,
                        )
                        .map_err(|_| RuntimeError::Refused)?;
                    let value = owner
                        .opened
                        .material
                        .ingest_checkpoint_file(
                            input,
                            &verified,
                            ChunkingLimits {
                                timeout: owner.timeout,
                            },
                        )
                        .map_err(|_| RuntimeError::Refused)?;
                    owner.opened.verify()?;
                    Ok::<_, RuntimeError>(value.0)
                })
                .await
                .map_err(|_| RuntimeError::Closed)??;
                save(
                    inner.clone(),
                    operation.clone(),
                    Payload::Manifest(manifest.clone()),
                )
                .await?;
                if !prepare {
                    return Ok(None);
                }
                distribute(inner.clone(), &manifest, deadline).await?;
                let mut round = CheckpointAvailabilityRound::begin(
                    inner.opened.config.clone(),
                    inner.opened.control.clone(),
                    &inner.service,
                    operation.clone(),
                    &manifest,
                    remaining(deadline)?,
                )
                .await
                .map_err(runtime_transport_error)?;
                for node in inner.opened.peers.keys().copied() {
                    round.refresh(node).await.map_err(runtime_transport_error)?;
                }
                let prepared = round
                    .prepare_for_publication(&inner.raft)
                    .await
                    .map_err(runtime_transport_error)?;
                let command = prepared.command().clone();
                save(
                    inner,
                    operation,
                    Payload::Prepared {
                        command: command.clone(),
                        fingerprint: command.fingerprint().unwrap(),
                    },
                )
                .await?;
                // Actual typed prepared object is dropped WITHOUT client_write.
                drop(prepared);
                Ok(Some(command))
            })
            .await
            .unwrap();
        worker_finished(&nodes[&collector]).await;
        if prepare {
            exact = result;
        }
    }
    let exact = exact.unwrap();
    assert_eq!(exact.observations().len(), 3);
    for node in nodes.values() {
        let state = node.control_state().await.unwrap();
        assert!(!state.checkpoints.contains_key(&manifest_id));
        assert!(!state.checkpoints.contains_key(&prepared_id));
    }
    let pending = nodes[&collector].pending_publication_operations().await.unwrap();
    worker_finished(&nodes[&collector]).await;
    assert_eq!(pending.len(), 2);
    assert!(pending.iter().any(|op| op.operation_id == manifest_id && op.stage == PublicationStage::Manifest));
    assert!(pending.iter().any(|op| op.operation_id == prepared_id && op.stage == PublicationStage::Prepared));
    assert!(!pending.iter().any(|op| op.operation_id == seed));
    // Corrupt/mismatched applied history must not silently drop an original
    // pending command. This negative state is a clone, not a durable write.
    let opened = &nodes[&collector].inner.opened;
    let mut conflicting = nodes[&collector].control_state().await.unwrap();
    conflicting.checkpoints.insert(prepared_id.clone(), conflicting.checkpoints[&seed].clone());
    assert!(pending_originals(opened, &conflicting, inventory(opened).unwrap()).is_err());
    let directory = policies[collector as usize - 1].control_directory.clone();
    let command_path = directory.join(filename(&prepared_id, "prepared"));
    let original_bytes = fs::read(&command_path).unwrap();
    let original_inode = fs::metadata(&command_path).unwrap().ino();
    let lock_inode = fs::metadata(directory.join(OWNER_LOCK)).unwrap().ino();
    for (_, node) in std::mem::take(&mut nodes) {
        node.shutdown().await.unwrap();
    }
    for policy in &mut policies {
        policy.initialize = false;
    }
    for policy in &policies {
        let node = RecoveryRuntime::start(policy.clone()).await.unwrap();
        // Explicit test election preserves the journal collector identity.
        // This is not automatic publication failover to a different collector.
        node.inner.raft.enable_elect(false);
        nodes.insert(policy.binding.node_id, node);
    }
    nodes[&collector]
        .inner
        .raft
        .trigger()
        .elect()
        .await
        .unwrap();
    assert_eq!(cluster_leader(&nodes).await, collector);
    let stopped = *nodes.keys().find(|id| **id != collector).unwrap();
    nodes.remove(&stopped).unwrap().shutdown().await.unwrap();
    assert_eq!(cluster_leader(&nodes).await, collector);
    let after_reopen = nodes[&collector].pending_publication_operations().await.unwrap();
    worker_finished(&nodes[&collector]).await;
    assert_eq!(after_reopen.len(), 2);
    assert!(after_reopen.iter().any(|op| op.operation_id == manifest_id && op.stage == PublicationStage::Manifest));
    assert!(after_reopen.iter().any(|op| op.operation_id == prepared_id && op.stage == PublicationStage::Prepared));
    let manifest_receipt = nodes[&collector]
        .resume_publication(manifest_id.clone())
        .await
        .unwrap();
    worker_finished(&nodes[&collector]).await;
    assert_eq!(
        serde_json::to_value(manifest_receipt).unwrap()["metadataCommitted"],
        true
    );
    let receipt = serde_json::to_value(
        nodes[&collector]
            .resume_publication(prepared_id.clone())
            .await
            .unwrap(),
    )
    .unwrap();
    worker_finished(&nodes[&collector]).await;
    assert_eq!(receipt["commandFingerprint"], exact.fingerprint().unwrap());
    for flag in [
        "quorumAvailable",
        "fullInstanceReady",
        "canonicalWriterPermitted",
    ] {
        assert_eq!(receipt[flag], false);
    }
    assert_eq!(
        nodes[&collector].control_state().await.unwrap().checkpoints[&prepared_id].command,
        exact
    );
    assert!(nodes[&collector].pending_publication_operations().await.unwrap().is_empty());
    worker_finished(&nodes[&collector]).await;
    assert_eq!(fs::read(&command_path).unwrap(), original_bytes);
    assert_eq!(fs::metadata(&command_path).unwrap().ino(), original_inode);
    for (_, node) in nodes {
        node.shutdown().await.unwrap();
    }
    assert_eq!(
        fs::metadata(directory.join(OWNER_LOCK)).unwrap().ino(),
        lock_inode
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn post_control_read_boundary_refuses_late_state_and_root_loss_even_on_io_error() {
    // Deterministic post-read seam: the positive state comes from actual redb.
    // Expiry, root substitution and the IO error below are deliberate fixtures,
    // not concurrent mutations or a real slow/failed IO race.
    let root = tempfile::Builder::new()
        .permissions(fs::Permissions::from_mode(0o700))
        .tempdir()
        .unwrap();
    let source = crate::source_context::tests::fixture(b"boundary fixture");
    let policy = super::super::tests::signed_capture_policy(root.path(), &source);
    let runtime = RecoveryRuntime::start(policy.clone()).await.unwrap();
    let inode = fs::metadata(policy.control_directory.join(OWNER_LOCK))
        .unwrap()
        .ino();
    let actual = runtime.inner.opened.control.control_state().await.unwrap();
    assert_eq!(
        serde_json::to_value(
            checked_control_read(
                &runtime.inner,
                Instant::now() + Duration::from_secs(1),
                Ok(actual.clone())
            )
            .unwrap()
        )
        .unwrap(),
        serde_json::to_value(&actual).unwrap()
    );
    let inner = runtime.inner.clone();
    assert_eq!(
        runtime
            .run_job(async move {
                checked_control_read(
                    &inner,
                    Instant::now() - Duration::from_millis(1),
                    Ok(actual),
                )
            })
            .await
            .unwrap_err(),
        RuntimeError::Deadline
    );
    worker_finished(&runtime).await;
    assert!(runtime.status().accepting);
    let original = root.path().join("material-original");
    fs::rename(&policy.material_directory, &original).unwrap();
    fs::create_dir(&policy.material_directory).unwrap();
    fs::set_permissions(
        &policy.material_directory,
        fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    let inner = runtime.inner.clone();
    assert_eq!(
        runtime
            .run_job(async move {
                checked_control_read(
                    &inner,
                    Instant::now() + Duration::from_secs(1),
                    Err(crate::store::StoreError::Io),
                )
            })
            .await
            .unwrap_err(),
        RuntimeError::Ownership
    );
    assert!(!runtime.status().accepting);
    // Restore only the deliberately substituted fixture root; never delete the
    // original data/lock or allow a second owner before actual supervisor drain.
    fs::remove_dir(&policy.material_directory).unwrap();
    fs::rename(original, &policy.material_directory).unwrap();
    let drained = runtime.shutdown().await;
    assert!(matches!(drained, Ok(_) | Err(RuntimeError::Ownership)));
    let reopened = Opened::open(&policy).unwrap();
    assert_eq!(
        fs::metadata(policy.control_directory.join(OWNER_LOCK))
            .unwrap()
            .ino(),
        inode
    );
    drop(reopened);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn original_capture_intent_is_durable_before_bytes_and_reopens_without_replacement() {
    // Public runtime API with generated encrypted loopback peers, but synthetic
    // signed context only. No HTTP 202, real Wabi export, SIGKILL, automatic
    // pending scheduler, archive availability or writer recovery is proven.
    let root = tempfile::Builder::new()
        .permissions(fs::Permissions::from_mode(0o700))
        .tempdir()
        .unwrap();
    let context = crate::source_context::tests::fixture(b"original admission-only context");
    let policies = cluster_policies(root.path(), &context);
    let mut nodes = BTreeMap::new();
    for index in [1, 2, 0] {
        nodes.insert(
            index as u64 + 1,
            RecoveryRuntime::start(policies[index].clone()).await.unwrap(),
        );
    }
    let leader = cluster_leader(&nodes).await;
    let follower = *nodes.keys().find(|&&id| id != leader).unwrap();
    let operation = "83".repeat(16);
    assert_eq!(
        nodes[&follower].record_capture_intent(operation.clone(), context.clone()).await,
        Err(RuntimeError::NotLeader),
    );
    worker_finished(&nodes[&follower]).await;
    assert!(inventory(&nodes[&follower].inner.opened).unwrap().is_empty());
    assert_eq!(
        nodes[&leader].record_capture_intent("../replacement".into(), context.clone()).await,
        Err(RuntimeError::Refused),
    );
    let mut unsigned_change = context.clone();
    unsigned_change.claims.source_node_id.push_str("-different");
    assert_eq!(
        nodes[&leader].record_capture_intent(operation.clone(), unsigned_change).await,
        Err(RuntimeError::Refused),
    );
    assert!(inventory(&nodes[&leader].inner.opened).unwrap().is_empty());
    let control = policies[(leader - 1) as usize].control_directory.clone();
    let lock_inode = fs::metadata(control.join(OWNER_LOCK)).unwrap().ino();
    nodes[&leader].record_capture_intent(operation.clone(), context.clone()).await.unwrap();
    worker_finished(&nodes[&leader]).await;
    let intent_path = control.join(filename(&operation, "capture"));
    let exact_bytes = fs::read(&intent_path).unwrap();
    let intent_inode = fs::metadata(&intent_path).unwrap().ino();
    let saved = inventory(&nodes[&leader].inner.opened).unwrap();
    assert_eq!(saved.len(), 1);
    assert_eq!(saved[&operation].capture.as_ref(), Some(&context));
    assert!(saved[&operation].manifest.is_none() && saved[&operation].prepared.is_none());
    assert_eq!(fs::metadata(&intent_path).unwrap().mode() & 0o077, 0);
    assert_eq!(fs::metadata(&intent_path).unwrap().nlink(), 1);
    // Same operation/context synchronizes the existing exact record. It does
    // not reset its inode, create material or replace the original context.
    nodes[&leader].record_capture_intent(operation.clone(), context.clone()).await.unwrap();
    worker_finished(&nodes[&leader]).await;
    assert_eq!(fs::read(&intent_path).unwrap(), exact_bytes);
    assert_eq!(fs::metadata(&intent_path).unwrap().ino(), intent_inode);
    let different = crate::source_context::tests::fixture(b"different admission context");
    assert_eq!(
        nodes[&leader].record_capture_intent(operation.clone(), different).await,
        Err(RuntimeError::Refused),
    );
    worker_finished(&nodes[&leader]).await;
    assert_eq!(fs::read(&intent_path).unwrap(), exact_bytes);
    assert_eq!(fs::metadata(&intent_path).unwrap().ino(), intent_inode);
    nodes[&leader].confirm_publication_intent(operation.clone()).await.unwrap();
    worker_finished(&nodes[&leader]).await;
    assert_eq!(fs::read(&intent_path).unwrap(), exact_bytes);
    assert_eq!(fs::metadata(&intent_path).unwrap().ino(), intent_inode);
    let pending = nodes[&leader].pending_publication_operations().await.unwrap();
    worker_finished(&nodes[&leader]).await;
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].operation_id, operation);
    assert_eq!(pending[0].stage, PublicationStage::Capture);
    let records = nodes[&leader].publication_operations().await.unwrap();
    worker_finished(&nodes[&leader]).await;
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].operation_id, operation);
    assert!(matches!(records[0].stage, PublicationStage::Capture));
    assert!(!nodes[&leader].status().full_instance_ready);
    assert!(!nodes[&leader].status().canonical_writer_permitted);
    for node in nodes.into_values() { node.shutdown().await.unwrap(); }
    let reopened = Opened::open(&policies[(leader - 1) as usize]).unwrap();
    let records = inventory(&reopened).unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[&operation].capture.as_ref(), Some(&context));
    assert!(records[&operation].manifest.is_none() && records[&operation].prepared.is_none());
    assert_eq!(fs::read(&intent_path).unwrap(), exact_bytes);
    assert_eq!(fs::metadata(&intent_path).unwrap().ino(), intent_inode);
    assert_eq!(fs::metadata(control.join(OWNER_LOCK)).unwrap().ino(), lock_inode);
}

#[test]
fn confirming_original_prefix_syncs_exact_records_without_recreation_or_command_submission() {
    // Direct real private journal IO; prepared observations are synthetic
    // format fixtures and never submitted to Raft. No OS power-loss proof.
    let (root, policy, opened, source) = setup();
    let operation = "91".repeat(16);
    let manifest = archive(root.path(), &opened, &source);
    let command = synthetic_command(&opened, &operation, &manifest);
    let fingerprint = command.fingerprint().unwrap();
    assert_eq!(confirm_original_intent(&opened, &operation), Err(RuntimeError::Refused));
    for body in [Payload::Capture(source), Payload::Manifest(manifest), Payload::Prepared { command, fingerprint }] {
        publish(&opened, &operation, body).unwrap();
        let records = inventory(&opened).unwrap();
        let mut originals = Vec::new();
        for phase in ["capture", "manifest", "prepared"] {
            let path = policy.control_directory.join(filename(&operation, phase));
            if path.exists() { originals.push((path.clone(), fs::read(&path).unwrap(), fs::metadata(&path).unwrap().ino())); }
        }
        confirm_original_intent(&opened, &operation).unwrap();
        assert_eq!(inventory(&opened).unwrap().len(), records.len());
        for (path, bytes, inode) in originals {
            assert_eq!(fs::read(&path).unwrap(), bytes);
            assert_eq!(fs::metadata(&path).unwrap().ino(), inode);
        }
    }
    assert_eq!(confirm_original_intent(&opened, "../replacement"), Err(RuntimeError::Refused));
    let capture = policy.control_directory.join(filename(&operation, "capture"));
    fs::remove_file(&capture).unwrap();
    assert_eq!(confirm_original_intent(&opened, &operation), Err(RuntimeError::Ownership));
    assert!(!capture.exists(), "confirmation must never recreate a missing parent record");
    assert!(policy.control_directory.join(filename(&operation, "manifest")).exists());
    assert!(policy.control_directory.join(filename(&operation, "prepared")).exists());
}
