//! Test bridge from authenticated peer ciphertext to the existing independent
//! inactive core verifier. No live Authority tree, engine writer, activation,
//! external-store readiness or production recovery-job API is introduced.
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::Path,
    time::Duration,
};
use wabi_consensus::{material::CheckpointManifest, transport::CheckpointClient};
use wabi_server::instance_archive::{
    restore_inactive_with_limits, verify_inactive_live, LiveArchiveReceipt, RestoreLimits,
};
use wabidb::engine::offline_inspect::InspectionLimits;

pub(super) async fn verify(
    peer: &CheckpointClient,
    expected: &CheckpointManifest,
    source: &LiveArchiveReceipt,
    identity: &Path,
) {
    let claims = &expected.source.claims;
    assert_eq!(source.schema_version, 1);
    assert!(!source.full_instance_ready);
    assert_eq!(source.encrypted_archive_sha256, claims.archive_sha256);
    assert_eq!(source.inventory_sha256, claims.inventory_sha256);
    assert_eq!(source.applied_commit_seq, claims.applied_commit_seq);
    assert_eq!(
        source.commit_prefix_fingerprint,
        claims.commit_prefix_fingerprint
    );
    assert_eq!(source.ciphertext_bytes, claims.ciphertext_bytes);
    assert!(claims.ciphertext_bytes > 0 && claims.ciphertext_bytes <= 64 * 1024 * 1024);
    let manifest_id = expected.sha256().unwrap();
    let observed = peer.fresh_receipt(expected).await.unwrap();
    assert!(matches!(observed.target_node_id(), 2 | 3));
    let fetched = peer.read_manifest(&manifest_id).await.unwrap();
    assert_eq!(&fetched, expected);
    let mut ciphertext = Vec::with_capacity(claims.ciphertext_bytes as usize);
    for index in 0..fetched.objects.len() {
        let bytes = peer.read_object(&fetched, index).await.unwrap();
        assert!(ciphertext.len() as u64 + bytes.len() as u64 <= claims.ciphertext_bytes);
        ciphertext.extend_from_slice(&bytes);
    }
    assert_eq!(ciphertext.len() as u64, claims.ciphertext_bytes);
    assert_eq!(
        hex::encode(Sha256::digest(&ciphertext)),
        claims.archive_sha256
    );
    // The recipient identity stays on the verifier computer. It never enters
    // a peer request. These are exclusively owned test inputs, not a public API.
    let mut key = Vec::new();
    fs::File::open(identity)
        .unwrap()
        .take(4097)
        .read_to_end(&mut key)
        .unwrap();
    assert!(!key.is_empty() && key.len() <= 4096);
    let source = source.clone();
    // Own scratch, the key copy, restore and all verifier calls inside this
    // blocking worker. A dropped caller cannot remove scratch under ongoing IO.
    // The nested private runtime keeps synchronous verifier IO off Raft's loop.
    let work = tokio::task::spawn_blocking(move || {
        let scratch = tempfile::tempdir().unwrap();
        fs::set_permissions(scratch.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let archive = scratch.path().join("peer.age");
        let private_key = scratch.path().join("recipient.txt");
        for (path, bytes) in [(&archive, &ciphertext), (&private_key, &key)] {
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(path)
                .unwrap();
            file.write_all(bytes).unwrap();
            file.sync_all().unwrap();
        }
        let inactive = scratch.path().join("inactive");
        restore_inactive_with_limits(
            &archive,
            &private_key,
            &inactive,
            RestoreLimits {
                max_entries: 10_000,
                max_plaintext_bytes: 64 * 1024 * 1024,
                max_path_bytes: 1024 * 1024,
                timeout: Duration::from_secs(30),
            },
            Some(&source.encrypted_archive_sha256),
        )
        .unwrap();
        let marker = inactive.join("data/wabidb/live-checkpoint-v1");
        let fence = inactive.join("data/wabidb/writer-fenced-v1");
        let guard = fs::read(&marker).unwrap();
        let fence_bytes = fs::read(&fence).unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let limits = InspectionLimits {
                timeout: Duration::from_secs(30),
                ..Default::default()
            };
            let receipt =
                verify_inactive_live(&inactive, &source, &archive, &private_key, limits.clone())
                    .await
                    .unwrap();
            assert_eq!(receipt.result, "PASS");
            assert_eq!(
                receipt.support_profile,
                "inactive-live-core-complete-history-v1"
            );
            assert_eq!(
                receipt.source_archive_sha256,
                source.encrypted_archive_sha256
            );
            assert!(receipt.source_receipt_matched && receipt.active_bundle_keys_match);
            assert!(receipt.inactive_guards_preserved);
            assert!(receipt.database.full_history_replayed);
            assert!(receipt.database.persisted_projection_matches);
            assert_eq!(
                receipt.database.applied_commit_seq,
                source.applied_commit_seq
            );
            assert_eq!(
                receipt.database.commit_prefix_fingerprint,
                source.commit_prefix_fingerprint
            );
            assert!(receipt.published_uploads_checked >= 1);
            assert!(!receipt.external_state_verified && !receipt.full_instance_ready);
            let lock_path = inactive.join("data/wabidb/.lock");
            let lock = fs::metadata(&lock_path).unwrap();
            let mut wrong_source = source.clone();
            wrong_source.encrypted_archive_sha256 = "00".repeat(32);
            assert!(verify_inactive_live(
                &inactive,
                &wrong_source,
                &archive,
                &private_key,
                limits.clone(),
            )
            .await
            .is_err());
            let upload = inactive.join("uploads/checkpoint-byte-fixture.bin");
            let original = fs::read(&upload).unwrap();
            let mut changed = original.clone();
            changed[0] ^= 1;
            fs::write(&upload, changed).unwrap();
            assert!(verify_inactive_live(
                &inactive,
                &source,
                &archive,
                &private_key,
                limits.clone(),
            )
            .await
            .is_err());
            fs::write(&upload, original).unwrap();
            // A fresh valid pass prevents blanket refusal from satisfying the
            // two negative assertions. Both inactive guards stay unmodified.
            verify_inactive_live(&inactive, &source, &archive, &private_key, limits)
                .await
                .unwrap();
            assert_eq!(fs::read(&marker).unwrap(), guard);
            assert_eq!(fs::read(&fence).unwrap(), fence_bytes);
            let after = fs::metadata(&lock_path).unwrap();
            assert_eq!((lock.dev(), lock.ino()), (after.dev(), after.ino()));
        });
        drop(runtime);
        // Explicitly assert owned plaintext/ciphertext/key scratch cleanup.
        let path = scratch.path().to_path_buf();
        scratch.close().unwrap();
        assert!(!path.exists());
    });
    work.await.unwrap();
}
