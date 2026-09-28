//! Main Wabi encrypted frozen-root archive; inactive inspection only.
use age::secrecy::ExposeSecret;
use sha2::{Digest, Sha256};
use std::{
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
};
use std::{path::Path, sync::Arc, time::Duration};
use wabi_server::{
    adapter::WdbAdapter,
    config::{LoreAddonConfig, ServerConfig, ServerRole},
    instance_archive::{restore_inactive, LiveCheckpointMetadata, LiveExportLimits},
    instance_checkpoint::InstanceCheckpointBoundary,
    state::AppState,
    upload_registry::UploadKind,
};
use wabidb::{
    domain::{ChannelKind, MemberRole},
    engine::wabi_store::WabiStore,
};

fn config(data: &Path, uploads: &Path) -> ServerConfig {
    assert!(
        std::env::var_os("WABIDB_ROOT_KEY").is_none(),
        "isolated checkpoint fixtures require the external database root-key override to be unset"
    );
    ServerConfig {
        host: "127.0.0.1".into(),
        port: 0,
        data_dir: data.to_string_lossy().into_owned(),
        uploads_dir: uploads.to_string_lossy().into_owned(),
        jwt_secret: "live-checkpoint-fixture-active-signing-key".into(),
        turn_enabled: false,
        turn_uri: None,
        turn_secret: None,
        node_id: "live-checkpoint-site".into(),
        is_primary: true,
        server_role: ServerRole::Authority,
        authority_url: None,
        admin_user_ids: vec![],
        blacklist_file: data.join("blacklist.txt").to_string_lossy().into_owned(),
        max_body_size: None,
        mesh_enabled: false,
        mesh_peers: vec![],
        lore: LoreAddonConfig::default(),
    }
}
fn limits() -> LiveExportLimits {
    LiveExportLimits {
        max_entries: 10_000,
        max_plaintext_bytes: 32 * 1024 * 1024,
        max_inventory_path_bytes: 1024 * 1024,
        copy_timeout: Duration::from_secs(30),
    }
}
fn identity(path: &Path) -> String {
    let key = age::x25519::Identity::generate();
    std::fs::write(path, key.to_string().expose_secret()).unwrap();
    key.to_public().to_string()
}

struct InboxProcess(Child);
impl Drop for InboxProcess {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn command_ok(program: &str, args: &[&str]) {
    let output = Command::new(program).args(args).output().unwrap();
    assert!(
        output.status.success(),
        "fixture command failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn fixture_path(path: &Path) -> &str {
    path.to_str().unwrap()
}

#[tokio::test]
async fn encrypted_live_archive_preserves_active_keys_security_retained_state_and_unknown_files() {
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().join("source/data");
    let uploads = temp.path().join("source/external-uploads");
    let state = Arc::new(AppState::new(config(&data, &uploads)).await.unwrap());
    let active_root = *state.wdb.engine().bootstrap_key();
    let user = state
        .wdb
        .create_user("owner", None, "fixture-hash")
        .await
        .unwrap();
    state.claim_ownership(user as i64, "owner").await.unwrap();
    let code = state
        .generate_recovery_codes(user as i64, 1)
        .await
        .unwrap()
        .remove(0);
    assert!(state
        .consume_recovery_code(&code, user as i64)
        .await
        .unwrap());
    state
        .revoke_token_with_exp(
            "fixture-denial".into(),
            chrono::Utc::now().timestamp() + 3600,
        )
        .await
        .unwrap();
    let channel = state
        .wdb
        .create_channel("Retained", ChannelKind::Text, user, false)
        .await
        .unwrap();
    state
        .wdb
        .add_channel_member(&channel, user, MemberRole::Owner)
        .await
        .unwrap();
    let retained = state
        .wdb
        .send_message(&channel, user, "kept fixture message", false, &[])
        .await
        .unwrap();
    let deleted = state
        .wdb
        .send_message(&channel, user, "deleted fixture message", false, &[])
        .await
        .unwrap();
    state.wdb.delete_message(&deleted, user).await.unwrap();
    for name in ["kept.bin", "denied.bin"] {
        state
            .upload_registry
            .publish_bytes(
                &uploads,
                state.wdb.engine(),
                name,
                name,
                Some(channel.clone()),
                Some(wabidb::sequencer::types::RoomOwnerPrecondition {
                    channel_id: channel.clone(),
                    owner_node_id: state.config.node_id.clone(),
                    expected_epoch: Some(1),
                }),
                Some(user as i64),
                UploadKind::Attachment,
                b"retained upload fixture bytes",
            )
            .await
            .unwrap();
    }
    state
        .upload_registry
        .revoke_canonical("denied.bin", state.wdb.engine(), user)
        .await
        .unwrap();
    std::fs::remove_file(uploads.join("denied.bin")).unwrap();
    std::fs::create_dir_all(data.join("unknown/empty")).unwrap();
    std::fs::write(
        data.join("unknown/new-component.json"),
        b"opaque component fixture",
    )
    .unwrap();
    std::fs::create_dir_all(uploads.join("unknown")).unwrap();
    std::fs::write(uploads.join("unknown/raw.bin"), b"unknown upload fixture").unwrap();
    std::fs::create_dir_all(data.join("tailcat")).unwrap();
    std::fs::write(
        data.join("tailcat/addr.txt"),
        b"old runtime address fixture",
    )
    .unwrap();
    std::fs::write(data.join("tailcat/keys.json"), b"[]").unwrap();
    // Simulate stale persisted files under active externally supplied keys.
    // The source's runtime keys stay authoritative; its files are not modified
    // by export. No real configuration or process is used in this fixture.
    std::fs::write(data.join("jwt_secret"), b"stale signing file").unwrap();
    std::fs::write(data.join("wabidb/root_key"), hex::encode([0xB8; 32])).unwrap();
    let key_file = temp.path().join("identity.txt");
    let recipient = identity(&key_file);
    let output = temp.path().join("checkpoint.age");
    let boundary =
        InstanceCheckpointBoundary::prepare_with_timeout(state.clone(), Duration::from_secs(3))
            .await
            .unwrap();
    let seq = boundary.applied_seq();
    let receipt = boundary
        .export_encrypted(recipient, output.clone(), limits())
        .await
        .unwrap()
        .unwrap();
    assert!(!receipt.full_instance_ready);
    assert_eq!(receipt.applied_commit_seq, seq);
    let ciphertext = std::fs::read(&output).unwrap();
    assert_eq!(receipt.ciphertext_bytes, ciphertext.len() as u64);
    assert_eq!(
        receipt.encrypted_archive_sha256,
        hex::encode(Sha256::digest(&ciphertext))
    );
    assert!(ciphertext.starts_with(b"age-encryption.org/v1"));
    assert!(!ciphertext
        .windows(state.config.jwt_secret.len())
        .any(|bytes| bytes == state.config.jwt_secret.as_bytes()));
    assert_eq!(
        std::fs::read(data.join("jwt_secret")).unwrap(),
        b"stale signing file"
    );
    let target = temp.path().join("inactive");
    restore_inactive(&output, &key_file, &target).unwrap();
    let restored_data = target.join("data");
    let restored_uploads = target.join("uploads");
    let metadata: LiveCheckpointMetadata =
        serde_json::from_slice(&std::fs::read(target.join("live-checkpoint.json")).unwrap())
            .unwrap();
    assert!(!metadata.full_instance_ready && !metadata.external_state_verified);
    assert_eq!(metadata.applied_commit_seq, seq);
    assert_eq!(
        std::fs::read_to_string(restored_data.join("jwt_secret")).unwrap(),
        state.config.jwt_secret
    );
    assert_eq!(
        std::fs::read_to_string(restored_data.join("wabidb/root_key"))
            .unwrap()
            .trim(),
        hex::encode(active_root)
    );
    assert!(restored_data.join("unknown/empty").is_dir());
    assert_eq!(
        std::fs::read(restored_data.join("unknown/new-component.json")).unwrap(),
        b"opaque component fixture"
    );
    assert_eq!(
        std::fs::read(restored_uploads.join("unknown/raw.bin")).unwrap(),
        b"unknown upload fixture"
    );
    assert!(!restored_data.join("tailcat/addr.txt").exists());
    assert!(restored_data.join("tailcat/keys.json").is_file());
    assert!(!restored_data.join("wabidb/.lock").exists());
    assert!(!restored_uploads.join("denied.bin").exists());
    assert_eq!(
        std::fs::read(restored_uploads.join("kept.bin")).unwrap(),
        b"retained upload fixture bytes"
    );
    assert!(AppState::new(config(&restored_data, &restored_uploads))
        .await
        .is_err());
    let inspected =
        WdbAdapter::open_with_node_id(&restored_data.join("wabidb"), state.config.node_id.clone())
            .await
            .unwrap();
    assert!(inspected.engine().local_writer_fenced().await);
    assert_eq!(inspected.engine().barrier().current(), seq);
    assert_eq!(inspected.get_owner_user_id().await.unwrap(), Some(user));
    let history = inspected.list_messages_typed(&channel, 20).await.unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].message_id, retained);
    let projection = inspected.engine().projection_state();
    use wabidb::projections::{auth_revocations as revocations, recovery_codes as codes};
    let key = b"token:fixture-denial";
    let bytes = projection.get(revocations::INDEX, key).unwrap();
    assert!(matches!(
        revocations::decode_value(key, &bytes).unwrap(),
        revocations::Value::Token { .. }
    ));
    let digest = hex::encode(Sha256::digest(code.as_bytes()));
    let key = codes::code_key(&digest);
    let bytes = projection.get(codes::INDEX, &key).unwrap();
    assert!(matches!(
        codes::decode_value(&key, &bytes).unwrap(),
        codes::Value::Code { consumed: true, .. }
    ));
    assert!(inspected
        .create_user("must-not-write", None, "fixture-hash")
        .await
        .is_err());
    state
        .wdb
        .send_message(&channel, user, "source resumed", false, &[])
        .await
        .unwrap();
    assert_eq!(
        inspected
            .list_messages_typed(&channel, 20)
            .await
            .unwrap()
            .len(),
        1
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&output).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(target.join("live-checkpoint.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[tokio::test]
async fn resource_limit_refusal_leaves_no_output_and_source_can_resume() {
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().join("data");
    let uploads = data.join("uploads");
    let state = Arc::new(AppState::new(config(&data, &uploads)).await.unwrap());
    std::fs::create_dir_all(&uploads).unwrap();
    let key_file = temp.path().join("identity.txt");
    let recipient = identity(&key_file);
    for (name, change) in ["entries", "bytes", "paths", "deadline"]
        .into_iter()
        .enumerate()
    {
        let mut budget = limits();
        match change {
            "entries" => budget.max_entries = 4,
            "bytes" => budget.max_plaintext_bytes = 1,
            "paths" => budget.max_inventory_path_bytes = 1,
            "deadline" => budget.copy_timeout = Duration::from_nanos(1),
            _ => unreachable!(),
        }
        let output = temp.path().join(format!("refused-{name}.age"));
        let boundary = InstanceCheckpointBoundary::prepare(state.clone())
            .await
            .unwrap();
        assert!(boundary
            .export_encrypted(recipient.clone(), output.clone(), budget)
            .await
            .unwrap()
            .is_err());
        assert!(!output.exists());
        assert!(!std::fs::read_dir(temp.path()).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".wabi-live-")));
        assert!(state.instance_operations.healthy_for_checkpoint());
    }
    state
        .wdb
        .create_user("after-refusal", None, "fixture-hash")
        .await
        .unwrap();
    let output = temp.path().join("accepted.age");
    InstanceCheckpointBoundary::prepare(state.clone())
        .await
        .unwrap()
        .export_encrypted(recipient, output.clone(), limits())
        .await
        .unwrap()
        .unwrap();
    let target = temp.path().join("inactive");
    restore_inactive(&output, &key_file, &target).unwrap();
    assert!(target.join("data/uploads").is_dir());
    assert!(!target.join("uploads").exists());
    let metadata: LiveCheckpointMetadata =
        serde_json::from_slice(&std::fs::read(target.join("live-checkpoint.json")).unwrap())
            .unwrap();
    assert_eq!(
        metadata.applied_commit_seq,
        state.wdb.engine().barrier().current()
    );
}

#[tokio::test]
async fn external_blacklist_and_enabled_lore_refuse_an_incomplete_export() {
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().join("data");
    let uploads = temp.path().join("uploads");
    std::fs::create_dir_all(&uploads).unwrap();
    let mut cfg = config(&data, &uploads);
    cfg.blacklist_file = temp
        .path()
        .join("outside-blacklist.txt")
        .to_string_lossy()
        .into_owned();
    let state = Arc::new(AppState::new(cfg).await.unwrap());
    let recipient = identity(&temp.path().join("identity.txt"));
    let output = temp.path().join("refused.age");
    let error = InstanceCheckpointBoundary::prepare(state)
        .await
        .unwrap()
        .export_encrypted(recipient.clone(), output.clone(), limits())
        .await
        .unwrap()
        .unwrap_err();
    assert!(error.to_string().contains("external blacklist"));
    assert!(!output.exists());
    let lore_data = temp.path().join("lore-source");
    let mut cfg = config(&lore_data, &uploads);
    cfg.lore.enabled = true;
    let state = Arc::new(AppState::new(cfg).await.unwrap());
    let error = InstanceCheckpointBoundary::prepare(state)
        .await
        .unwrap()
        .export_encrypted(recipient, output.clone(), limits())
        .await
        .unwrap()
        .unwrap_err();
    assert!(error.to_string().contains("Lore"));
    assert!(!output.exists());
}

#[tokio::test]
async fn live_archive_crosses_authenticated_inbox_and_cli_restore_stays_inactive() {
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().join("source-data");
    let uploads = temp.path().join("source-uploads");
    std::fs::create_dir_all(&uploads).unwrap();
    let state = Arc::new(AppState::new(config(&data, &uploads)).await.unwrap());
    let user = state
        .wdb
        .create_user("inbox-owner", None, "fixture-hash")
        .await
        .unwrap();
    state
        .claim_ownership(user as i64, "inbox-owner")
        .await
        .unwrap();
    let channel = state
        .wdb
        .create_channel("Checkpoint", ChannelKind::Text, user, false)
        .await
        .unwrap();
    state
        .wdb
        .add_channel_member(&channel, user, MemberRole::Owner)
        .await
        .unwrap();
    state
        .wdb
        .send_message(&channel, user, "at checkpoint", false, &[])
        .await
        .unwrap();
    std::fs::write(data.join("unknown-component"), b"retained sidecar").unwrap();
    let identity_file = temp.path().join("recovery.agekey");
    let recipient = identity(&identity_file);
    let archive = temp.path().join("live.age");
    let receipt = InstanceCheckpointBoundary::prepare(state.clone())
        .await
        .unwrap()
        .export_encrypted(recipient, archive.clone(), limits())
        .await
        .unwrap()
        .unwrap();
    state
        .wdb
        .send_message(&channel, user, "after checkpoint", false, &[])
        .await
        .unwrap();
    assert!(state.wdb.engine().barrier().current() > receipt.applied_commit_seq);

    let token = temp.path().join("inbox-token");
    std::fs::write(&token, b"0123456789abcdef0123456789abcdef\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&token, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    let storage = temp.path().join("inbox-storage");
    let inbox = env!("CARGO_BIN_EXE_wabi-instance-inbox");
    let mut process = InboxProcess(
        Command::new(inbox)
            .args([
                "serve",
                "--listen",
                "127.0.0.1:0",
                "--storage-dir",
                fixture_path(&storage),
                "--token-file",
                fixture_path(&token),
                "--max-bytes",
                "33554432",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let stdout = process.0.stdout.take().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        let result = BufReader::new(stdout).read_line(&mut line).map(|_| line);
        let _ = tx.send(result);
    });
    let line = rx
        .recv_timeout(Duration::from_secs(10))
        .expect("inbox must start promptly")
        .unwrap();
    let address = line
        .trim()
        .strip_prefix("Encrypted instance inbox listening on ")
        .unwrap();
    let endpoint = format!("http://{address}");
    let args = [
        "send",
        "--input",
        fixture_path(&archive),
        "--endpoint",
        &endpoint,
        "--token-file",
        fixture_path(&token),
        "--id",
        "live-checkpoint",
    ];
    command_ok(inbox, &args);
    let stored = storage.join("live-checkpoint.age");
    assert_eq!(
        hex::encode(Sha256::digest(std::fs::read(&stored).unwrap())),
        receipt.encrypted_archive_sha256
    );
    let repeated = Command::new(inbox).args(args).output().unwrap();
    assert!(!repeated.status.success());
    assert_eq!(
        hex::encode(Sha256::digest(std::fs::read(&stored).unwrap())),
        receipt.encrypted_archive_sha256
    );
    let wrong_token = temp.path().join("wrong-token");
    std::fs::write(&wrong_token, b"abcdef0123456789abcdef0123456789\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&wrong_token, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    let denied = Command::new(inbox)
        .args([
            "send",
            "--input",
            fixture_path(&archive),
            "--endpoint",
            &endpoint,
            "--token-file",
            fixture_path(&wrong_token),
            "--id",
            "denied-copy",
        ])
        .output()
        .unwrap();
    assert!(!denied.status.success());
    assert!(!storage.join("denied-copy.age").exists());

    let fetched = temp.path().join("fetched.age");
    command_ok(
        inbox,
        &[
            "fetch",
            "--id",
            "live-checkpoint",
            "--endpoint",
            &endpoint,
            "--token-file",
            fixture_path(&token),
            "--output",
            fixture_path(&fetched),
        ],
    );
    assert_eq!(
        hex::encode(Sha256::digest(std::fs::read(&fetched).unwrap())),
        receipt.encrypted_archive_sha256
    );
    let target = temp.path().join("inactive-restore");
    command_ok(
        env!("CARGO_BIN_EXE_wabi-instance-snapshot"),
        &[
            "restore",
            "--input",
            fixture_path(&fetched),
            "--identity-file",
            fixture_path(&identity_file),
            "--target-root",
            fixture_path(&target),
        ],
    );
    assert!(target.join("data/wabidb/live-checkpoint-v1").is_file());
    assert!(target.join("data/wabidb/writer-fenced-v1").is_file());
    assert_eq!(
        std::fs::read(target.join("data/unknown-component")).unwrap(),
        b"retained sidecar"
    );
    let metadata: LiveCheckpointMetadata =
        serde_json::from_slice(&std::fs::read(target.join("live-checkpoint.json")).unwrap())
            .unwrap();
    assert_eq!(metadata.applied_commit_seq, receipt.applied_commit_seq);
    assert!(!metadata.full_instance_ready);
    let restored =
        WdbAdapter::open_with_node_id(&target.join("data/wabidb"), "live-checkpoint-site".into())
            .await
            .unwrap();
    assert!(restored.engine().local_writer_fenced().await);
    let history = restored.list_messages_typed(&channel, 100).await.unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].content, "at checkpoint");
}
