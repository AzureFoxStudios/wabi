use super::*;
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use std::{
    io::{BufRead, BufReader},
    os::unix::fs::{symlink, PermissionsExt},
    process::{Command, Stdio},
    sync::mpsc,
};
fn fixture() -> (SignedSourceContext, LiveArchiveReceipt) {
    // Synthetic storage-only signature fixture, not a real Wabi capture.
    let key = SigningKey::from_bytes((&[7u8; 32]).into()).unwrap();
    let public_key = hex::encode(key.verifying_key().to_encoded_point(false).as_bytes());
    let community = hex::encode(Sha256::digest(hex::decode(&public_key).unwrap()));
    let receipt = LiveArchiveReceipt {
        schema_version: 1,
        applied_commit_seq: 16,
        commit_prefix_fingerprint: "ab".repeat(32),
        file_count: 1,
        directory_count: 1,
        plaintext_file_bytes: 3,
        ciphertext_bytes: 3,
        inventory_sha256: "cd".repeat(32),
        encrypted_archive_sha256: hex::encode(Sha256::digest(b"abc")),
        full_instance_ready: false,
    };
    let identity = FrozenSourceIdentity {
        community: community.clone(),
        node: "node-1".into(),
        bootstrap: "ef".repeat(32),
        applied: 16,
        prefix: receipt.commit_prefix_fingerprint.clone(),
    };
    let claims = identity.claims(&community, &receipt).unwrap();
    let sig: Signature = key.sign(&wabi_consensus::source_context::signing_input(&claims).unwrap());
    let sig = sig.normalize_s().unwrap_or(sig);
    (
        SignedSourceContext {
            claims,
            public_key,
            signature: hex::encode(sig.to_bytes()),
        },
        receipt,
    )
}
fn root() -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    root
}
#[test]
fn source_claims_and_receipt_bindings_fail_closed() {
    let (context, receipt) = fixture();
    validate_receipt(&context, &receipt, &context.claims.community_id, "node-1").unwrap();
    assert!(validate_receipt(&context, &receipt, &context.claims.community_id, "node-2").is_err());
    for fault in 0..6 {
        let mut changed = receipt.clone();
        match fault {
            0 => changed.schema_version = 2,
            1 => changed.full_instance_ready = true,
            2 => changed.ciphertext_bytes += 1,
            3 => changed.applied_commit_seq += 1,
            4 => changed.encrypted_archive_sha256 = "aa".repeat(32),
            _ => changed.inventory_sha256 = "aa".repeat(32),
        }
        assert!(
            validate_receipt(&context, &changed, &context.claims.community_id, "node-1").is_err()
        );
    }
    assert!(!valid_job_id("../secret"));
    assert!(!valid_job_id("00000000000000000000000000000000"));
}
#[test]
fn descriptor_publication_is_private_immutable_bounded_and_confined() {
    let root = root();
    let directory = SourceDirectory::open(root.path()).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let (context, receipt) = fixture();
    let collision = root.path().join(".source-context-owned-elsewhere");
    fs::write(&collision, b"preserve another publisher").unwrap();
    assert!(directory
        .publish_stage(
            &id,
            &context,
            ".source-context-owned-elsewhere".into(),
            |_| {}
        )
        .is_err());
    assert_eq!(fs::read(&collision).unwrap(), b"preserve another publisher");
    fs::remove_file(collision).unwrap();
    directory.publish(&id, &context).unwrap();
    assert_eq!(directory.read(&id).unwrap(), context);
    assert!(directory.publish(&id, &context).is_err());
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
    let path = root.path().join(format!("{id}.source-context.json"));
    assert_eq!(fs::metadata(&path).unwrap().mode() & 0o077, 0);
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(directory.read(&id).is_err());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let alias = root.path().join("alias");
    fs::hard_link(&path, &alias).unwrap();
    assert!(directory.read(&id).is_err());
    fs::remove_file(alias).unwrap();
    fs::write(&path, vec![b'x'; MAX_SOURCE_CONTEXT_BYTES + 1]).unwrap();
    assert!(directory.read(&id).is_err());
    fs::remove_file(&path).unwrap();
    symlink("missing-private-file", &path).unwrap();
    assert!(directory.read(&id).is_err());
    assert!(directory.publish(&id, &context).is_err());
    assert!(directory.read("../outside").is_err());
    let archive = root.path().join(format!("{id}.age"));
    fs::write(&archive, b"abc").unwrap();
    fs::set_permissions(&archive, fs::Permissions::from_mode(0o600)).unwrap();
    directory
        .verify_archive(&id, &receipt, 3, Duration::from_secs(1))
        .unwrap();
    assert!(directory
        .verify_archive(&id, &receipt, 2, Duration::from_secs(1))
        .is_err());
    fs::write(&archive, b"bad").unwrap();
    assert!(directory
        .verify_archive(&id, &receipt, 3, Duration::from_secs(1))
        .is_err());
    let moved = root.path().with_extension("moved-source-directory");
    fs::rename(root.path(), &moved).unwrap();
    fs::create_dir(root.path()).unwrap();
    assert!(directory.read(&id).is_err());
    fs::remove_dir_all(moved).unwrap();
}

fn archive_fixture(root: &Path, id: &str) -> PathBuf {
    let archive = root.join(format!("{id}.age"));
    fs::write(&archive, b"abc").unwrap();
    fs::set_permissions(&archive, fs::Permissions::from_mode(0o600)).unwrap();
    archive
}
#[test]
fn verified_archive_returns_same_held_descriptor_at_zero_and_ingests_signed_bytes() {
    let root = root();
    let directory = SourceDirectory::open(root.path()).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let archive = archive_fixture(root.path(), &id);
    let original = fs::metadata(archive).unwrap();
    let (context, receipt) = fixture();
    let observed_fd = std::cell::Cell::new(-1);
    let mut file = directory
        .verified_archive_file_hook(&id, &receipt, 3, Duration::from_secs(1), |held, _| {
            observed_fd.set(held.as_raw_fd());
        })
        .unwrap();
    assert_eq!(file.as_raw_fd(), observed_fd.get());
    assert_eq!(
        (
            file.metadata().unwrap().dev(),
            file.metadata().unwrap().ino()
        ),
        (original.dev(), original.ino())
    );
    assert_eq!(file.stream_position().unwrap(), 0);
    let mut read = [0; 3];
    file.read_exact(&mut read).unwrap();
    assert_eq!(&read, b"abc");
    // Consumes the same already-read File; the material API must rewind it.
    // This is a synthetic signature/storage bridge, not a genuine export.
    let material_root = root.path().join("material");
    fs::create_dir(&material_root).unwrap();
    fs::set_permissions(&material_root, fs::Permissions::from_mode(0o700)).unwrap();
    let store = wabi_consensus::material::MaterialStore::open(
        &material_root,
        wabi_consensus::model::StoreBinding {
            community_id: context.claims.community_id.clone(),
            partition_id: "community/control".into(),
            node_id: 1,
        },
        wabi_consensus::material::MaterialLimits {
            min_free_bytes: 1,
            ..Default::default()
        },
    )
    .unwrap();
    let verified = context
        .verify(&context.claims.community_id, "node-1")
        .unwrap();
    let (_, local) = store
        .ingest_checkpoint_file(
            file,
            &verified,
            wabi_consensus::material::ChunkingLimits::default(),
        )
        .unwrap();
    let view = serde_json::to_value(local).unwrap();
    assert_eq!(view["requiredBytes"], 3);
    assert_eq!(view["fullInstanceReady"], false);
    assert_eq!(view["canonicalWriterPermitted"], false);
    directory
        .verify_archive(&id, &receipt, 3, Duration::from_secs(1))
        .unwrap();
}
#[test]
fn verified_archive_refuses_unsafe_input_wrong_hash_budget_id_and_zero_deadline() {
    for attack in 0..5 {
        let root = root();
        let directory = SourceDirectory::open(root.path()).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let archive = archive_fixture(root.path(), &id);
        match attack {
            0 => fs::set_permissions(&archive, fs::Permissions::from_mode(0o644)).unwrap(),
            1 => fs::hard_link(&archive, root.path().join("second-link")).unwrap(),
            2 => {
                fs::rename(&archive, root.path().join("original.age")).unwrap();
                symlink("original.age", &archive).unwrap();
            }
            3 => {
                fs::remove_file(&archive).unwrap();
                fs::create_dir(&archive).unwrap();
                fs::set_permissions(&archive, fs::Permissions::from_mode(0o700)).unwrap();
            }
            _ => fs::write(&archive, b"bad").unwrap(),
        }
        assert!(directory
            .verified_archive_file(&id, &fixture().1, 3, Duration::from_secs(1))
            .is_err());
    }
    let root = root();
    let directory = SourceDirectory::open(root.path()).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    archive_fixture(root.path(), &id);
    let receipt = fixture().1;
    assert!(directory
        .verified_archive_file(&id, &receipt, 2, Duration::from_secs(1))
        .is_err());
    assert!(directory
        .verified_archive_file("../outside", &receipt, 3, Duration::from_secs(1))
        .is_err());
    assert!(directory
        .verified_archive_file(&id, &receipt, 3, Duration::ZERO)
        .is_err());
    let mut wrong = receipt;
    wrong.ciphertext_bytes += 1;
    assert!(directory
        .verified_archive_file(&id, &wrong, 4, Duration::from_secs(1))
        .is_err());
}
#[test]
fn verified_archive_rechecks_held_metadata_name_and_directory_after_reads() {
    for attack in 0..6 {
        let root = root();
        let source = root.path().join("source");
        fs::create_dir(&source).unwrap();
        fs::set_permissions(&source, fs::Permissions::from_mode(0o700)).unwrap();
        let directory = SourceDirectory::open(&source).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let archive = archive_fixture(&source, &id);
        let result = directory.verified_archive_file_hook(
            &id,
            &fixture().1,
            3,
            Duration::from_secs(1),
            |_, _| match attack {
                0 => fs::set_permissions(&archive, fs::Permissions::from_mode(0o400)).unwrap(),
                1 => fs::set_permissions(&archive, fs::Permissions::from_mode(0o644)).unwrap(),
                2 => fs::hard_link(&archive, source.join("second-link")).unwrap(),
                3 => {
                    fs::rename(&archive, source.join("original.age")).unwrap();
                    archive_fixture(&source, &id);
                }
                4 => File::open(&archive)
                    .unwrap()
                    .set_times(
                        fs::FileTimes::new()
                            .set_modified(std::time::UNIX_EPOCH + Duration::from_secs(42)),
                    )
                    .unwrap(),
                _ => {
                    fs::rename(&source, root.path().join("retained-source")).unwrap();
                    fs::create_dir(&source).unwrap();
                    fs::set_permissions(&source, fs::Permissions::from_mode(0o700)).unwrap();
                }
            },
        );
        assert!(
            result.is_err(),
            "accepted post-read metadata/name/directory change {attack}"
        );
    }
}
#[test]
fn verified_archive_expiry_after_reads_never_returns_a_file() {
    let root = root();
    let directory = SourceDirectory::open(root.path()).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    archive_fixture(root.path(), &id);
    let reached = std::cell::Cell::new(false);
    let result = directory.verified_archive_file_hook(
        &id,
        &fixture().1,
        3,
        Duration::from_secs(1),
        |_, deadline| {
            reached.set(true);
            std::thread::sleep(
                deadline.saturating_duration_since(Instant::now()) + Duration::from_millis(10),
            );
        },
    );
    assert!(
        reached.get(),
        "expiry test did not reach completed archive reads"
    );
    assert!(result.is_err());
}
#[test]
fn actual_process_death_never_exposes_partial_context_as_valid() {
    // The same archive tests are compiled under both the library and the
    // snapshot CLI wrapper. Strip only the crate name, keeping the real root.
    let child_test = format!(
        "{}::publication_crash_child",
        module_path!().split_once("::").unwrap().1
    );
    for point in ["StageSynced", "Linked", "StageRemoved", "DirectorySynced"] {
        let root = root();
        let id = uuid::Uuid::new_v4().to_string();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", &child_test, "--ignored", "--nocapture"])
            .env("WABI_SOURCE_CONTEXT_CHILD_ROOT", root.path())
            .env("WABI_SOURCE_CONTEXT_CHILD_ID", &id)
            .env("WABI_SOURCE_CONTEXT_CHILD_POINT", point)
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (sender, receiver) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if line.unwrap().contains("SOURCE-CONTEXT-CRASH-READY") {
                    sender.send(()).unwrap();
                    break;
                }
            }
        });
        let ready = receiver.recv_timeout(Duration::from_secs(10));
        child.kill().unwrap();
        let status = child.wait().unwrap();
        reader.join().unwrap();
        ready.unwrap();
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(status.signal(), Some(9));
        let directory = SourceDirectory::open(root.path()).unwrap();
        let result = directory.read(&id);
        if matches!(point, "StageRemoved" | "DirectorySynced") {
            assert_eq!(result.unwrap(), fixture().0);
        } else {
            assert!(result.is_err());
        }
        // Death can retain the private stage (and linked final). It stays disk
        // charged, never a Ready job. Only this owned TempDir is disposed.
    }
}
#[test]
#[ignore = "owned subprocess invoked by actual_process_death_never_exposes_partial_context_as_valid"]
fn publication_crash_child() {
    let root =
        std::path::PathBuf::from(std::env::var_os("WABI_SOURCE_CONTEXT_CHILD_ROOT").unwrap());
    let id = std::env::var("WABI_SOURCE_CONTEXT_CHILD_ID").unwrap();
    let point = std::env::var("WABI_SOURCE_CONTEXT_CHILD_POINT").unwrap();
    SourceDirectory::open(&root)
        .unwrap()
        .publish_hook(&id, &fixture().0, |stage| {
            if format!("{stage:?}") == point {
                println!("SOURCE-CONTEXT-CRASH-READY");
                std::io::stdout().flush().unwrap();
                loop {
                    std::thread::park();
                }
            }
        })
        .unwrap();
    panic!("missing crash point");
}
