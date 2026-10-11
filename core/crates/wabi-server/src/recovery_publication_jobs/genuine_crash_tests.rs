//! Unapplied next fixture: one real collector process is killed; its two
//! encrypted control voters survive in the parent. No replacement writer,
//! HTTP-202 crash, Manifest/Prepared cut, or full-instance HA is claimed.
use super::genuine_restart as fixture;
use crate::{app_router::build_app_router, config::ServerConfig,
    recovery_node::{load, RecoveryNodeConfig}, state::AppState};
use axum::{body::Body, http::StatusCode};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{fs::{self, File, OpenOptions}, io::{Read, Write},
    os::unix::{fs::{MetadataExt, OpenOptionsExt}, process::ExitStatusExt},
    path::{Path, PathBuf}, process::{Child, Command, ExitStatus, Stdio},
    sync::Arc, thread::JoinHandle, time::Duration};
use wabi_consensus::{runtime::{PublicationStage, RecoveryRuntime}, source_context::SignedSourceContext};
use wabidb::{domain::ChannelKind, engine::wabi_store::WabiStore};

const CHILD: &str = "recovery_publication_jobs::tests::genuine_crash::isolated_original_capture_crash_child";
const NOFOLLOW: i32 = 0o400000;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SavedCase {
    config: ServerConfig, secret: String, recipient: String,
    policies: Vec<RecoveryNodeConfig>, capture_id: String, message_id: String,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Debug)]
#[serde(deny_unknown_fields)]
struct OriginalFile { identity: (u64, u64), sha256: String }
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SyncedCut {
    capture_id: String, operation_id: String, engine_lock: (u64, u64),
    collector_pid: u32, collector_start_ticks: u64,
    source: OriginalFile, archive: OriginalFile, intent: OriginalFile,
    owner_lock: (u64, u64), control_lock: (u64, u64), material_lock: (u64, u64),
}

fn process_start_ticks(pid: u32) -> u64 {
    let raw = fs::read_to_string(format!("/proc/{pid}/stat")).unwrap();
    raw.rsplit_once(')').unwrap().1.split_whitespace().nth(19).unwrap().parse().unwrap()
}
fn uid() -> u32 { fs::metadata("/proc/self").unwrap().uid() }
fn private_case(path: &Path) {
    let m = fs::symlink_metadata(path).unwrap();
    assert!(path.is_absolute() && m.is_dir() && !m.file_type().is_symlink());
    assert_eq!(m.uid(), uid());
    assert_eq!(m.mode() & 0o077, 0);
    for ancestor in path.ancestors() {
        assert!(!fs::symlink_metadata(ancestor).unwrap().file_type().is_symlink());
    }
}
fn read_private(path: &Path, cap: usize) -> Vec<u8> {
    private_case(path.parent().unwrap());
    let mut file = OpenOptions::new().read(true).custom_flags(NOFOLLOW).open(path).unwrap();
    let m = file.metadata().unwrap();
    assert!(m.is_file() && m.nlink() == 1 && m.uid() == uid() && m.mode() & 0o077 == 0);
    assert!(m.len() <= cap as u64);
    let mut bytes = Vec::new();
    (&mut file).take(cap as u64 + 1).read_to_end(&mut bytes).unwrap();
    let key = |m: &fs::Metadata| (m.dev(), m.ino(), m.len(), m.uid(), m.mode(), m.nlink(),
        m.mtime(), m.mtime_nsec(), m.ctime(), m.ctime_nsec());
    assert_eq!(bytes.len() as u64, m.len());
    assert_eq!(key(&m), key(&file.metadata().unwrap()));
    assert_eq!(key(&m), key(&fs::symlink_metadata(path).unwrap()));
    bytes
}
fn write_private<T: Serialize>(path: &Path, value: &T) {
    private_case(path.parent().unwrap());
    let mut file = OpenOptions::new().write(true).create_new(true).mode(0o600)
        .custom_flags(NOFOLLOW).open(path).unwrap();
    file.write_all(&serde_json::to_vec(value).unwrap()).unwrap();
    file.sync_all().unwrap();
    File::open(path.parent().unwrap()).unwrap().sync_all().unwrap();
    // Readers wait for this separate empty ready name. The immutable data and
    // its directory are already synced before the ready name can be observed;
    // seeing the destination during its initial write is never a handshake.
    let ready = ready_name(path);
    let flag = OpenOptions::new().write(true).create_new(true).mode(0o600)
        .custom_flags(NOFOLLOW).open(ready).unwrap();
    flag.sync_all().unwrap();
    File::open(path.parent().unwrap()).unwrap().sync_all().unwrap();
}
fn ready_name(path: &Path) -> PathBuf {
    path.with_file_name(format!("{}.ready", path.file_name().unwrap().to_str().unwrap()))
}
fn observed(path: &Path) -> OriginalFile {
    let identity = fixture::inode(path);
    let bytes = read_private(path, 64 * 1024 * 1024);
    assert_eq!(fixture::inode(path), identity);
    OriginalFile { identity, sha256: hex::encode(Sha256::digest(bytes)) }
}
fn install_environment(root: &Path, secret: &str, recipient: &str) -> fixture::Environment {
    let mut env = fixture::Environment::new();
    env.set("WABI_OPERATOR_SECRET", secret);
    env.set("WABI_CHECKPOINT_DIR", root.join("checkpoints"));
    env.set("WABI_CHECKPOINT_RECIPIENT", recipient);
    env.set("WABI_CHECKPOINT_SOURCE_CONTEXT", "1");
    for (name, value) in [
        ("WABI_CHECKPOINT_DRAIN_SECONDS", "3"), ("WABI_CHECKPOINT_COPY_SECONDS", "10"),
        ("WABI_CHECKPOINT_MAX_ENTRIES", "10000"), ("WABI_CHECKPOINT_MAX_BYTES", "33554432"),
        ("WABI_CHECKPOINT_MAX_PATH_BYTES", "1048576"), ("WABI_CHECKPOINT_STORAGE_BYTES", "268435456"),
        ("WABI_CHECKPOINT_MIN_FREE_BYTES", "67108864")
    ] { env.set(name, value); }
    env
}

struct OwnedChild {
    child: Child, original_start_ticks: u64, output: Option<JoinHandle<Vec<u8>>>, errors: Option<JoinHandle<Vec<u8>>>,
}
impl OwnedChild {
    fn start(root: &Path, mode: &str) -> Self {
        private_case(root);
        let mut command = Command::new(std::env::current_exe().unwrap());
        command.args([CHILD, "--ignored", "--exact", "--test-threads=1", "--nocapture"])
            .env_clear().stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        for name in ["HOME", "USER", "LOGNAME", "PATH", "LANG", "TZ", "TMPDIR"] {
            if let Some(value) = std::env::var_os(name) { command.env(name, value); }
        }
        command.env("WABI_TEST_ORIGINAL_CRASH_ROOT", root).env("WABI_TEST_ORIGINAL_CRASH_MODE", mode);
        let mut child = command.spawn().unwrap();
        let read = |stream: Box<dyn Read + Send>| std::thread::spawn(move || {
            let mut bytes = Vec::new();
            stream.take(4 * 1024 * 1024 + 1).read_to_end(&mut bytes).unwrap();
            bytes
        });
        let output = read(Box::new(child.stdout.take().unwrap()));
        let errors = read(Box::new(child.stderr.take().unwrap()));
        let original_start_ticks = process_start_ticks(child.id());
        Self { child, original_start_ticks, output: Some(output), errors: Some(errors) }
    }
    async fn marker(&mut self, path: &Path) -> Vec<u8> {
        tokio::time::timeout(Duration::from_secs(35), async {
            loop {
                assert!(self.child.try_wait().unwrap().is_none(), "fixture exited before synced cut");
                if fs::symlink_metadata(ready_name(path)).is_ok() {
                    assert!(read_private(&ready_name(path), 0).is_empty());
                    return read_private(path, 512 * 1024);
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.expect("original child marker deadline")
    }
    fn evidence(&mut self, label: &str, status: ExitStatus) -> Vec<u8> {
        let output = self.output.take().unwrap().join().unwrap();
        let errors = self.errors.take().unwrap().join().unwrap();
        writeln!(std::io::stdout().lock(),
            "isolated crash {label} stdoutBase64={} stderrBase64={} exit={:?} signal={:?}",
            base64::engine::general_purpose::STANDARD.encode(&output),
            base64::engine::general_purpose::STANDARD.encode(&errors), status.code(), status.signal()).unwrap();
        assert!(output.len() <= 4 * 1024 * 1024 && errors.len() <= 4 * 1024 * 1024);
        output
    }
    fn kill_at_synced_cut(&mut self) {
        // Child remains owned and unreaped here; no other waiter owns its PID.
        // Only this exact Child is killed. Outer runner owns full descendants.
        assert!(self.child.try_wait().unwrap().is_none());
        assert_eq!(process_start_ticks(self.child.id()), self.original_start_ticks);
        self.child.kill().unwrap();
        let status = self.child.wait().unwrap();
        let output = self.evidence("seed", status);
        assert!(!String::from_utf8_lossy(&output).contains("test result:"),
            "seed helper reached a terminal libtest verdict before original SIGKILL");
        assert_eq!(status.signal(), Some(9));
    }
    async fn finish(&mut self) {
        let status = tokio::time::timeout(Duration::from_secs(90), async {
            loop {
                if let Some(status) = self.child.try_wait().unwrap() { return status; }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.expect("reopened child direct wait deadline");
        let output = self.evidence("follower-reopen", status);
        assert!(status.success());
        let text = String::from_utf8(output).unwrap();
        let verdicts: Vec<_> = text.lines().filter(|line| line.starts_with("test result:")).collect();
        assert_eq!(verdicts.len(), 1);
        assert!(verdicts[0].starts_with("test result: ok. 1 passed; 0 failed; 0 ignored;"));
        assert!(text.contains("isolated_original_capture_crash_child ... ok"));
    }
}
impl Drop for OwnedChild {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
        // On failed tests reader/descendant ownership is not declared drained.
        // Original fixture Root retains scratch; outer owned runner must prove
        // actual terminal descendants before cleanup. Pipe joins are not a
        // universal ninety-second deadline.
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actual_collector_sigkill_reopens_original_capture_on_follower_without_canonical_writer_permission() {
    let root = fixture::Root::new();
    let case_root = root.path().join("case");
    fixture::private(&case_root);
    let mut seed = OwnedChild::start(&case_root, "seed");
    let saved: SavedCase = serde_json::from_slice(&seed.marker(&case_root.join("case.json")).await).unwrap();
    let mut followers = Vec::new();
    for policy in &saved.policies[1..] {
        let path = policy.control_directory.parent().unwrap().join("node.json");
        write_private(&path, policy);
        followers.push(RecoveryRuntime::start(load(&path).unwrap()).await.unwrap());
    }
    write_private(&case_root.join("start-collector.json"), &json!({"go":true}));
    let cut: SyncedCut = serde_json::from_slice(&seed.marker(&case_root.join("synced-cut.json")).await).unwrap();
    assert_eq!(cut.collector_pid, seed.child.id());
    assert_eq!(cut.collector_start_ticks, seed.original_start_ticks);
    assert_eq!(process_start_ticks(seed.child.id()), cut.collector_start_ticks);
    assert_eq!(cut.capture_id, saved.capture_id);
    assert_eq!(cut.operation_id, uuid::Uuid::parse_str(&saved.capture_id).unwrap().simple().to_string());
    fixture::leader(&followers, Some(1)).await;
    for node in &followers { assert!(node.control_state().await.unwrap().checkpoints.is_empty()); }
    seed.kill_at_synced_cut();
    writeln!(std::io::stdout().lock(), "original collector crash cutBase64={}",
        base64::engine::general_purpose::STANDARD.encode(serde_json::to_vec(&cut).unwrap())).unwrap();
    let policy = &saved.policies[0];
    let engine = Path::new(&saved.config.data_dir).join("wabidb/.lock");
    {
        let _engine = fixture::stopped_lock(&engine).await;
        let _owner = fixture::stopped_lock(&policy.control_directory.join(".runtime.lock")).await;
        let _control = fixture::stopped_lock(&policy.control_directory.join(".lock")).await;
        let _material = fixture::stopped_lock(&policy.material_directory.join(".lock")).await;
        assert_eq!(fixture::inode(&engine), cut.engine_lock);
        assert_eq!(fixture::inode(&policy.control_directory.join(".runtime.lock")), cut.owner_lock);
        assert_eq!(fixture::inode(&policy.control_directory.join(".lock")), cut.control_lock);
        assert_eq!(fixture::inode(&policy.material_directory.join(".lock")), cut.material_lock);
    }
    let actual_survivor = fixture::leader_from_allowed(&followers, &[2,3]).await;
    assert!(actual_survivor == 2 || actual_survivor == 3);
    let mut reopened = OwnedChild::start(&case_root, "follower-reopen");
    reopened.finish().await;
    let report: serde_json::Value = serde_json::from_slice(&read_private(&case_root.join("follower-refusal.json"), 512 * 1024)).unwrap();
    assert_eq!(report["originalOperationId"], cut.operation_id);
    assert_eq!(report["actualNodeId"], 1);
    assert!(report["actualLeaderId"] == 2 || report["actualLeaderId"] == 3);
    assert_eq!(report["httpRefusal"], 503);
    for name in ["fullInstanceReady", "canonicalWriterPermitted", "replacementAuthorityActivated"] {
        assert_eq!(report[name], false);
    }
    for node in &followers { assert!(node.control_state().await.unwrap().checkpoints.is_empty()); }
    writeln!(std::io::stdout().lock(), "original collector follower refusalBase64={}",
        base64::engine::general_purpose::STANDARD.encode(serde_json::to_vec(&report).unwrap())).unwrap();
    for node in followers { node.shutdown().await.unwrap(); }
    root.completed();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "isolated crash/reopen helper; requires exact owned parent fixture"]
async fn isolated_original_capture_crash_child() {
    let root = PathBuf::from(std::env::var_os("WABI_TEST_ORIGINAL_CRASH_ROOT").unwrap());
    private_case(&root);
    match std::env::var("WABI_TEST_ORIGINAL_CRASH_MODE").unwrap().as_str() {
        "seed" => seed_original(&root).await,
        "follower-reopen" => reopen_original(&root).await,
        _ => panic!("unknown isolated fixture mode"),
    }
}

async fn seed_original(root: &Path) {
    let secret = uuid::Uuid::new_v4().simple().to_string();
    let recipient = age::x25519::Identity::generate().to_public().to_string();
    fixture::private(&root.join("checkpoints"));
    let mut env = install_environment(root, &secret, &recipient);
    let config = fixture::config(root);
    let initial = Arc::new(AppState::new(config.clone()).await.unwrap());
    let app = build_app_router(initial.clone());
    let user = initial.wdb.create_user("crash_owner", None, "generated-fixture-hash").await.unwrap();
    initial.claim_ownership(user as i64, "crash_owner").await.unwrap();
    let channel = initial.wdb.create_channel("Original crash", ChannelKind::Text, user, false).await.unwrap();
    let message_id = initial.wdb.send_message(&channel, user, "original crash content", false, &[]).await.unwrap();
    let capture = fixture::capture(&app, &initial, &secret).await;
    let community = initial.community_roster.community_id().to_string();
    fixture::halt(initial, app, None).await;
    let policies = fixture::policies(root, &community, &config.node_id);
    let saved = SavedCase { config: config.clone(), secret: secret.clone(), recipient,
        policies: policies.clone(), capture_id: capture.id.clone(), message_id };
    write_private(&root.join("case.json"), &saved);
    tokio::time::timeout(Duration::from_secs(35), async {
        while !ready_name(&root.join("start-collector.json")).exists() { tokio::time::sleep(Duration::from_millis(10)).await; }
    }).await.expect("parent did not start actual followers");
    assert!(read_private(&ready_name(&root.join("start-collector.json")), 0).is_empty());
    assert_eq!(serde_json::from_slice::<serde_json::Value>(&read_private(&root.join("start-collector.json"), 1024)).unwrap(), json!({"go":true}));
    let policy_path = root.join("publisher.json");
    write_private(&policy_path, &policies[0]);
    env.set("WABI_RECOVERY_PUBLISHER_CONFIG", &policy_path);
    let state = Arc::new(AppState::new(config).await.unwrap());
    let publisher = state.recovery_publication.as_ref().unwrap();
    let held = state.checkpoint_jobs.held_ready_capture(capture.id.clone(), community,
        state.config.node_id.clone(), 64 * 1024 * 1024, Duration::from_secs(10)).await.unwrap();
    let operation = uuid::Uuid::parse_str(&capture.id).unwrap().simple().to_string();
    {
        let runtime = publisher.inner.runtime.lock().await;
        let node = runtime.as_ref().unwrap();
        tokio::time::timeout(Duration::from_secs(15), async {
            while node.status().leader_node_id != Some(1) || !node.status().membership_ready {
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }).await.unwrap();
        node.record_capture_intent(operation.clone(), held.context.clone()).await.unwrap();
        while node.local_job_active() { tokio::time::sleep(Duration::from_millis(1)).await; }
        let pending = node.pending_publication_operations().await.unwrap();
        while node.local_job_active() { tokio::time::sleep(Duration::from_millis(1)).await; }
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].operation_id, operation);
        assert_eq!(pending[0].stage, PublicationStage::Capture);
    }
    let checkpoints = root.join("checkpoints");
    let cut = SyncedCut { capture_id: capture.id.clone(), operation_id: operation.clone(),
        collector_pid: std::process::id(), collector_start_ticks: process_start_ticks(std::process::id()),
        engine_lock: fixture::inode(&Path::new(&state.config.data_dir).join("wabidb/.lock")),
        source: observed(&checkpoints.join(format!("{}.source-context.json", capture.id))),
        archive: observed(&checkpoints.join(format!("{}.age", capture.id))),
        intent: observed(&policies[0].control_directory.join(format!("publication-{operation}-capture.json"))),
        owner_lock: fixture::inode(&policies[0].control_directory.join(".runtime.lock")),
        control_lock: fixture::inode(&policies[0].control_directory.join(".lock")),
        material_lock: fixture::inode(&policies[0].material_directory.join(".lock")) };
    write_private(&root.join("synced-cut.json"), &cut);
    // Retain actual Authority/Ready/File owners while the parent SIGKILLs this
    // process. This is a test-only synced-intent cut before router attachment.
    let _retained = (state, held);
    tokio::time::sleep(Duration::from_secs(60)).await;
    panic!("parent did not kill the original collector at its synced cut");
}

async fn reopen_original(root: &Path) {
    let saved: SavedCase = serde_json::from_slice(&read_private(&root.join("case.json"), 512 * 1024)).unwrap();
    let cut: SyncedCut = serde_json::from_slice(&read_private(&root.join("synced-cut.json"), 512 * 1024)).unwrap();
    let mut env = install_environment(root, &saved.secret, &saved.recipient);
    let mut policy = saved.policies[0].clone();
    policy.initialize = false;
    let policy_path = root.join("publisher-reopen.json");
    write_private(&policy_path, &policy);
    env.set("WABI_RECOVERY_PUBLISHER_CONFIG", &policy_path);
    let state = Arc::new(AppState::new(saved.config.clone()).await.unwrap());
    assert_eq!(state.wdb.get_message_typed(&saved.message_id).await.unwrap().unwrap().content,
        "original crash content");
    let source: SignedSourceContext = serde_json::from_slice(&read_private(
        &root.join("checkpoints").join(format!("{}.source-context.json", saved.capture_id)), 512 * 1024)).unwrap();
    source.verify(state.community_roster.community_id(), &saved.config.node_id).unwrap();
    let publisher = state.recovery_publication.as_ref().unwrap();
    let actual_leader;
    {
        let runtime = publisher.inner.runtime.lock().await;
        let node = runtime.as_ref().unwrap();
        actual_leader = tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let view = node.status();
                if view.accepting && view.membership_ready && matches!(view.leader_node_id, Some(2 | 3)) {
                    break view.leader_node_id.unwrap();
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }).await.unwrap();
        let pending = node.pending_publication_operations().await.unwrap();
        while node.local_job_active() { tokio::time::sleep(Duration::from_millis(1)).await; }
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].operation_id, cut.operation_id);
        assert_eq!(pending[0].stage, PublicationStage::Capture);
        assert!(node.control_state().await.unwrap().checkpoints.is_empty());
    }
    let app = build_app_router(state.clone());
    let before = fixture::status(&app, &saved.secret).await;
    assert_eq!(before["accepting"], true);
    assert_eq!(before["jobs"], json!([]));
    let (code, _) = fixture::request(&app, "POST", fixture::PUBLICATIONS, "127.0.0.1:33001",
        Some(&saved.secret), Body::from(json!({"captureJobId":saved.capture_id}).to_string())).await;
    assert_eq!(code, StatusCode::SERVICE_UNAVAILABLE);
    let refused = fixture::finished(&app, &saved.secret, &saved.capture_id).await;
    assert_eq!(refused["phase"], "failed");
    assert_eq!(refused["failureCode"], "publication_indeterminate");
    assert!(refused["historicalReceipt"].is_null());
    state.recovery_publication.as_ref().unwrap().shutdown().await.unwrap();
    state.recovery_publication.as_ref().unwrap().shutdown().await.unwrap();
    let checkpoints = root.join("checkpoints");
    assert_eq!(observed(&checkpoints.join(format!("{}.source-context.json", saved.capture_id))), cut.source);
    assert_eq!(observed(&checkpoints.join(format!("{}.age", saved.capture_id))), cut.archive);
    assert_eq!(observed(&policy.control_directory.join(format!("publication-{}-capture.json", cut.operation_id))), cut.intent);
    fixture::halt(state, app, Some(&policy)).await;
    assert_eq!(fixture::inode(&Path::new(&saved.config.data_dir).join("wabidb/.lock")), cut.engine_lock);
    assert_eq!(fixture::inode(&policy.control_directory.join(".runtime.lock")), cut.owner_lock);
    assert_eq!(fixture::inode(&policy.control_directory.join(".lock")), cut.control_lock);
    assert_eq!(fixture::inode(&policy.material_directory.join(".lock")), cut.material_lock);
    assert!(fixture::recorded(&policy).await.as_object().unwrap().is_empty());
    write_private(&root.join("follower-refusal.json"), &json!({
        "originalOperationId":cut.operation_id, "actualNodeId":1,
        "actualLeaderId":actual_leader, "httpRefusal":503,
        "fullInstanceReady":false, "canonicalWriterPermitted":false,
        "replacementAuthorityActivated":false,
        "scope":"Actual original collector SIGKILL and follower reopen; no HTTP202 crash or Manifest/Prepared cut"}));
}
