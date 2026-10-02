use super::*;
use std::{
    io::{BufRead, BufReader},
    os::unix::fs::{symlink, MetadataExt, PermissionsExt},
    process::{Command, Stdio},
    sync::mpsc,
    time::Duration,
};

fn root() -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    root
}
fn binding() -> StoreBinding {
    StoreBinding {
        community_id: "ab".repeat(32),
        partition_id: "recovery/main".into(),
        node_id: 1,
    }
}
fn limits() -> MaterialLimits {
    MaterialLimits {
        min_free_bytes: 1,
        ..Default::default()
    }
}
fn object(kind: MaterialKind, bytes: &[u8]) -> ObjectRef {
    ObjectRef {
        kind,
        sha256: digest(bytes),
        bytes: bytes.len() as u64,
    }
}
fn bundle() -> (MaterialManifest, Vec<Vec<u8>>) {
    // Deliberately synthetic opaque bytes. This test cannot certify encryption.
    let bytes = vec![
        b"checkpoint-part-one".to_vec(),
        b"checkpoint-part-two".to_vec(),
        b"tail-through-12".to_vec(),
        b"attachment".to_vec(),
    ];
    let kinds = [
        MaterialKind::CheckpointChunk,
        MaterialKind::CheckpointChunk,
        MaterialKind::CommittedTailChunk,
        MaterialKind::BlobChunk,
    ];
    let manifest = MaterialManifest {
        schema_version: 1,
        community_id: binding().community_id,
        partition_id: binding().partition_id,
        source_archive_sha256: digest(&[bytes[0].as_slice(), bytes[1].as_slice()].concat()),
        source_inventory_sha256: "cd".repeat(32),
        key_context_sha256: "ef".repeat(32),
        checkpoint_applied_seq: 10,
        required_through_seq: 12,
        assigned_sequence_high_water: 15,
        objects: kinds
            .into_iter()
            .zip(&bytes)
            .map(|(kind, data)| object(kind, data))
            .collect(),
    };
    (manifest, bytes)
}
fn populate(store: &MaterialStore, manifest: &MaterialManifest, bytes: &[Vec<u8>]) {
    for (object, bytes) in manifest.objects.iter().zip(bytes) {
        store.put_object(object, bytes).unwrap()
    }
}
fn no_stages(path: &Path) {
    assert!(fs::read_dir(path).unwrap().all(|e| !e
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".stage-")))
}

#[test]
fn exact_bytes_receipt_reopens_without_writer_permission() {
    let root = root();
    let (manifest, bytes) = bundle();
    let store = MaterialStore::open(root.path(), binding(), limits()).unwrap();
    populate(&store, &manifest, &bytes);
    let receipt = store.certify_local(&manifest).unwrap();
    let encoded = serde_json::to_value(&receipt).unwrap();
    for field in [
        "sourceAuthenticityVerified",
        "payloadEncryptionVerified",
        "inactiveReplayVerified",
        "quorumAvailable",
        "fullInstanceReady",
        "canonicalWriterPermitted",
    ] {
        assert_eq!(encoded[field], false)
    }
    assert_eq!(encoded["scope"], "local_required_bytes_only");
    assert_eq!(encoded["requiredObjects"], 4);
    assert_eq!(store.receipt(receipt.manifest_sha256()).unwrap(), receipt);
    let inode = fs::metadata(root.path().join(LOCK)).unwrap().ino();
    drop(store);
    let store = MaterialStore::open(root.path(), binding(), limits()).unwrap();
    assert_eq!(store.receipt(receipt.manifest_sha256()).unwrap(), receipt);
    assert_eq!(fs::metadata(root.path().join(LOCK)).unwrap().ino(), inode);
    no_stages(root.path());
}
#[test]
fn absent_wrong_or_corrupt_material_cannot_receive_a_receipt() {
    let root = root();
    let store = MaterialStore::open(root.path(), binding(), limits()).unwrap();
    let (manifest, bytes) = bundle();
    assert_eq!(store.certify_local(&manifest), Err(MaterialError::NotFound));
    assert_eq!(
        store.put_object(&manifest.objects[0], b"wrong"),
        Err(MaterialError::Format)
    );
    populate(&store, &manifest, &bytes);
    let receipt = store.certify_local(&manifest).unwrap();
    let file = root
        .path()
        .join(format!("{}.blob", manifest.objects[3].sha256));
    fs::write(&file, b"wrong-size").unwrap();
    assert_eq!(
        store.receipt(receipt.manifest_sha256()),
        Err(MaterialError::Format)
    );
    assert_eq!(
        store.put_object(&manifest.objects[3], &bytes[3]),
        Err(MaterialError::Format)
    );
    assert_eq!(fs::read(file).unwrap(), b"wrong-size");
    no_stages(root.path());
}
#[test]
fn manifest_identity_context_order_and_sequence_rules_are_enforced() {
    let root = root();
    let store = MaterialStore::open(root.path(), binding(), limits()).unwrap();
    let (manifest, bytes) = bundle();
    populate(&store, &manifest, &bytes);
    let mut changed = manifest.clone();
    changed.community_id = "12".repeat(32);
    assert_eq!(store.certify_local(&changed), Err(MaterialError::Context));
    changed = manifest.clone();
    changed.objects.swap(0, 1);
    assert_eq!(store.certify_local(&changed), Err(MaterialError::Format));
    changed = manifest.clone();
    changed.source_archive_sha256 = "12".repeat(32);
    assert_eq!(store.certify_local(&changed), Err(MaterialError::Format));
    changed = manifest.clone();
    changed.assigned_sequence_high_water = 11;
    assert_eq!(store.certify_local(&changed), Err(MaterialError::Format));
    changed = manifest.clone();
    changed
        .objects
        .retain(|o| o.kind != MaterialKind::CommittedTailChunk);
    assert_eq!(store.certify_local(&changed), Err(MaterialError::Format));
    changed = manifest.clone();
    changed.objects.push(changed.objects[0].clone());
    assert_eq!(store.certify_local(&changed), Err(MaterialError::Format));
    let receipt = store.certify_local(&manifest).unwrap();
    changed = manifest;
    changed.key_context_sha256 = "12".repeat(32);
    let other = store.certify_local(&changed).unwrap();
    assert_ne!(receipt.manifest_sha256(), other.manifest_sha256());
    assert_eq!(store.receipt("../manifest"), Err(MaterialError::Format));
    no_stages(root.path());
}
#[test]
fn configured_object_total_count_manifest_and_free_space_budgets_apply() {
    let initial_root = root();
    let mut limited = limits();
    limited.max_object_bytes = 4;
    limited.max_stored_bytes = 6;
    limited.max_objects = 2;
    limited.max_manifests = 1;
    let store = MaterialStore::open(initial_root.path(), binding(), limited).unwrap();
    let a = object(MaterialKind::CheckpointChunk, b"1234");
    store.put_object(&a, b"1234").unwrap();
    assert_eq!(
        store.put_object(&object(MaterialKind::BlobChunk, b"abcde"), b"abcde"),
        Err(MaterialError::Budget)
    );
    assert_eq!(
        store.put_object(&object(MaterialKind::BlobChunk, b"abc"), b"abc"),
        Err(MaterialError::Budget)
    );
    store
        .put_object(&object(MaterialKind::BlobChunk, b"ab"), b"ab")
        .unwrap();
    assert_eq!(
        store.put_object(&object(MaterialKind::BlobChunk, b"c"), b"c"),
        Err(MaterialError::Budget)
    );
    no_stages(initial_root.path());
    drop(store);
    let full = root();
    let mut limited = limits();
    limited.min_free_bytes = u64::MAX;
    assert_eq!(
        MaterialStore::open(full.path(), binding(), limited).unwrap_err(),
        MaterialError::Budget
    );
    let separate = root();
    let (manifest, bytes) = bundle();
    let mut limited = limits();
    limited.max_manifests = 1;
    let store = MaterialStore::open(separate.path(), binding(), limited).unwrap();
    populate(&store, &manifest, &bytes);
    store.certify_local(&manifest).unwrap();
    let mut other = manifest;
    other.key_context_sha256 = "12".repeat(32);
    assert_eq!(store.certify_local(&other), Err(MaterialError::Budget));
    no_stages(separate.path());
}
#[test]
fn unrelated_public_or_symlinked_roots_are_refused_without_mutation() {
    let unrelated = root();
    fs::write(unrelated.path().join("operator-data"), b"preserve").unwrap();
    assert_eq!(
        MaterialStore::open(unrelated.path(), binding(), limits()).unwrap_err(),
        MaterialError::Ownership
    );
    assert!(!unrelated.path().join(LOCK).exists());
    assert_eq!(
        fs::read(unrelated.path().join("operator-data")).unwrap(),
        b"preserve"
    );
    let public = root();
    fs::set_permissions(public.path(), fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(
        MaterialStore::open(public.path(), binding(), limits()).unwrap_err(),
        MaterialError::Ownership
    );
    let parent = root();
    let target = root();
    symlink(target.path(), parent.path().join("alias")).unwrap();
    assert_eq!(
        MaterialStore::open(&parent.path().join("alias"), binding(), limits()).unwrap_err(),
        MaterialError::Ownership
    );
    assert!(!target.path().join(LOCK).exists());
}
#[test]
fn held_lock_and_binding_remain_exclusive_until_every_clone_drops() {
    let root = root();
    let store = MaterialStore::open(root.path(), binding(), limits()).unwrap();
    let clone = store.clone();
    drop(store);
    assert_eq!(
        MaterialStore::open(root.path(), binding(), limits()).unwrap_err(),
        MaterialError::Ownership
    );
    drop(clone);
    let mut changed = binding();
    changed.node_id = 2;
    assert_eq!(
        MaterialStore::open(root.path(), changed, limits()).unwrap_err(),
        MaterialError::Context
    );
    assert!(MaterialStore::open(root.path(), binding(), limits()).is_ok());
}
#[test]
fn concurrent_duplicates_publish_one_immutable_object() {
    let root = root();
    let store = MaterialStore::open(root.path(), binding(), limits()).unwrap();
    let object = object(MaterialKind::CheckpointChunk, b"same");
    let threads: Vec<_> = (0..8)
        .map(|_| {
            let store = store.clone();
            let object = object.clone();
            std::thread::spawn(move || store.put_object(&object, b"same").unwrap())
        })
        .collect();
    for thread in threads {
        thread.join().unwrap()
    }
    assert_eq!(store.inner.inventory().unwrap(), (1, 0, 4));
    no_stages(root.path());
}
#[test]
fn replaced_root_and_lock_refuse_writes_without_touching_redirect() {
    let parent = root();
    let path = parent.path().join("store");
    fs::create_dir(&path).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    let store = MaterialStore::open(&path, binding(), limits()).unwrap();
    fs::rename(&path, parent.path().join("retired")).unwrap();
    fs::create_dir(&path).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(
        store.put_object(&object(MaterialKind::BlobChunk, b"a"), b"a"),
        Err(MaterialError::Ownership)
    );
    assert_eq!(fs::read_dir(&path).unwrap().count(), 0);
    drop(store);
    let root = root();
    let store = MaterialStore::open(root.path(), binding(), limits()).unwrap();
    fs::rename(root.path().join(LOCK), root.path().join("original-lock")).unwrap();
    let new = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(root.path().join(LOCK))
        .unwrap();
    drop(new);
    assert_eq!(
        store.put_object(&object(MaterialKind::BlobChunk, b"a"), b"a"),
        Err(MaterialError::Ownership)
    );
}
#[test]
fn symlink_hardlink_and_public_required_objects_are_refused() {
    for attack in 0..3 {
        let root = root();
        let store = MaterialStore::open(root.path(), binding(), limits()).unwrap();
        let (manifest, bytes) = bundle();
        populate(&store, &manifest, &bytes);
        let path = root
            .path()
            .join(format!("{}.blob", manifest.objects[0].sha256));
        match attack {
            0 => {
                let other = root.path().join("external");
                fs::rename(&path, &other).unwrap();
                symlink(&other, &path).unwrap()
            }
            1 => fs::hard_link(&path, root.path().join("external")).unwrap(),
            _ => fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap(),
        }
        assert_eq!(
            store.certify_local(&manifest),
            Err(MaterialError::Ownership)
        );
    }
}
#[test]
fn removed_required_object_and_tampered_manifest_refuse_fresh_receipts() {
    let root = root();
    let store = MaterialStore::open(root.path(), binding(), limits()).unwrap();
    let (manifest, bytes) = bundle();
    populate(&store, &manifest, &bytes);
    let receipt = store.certify_local(&manifest).unwrap();
    fs::remove_file(
        root.path()
            .join(format!("{}.blob", manifest.objects[3].sha256)),
    )
    .unwrap();
    assert_eq!(
        store.receipt(receipt.manifest_sha256()),
        Err(MaterialError::NotFound)
    );
    store.put_object(&manifest.objects[3], &bytes[3]).unwrap();
    fs::write(
        root.path()
            .join(format!("{}.manifest.json", receipt.manifest_sha256())),
        b"{}",
    )
    .unwrap();
    assert_eq!(
        store.receipt(receipt.manifest_sha256()),
        Err(MaterialError::Format)
    );
}

#[test]
#[ignore = "owned child entrypoint invoked by process crash acceptance"]
fn material_process_crash_child() {
    let path = std::env::var_os("WABI_MATERIAL_CRASH_ROOT").unwrap();
    let wanted = std::env::var("WABI_MATERIAL_CRASH_POINT").unwrap();
    let mode = std::env::var("WABI_MATERIAL_CRASH_MODE").unwrap();
    let store = MaterialStore::open(Path::new(&path), binding(), limits()).unwrap();
    let (manifest, bytes) = bundle();
    let hook = |point: Point| {
        if format!("{point:?}") == wanted {
            println!("MATERIAL_CRASH_READY");
            std::io::stdout().flush().unwrap();
            loop {
                std::thread::park()
            }
        }
    };
    if mode == "manifest" {
        populate(&store, &manifest, &bytes);
        store.certify_hook(&manifest, hook).unwrap();
    } else {
        store
            .put_object_hook(&manifest.objects[0], &bytes[0], hook)
            .unwrap();
    }
    panic!("crash point not reached");
}
#[test]
fn process_sigkill_at_all_publication_boundaries_preserves_lock_and_truth() {
    for mode in ["object", "manifest"] {
        for point in [
            Point::StageSynced,
            Point::Linked,
            Point::StageRemoved,
            Point::DirectorySynced,
        ] {
            let root = root();
            let initial = MaterialStore::open(root.path(), binding(), limits()).unwrap();
            let lock_inode = fs::metadata(root.path().join(LOCK)).unwrap().ino();
            drop(initial);
            let mut child = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "material::tests::material_process_crash_child",
                    "--ignored",
                    "--nocapture",
                ])
                .env("WABI_MATERIAL_CRASH_ROOT", root.path())
                .env("WABI_MATERIAL_CRASH_MODE", mode)
                .env("WABI_MATERIAL_CRASH_POINT", format!("{point:?}"))
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
                    let mut bounded = reader.by_ref().take(4096);
                    if bounded.read_line(&mut line).unwrap_or(0) == 0 {
                        break;
                    }
                    if line.trim() == "MATERIAL_CRASH_READY" {
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
            let store = MaterialStore::open(root.path(), binding(), limits()).unwrap();
            let (manifest, bytes) = bundle();
            if mode == "object" {
                let path = root
                    .path()
                    .join(format!("{}.blob", manifest.objects[0].sha256));
                if point == Point::StageSynced {
                    assert!(!path.exists())
                } else {
                    assert_eq!(fs::read(path).unwrap(), bytes[0]);
                    store.put_object(&manifest.objects[0], &bytes[0]).unwrap()
                }
            } else {
                let id = digest(&json(&manifest).unwrap());
                if point == Point::StageSynced {
                    assert_eq!(store.receipt(&id), Err(MaterialError::NotFound))
                } else {
                    let receipt = store.receipt(&id).unwrap();
                    assert_eq!(receipt.manifest_sha256(), id);
                    assert_eq!(
                        serde_json::to_value(receipt).unwrap()["canonicalWriterPermitted"],
                        false
                    )
                }
            }
            assert_eq!(
                fs::metadata(root.path().join(LOCK)).unwrap().ino(),
                lock_inode
            );
            no_stages(root.path());
        }
    }
}
