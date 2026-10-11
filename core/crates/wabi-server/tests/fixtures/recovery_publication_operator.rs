//! Disposable configured-publisher contract support. No production hooks.
use axum::{body::{to_bytes, Body}, extract::ConnectInfo, http::{Request, StatusCode}, Router};
use fs4::fs_std::FileExt;
use serde_json::{json, Value};
use std::{collections::BTreeMap, ffi::OsString, fs::{self, File, OpenOptions}, io::Write,
    net::{SocketAddr, TcpListener}, os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf}, sync::Arc, time::Duration};
use tower::ServiceExt;
use wabi_consensus::{model::{RecoveryPeer, StoreBinding, CONTROL_PROTOCOL},
    runtime::RecoveryRuntime, transport::Identity};
use wabi_server::{config::{LoreAddonConfig, ServerConfig, ServerRole},
    recovery_node::RecoveryNodeConfig, state::AppState};

pub const PUBLICATIONS: &str = "/api/operator/checkpoints/publications";

/// One test in a dedicated, serial test binary. Refuse inherited operator
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
    pub fn new() -> Self { Self(Some(tempfile::tempdir().unwrap())) }
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
pub async fn capture(app: &Router, state: &AppState, secret: &str) -> wabi_server::checkpoint_jobs::CheckpointJob {
    let (code, queued) = request(app, "POST", "/api/operator/checkpoints", "127.0.0.1:33001",
        Some(secret), Body::from("{}")).await;
    assert_eq!(code, StatusCode::ACCEPTED, "{queued}");
    let id = queued["id"].as_str().unwrap().to_string();
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let view = state.checkpoint_jobs.status();
            if view.active_job_id.is_none() {
                let job = view.jobs.iter().find(|job| job.id == id).unwrap().clone();
                assert_eq!(job.phase, wabi_server::checkpoint_jobs::CheckpointPhase::Ready,
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
