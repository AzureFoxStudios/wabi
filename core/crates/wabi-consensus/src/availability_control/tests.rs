//! Deterministic metadata/storage fixtures. The source signature is real,
//! but the payload and peer observations are synthetic, not an Authority export.
use super::*;
use crate::{
    material::ObjectRef,
    model::{ControlCommand, ControlData, StoreBinding, CONTROL_PROTOCOL},
    source_context::tests::fixture,
    store::{Store, StoreLimits},
    Entry,
};
use openraft::{storage::RaftStateMachine, EntryPayload, RaftSnapshotBuilder};
use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
};

fn log(index: u64) -> LogId {
    LogId::new(openraft::CommittedLeaderId::new(1, 1), index)
}
pub(crate) fn command_fixture() -> (CheckpointObservationCommand, StoreBinding) {
    let bytes = b"synthetic checkpoint control fixture";
    let source = fixture(bytes);
    let binding = StoreBinding {
        community_id: source.claims.community_id.clone(),
        partition_id: "community/root".into(),
        node_id: 1,
    };
    let peers: BTreeMap<_, _> = (1..=3)
        .map(|node| {
            (
                node,
                RecoveryPeer {
                    protocol: CONTROL_PROTOCOL,
                    community_id: binding.community_id.clone(),
                    site_id: format!("site-{node}"),
                    public_key: format!("{node:064x}"),
                    rpc_address: format!("127.0.0.1:{}", 12000 + node),
                },
            )
        })
        .collect();
    let source_context_sha256 = source
        .verify(&binding.community_id, "node-1")
        .unwrap()
        .sha256()
        .to_owned();
    let manifest = CheckpointManifest {
        schema_version: 2,
        partition_id: binding.partition_id.clone(),
        objects: vec![ObjectRef {
            kind: MaterialKind::CheckpointChunk,
            sha256: hex::encode(Sha256::digest(bytes)),
            bytes: bytes.len() as u64,
        }],
        source,
    };
    let proposal = ProposalWire {
        schema_version: 1,
        scope: "uncommitted_checkpoint_availability_proposal".into(),
        operation_id: "ab".repeat(16),
        community_id: binding.community_id.clone(),
        partition_id: binding.partition_id.clone(),
        membership_log_id: log(1),
        roster_digest: roster_digest(&peers).unwrap(),
        manifest_sha256: manifest.sha256().unwrap(),
        source_context_sha256,
        source_archive_sha256: manifest.source.claims.archive_sha256.clone(),
        source_inventory_sha256: manifest.source.claims.inventory_sha256.clone(),
        applied_commit_seq: manifest.source.claims.applied_commit_seq,
        required_objects: 1,
        required_bytes: bytes.len() as u64,
        observations: vec![
            Observation {
                node_id: 1,
                origin: ObservationOrigin::LocalDurableRead,
                receipt_sha256: "cd".repeat(32),
            },
            Observation {
                node_id: 2,
                origin: ObservationOrigin::AuthenticatedPeer,
                receipt_sha256: "ef".repeat(32),
            },
        ],
        allocation: AllocationKnowledge::Unknown,
        committed: false,
        source_role_verified: false,
        payload_encryption_verified: false,
        inactive_replay_verified: false,
        quorum_available: false,
        full_instance_ready: false,
        canonical_writer_permitted: false,
    };
    (
        CheckpointObservationCommand::collected(1, peers, proposal, manifest).unwrap(),
        binding,
    )
}
fn member(command: &CheckpointObservationCommand, index: u64) -> Entry {
    Entry {
        log_id: log(index),
        payload: EntryPayload::Membership(openraft::Membership::new(
            vec![[1, 2, 3].into()],
            command.peers.clone(),
        )),
    }
}
fn data(command: &CheckpointObservationCommand, index: u64) -> Entry {
    Entry {
        log_id: log(index),
        payload: EntryPayload::Normal(ControlData::Checkpoint(command.clone())),
    }
}
fn root() -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    root
}

#[test]
fn legacy_flat_wire_and_empty_state_remain_identical() {
    let legacy = ControlCommand {
        operation_id: "ab".repeat(16),
        partition_id: "room:fixture".into(),
        expected_epoch: 0,
        proposed_writer: 1,
        checkpoint_inventory_sha256: "cd".repeat(32),
    };
    let original = serde_json::to_vec(&legacy).unwrap();
    let golden = format!(
        "{{\"operationId\":\"{}\",\"partitionId\":\"room:fixture\",\"expectedEpoch\":0,\"proposedWriter\":1,\"checkpointInventorySha256\":\"{}\"}}",
        "ab".repeat(16), "cd".repeat(32),
    );
    assert_eq!(original, golden.as_bytes());
    let wrapped: ControlData = legacy.clone().into();
    assert_eq!(original, serde_json::to_vec(&wrapped).unwrap());
    let decoded: ControlData = serde_json::from_slice(&original).unwrap();
    assert!(matches!(decoded, ControlData::Legacy(command) if command == legacy));
    let state = serde_json::to_value(ControlState::default()).unwrap();
    assert!(state.get("checkpoints").is_none());
    let mut mixed = serde_json::to_value(wrapped).unwrap();
    mixed["schemaVersion"] = 2.into();
    assert!(serde_json::from_value::<ControlData>(mixed).is_err());
    // Shared golden from the existing Python physical command controller.
    let controller = ControlData::Legacy(ControlCommand {
        operation_id: format!("{:032x}", 1),
        checkpoint_inventory_sha256: "ab".repeat(32),
        ..legacy
    });
    assert_eq!(
        hex::encode(Sha256::digest(serde_json::to_vec(&controller).unwrap())),
        "5c7ee9597c941f9f8cf1b3eb1400f815242cbbbc27824b86f2510b116f0f5b3a"
    );
}

#[test]
fn strict_wire_refuses_duplicate_fields_roster_and_forged_bindings() {
    let (command, _) = command_fixture();
    assert!(command.valid());
    let wire = serde_json::to_string(&command).unwrap();
    let application: ControlData = serde_json::from_str(&wire).unwrap();
    assert!(matches!(application, ControlData::Checkpoint(decoded) if decoded == command));
    assert_eq!(
        serde_json::from_str::<CheckpointObservationCommand>(&wire).unwrap(),
        command
    );
    for field in ["schemaVersion", "kind", "collectorNodeId", "proposalSha256"] {
        let value = serde_json::to_value(&command).unwrap()[field].clone();
        let duplicate = format!("{},\"{field}\":{value}}}", &wire[..wire.len() - 1]);
        assert!(
            serde_json::from_str::<ControlData>(&duplicate).is_err(),
            "{field}"
        );
    }
    let peer = serde_json::to_string(&command.peers[&1]).unwrap();
    let duplicate = wire.replacen("\"peers\":{", &format!("\"peers\":{{\"1\":{peer},"), 1);
    assert!(serde_json::from_str::<ControlData>(&duplicate).is_err());
    for schema in [0, 1, 3, 255] {
        let mut changed = serde_json::to_value(&command).unwrap();
        changed["schemaVersion"] = schema.into();
        assert!(serde_json::from_value::<ControlData>(changed).is_err());
    }
    for field in [
        "quorumAvailable",
        "committed",
        "canonicalWriterPermitted",
        "sourceRoleVerified",
    ] {
        let mut changed = serde_json::to_value(&command).unwrap();
        changed["proposal"][field] = true.into();
        let parsed: CheckpointObservationCommand = serde_json::from_value(changed).unwrap();
        assert!(!parsed.valid());
    }
    let mut changed = command.clone();
    changed.manifest.source.signature = "00".repeat(64);
    assert!(!changed.valid());
    let mut changed = command.clone();
    changed.proposal.observations[1].node_id = 1;
    changed.proposal_sha256 = changed.proposal.sha256().unwrap();
    assert!(!changed.valid());
    let mut changed = command.clone();
    changed.proposal.required_bytes += 1;
    changed.proposal_sha256 = changed.proposal.sha256().unwrap();
    assert!(!changed.valid());
}

#[tokio::test]
async fn committed_record_reopens_and_snapshot_preserves_global_retry_identity() {
    let (command, binding) = command_fixture();
    let original_root = root();
    let mut store = Store::open(
        original_root.path(),
        binding.clone(),
        StoreLimits::default(),
    )
    .unwrap();
    store.apply([member(&command, 1)]).await.unwrap();
    let before = fs::metadata(original_root.path().join(".lock")).unwrap();
    let reply = store.apply([data(&command, 2)]).await.unwrap().remove(0);
    assert_eq!(reply.outcome, Outcome::Accepted);
    assert!(!reply.canonical_writer_permitted);
    assert_eq!(reply.committed_at, Some(log(2)));
    assert_eq!(store.apply([data(&command, 3)]).await.unwrap()[0], reply);
    let mut changed = command.clone();
    changed.proposal.observations[1].receipt_sha256 = "12".repeat(32);
    changed.proposal_sha256 = changed.proposal.sha256().unwrap();
    assert!(changed.valid());
    assert_eq!(
        store.apply([data(&changed, 4)]).await.unwrap()[0].outcome,
        Outcome::Refused
    );
    let legacy = ControlCommand {
        operation_id: command.operation_id().into(),
        partition_id: "room:fixture".into(),
        expected_epoch: 0,
        proposed_writer: 1,
        checkpoint_inventory_sha256: "12".repeat(32),
    };
    assert_eq!(
        store
            .apply([Entry {
                log_id: log(5),
                payload: EntryPayload::Normal(legacy.into())
            }])
            .await
            .unwrap()[0]
            .outcome,
        Outcome::Refused
    );
    let snapshot = store.build_snapshot().await.unwrap();
    assert!(snapshot.meta.snapshot_id.starts_with("v2-"));
    let follower_root = root();
    let mut follower_binding = binding.clone();
    follower_binding.node_id = 3;
    let mut follower = Store::open(
        follower_root.path(),
        follower_binding.clone(),
        StoreLimits::default(),
    )
    .unwrap();
    follower
        .install_snapshot(&snapshot.meta, snapshot.snapshot)
        .await
        .unwrap();
    assert_eq!(follower.apply([data(&command, 6)]).await.unwrap()[0], reply);
    drop(follower);
    let follower = Store::open(
        follower_root.path(),
        follower_binding,
        StoreLimits::default(),
    )
    .unwrap();
    assert_eq!(
        follower.control_state().await.unwrap().checkpoints[command.operation_id()].reply,
        reply
    );
    drop(store);
    let reopened = Store::open(original_root.path(), binding, StoreLimits::default()).unwrap();
    let state = reopened.control_state().await.unwrap();
    assert_eq!(state.checkpoints.len(), 1);
    assert!(state.intents.is_empty() && state.operations.is_empty());
    let after = fs::metadata(original_root.path().join(".lock")).unwrap();
    assert_eq!((before.dev(), before.ino()), (after.dev(), after.ino()));
}

#[tokio::test]
async fn changed_applied_membership_records_a_stable_refusal() {
    let (command, binding) = command_fixture();
    let root = root();
    let mut store = Store::open(root.path(), binding, StoreLimits::default()).unwrap();
    store
        .apply([member(&command, 1), member(&command, 2)])
        .await
        .unwrap();
    let reply = store.apply([data(&command, 3)]).await.unwrap().remove(0);
    assert_eq!(reply.outcome, Outcome::Refused);
    assert_eq!(reply.committed_at, Some(log(3)));
    assert_eq!(store.apply([data(&command, 4)]).await.unwrap()[0], reply);
    assert!(store
        .build_snapshot()
        .await
        .unwrap()
        .meta
        .snapshot_id
        .starts_with("v2-"));
}

#[tokio::test]
async fn legacy_collision_and_shared_quota_refuse_without_replacing_history() {
    let (command, binding) = command_fixture();
    let root = root();
    let mut store = Store::open(root.path(), binding.clone(), StoreLimits::default()).unwrap();
    let legacy = ControlCommand {
        operation_id: command.operation_id().into(),
        partition_id: "room:fixture".into(),
        expected_epoch: 0,
        proposed_writer: 1,
        checkpoint_inventory_sha256: "12".repeat(32),
    };
    store
        .apply([
            member(&command, 1),
            Entry {
                log_id: log(2),
                payload: EntryPayload::Normal(legacy.clone().into()),
            },
        ])
        .await
        .unwrap();
    assert_eq!(
        store.apply([data(&command, 3)]).await.unwrap()[0].outcome,
        Outcome::Refused
    );
    let state = store.control_state().await.unwrap();
    assert_eq!(state.operations[command.operation_id()].command, legacy);
    assert!(state.checkpoints.is_empty());
    let mut next = command.clone();
    next.proposal.operation_id = "13".repeat(16);
    next.proposal_sha256 = next.proposal.sha256().unwrap();
    let mut state = state;
    assert_eq!(
        state
            .apply_checkpoint(
                next.clone(),
                log(4),
                &binding.community_id,
                &binding.partition_id,
                1
            )
            .outcome,
        Outcome::Refused
    );
    assert!(state.checkpoints.is_empty());
    assert_eq!(
        state
            .apply_checkpoint(
                next,
                log(4),
                &binding.community_id,
                &binding.partition_id,
                2
            )
            .outcome,
        Outcome::Accepted
    );
    let another = ControlCommand {
        operation_id: "14".repeat(16),
        ..legacy
    };
    assert_eq!(
        state
            .apply_command(another, log(5), &binding.community_id, 2, 2)
            .outcome,
        Outcome::Refused
    );
    assert_eq!(state.operations.len() + state.checkpoints.len(), 2);
}

#[tokio::test]
async fn later_snapshot_cannot_erase_an_acknowledged_checkpoint() {
    let (command, binding) = command_fixture();
    let original_root = root();
    let other_root = root();
    let mut original = Store::open(
        original_root.path(),
        binding.clone(),
        StoreLimits::default(),
    )
    .unwrap();
    let mut other_binding = binding;
    other_binding.node_id = 2;
    let mut other = Store::open(other_root.path(), other_binding, StoreLimits::default()).unwrap();
    original
        .apply([member(&command, 1), data(&command, 2)])
        .await
        .unwrap();
    // A structurally valid later V1 snapshot contains no original operation.
    other
        .apply([
            member(&command, 1),
            Entry {
                log_id: log(3),
                payload: EntryPayload::Blank,
            },
        ])
        .await
        .unwrap();
    let lost_history = other.build_snapshot().await.unwrap();
    assert!(original
        .install_snapshot(&lost_history.meta, lost_history.snapshot)
        .await
        .is_err());
    assert!(original
        .control_state()
        .await
        .unwrap()
        .checkpoints
        .contains_key(command.operation_id()));
    assert_eq!(
        original.control_state().await.unwrap().last_applied,
        Some(log(2))
    );
}

#[tokio::test]
async fn inconsistent_checkpoint_snapshots_refuse_before_state_publication() {
    use crate::{model::StateEnvelope, snapshot::BoundedSnapshot};
    let (command, binding) = command_fixture();
    let source_root = root();
    let mut source =
        Store::open(source_root.path(), binding.clone(), StoreLimits::default()).unwrap();
    source
        .apply([member(&command, 1), data(&command, 2)])
        .await
        .unwrap();
    let original = source.control_state().await.unwrap();
    // First establish the valid typed canonical baseline really imports.
    let valid_root = root();
    let mut target_binding = binding.clone();
    target_binding.node_id = 2;
    let mut valid = Store::open(
        valid_root.path(),
        target_binding.clone(),
        StoreLimits::default(),
    )
    .unwrap();
    let baseline = source.build_snapshot().await.unwrap();
    valid
        .install_snapshot(&baseline.meta, baseline.snapshot)
        .await
        .unwrap();
    assert!(valid
        .control_state()
        .await
        .unwrap()
        .checkpoints
        .contains_key(command.operation_id()));
    for fault in [
        "old_schema",
        "unknown_schema",
        "uncovered_reply",
        "wrong_id",
        "bad_proposal_hash",
        "writer_grant",
        "conflict_outcome",
    ] {
        let target_root = root();
        let mut target = Store::open(
            target_root.path(),
            target_binding.clone(),
            StoreLimits::default(),
        )
        .unwrap();
        let mut state = original.clone();
        let receipt = state.checkpoints.get_mut(command.operation_id()).unwrap();
        match fault {
            "uncovered_reply" => receipt.reply.committed_at = Some(log(99)),
            "wrong_id" => {
                let receipt = state.checkpoints.remove(command.operation_id()).unwrap();
                state.checkpoints.insert("11".repeat(16), receipt);
            }
            "bad_proposal_hash" => receipt.command.proposal_sha256 = "11".repeat(32),
            "writer_grant" => receipt.reply.canonical_writer_permitted = true,
            "conflict_outcome" => receipt.reply.outcome = Outcome::Conflict,
            _ => (),
        }
        let schema = match fault {
            "old_schema" => 1,
            "unknown_schema" => 3,
            _ => 2,
        };
        let envelope = StateEnvelope {
            schema_version: schema,
            community_id: binding.community_id.clone(),
            partition_id: binding.partition_id.clone(),
            state,
        };
        let bytes = serde_json::to_vec(&envelope).unwrap();
        let meta = openraft::SnapshotMeta {
            last_log_id: original.last_applied,
            last_membership: original.membership.clone(),
            snapshot_id: format!("v{schema}-{}", hex::encode(Sha256::digest(&bytes))),
        };
        assert!(
            target
                .install_snapshot(
                    &meta,
                    Box::new(BoundedSnapshot::from_bytes(bytes, 16 * 1024 * 1024).unwrap())
                )
                .await
                .is_err(),
            "{fault}"
        );
        assert_eq!(target.control_state().await.unwrap().last_applied, None);
        assert!(target.control_state().await.unwrap().checkpoints.is_empty());
        assert!(target.get_current_snapshot().await.unwrap().is_none());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires the exact preserved V1 worker and stage hash; run explicitly"]
async fn actual_preserved_v1_worker_accepts_same_v1_binding_and_refuses_v2_upgrade() {
    use crate::transport::Identity;
    use openraft::storage::{RaftLogStorage, RaftLogStorageExt};
    use std::{
        io::{Read, Write},
        net::TcpListener,
        os::unix::net::UnixStream,
        path::PathBuf,
        process::{Command, Stdio},
        time::Duration,
    };
    let binary = PathBuf::from(
        std::env::var_os("WABI_V1_READER_BINARY").expect("preserved binary required"),
    );
    let expected = std::env::var("WABI_V1_READER_SHA256").expect("exact stage hash required");
    assert!(binary.is_absolute() && binary.file_name().unwrap() == "reader.bin");
    let parent = binary.parent().unwrap();
    assert_eq!(parent.parent().unwrap(), std::path::Path::new("/tmp"));
    assert!(parent
        .file_name()
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("wabi-geographic-v1-reader-"));
    let directory = fs::symlink_metadata(parent).unwrap();
    let before = fs::symlink_metadata(&binary).unwrap();
    assert!(directory.is_dir() && !directory.file_type().is_symlink());
    assert!(before.is_file() && !before.file_type().is_symlink() && before.nlink() == 1);
    assert_eq!(before.uid(), directory.uid());
    assert_eq!(directory.permissions().mode() & 0o077, 0);
    assert_eq!(before.permissions().mode() & 0o077, 0);
    assert!(before.len() <= 32 * 1024 * 1024 && lower_hex(&expected, 64));
    let opened = fs::File::open(&binary).unwrap();
    let held = opened.metadata().unwrap();
    assert_eq!((before.dev(), before.ino()), (held.dev(), held.ino()));
    let mut artifact = Vec::new();
    opened
        .take(32 * 1024 * 1024 + 1)
        .read_to_end(&mut artifact)
        .unwrap();
    assert_eq!(artifact.len() as u64, before.len());
    assert_eq!(hex::encode(Sha256::digest(&artifact)), expected);
    assert!(artifact.starts_with(b"\x7fELF"));
    assert!(artifact
        .windows(b"wabi-control-v1/openraft-0.9.25-json".len())
        .any(|w| w == b"wabi-control-v1/openraft-0.9.25-json"));
    assert!(!artifact
        .windows(b"wabi-control-v2/openraft-0.9.25-json".len())
        .any(|w| w == b"wabi-control-v2/openraft-0.9.25-json"));
    let after = fs::symlink_metadata(&binary).unwrap();
    assert_eq!(
        (
            before.dev(),
            before.ino(),
            before.len(),
            before.mtime(),
            before.mtime_nsec(),
            before.ctime(),
            before.ctime_nsec()
        ),
        (
            after.dev(),
            after.ino(),
            after.len(),
            after.mtime(),
            after.mtime_nsec(),
            after.ctime(),
            after.ctime_nsec()
        )
    );
    drop(artifact);
    struct OwnedChild(std::process::Child);
    impl Drop for OwnedChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    fn exchange(path: &std::path::Path, action: &str) -> serde_json::Value {
        let mut socket = UnixStream::connect(path).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        socket
            .set_write_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let bytes = serde_json::to_vec(&serde_json::json!({"action":action})).unwrap();
        socket
            .write_all(&(bytes.len() as u32).to_be_bytes())
            .unwrap();
        socket.write_all(&bytes).unwrap();
        let mut length = [0; 4];
        socket.read_exact(&mut length).unwrap();
        let length = u32::from_be_bytes(length) as usize;
        assert!((1..=4096).contains(&length));
        let mut bytes = vec![0; length];
        socket.read_exact(&mut bytes).unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }
    let root = root();
    let owner = "c1".repeat(32);
    let (mut command, binding) = command_fixture();
    let mut reservations = Vec::new();
    for node in 1..=3 {
        let socket = TcpListener::bind("127.0.0.1:0").unwrap();
        let identity = Identity::generate().unwrap();
        command.peers.get_mut(&node).unwrap().public_key = identity.public_hex();
        command.peers.get_mut(&node).unwrap().rpc_address =
            socket.local_addr().unwrap().to_string();
        if node == 1 {
            identity.persist_new(root.path()).unwrap();
        }
        reservations.push(socket);
    }
    command.proposal.roster_digest = roster_digest(&command.peers).unwrap();
    command.proposal_sha256 = command.proposal.sha256().unwrap();
    assert!(command.valid());
    let config = serde_json::json!({"binding":binding,"peers":command.peers,"bindAddress":command.peers[&1].rpc_address,"owner":owner});
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(root.path().join("fixture.json"))
        .unwrap();
    file.write_all(&serde_json::to_vec(&config).unwrap())
        .unwrap();
    file.sync_all().unwrap();
    drop(file);
    let mut store = Store::open(root.path(), binding.clone(), StoreLimits::default()).unwrap();
    let member = member(&command, 1);
    // A real Raft reader needs a complete prefix from index zero. The other
    // deterministic application fixtures do not start a Raft actor.
    let initial = Entry {
        log_id: log(0),
        payload: EntryPayload::Blank,
    };
    // Exercise the actual old reader against a flat legacy command AND its
    // persisted application result, not only membership/empty-state records.
    let legacy = Entry {
        log_id: log(2),
        payload: EntryPayload::Normal(
            ControlCommand {
                operation_id: "c2".repeat(16),
                partition_id: "room:fixture".into(),
                expected_epoch: 0,
                proposed_writer: 1,
                checkpoint_inventory_sha256: "c3".repeat(32),
            }
            .into(),
        ),
    };
    store
        .blocking_append([initial.clone(), member.clone(), legacy.clone()])
        .await
        .unwrap();
    store
        .save_vote(&openraft::Vote::new_committed(1, 1))
        .await
        .unwrap();
    store.save_committed(Some(log(2))).await.unwrap();
    assert_eq!(
        store.apply([initial, member, legacy]).await.unwrap()[2].outcome,
        Outcome::Accepted
    );
    store.build_snapshot().await.unwrap();
    drop(store);
    // Let only the old worker bind its selected endpoint. Other ports remain
    // reserved and have no actual recovery-voter service behind them.
    drop(reservations.remove(0));
    let spawn = || {
        OwnedChild(
            Command::new(&binary)
                .args([
                    "--exact",
                    "processes::separate_process_recovery_worker",
                    "--ignored",
                    "--nocapture",
                    "--test-threads=1",
                ])
                .env_clear()
                .env("WABI_RPC_FIXTURE_ROOT", root.path())
                .env("WABI_RPC_FIXTURE_OWNER", &owner)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap(),
        )
    };
    let mut positive = spawn();
    let control = root.path().join("control.sock");
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            if let Some(exit) = positive.0.try_wait().unwrap() {
                let mut diagnostic = String::new();
                positive
                    .0
                    .stderr
                    .take()
                    .unwrap()
                    .take(16 * 1024)
                    .read_to_string(&mut diagnostic)
                    .unwrap();
                panic!("V1 positive control exited before readiness: {exit}; {diagnostic}");
            }
            if control.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let status = exchange(&control, "status");
    assert_eq!(status["nodeId"], 1);
    assert_eq!(status["durableAppliedIndex"], 2);
    assert_eq!(status["operations"], 1);
    assert_eq!(status["epoch"], 1);
    assert_eq!(status["canonicalWriterPermitted"], false);
    assert_eq!(exchange(&control, "stop")["result"], "stopped");
    let positive_exit = tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            if let Some(exit) = positive.0.try_wait().unwrap() {
                break exit;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(positive_exit.success());
    drop(positive);
    assert!(!control.exists());
    let mut store = Store::open(root.path(), binding.clone(), StoreLimits::default()).unwrap();
    let data = data(&command, 3);
    store.blocking_append([data.clone()]).await.unwrap();
    store.save_committed(Some(log(3))).await.unwrap();
    assert_eq!(
        store.apply([data]).await.unwrap()[0].outcome,
        Outcome::Accepted
    );
    store.build_snapshot().await.unwrap();
    let expected_state = store.control_state().await.unwrap();
    let lock = fs::metadata(root.path().join(".lock")).unwrap();
    drop(store);
    let mut negative = spawn();
    let exit = tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            if let Some(exit) = negative.0.try_wait().unwrap() {
                break exit;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(exit.code(), Some(101));
    let mut diagnostic = String::new();
    negative
        .0
        .stderr
        .take()
        .unwrap()
        .take(16 * 1024)
        .read_to_string(&mut diagnostic)
        .unwrap();
    assert!(
        diagnostic.contains("Format"),
        "old worker must report the actual store-format refusal"
    );
    assert!(!control.exists());
    drop(negative);
    let store = Store::open(root.path(), binding, StoreLimits::default()).unwrap();
    assert_eq!(store.control_state().await.unwrap(), expected_state);
    let after = fs::metadata(root.path().join(".lock")).unwrap();
    assert_eq!((lock.dev(), lock.ino()), (after.dev(), after.ino()));
    drop(store);
    drop(reservations);
}
