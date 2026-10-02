use super::*;
use openraft::storage::RaftLogStorage;
use std::time::Duration;

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn runtime_lease_covers_cancelled_blocking_io_snapshot_owner_and_actual_lock_release() {
    use openraft::{storage::RaftStateMachine, RaftSnapshotBuilder};
    use std::{
        os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
        sync::atomic::{AtomicBool, Ordering},
    };
    struct Lease {
        path: PathBuf,
        inode: u64,
        released_after_lock: Arc<AtomicBool>,
    }
    impl Drop for Lease {
        fn drop(&mut self) {
            let probe = OpenOptions::new()
                .read(true)
                .write(true)
                .custom_flags(0o400000)
                .open(&self.path)
                .unwrap();
            assert_eq!(probe.metadata().unwrap().ino(), self.inode);
            self.released_after_lock
                .store(probe.try_lock_exclusive().unwrap(), Ordering::SeqCst);
        }
    }
    let root = tempfile::tempdir().unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let initial = Store::open(
        root.path(),
        StoreBinding {
            community_id: "ab".repeat(32),
            partition_id: "community/control".into(),
            node_id: 1,
        },
        StoreLimits {
            min_free_bytes: 1,
            ..Default::default()
        },
    )
    .unwrap();
    let path = root.path().join(".lock");
    let inode = fs::metadata(&path).unwrap().ino();
    let released = Arc::new(AtomicBool::new(false));
    let store = Arc::new(
        initial
            .with_runtime_owner(Arc::new(Lease {
                path: path.clone(),
                inode,
                released_after_lock: released.clone(),
            }))
            .unwrap(),
    );
    let mut state_machine = (*store).clone();
    let mut snapshot = state_machine.get_snapshot_builder().await;
    drop(state_machine);
    let (entered, entered_rx) = tokio::sync::oneshot::channel();
    let (release, released_rx) = std::sync::mpsc::channel();
    let worker_store = store.clone();
    let caller = tokio::spawn(async move {
        worker_store
            .run(move |inner| {
                let tx = transaction(inner, 1024 * 1024)?;
                put(&tx, "logBytes", &0u64)?;
                entered.send(()).unwrap();
                released_rx.recv().unwrap();
                io(tx.commit())
            })
            .await
    });
    entered_rx.await.unwrap();
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    let wait_store = store.clone();
    let waiting = tokio::spawn(async move { wait_store.await_runtime_owners().await });
    tokio::task::yield_now().await;
    assert!(!waiting.is_finished());
    assert!(!released.load(Ordering::SeqCst));
    release.send(()).unwrap();
    // The actual builder still owns the same Inner even after IO finishes.
    snapshot.build_snapshot().await.unwrap();
    assert!(!waiting.is_finished());
    drop(snapshot);
    waiting.await.unwrap().unwrap();
    assert!(!released.load(Ordering::SeqCst));
    drop(store);
    assert!(
        released.load(Ordering::SeqCst),
        "runtime lease was released before original database lock"
    );
    assert_eq!(fs::metadata(&path).unwrap().ino(), inode);
}

#[cfg(target_os = "linux")]
fn kill_ready() {
    use std::io::Write;
    println!("WABI_V2_STORAGE_BOUNDARY");
    std::io::stdout().flush().unwrap();
    std::thread::sleep(Duration::from_secs(30));
    panic!("owned parent did not kill V2 worker");
}

#[cfg(target_os = "linux")]
#[tokio::test]
#[ignore = "owned subprocess fixture for V2 transaction power-loss boundaries"]
async fn v2_transaction_process_worker() {
    use openraft::{
        storage::{RaftLogStorageExt, RaftStateMachine},
        RaftSnapshotBuilder,
    };
    let Some(root) = std::env::var_os("WABI_V2_KILL_ROOT") else {
        return;
    };
    let mode = std::env::var("WABI_V2_KILL_BOUNDARY").unwrap();
    let (command, binding) = crate::availability_control::tests::command_fixture();
    let mut store = Store::open(Path::new(&root), binding, StoreLimits::default()).unwrap();
    let member = Entry {
        log_id: LogId::new(openraft::CommittedLeaderId::new(1, 1), 1),
        payload: EntryPayload::Membership(openraft::Membership::new(vec![[1, 2, 3].into()], {
            serde_json::from_value::<std::collections::BTreeMap<u64, RecoveryPeer>>(
                serde_json::to_value(&command).unwrap()["peers"].clone(),
            )
            .unwrap()
        })),
    };
    let data = Entry {
        log_id: LogId::new(openraft::CommittedLeaderId::new(1, 1), 2),
        payload: EntryPayload::Normal(ControlData::Checkpoint(command.clone())),
    };
    store.blocking_append([member.clone()]).await.unwrap();
    store.apply([member]).await.unwrap();
    store.build_snapshot().await.unwrap();
    if mode == "before_log" {
        store
            .run(move |inner| {
                let tx = transaction(inner, 1024 * 1024)?;
                upgrade_format(inner, &tx, 2)?;
                let encoded = encode(&EntryEnvelope {
                    schema_version: 2,
                    entry: data,
                })?;
                let old: u64 = writable_meta(&tx, "logBytes")?;
                io(io(tx.open_table(LOGS))?.insert(2, encoded.as_slice()))?;
                put(&tx, "logBytes", &(old + encoded.len() as u64))?;
                kill_ready();
                Ok(())
            })
            .await
            .unwrap();
        return;
    }
    store.blocking_append([data.clone()]).await.unwrap();
    if mode == "after_log" {
        kill_ready();
    }
    store.save_committed(Some(data.log_id)).await.unwrap();
    if mode == "before_state" {
        store
            .run(move |inner| {
                let mut state = read_state(inner, &io(inner.db.begin_read())?)?;
                state.apply_checkpoint(
                    command,
                    data.log_id,
                    &inner.binding.community_id,
                    &inner.binding.partition_id,
                    MAX_OPERATIONS,
                );
                state.last_applied = Some(data.log_id);
                let tx = transaction(inner, 1024 * 1024)?;
                put(&tx, "state", &envelope(inner, state, 2))?;
                kill_ready();
                Ok(())
            })
            .await
            .unwrap();
        return;
    }
    assert_eq!(
        store.apply([data]).await.unwrap()[0].outcome,
        Outcome::Accepted
    );
    if mode == "after_state" {
        kill_ready();
    }
    if mode == "before_snapshot" {
        store
            .run(|inner| {
                let state = read_state(inner, &io(inner.db.begin_read())?)?;
                let bytes = encode(&envelope(inner, state.clone(), 2))?;
                let metadata = SnapshotMeta {
                    last_log_id: state.last_applied,
                    last_membership: state.membership,
                    snapshot_id: snapshot_id(2, &bytes),
                };
                let tx = transaction(inner, 1024 * 1024)?;
                put(&tx, "snapshotMeta", &metadata)?;
                io(io(tx.open_table(META))?.insert("snapshotBytes", bytes.as_slice()))?;
                kill_ready();
                Ok(())
            })
            .await
            .unwrap();
        return;
    }
    assert_eq!(mode, "after_snapshot");
    store.build_snapshot().await.unwrap();
    kill_ready();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn actual_process_kill_preserves_v2_log_state_and_snapshot_transaction_boundaries() {
    use openraft::{storage::RaftStateMachine, RaftLogReader};
    use std::{
        io::BufRead,
        os::unix::process::ExitStatusExt,
        process::{Command, Stdio},
    };
    struct OwnedChild(std::process::Child);
    impl Drop for OwnedChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    for mode in [
        "before_log",
        "after_log",
        "before_state",
        "after_state",
        "before_snapshot",
        "after_snapshot",
    ] {
        let root = tempfile::tempdir().unwrap();
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let mut child = OwnedChild(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "store::tests::v2_transaction_process_worker",
                    "--ignored",
                    "--nocapture",
                ])
                .env("WABI_V2_KILL_ROOT", root.path())
                .env("WABI_V2_KILL_BOUNDARY", mode)
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let output = child.0.stdout.take().unwrap();
        let (ready, received) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || {
            for line in std::io::BufReader::new(output).lines() {
                if line.is_ok_and(|line| line == "WABI_V2_STORAGE_BOUNDARY") {
                    let _ = ready.send(());
                    break;
                }
            }
        });
        received.recv_timeout(Duration::from_secs(10)).expect(mode);
        let lock_before = fs::metadata(root.path().join(".lock")).unwrap();
        child.0.kill().unwrap();
        assert_eq!(child.0.wait().unwrap().signal(), Some(9));
        reader.join().unwrap();
        let (command, binding) = crate::availability_control::tests::command_fixture();
        let mut store = Store::open(root.path(), binding, StoreLimits::default()).unwrap();
        let identity: DatabaseIdentity = store.read_value("identity").await.unwrap();
        let state = store.control_state().await.unwrap();
        let logs = store.try_get_log_entries(1..=2).await.unwrap();
        let snapshot = store.get_current_snapshot().await.unwrap().unwrap();
        if mode == "before_log" {
            assert_eq!(identity.schema_version, 1);
            assert_eq!(logs.len(), 1);
            assert!(snapshot.meta.snapshot_id.starts_with("v1-"));
        } else {
            assert_eq!(identity.schema_version, 2);
            assert_eq!(logs.len(), 2);
            assert!(snapshot.meta.snapshot_id.starts_with("v2-"));
        }
        let applied = matches!(mode, "after_state" | "before_snapshot" | "after_snapshot");
        assert_eq!(
            state.checkpoints.contains_key(command.operation_id()),
            applied,
            "{mode}"
        );
        assert_eq!(
            snapshot.meta.last_log_id.unwrap().index,
            if mode == "after_snapshot" { 2 } else { 1 }
        );
        drop(snapshot.snapshot);
        if mode != "before_log" && !applied {
            store.save_committed(Some(logs[1].log_id)).await.unwrap();
            assert_eq!(
                store.apply([logs[1].clone()]).await.unwrap()[0].outcome,
                Outcome::Accepted
            );
        }
        let lock_after = fs::metadata(root.path().join(".lock")).unwrap();
        assert_eq!(
            (lock_before.dev(), lock_before.ino()),
            (lock_after.dev(), lock_after.ino())
        );
    }
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn first_v2_log_atomically_upgrades_identity_snapshot_and_stays_sticky() {
    use openraft::{storage::RaftLogStorageExt, storage::RaftStateMachine, RaftSnapshotBuilder};
    let (command, binding) = crate::availability_control::tests::command_fixture();
    let root = tempfile::tempdir().unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let mut store = Store::open(root.path(), binding.clone(), StoreLimits::default()).unwrap();
    let member = Entry {
        log_id: LogId::new(openraft::CommittedLeaderId::new(1, 1), 1),
        payload: EntryPayload::Membership(openraft::Membership::new(vec![[1, 2, 3].into()], {
            let value = serde_json::to_value(&command).unwrap();
            serde_json::from_value::<std::collections::BTreeMap<u64, RecoveryPeer>>(
                value["peers"].clone(),
            )
            .unwrap()
        })),
    };
    store.blocking_append([member.clone()]).await.unwrap();
    store.apply([member]).await.unwrap();
    let before = store.build_snapshot().await.unwrap();
    assert!(before.meta.snapshot_id.starts_with("v1-"));
    drop(before.snapshot);
    let data = Entry {
        log_id: LogId::new(openraft::CommittedLeaderId::new(1, 1), 2),
        payload: EntryPayload::Normal(ControlData::Checkpoint(command)),
    };
    store.blocking_append([data.clone()]).await.unwrap();
    let identity: DatabaseIdentity = store.read_value("identity").await.unwrap();
    assert_eq!(identity.schema_version, 2);
    assert_eq!(identity.format, FORMAT_V2);
    // Exact old-reader predicate, not a claim of a separate old-binary run.
    assert!(!(identity.schema_version == CONTROL_SCHEMA && identity.format == FORMAT));
    assert!(store
        .get_current_snapshot()
        .await
        .unwrap()
        .unwrap()
        .meta
        .snapshot_id
        .starts_with("v2-"));
    // The first V2 log may still be uncommitted. Truncation cannot permit an
    // older binary to silently reuse a store that has required V2 support.
    store.truncate(data.log_id).await.unwrap();
    assert_eq!(
        store
            .read_value::<DatabaseIdentity>("identity")
            .await
            .unwrap()
            .schema_version,
        2
    );
    drop(store);
    let mut store = Store::open(root.path(), binding, StoreLimits::default()).unwrap();
    assert!(store
        .build_snapshot()
        .await
        .unwrap()
        .meta
        .snapshot_id
        .starts_with("v2-"));
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn uncommitted_format_upgrade_rolls_back_all_publications() {
    let (_command, binding) = crate::availability_control::tests::command_fixture();
    let root = tempfile::tempdir().unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let store = Store::open(root.path(), binding, StoreLimits::default()).unwrap();
    store
        .run(|inner| {
            let tx = transaction(inner, 1024 * 1024)?;
            upgrade_format(inner, &tx, 2)?;
            assert_eq!(
                writable_meta::<DatabaseIdentity>(&tx, "identity")?.schema_version,
                2
            );
            // Deliberately drop the owned transaction without commit. This checks
            // rollback atomicity; subprocess power loss remains a separate gate.
            drop(tx);
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(
        store
            .read_value::<DatabaseIdentity>("identity")
            .await
            .unwrap()
            .schema_version,
        1
    );
    assert!(store.control_state().await.unwrap().checkpoints.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_caller_does_not_release_unfinished_commit_or_store_ownership() {
    let root = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let binding = StoreBinding {
        community_id: "ab".repeat(32),
        partition_id: "community/control".into(),
        node_id: 1,
    };
    let store = Store::open(root.path(), binding.clone(), StoreLimits::default()).unwrap();
    let (entered, started) = tokio::sync::oneshot::channel();
    let (release, held) = std::sync::mpsc::channel();
    let task_store = store.clone();
    let writer = tokio::spawn(async move {
        task_store
            .run(move |inner| {
                let tx = transaction(inner, 1024 * 1024)?;
                put(&tx, "vote", &Some(Vote::new_committed(4, 2)))?;
                let _ = entered.send(());
                held.recv_timeout(Duration::from_secs(5))
                    .map_err(|_| StoreError::Io)?;
                io(tx.commit())
            })
            .await
    });
    started.await.unwrap();
    writer.abort();
    assert!(writer.await.unwrap_err().is_cancelled());
    assert!(matches!(
        Store::open(root.path(), binding.clone(), StoreLimits::default()),
        Err(StoreError::Ownership)
    ));
    let mut reader_store = store.clone();
    let mut reader = tokio::spawn(async move { reader_store.read_vote().await });
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut reader)
            .await
            .is_err()
    );
    release.send(()).unwrap();
    assert_eq!(
        reader.await.unwrap().unwrap(),
        Some(Vote::new_committed(4, 2))
    );
    drop(store);
    let mut reopened = Store::open(root.path(), binding, StoreLimits::default()).unwrap();
    assert_eq!(
        reopened.read_vote().await.unwrap(),
        Some(Vote::new_committed(4, 2))
    );
}
