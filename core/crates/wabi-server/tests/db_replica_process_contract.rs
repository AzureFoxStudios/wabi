//! Two-process development WabiDB catch-up, with a fenced passive receiver.
//! Incremental catch-up can copy verified published uploads and an explicit,
//! bounded sidecar set when configured. It still lacks complete state and promotion.

use sha2::Digest;
use std::{
    io::{BufRead, BufReader, Read},
    path::Path,
    process::{Child, Command, Stdio},
    sync::Arc,
    time::Duration,
};
use wabi_server::replication_transport::ReqwestTransport;
use wabi_server::upload_registry::{UploadKind, UploadRegistry};
use wabidb::{
    crypto::bootstrap::BootstrapSource,
    engine::{WabiDbConfig, WabiDbEngine},
    format::record::RecordKind,
    projections::{community_roster as roster_projection, upload_assets as asset_projection},
    replication::{config::ReplicationConfig, replica_fingerprint, SyncTransport},
    sequencer::types::{CommandCommit, EventToWrite},
};

const TOKEN: &str = "1234567890abcdef1234567890abcdef";
const KEY: [u8; 32] = [0xAB; 32];

struct Receiver(Child);

#[cfg(unix)]
impl Receiver {
    fn stop_gracefully(mut self) {
        let status = Command::new("kill")
            .args(["-TERM", &self.0.id().to_string()])
            .status()
            .unwrap();
        assert!(status.success(), "send SIGTERM to fenced receiver");
        for _ in 0..100 {
            if let Some(exit) = self.0.try_wait().unwrap() {
                assert!(exit.success(), "fenced receiver shut down cleanly: {exit}");
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        panic!("fenced receiver did not shut down within ten seconds");
    }
}

impl Drop for Receiver {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn private_file(path: &Path, bytes: &[u8]) {
    std::fs::write(path, bytes).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
}

fn snapshot_command(args: &[&str]) -> String {
    let output = Command::new(env!("CARGO_BIN_EXE_wabi-instance-snapshot"))
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "snapshot command failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

fn start_receiver(data: &Path, token: &Path, listen: &str) -> (Receiver, String) {
    start_receiver_with_uploads(data, token, listen, None)
}

fn start_receiver_with_uploads(
    data: &Path,
    token: &Path,
    listen: &str,
    uploads: Option<&Path>,
) -> (Receiver, String) {
    start_receiver_with_instance(data, token, listen, uploads, None)
}

fn start_receiver_with_instance(
    data: &Path,
    token: &Path,
    listen: &str,
    uploads: Option<&Path>,
    instance: Option<&Path>,
) -> (Receiver, String) {
    let mut command = Command::new(env!("CARGO_BIN_EXE_wabi-db-replica-dev"));
    command.args([
        "--data-dir",
        data.to_str().unwrap(),
        "--token-file",
        token.to_str().unwrap(),
        "--listen",
        listen,
        "--experimental-replication",
    ]);
    if let Some(uploads) = uploads {
        command.args(["--uploads-dir", uploads.to_str().unwrap()]);
    }
    if let Some(instance) = instance {
        command.args(["--instance-dir", instance.to_str().unwrap()]);
    }
    let mut child = Receiver(
        command
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let mut line = String::new();
    BufReader::new(child.0.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let address = line
        .trim()
        .strip_prefix("Fenced WabiDB development receiver listening on ")
        .unwrap_or_else(|| {
            let exit = child.0.try_wait().unwrap();
            let mut stderr = String::new();
            if exit.is_some() {
                if let Some(mut stream) = child.0.stderr.take() {
                    let _ = stream.read_to_string(&mut stderr);
                }
            }
            panic!("receiver startup failed: line={line:?}, exit={exit:?}, stderr={stderr}");
        });
    (child, format!("http://{address}"))
}

async fn wait_for_applied(client: &reqwest::Client, endpoint: &str, wanted: u64) {
    for _ in 0..100 {
        if let Ok(response) = client
            .get(format!("{endpoint}/api/v1/sync/status"))
            .header("x-wabi-sync-token", TOKEN)
            .send()
            .await
        {
            if response.status().is_success() {
                let body: serde_json::Value = response.json().await.unwrap();
                if body["appliedCommitSeq"].as_u64() == Some(wanted) {
                    assert_eq!(body["indexedCommitSeq"].as_u64(), Some(wanted));
                    assert_eq!(body["writerFenced"], true);
                    assert_eq!(body["fullInstanceReady"], false);
                    assert_eq!(
                        body["replicaFingerprint"].as_str(),
                        Some(replica_fingerprint(&KEY).as_str())
                    );
                    return;
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("receiver did not apply commit {wanted}");
}

async fn write_event(engine: &WabiDbEngine, payload: &[u8]) -> u64 {
    let (response_tx, _response_rx) = tokio::sync::oneshot::channel();
    engine
        .run_command(CommandCommit {
            room_owner_precondition: None,
            caller_user_id: 1,
            caller_device_id: "regional-device".into(),
            command_name: "regional_probe".into(),
            idempotency_key: None,
            events: vec![EventToWrite {
                stream_id: "channel:regional-probe".into(),
                event_type: "regional_probe_event".into(),
                stream_kind: 1,
                record_kind: RecordKind::Event,
                plaintext: payload.to_vec(),
            }],
            essential: true,
            response_tx,
        })
        .await
        .unwrap()
        .commit_seq
}

#[tokio::test]
async fn fenced_process_refuses_a_push_that_skips_a_committed_entry() {
    std::env::set_var("WABI_SYNC_TOKEN", TOKEN);
    std::env::set_var("WABIDB_EXPERIMENTAL_REPLICATION", "true");
    let temp = tempfile::tempdir().unwrap();
    let source_dir = temp.path().join("source-wabidb");
    let receiver_dir = temp.path().join("receiver-wabidb");
    std::fs::create_dir_all(&receiver_dir).unwrap();
    private_file(
        &receiver_dir.join("root_key"),
        format!("{}\n", hex::encode(KEY)).as_bytes(),
    );
    private_file(&receiver_dir.join("writer-fenced-v1"), b"fenced\n");
    let token_file = temp.path().join("sync-token");
    private_file(&token_file, format!("{TOKEN}\n").as_bytes());

    let mut config = WabiDbConfig::new(source_dir.clone(), BootstrapSource::Provided(KEY));
    config.allow_init = true;
    let source = WabiDbEngine::open(config).await.unwrap();
    source
        .get_or_create_stream_key("channel:regional-probe")
        .await
        .unwrap();
    assert_eq!(write_event(&source, b"first").await, 1);
    assert_eq!(write_event(&source, b"second").await, 2);
    assert_eq!(write_event(&source, b"third").await, 3);
    let entries =
        wabidb::commit_index::batcher::read_all_entries(&source_dir.join("global/commit-index"))
            .unwrap();
    let (_receiver, endpoint) = start_receiver(&receiver_dir, &token_file, "127.0.0.1:0");
    let transport = ReqwestTransport::new(source_dir, replica_fingerprint(&KEY));

    assert!(transport
        .push(&endpoint, vec![entries[0].clone(), entries[2].clone()])
        .await
        .is_err());
    let client = reqwest::Client::new();
    wait_for_applied(&client, &endpoint, 0).await;

    transport.push(&endpoint, entries).await.unwrap();
    wait_for_applied(&client, &endpoint, 3).await;
}

#[tokio::test]
async fn fenced_process_catches_up_after_receiver_restart() {
    std::env::set_var("WABI_SYNC_TOKEN", TOKEN);
    std::env::set_var("WABIDB_EXPERIMENTAL_REPLICATION", "true");
    let temp = tempfile::tempdir().unwrap();
    let source_dir = temp.path().join("source-wabidb");
    let receiver_dir = temp.path().join("receiver-wabidb");
    std::fs::create_dir_all(&source_dir).unwrap();
    std::fs::create_dir_all(&receiver_dir).unwrap();
    private_file(
        &receiver_dir.join("root_key"),
        format!("{}\n", hex::encode(KEY)).as_bytes(),
    );
    private_file(&receiver_dir.join("writer-fenced-v1"), b"fenced\n");
    let token_file = temp.path().join("sync-token");
    private_file(&token_file, format!("{TOKEN}\n").as_bytes());

    let (receiver, endpoint) = start_receiver(&receiver_dir, &token_file, "127.0.0.1:0");
    let client = reqwest::Client::new();
    assert_eq!(
        client
            .get(format!("{endpoint}/api/v1/sync/status"))
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::UNAUTHORIZED
    );
    let wrong = ReqwestTransport::new(source_dir.clone(), "wrong-root".into());
    assert!(wrong.latest_position(&endpoint).await.is_err());

    let transport = Arc::new(ReqwestTransport::new(
        source_dir.clone(),
        replica_fingerprint(&KEY),
    ));
    let mut config = WabiDbConfig::new(source_dir.clone(), BootstrapSource::Provided(KEY));
    config.allow_init = true;
    config.replication_config = Some(ReplicationConfig::new(&endpoint, 100_000, 5_000_000));
    config.sync_transport = Some(transport);
    let source = WabiDbEngine::open(config).await.unwrap();
    source
        .get_or_create_stream_key("channel:regional-probe")
        .await
        .unwrap();
    assert_eq!(write_event(&source, b"first").await, 1);
    assert_eq!(write_event(&source, b"second").await, 2);
    wait_for_applied(&client, &endpoint, 2).await;

    drop(receiver);
    assert_eq!(write_event(&source, b"third").await, 3);
    let (receiver, restarted_endpoint) = start_receiver(
        &receiver_dir,
        &token_file,
        endpoint.strip_prefix("http://").unwrap(),
    );
    assert_eq!(
        restarted_endpoint, endpoint,
        "source currently targets the same receiver URL"
    );
    wait_for_applied(&client, &endpoint, 3).await;
    #[cfg(unix)]
    {
        receiver.stop_gracefully();
        assert!(receiver_dir.join("projections/snapshot.json").is_file());
        assert!(!receiver_dir.join(".lock").exists());
    }
    #[cfg(not(unix))]
    drop(receiver);

    let config = WabiDbConfig::new(receiver_dir, BootstrapSource::Provided(KEY));
    let reopened = WabiDbEngine::open(config).await.unwrap();
    assert!(reopened.durable_writer_fenced());
    assert_eq!(
        reopened
            .projection_state()
            .get("events", b"regional_probe_event"),
        Some(b"third".to_vec())
    );
}

#[tokio::test]
async fn stopped_encrypted_baseline_then_verified_upload_catch_up() {
    std::env::set_var("WABI_SYNC_TOKEN", TOKEN);
    std::env::set_var("WABIDB_EXPERIMENTAL_REPLICATION", "true");
    let temp = tempfile::tempdir().unwrap();
    let source_data = temp.path().join("source-data");
    let source_db = source_data.join("wabidb");
    let source_uploads = temp.path().join("source-uploads");
    std::fs::create_dir_all(&source_db).unwrap();
    std::fs::create_dir(&source_uploads).unwrap();
    private_file(&source_data.join("jwt_secret"), b"disposable-jwt-secret");
    private_file(
        &source_db.join("root_key"),
        format!("{}\n", hex::encode(KEY)).as_bytes(),
    );
    std::fs::write(
        source_data.join("conversation_notes.json"),
        b"baseline notes",
    )
    .unwrap();
    std::fs::write(source_uploads.join("baseline.bin"), b"baseline upload").unwrap();
    let upload_registry = UploadRegistry::new_persistent(&source_data).unwrap();
    upload_registry
        .record(
            "baseline.bin",
            "baseline.bin",
            None,
            Some(1),
            UploadKind::Attachment,
            b"baseline upload".len() as u64,
        )
        .await
        .unwrap();

    let mut initial_config = WabiDbConfig::new(source_db.clone(), BootstrapSource::Provided(KEY));
    initial_config.allow_init = true;
    let initial = WabiDbEngine::open(initial_config).await.unwrap();
    initial
        .get_or_create_stream_key("channel:regional-probe")
        .await
        .unwrap();
    assert_eq!(write_event(&initial, b"baseline").await, 1);
    drop(initial);

    let identity = temp.path().join("recovery.agekey");
    let keygen_output =
        snapshot_command(&["keygen", "--identity-file", identity.to_str().unwrap()]);
    let recipient = keygen_output
        .lines()
        .find_map(|line| line.strip_prefix("Recipient: "))
        .expect("snapshot recipient");
    let archive = temp.path().join("baseline.age");
    snapshot_command(&[
        "export",
        "--data-dir",
        source_data.to_str().unwrap(),
        "--uploads-dir",
        source_uploads.to_str().unwrap(),
        "--recipient",
        recipient,
        "--output",
        archive.to_str().unwrap(),
    ]);
    let passive = temp.path().join("passive");
    snapshot_command(&[
        "restore",
        "--input",
        archive.to_str().unwrap(),
        "--identity-file",
        identity.to_str().unwrap(),
        "--target-root",
        passive.to_str().unwrap(),
        "--passive-replica",
    ]);
    assert_eq!(
        std::fs::read(passive.join("uploads/baseline.bin")).unwrap(),
        b"baseline upload"
    );
    assert_eq!(
        std::fs::read(passive.join("data/conversation_notes.json")).unwrap(),
        b"baseline notes"
    );
    assert!(passive.join("data/wabidb/writer-fenced-v1").is_file());

    let token_file = temp.path().join("sync-token");
    private_file(&token_file, format!("{TOKEN}\n").as_bytes());
    let passive_db = passive.join("data/wabidb");
    let passive_uploads = passive.join("uploads");
    let (receiver, endpoint) = start_receiver_with_instance(
        &passive_db,
        &token_file,
        "127.0.0.1:0",
        Some(&passive_uploads),
        Some(&passive.join("data")),
    );
    let client = reqwest::Client::new();
    wait_for_applied(&client, &endpoint, 1).await;
    let status: serde_json::Value = client
        .get(format!("{endpoint}/api/v1/sync/status"))
        .header("x-wabi-sync-token", TOKEN)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(status["uploadCopyEnabled"], true);
    assert_eq!(status["sidecarCopyEnabled"], true);
    assert_eq!(status["fullInstanceReady"], false);
    assert_eq!(
        client
            .get(format!("{endpoint}/api/v1/sync/sidecars"))
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        client
            .put(format!("{endpoint}/api/v1/sync/sidecars/unknown.json"))
            .header("x-wabi-sync-token", TOKEN)
            .header("x-wabi-sha256", hex::encode(sha2::Sha256::digest(b"bad")))
            .body("bad")
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::BAD_REQUEST
    );
    assert_eq!(
        client
            .put(format!(
                "{endpoint}/api/v1/sync/sidecars/conversation_notes.json"
            ))
            .header("x-wabi-sync-token", TOKEN)
            .header("x-wabi-sha256", hex::encode([0u8; 32]))
            .body("bad")
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::BAD_REQUEST
    );
    #[cfg(unix)]
    {
        let outside = temp.path().join("outside-sidecar");
        private_file(&outside, b"untouched");
        let link = passive.join("data/admin_policies.json");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        assert_eq!(
            client
                .get(format!("{endpoint}/api/v1/sync/sidecars"))
                .header("x-wabi-sync-token", TOKEN)
                .send()
                .await
                .unwrap()
                .status(),
            reqwest::StatusCode::CONFLICT
        );
        assert_eq!(
            client
                .delete(format!(
                    "{endpoint}/api/v1/sync/sidecars/admin_policies.json"
                ))
                .header("x-wabi-sync-token", TOKEN)
                .send()
                .await
                .unwrap()
                .status(),
            reqwest::StatusCode::CONFLICT
        );
        assert_eq!(std::fs::read(&outside).unwrap(), b"untouched");
        std::fs::remove_file(link).unwrap();
    }

    let mut source_config = WabiDbConfig::new(source_db, BootstrapSource::Provided(KEY));
    source_config.replication_config = Some(ReplicationConfig::new(&endpoint, 100_000, 5_000_000));
    source_config.sync_transport = Some(Arc::new(
        ReqwestTransport::new(source_data.join("wabidb"), replica_fingerprint(&KEY))
            .with_uploads_dir(source_uploads.clone())
            .with_instance_dir(source_data.clone()),
    ));
    let source = WabiDbEngine::open(source_config).await.unwrap();
    assert_eq!(write_event(&source, b"after-baseline").await, 2);
    wait_for_applied(&client, &endpoint, 2).await;

    source
        .get_or_create_stream_key("community-roster:v1")
        .await
        .unwrap();
    let roster = serde_json::json!({
        "schemaVersion": 1,
        "version": 1,
        "entries": [{"nodeId":"new","role":"authority","url":"https://new.example"}]
    });
    let (response_tx, _response_rx) = tokio::sync::oneshot::channel();
    let roster_commit = source
        .run_command(CommandCommit {
            room_owner_precondition: None,
            caller_user_id: 1,
            caller_device_id: "primary".into(),
            command_name: roster_projection::EVENT.into(),
            idempotency_key: None,
            events: vec![EventToWrite {
                stream_id: "community-roster:v1".into(),
                event_type: roster_projection::EVENT.into(),
                stream_kind: 6,
                record_kind: RecordKind::Event,
                plaintext: serde_json::to_vec(&roster).unwrap(),
            }],
            essential: true,
            response_tx,
        })
        .await
        .unwrap();
    assert_eq!(roster_commit.commit_seq, 3);
    wait_for_applied(&client, &endpoint, 3).await;

    assert!(upload_registry
        .revoke_canonical("baseline.bin", &source, 1)
        .await
        .unwrap());
    wait_for_applied(&client, &endpoint, 4).await;
    for _ in 0..150 {
        if !passive_uploads.join("baseline.bin").exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(
        !passive_uploads.join("baseline.bin").exists(),
        "revoked baseline bytes remain on the passive receiver"
    );
    let mut pruned_through = 0;
    for _ in 0..150 {
        let status: serde_json::Value = client
            .get(format!("{endpoint}/api/v1/sync/status"))
            .header("x-wabi-sync-token", TOKEN)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        pruned_through = status["uploadPrunedThroughCommitSeq"].as_u64().unwrap();
        if pruned_through >= 4 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(pruned_through >= 4);

    let later_bytes = vec![0x5a; 2 * 1024 * 1024 + 3];
    upload_registry
        .publish_bytes(
            &source_uploads,
            &source,
            "later.bin",
            "later.bin",
            None,
            None,
            Some(1),
            UploadKind::Attachment,
            &later_bytes,
        )
        .await
        .unwrap();
    wait_for_applied(&client, &endpoint, 5).await;
    for _ in 0..150 {
        if std::fs::metadata(passive_uploads.join("later.bin"))
            .is_ok_and(|metadata| metadata.len() == later_bytes.len() as u64)
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(
        std::fs::read(passive_uploads.join("later.bin")).unwrap(),
        later_bytes
    );

    // A registered file from the old upload path can join the same
    // publication/copy stream through an explicit backfill after baseline.
    let legacy_bytes = b"registered before publication records";
    std::fs::write(source_uploads.join("legacy-after.bin"), legacy_bytes).unwrap();
    upload_registry
        .record(
            "legacy-after.bin",
            "legacy-original.bin",
            None,
            Some(1),
            UploadKind::Attachment,
            legacy_bytes.len() as u64,
        )
        .await
        .unwrap();
    let backfilled = upload_registry
        .backfill_legacy_assets(&source_uploads, &source, 100, true)
        .await
        .unwrap();
    assert_eq!(backfilled.committed, 1);
    wait_for_applied(&client, &endpoint, 6).await;
    for _ in 0..150 {
        if std::fs::read(passive_uploads.join("legacy-after.bin"))
            .is_ok_and(|bytes| bytes == legacy_bytes)
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(
        std::fs::read(passive_uploads.join("legacy-after.bin")).unwrap(),
        legacy_bytes
    );
    std::fs::write(source_data.join("conversation_notes.json"), b"later notes").unwrap();
    for _ in 0..150 {
        if std::fs::read(passive.join("data/conversation_notes.json"))
            .is_ok_and(|bytes| bytes == b"later notes")
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(
        std::fs::read(passive.join("data/conversation_notes.json")).unwrap(),
        b"later notes"
    );
    std::fs::remove_file(source_data.join("conversation_notes.json")).unwrap();
    for _ in 0..150 {
        if !passive.join("data/conversation_notes.json").exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(!passive.join("data/conversation_notes.json").exists());
    drop(receiver);
    // Startup also removes a revoked file found in a restored passive tree.
    std::fs::write(passive_uploads.join("baseline.bin"), b"stale private copy").unwrap();
    let (restarted, restarted_endpoint) = start_receiver_with_instance(
        &passive_db,
        &token_file,
        endpoint.strip_prefix("http://").unwrap(),
        Some(&passive_uploads),
        Some(&passive.join("data")),
    );
    assert_eq!(restarted_endpoint, endpoint);
    assert!(!passive_uploads.join("baseline.bin").exists());
    drop(restarted);
    let reopened = WabiDbEngine::open(WabiDbConfig::new(
        passive_db,
        BootstrapSource::Provided(KEY),
    ))
    .await
    .unwrap();
    assert!(reopened.durable_writer_fenced());
    assert_eq!(
        reopened
            .projection_state()
            .get("events", b"regional_probe_event"),
        Some(b"after-baseline".to_vec())
    );
    let recovered_roster = reopened
        .projection_state()
        .get(roster_projection::INDEX, roster_projection::KEY)
        .unwrap();
    let recovered_roster = roster_projection::decode(&recovered_roster).unwrap();
    assert_eq!(recovered_roster.version, 1);
    assert_eq!(recovered_roster.entries[0].url, "https://new.example");
    let recovered_asset = reopened
        .projection_state()
        .get(asset_projection::INDEX, b"later.bin")
        .unwrap();
    let recovered_asset = asset_projection::decode(&recovered_asset).unwrap();
    assert_eq!(recovered_asset.size, (2 * 1024 * 1024 + 3) as u64);
    assert_eq!(
        recovered_asset.sha256,
        hex::encode(sha2::Sha256::digest(&later_bytes))
    );
    let recovered_legacy = reopened
        .projection_state()
        .get(asset_projection::INDEX, b"legacy-after.bin")
        .unwrap();
    assert_eq!(
        asset_projection::decode(&recovered_legacy)
            .unwrap()
            .original_name,
        "legacy-original.bin"
    );
    let restored_registry = UploadRegistry::new_persistent(passive.join("data")).unwrap();
    assert!(restored_registry.is_revoked("baseline.bin").await);
    restored_registry
        .reconcile_revocations(&reopened)
        .await
        .unwrap();
    assert!(restored_registry.is_revoked("baseline.bin").await);
    assert!(
        UploadRegistry::new_persistent(passive.join("data"))
            .unwrap()
            .is_revoked("baseline.bin")
            .await
    );
    assert_eq!(
        restored_registry
            .reconcile_published_assets(&passive_uploads, &reopened)
            .await
            .unwrap(),
        0
    );
    assert!(restored_registry.get("legacy-after.bin").await.is_some());
}

#[tokio::test]
async fn fenced_upload_endpoint_resumes_and_rejects_wrong_bytes() {
    std::env::set_var("WABI_SYNC_TOKEN", TOKEN);
    std::env::set_var("WABIDB_EXPERIMENTAL_REPLICATION", "true");
    let temp = tempfile::tempdir().unwrap();
    let source_data = temp.path().join("source-data");
    let source_db = source_data.join("wabidb");
    let source_uploads = temp.path().join("source-uploads");
    let receiver_db = temp.path().join("receiver-wabidb");
    let receiver_uploads = temp.path().join("receiver-uploads");
    std::fs::create_dir_all(&receiver_db).unwrap();
    std::fs::create_dir(&receiver_uploads).unwrap();
    private_file(
        &receiver_db.join("root_key"),
        format!("{}\n", hex::encode(KEY)).as_bytes(),
    );
    private_file(&receiver_db.join("writer-fenced-v1"), b"fenced\n");
    let token_file = temp.path().join("sync-token");
    private_file(&token_file, format!("{TOKEN}\n").as_bytes());

    let mut source_config = WabiDbConfig::new(source_db.clone(), BootstrapSource::Provided(KEY));
    source_config.allow_init = true;
    let source = WabiDbEngine::open(source_config).await.unwrap();
    let registry = UploadRegistry::new_persistent(&source_data).unwrap();
    registry
        .publish_bytes(
            &source_uploads,
            &source,
            "restart.bin",
            "restart.bin",
            None,
            None,
            Some(1),
            UploadKind::Attachment,
            b"abcde",
        )
        .await
        .unwrap();
    let entries =
        wabidb::commit_index::batcher::read_all_entries(&source_db.join("global/commit-index"))
            .unwrap();
    let (receiver, endpoint) = start_receiver_with_uploads(
        &receiver_db,
        &token_file,
        "127.0.0.1:0",
        Some(&receiver_uploads),
    );
    let transport = ReqwestTransport::new(source_db.clone(), replica_fingerprint(&KEY));
    transport.push(&endpoint, entries).await.unwrap();
    let client = reqwest::Client::new();
    let asset_url = format!("{endpoint}/api/v1/sync/assets/restart.bin");
    let missing_url = format!("{endpoint}/api/v1/sync/assets/missing");
    assert_eq!(
        client
            .put(&asset_url)
            .query(&[("offset", 0)])
            .body("abcde")
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        client
            .put(&asset_url)
            .header("x-wabi-sync-token", TOKEN)
            .query(&[("offset", 0)])
            .body(vec![0_u8; 1024 * 1024 + 1])
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::PAYLOAD_TOO_LARGE
    );
    assert_eq!(
        client
            .put(&asset_url)
            .header("x-wabi-sync-token", TOKEN)
            .query(&[("offset", 1)])
            .body("ab")
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::CONFLICT
    );
    assert_eq!(
        client
            .put(&asset_url)
            .header("x-wabi-sync-token", TOKEN)
            .query(&[("offset", 0)])
            .body("ab")
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::OK
    );
    drop(receiver);
    let (_receiver, restarted_endpoint) = start_receiver_with_uploads(
        &receiver_db,
        &token_file,
        endpoint.strip_prefix("http://").unwrap(),
        Some(&receiver_uploads),
    );
    assert_eq!(restarted_endpoint, endpoint);
    // Do not reuse a pooled connection to the receiver process we just killed.
    let client = reqwest::Client::new();
    let inventory: serde_json::Value = client
        .get(&missing_url)
        .header("x-wabi-sync-token", TOKEN)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(inventory["entries"][0]["offset"], 2);
    assert_eq!(
        client
            .put(&asset_url)
            .header("x-wabi-sync-token", TOKEN)
            .query(&[("offset", 2)])
            .body("xxx")
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::CONFLICT
    );
    assert!(!receiver_uploads.join("restart.bin").exists());
    let inventory: serde_json::Value = client
        .get(&missing_url)
        .header("x-wabi-sync-token", TOKEN)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(inventory["entries"][0]["offset"], 0);
    assert_eq!(
        client
            .put(&asset_url)
            .header("x-wabi-sync-token", TOKEN)
            .query(&[("offset", 0)])
            .body("abcde")
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::OK
    );
    assert_eq!(
        std::fs::read(receiver_uploads.join("restart.bin")).unwrap(),
        b"abcde"
    );

    registry
        .publish_bytes(
            &source_uploads,
            &source,
            "staged-revoke.bin",
            "staged-revoke.bin",
            None,
            None,
            Some(1),
            UploadKind::Attachment,
            b"hide",
        )
        .await
        .unwrap();
    let entries =
        wabidb::commit_index::batcher::read_all_entries(&source_db.join("global/commit-index"))
            .unwrap()
            .into_iter()
            .filter(|entry| entry.commit_seq > 1)
            .collect();
    transport.push(&endpoint, entries).await.unwrap();
    let staged_url = format!("{endpoint}/api/v1/sync/assets/staged-revoke.bin");
    assert_eq!(
        client
            .put(&staged_url)
            .header("x-wabi-sync-token", TOKEN)
            .query(&[("offset", 0)])
            .body("hi")
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::OK
    );
    let staged_path = receiver_uploads.join(".replica/staged-revoke.bin.part");
    assert!(staged_path.exists());
    registry
        .revoke_canonical("staged-revoke.bin", &source, 1)
        .await
        .unwrap();
    let entries =
        wabidb::commit_index::batcher::read_all_entries(&source_db.join("global/commit-index"))
            .unwrap()
            .into_iter()
            .filter(|entry| entry.commit_seq > 2)
            .collect();
    transport.push(&endpoint, entries).await.unwrap();
    assert_eq!(
        client
            .get(&missing_url)
            .header("x-wabi-sync-token", TOKEN)
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::OK
    );
    assert!(!staged_path.exists());
    assert_eq!(
        client
            .put(&staged_url)
            .header("x-wabi-sync-token", TOKEN)
            .query(&[("offset", 2)])
            .body("de")
            .send()
            .await
            .unwrap()
            .status(),
        reqwest::StatusCode::GONE
    );
}

#[tokio::test]
async fn same_root_key_with_divergent_commit_prefix_does_not_catch_up() {
    std::env::set_var("WABI_SYNC_TOKEN", TOKEN);
    std::env::set_var("WABIDB_EXPERIMENTAL_REPLICATION", "true");
    let temp = tempfile::tempdir().unwrap();
    let source_db = temp.path().join("source-wabidb");
    let receiver_db = temp.path().join("receiver-wabidb");
    std::fs::create_dir_all(&source_db).unwrap();
    std::fs::create_dir_all(&receiver_db).unwrap();
    private_file(
        &receiver_db.join("root_key"),
        format!("{}\n", hex::encode(KEY)).as_bytes(),
    );

    for (data_dir, payload) in [
        (source_db.as_path(), b"source-baseline".as_slice()),
        (receiver_db.as_path(), b"other-baseline".as_slice()),
    ] {
        let mut config = WabiDbConfig::new(data_dir.to_path_buf(), BootstrapSource::Provided(KEY));
        config.allow_init = true;
        let engine = WabiDbEngine::open(config).await.unwrap();
        engine
            .get_or_create_stream_key("channel:regional-probe")
            .await
            .unwrap();
        assert_eq!(write_event(&engine, payload).await, 1);
    }
    private_file(&receiver_db.join("writer-fenced-v1"), b"fenced\n");
    let token_file = temp.path().join("sync-token");
    private_file(&token_file, format!("{TOKEN}\n").as_bytes());
    let (receiver, endpoint) = start_receiver(&receiver_db, &token_file, "127.0.0.1:0");
    let client = reqwest::Client::new();
    wait_for_applied(&client, &endpoint, 1).await;

    let position = ReqwestTransport::new(source_db.clone(), replica_fingerprint(&KEY))
        .latest_position(&endpoint)
        .await
        .unwrap();
    let source_entries =
        wabidb::commit_index::batcher::read_all_entries(&source_db.join("global/commit-index"))
            .unwrap();
    assert_ne!(
        position.prefix_fingerprint,
        wabidb::replication::commit_prefix_fingerprint(&source_entries, 1)
    );

    let mut config = WabiDbConfig::new(source_db.clone(), BootstrapSource::Provided(KEY));
    config.replication_config = Some(ReplicationConfig::new(&endpoint, 50_000, 5_000_000));
    config.sync_transport = Some(Arc::new(ReqwestTransport::new(
        source_db,
        replica_fingerprint(&KEY),
    )));
    let source = WabiDbEngine::open(config).await.unwrap();
    assert_eq!(write_event(&source, b"must-not-cross").await, 2);
    tokio::time::sleep(Duration::from_millis(350)).await;
    let body: serde_json::Value = client
        .get(format!("{endpoint}/api/v1/sync/status"))
        .header("x-wabi-sync-token", TOKEN)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(body["appliedCommitSeq"], 1);
    drop(receiver);
}
