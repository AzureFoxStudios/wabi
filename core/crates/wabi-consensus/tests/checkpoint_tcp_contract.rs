//! Isolated field fixture for real checkpoint ciphertext. This never starts a
//! Wabi Authority/Raft writer, activates recovered data or changes a firewall.
#![cfg(target_os = "linux")]
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::Read,
    net::SocketAddr,
    os::{
        fd::AsRawFd,
        unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    },
    path::{Component, PathBuf},
    sync::{Arc, Condvar, Mutex},
    time::Duration,
};
use tokio::{net::TcpListener, sync::oneshot};
use wabi_consensus::{
    material::{CheckpointManifest, MaterialLimits, MaterialStore},
    model::{RecoveryPeer, StoreBinding},
    transport::{serve_checkpoint, CheckpointClient, Config, Identity, Limits, MaterialService},
};
const NOFOLLOW: i32 = 0x20000;
const PURPOSE: &str = "wabi-disposable-checkpoint-ciphertext-v1";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Bootstrap {
    schema_version: u8,
    purpose: String,
    owner: String,
    node_id: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Fixture {
    schema_version: u8,
    purpose: String,
    owner: String,
    binding: StoreBinding,
    peers: BTreeMap<u64, RecoveryPeer>,
    bind_address: SocketAddr,
    source_node: String,
    manifest_sha256: String,
    lifetime_seconds: u64,
}
fn hex64(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
impl Fixture {
    fn validate(&self, owner: &str) {
        assert_eq!(self.schema_version, 1);
        assert_eq!(self.purpose, PURPOSE);
        assert_eq!(self.owner, owner);
        assert!(hex64(owner) && hex64(&self.manifest_sha256));
        assert!((1..=3).contains(&self.binding.node_id));
        assert_eq!(self.peers.keys().copied().collect::<Vec<_>>(), [1, 2, 3]);
        assert!(!self.source_node.is_empty() && self.source_node.len() <= 256);
        assert!((30..=300).contains(&self.lifetime_seconds));
        assert_eq!(
            self.peers[&self.binding.node_id]
                .rpc_address
                .parse::<SocketAddr>()
                .unwrap(),
            self.bind_address
        );
    }
}
struct Root {
    path: PathBuf,
    directory: File,
    owner: String,
}
impl Root {
    fn from_environment() -> Self {
        Self::open(
            PathBuf::from(std::env::var_os("WABI_CHECKPOINT_FIXTURE_ROOT").unwrap()),
            std::env::var("WABI_CHECKPOINT_FIXTURE_OWNER").unwrap(),
        )
    }
    fn open(path: PathBuf, owner: String) -> Self {
        assert!(hex64(&owner));
        assert!(path.is_absolute());
        assert!(!path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir)));
        for ancestor in path.ancestors() {
            assert!(!fs::symlink_metadata(ancestor)
                .unwrap()
                .file_type()
                .is_symlink());
        }
        let directory = OpenOptions::new()
            .read(true)
            .custom_flags(NOFOLLOW)
            .open(&path)
            .unwrap();
        let root = Self {
            path,
            directory,
            owner,
        };
        root.verify();
        root
    }
    fn pinned(&self) -> PathBuf {
        PathBuf::from(format!("/proc/self/fd/{}", self.directory.as_raw_fd()))
    }
    fn verify(&self) {
        let named = fs::symlink_metadata(&self.path).unwrap();
        let held = self.directory.metadata().unwrap();
        assert!(named.is_dir() && !named.file_type().is_symlink());
        assert_eq!((named.dev(), named.ino()), (held.dev(), held.ino()));
        assert_eq!(named.uid(), fs::metadata("/proc/self").unwrap().uid());
        assert_eq!(named.mode() & 0o077, 0);
    }
    fn read(&self, name: &str, cap: u64) -> Vec<u8> {
        self.verify();
        let path = self.pinned().join(name);
        let named = fs::symlink_metadata(&path).unwrap();
        assert!(named.is_file());
        assert_eq!(named.nlink(), 1);
        assert_eq!(named.mode() & 0o077, 0);
        assert_eq!(named.uid(), fs::metadata("/proc/self").unwrap().uid());
        assert!(named.len() <= cap);
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(NOFOLLOW)
            .open(&path)
            .unwrap();
        let before = file.metadata().unwrap();
        assert_eq!((named.dev(), named.ino()), (before.dev(), before.ino()));
        let mut bytes = Vec::new();
        file.take(cap + 1).read_to_end(&mut bytes).unwrap();
        assert!(bytes.len() as u64 <= cap);
        let after = fs::symlink_metadata(&path).unwrap();
        assert_eq!(
            (
                before.dev(),
                before.ino(),
                before.len(),
                before.mtime(),
                before.mtime_nsec(),
                before.ctime(),
                before.ctime_nsec()
            ),
            (
                after.dev(),
                after.ino(),
                after.len(),
                after.mtime(),
                after.mtime_nsec(),
                after.ctime(),
                after.ctime_nsec()
            )
        );
        self.verify();
        bytes
    }
    fn fixture(&self) -> Fixture {
        let fixture: Fixture =
            serde_json::from_slice(&self.read("fixture.json", 16 * 1024)).unwrap();
        fixture.validate(&self.owner);
        fixture
    }
    fn material(&self, binding: StoreBinding) -> MaterialStore {
        let path = self.path.join("material");
        match fs::create_dir(&path) {
            Ok(()) => fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap(),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(e) => panic!("private material directory: {e}"),
        }
        let store = MaterialStore::open(
            &path,
            binding,
            MaterialLimits {
                min_free_bytes: 64 * 1024 * 1024,
                ..Default::default()
            },
        )
        .unwrap();
        self.verify();
        store
    }
}
// An OS watchdog belongs to this disposable child only. Normal completion joins
// it; a stalled syscall can produce exit124, never a successful transfer marker.
struct Watchdog(
    Arc<(Mutex<bool>, Condvar)>,
    Option<std::thread::JoinHandle<()>>,
);
impl Watchdog {
    fn start(seconds: u64) -> Self {
        let state = Arc::new((Mutex::new(false), Condvar::new()));
        let child = state.clone();
        let thread = std::thread::spawn(move || {
            let (lock, cond) = &*child;
            let (done, _) = cond
                .wait_timeout_while(lock.lock().unwrap(), Duration::from_secs(seconds), |done| {
                    !*done
                })
                .unwrap();
            if !*done {
                std::process::exit(124);
            }
        });
        Self(state, Some(thread))
    }
}
impl Drop for Watchdog {
    fn drop(&mut self) {
        let (lock, cond) = &*self.0;
        *lock.lock().unwrap() = true;
        cond.notify_all();
        self.1.take().unwrap().join().unwrap();
    }
}

#[test]
#[ignore = "private disposable field fixture; prints only public Noise identity"]
fn checkpoint_identity_bootstrap() {
    let root = Root::from_environment();
    let bootstrap: Bootstrap = serde_json::from_slice(&root.read("bootstrap.json", 1024)).unwrap();
    assert_eq!(bootstrap.schema_version, 1);
    assert_eq!(bootstrap.purpose, PURPOSE);
    assert_eq!(bootstrap.owner, root.owner);
    assert!((1..=3).contains(&bootstrap.node_id));
    for entry in fs::read_dir(root.pinned()).unwrap() {
        let name = entry.unwrap().file_name();
        assert!(name == "bootstrap.json" || name == "probe.bin");
    }
    let identity = Identity::generate().unwrap();
    identity.persist_new(&root.path).unwrap();
    root.verify();
    println!(
        "WABI_CHECKPOINT_PUBLIC_V1 {}",
        serde_json::json!({
            "schemaVersion": 1, "nodeId": bootstrap.node_id, "publicKey": identity.public_hex()
        })
    );
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Outcome {
    schema_version: u8,
    purpose: &'static str,
    node_id: u64,
    action: String,
    manifest_sha256: String,
    receipt: serde_json::Value,
    canonical_writer_permitted: bool,
}
fn target(fixture: &Fixture) -> u64 {
    let target: u64 = std::env::var("WABI_CHECKPOINT_FIXTURE_TARGET")
        .unwrap()
        .parse()
        .unwrap();
    assert!(fixture.peers.contains_key(&target));
    assert_ne!(target, fixture.binding.node_id);
    target
}
#[test]
#[ignore = "bounded disposable field worker; requires an exact enrolled roster"]
fn checkpoint_ciphertext_worker() {
    let watchdog = Watchdog::start(330);
    let root = Root::from_environment();
    let fixture = root.fixture();
    let action = std::env::var("WABI_CHECKPOINT_FIXTURE_ACTION").unwrap();
    assert!(
        ["serve", "seed", "push", "pull", "receipt", "remote_receipt"].contains(&action.as_str())
    );
    assert_eq!(root.read("recovery.key", 32).len(), 32);
    let identity = Arc::new(Identity::load(&root.path).unwrap());
    let config = Arc::new(
        Config::new(
            fixture.binding.clone(),
            fixture.peers.clone(),
            identity,
            Limits::default(),
        )
        .unwrap(),
    );
    root.verify();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let result = runtime.block_on(async {
        let id = fixture.manifest_sha256.clone();
        let source = fixture.source_node.clone();
        let receipt = if action == "serve" {
            let store = root.material(fixture.binding.clone());
            let service = MaterialService::new(store, &config, source, 1).unwrap();
            let listener = TcpListener::bind(fixture.bind_address).await.unwrap();
            let (stop, stopped) = oneshot::channel();
            let server = tokio::spawn(serve_checkpoint(listener, config, stopped, service));
            println!(
                "WABI_CHECKPOINT_LISTEN_V1 {}",
                serde_json::json!({"nodeId": fixture.binding.node_id, "manifestSha256": id})
            );
            tokio::time::sleep(Duration::from_secs(fixture.lifetime_seconds)).await;
            stop.send(()).unwrap();
            server.await.unwrap().unwrap(); // actual owned blocking IO drains
            serde_json::json!({"serverDrained": true})
        } else if action == "remote_receipt" {
            let client = CheckpointClient::new(config, target(&fixture), source).unwrap();
            let manifest = client.read_manifest(&id).await.unwrap();
            serde_json::to_value(client.fresh_receipt(&manifest).await.unwrap()).unwrap()
        } else {
            // These one-shot commands exclusively own their local MaterialStore.
            // Do not run them beside a local serve child holding that store lock.
            let store = root.material(fixture.binding.clone());
            if action == "seed" {
                assert_eq!(fixture.binding.node_id, 1);
                let manifest: CheckpointManifest =
                    serde_json::from_slice(&root.read("manifest.json", 256 * 1024)).unwrap();
                assert_eq!(manifest.sha256().unwrap(), id);
                let verified = manifest
                    .source
                    .verify(&fixture.binding.community_id, &source)
                    .unwrap();
                let input = root.path.join("ciphertext.age");
                // Actual producer bytes are ingested/hash-checked against the
                // exact signed context. Caller supplies no arbitrary input path.
                let (actual, local) = store
                    .ingest_checkpoint(&input, &verified, Default::default())
                    .unwrap();
                assert_eq!(actual, manifest);
                serde_json::to_value(local).unwrap()
            } else if action == "receipt" {
                serde_json::to_value(store.checkpoint_receipt(&id, &source).unwrap()).unwrap()
            } else {
                let client =
                    CheckpointClient::new(config, target(&fixture), source.clone()).unwrap();
                if action == "push" {
                    let manifest = store.read_checkpoint_manifest(&id, &source).unwrap();
                    store.checkpoint_receipt(&id, &source).unwrap();
                    for index in 0..manifest.objects.len() {
                        let (object, bytes) =
                            store.read_checkpoint_object(&id, &source, index).unwrap();
                        client.put_object(object, &bytes).await.unwrap();
                    }
                    serde_json::to_value(client.certify(&manifest).await.unwrap()).unwrap()
                } else {
                    let manifest = client.read_manifest(&id).await.unwrap();
                    client.fresh_receipt(&manifest).await.unwrap();
                    for (index, object) in manifest.objects.iter().enumerate() {
                        let bytes = client.read_object(&manifest, index).await.unwrap();
                        store.put_object(object, &bytes).unwrap();
                    }
                    serde_json::to_value(store.certify_checkpoint(&manifest, &source).unwrap())
                        .unwrap()
                }
            }
        };
        root.verify();
        Outcome {
            schema_version: 1,
            purpose: PURPOSE,
            node_id: fixture.binding.node_id,
            action,
            manifest_sha256: id,
            receipt,
            canonical_writer_permitted: false,
        }
    });
    // All local IO here is synchronous and owned by this child/runtime. There
    // are no detached spawn_blocking jobs or timed-out success conversions.
    drop(runtime);
    drop(watchdog);
    println!(
        "WABI_CHECKPOINT_RESULT_V1 {}",
        serde_json::to_string(&result).unwrap()
    );
}

#[test]
fn private_root_refuses_symlinks_public_permissions_and_unknown_owner_shape() {
    let dir = tempfile::tempdir().unwrap();
    fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let path = dir.path().to_path_buf();
    let owner = "ab".repeat(32);
    let root = Root::open(path.clone(), owner.clone());
    fs::write(path.join("fixture.json"), b"{}").unwrap();
    fs::set_permissions(path.join("fixture.json"), fs::Permissions::from_mode(0o600)).unwrap();
    assert!(std::panic::catch_unwind(|| root.fixture()).is_err());
    fs::set_permissions(path.join("fixture.json"), fs::Permissions::from_mode(0o644)).unwrap();
    assert!(std::panic::catch_unwind(|| root.read("fixture.json", 16384)).is_err());
    fs::remove_file(path.join("fixture.json")).unwrap();
    std::os::unix::fs::symlink("missing", path.join("fixture.json")).unwrap();
    assert!(std::panic::catch_unwind(|| root.read("fixture.json", 16384)).is_err());
    let link = path.join("linked");
    std::os::unix::fs::symlink(&path, &link).unwrap();
    assert!(std::panic::catch_unwind(|| Root::open(link, owner)).is_err());
}
