#![cfg(target_os = "linux")]
//! Actual operator capture + approved Noise peer + owned inactive candidate.
//! No browser, physical-site, quorum, promotion or complete enabled-state claim.
use age::secrecy::ExposeSecret;
use axum::{
    body::{to_bytes, Body},
    extract::ConnectInfo,
    http::{Request, StatusCode},
    Router,
};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    net::SocketAddr,
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::Path,
    sync::{Arc, Once},
    time::Duration,
};
use tokio::{net::TcpListener, sync::oneshot};
use tower::ServiceExt;
use wabi_consensus::{
    material::{ChunkingLimits, MaterialLimits, MaterialStore},
    model::{RecoveryPeer, StoreBinding, CONTROL_PROTOCOL},
    source_context::SignedSourceContext,
    transport::{serve_checkpoint, Config, Identity, Limits, MaterialService},
};
use wabi_server::{
    checkpoint_jobs::{CheckpointJobs, CheckpointPhase, CheckpointPolicy},
    config::{LoreAddonConfig, ServerConfig, ServerRole},
    instance_archive::{verify_inactive_live, LiveExportLimits},
    recovery_peer_jobs::{PeerVerificationJobs, PeerVerificationPolicy},
    state::AppState,
};
use wabidb::engine::wabi_store::WabiStore;

#[path = "fixtures/checkpoint_office_verify.rs"]
mod office;

const SECRET: &str = "disposable-peer-verification-fixture-secret";
const ENDPOINT: &str = "/api/operator/checkpoints/peer-verifications";
fn directory(path: &Path) {
    fs::create_dir_all(path).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}
fn config(root: &Path) -> ServerConfig {
    static INIT: Once = Once::new();
    INIT.call_once(|| std::env::set_var("WABI_OPERATOR_SECRET", SECRET));
    assert!(std::env::var_os("WABIDB_ROOT_KEY").is_none());
    assert!(std::env::var_os("WABI_CHECKPOINT_PEER_VERIFY_CONFIG").is_none());
    directory(&root.join("uploads"));
    ServerConfig {
        host: "127.0.0.1".into(),
        port: 0,
        data_dir: root.join("data").to_string_lossy().into(),
        uploads_dir: root.join("uploads").to_string_lossy().into(),
        jwt_secret: "disposable-peer-jwt-fixture".into(),
        turn_enabled: false,
        turn_uri: None,
        turn_secret: None,
        node_id: "peer-verification-source".into(),
        is_primary: true,
        server_role: ServerRole::Authority,
        authority_url: None,
        admin_user_ids: vec![],
        blacklist_file: root.join("data/blacklist.txt").to_string_lossy().into(),
        max_body_size: None,
        mesh_enabled: false,
        mesh_peers: vec![],
        lore: LoreAddonConfig::default(),
    }
}
async fn call(
    app: &Router,
    method: &str,
    uri: &str,
    peer: &str,
    secret: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json");
    if let Some(secret) = secret {
        request = request.header("x-operator-secret", secret);
    }
    let mut request = request.body(Body::from(body.to_string())).unwrap();
    request
        .extensions_mut()
        .insert(ConnectInfo(peer.parse::<SocketAddr>().unwrap()));
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    if response.headers().contains_key("cache-control") {
        assert_eq!(response.headers()["cache-control"], "no-store, private");
    }
    let bytes = to_bytes(response.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(json!({"plain":String::from_utf8_lossy(&bytes)})),
    )
}
async fn completed(app: &Router, id: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let (status, body) = call(
                app,
                "GET",
                ENDPOINT,
                "127.0.0.1:32101",
                Some(SECRET),
                json!({}),
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            let job = body["jobs"]
                .as_array()
                .unwrap()
                .iter()
                .find(|j| j["id"] == id)
                .unwrap();
            if !job["finishedAtUnixMs"].is_null() {
                return job.clone();
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn peer_controls_require_loopback_and_secret_and_default_off() {
    let root = tempfile::tempdir().unwrap();
    let state = Arc::new(AppState::new(config(root.path())).await.unwrap());
    let app = wabi_server::app_router::build_app_router(state);
    let body = json!({"captureJobId":"unknown","peerNodeId":2,"manifestSha256":"00".repeat(32)});
    for method in ["GET", "POST"] {
        for (peer, secret) in [
            ("127.0.0.1:32101", None),
            ("127.0.0.1:32101", Some("wrong")),
            ("192.0.2.10:32101", Some(SECRET)),
        ] {
            assert_eq!(
                call(&app, method, ENDPOINT, peer, secret, body.clone())
                    .await
                    .0,
                StatusCode::FORBIDDEN
            );
        }
    }
    let (status, body) = call(
        &app,
        "GET",
        ENDPOINT,
        "127.0.0.1:32101",
        Some(SECRET),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["enabled"], false);
    assert_eq!(body["fullInstanceReady"], false);
    assert_eq!(body["canonicalWriterPermitted"], false);
    assert_eq!(
        call(
            &app,
            "POST",
            ENDPOINT,
            "127.0.0.1:32101",
            Some(SECRET),
            json!({"captureJobId":"unknown","peerNodeId":2,"manifestSha256":"00".repeat(32)})
        )
        .await
        .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
}

struct Setup {
    policy: PeerVerificationPolicy,
    configs: Vec<Arc<Config>>,
    listeners: Vec<TcpListener>,
    key_text: String,
}
async fn setup(root: &Path, state: &AppState) -> Setup {
    let recipient = age::x25519::Identity::generate();
    let key_text = recipient.to_string().expose_secret().to_string();
    let key_file = root.join("recipient.txt");
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&key_file)
        .unwrap();
    file.write_all(key_text.as_bytes()).unwrap();
    file.sync_all().unwrap();
    for name in ["scratch", "candidates", "checkpoints"] {
        directory(&root.join(name));
    }
    let mut identities = vec![];
    let mut listeners = vec![];
    for id in 1..=3 {
        let identity = Arc::new(Identity::generate().unwrap());
        let path = root.join(format!("identity-{id}"));
        directory(&path);
        identity.persist_new(&path).unwrap();
        identities.push(identity);
        listeners.push(TcpListener::bind("127.0.0.1:0").await.unwrap());
    }
    let binding = StoreBinding {
        community_id: state.community_roster.community_id().into(),
        partition_id: "core-recovery".into(),
        node_id: 1,
    };
    let peers: BTreeMap<_, _> = (1..=3)
        .map(|id| {
            (
                id,
                RecoveryPeer {
                    protocol: CONTROL_PROTOCOL,
                    community_id: binding.community_id.clone(),
                    site_id: format!("logical-fixture-site-{id}"),
                    public_key: identities[id as usize - 1].public_hex(),
                    rpc_address: listeners[id as usize - 1].local_addr().unwrap().to_string(),
                },
            )
        })
        .collect();
    let configs = (1..=3)
        .map(|id| {
            Arc::new(
                Config::new(
                    StoreBinding {
                        node_id: id,
                        ..binding.clone()
                    },
                    peers.clone(),
                    identities[id as usize - 1].clone(),
                    Limits::default(),
                )
                .unwrap(),
            )
        })
        .collect();
    let policy = PeerVerificationPolicy {
        schema_version: 1,
        binding,
        peers,
        identity_directory: root.join("identity-1"),
        recipient_identity_file: key_file,
        scratch_directory: root.join("scratch"),
        candidate_directory: root.join("candidates"),
        max_candidates: 4,
        max_candidate_bytes: 128 * 1024 * 1024,
        max_ciphertext_bytes: 8 * 1024 * 1024,
        max_plaintext_bytes: 8 * 1024 * 1024,
        max_entries: 10_000,
        min_free_bytes: 1024 * 1024,
        timeout_seconds: 30,
    };
    Setup {
        policy,
        configs,
        listeners,
        key_text,
    }
}

#[tokio::test]
async fn configured_job_fetches_real_capture_retains_fenced_candidate_and_drains() {
    configured_peer_roundtrip(false).await;
}

#[tokio::test]
async fn allocated_cleanup_failure_closes_admission_and_restart_refuses_remnants() {
    assert_ne!(
        fs::metadata("/proc/self").unwrap().uid(),
        0,
        "cleanup permission fault requires unprivileged Linux execution"
    );
    configured_peer_roundtrip(true).await;
}

async fn configured_peer_roundtrip(fail_cleanup: bool) {
    let root = tempfile::tempdir().unwrap();
    let cfg = config(root.path());
    let mut initial = AppState::new(cfg.clone()).await.unwrap();
    let setup = setup(root.path(), &initial).await;
    let key: age::x25519::Identity = setup.key_text.parse().unwrap();
    let capture_policy = CheckpointPolicy {
        directory: root.path().join("checkpoints"),
        recipient: key.to_public().to_string(),
        drain_timeout: Duration::from_secs(3),
        export_limits: LiveExportLimits {
            max_entries: 10_000,
            max_plaintext_bytes: 8 * 1024 * 1024,
            max_inventory_path_bytes: 1024 * 1024,
            copy_timeout: Duration::from_secs(10),
        },
        max_stored_bytes: 128 * 1024 * 1024,
        min_free_bytes: 1024 * 1024,
    };
    initial.checkpoint_jobs = CheckpointJobs::open_with_peer_verification(
        Some(capture_policy.clone()),
        &cfg,
        setup.policy.clone(),
    )
    .unwrap();
    let state = Arc::new(initial);
    let user = state
        .wdb
        .create_user("peer_fixture_owner", None, "fixture-hash")
        .await
        .unwrap();
    state
        .claim_ownership(user as i64, "peer_fixture_owner")
        .await
        .unwrap();
    let office_seed = office::seed(state.clone(), user).await;
    let mut seed = 0x7451_9819_9245_562bu64;
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
            Path::new(&cfg.uploads_dir),
            state.wdb.engine(),
            "peer-fixture.bin",
            "peer-fixture.bin",
            None,
            None,
            Some(user as i64),
            wabi_server::upload_registry::UploadKind::Other,
            &payload,
        )
        .await
        .unwrap();
    let app = wabi_server::checkpoint_jobs::routes().with_state(state.clone());
    let (status, created) = call(
        &app,
        "POST",
        "/api/operator/checkpoints",
        "127.0.0.1:32101",
        Some(SECRET),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let capture_id = created["id"].as_str().unwrap();
    let capture = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let status = state.checkpoint_jobs.status();
            let capture = status.jobs.iter().find(|j| j.id == capture_id).unwrap();
            if capture.phase == CheckpointPhase::Ready {
                return capture.clone();
            }
            assert_ne!(
                capture.phase,
                CheckpointPhase::Failed,
                "{:?}",
                capture.failure_code
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let (status, body) = call(
        &app,
        "GET",
        &format!("/api/operator/checkpoints/{capture_id}/source-context"),
        "127.0.0.1:32101",
        Some(SECRET),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let context: SignedSourceContext = serde_json::from_value(body).unwrap();
    let verified = context
        .verify(state.community_roster.community_id(), &cfg.node_id)
        .unwrap();
    let mut stores = vec![];
    for id in 1..=2 {
        let path = root.path().join(format!("material-{id}"));
        directory(&path);
        stores.push(
            MaterialStore::open(
                &path,
                StoreBinding {
                    node_id: id,
                    ..setup.policy.binding.clone()
                },
                MaterialLimits {
                    min_free_bytes: 1024 * 1024,
                    ..Default::default()
                },
            )
            .unwrap(),
        );
    }
    let (manifest, _) = stores[0]
        .ingest_checkpoint(
            &capture_policy.directory.join(format!("{capture_id}.age")),
            &verified,
            ChunkingLimits::default(),
        )
        .unwrap();
    let digest = manifest.sha256().unwrap();
    for (index, object) in manifest.objects.iter().enumerate() {
        let (_, bytes) = stores[0]
            .read_checkpoint_object(&digest, &cfg.node_id, index)
            .unwrap();
        stores[1].put_object(object, &bytes).unwrap();
    }
    stores[1]
        .certify_checkpoint(&manifest, &cfg.node_id)
        .unwrap();
    let mut listeners = setup.listeners.into_iter();
    drop(listeners.next().unwrap());
    let listener = listeners.next().unwrap();
    let service =
        MaterialService::new(stores[1].clone(), &setup.configs[1], cfg.node_id.clone(), 1).unwrap();
    let peer_config = setup.configs[1].clone();
    let (stop, stopped) = oneshot::channel();
    let (allow_accept, accepting) = oneshot::channel();
    let server = tokio::spawn(async move {
        accepting.await.unwrap();
        serve_checkpoint(listener, peer_config, stopped, service).await
    });
    let mut request = json!({"captureJobId":capture_id,"peerNodeId":2,"manifestSha256":digest});
    let mut forged = request.clone();
    forged["recipientIdentityFile"] = json!("/etc/shadow");
    assert_eq!(
        call(
            &app,
            "POST",
            ENDPOINT,
            "127.0.0.1:32101",
            Some(SECRET),
            forged
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    request["manifestSha256"] = json!("ff".repeat(32));
    let (status, failed) = call(
        &app,
        "POST",
        ENDPOINT,
        "127.0.0.1:32101",
        Some(SECRET),
        request.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    // The peer listener is bound but cannot accept yet. Completion of the
    // first HTTP caller leaves a real owned network job and its admission
    // permit; a second request must refuse before the peer is released.
    assert_eq!(
        call(
            &app,
            "POST",
            ENDPOINT,
            "127.0.0.1:32101",
            Some(SECRET),
            request.clone()
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    allow_accept.send(()).unwrap();
    let failed = completed(&app, failed["id"].as_str().unwrap()).await;
    assert_eq!(failed["phase"], "failed");
    assert_eq!(failed["failureCode"], "peer_manifest_unavailable");
    assert_eq!(
        fs::read_dir(&setup.policy.scratch_directory)
            .unwrap()
            .count(),
        0
    );
    request["manifestSha256"] = json!(manifest.sha256().unwrap());
    let before = fs::metadata(Path::new(&cfg.data_dir).join("wabidb/.lock")).unwrap();
    let (status, job) = call(
        &app,
        "POST",
        ENDPOINT,
        "127.0.0.1:32101",
        Some(SECRET),
        request.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let id = job["id"].as_str().unwrap();
    if fail_cleanup {
        // Observe a genuinely allocated owner, then remove only the parent
        // directory's write permission. Its children remain accessible for
        // download/verification/publication, but unlinking the scratch root
        // must fail. This does not alter any live data or persistent lock.
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if fs::read_dir(&setup.policy.scratch_directory)
                    .unwrap()
                    .next()
                    .is_some()
                {
                    fs::set_permissions(
                        &setup.policy.scratch_directory,
                        fs::Permissions::from_mode(0o500),
                    )
                    .unwrap();
                    break;
                }
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap();
    } else {
        // Shutdown owns the actual job independently of the request/caller.
        state.checkpoint_jobs.shutdown_peer_verification().await;
    }
    let done = completed(&app, id).await;
    if fail_cleanup {
        assert_eq!(done["phase"], "failed", "{done}");
        assert_eq!(done["failureCode"], "scratch_cleanup_failed", "{done}");
        assert!(done["candidateId"].is_null());
        let retained = setup.policy.candidate_directory.join(id);
        let record: Value =
            serde_json::from_slice(&fs::read(retained.join("candidate.json")).unwrap()).unwrap();
        assert_eq!(record["canonicalWriterPermitted"], false);
        assert_eq!(record["fullInstanceReady"], false);
        assert_eq!(
            record["verification"]["database"]["fullHistoryReplayed"],
            true
        );
        let (_, status) = call(
            &app,
            "GET",
            ENDPOINT,
            "127.0.0.1:32101",
            Some(SECRET),
            json!({}),
        )
        .await;
        // Observe poison before invoking shutdown: shutdown itself must not
        // make a missing admission latch appear correct.
        assert_eq!(status["accepting"], false);
        assert_eq!(
            call(
                &app,
                "POST",
                ENDPOINT,
                "127.0.0.1:32101",
                Some(SECRET),
                request
            )
            .await
            .0,
            StatusCode::SERVICE_UNAVAILABLE
        );
        state.checkpoint_jobs.shutdown_peer_verification().await;
        let after = fs::metadata(Path::new(&cfg.data_dir).join("wabidb/.lock")).unwrap();
        assert_eq!((before.dev(), before.ino()), (after.dev(), after.ino()));
        fs::set_permissions(
            &setup.policy.scratch_directory,
            fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        stop.send(()).unwrap();
        server.await.unwrap().unwrap();
        drop(office_seed);
        drop(app);
        drop(state);
        let error = match PeerVerificationJobs::open(setup.policy.clone(), &cfg) {
            Ok(_) => panic!("restart admitted unresolved scratch"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("unresolved scratch"), "{error}");
        let remnants: Vec<_> = fs::read_dir(&setup.policy.scratch_directory)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        assert_eq!(remnants.len(), 1);
        for path in remnants {
            assert!(path
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("wabi-peer-verify-"));
            assert!(fs::symlink_metadata(&path).unwrap().is_dir());
            // Explicit retirement of this test's own stopped disposable root.
            fs::remove_dir_all(path).unwrap();
        }
        let restarted = PeerVerificationJobs::open(setup.policy.clone(), &cfg).unwrap();
        assert!(restarted.status().accepting);
        restarted.shutdown().await;
        return;
    }
    assert_eq!(done["phase"], "core_verified", "{done}");
    assert_eq!(done["candidateId"], id);
    assert_eq!(done["fullInstanceReady"], false);
    assert_eq!(done["canonicalWriterPermitted"], false);
    assert_eq!(done["receipt"]["inactiveGuardsPreserved"], true);
    let candidate = setup.policy.candidate_directory.join(id);
    let candidate_lock = fs::metadata(candidate.join("inactive/data/wabidb/.lock")).unwrap();
    assert_eq!(candidate_lock.mode() & 0o077, 0);
    assert_eq!(candidate_lock.nlink(), 1);
    assert!(candidate.join("candidate.json").is_file());
    assert!(candidate
        .join("inactive/data/wabidb/live-checkpoint-v1")
        .is_file());
    assert!(candidate
        .join("inactive/data/wabidb/writer-fenced-v1")
        .is_file());
    assert_eq!(
        fs::read(candidate.join("inactive/uploads/peer-fixture.bin")).unwrap(),
        payload
    );
    assert!(!candidate.join("recipient.txt").exists());
    assert_eq!(
        fs::read_dir(&setup.policy.scratch_directory)
            .unwrap()
            .count(),
        0
    );
    let repeated = verify_inactive_live(
        &candidate.join("inactive"),
        capture.receipt.as_ref().unwrap(),
        &candidate.join("capture.age"),
        &setup.policy.recipient_identity_file,
        Default::default(),
    )
    .await
    .unwrap();
    assert!(!repeated.full_instance_ready);
    assert!(repeated.database.full_history_replayed);
    office::inspect(
        &office_seed,
        &candidate.join("inactive"),
        capture.receipt.as_ref().unwrap(),
    )
    .await;
    let candidate_lock_after = fs::metadata(candidate.join("inactive/data/wabidb/.lock")).unwrap();
    assert_eq!(
        (candidate_lock.dev(), candidate_lock.ino()),
        (candidate_lock_after.dev(), candidate_lock_after.ino())
    );
    let after = fs::metadata(Path::new(&cfg.data_dir).join("wabidb/.lock")).unwrap();
    assert_eq!((before.dev(), before.ino()), (after.dev(), after.ino()));
    let text = done.to_string();
    assert!(!text.contains(&setup.key_text));
    assert!(!text.contains(&cfg.jwt_secret));
    assert_eq!(
        call(
            &app,
            "POST",
            ENDPOINT,
            "127.0.0.1:32101",
            Some(SECRET),
            request
        )
        .await
        .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
}

#[tokio::test]
async fn startup_refuses_roster_keys_live_overlap_and_duplicate_candidate_owner() {
    let root = tempfile::tempdir().unwrap();
    let cfg = config(root.path());
    let state = AppState::new(cfg.clone()).await.unwrap();
    let setup = setup(root.path(), &state).await;
    let mut bad = setup.policy.clone();
    bad.peers.remove(&3);
    assert!(PeerVerificationJobs::open(bad, &cfg).is_err());
    let mut bad = setup.policy.clone();
    bad.scratch_directory = Path::new(&cfg.data_dir).to_path_buf();
    assert!(PeerVerificationJobs::open(bad, &cfg).is_err());
    let mut bad = setup.policy.clone();
    bad.candidate_directory = Path::new(&cfg.data_dir).to_path_buf();
    assert!(PeerVerificationJobs::open(bad, &cfg).is_err());
    let mut bad = setup.policy.clone();
    bad.recipient_identity_file = root.path().join("absent-identity");
    assert!(PeerVerificationJobs::open(bad, &cfg).is_err());
    let manager = PeerVerificationJobs::open(setup.policy.clone(), &cfg).unwrap();
    assert!(PeerVerificationJobs::open(setup.policy.clone(), &cfg).is_err());
    manager.shutdown().await;
    assert!(!manager.status().accepting);
    drop(manager);
    let manager = PeerVerificationJobs::open(setup.policy.clone(), &cfg).unwrap();
    manager.shutdown().await;
    drop(manager);
    let mut bad = setup.policy.clone();
    bad.max_candidate_bytes = 1;
    assert!(PeerVerificationJobs::open(bad, &cfg).is_err());
    let retained = setup.policy.candidate_directory.join("00".repeat(16));
    directory(&retained);
    let mut bad = setup.policy.clone();
    bad.max_candidates = 1;
    assert!(PeerVerificationJobs::open(bad, &cfg).is_err());
    fs::remove_dir(retained).unwrap();
    let policy = serde_json::to_string(&setup.policy).unwrap();
    let duplicate = policy.replacen("\"peers\":{\"1\":", "\"peers\":{\"01\":", 1);
    assert!(serde_json::from_str::<PeerVerificationPolicy>(&duplicate).is_err());
    let public_key = root.path().join("public-recipient.txt");
    fs::write(&public_key, &setup.key_text).unwrap();
    fs::set_permissions(&public_key, fs::Permissions::from_mode(0o644)).unwrap();
    let mut bad = setup.policy.clone();
    bad.recipient_identity_file = public_key;
    assert!(PeerVerificationJobs::open(bad, &cfg).is_err());
    let manager = PeerVerificationJobs::open(setup.policy.clone(), &cfg).unwrap();
    manager.shutdown().await;
}
