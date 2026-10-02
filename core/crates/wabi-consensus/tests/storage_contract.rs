use openraft::{
    storage::{RaftLogStorage, RaftLogStorageExt, RaftStateMachine},
    EntryPayload, RaftLogReader, RaftSnapshotBuilder, Vote,
};
use std::{collections::BTreeMap, io::SeekFrom};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};
use wabi_consensus::{
    model::*,
    snapshot::BoundedSnapshot,
    store::{Store, StoreError, StoreLimits},
    ConsensusTypes, Entry, LogId,
};

fn private_root() -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    root
}
fn binding(node_id: u64) -> StoreBinding {
    StoreBinding {
        community_id: "ab".repeat(32),
        partition_id: "community/control".into(),
        node_id,
    }
}
fn log(index: u64) -> LogId {
    LogId::new(openraft::CommittedLeaderId::new(1, 1), index)
}
fn peers() -> BTreeMap<u64, RecoveryPeer> {
    (1..=3)
        .map(|id| {
            (
                id,
                RecoveryPeer {
                    protocol: CONTROL_PROTOCOL,
                    community_id: binding(1).community_id,
                    site_id: format!("site-{id}"),
                    public_key: format!("{id:064x}"),
                    rpc_address: format!("127.0.0.1:{}", 12000 + id),
                },
            )
        })
        .collect()
}
fn membership(index: u64) -> Entry {
    Entry {
        log_id: log(index),
        payload: EntryPayload::Membership(openraft::Membership::new(
            vec![[1, 2, 3].into()],
            peers(),
        )),
    }
}
fn command(id: u64, expected_epoch: u64) -> ControlCommand {
    ControlCommand {
        operation_id: format!("{id:032x}"),
        partition_id: "room:fixture".into(),
        expected_epoch,
        proposed_writer: 1,
        checkpoint_inventory_sha256: "cd".repeat(32),
    }
}
fn data(index: u64, command: ControlCommand) -> Entry {
    Entry {
        log_id: log(index),
        payload: EntryPayload::Normal(command),
    }
}
fn open(root: &std::path::Path, node: u64) -> Store {
    Store::open(root, binding(node), StoreLimits::default()).unwrap()
}

struct Builder;
impl openraft::testing::StoreBuilder<ConsensusTypes, Store, Store, tempfile::TempDir> for Builder {
    async fn build(
        &self,
    ) -> Result<(tempfile::TempDir, Store, Store), openraft::StorageError<u64>> {
        let root = private_root();
        let store = open(root.path(), 1);
        Ok((root, store.clone(), store))
    }
}
#[test]
fn upstream_storage_suite_uses_the_actual_transactional_store() {
    openraft::testing::Suite::<ConsensusTypes, Store, Store, Builder, tempfile::TempDir>::test_all(
        Builder,
    )
    .unwrap();
}

#[tokio::test]
async fn votes_commit_membership_receipts_and_snapshot_survive_reopen() {
    let root = private_root();
    let mut store = open(root.path(), 1);
    let entries = vec![membership(0), data(1, command(1, 0))];
    store.save_vote(&Vote::new_committed(4, 2)).await.unwrap();
    store.blocking_append(entries.clone()).await.unwrap();
    store.save_committed(Some(log(1))).await.unwrap();
    let replies = store.apply(entries).await.unwrap();
    assert_eq!(replies[1].outcome, Outcome::Accepted);
    assert!(!replies[1].canonical_writer_permitted);
    let snapshot = store.build_snapshot().await.unwrap();
    let meta = snapshot.meta;
    drop(snapshot.snapshot);
    drop(store);
    let mut store = open(root.path(), 1);
    assert_eq!(
        store.read_vote().await.unwrap(),
        Some(Vote::new_committed(4, 2))
    );
    assert_eq!(store.read_committed().await.unwrap(), Some(log(1)));
    assert_eq!(store.applied_state().await.unwrap().0, Some(log(1)));
    assert_eq!(
        store.get_current_snapshot().await.unwrap().unwrap().meta,
        meta
    );
    let retry = store
        .apply([data(2, command(1, 0))])
        .await
        .unwrap()
        .remove(0);
    assert_eq!(retry, replies[1]);
    let mut changed = command(1, 1);
    changed.proposed_writer = 2;
    assert_eq!(
        store.apply([data(3, changed)]).await.unwrap()[0].outcome,
        Outcome::Refused
    );
    assert_eq!(
        store.control_state().await.unwrap().intents["room:fixture"].epoch,
        1
    );
    assert_eq!(
        store.apply([data(4, command(2, 0))]).await.unwrap()[0].outcome,
        Outcome::Conflict
    );
    assert_eq!(
        store.apply([data(5, command(3, 1))]).await.unwrap()[0].epoch,
        2
    );
}

#[tokio::test]
async fn regressions_gaps_and_changes_to_committed_logs_refuse_atomically() {
    let root = private_root();
    let mut store = open(root.path(), 1);
    store.save_vote(&Vote::new_committed(3, 1)).await.unwrap();
    assert!(store.save_vote(&Vote::new(2, 3)).await.is_err());
    assert_eq!(
        store.read_vote().await.unwrap(),
        Some(Vote::new_committed(3, 1))
    );
    store
        .blocking_append([membership(0), data(1, command(1, 0))])
        .await
        .unwrap();
    assert!(store
        .blocking_append([data(3, command(3, 1))])
        .await
        .is_err());
    assert!(store
        .blocking_append([data(2, command(2, 1)), data(4, command(4, 1))])
        .await
        .is_err());
    assert_eq!(
        store.get_log_state().await.unwrap().last_log_id,
        Some(log(1))
    );
    store.save_committed(Some(log(1))).await.unwrap();
    assert!(store.save_committed(Some(log(0))).await.is_err());
    assert!(store.save_committed(None).await.is_err());
    assert!(store
        .blocking_append([data(1, command(99, 0))])
        .await
        .is_err());
    assert!(store.truncate(log(1)).await.is_err());
    assert_eq!(store.try_get_log_entries(0..=1).await.unwrap().len(), 2);
}

#[tokio::test]
async fn superseded_prefix_is_not_resurrected_and_future_term_at_purged_index_refuses() {
    let root = private_root();
    let mut store = open(root.path(), 1);
    let entries = [membership(0), data(1, command(1, 0))];
    store.blocking_append(entries.clone()).await.unwrap();
    store.save_committed(Some(log(1))).await.unwrap();
    store.apply(entries.clone()).await.unwrap();
    store.build_snapshot().await.unwrap();
    store.purge(log(1)).await.unwrap();
    store.blocking_append(entries).await.unwrap();
    assert!(store.try_get_log_entries(0..).await.unwrap().is_empty());
    assert_eq!(
        store.get_log_state().await.unwrap().last_purged_log_id,
        Some(log(1))
    );
    let mut invalid = data(1, command(2, 1));
    invalid.log_id = LogId::new(openraft::CommittedLeaderId::new(9, 2), 1);
    assert!(store.blocking_append([invalid]).await.is_err());
    assert_eq!(
        store.control_state().await.unwrap().intents["room:fixture"].epoch,
        1
    );
    store
        .blocking_append([data(2, command(2, 1))])
        .await
        .unwrap();
    assert_eq!(store.try_get_log_entries(0..).await.unwrap().len(), 1);
}

#[tokio::test]
async fn oversized_fields_are_refused_before_serialization_and_do_not_advance_state() {
    let root = private_root();
    let mut store = open(root.path(), 1);
    for field in ["operation", "partition", "inventory"] {
        let mut oversized = command(1, 0);
        match field {
            "operation" => oversized.operation_id = "0".repeat(33),
            "partition" => oversized.partition_id = "a".repeat(129),
            _ => oversized.checkpoint_inventory_sha256 = "0".repeat(65),
        }
        assert!(store
            .blocking_append([data(0, oversized.clone())])
            .await
            .is_err());
        assert!(store.apply([data(0, oversized)]).await.is_err());
        assert_eq!(store.get_log_state().await.unwrap().last_log_id, None);
        assert_eq!(store.applied_state().await.unwrap().0, None);
    }
}

#[tokio::test]
async fn stale_wrong_community_and_changed_snapshot_metadata_refuse() {
    let a = private_root();
    let b = private_root();
    let mut source = open(a.path(), 1);
    let mut receiver = open(b.path(), 2);
    source
        .apply([membership(0), data(1, command(1, 0))])
        .await
        .unwrap();
    let snapshot = source.build_snapshot().await.unwrap();
    receiver
        .install_snapshot(&snapshot.meta, snapshot.snapshot)
        .await
        .unwrap();
    assert_eq!(
        receiver.control_state().await.unwrap().intents["room:fixture"].epoch,
        1
    );
    let snapshot = source.build_snapshot().await.unwrap();
    let mut wrong = snapshot.meta;
    wrong.last_log_id = Some(log(99));
    assert!(receiver
        .install_snapshot(&wrong, snapshot.snapshot)
        .await
        .is_err());
    assert_eq!(receiver.applied_state().await.unwrap().0, Some(log(1)));
    receiver.apply([data(2, command(2, 1))]).await.unwrap();
    let stale = source.build_snapshot().await.unwrap();
    assert!(receiver
        .install_snapshot(&stale.meta, stale.snapshot)
        .await
        .is_err());
    assert_eq!(receiver.applied_state().await.unwrap().0, Some(log(2)));
    let c = private_root();
    let mut different = binding(3);
    different.community_id = "ef".repeat(32);
    let mut foreign = Store::open(c.path(), different, StoreLimits::default()).unwrap();
    let snapshot = source.build_snapshot().await.unwrap();
    assert!(foreign
        .install_snapshot(&snapshot.meta, snapshot.snapshot)
        .await
        .is_err());
    assert_eq!(foreign.applied_state().await.unwrap().0, None);
}

#[tokio::test]
async fn internally_inconsistent_snapshot_refuses_even_with_matching_payload_hash() {
    use sha2::{Digest, Sha256};
    use tokio::io::AsyncReadExt;
    let a = private_root();
    let b = private_root();
    let mut source = open(a.path(), 1);
    let mut receiver = open(b.path(), 2);
    source
        .apply([membership(0), data(1, command(1, 0))])
        .await
        .unwrap();
    for fault in [
        "missing_receipt",
        "wrong_epoch",
        "writer_permit",
        "different_inventory",
    ] {
        let mut snapshot = source.build_snapshot().await.unwrap();
        let mut raw = Vec::new();
        snapshot.snapshot.read_to_end(&mut raw).await.unwrap();
        let mut value: serde_json::Value = serde_json::from_slice(&raw).unwrap();
        match fault {
            "missing_receipt" => {
                value["state"]["operations"]
                    .as_object_mut()
                    .unwrap()
                    .clear();
            }
            "wrong_epoch" => value["state"]["intents"]["room:fixture"]["epoch"] = 99.into(),
            "writer_permit" => {
                value["state"]["operations"][format!("{:032x}", 1)]["reply"]
                    ["canonicalWriterPermitted"] = true.into()
            }
            _ => {
                value["state"]["intents"]["room:fixture"]["checkpointInventorySha256"] =
                    "ef".repeat(32).into()
            }
        }
        let bytes = serde_json::to_vec(&value).unwrap();
        snapshot.meta.snapshot_id = format!("v1-{}", hex::encode(Sha256::digest(&bytes)));
        assert!(
            receiver
                .install_snapshot(
                    &snapshot.meta,
                    Box::new(BoundedSnapshot::from_bytes(bytes, 16 * 1024 * 1024).unwrap())
                )
                .await
                .is_err(),
            "{fault}"
        );
        assert_eq!(receiver.applied_state().await.unwrap().0, None);
        assert!(receiver.get_current_snapshot().await.unwrap().is_none());
    }
}

#[tokio::test]
async fn budgets_refuse_before_snapshot_allocation_or_log_publication() {
    let mut buffer = BoundedSnapshot::new(32);
    buffer.write_all(&[0u8; 32]).await.unwrap();
    assert!(buffer.write_all(&[1]).await.is_err());
    assert!(buffer.seek(SeekFrom::Start(33)).await.is_err());
    let root = private_root();
    let mut limits = StoreLimits::default();
    limits.max_log_bytes = 128;
    let mut store = Store::open(root.path(), binding(1), limits).unwrap();
    assert!(store.blocking_append([membership(0)]).await.is_err());
    assert_eq!(store.get_log_state().await.unwrap().last_log_id, None);
    drop(store);
    let mut store = open(root.path(), 1);
    assert_eq!(store.get_log_state().await.unwrap().last_log_id, None);
}

#[test]
fn identity_and_exclusive_private_root_do_not_silently_reset() {
    let root = private_root();
    let store = open(root.path(), 1);
    assert!(matches!(
        Store::open(root.path(), binding(1), StoreLimits::default()),
        Err(StoreError::Ownership)
    ));
    drop(store);
    assert!(matches!(
        Store::open(root.path(), binding(2), StoreLimits::default()),
        Err(StoreError::Format)
    ));
    let store = open(root.path(), 1);
    drop(store);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root = private_root();
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(matches!(
            Store::open(root.path(), binding(1), StoreLimits::default()),
            Err(StoreError::Ownership)
        ));
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let elsewhere = tempfile::NamedTempFile::new().unwrap();
        symlink(elsewhere.path(), root.path().join(".lock")).unwrap();
        assert!(matches!(
            Store::open(root.path(), binding(1), StoreLimits::default()),
            Err(StoreError::Ownership)
        ));
    }
}

#[cfg(unix)]
#[tokio::test]
async fn runtime_refuses_replaced_lock_database_or_directory_and_preserves_lock_bytes() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    for replaced in [".lock", "consensus.redb", "directory"] {
        let parent = private_root();
        let root = parent.path().join("node");
        std::fs::create_dir(&root).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let lock = root.join(".lock");
        std::fs::write(&lock, b"persistent lock diagnostic sentinel").unwrap();
        let identity = std::fs::metadata(&lock).unwrap().ino();
        let mut store = open(&root, 1);
        assert_eq!(
            std::fs::read(&lock).unwrap(),
            b"persistent lock diagnostic sentinel"
        );
        assert_eq!(std::fs::metadata(&lock).unwrap().ino(), identity);
        if replaced == "directory" {
            std::fs::rename(&root, parent.path().join("held-node")).unwrap();
            std::fs::create_dir(&root).unwrap();
            std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        } else {
            let path = root.join(replaced);
            std::fs::rename(&path, root.join("held-inode")).unwrap();
            std::fs::write(&path, b"substituted").unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        assert!(store.read_vote().await.is_err());
        assert!(store.save_vote(&Vote::new_committed(4, 2)).await.is_err());
        drop(store);
    }
}

#[test]
fn explicit_roster_rejects_duplicate_sites_keys_endpoints_and_protocol() {
    let good = peers();
    wabi_consensus::trust::validate_three_voter_roster(&binding(1), &good).unwrap();
    for field in ["site", "key", "endpoint", "protocol", "community"] {
        let mut bad = good.clone();
        let prior = bad[&1].clone();
        let peer = bad.get_mut(&2).unwrap();
        match field {
            "site" => peer.site_id = prior.site_id,
            "key" => peer.public_key = prior.public_key,
            "endpoint" => peer.rpc_address = prior.rpc_address,
            "protocol" => peer.protocol += 1,
            _ => peer.community_id = "00".repeat(32),
        }
        assert!(wabi_consensus::trust::validate_three_voter_roster(&binding(1), &bad).is_err());
    }
    let mut bad = good;
    bad.remove(&3);
    assert!(wabi_consensus::trust::validate_three_voter_roster(&binding(1), &bad).is_err());
}

// Separate process, killed without dropping the store or shutting down Tokio.
// The parent owns and removes the private fixture, including its persistent lock.
#[tokio::test]
#[ignore = "subprocess fixture; invoked only by the kill contract"]
async fn acknowledged_state_process_worker() {
    let Some(root) = std::env::var_os("WABI_CONSENSUS_KILL_FIXTURE") else {
        return;
    };
    use std::io::Write;
    let mut store = open(std::path::Path::new(&root), 1);
    let entries = [membership(0), data(1, command(1, 0))];
    store.save_vote(&Vote::new_committed(4, 2)).await.unwrap();
    store.blocking_append(entries.clone()).await.unwrap();
    store.save_committed(Some(log(1))).await.unwrap();
    if std::env::var_os("WABI_CONSENSUS_KILL_APPLIED").is_some() {
        assert_eq!(
            store.apply(entries).await.unwrap()[1].outcome,
            Outcome::Accepted
        );
        store.build_snapshot().await.unwrap();
    }
    println!("WABI_CONSENSUS_ACK_DURABLE");
    std::io::stdout().flush().unwrap();
    tokio::time::sleep(std::time::Duration::from_secs(30)).await;
    panic!("parent did not kill fixture within deadline");
}

#[tokio::test]
async fn killed_process_preserves_acknowledged_vote_logs_commit_applied_receipt_and_snapshot() {
    use std::io::BufRead;
    use std::process::{Command, Stdio};
    struct OwnedChild(std::process::Child);
    impl Drop for OwnedChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    for applied in [false, true] {
        let root = private_root();
        let mut process = Command::new(std::env::current_exe().unwrap());
        process
            .args([
                "--exact",
                "acknowledged_state_process_worker",
                "--ignored",
                "--nocapture",
            ])
            .env("WABI_CONSENSUS_KILL_FIXTURE", root.path())
            .env_remove("WABI_CONSENSUS_KILL_APPLIED")
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if applied {
            process.env("WABI_CONSENSUS_KILL_APPLIED", "1");
        }
        let mut child = OwnedChild(process.spawn().unwrap());
        let output = child.0.stdout.take().unwrap();
        let (sender, ready) = std::sync::mpsc::channel();
        let drain = std::thread::spawn(move || {
            for line in std::io::BufReader::new(output).lines() {
                if line.is_ok_and(|line| line == "WABI_CONSENSUS_ACK_DURABLE") {
                    let _ = sender.send(());
                    return;
                }
            }
        });
        ready
            .recv_timeout(std::time::Duration::from_secs(10))
            .unwrap();
        child.0.kill().unwrap();
        let status = child.0.wait().unwrap();
        assert!(!status.success());
        drain.join().unwrap();
        let mut store = open(root.path(), 1);
        assert_eq!(
            store.read_vote().await.unwrap(),
            Some(Vote::new_committed(4, 2))
        );
        assert_eq!(store.read_committed().await.unwrap(), Some(log(1)));
        assert_eq!(store.try_get_log_entries(0..=1).await.unwrap().len(), 2);
        let state = store.control_state().await.unwrap();
        if applied {
            assert_eq!(state.last_applied, Some(log(1)));
            assert_eq!(state.intents["room:fixture"].epoch, 1);
            assert_eq!(
                state.operations[&format!("{:032x}", 1)].reply.outcome,
                Outcome::Accepted
            );
            assert!(store.get_current_snapshot().await.unwrap().is_some());
        } else {
            assert!(state.last_applied.is_none());
            assert!(state.operations.is_empty());
            assert!(store.get_current_snapshot().await.unwrap().is_none());
        }
    }
}
