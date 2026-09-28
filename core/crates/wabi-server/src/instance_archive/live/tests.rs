use super::*;

struct Fixture {
    temp: tempfile::TempDir,
    data: PathBuf,
    uploads: PathBuf,
    recipient: age::x25519::Recipient,
    identity: age::x25519::Identity,
    identity_path: PathBuf,
    root: [u8; 32],
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("source/data");
        let uploads = temp.path().join("source/uploads");
        fs::create_dir_all(data.join("wabidb/global/commit-index")).unwrap();
        fs::create_dir_all(data.join("wabidb/projections")).unwrap();
        fs::create_dir_all(&uploads).unwrap();
        // Empty synthetic storage fixture for archive framing/key checks.
        // Real engine restore/read acceptance lives in the AppState contract.
        fs::write(data.join("wabidb/storage-manifest.json"), b"{}").unwrap();
        fs::write(
            data.join("wabidb/projections/snapshot.json"),
            br#"{"watermark":0,"indexes":[]}"#,
        )
        .unwrap();
        fs::write(uploads.join("test.bin"), b"test-payload-archiveonly").unwrap();
        let identity = age::x25519::Identity::generate();
        let identity_path = temp.path().join("identity.txt");
        fs::write(&identity_path, identity.to_string().expose_secret()).unwrap();
        let recipient = identity.to_public();
        Self {
            temp,
            data,
            uploads,
            recipient,
            identity,
            identity_path,
            root: [0x27; 32],
        }
    }

    fn metadata(&self) -> LiveCheckpointMetadata {
        LiveCheckpointMetadata {
            schema_version: 1,
            captured_at_unix_ms: 1,
            applied_commit_seq: 0,
            commit_prefix_fingerprint: wabidb::replication::commit_prefix_fingerprint(&[], 0),
            bootstrap_fingerprint: wabidb::replication::replica_fingerprint(&self.root),
            node_id: "archive-unit-fixture".into(),
            server_config: serde_json::json!({
                "node_id": "archive-unit-fixture",
                "server_role": "authority",
                "jwt_secret": "fixture-active-key"
            }),
            excluded_runtime_paths: ["data/.lock", "data/wabidb/.lock", "data/tailcat/addr.txt"]
                .into_iter()
                .map(str::to_owned)
                .collect(),
            active_key_substitutions: ["data/jwt_secret", "data/wabidb/root_key"]
                .into_iter()
                .map(str::to_owned)
                .collect(),
            external_state_verified: false,
            full_instance_ready: false,
        }
    }

    fn export(&self, name: &str, metadata: LiveCheckpointMetadata) -> Result<LiveArchiveReceipt> {
        export_frozen(
            FrozenExport {
                data: &self.data,
                uploads: &self.uploads,
                jwt_secret: "fixture-active-key",
                root_key: &self.root,
                metadata,
            },
            &self.recipient.to_string(),
            &self.temp.path().join(name),
            limits(),
        )
    }

    fn decrypt(&self, path: &Path) -> Vec<u8> {
        let decryptor = Decryptor::new(File::open(path).unwrap()).unwrap();
        let mut reader = decryptor
            .decrypt(std::iter::once(&self.identity as &dyn age::Identity))
            .unwrap();
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).unwrap();
        bytes
    }

    fn encrypt(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let output = self.temp.path().join(name);
        let encryptor =
            Encryptor::with_recipients(std::iter::once(&self.recipient as &dyn age::Recipient))
                .unwrap();
        let mut writer = encryptor
            .wrap_output(File::create(&output).unwrap())
            .unwrap();
        writer.write_all(bytes).unwrap();
        writer.finish().unwrap();
        output
    }

    fn no_restore_temps(&self) {
        assert!(!fs::read_dir(self.temp.path()).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".wabi-restore-")));
    }

    fn refuse_restore(&self, archive: &Path) -> String {
        let target = self.temp.path().join("refused-restore");
        let error = restore(archive, &self.identity_path, &target, false, false).unwrap_err();
        assert!(!target.exists());
        self.no_restore_temps();
        error.to_string()
    }
}

fn limits() -> LiveExportLimits {
    LiveExportLimits {
        max_entries: 1_000,
        max_plaintext_bytes: 1024 * 1024,
        max_inventory_path_bytes: 64 * 1024,
        copy_timeout: Duration::from_secs(10),
    }
}

fn rewrite_header(bytes: &[u8], change: impl FnOnce(&mut LiveCheckpointMetadata)) -> Vec<u8> {
    let mut remaining = &bytes[LIVE_MAGIC.len()..];
    let mut header = read_metadata(&mut remaining).unwrap();
    change(&mut header);
    let header = serde_json::to_vec(&header).unwrap();
    let mut rewritten = LIVE_MAGIC.to_vec();
    rewritten.extend_from_slice(&(header.len() as u32).to_le_bytes());
    rewritten.extend_from_slice(&header);
    rewritten.extend_from_slice(remaining);
    rewritten
}

#[test]
fn live_restore_is_fenced_without_the_passive_flag_and_cannot_use_stopped_activation() {
    let fixture = Fixture::new();
    let receipt = fixture.export("archive.age", fixture.metadata()).unwrap();
    let archive = fixture.temp.path().join("archive.age");
    let target = fixture.temp.path().join("inactive");
    restore(&archive, &fixture.identity_path, &target, false, false).unwrap();
    assert!(target.join("data/wabidb").join(LIVE_MARKER).is_file());
    assert_eq!(
        fs::read(target.join("data/wabidb").join(WRITER_FENCE_MARKER)).unwrap(),
        b"fenced\n"
    );
    assert!(!receipt.full_instance_ready);
    assert_eq!(
        receipt.encrypted_archive_sha256,
        hex::encode(Sha256::digest(fs::read(&archive).unwrap()))
    );
    let unused_receipt = fixture.temp.path().join("missing-receipt");
    for result in [
        activate_restored(&target, &unused_receipt),
        activate_passive(&target, &unused_receipt, true),
    ] {
        assert!(result.unwrap_err().to_string().contains("live checkpoint"));
    }
    fs::remove_file(target.join("data/wabidb").join(WRITER_FENCE_MARKER)).unwrap();
    assert!(refuse_live_activation(&target.join("data")).is_err());
    let blocked = fixture.temp.path().join("controlled");
    assert!(
        restore(&archive, &fixture.identity_path, &blocked, true, false)
            .unwrap_err()
            .to_string()
            .contains("stopped controlled-move")
    );
    assert!(!blocked.exists());
    fixture.no_restore_temps();
}

#[test]
fn export_refuses_metadata_for_different_active_keys_before_creating_output() {
    let fixture = Fixture::new();
    let mut metadata = fixture.metadata();
    metadata.server_config["jwt_secret"] = "different-key".into();
    assert!(fixture
        .export("wrong-jwt.age", metadata)
        .unwrap_err()
        .to_string()
        .contains("active keys"));
    let mut metadata = fixture.metadata();
    metadata.bootstrap_fingerprint = "11".repeat(32);
    assert!(fixture
        .export("wrong-root.age", metadata)
        .unwrap_err()
        .to_string()
        .contains("active keys"));
    assert!(!fixture.temp.path().join("wrong-jwt.age").exists());
    assert!(!fixture.temp.path().join("wrong-root.age").exists());
}

#[test]
fn restore_refuses_authenticated_position_prefix_and_key_header_mismatches() {
    let fixture = Fixture::new();
    fixture.export("original.age", fixture.metadata()).unwrap();
    let original = fixture.decrypt(&fixture.temp.path().join("original.age"));
    for mismatch in ["position", "prefix", "root", "jwt"] {
        let rewritten = rewrite_header(&original, |metadata| match mismatch {
            "position" => metadata.applied_commit_seq = 1,
            "prefix" => metadata.commit_prefix_fingerprint = "22".repeat(32),
            "root" => metadata.bootstrap_fingerprint = "22".repeat(32),
            "jwt" => metadata.server_config["jwt_secret"] = "different".into(),
            _ => unreachable!(),
        });
        let archive = fixture.encrypt(&format!("{mismatch}.age"), &rewritten);
        let error = fixture.refuse_restore(&archive);
        assert!(
            error.contains("disagrees") || error.contains("disagree"),
            "{error}"
        );
    }
}

#[test]
fn restore_refuses_authenticated_readiness_claims_and_oversized_header() {
    let fixture = Fixture::new();
    fixture.export("original.age", fixture.metadata()).unwrap();
    let original = fixture.decrypt(&fixture.temp.path().join("original.age"));
    for external in [false, true] {
        let bytes = rewrite_header(&original, |metadata| {
            if external {
                metadata.external_state_verified = true;
            } else {
                metadata.full_instance_ready = true;
            }
        });
        let archive = fixture.encrypt(&format!("readiness-{external}.age"), &bytes);
        assert!(fixture
            .refuse_restore(&archive)
            .contains("unsupported readiness"));
    }
    let mut bytes = LIVE_MAGIC.to_vec();
    bytes.extend_from_slice(&((MAX_HEADER_BYTES + 1) as u32).to_le_bytes());
    let archive = fixture.encrypt("large-header.age", &bytes);
    assert!(fixture
        .refuse_restore(&archive)
        .contains("header exceeds limit"));
}

#[test]
fn restore_refuses_authenticated_bad_file_digest_footer_and_trailing_bytes() {
    let fixture = Fixture::new();
    fixture.export("original.age", fixture.metadata()).unwrap();
    let original = fixture.decrypt(&fixture.temp.path().join("original.age"));
    let mut bytes = original.clone();
    let payload = b"test-payload-archiveonly";
    let position = bytes
        .windows(payload.len())
        .position(|w| w == payload)
        .unwrap();
    bytes[position] ^= 1;
    let archive = fixture.encrypt("bad-file.age", &bytes);
    assert!(fixture
        .refuse_restore(&archive)
        .contains("file hash mismatch"));
    let mut bytes = original.clone();
    let last = bytes.len() - 1;
    bytes[last] ^= 1;
    let archive = fixture.encrypt("bad-footer.age", &bytes);
    assert!(fixture
        .refuse_restore(&archive)
        .contains("inventory footer mismatch"));
    let mut bytes = original;
    bytes.push(0);
    let archive = fixture.encrypt("trailing.age", &bytes);
    assert!(fixture.refuse_restore(&archive).contains("trailing data"));
}

#[test]
fn ciphertext_corruption_truncation_and_wrong_identity_leave_no_restore() {
    let fixture = Fixture::new();
    fixture.export("original.age", fixture.metadata()).unwrap();
    let original_path = fixture.temp.path().join("original.age");
    let original = fs::read(&original_path).unwrap();
    let mut bytes = original.clone();
    let last = bytes.len() - 1;
    bytes[last] ^= 1;
    let corrupt = fixture.temp.path().join("corrupt.age");
    fs::write(&corrupt, bytes).unwrap();
    fixture.refuse_restore(&corrupt);
    let truncated = fixture.temp.path().join("truncated.age");
    fs::write(&truncated, &original[..original.len() - 8]).unwrap();
    fixture.refuse_restore(&truncated);
    let other = age::x25519::Identity::generate();
    let wrong_key = fixture.temp.path().join("wrong-identity");
    fs::write(&wrong_key, other.to_string().expose_secret()).unwrap();
    let target = fixture.temp.path().join("wrong-key-restore");
    assert!(restore(&original_path, &wrong_key, &target, false, false).is_err());
    assert!(!target.exists());
    fixture.no_restore_temps();
}

#[test]
fn authenticated_unsafe_duplicate_and_invalid_kind_entries_are_refused() {
    let fixture = Fixture::new();
    for case in ["unsafe", "duplicate", "kind"] {
        let header = serde_json::to_vec(&fixture.metadata()).unwrap();
        let mut bytes = LIVE_MAGIC.to_vec();
        bytes.extend_from_slice(&(header.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&header);
        write_string(&mut bytes, "").unwrap();
        bytes.extend_from_slice(&(if case == "duplicate" { 2u64 } else { 1u64 }).to_le_bytes());
        bytes.push(if case == "kind" { 2 } else { 0 });
        write_string(
            &mut bytes,
            if case == "unsafe" {
                "data/../escape"
            } else {
                "data"
            },
        )
        .unwrap();
        if case == "duplicate" {
            bytes.push(0);
            write_string(&mut bytes, "data").unwrap();
        }
        let archive = fixture.encrypt(&format!("{case}.age"), &bytes);
        let error = fixture.refuse_restore(&archive);
        assert!(
            error.contains("path") || error.contains("entry type"),
            "{error}"
        );
    }
}

#[test]
fn inventory_footer_binds_path_type_content_size_and_totals() {
    let mut inventory = Inventory::default();
    inventory.entry("data", true, 0, &[0; 32]);
    inventory.entry("data/file", false, 7, &[3; 32]);
    let footer = inventory.footer();
    inventory.verify_footer(&mut &footer[..]).unwrap();
    for offset in [
        0,
        FOOTER_MAGIC.len(),
        FOOTER_MAGIC.len() + 8,
        FOOTER_MAGIC.len() + 16,
        footer.len() - 1,
    ] {
        let mut changed = footer.clone();
        changed[offset] ^= 1;
        assert!(inventory.verify_footer(&mut &changed[..]).is_err());
    }
    for (name, directory, size, digest) in [
        ("data/other", false, 7, [3; 32]),
        ("data/file", true, 7, [3; 32]),
        ("data/file", false, 8, [3; 32]),
        ("data/file", false, 7, [4; 32]),
    ] {
        let mut changed = Inventory::default();
        changed.entry("data", true, 0, &[0; 32]);
        changed.entry(name, directory, size, &digest);
        assert!(changed.verify_footer(&mut &footer[..]).is_err());
    }
    assert!(inventory
        .verify_footer(&mut &footer[..footer.len() - 1])
        .is_err());
}

#[test]
fn file_revalidation_detects_changed_bytes_even_with_original_size_and_mtime() {
    let fixture = Fixture::new();
    let budget = Budget::new(limits()).unwrap();
    let entries = collect(&fixture.data, &fixture.uploads, false, &budget).unwrap();
    let entry = entries
        .iter()
        .find(|entry| entry.archive_path == "uploads/test.bin")
        .unwrap();
    let original = file_digest(entry, None, &budget).unwrap();
    fs::write(&entry.source_path, vec![b'X'; entry.size as usize]).unwrap();
    File::options()
        .write(true)
        .open(&entry.source_path)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(entry.modified.unwrap()))
        .unwrap();
    assert_ne!(file_digest(entry, None, &budget).unwrap(), original);
}

#[test]
fn inventory_limits_refuse_before_unbounded_queue_growth() {
    let fixture = Fixture::new();
    for name in 0..100 {
        fs::write(fixture.uploads.join(format!("item-{name}")), b"x").unwrap();
    }
    for constraint in ["entries", "paths", "bytes"] {
        let mut bounded = limits();
        match constraint {
            "entries" => bounded.max_entries = 10,
            "paths" => bounded.max_inventory_path_bytes = 80,
            "bytes" => bounded.max_plaintext_bytes = 1,
            _ => unreachable!(),
        }
        let budget = Budget::new(bounded).unwrap();
        assert!(collect(&fixture.data, &fixture.uploads, false, &budget)
            .unwrap_err()
            .to_string()
            .contains("budget exceeded"));
    }
}

#[test]
fn invalid_and_elapsed_limits_refuse() {
    for constraint in [
        "zero-time",
        "overflow-time",
        "entries-small",
        "entries-large",
        "zero-bytes",
        "zero-paths",
    ] {
        let mut value = limits();
        match constraint {
            "zero-time" => value.copy_timeout = Duration::ZERO,
            "overflow-time" => value.copy_timeout = Duration::MAX,
            "entries-small" => value.max_entries = 3,
            "entries-large" => value.max_entries = MAX_ENTRIES + 1,
            "zero-bytes" => value.max_plaintext_bytes = 0,
            "zero-paths" => value.max_inventory_path_bytes = 0,
            _ => unreachable!(),
        }
        assert!(Budget::new(value).is_err());
    }
    let mut budget = Budget::new(limits()).unwrap();
    budget.deadline = Instant::now();
    assert!(budget.check().is_err());
}

#[test]
fn output_guard_discards_owned_partial_and_unaccepted_published_ciphertext_on_panic() {
    let temp = tempfile::tempdir().unwrap();
    for published in [false, true] {
        let temporary = temp.path().join("partial.tmp");
        let output = temp.path().join("unaccepted.age");
        fs::write(&temporary, b"ciphertext").unwrap();
        if published {
            fs::hard_link(&temporary, &output).unwrap();
        }
        let guard = PrivateOutput {
            temporary: temporary.clone(),
            output: output.clone(),
            created: true,
            published,
            complete: false,
        };
        let result = std::panic::catch_unwind(move || {
            let _owned = guard;
            panic!("fixture injected failure");
        });
        assert!(result.is_err());
        assert!(!temporary.exists());
        assert!(!output.exists());
    }
}

#[test]
fn output_guard_keeps_accepted_output_and_does_not_remove_unowned_existing_files() {
    let temp = tempfile::tempdir().unwrap();
    let temporary = temp.path().join("temporary");
    let output = temp.path().join("archive");
    fs::write(&temporary, b"ciphertext").unwrap();
    fs::hard_link(&temporary, &output).unwrap();
    drop(PrivateOutput {
        temporary: temporary.clone(),
        output: output.clone(),
        created: true,
        published: true,
        complete: true,
    });
    assert!(!temporary.exists());
    assert_eq!(fs::read(&output).unwrap(), b"ciphertext");
    fs::write(&temporary, b"another-attempt").unwrap();
    drop(PrivateOutput {
        temporary: temporary.clone(),
        output: output.clone(),
        created: false,
        published: false,
        complete: false,
    });
    assert_eq!(fs::read(temporary).unwrap(), b"another-attempt");
    assert_eq!(fs::read(output).unwrap(), b"ciphertext");
}

#[cfg(unix)]
#[test]
fn unknown_symlinks_and_non_utf8_names_refuse_without_output() {
    use std::{
        ffi::OsString,
        os::unix::{ffi::OsStringExt, fs::symlink},
    };
    let fixture = Fixture::new();
    let link = fixture.data.join("unknown-link");
    symlink(fixture.uploads.join("test.bin"), &link).unwrap();
    assert!(fixture.export("symlink.age", fixture.metadata()).is_err());
    assert!(!fixture.temp.path().join("symlink.age").exists());
    fs::remove_file(link).unwrap();
    fs::write(
        fixture.data.join(OsString::from_vec(vec![0xFF])),
        b"unsupported",
    )
    .unwrap();
    assert!(fixture.export("name.age", fixture.metadata()).is_err());
    assert!(!fixture.temp.path().join("name.age").exists());
}

#[test]
fn exporter_refuses_existing_output_without_replacing_it() {
    let fixture = Fixture::new();
    let output = fixture.temp.path().join("existing.age");
    fs::write(&output, b"keep existing").unwrap();
    assert!(fixture.export("existing.age", fixture.metadata()).is_err());
    assert_eq!(fs::read(output).unwrap(), b"keep existing");
}
