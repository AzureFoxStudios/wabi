//! Running Authority checkpoint controls, isolation, ownership and restart receipts.
use age::secrecy::ExposeSecret;
use axum::{
    body::{to_bytes, Body},
    extract::ConnectInfo,
    http::{Request, StatusCode},
    Router,
};
use serde_json::{json, Value};
use std::{
    net::SocketAddr,
    path::Path,
    sync::{Arc, Once},
    time::Duration,
};
use tower::ServiceExt;
use wabi_server::{
    adapter::WdbAdapter,
    app_router::build_app_router,
    checkpoint_jobs::{CheckpointJobs, CheckpointPhase, CheckpointPolicy},
    config::{LoreAddonConfig, ServerConfig, ServerRole},
    instance_archive::{restore_inactive, LiveExportLimits},
    state::AppState,
};
use wabidb::{
    domain::{ChannelKind, MemberRole},
    engine::wabi_store::WabiStore,
};

const SECRET: &str = "isolated-checkpoint-contract-operator-secret";
#[cfg(target_os = "linux")]
#[path = "fixtures/checkpoint_field_export.rs"]
mod checkpoint_field_export;
#[cfg(target_os = "linux")]
#[path = "fixtures/checkpoint_peer_verify.rs"]
mod checkpoint_peer_verify;
#[cfg(target_os = "linux")]
#[path = "fixtures/checkpoint_rpc.rs"]
mod checkpoint_rpc;
#[path = "fixtures/writer_drain.rs"]
mod writer_drain;
fn config(root: &Path) -> ServerConfig {
    assert!(std::env::var_os("WABIDB_ROOT_KEY").is_none());
    assert!(std::env::var_os("WABI_CHECKPOINT_DIR").is_none());
    static INIT: Once = Once::new();
    INIT.call_once(|| std::env::set_var("WABI_OPERATOR_SECRET", SECRET));
    std::fs::create_dir_all(root.join("uploads")).unwrap();
    let data = root.join("data");
    ServerConfig {
        host: "127.0.0.1".into(),
        port: 0,
        data_dir: data.to_string_lossy().into(),
        uploads_dir: root.join("uploads").to_string_lossy().into(),
        jwt_secret: "isolated-checkpoint-contract-active-key".into(),
        turn_enabled: false,
        turn_uri: None,
        turn_secret: None,
        node_id: "checkpoint-control-fixture".into(),
        is_primary: true,
        server_role: ServerRole::Authority,
        authority_url: None,
        admin_user_ids: vec![],
        blacklist_file: data.join("blacklist.txt").to_string_lossy().into(),
        max_body_size: None,
        mesh_enabled: false,
        mesh_peers: vec![],
        lore: LoreAddonConfig::default(),
    }
}
fn policy(root: &Path, recipient: String) -> CheckpointPolicy {
    let directory = root.join("checkpoints");
    std::fs::create_dir(&directory).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    CheckpointPolicy {
        directory,
        recipient,
        drain_timeout: Duration::from_secs(2),
        export_limits: LiveExportLimits {
            max_entries: 10_000,
            max_plaintext_bytes: 32 * 1024 * 1024,
            max_inventory_path_bytes: 1024 * 1024,
            copy_timeout: Duration::from_secs(10),
        },
        max_stored_bytes: 128 * 1024 * 1024,
        min_free_bytes: 64 * 1024 * 1024,
    }
}
async fn call(app: &Router, method: &str, peer: &str, secret: Option<&str>) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri("/api/operator/checkpoints/")
        .header("content-type", "application/json");
    if let Some(secret) = secret {
        request = request.header("x-operator-secret", secret);
    }
    let mut request = request.body(Body::from("{}")).unwrap();
    request
        .extensions_mut()
        .insert(ConnectInfo(peer.parse::<SocketAddr>().unwrap()));
    let response = tokio::time::timeout(Duration::from_secs(2), app.clone().oneshot(request))
        .await
        .expect("checkpoint control must not wait for admission")
        .unwrap();
    let status = response.status();
    let cache = response.headers().get("cache-control").cloned();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    let body =
        serde_json::from_slice(&bytes).unwrap_or(json!({"plain": String::from_utf8_lossy(&bytes)}));
    assert_eq!(
        cache.as_ref().map(|value| value.to_str().unwrap()),
        Some("no-store, private"),
        "status={status}, body={body}"
    );
    (status, body)
}
async fn finished(state: &AppState) -> wabi_server::checkpoint_jobs::CheckpointJob {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let status = state.checkpoint_jobs.status();
            if status.active_job_id.is_none() {
                return status.jobs.last().unwrap().clone();
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn full_router_requires_loopback_and_secret_and_keeps_control_reachable_during_pause() {
    let temp = tempfile::tempdir().unwrap();
    let state = Arc::new(AppState::new(config(temp.path())).await.unwrap());
    let app = build_app_router(state.clone());
    for method in ["GET", "POST"] {
        assert_eq!(
            call(&app, method, "127.0.0.1:33001", None).await.0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            call(&app, method, "127.0.0.1:33001", Some("wrong")).await.0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            call(&app, method, "100.87.255.66:33001", Some(SECRET))
                .await
                .0,
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(
        call(&app, "POST", "127.0.0.1:33001", Some(SECRET)).await.0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    let pause = state.instance_operations.quiesce().await.unwrap();
    let (status, body) = call(&app, "GET", "127.0.0.1:33001", Some(SECRET)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["enabled"], false);
    assert_eq!(body["fullInstanceReady"], false);
    drop(pause);
}

#[tokio::test]
async fn accepted_owned_job_drains_without_deadlock_restores_state_and_retains_safe_receipt() {
    let temp = tempfile::tempdir().unwrap();
    let mut app_state = AppState::new(config(temp.path())).await.unwrap();
    let key = age::x25519::Identity::generate();
    let identity = temp.path().join("identity.txt");
    std::fs::write(&identity, key.to_string().expose_secret()).unwrap();
    let policy = policy(temp.path(), key.to_public().to_string());
    app_state.checkpoint_jobs =
        CheckpointJobs::open(Some(policy.clone()), &app_state.config).unwrap();
    let state = Arc::new(app_state);
    let user = state
        .wdb
        .create_user("fixture_owner", None, "fixture-hash")
        .await
        .unwrap();
    state
        .claim_ownership(user as i64, "fixture_owner")
        .await
        .unwrap();
    let channel = state
        .wdb
        .create_channel("Fixture", ChannelKind::Text, user, false)
        .await
        .unwrap();
    state
        .wdb
        .add_channel_member(&channel, user, MemberRole::Owner)
        .await
        .unwrap();
    let first = state
        .wdb
        .send_message(&channel, user, "before snapshot", false, &[])
        .await
        .unwrap();
    let app = build_app_router(state.clone());
    let held = state.instance_operations.quiesce().await.unwrap();
    let (status, accepted) = call(&app, "POST", "127.0.0.1:33002", Some(SECRET)).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(
        call(&app, "POST", "127.0.0.1:33002", Some(SECRET)).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(&app, "GET", "127.0.0.1:33002", Some(SECRET)).await.0,
        StatusCode::OK
    );
    // The initiating request is already gone; the job remains owned and waiting.
    assert!(state.checkpoint_jobs.status().active_job_id.is_some());
    drop(held);
    let job = finished(&state).await;
    assert_eq!(job.id, accepted["id"]);
    assert_eq!(
        job.phase,
        CheckpointPhase::Ready,
        "failure code: {:?}",
        job.failure_code
    );
    let receipt = job.receipt.as_ref().unwrap();
    assert!(!receipt.full_instance_ready);
    let status = serde_json::to_string(&state.checkpoint_jobs.status()).unwrap();
    assert!(!status.contains(&state.config.jwt_secret));
    assert!(!status.contains("serverConfig"));
    assert!(!status.contains("bootstrapFingerprint"));
    let restored_manager = CheckpointJobs::open(Some(policy.clone()), &state.config).unwrap();
    assert_eq!(
        restored_manager
            .status()
            .jobs
            .last()
            .unwrap()
            .receipt
            .as_ref()
            .unwrap()
            .encrypted_archive_sha256,
        receipt.encrypted_archive_sha256
    );
    assert!(restored_manager.status().active_job_id.is_none());
    let target = temp.path().join("inactive");
    restore_inactive(
        &policy.directory.join(format!("{}.age", job.id)),
        &identity,
        &target,
    )
    .unwrap();
    assert!(!target.join("data/.wabi-secret-publication.lock").exists());
    assert!(!target
        .join("data/wabidb/.wabi-secret-publication.lock")
        .exists());
    let replica = WdbAdapter::open_with_node_id(
        &target.join("data/wabidb"),
        "checkpoint-control-fixture".into(),
    )
    .await
    .unwrap();
    assert!(replica.get_user(user).await.unwrap().is_some());
    assert!(replica.get_message(&first).await.unwrap().is_some());
    assert!(replica
        .send_message(&channel, user, "must be fenced", false, &[])
        .await
        .is_err());
    state
        .wdb
        .send_message(&channel, user, "after snapshot", false, &[])
        .await
        .unwrap();
    assert!(state.instance_operations.healthy_for_checkpoint());
    assert!(std::fs::read_dir(&policy.directory)
        .unwrap()
        .all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with('.')));
    let archive = policy.directory.join(format!("{}.age", job.id));
    let mut damaged = std::fs::read(&archive).unwrap();
    let last = damaged.len() - 1;
    damaged[last] ^= 1;
    std::fs::write(&archive, damaged).unwrap();
    let damaged_manager = CheckpointJobs::open(Some(policy), &state.config).unwrap();
    assert_eq!(
        damaged_manager.status().jobs.last().unwrap().phase,
        CheckpointPhase::Failed
    );
    assert_eq!(
        damaged_manager
            .status()
            .jobs
            .last()
            .unwrap()
            .failure_code
            .as_deref(),
        Some("recorded_archive_unavailable")
    );
}

#[tokio::test]
async fn bounded_failure_releases_job_and_restart_marks_interrupted_jobs_without_promotion() {
    let temp = tempfile::tempdir().unwrap();
    let mut state = AppState::new(config(temp.path())).await.unwrap();
    let key = age::x25519::Identity::generate();
    let mut policy = policy(temp.path(), key.to_public().to_string());
    policy.drain_timeout = Duration::from_millis(20);
    state.checkpoint_jobs = CheckpointJobs::open(Some(policy.clone()), &state.config).unwrap();
    let state = Arc::new(state);
    let held = state.instance_operations.quiesce().await.unwrap();
    state.checkpoint_jobs.start(state.clone()).unwrap();
    let job = finished(&state).await;
    assert_eq!(job.phase, CheckpointPhase::Failed);
    assert_eq!(job.failure_code.as_deref(), Some("checkpoint_drain_failed"));
    drop(held);
    assert!(state.instance_operations.healthy_for_checkpoint());
    let mut record = serde_json::to_value(&job).unwrap();
    record["phase"] = json!("copying");
    record["finishedAtUnixMs"] = Value::Null;
    std::fs::write(
        policy.directory.join(format!("{}.json", job.id)),
        serde_json::to_vec(&record).unwrap(),
    )
    .unwrap();
    let reopened = CheckpointJobs::open(Some(policy.clone()), &state.config).unwrap();
    assert_eq!(
        reopened.status().jobs[0].failure_code.as_deref(),
        Some("process_interrupted")
    );
    assert!(reopened.status().active_job_id.is_none());
    assert!(!reopened.status().full_instance_ready);
    policy.max_stored_bytes = 1;
    let denied = CheckpointJobs::open(Some(policy), &state.config).unwrap();
    denied.start(state.clone()).unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while denied.status().active_job_id.is_some() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        denied.status().jobs.last().unwrap().failure_code.as_deref(),
        Some("storage_budget_failed")
    );
    assert_eq!(
        std::fs::read_dir(temp.path().join("checkpoints"))
            .unwrap()
            .count(),
        1,
        "a refused storage reservation must not allocate another disk record"
    );
}

async fn context_call(
    app: &Router,
    id: &str,
    peer: &str,
    headers: &[(&str, &str)],
) -> (StatusCode, Value) {
    let mut request =
        Request::builder().uri(format!("/api/operator/checkpoints/{id}/source-context"));
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let mut request = request.body(Body::empty()).unwrap();
    request
        .extensions_mut()
        .insert(ConnectInfo(peer.parse::<SocketAddr>().unwrap()));
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    assert_eq!(response.headers()["cache-control"], "no-store, private");
    let bytes = to_bytes(response.into_body(), 32 * 1024).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(json!({"plain":String::from_utf8_lossy(&bytes)})),
    )
}
#[cfg(target_os = "linux")]
#[tokio::test]
async fn signed_source_route_uses_actual_capture_and_preserves_old_schemas_after_restart() {
    signed_source_capture(None).await;
}

/// Explicit disposable field export. Only encrypted bytes and signed public
/// metadata leave this fixture; its decryption identity stays in its TempDir.
#[cfg(target_os = "linux")]
#[tokio::test]
#[ignore = "requires an exclusive private field-export directory and owner token"]
async fn physical_checkpoint_ciphertext_export() {
    let output = checkpoint_field_export::Output::from_environment();
    signed_source_capture(Some(&output)).await;
    output.completed();
}

#[cfg(target_os = "linux")]
async fn signed_source_capture(export: Option<&checkpoint_field_export::Output>) {
    let temp = tempfile::tempdir().unwrap();
    let mut initial = AppState::new(config(temp.path())).await.unwrap();
    let key = age::x25519::Identity::generate();
    let policy = policy(temp.path(), key.to_public().to_string());
    initial.checkpoint_jobs =
        CheckpointJobs::open_with_source_context(Some(policy.clone()), &initial.config, true)
            .unwrap();
    let state = Arc::new(initial);
    let user = state
        .wdb
        .create_user("signed_source_owner", None, "fixture-hash")
        .await
        .unwrap();
    state
        .claim_ownership(user as i64, "signed_source_owner")
        .await
        .unwrap();
    // Disposable registered upload forces real ciphertext to cross several
    // 64 KiB boundaries. Use the real durable publisher, not an orphan file.
    // This is not browser/upload-API acceptance.
    let mut seed = 0x7a41_0933_28ee_102bu64;
    let payload: Vec<u8> = (0..160 * 1024)
        .map(|_| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed as u8
        })
        .collect();
    state
        .upload_registry
        .publish_bytes(
            Path::new(&state.config.uploads_dir),
            state.wdb.engine(),
            "checkpoint-byte-fixture.bin",
            "checkpoint-byte-fixture.bin",
            None,
            None,
            Some(user as i64),
            wabi_server::upload_registry::UploadKind::Other,
            &payload,
        )
        .await
        .unwrap();
    // Full Socket.IO setup retains background state. Use the actual operator
    // routes for capture so every owner can drop before reopening this WDB.
    let app = wabi_server::checkpoint_jobs::routes().with_state(state.clone());
    state.checkpoint_jobs.start(state.clone()).unwrap();
    let job = finished(&state).await;
    assert_eq!(job.phase, CheckpointPhase::Ready, "{:?}", job.failure_code);
    let (status, body) = context_call(
        &app,
        &job.id,
        "127.0.0.1:32001",
        &[("x-operator-secret", SECRET)],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let signed: wabi_consensus::source_context::SignedSourceContext =
        serde_json::from_value(body.clone()).unwrap();
    let verified = signed
        .verify(state.community_roster.community_id(), &state.config.node_id)
        .unwrap();
    let receipt = job.receipt.as_ref().unwrap();
    assert_eq!(
        verified.claims().archive_sha256,
        receipt.encrypted_archive_sha256
    );
    assert_eq!(verified.claims().inventory_sha256, receipt.inventory_sha256);
    assert_eq!(
        verified.claims().applied_commit_seq,
        receipt.applied_commit_seq
    );
    assert_eq!(
        verified.claims().commit_prefix_fingerprint,
        receipt.commit_prefix_fingerprint
    );
    assert_eq!(
        verified.claims().bootstrap_fingerprint,
        state.wdb.engine().replica_fingerprint()
    );
    assert_eq!(body["claims"]["allocation"], json!({"kind":"unknown"}));
    for private in [
        &state.config.jwt_secret,
        &state.config.data_dir,
        &state.config.uploads_dir,
    ] {
        assert!(!body.to_string().contains(private));
    }
    let job_json = serde_json::to_value(&job).unwrap();
    assert_eq!(job_json.as_object().unwrap().len(), 7);
    assert_eq!(
        serde_json::to_value(receipt)
            .unwrap()
            .as_object()
            .unwrap()
            .len(),
        10
    );
    let reopened =
        CheckpointJobs::open_with_source_context(Some(policy.clone()), &state.config, true)
            .unwrap();
    assert_eq!(reopened.status().jobs.len(), 1);
    assert_eq!(reopened.status().jobs[0].phase, CheckpointPhase::Ready);
    // Independently decrypt this exact export and compare its protected
    // metadata/root. Never open an inactive WDB or a mutating roster.
    let identity = temp.path().join("signed-identity.txt");
    std::fs::write(&identity, key.to_string().expose_secret()).unwrap();
    let inactive = temp.path().join("signed-inactive");
    restore_inactive(
        &policy.directory.join(format!("{}.age", job.id)),
        &identity,
        &inactive,
    )
    .unwrap();
    assert_eq!(
        std::fs::read(inactive.join("uploads/checkpoint-byte-fixture.bin")).unwrap(),
        payload
    );
    let protected: wabi_server::instance_archive::LiveCheckpointMetadata =
        serde_json::from_slice(&std::fs::read(inactive.join("live-checkpoint.json")).unwrap())
            .unwrap();
    assert_eq!(protected.node_id, verified.claims().source_node_id);
    assert_eq!(
        protected.bootstrap_fingerprint,
        verified.claims().bootstrap_fingerprint
    );
    assert_eq!(
        protected.applied_commit_seq,
        verified.claims().applied_commit_seq
    );
    assert_eq!(
        protected.commit_prefix_fingerprint,
        verified.claims().commit_prefix_fingerprint
    );
    let root_key: [u8; 32] = hex::decode(
        std::fs::read_to_string(inactive.join("data/wabidb/root_key"))
            .unwrap()
            .trim(),
    )
    .unwrap()
    .try_into()
    .unwrap();
    use hmac::{Hmac, KeyInit, Mac};
    use sha2::{Digest, Sha256};
    let derived = (0u8..=u8::MAX)
        .find_map(|counter| {
            let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(&root_key).unwrap();
            mac.update(b"wabi/community-roster/p256/v1");
            mac.update(&[counter]);
            p256::ecdsa::SigningKey::from_slice(&mac.finalize().into_bytes()).ok()
        })
        .unwrap();
    assert_eq!(
        hex::encode(derived.verifying_key().to_encoded_point(false).as_bytes()),
        signed.public_key
    );
    assert_eq!(
        hex::encode(Sha256::digest(
            derived.verifying_key().to_encoded_point(false).as_bytes()
        )),
        verified.claims().community_id
    );
    let channel = state
        .wdb
        .create_channel("Post capture", ChannelKind::Text, user, false)
        .await
        .unwrap();
    state
        .wdb
        .add_channel_member(&channel, user, MemberRole::Owner)
        .await
        .unwrap();
    state
        .wdb
        .send_message(&channel, user, "real later write", false, &[])
        .await
        .unwrap();
    assert_eq!(
        context_call(
            &app,
            &job.id,
            "127.0.0.1:32001",
            &[("x-operator-secret", SECRET)]
        )
        .await
        .1,
        body
    );
    // A real encrypted export, chunked and verified locally against its real
    // community key. No encryption/replay/writer proof is inferred by storage.
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::PermissionsExt;
        let material = temp.path().join("material");
        std::fs::create_dir(&material).unwrap();
        std::fs::set_permissions(&material, std::fs::Permissions::from_mode(0o700)).unwrap();
        let store = wabi_consensus::material::MaterialStore::open(
            &material,
            wabi_consensus::model::StoreBinding {
                community_id: state.community_roster.community_id().into(),
                partition_id: "community/root".into(),
                node_id: 1,
            },
            wabi_consensus::material::MaterialLimits {
                min_free_bytes: 1,
                ..Default::default()
            },
        )
        .unwrap();
        let (manifest, local) = store
            .ingest_checkpoint(
                &policy.directory.join(format!("{}.age", job.id)),
                &verified,
                Default::default(),
            )
            .unwrap();
        assert!(manifest.objects.len() > 2);
        assert_eq!(
            serde_json::to_value(local).unwrap()["canonicalWriterPermitted"],
            false
        );
        checkpoint_rpc::transfer_reseed(temp.path(), &store, &manifest, receipt, &identity).await;
        if let Some(output) = export {
            output.publish(&policy.directory.join(format!("{}.age", job.id)), &manifest);
        }
    }
    assert!(
        CheckpointJobs::open(Some(policy.clone()), &state.config).is_ok(),
        "old open ignores separately versioned contexts"
    );
    // Reconstruct the actual Authority, not only its in-memory job manager.
    // Wait only for admitted disk writes to drain; never remove the lock inode.
    use std::os::unix::fs::MetadataExt;
    let restart_config = state.config.clone();
    let community_id = state.community_roster.community_id().to_string();
    let lock = Path::new(&restart_config.data_dir).join("wabidb/.lock");
    let lock_before = std::fs::metadata(&lock).unwrap();
    drop(reopened);
    drop(app);
    drop(state);
    let mut restarted = writer_drain::app_state(&restart_config).await.unwrap();
    restarted.checkpoint_jobs =
        CheckpointJobs::open_with_source_context(Some(policy.clone()), &restarted.config, true)
            .unwrap();
    assert_eq!(restarted.community_roster.community_id(), community_id);
    let lock_after = std::fs::metadata(&lock).unwrap();
    assert_eq!(lock_before.dev(), lock_after.dev());
    assert_eq!(lock_before.ino(), lock_after.ino());
    let state = Arc::new(restarted);
    let app = build_app_router(state.clone());
    let (restart_status, restart_body) = context_call(
        &app,
        &job.id,
        "127.0.0.1:32001",
        &[("x-operator-secret", SECRET)],
    )
    .await;
    assert_eq!(restart_status, StatusCode::OK, "{restart_body}");
    assert_eq!(restart_body, body);
    let disk = policy.directory.join(format!("{}.json", job.id));
    let original = std::fs::read(&disk).unwrap();
    for fault in [
        "missing",
        "corrupt",
        "failed",
        "receipt",
        "oversized",
        "symlink",
    ] {
        match fault {
            "missing" => std::fs::remove_file(&disk).unwrap(),
            "corrupt" => std::fs::write(&disk, b"bad record").unwrap(),
            "oversized" => std::fs::write(&disk, vec![b' '; 64 * 1024 + 1]).unwrap(),
            "symlink" => {
                std::fs::remove_file(&disk).unwrap();
                std::os::unix::fs::symlink("missing-target", &disk).unwrap();
            }
            kind => {
                let mut value = job_json.clone();
                if kind == "failed" {
                    value["phase"] = json!("failed");
                } else {
                    value["receipt"]["appliedCommitSeq"] = json!(999999);
                }
                std::fs::write(&disk, serde_json::to_vec(&value).unwrap()).unwrap();
            }
        }
        assert_eq!(
            context_call(
                &app,
                &job.id,
                "127.0.0.1:32001",
                &[("x-operator-secret", SECRET)]
            )
            .await
            .0,
            StatusCode::NOT_FOUND,
            "{fault}"
        );
        if std::fs::symlink_metadata(&disk).is_ok() {
            std::fs::remove_file(&disk).unwrap();
        }
        std::fs::write(&disk, &original).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&disk, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    let sidecar = policy
        .directory
        .join(format!("{}.source-context.json", job.id));
    let original = std::fs::read(&sidecar).unwrap();
    let mut tampered = body.clone();
    tampered["signature"] = json!("00".repeat(64));
    std::fs::write(&sidecar, serde_json::to_vec(&tampered).unwrap()).unwrap();
    assert_eq!(
        context_call(
            &app,
            &job.id,
            "127.0.0.1:32001",
            &[("x-operator-secret", SECRET)]
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    std::fs::write(&sidecar, &original).unwrap();
    let mut interrupted = job_json.clone();
    interrupted["phase"] = json!("copying");
    std::fs::write(&disk, serde_json::to_vec(&interrupted).unwrap()).unwrap();
    let interrupted =
        CheckpointJobs::open_with_source_context(Some(policy.clone()), &state.config, true)
            .unwrap();
    assert_eq!(
        interrupted.status().jobs[0].failure_code.as_deref(),
        Some("process_interrupted")
    );
    assert_eq!(
        context_call(
            &app,
            &job.id,
            "127.0.0.1:32001",
            &[("x-operator-secret", SECRET)]
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
}
#[cfg(target_os = "linux")]
#[tokio::test]
async fn source_route_refuses_forwarded_peer_account_token_unknown_jobs_and_default_off() {
    let temp = tempfile::tempdir().unwrap();
    let state = Arc::new(AppState::new(config(temp.path())).await.unwrap());
    let app = build_app_router(state.clone());
    let id = uuid::Uuid::new_v4().to_string();
    let claims = wabi_server::auth_extractor::JwtClaims {
        sub: "1".into(),
        username: "fixture".into(),
        is_guest: false,
        exp: chrono::Utc::now().timestamp() + 60,
        iat: chrono::Utc::now().timestamp(),
        jti: "source-route-fixture".into(),
        stepup: false,
        token_type: "access".into(),
    };
    let token = format!(
        "Bearer {}",
        jsonwebtoken::encode(
            &jsonwebtoken::Header::default(),
            &claims,
            &jsonwebtoken::EncodingKey::from_secret(state.config.jwt_secret.as_bytes())
        )
        .unwrap()
    );
    let stepup = format!(
        "Bearer {}",
        jsonwebtoken::encode(
            &jsonwebtoken::Header::default(),
            &wabi_server::auth_extractor::JwtClaims {
                stepup: true,
                ..claims
            },
            &jsonwebtoken::EncodingKey::from_secret(state.config.jwt_secret.as_bytes())
        )
        .unwrap()
    );
    for headers in [
        vec![],
        vec![("x-operator-secret", "wrong")],
        vec![("authorization", token.as_str())],
        vec![("authorization", stepup.as_str())],
    ] {
        assert_eq!(
            context_call(&app, &id, "127.0.0.1:32001", &headers).await.0,
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(
        context_call(
            &app,
            &id,
            "100.87.255.66:32001",
            &[
                ("x-operator-secret", SECRET),
                ("x-forwarded-for", "127.0.0.1"),
                ("forwarded", "for=127.0.0.1")
            ]
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    for id in [&id, "invalid-id", "..%2Fprivate"] {
        assert_eq!(
            context_call(
                &app,
                id,
                "127.0.0.1:32001",
                &[("x-operator-secret", SECRET)]
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
    }
}
#[cfg(target_os = "linux")]
#[tokio::test]
async fn source_sidecar_reserves_directory_and_byte_budgets_before_allocating_jobs() {
    let temp = tempfile::tempdir().unwrap();
    let state = Arc::new(AppState::new(config(temp.path())).await.unwrap());
    let key = age::x25519::Identity::generate();
    let mut policy = policy(temp.path(), key.to_public().to_string());
    for n in 0..508 {
        std::fs::write(policy.directory.join(format!("charged-{n}")), b"").unwrap();
    }
    let manager =
        CheckpointJobs::open_with_source_context(Some(policy.clone()), &state.config, true)
            .unwrap();
    manager.start(state.clone()).unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while manager.status().active_job_id.is_some() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        manager.status().jobs[0].failure_code.as_deref(),
        Some("storage_budget_failed")
    );
    assert_eq!(std::fs::read_dir(&policy.directory).unwrap().count(), 508);
    for entry in std::fs::read_dir(&policy.directory).unwrap() {
        std::fs::remove_file(entry.unwrap().path()).unwrap();
    }
    let limits = &policy.export_limits;
    let old_reserve = limits.max_plaintext_bytes
        + limits.max_plaintext_bytes / 50
        + limits.max_inventory_path_bytes
        + limits.max_entries * 64
        + 2 * 1024 * 1024;
    policy.max_stored_bytes = old_reserve;
    let manager =
        CheckpointJobs::open_with_source_context(Some(policy.clone()), &state.config, true)
            .unwrap();
    manager.start(state.clone()).unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while manager.status().active_job_id.is_some() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        manager.status().jobs[0].failure_code.as_deref(),
        Some("storage_budget_failed")
    );
    assert_eq!(std::fs::read_dir(&policy.directory).unwrap().count(), 0);
}
