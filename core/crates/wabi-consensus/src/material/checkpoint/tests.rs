use super::*;
use crate::source_context::tests::fixture;
use std::{
    io::{BufRead, BufReader, SeekFrom},
    os::unix::fs::{symlink, PermissionsExt},
    process::{Command, Stdio},
    sync::mpsc,
};
fn private_root() -> tempfile::TempDir {
    let p = tempfile::tempdir().unwrap();
    fs::set_permissions(p.path(), fs::Permissions::from_mode(0o700)).unwrap();
    p
}
fn binding(source: &SignedSourceContext) -> StoreBinding {
    StoreBinding {
        community_id: source.claims.community_id.clone(),
        partition_id: "community/root".into(),
        node_id: 1,
    }
}
fn limits() -> MaterialLimits {
    MaterialLimits {
        min_free_bytes: 1,
        ..Default::default()
    }
}
fn reopen_owned(root: &Path, binding: StoreBinding) -> MaterialStore {
    let inode = fs::metadata(root.join(LOCK)).unwrap().ino();
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        assert_eq!(fs::metadata(root.join(LOCK)).unwrap().ino(), inode);
        // Probe actual lock contention only. Never retry the broad Ownership
        // error, which also covers unsafe mode/owner/inode/name failures.
        let probe = OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(NOFOLLOW)
            .open(root.join(LOCK))
            .unwrap();
        let metadata = probe.metadata().unwrap();
        assert_eq!(metadata.ino(), inode);
        assert_eq!(metadata.mode() & 0o077, 0);
        assert_eq!(metadata.nlink(), 1);
        assert_eq!(metadata.uid(), fs::metadata("/proc/self").unwrap().uid());
        if !FileExt::try_lock_exclusive(&probe).unwrap() {
            assert!(Instant::now() < deadline, "owned lock remained busy");
            drop(probe);
            std::thread::sleep(Duration::from_millis(1));
            continue;
        }
        drop(probe);
        // A new race/unsafe root still fails immediately here; no retry can
        // hide production refusal or silently replace the persistent inode.
        return MaterialStore::open(root, binding, limits())
            .expect("owned checkpoint reopen failed");
    }
}
fn stage(
    bytes: &[u8],
) -> (
    tempfile::TempDir,
    PathBuf,
    MaterialStore,
    VerifiedSourceContext,
) {
    let parent = private_root();
    let path = parent.path().join("captured.age");
    fs::write(&path, bytes).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let root = parent.path().join("material");
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let source = fixture(bytes);
    let store = MaterialStore::open(&root, binding(&source), limits()).unwrap();
    let verified = source
        .verify(&source.claims.community_id, "node-1")
        .unwrap();
    (parent, path, store, verified)
}
#[test]
fn signed_checkpoint_ingests_exact_order_reopens_and_keeps_allocation_unknown() {
    let bytes: Vec<u8> = (0..TRANSFER_OBJECT_BYTES + 31)
        .map(|n| (n % 251) as u8)
        .collect();
    let (parent, path, store, source) = stage(&bytes);
    let (manifest, receipt) = store
        .ingest_checkpoint(&path, &source, ChunkingLimits::default())
        .unwrap();
    assert_eq!(manifest.objects.len(), 2);
    assert_eq!(
        store
            .checkpoint_receipt(receipt.manifest_sha256(), "node-1")
            .unwrap(),
        receipt
    );
    assert_eq!(
        store.receipt(receipt.manifest_sha256()),
        Err(MaterialError::NotFound)
    );
    let view = serde_json::to_value(&receipt).unwrap();
    assert_eq!(view["allocation"], serde_json::json!({"kind":"unknown"}));
    assert_eq!(view["communitySignatureVerified"], true);
    for field in [
        "sourceRoleVerified",
        "payloadEncryptionVerified",
        "inactiveReplayVerified",
        "quorumAvailable",
        "fullInstanceReady",
        "canonicalWriterPermitted",
    ] {
        assert_eq!(view[field], false)
    }
    let root = parent.path().join("material");
    let inode = fs::metadata(root.join(LOCK)).unwrap().ino();
    drop(store);
    let store = reopen_owned(&root, binding(source.signed()));
    assert_eq!(
        store
            .checkpoint_receipt(receipt.manifest_sha256(), "node-1")
            .unwrap(),
        receipt
    );
    assert_eq!(fs::metadata(root.join(LOCK)).unwrap().ino(), inode);
}

#[test]
fn owned_reopen_waits_for_held_descriptor_without_replacing_lock() {
    let (parent, _path, store, source) = stage(b"opaque");
    let root = parent.path().join("material");
    let inode = fs::metadata(root.join(LOCK)).unwrap().ino();
    let retained = store.inner.lock.try_clone().unwrap();
    drop(store);
    assert!(matches!(
        MaterialStore::open(&root, binding(source.signed()), limits()),
        Err(MaterialError::Ownership)
    ));
    let release = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(20));
        drop(retained);
    });
    let store = reopen_owned(&root, binding(source.signed()));
    release.join().unwrap();
    assert_eq!(fs::metadata(root.join(LOCK)).unwrap().ino(), inode);
    drop(store);
}

#[test]
fn actual_expiry_under_lane_contention_never_returns_a_new_receipt() {
    let (parent, path, store, source) = stage(b"opaque expired capture");
    let owned = store.clone();
    let proof = source.clone();
    let held = store.inner.lane.lock().unwrap();
    let (started, ready) = mpsc::channel();
    let task = std::thread::spawn(move || {
        started.send(()).unwrap();
        owned.ingest_checkpoint(
            &path,
            &proof,
            ChunkingLimits {
                timeout: Duration::from_millis(20),
            },
        )
    });
    ready.recv_timeout(Duration::from_secs(2)).unwrap();
    std::thread::sleep(Duration::from_millis(60));
    drop(held);
    assert_eq!(task.join().unwrap(), Err(MaterialError::Deadline));
    assert!(fs::read_dir(parent.path().join("material"))
        .unwrap()
        .all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".checkpoint.json")));
    // A valid object, if already written, stays quota charged. No deletion or
    // successful receipt is invented when the deadline expires.
}

#[test]
fn certification_contention_and_late_publication_refuse_success_without_deleting_bytes() {
    let bytes = b"opaque completed chunks";
    let (parent, _path, store, source) = stage(bytes);
    let object = ObjectRef {
        kind: MaterialKind::CheckpointChunk,
        sha256: digest(bytes),
        bytes: bytes.len() as u64,
    };
    store.put_object(&object, bytes).unwrap();
    let manifest = CheckpointManifest {
        schema_version: 2,
        partition_id: store.inner.binding.partition_id.clone(),
        source: source.signed().clone(),
        objects: vec![object.clone()],
    };
    let id = manifest.sha256().unwrap();
    let owned = store.clone();
    let copy = manifest.clone();
    let held = store.inner.lane.lock().unwrap();
    let (started, ready) = mpsc::channel();
    let task = std::thread::spawn(move || {
        let end = Instant::now() + Duration::from_millis(20);
        started.send(end).unwrap();
        owned.certify_checkpoint_deadline(&copy, "node-1", Some(end), |_| {})
    });
    let end = ready.recv_timeout(Duration::from_secs(2)).unwrap();
    std::thread::sleep(end.saturating_duration_since(Instant::now()) + Duration::from_millis(10));
    drop(held);
    assert_eq!(task.join().unwrap(), Err(MaterialError::Deadline));
    assert!(!parent
        .path()
        .join("material")
        .join(format!("{id}.checkpoint.json"))
        .exists());
    let end = Instant::now() + Duration::from_millis(20);
    assert_eq!(
        store.certify_checkpoint_deadline(&manifest, "node-1", Some(end), |point| {
            if point == Point::StageSynced {
                std::thread::sleep(
                    end.saturating_duration_since(Instant::now()) + Duration::from_millis(10),
                );
            }
        }),
        Err(MaterialError::Deadline)
    );
    // Started file publication is not preempted or rolled back. Its complete
    // immutable bytes survive; only a later fresh read can certify durability.
    store.inner.verify_object(&object, None).unwrap();
    assert_eq!(
        store
            .checkpoint_receipt(&id, "node-1")
            .unwrap()
            .manifest_sha256(),
        id
    );
}
#[test]
fn repeated_chunk_refs_and_larger_versioned_metadata_are_bounded_and_recoverable() {
    let bytes = vec![b'q'; TRANSFER_OBJECT_BYTES * 2];
    let (_parent, path, store, source) = stage(&bytes);
    let (manifest, receipt) = store
        .ingest_checkpoint(&path, &source, ChunkingLimits::default())
        .unwrap();
    assert_eq!(manifest.objects[0], manifest.objects[1]);
    assert_eq!(store.inner.inventory().unwrap().0, 1);
    assert_eq!(
        serde_json::to_value(receipt).unwrap()["requiredBytes"],
        bytes.len()
    );
    let data = b"abc";
    let archive = data.repeat(1024);
    let (parent, _, store, source) = stage(&archive);
    let object = ObjectRef {
        kind: MaterialKind::CheckpointChunk,
        sha256: digest(data),
        bytes: 3,
    };
    store.put_object(&object, data).unwrap();
    let manifest = CheckpointManifest {
        schema_version: 2,
        partition_id: binding(source.signed()).partition_id,
        source: source.signed().clone(),
        objects: vec![object; 1024],
    };
    assert!(encode(&manifest).unwrap().len() > MAX_JSON);
    let receipt = store.certify_checkpoint(&manifest, "node-1").unwrap();
    drop(store);
    let store = MaterialStore::open(
        &parent.path().join("material"),
        binding(source.signed()),
        limits(),
    )
    .unwrap();
    assert_eq!(
        store
            .checkpoint_receipt(receipt.manifest_sha256(), "node-1")
            .unwrap(),
        receipt
    );
}
#[test]
fn incorrect_signed_source_order_node_kind_or_required_bytes_refuse() {
    let bytes: Vec<u8> = (0..TRANSFER_OBJECT_BYTES + 23)
        .map(|n| (n % 251) as u8)
        .collect();
    let (_parent, path, store, source) = stage(&bytes);
    let (manifest, receipt) = store
        .ingest_checkpoint(&path, &source, ChunkingLimits::default())
        .unwrap();
    assert_eq!(
        store.certify_checkpoint(&manifest, "node-2"),
        Err(MaterialError::Context)
    );
    let mut other = manifest.clone();
    other.objects.swap(0, 1);
    assert_eq!(
        store.certify_checkpoint(&other, "node-1"),
        Err(MaterialError::Format)
    );
    other = manifest.clone();
    other.objects[0].kind = MaterialKind::CommittedTailChunk;
    assert_eq!(
        store.certify_checkpoint(&other, "node-1"),
        Err(MaterialError::Format)
    );
    other = manifest.clone();
    other.partition_id = "other/partition".into();
    assert_eq!(
        store.certify_checkpoint(&other, "node-1"),
        Err(MaterialError::Context)
    );
    let file = store
        .inner
        .relative(&format!("{}.blob", manifest.objects[1].sha256));
    fs::write(&file, b"corruption").unwrap();
    assert_eq!(
        store.checkpoint_receipt(receipt.manifest_sha256(), "node-1"),
        Err(MaterialError::Format)
    );
    let bytes = vec![b'a'; TRANSFER_OBJECT_BYTES + 1];
    let (_parent, path, store, source) = stage(&bytes);
    fs::write(&path, vec![b'b'; bytes.len()]).unwrap();
    assert_eq!(
        store
            .ingest_checkpoint(&path, &source, ChunkingLimits::default())
            .unwrap_err(),
        MaterialError::Format
    );
    assert_eq!(store.inner.inventory().unwrap().1, 0);
}
#[test]
fn source_inputs_quota_and_deadline_contract_refuse_before_receipt() {
    for attack in 0..3 {
        let (parent, path, store, source) = stage(b"opaque");
        match attack {
            0 => fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap(),
            1 => fs::hard_link(&path, parent.path().join("second-link")).unwrap(),
            _ => {
                let actual = parent.path().join("actual");
                fs::rename(&path, &actual).unwrap();
                symlink(actual, &path).unwrap()
            }
        }
        assert_eq!(
            store
                .ingest_checkpoint(&path, &source, ChunkingLimits::default())
                .unwrap_err(),
            MaterialError::Ownership
        );
        assert_eq!(store.inner.inventory().unwrap().0, 0)
    }
    let (_parent, path, store, source) = stage(b"opaque");
    assert_eq!(
        store
            .ingest_checkpoint(
                &path,
                &source,
                ChunkingLimits {
                    timeout: Duration::ZERO
                }
            )
            .unwrap_err(),
        MaterialError::Format
    );
    let root = private_root();
    let mut foreign = binding(source.signed());
    foreign.community_id = "12".repeat(32);
    let other = MaterialStore::open(root.path(), foreign, limits()).unwrap();
    assert_eq!(
        other
            .ingest_checkpoint(&path, &source, ChunkingLimits::default())
            .unwrap_err(),
        MaterialError::Context
    );
    let root = private_root();
    let mut limited = limits();
    limited.max_object_bytes = 3;
    limited.max_stored_bytes = 3;
    let other = MaterialStore::open(root.path(), binding(source.signed()), limited).unwrap();
    assert_eq!(
        other
            .ingest_checkpoint(&path, &source, ChunkingLimits::default())
            .unwrap_err(),
        MaterialError::Budget
    );
    assert_eq!(other.inner.inventory().unwrap().0, 0);
}
#[test]
fn owned_file_rewinds_and_matches_path_manifest_and_receipt() {
    let bytes: Vec<u8> = (0..TRANSFER_OBJECT_BYTES + 23)
        .map(|n| (n % 251) as u8)
        .collect();
    let (_parent, path, store, source) = stage(&bytes);
    let expected = store
        .ingest_checkpoint(&path, &source, ChunkingLimits::default())
        .unwrap();
    let mut input = File::open(&path).unwrap();
    input
        .seek(SeekFrom::Start(bytes.len() as u64 + 17))
        .unwrap();
    let actual = store
        .ingest_checkpoint_file(input, &source, ChunkingLimits::default())
        .unwrap();
    assert_eq!(actual, expected);
    assert_eq!(store.inner.inventory().unwrap().0, 2);
    assert_eq!(store.inner.inventory().unwrap().1, 1);
    for field in [
        "quorumAvailable",
        "fullInstanceReady",
        "canonicalWriterPermitted",
    ] {
        assert_eq!(
            serde_json::to_value(actual.1.clone()).unwrap()[field],
            false
        );
    }
}
#[test]
fn owned_descriptor_ingests_without_relaxing_path_ancestor_or_name_checks() {
    let (parent, path, store, source) = stage(b"opaque held descriptor");
    let directory = File::open(parent.path()).unwrap();
    let relative = PathBuf::from(format!(
        "/proc/self/fd/{}/captured.age",
        directory.as_raw_fd()
    ));
    assert_eq!(
        store.ingest_checkpoint(&relative, &source, ChunkingLimits::default()),
        Err(MaterialError::Ownership)
    );
    assert_eq!(store.inner.inventory().unwrap().0, 0);
    let held = File::open(&relative).unwrap();
    // Descriptor ingestion promises the held bytes, not ownership of an old
    // path name. Establish this change before the API's metadata snapshot.
    fs::rename(&path, parent.path().join("retained.age")).unwrap();
    fs::write(&path, b"replacement wrong bytes").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let (manifest, receipt) = store
        .ingest_checkpoint_file(held, &source, ChunkingLimits::default())
        .unwrap();
    assert_eq!(manifest.source, *source.signed());
    assert_eq!(
        store
            .checkpoint_receipt(receipt.manifest_sha256(), "node-1")
            .unwrap(),
        receipt
    );
    assert_eq!(
        store
            .ingest_checkpoint(&path, &source, ChunkingLimits::default())
            .unwrap_err(),
        MaterialError::Format
    );
}
#[test]
fn owned_file_rejects_nonprivate_nonregular_linked_and_wrong_size_before_chunks() {
    for attack in 0..5 {
        let (parent, path, store, source) = stage(b"opaque");
        let input = if attack == 2 {
            File::open(parent.path()).unwrap()
        } else {
            File::open(&path).unwrap()
        };
        match attack {
            0 => fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap(),
            1 => fs::hard_link(&path, parent.path().join("alias.age")).unwrap(),
            2 => {}
            3 => fs::remove_file(&path).unwrap(),
            _ => fs::write(&path, b"longer archive").unwrap(),
        }
        assert_eq!(
            store
                .ingest_checkpoint_file(input, &source, ChunkingLimits::default())
                .unwrap_err(),
            if attack == 4 {
                MaterialError::Format
            } else {
                MaterialError::Ownership
            }
        );
        assert_eq!(store.inner.inventory().unwrap().0, 0);
        assert_eq!(store.inner.inventory().unwrap().1, 0);
    }
    let (_parent, path, _store, source) = stage(b"opaque");
    let metadata = File::open(path).unwrap().metadata().unwrap();
    // Exercise owner comparison without requiring root or changing any file's
    // owner. The production expected UID always comes from /proc/self.
    assert_eq!(
        checkpoint_input_metadata(
            &metadata,
            metadata.uid().wrapping_add(1),
            source.claims().ciphertext_bytes
        ),
        Err(MaterialError::Ownership)
    );
}
#[test]
fn owned_file_metadata_changes_after_reads_leave_chunks_without_new_receipt() {
    for attack in 0..6 {
        let (parent, path, store, source) = stage(b"opaque");
        let input = File::open(&path).unwrap();
        let deadline = store
            .ingestion_deadline(&source, ChunkingLimits::default())
            .unwrap();
        assert_eq!(
            store.ingest_checkpoint_opened(input, &source, deadline, |_| {
                match attack {
                    0 => fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap(),
                    1 => fs::hard_link(&path, parent.path().join("alias.age")).unwrap(),
                    2 => fs::write(&path, b"longer after read").unwrap(),
                    3 => fs::remove_file(&path).unwrap(),
                    4 => {
                        // Still private, but no longer the original metadata.
                        fs::set_permissions(&path, fs::Permissions::from_mode(0o400)).unwrap();
                    }
                    _ => {
                        // Same bytes and length do not hide a metadata change.
                        File::open(&path)
                            .unwrap()
                            .set_times(
                                fs::FileTimes::new()
                                    .set_modified(std::time::UNIX_EPOCH + Duration::from_secs(42)),
                            )
                            .unwrap();
                    }
                }
                Ok(())
            }),
            Err(MaterialError::Ownership)
        );
        assert_eq!(store.inner.inventory().unwrap().0, 1);
        assert_eq!(store.inner.inventory().unwrap().1, 0);
    }
}
#[test]
fn owned_file_hash_context_quota_and_invalid_deadlines_refuse_receipts() {
    let (_parent, path, store, source) = stage(b"opaque");
    fs::write(&path, b"mutant").unwrap();
    assert_eq!(
        store.ingest_checkpoint_file(
            File::open(&path).unwrap(),
            &source,
            ChunkingLimits::default()
        ),
        Err(MaterialError::Format)
    );
    assert_eq!(store.inner.inventory().unwrap().1, 0);
    for timeout in [Duration::ZERO, Duration::from_secs(301)] {
        assert_eq!(
            store.ingest_checkpoint_file(
                File::open(&path).unwrap(),
                &source,
                ChunkingLimits { timeout }
            ),
            Err(MaterialError::Format)
        );
    }
    let root = private_root();
    let mut foreign = binding(source.signed());
    foreign.community_id = "12".repeat(32);
    let other = MaterialStore::open(root.path(), foreign, limits()).unwrap();
    assert_eq!(
        other.ingest_checkpoint_file(
            File::open(&path).unwrap(),
            &source,
            ChunkingLimits::default()
        ),
        Err(MaterialError::Context)
    );
    assert_eq!(other.inner.inventory().unwrap().0, 0);
    let root = private_root();
    let mut limited = limits();
    limited.max_object_bytes = 3;
    limited.max_stored_bytes = 3;
    let other = MaterialStore::open(root.path(), binding(source.signed()), limited).unwrap();
    assert_eq!(
        other.ingest_checkpoint_file(
            File::open(&path).unwrap(),
            &source,
            ChunkingLimits::default()
        ),
        Err(MaterialError::Budget)
    );
    assert_eq!(other.inner.inventory().unwrap().0, 0);

    let bytes = vec![b'a'; TRANSFER_OBJECT_BYTES + 1];
    let (_parent, path, _store, source) = stage(&bytes);
    let root = private_root();
    let mut limited = limits();
    limited.max_objects = 1;
    let other = MaterialStore::open(root.path(), binding(source.signed()), limited).unwrap();
    assert_eq!(
        other.ingest_checkpoint_file(
            File::open(&path).unwrap(),
            &source,
            ChunkingLimits::default()
        ),
        Err(MaterialError::Budget)
    );
    assert_eq!(other.inner.inventory().unwrap().0, 1);
    assert_eq!(other.inner.inventory().unwrap().1, 0);
}
#[test]
fn owned_file_actual_expiry_under_lane_contention_never_returns_receipt() {
    let (parent, path, store, source) = stage(b"opaque expired held capture");
    let input = File::open(path).unwrap();
    let owned = store.clone();
    let held = store.inner.lane.lock().unwrap();
    let (started, ready) = mpsc::channel();
    let task = std::thread::spawn(move || {
        // Signal only after the real shared ingestion deadline exists. Caller
        // scheduling cannot move its start past the parent's waiting period.
        let deadline = owned
            .ingestion_deadline(
                &source,
                ChunkingLimits {
                    timeout: Duration::from_millis(20),
                },
            )
            .unwrap();
        started.send(deadline).unwrap();
        owned.ingest_checkpoint_opened(input, &source, deadline, |_| Ok(()))
    });
    let started = ready.recv_timeout(Duration::from_secs(2));
    if let Ok(deadline) = started {
        std::thread::sleep(
            deadline.saturating_duration_since(Instant::now()) + Duration::from_millis(10),
        );
    }
    drop(held);
    let result = task.join();
    started.unwrap();
    assert_eq!(result.unwrap(), Err(MaterialError::Deadline));
    assert_eq!(store.inner.inventory().unwrap().1, 0);
    assert!(fs::read_dir(parent.path().join("material"))
        .unwrap()
        .all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".checkpoint.json")));
}
#[test]
fn legacy_receipts_remain_separate_and_unchanged() {
    let (_parent, path, store, source) = stage(b"opaque");
    let (manifest, checkpoint) = store
        .ingest_checkpoint(&path, &source, ChunkingLimits::default())
        .unwrap();
    let legacy = MaterialManifest {
        schema_version: 1,
        community_id: source.claims().community_id.clone(),
        partition_id: manifest.partition_id,
        source_archive_sha256: source.claims().archive_sha256.clone(),
        source_inventory_sha256: "ab".repeat(32),
        key_context_sha256: "ef".repeat(32),
        checkpoint_applied_seq: 16,
        required_through_seq: 16,
        assigned_sequence_high_water: 16,
        objects: manifest.objects,
    };
    let receipt = store.certify_local(&legacy).unwrap();
    assert_eq!(store.receipt(receipt.manifest_sha256()).unwrap(), receipt);
    assert_ne!(receipt.manifest_sha256(), checkpoint.manifest_sha256());
    assert_eq!(
        store.checkpoint_receipt(receipt.manifest_sha256(), "node-1"),
        Err(MaterialError::NotFound)
    );
    assert_eq!(
        serde_json::to_value(receipt).unwrap()["sourceAuthenticityVerified"],
        false
    );
}
#[test]
#[ignore = "owned signed-checkpoint publication crash child invoked by parent"]
fn signed_checkpoint_crash_child() {
    let root = PathBuf::from(std::env::var_os("WABI_SIGNED_CHECKPOINT_ROOT").unwrap());
    let wanted = std::env::var("WABI_SIGNED_CHECKPOINT_POINT").unwrap();
    let source = fixture(b"opaque");
    let store = MaterialStore::open(&root, binding(&source), limits()).unwrap();
    let object = ObjectRef {
        kind: MaterialKind::CheckpointChunk,
        sha256: digest(b"opaque"),
        bytes: 6,
    };
    store.put_object(&object, b"opaque").unwrap();
    let manifest = CheckpointManifest {
        schema_version: 2,
        partition_id: binding(&source).partition_id,
        source,
        objects: vec![object],
    };
    store
        .certify_checkpoint_hook(&manifest, "node-1", |point| {
            if format!("{point:?}") == wanted {
                println!("SIGNED_CHECKPOINT_READY");
                std::io::stdout().flush().unwrap();
                loop {
                    std::thread::park()
                }
            }
        })
        .unwrap();
    panic!("expected point not reached");
}
#[test]
fn signed_manifest_sigkill_boundaries_preserve_receipt_truth_and_lock_inode() {
    for point in [
        Point::StageSynced,
        Point::Linked,
        Point::StageRemoved,
        Point::DirectorySynced,
    ] {
        let root = private_root();
        let source = fixture(b"opaque");
        let initial = MaterialStore::open(root.path(), binding(&source), limits()).unwrap();
        let inode = fs::metadata(root.path().join(LOCK)).unwrap().ino();
        drop(initial);
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "material::checkpoint::tests::signed_checkpoint_crash_child",
                "--ignored",
                "--nocapture",
            ])
            .env("WABI_SIGNED_CHECKPOINT_ROOT", root.path())
            .env("WABI_SIGNED_CHECKPOINT_POINT", format!("{point:?}"))
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let output = child.stdout.take().unwrap();
        let (sender, receiver) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            let mut reader = BufReader::new(output);
            for _ in 0..8 {
                let mut line = String::new();
                if reader.by_ref().take(4096).read_line(&mut line).unwrap_or(0) == 0 {
                    break;
                }
                if line.trim() == "SIGNED_CHECKPOINT_READY" {
                    let _ = sender.send(());
                    break;
                }
            }
        });
        let ready = receiver.recv_timeout(Duration::from_secs(5));
        let killed = child.kill();
        let status = child.wait();
        reader.join().unwrap();
        ready.unwrap();
        killed.unwrap();
        assert!(!status.unwrap().success());
        let store = MaterialStore::open(root.path(), binding(&source), limits()).unwrap();
        let manifest = CheckpointManifest {
            schema_version: 2,
            partition_id: binding(&source).partition_id,
            source,
            objects: vec![ObjectRef {
                kind: MaterialKind::CheckpointChunk,
                sha256: digest(b"opaque"),
                bytes: 6,
            }],
        };
        let id = manifest.sha256().unwrap();
        if point == Point::StageSynced {
            assert_eq!(
                store.checkpoint_receipt(&id, "node-1"),
                Err(MaterialError::NotFound)
            )
        } else {
            let receipt = store.checkpoint_receipt(&id, "node-1").unwrap();
            assert_eq!(receipt.manifest_sha256(), id);
            assert_eq!(
                serde_json::to_value(receipt).unwrap()["canonicalWriterPermitted"],
                false
            )
        }
        assert_eq!(fs::metadata(root.path().join(LOCK)).unwrap().ino(), inode);
        assert!(store
            .inner
            .names()
            .unwrap()
            .iter()
            .all(|name| !name.starts_with(".stage-")));
    }
}
