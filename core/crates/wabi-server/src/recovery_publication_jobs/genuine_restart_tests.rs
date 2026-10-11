//! Test-only genuine automatic pending publication fixture.
//! The original intent is seeded through the real runtime before full-router
//! attachment. This is not a process-kill or replacement Authority test.
#![allow(dead_code)]
use axum::{body::{to_bytes, Body}, extract::ConnectInfo, http::{Request, StatusCode}, Router};
use fs4::fs_std::FileExt;
use serde_json::{json, Value};
use std::{collections::BTreeMap, ffi::OsString, fs::{self, File, OpenOptions}, io::Write,
    net::{SocketAddr, TcpListener}, os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf}, sync::Arc, time::Duration};
use tower::ServiceExt;
use wabi_consensus::{model::{RecoveryPeer, StoreBinding, CONTROL_PROTOCOL},
    runtime::RecoveryRuntime, transport::Identity};
use crate::{config::{LoreAddonConfig, ServerConfig, ServerRole},
    recovery_node::RecoveryNodeConfig, state::AppState};

pub const PUBLICATIONS: &str = "/api/operator/checkpoints/publications";

/// Only the isolated child runs this environment helper. Refuse inherited operator
/// configuration rather than redirecting an actual deployment's inputs.
pub struct Environment(Vec<(&'static str, Option<OsString>)>);
impl Environment {
    pub fn new() -> Self {
        for name in ["WABIDB_ROOT_KEY", "WABIDB_PEER_ENDPOINT", "WABI_OPERATOR_SECRET", "WABI_CHECKPOINT_DIR",
            "WABI_CHECKPOINT_RECIPIENT", "WABI_RECOVERY_PUBLISHER_CONFIG",
            "WABI_CHECKPOINT_PEER_VERIFY_CONFIG"] {
            assert!(std::env::var_os(name).is_none(), "isolated test environment required: {name}");
        }
        Self(Vec::new())
    }
    pub fn set(&mut self, name: &'static str, value: impl AsRef<std::ffi::OsStr>) {
        if !self.0.iter().any(|(saved, _)| *saved == name) {
            self.0.push((name, std::env::var_os(name)));
        }
        std::env::set_var(name, value);
    }
}
impl Drop for Environment {
    fn drop(&mut self) {
        for (name, value) in self.0.drain(..).rev() {
            match value { Some(value) => std::env::set_var(name, value), None => std::env::remove_var(name) }
        }
    }
}

/// On failure keep private fixtures until the outer runner proves the test
/// process terminal. Never unlink advisory locks while async owners may live.
pub struct Root(Option<tempfile::TempDir>);
impl Root {
    pub fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        // Make fixture ownership explicit even for ordinary workspace tests
        // started under a permissive caller umask. No global umask mutation.
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
        Self(Some(root))
    }
    pub fn path(&self) -> &Path { self.0.as_ref().unwrap().path() }
    pub fn completed(mut self) { self.0.take().unwrap().close().unwrap(); }
}
impl Drop for Root {
    fn drop(&mut self) {
        if let Some(root) = self.0.take() { let _retained = root.keep(); }
    }
}
pub fn private(path: &Path) {
    fs::create_dir(path).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}
pub fn config(root: &Path) -> ServerConfig {
    fs::create_dir_all(root.join("uploads")).unwrap();
    let data = root.join("data");
    ServerConfig {
        host: "127.0.0.1".into(), port: 0, data_dir: data.to_string_lossy().into(),
        uploads_dir: root.join("uploads").to_string_lossy().into(),
        jwt_secret: uuid::Uuid::new_v4().simple().to_string(),
        turn_enabled: false, turn_uri: None, turn_secret: None,
        node_id: "publication-contract-authority".into(), is_primary: true,
        server_role: ServerRole::Authority, authority_url: None, admin_user_ids: vec![],
        blacklist_file: data.join("blacklist.txt").to_string_lossy().into(),
        max_body_size: None, mesh_enabled: false, mesh_peers: vec![],
        lore: LoreAddonConfig::default(),
    }
}
pub fn write_policy(path: &Path, policy: &RecoveryNodeConfig) {
    let mut file = OpenOptions::new().write(true).create(true).truncate(true)
        .mode(0o600).open(path).unwrap();
    assert_eq!(file.metadata().unwrap().mode() & 0o077, 0);
    file.write_all(&serde_json::to_vec(policy).unwrap()).unwrap();
    file.sync_all().unwrap();
}
pub fn policies(root: &Path, community: &str, source: &str) -> Vec<RecoveryNodeConfig> {
    let mut peers = BTreeMap::new();
    let mut reservations = Vec::new();
    for id in 1..=3 {
        let node = root.join(format!("node-{id}"));
        private(&node);
        for name in ["identity", "control", "material"] { private(&node.join(name)); }
        let identity = Identity::generate().unwrap();
        identity.persist_new(&node.join("identity")).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        peers.insert(id, RecoveryPeer { protocol: CONTROL_PROTOCOL, community_id: community.into(),
            site_id: format!("loopback-fixture-{id}"), public_key: identity.public_hex(),
            rpc_address: listener.local_addr().unwrap().to_string() });
        reservations.push(listener);
    }
    let result = (1..=3).map(|id| {
        let node = root.join(format!("node-{id}"));
        RecoveryNodeConfig { schema_version: 1, binding: StoreBinding {
            community_id: community.into(), partition_id: "community/control".into(), node_id: id },
            peers: peers.clone(), source_node_id: source.into(), identity_directory: node.join("identity"),
            control_directory: node.join("control"), material_directory: node.join("material"),
            bind_address: None, initialize: id == 1, work_timeout_seconds: 10,
            rpc_deadline_milliseconds: 1000, minimum_free_bytes: 64 * 1024 * 1024 }
    }).collect();
    // The bind race is real: runtime startup must fail if a reservation is lost.
    drop(reservations);
    result
}
pub async fn request(app: &Router, method: &str, uri: &str, peer: &str,
    secret: Option<&str>, body: Body) -> (StatusCode, Value) {
    let mut request = Request::builder().method(method).uri(uri).header("content-type", "application/json");
    if let Some(secret) = secret { request = request.header("x-operator-secret", secret); }
    let mut request = request.body(body).unwrap();
    request.extensions_mut().insert(ConnectInfo(peer.parse::<SocketAddr>().unwrap()));
    let response = tokio::time::timeout(Duration::from_secs(7), app.clone().oneshot(request))
        .await.expect("operator response deadline").unwrap();
    let status = response.status();
    assert_eq!(response.headers().get("cache-control").unwrap(), "no-store, private");
    let bytes = to_bytes(response.into_body(), 256 * 1024).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({"plain":String::from_utf8_lossy(&bytes)})))
}
pub async fn status(app: &Router, secret: &str) -> Value {
    let (code, value) = request(app, "GET", PUBLICATIONS, "127.0.0.1:33001", Some(secret), Body::empty()).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(value["fullInstanceReady"], false);
    assert_eq!(value["canonicalWriterPermitted"], false);
    assert_eq!(value["historyIsDurable"], false);
    assert_eq!(value["statusLifetime"], "current_process");
    value
}
pub async fn publish(app: &Router, secret: &str, capture: &str) -> Value {
    let (code, queued) = request(app, "POST", PUBLICATIONS, "127.0.0.1:33001", Some(secret),
        Body::from(json!({"captureJobId":capture}).to_string())).await;
    assert_eq!(code, StatusCode::ACCEPTED, "{queued}");
    assert_eq!(queued["captureJobId"], capture);
    assert_eq!(queued["operationId"], uuid::Uuid::parse_str(capture).unwrap().simple().to_string());
    finished(app, secret, capture).await
}
pub async fn finished(app: &Router, secret: &str, capture: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(35), async {
        loop {
            let view = status(app, secret).await;
            if view["activeCaptureId"].is_null() {
                let job = view["jobs"].as_array().unwrap().iter()
                    .find(|job| job["captureJobId"] == capture).unwrap().clone();
                assert!(job["phase"] == "historical" || job["phase"] == "failed");
                assert_eq!(job["fullInstanceReady"], false);
                assert_eq!(job["canonicalWriterPermitted"], false);
                return job;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }).await.expect("publication did not reach terminal public status")
}
pub async fn capture(app: &Router, state: &AppState, secret: &str) -> crate::checkpoint_jobs::CheckpointJob {
    let (code, queued) = request(app, "POST", "/api/operator/checkpoints", "127.0.0.1:33001",
        Some(secret), Body::from("{}")).await;
    assert_eq!(code, StatusCode::ACCEPTED, "{queued}");
    let id = queued["id"].as_str().unwrap().to_string();
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let view = state.checkpoint_jobs.status();
            if view.active_job_id.is_none() {
                let job = view.jobs.iter().find(|job| job.id == id).unwrap().clone();
                assert_eq!(job.phase, crate::checkpoint_jobs::CheckpointPhase::Ready,
                    "genuine capture failed: {:?}", job.failure_code);
                assert!(!job.receipt.as_ref().unwrap().full_instance_ready);
                return job;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }).await.expect("capture deadline")
}
pub async fn leader(nodes: &[RecoveryRuntime], expected: Option<u64>) -> u64 {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            if let Some(id) = nodes[0].status().leader_node_id {
                if expected.is_none_or(|expected| expected == id)
                    && nodes.iter().all(|node| { let view = node.status();
                        view.accepting && view.membership_ready && view.leader_node_id == Some(id) }) {
                    return id;
                }
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }).await.expect("real runtime leader/membership did not converge")
}
// Surviving followers can briefly agree on a retired leader before their
// election timer expires. Wait for a leader in the explicitly surviving
// roster; cached agreement alone is not proof that replacement completed.
pub async fn leader_from_allowed(nodes: &[RecoveryRuntime], allowed: &[u64]) -> u64 {
    assert!(!nodes.is_empty() && !allowed.is_empty());
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            if let Some(id) = nodes[0].status().leader_node_id {
                if allowed.contains(&id)
                    && nodes.iter().all(|node| { let view = node.status();
                        view.accepting && view.membership_ready && view.leader_node_id == Some(id) }) {
                    return id;
                }
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }).await.expect("surviving runtime leader/membership did not converge")
}
pub fn inode(path: &Path) -> (u64, u64) {
    let metadata = fs::symlink_metadata(path).unwrap();
    assert!(metadata.is_file() && !metadata.file_type().is_symlink());
    (metadata.dev(), metadata.ino())
}
pub async fn stopped_lock(path: &Path) -> File {
    let original = inode(path);
    let file = OpenOptions::new().read(true).write(true).open(path).unwrap();
    assert_eq!((file.metadata().unwrap().dev(), file.metadata().unwrap().ino()), original);
    tokio::time::timeout(Duration::from_secs(20), async {
        while !FileExt::try_lock_exclusive(&file).unwrap() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("actual owned writers did not release original advisory lock");
    assert_eq!(inode(path), original);
    file
}
pub async fn halt(state: Arc<AppState>, app: Router, policy: Option<&RecoveryNodeConfig>) {
    let engine = Path::new(&state.config.data_dir).join("wabidb/.lock");
    let weak = Arc::downgrade(&state);
    let io = state.sio.write().unwrap().take();
    if let Some(io) = io { io.close().await; }
    state.checkpoint_jobs.shutdown_peer_verification().await;
    state.tailcat.shutdown().await;
    drop(app);
    drop(state);
    tokio::time::timeout(Duration::from_secs(20), async {
        while weak.upgrade().is_some() { tokio::time::sleep(Duration::from_millis(10)).await; }
    }).await.expect("Authority state owners did not drain");
    let _engine = stopped_lock(&engine).await;
    if let Some(policy) = policy {
        let _runtime = stopped_lock(&policy.control_directory.join(".runtime.lock")).await;
        let _control = stopped_lock(&policy.control_directory.join(".lock")).await;
        let _material = stopped_lock(&policy.material_directory.join(".lock")).await;
    }
}
pub async fn recorded(policy: &RecoveryNodeConfig) -> serde_json::Value {
    // Only after actual runtime drain. Hold the existing owner lock while
    // opening the original control store; never create a replacement binding.
    let _owner = stopped_lock(&policy.control_directory.join(".runtime.lock")).await;
    let store = wabi_consensus::store::Store::open(&policy.control_directory,
        policy.binding.clone(), wabi_consensus::store::StoreLimits {
            min_free_bytes: policy.minimum_free_bytes, ..Default::default() }).unwrap();
    let state = store.control_state().await.unwrap();
    serde_json::to_value(state.checkpoints).unwrap()
}

/// The lib test itself never mutates process environment. Its exact ignored
/// child receives a fresh explicit environment, preventing races with ordinary
/// parallel workspace tests. The remote outer runner also owns descendants.
#[test]
fn full_router_automatically_reconciles_original_genuine_capture_intent() {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use base64::Engine as _;
    let mut command = Command::new(std::env::current_exe().unwrap());
    command.args([
        "recovery_publication_jobs::tests::genuine_restart::isolated_genuine_restart_child",
        "--ignored", "--exact", "--test-threads=1", "--nocapture"
    ]).env_clear();
    for name in ["HOME", "USER", "LOGNAME", "PATH", "LANG", "TZ", "TMPDIR"] {
        if let Some(value) = std::env::var_os(name) { command.env(name, value); }
    }
    command.env("WABI_TEST_GENUINE_RESTART_CHILD", "1")
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().unwrap();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let read = |stream: Box<dyn Read + Send>| std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stream.take(4 * 1024 * 1024 + 1).read_to_end(&mut bytes).unwrap();
        bytes
    });
    let output = read(Box::new(stdout));
    let errors = read(Box::new(stderr));
    // This bounds direct child waiting. Pipe-owner/descendant terminal proof
    // still belongs to the outer actual owned-process runner; unexpected
    // inherited pipe handles must not be called drained merely on child exit.
    let deadline = std::time::Instant::now() + Duration::from_secs(90);
    let mut expired = false;
    loop {
        if child.try_wait().unwrap().is_some() { break; }
        if std::time::Instant::now() >= deadline {
            expired = true;
            child.kill().unwrap();
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let status = child.wait().unwrap();
    let output = output.join().unwrap();
    let errors = errors.join().unwrap();
    // Preserve the complete nested output in the actual parent test log without
    // creating a second literal libtest verdict for the runner to miscount.
    // Write through the actual stdout handle; print macros are captured and
    // discarded by libtest on success, which would lose the child evidence.
    writeln!(std::io::stdout().lock(),
        "isolated restart child stdoutBase64={} stderrBase64={} exit={:?} expired={}",
        base64::engine::general_purpose::STANDARD.encode(&output),
        base64::engine::general_purpose::STANDARD.encode(&errors), status.code(), expired).unwrap();
    assert!(!expired && status.success(), "isolated genuine restart child failed");
    assert!(output.len() <= 4 * 1024 * 1024 && errors.len() <= 4 * 1024 * 1024);
    assert!(String::from_utf8(output).unwrap().contains("test result: ok. 1 passed; 0 failed; 0 ignored;"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "isolated child, executed only by the owned parent fixture"]
async fn isolated_genuine_restart_child() {
    assert_eq!(std::env::var("WABI_TEST_GENUINE_RESTART_CHILD").unwrap(), "1");
    use crate::{app_router::build_app_router, recovery_node::load};
    use wabi_consensus::{runtime::PublicationStage, source_context::SignedSourceContext};
    use wabidb::{domain::ChannelKind, engine::wabi_store::WabiStore};
    let mut env = Environment::new();
    let root = Root::new();
    let secret = uuid::Uuid::new_v4().simple().to_string();
    env.set("WABI_OPERATOR_SECRET", &secret);
    let checkpoints = root.path().join("checkpoints");
    private(&checkpoints);
    env.set("WABI_CHECKPOINT_DIR", &checkpoints);
    let encryption = age::x25519::Identity::generate();
    env.set("WABI_CHECKPOINT_RECIPIENT", encryption.to_public().to_string());
    env.set("WABI_CHECKPOINT_SOURCE_CONTEXT", "1");
    for (name, value) in [
        ("WABI_CHECKPOINT_DRAIN_SECONDS", "3"), ("WABI_CHECKPOINT_COPY_SECONDS", "10"),
        ("WABI_CHECKPOINT_MAX_ENTRIES", "10000"), ("WABI_CHECKPOINT_MAX_BYTES", "33554432"),
        ("WABI_CHECKPOINT_MAX_PATH_BYTES", "1048576"), ("WABI_CHECKPOINT_STORAGE_BYTES", "268435456"),
        ("WABI_CHECKPOINT_MIN_FREE_BYTES", "67108864")
    ] { env.set(name, value); }
    let config = config(root.path());
    let initial = Arc::new(AppState::new(config.clone()).await.unwrap());
    let app = build_app_router(initial.clone());
    let user = initial.wdb.create_user("restart_owner", None, "generated-fixture-hash").await.unwrap();
    initial.claim_ownership(user as i64, "restart_owner").await.unwrap();
    let channel = initial.wdb.create_channel("Restart capture", ChannelKind::Text, user, false).await.unwrap();
    initial.wdb.send_message(&channel, user, "original durable content", false, &[]).await.unwrap();
    let capture = capture(&app, &initial, &secret).await;
    let (code, context) = request(&app, "GET",
        &format!("/api/operator/checkpoints/{}/source-context", capture.id),
        "127.0.0.1:33001", Some(&secret), Body::empty()).await;
    assert_eq!(code, StatusCode::OK);
    let signed: SignedSourceContext = serde_json::from_value(context).unwrap();
    let community = initial.community_roster.community_id().to_string();
    signed.verify(&community, &config.node_id).unwrap();
    let source = checkpoints.join(format!("{}.source-context.json", capture.id));
    let archive = checkpoints.join(format!("{}.age", capture.id));
    let original_source = fs::read(&source).unwrap();
    let original_archive = fs::read(&archive).unwrap();
    let source_inode = inode(&source);
    let archive_inode = inode(&archive);
    let engine = Path::new(&config.data_dir).join("wabidb/.lock");
    let engine_inode = inode(&engine);
    halt(initial, app, None).await;

    let policies = policies(root.path(), &community, &config.node_id);
    let policy_path = root.path().join("publisher.json");
    write_policy(&policy_path, &policies[0]);
    env.set("WABI_RECOVERY_PUBLISHER_CONFIG", &policy_path);
    let mut followers = Vec::new();
    for policy in &policies[1..] {
        let path = policy.control_directory.parent().unwrap().join("node.json");
        write_policy(&path, policy);
        followers.push(RecoveryRuntime::start(load(&path).unwrap()).await.unwrap());
    }
    let state = Arc::new(AppState::new(config.clone()).await.unwrap());
    leader(&followers, Some(1)).await;
    let operation = uuid::Uuid::parse_str(&capture.id).unwrap().simple().to_string();
    let intent = policies[0].control_directory.join(format!("publication-{operation}-capture.json"));
    {
        // Private test seam seeds the original intent through the actual
        // runtime and sync path before the production full router attaches.
        // There is no operator publication request or manual resume call.
        let publisher = state.recovery_publication.as_ref().unwrap();
        let runtime = publisher.inner.runtime.lock().await;
        let node = runtime.as_ref().unwrap();
        node.record_capture_intent(operation.clone(), signed.clone()).await.unwrap();
        while node.local_job_active() { tokio::time::sleep(Duration::from_millis(1)).await; }
        let pending = node.pending_publication_operations().await.unwrap();
        while node.local_job_active() { tokio::time::sleep(Duration::from_millis(1)).await; }
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].operation_id, operation);
        assert_eq!(pending[0].stage, PublicationStage::Capture);
    }
    let original_intent = fs::read(&intent).unwrap();
    let intent_inode = inode(&intent);
    let app = build_app_router(state.clone());
    {
        let publisher = state.recovery_publication.as_ref().unwrap();
        let original_worker = publisher.inner.restart.lock().unwrap().worker.as_ref().unwrap().id();
        publisher.attach(&state);
        publisher.attach(&state);
        assert_eq!(publisher.inner.restart.lock().unwrap().worker.as_ref().unwrap().id(), original_worker);
    }
    let job = tokio::time::timeout(Duration::from_secs(35), async {
        loop {
            let view = status(&app, &secret).await;
            if let Some(job) = view["jobs"].as_array().unwrap().iter()
                .find(|job| job["captureJobId"] == capture.id && job["phase"] == "historical") {
                return job.clone();
            }
            assert_eq!(view["accepting"], true, "automatic original publication refused: {view}");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }).await.expect("production router did not automatically reconcile original intent");
    let receipt = &job["historicalReceipt"];
    assert_eq!(receipt["operationId"], operation);
    assert_eq!(receipt["metadataCommitted"], true);
    assert_eq!(receipt["quorumAvailable"], false);
    assert_eq!(receipt["fullInstanceReady"], false);
    assert_eq!(receipt["canonicalWriterPermitted"], false);
    assert_eq!(status(&app, &secret).await["jobs"].as_array().unwrap().len(), 1);
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let left = followers[0].control_state().await.unwrap();
            let right = followers[1].control_state().await.unwrap();
            if let (Some(left), Some(right)) = (left.checkpoints.get(&operation), right.checkpoints.get(&operation)) {
                assert_eq!(left, right);
                assert_eq!(left.command.manifest_sha256(), receipt["manifestSha256"].as_str().unwrap());
                assert_eq!(left.command.fingerprint().unwrap(), receipt["commandFingerprint"].as_str().unwrap());
                assert_eq!(serde_json::to_value(&left.command).unwrap()["manifest"]["source"], serde_json::to_value(&signed).unwrap());
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }).await.expect("actual followers did not apply original automatic publication");
    assert_eq!(fs::read(&intent).unwrap(), original_intent);
    assert_eq!(inode(&intent), intent_inode);
    assert_eq!(fs::read(&source).unwrap(), original_source);
    assert_eq!(fs::read(&archive).unwrap(), original_archive);
    assert_eq!(inode(&source), source_inode);
    assert_eq!(inode(&archive), archive_inode);
    // Close after the original reservation but before its durable admission
    // acknowledgment. Refusal must retain the same queued Authority/lease.
    let pause = state.instance_operations.quiesce().await.unwrap();
    let queued_state = state.clone();
    let queued_id = capture.id.clone();
    let queued = tokio::spawn(async move {
        let publisher = queued_state.recovery_publication.as_ref().unwrap().clone();
        publisher.start(queued_id, queued_state).await
    });
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let publisher = state.recovery_publication.as_ref().unwrap();
            if publisher.status().active_capture_id.as_deref() == Some(capture.id.as_str())
                && state.instance_operations.waiting_operations() > 0 { break; }
            tokio::task::yield_now().await;
        }
    }).await.expect("original historical retry did not retain queued admission");
    state.recovery_publication.as_ref().unwrap().inner.close();
    assert!(!queued.is_finished());
    assert_eq!(inode(&engine), engine_inode);
    let probe = OpenOptions::new().read(true).write(true).open(&engine).unwrap();
    assert!(!FileExt::try_lock_exclusive(&probe).unwrap());
    drop(probe);
    drop(pause);
    let refusal = tokio::time::timeout(Duration::from_secs(5), queued).await.unwrap().unwrap();
    assert!(matches!(refusal, Err(super::super::StartError::Indeterminate)));
    state.recovery_publication.as_ref().unwrap().shutdown().await.unwrap();
    state.recovery_publication.as_ref().unwrap().shutdown().await.unwrap();
    assert_eq!(fs::read(&intent).unwrap(), original_intent);
    assert_eq!(inode(&intent), intent_inode);
    halt(state, app, Some(&policies[0])).await;
    for node in followers { node.shutdown().await.unwrap(); }
    assert_eq!(inode(&engine), engine_inode);
    let recorded = recorded(&policies[0]).await;
    assert_eq!(recorded.as_object().unwrap().len(), 1);
    assert!(recorded.get(&operation).is_some());
    root.completed();
}
