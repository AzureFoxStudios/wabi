use super::*;
use crate::crypto::bootstrap::BootstrapSource;
use crate::engine::{WabiDbConfig, WabiDbEngine};
use crate::format::record::RecordKind;
use crate::sequencer::types::{CommandCommit, EventToWrite};

const KEY: [u8; 32] = [42; 32];

async fn fixture(root: &Path) -> (u64, String) {
    let mut config = WabiDbConfig::new(root.to_owned(), BootstrapSource::Provided(KEY));
    config.allow_init = true;
    let engine = WabiDbEngine::open(config).await.unwrap();
    engine
        .get_or_create_stream_key("inspection-fixture")
        .await
        .unwrap();
    for value in [b"first".as_slice(), b"latest".as_slice()] {
        engine
            .run_command(CommandCommit {
                room_owner_precondition: None,
                caller_user_id: 1,
                caller_device_id: "fixture".into(),
                command_name: "inspection_fixture".into(),
                idempotency_key: None,
                essential: true,
                response_tx: tokio::sync::oneshot::channel().0,
                events: vec![EventToWrite {
                    stream_id: "inspection-fixture".into(),
                    stream_kind: 6,
                    event_type: "inspection_fixture".into(),
                    record_kind: RecordKind::Event,
                    plaintext: value.to_vec(),
                }],
            })
            .await
            .unwrap();
    }
    let sequence = engine.barrier().current();
    drop(engine);
    // Writer tasks retain their own lock until shutdown finishes. Prove release
    // by acquiring that exact inode; no PID deletion or fixed sleep assumption.
    let lock = File::open(root.join(".lock")).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if FileExt::try_lock_exclusive(&lock).unwrap() {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    FileExt::unlock(&lock).unwrap();
    let indexed =
        crate::commit_index::batcher::read_all_entries(&root.join("global/commit-index")).unwrap();
    (
        sequence,
        crate::replication::commit_prefix_fingerprint(&indexed, sequence),
    )
}

#[tokio::test]
async fn full_replay_matches_saved_view_without_any_data_write_or_guard_change() {
    let temp = tempfile::tempdir().unwrap();
    let (seq, prefix) = fixture(temp.path()).await;
    fs::write(temp.path().join("writer-fenced-v1"), b"fenced\n").unwrap();
    fs::write(
        temp.path().join("live-checkpoint-v1"),
        b"inactive checkpoint fixture\n",
    )
    .unwrap();
    fs::write(
        temp.path().join(".lock"),
        b"diagnostic text is not ownership",
    )
    .unwrap();
    let limits = InspectionLimits::default();
    let before = inventory(temp.path(), &limits, Instant::now() + limits.timeout).unwrap();
    let lock_text = fs::read(temp.path().join(".lock")).unwrap();
    let inspected = inspect_frozen(temp.path(), &KEY, seq, &prefix, limits.clone())
        .await
        .unwrap();
    assert!(inspected.receipt.full_history_replayed);
    assert!(inspected.receipt.persisted_projection_matches);
    assert_eq!(inspected.receipt.indexed_commits, 2);
    assert_eq!(
        inspected
            .projection_state()
            .get("events", b"inspection_fixture"),
        Some(b"latest".to_vec())
    );
    assert!(before == inventory(temp.path(), &limits, Instant::now() + limits.timeout).unwrap());
    assert_eq!(fs::read(temp.path().join(".lock")).unwrap(), lock_text);
    assert_eq!(
        fs::read(temp.path().join("writer-fenced-v1")).unwrap(),
        b"fenced\n"
    );
}

#[tokio::test]
async fn saved_state_corruption_is_not_hidden_by_loading_the_snapshot() {
    let temp = tempfile::tempdir().unwrap();
    let (seq, prefix) = fixture(temp.path()).await;
    let snapshot = temp.path().join("projections/snapshot.json");
    let mut value: serde_json::Value =
        serde_json::from_slice(&fs::read(&snapshot).unwrap()).unwrap();
    value["indexes"][0][1][0]["value"] = serde_json::Value::String(hex::encode(b"invented-state"));
    fs::write(snapshot, serde_json::to_vec(&value).unwrap()).unwrap();
    assert!(
        inspect_frozen(temp.path(), &KEY, seq, &prefix, InspectionLimits::default())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn wrong_key_missing_indexed_record_and_wrong_prefix_refuse_without_repair() {
    let temp = tempfile::tempdir().unwrap();
    let (seq, prefix) = fixture(temp.path()).await;
    assert!(inspect_frozen(
        temp.path(),
        &[9; 32],
        seq,
        &prefix,
        InspectionLimits::default()
    )
    .await
    .is_err());
    assert!(inspect_frozen(
        temp.path(),
        &KEY,
        seq,
        &"00".repeat(32),
        InspectionLimits::default()
    )
    .await
    .is_err());
    let streams = temp.path().join("streams");
    fs::remove_dir_all(&streams).unwrap();
    assert!(
        inspect_frozen(temp.path(), &KEY, seq, &prefix, InspectionLimits::default())
            .await
            .is_err()
    );
    assert!(!streams.exists());
}

#[tokio::test]
async fn running_writer_limits_and_disconnected_index_file_refuse() {
    let temp = tempfile::tempdir().unwrap();
    let (seq, prefix) = fixture(temp.path()).await;
    let lock = File::open(temp.path().join(".lock")).unwrap();
    assert!(FileExt::try_lock_exclusive(&lock).unwrap());
    assert!(
        inspect_frozen(temp.path(), &KEY, seq, &prefix, InspectionLimits::default())
            .await
            .is_err()
    );
    FileExt::unlock(&lock).unwrap();
    for limits in [
        InspectionLimits {
            max_file_bytes: 1,
            ..InspectionLimits::default()
        },
        InspectionLimits {
            max_entries: 1,
            ..InspectionLimits::default()
        },
        InspectionLimits {
            max_snapshot_bytes: 1,
            ..InspectionLimits::default()
        },
        InspectionLimits {
            timeout: Duration::ZERO,
            ..InspectionLimits::default()
        },
    ] {
        assert!(inspect_frozen(temp.path(), &KEY, seq, &prefix, limits)
            .await
            .is_err());
    }
    fs::write(
        temp.path().join("global/commit-index/00000002.widx"),
        b"unrelated tail",
    )
    .unwrap();
    assert!(
        inspect_frozen(temp.path(), &KEY, seq, &prefix, InspectionLimits::default())
            .await
            .is_err()
    );
}

#[cfg(unix)]
#[tokio::test]
async fn symlinks_and_special_files_refuse_before_replay() {
    let temp = tempfile::tempdir().unwrap();
    let (seq, prefix) = fixture(temp.path()).await;
    std::os::unix::fs::symlink(
        temp.path().join("storage-manifest.json"),
        temp.path().join("outside-link"),
    )
    .unwrap();
    assert!(
        inspect_frozen(temp.path(), &KEY, seq, &prefix, InspectionLimits::default())
            .await
            .is_err()
    );
}

#[test]
fn content_fingerprint_is_ordered_private_bounded_and_empty_index_neutral() {
    let left = ProjectionState::new();
    let right = ProjectionState::new();
    left.insert("b", b"2".to_vec(), b"second".to_vec(), 3);
    left.insert("a", b"1".to_vec(), b"private-secret".to_vec(), 3);
    right.insert("a", b"1".to_vec(), b"private-secret".to_vec(), 3);
    right.insert("b", b"2".to_vec(), b"second".to_vec(), 3);
    right.with_index("empty-lookup", |_| ());
    left.set_applied_commit_seq(3);
    right.set_applied_commit_seq(3);
    let receipt = left.content_fingerprint(10, 100).unwrap();
    assert_eq!(receipt, right.content_fingerprint(10, 100).unwrap());
    assert!(!serde_json::to_string(&receipt)
        .unwrap()
        .contains("private-secret"));
    assert!(left.content_fingerprint(1, 100).is_err());
    assert!(left.content_fingerprint(10, 1).is_err());
    right.insert("unexpected", b"k".to_vec(), b"v".to_vec(), 3);
    assert_ne!(receipt, right.content_fingerprint(10, 100).unwrap());
}

#[test]
fn strict_saved_view_rejects_duplicate_decoded_keys_and_unknown_fields() {
    let temp = tempfile::tempdir().unwrap();
    fs::create_dir_all(temp.path().join("projections")).unwrap();
    for invalid in [
        r#"{"watermark":1,"indexes":[],"unknown":1}"#,
        r#"{"watermark":1,"indexes":[["x",[{"key":"ab","value":"00"},{"key":"AB","value":"01"}]]]}"#,
        r#"{"watermark":1,"indexes":[["x",[]],["x",[]]]}"#,
        r#"{"watermark":1,"watermark":2,"indexes":[]}"#,
    ] {
        fs::write(temp.path().join("projections/snapshot.json"), invalid).unwrap();
        assert!(read_saved_view(temp.path(), &InspectionLimits::default()).is_err());
    }
}

#[tokio::test]
async fn borrowed_lock_requires_this_tree_and_stays_owned_after_inspection() {
    let temp = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let (seq, prefix) = fixture(temp.path()).await;
    let wrong = File::create(other.path().join(".lock")).unwrap();
    assert!(inspect_frozen_locked(
        temp.path(),
        &KEY,
        seq,
        &prefix,
        InspectionLimits::default(),
        &wrong
    )
    .await
    .is_err());
    let lock = File::open(temp.path().join(".lock")).unwrap();
    assert!(FileExt::try_lock_exclusive(&lock).unwrap());
    inspect_frozen_locked(
        temp.path(),
        &KEY,
        seq,
        &prefix,
        InspectionLimits::default(),
        &lock,
    )
    .await
    .unwrap();
    let competing = File::open(temp.path().join(".lock")).unwrap();
    assert!(!FileExt::try_lock_exclusive(&competing).unwrap());
    FileExt::unlock(&lock).unwrap();
    assert!(FileExt::try_lock_exclusive(&competing).unwrap());
}
