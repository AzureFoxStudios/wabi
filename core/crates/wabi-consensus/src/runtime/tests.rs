use super::*;
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use sha2::{Digest, Sha256};
use std::{
    io::{Seek, SeekFrom},
    os::unix::fs::{symlink, PermissionsExt},
};

fn private(path: &Path) {
    fs::create_dir(path).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}
fn build_policy(root: &Path) -> RuntimePolicy {
    let mut peers = BTreeMap::new();
    let mut reservations = Vec::new();
    for id in 1..=3 {
        let key = Identity::generate().unwrap();
        let address = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        peers.insert(
            id,
            RecoveryPeer {
                protocol: crate::model::CONTROL_PROTOCOL,
                community_id: "ab".repeat(32),
                site_id: format!("site-{id}"),
                public_key: key.public_hex(),
                rpc_address: address.local_addr().unwrap().to_string(),
            },
        );
        if id == 1 {
            private(&root.join("identity"));
            key.persist_new(&root.join("identity")).unwrap();
        }
        reservations.push(address);
    }
    private(&root.join("control"));
    private(&root.join("material"));
    RuntimePolicy {
        binding: StoreBinding {
            community_id: "ab".repeat(32),
            partition_id: "community/control".into(),
            node_id: 1,
        },
        peers,
        source_node_id: "source-node".into(),
        identity_directory: root.join("identity"),
        control_directory: root.join("control"),
        material_directory: root.join("material"),
        bind_address: None,
        initialize: false,
        control_limits: StoreLimits {
            min_free_bytes: 1,
            ..Default::default()
        },
        material_limits: MaterialLimits {
            min_free_bytes: 1,
            ..Default::default()
        },
        transport_limits: Limits::default(),
        work_timeout: Duration::from_secs(10),
    }
}

fn signed_capture_policy(root: &Path, context: &SignedSourceContext) -> RuntimePolicy {
    let mut policy = build_policy(root);
    policy.binding.community_id = context.claims.community_id.clone();
    policy.source_node_id = context.claims.source_node_id.clone();
    for peer in policy.peers.values_mut() {
        peer.community_id = policy.binding.community_id.clone();
    }
    policy
}
async fn wait_finished_local_job(runtime: &RecoveryRuntime) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let done = runtime
                .inner
                .worker
                .lock()
                .unwrap()
                .as_ref()
                .is_none_or(JoinHandle::is_finished);
            if done {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}
fn resign_fixture(context: &mut SignedSourceContext, key_byte: u8) {
    let key = SigningKey::from_slice(&[key_byte; 32]).unwrap();
    context.public_key = hex::encode(key.verifying_key().to_encoded_point(false).as_bytes());
    context.claims.community_id =
        hex::encode(Sha256::digest(hex::decode(&context.public_key).unwrap()));
    let signature: Signature =
        key.sign(&crate::source_context::signing_input(&context.claims).unwrap());
    context.signature = hex::encode(signature.normalize_s().unwrap_or(signature).to_bytes());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn owned_capture_file_uses_signed_binding_and_reopens_durable_material_after_shutdown() {
    let root = tempfile::Builder::new()
        .permissions(fs::Permissions::from_mode(0o700))
        .tempdir()
        .unwrap();
    // Current 64 KiB transfer chunks: exercise a complete and a partial chunk.
    let bytes = vec![b'x'; 64 * 1024 + 31];
    let context = crate::source_context::tests::fixture(&bytes);
    let policy = signed_capture_policy(root.path(), &context);
    let archive = root.path().join("capture.age");
    fs::write(&archive, &bytes).unwrap();
    fs::set_permissions(&archive, fs::Permissions::from_mode(0o600)).unwrap();
    let directory = File::open(root.path()).unwrap();
    let pinned = PathBuf::from(format!(
        "/proc/self/fd/{}/capture.age",
        directory.as_raw_fd()
    ));
    let mut file = File::open(&pinned).unwrap();
    file.seek(SeekFrom::Start(bytes.len() as u64 + 17)).unwrap();
    let runtime = RecoveryRuntime::start(policy.clone()).await.unwrap();
    let lock = fs::metadata(policy.control_directory.join(OWNER_LOCK))
        .unwrap()
        .ino();
    let material_lock = fs::metadata(policy.material_directory.join(".lock"))
        .unwrap()
        .ino();
    let manifest = runtime
        .ingest_capture_file(file, context.clone())
        .await
        .unwrap();
    assert_eq!(manifest.source, context);
    assert_eq!(manifest.objects.len(), 2);
    assert!(!runtime.status().full_instance_ready);
    assert!(!runtime.status().canonical_writer_permitted);
    runtime.shutdown().await.unwrap();
    let material = MaterialStore::open(
        &policy.material_directory,
        policy.binding.clone(),
        policy.material_limits.clone(),
    )
    .unwrap();
    let receipt = material
        .checkpoint_receipt(&manifest.sha256().unwrap(), &policy.source_node_id)
        .unwrap();
    let view = serde_json::to_value(receipt).unwrap();
    assert_eq!(view["requiredBytes"], bytes.len());
    assert_eq!(view["fullInstanceReady"], false);
    assert_eq!(view["canonicalWriterPermitted"], false);
    assert_eq!(
        fs::metadata(policy.material_directory.join(".lock"))
            .unwrap()
            .ino(),
        material_lock
    );
    drop(material);
    let reopened = RecoveryRuntime::start(policy.clone()).await.unwrap();
    reopened.shutdown().await.unwrap();
    assert_eq!(
        fs::metadata(policy.control_directory.join(OWNER_LOCK))
            .unwrap()
            .ino(),
        lock
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn owned_capture_file_refuses_bad_signature_unsafe_file_and_busy_job_without_escape() {
    let root = tempfile::Builder::new()
        .permissions(fs::Permissions::from_mode(0o700))
        .tempdir()
        .unwrap();
    let context = crate::source_context::tests::fixture(b"opaque");
    let policy = signed_capture_policy(root.path(), &context);
    let archive = root.path().join("capture.age");
    fs::write(&archive, b"opaque").unwrap();
    fs::set_permissions(&archive, fs::Permissions::from_mode(0o600)).unwrap();
    let runtime = Arc::new(RecoveryRuntime::start(policy.clone()).await.unwrap());
    let mut bad = context.clone();
    bad.signature.replace_range(
        0..1,
        if bad.signature.starts_with('0') {
            "1"
        } else {
            "0"
        },
    );
    assert_eq!(
        runtime
            .ingest_capture_file(File::open(&archive).unwrap(), bad)
            .await,
        Err(RuntimeError::Refused)
    );
    let mut wrong = context.clone();
    wrong.claims.source_node_id = "another-source".into();
    resign_fixture(&mut wrong, 7);
    wrong
        .verify(&wrong.claims.community_id, "another-source")
        .unwrap();
    assert_eq!(
        runtime
            .ingest_capture_file(File::open(&archive).unwrap(), wrong)
            .await,
        Err(RuntimeError::Refused)
    );
    let mut foreign = context.clone();
    resign_fixture(&mut foreign, 8);
    foreign
        .verify(&foreign.claims.community_id, "node-1")
        .unwrap();
    assert_eq!(
        runtime
            .ingest_capture_file(File::open(&archive).unwrap(), foreign)
            .await,
        Err(RuntimeError::Refused)
    );
    fs::set_permissions(&archive, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(
        runtime
            .ingest_capture_file(File::open(&archive).unwrap(), context.clone())
            .await,
        Err(RuntimeError::Refused)
    );
    wait_finished_local_job(&runtime).await;
    assert!(runtime.status().accepting);
    fs::set_permissions(&archive, fs::Permissions::from_mode(0o600)).unwrap();
    let (entered, entered_rx) = oneshot::channel();
    let (release, released) = oneshot::channel();
    let owner = runtime.clone();
    let held_job = tokio::spawn(async move {
        owner
            .run_job(async move {
                entered.send(()).unwrap();
                released.await.unwrap();
                Ok(())
            })
            .await
    });
    entered_rx.await.unwrap();
    assert_eq!(
        runtime
            .ingest_capture_file(File::open(&archive).unwrap(), context.clone())
            .await,
        Err(RuntimeError::Busy)
    );
    release.send(()).unwrap();
    held_job.await.unwrap().unwrap();
    wait_finished_local_job(&runtime).await;
    runtime
        .ingest_capture_file(File::open(archive).unwrap(), context)
        .await
        .unwrap();
    let runtime = Arc::try_unwrap(runtime).ok().unwrap();
    runtime.shutdown().await.unwrap();
}

#[test]
fn preflight_refuses_alias_symlink_unowned_key_and_invalid_source_before_enrollment() {
    let root = tempfile::tempdir().unwrap();
    let policy = build_policy(root.path());
    let mut candidate = policy.clone();
    candidate.material_directory = candidate.control_directory.clone();
    assert!(matches!(
        Opened::open(&candidate),
        Err(RuntimeError::Ownership)
    ));
    symlink(&policy.material_directory, root.path().join("alias")).unwrap();
    candidate = policy.clone();
    candidate.material_directory = root.path().join("alias");
    assert!(matches!(
        Opened::open(&candidate),
        Err(RuntimeError::Ownership)
    ));
    candidate = policy.clone();
    candidate.source_node_id.clear();
    assert!(matches!(
        Opened::open(&candidate),
        Err(RuntimeError::Configuration)
    ));
    candidate = policy.clone();
    candidate.initialize = true;
    candidate.binding.node_id = 2;
    assert!(matches!(
        Opened::open(&candidate),
        Err(RuntimeError::Configuration)
    ));
    candidate = policy.clone();
    candidate.work_timeout = Duration::from_secs(31);
    assert!(matches!(
        Opened::open(&candidate),
        Err(RuntimeError::Configuration)
    ));
    fs::set_permissions(
        policy.identity_directory.join("recovery.key"),
        fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    assert!(matches!(
        Opened::open(&policy),
        Err(RuntimeError::Configuration)
    ));
    assert!(!policy.control_directory.join(ENROLLMENT).exists());
}

#[test]
fn enrollment_and_existing_locks_are_immutable_no_implicit_legacy_adoption() {
    let root = tempfile::tempdir().unwrap();
    let policy = build_policy(root.path());
    let opened = Opened::open(&policy).unwrap();
    let enrollment = fs::read(policy.control_directory.join(ENROLLMENT)).unwrap();
    let inode = fs::metadata(policy.control_directory.join(OWNER_LOCK))
        .unwrap()
        .ino();
    assert!(matches!(
        Opened::open(&policy),
        Err(RuntimeError::Ownership)
    ));
    drop(opened);
    let mut changed = policy.clone();
    changed.source_node_id = "another-source".into();
    assert!(matches!(
        Opened::open(&changed),
        Err(RuntimeError::Configuration)
    ));
    changed = policy.clone();
    changed.peers.get_mut(&3).unwrap().site_id = "another-site".into();
    assert!(matches!(
        Opened::open(&changed),
        Err(RuntimeError::Configuration)
    ));
    assert_eq!(
        fs::read(policy.control_directory.join(ENROLLMENT)).unwrap(),
        enrollment
    );
    assert_eq!(
        fs::metadata(policy.control_directory.join(OWNER_LOCK))
            .unwrap()
            .ino(),
        inode
    );
    let reopened = Opened::open(&policy).unwrap();
    drop(reopened);
    let lock_path = policy.control_directory.join(".lock");
    let original = fs::metadata(&lock_path).unwrap().ino();
    fs::set_permissions(&lock_path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(matches!(
        Opened::open(&policy),
        Err(RuntimeError::Ownership)
    ));
    assert_eq!(fs::metadata(&lock_path).unwrap().ino(), original);
    assert_eq!(fs::metadata(&lock_path).unwrap().mode() & 0o777, 0o644);

    let foreign = tempfile::tempdir().unwrap();
    let candidate = build_policy(foreign.path());
    fs::write(
        candidate.control_directory.join("old-state"),
        b"must preserve",
    )
    .unwrap();
    assert!(matches!(
        Opened::open(&candidate),
        Err(RuntimeError::Configuration)
    ));
    assert_eq!(
        fs::read(candidate.control_directory.join("old-state")).unwrap(),
        b"must preserve"
    );
    assert!(!candidate.control_directory.join(ENROLLMENT).exists());
}

#[test]
fn partial_enrollment_refuses_restart_without_replacement() {
    let root = tempfile::tempdir().unwrap();
    let policy = build_policy(root.path());
    let path = policy.control_directory.join(ENROLLMENT);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
        .unwrap();
    file.write_all(b"{\"schemaVersion\":").unwrap();
    file.sync_all().unwrap();
    let inode = file.metadata().unwrap().ino();
    drop(file);
    assert!(matches!(
        Opened::open(&policy),
        Err(RuntimeError::Configuration)
    ));
    assert_eq!(fs::read(&path).unwrap(), b"{\"schemaVersion\":");
    assert_eq!(fs::metadata(&path).unwrap().ino(), inode);
    assert!(!policy.control_directory.join("consensus.redb").exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_caller_keeps_job_owned_and_shutdown_waits_for_actual_completion() {
    let root = tempfile::tempdir().unwrap();
    let policy = build_policy(root.path());
    let runtime = Arc::new(RecoveryRuntime::start(policy.clone()).await.unwrap());
    let (entered, entered_rx) = oneshot::channel();
    let (release, released) = oneshot::channel();
    let caller_runtime = runtime.clone();
    let caller = tokio::spawn(async move {
        caller_runtime
            .run_job(async move {
                entered.send(()).unwrap();
                released.await.unwrap();
                Ok::<_, RuntimeError>(())
            })
            .await
    });
    entered_rx.await.unwrap();
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    assert_eq!(
        runtime.run_job(async { Ok(()) }).await.unwrap_err(),
        RuntimeError::Busy
    );
    let runtime = Arc::try_unwrap(runtime).ok().unwrap();
    let shutdown = tokio::spawn(runtime.shutdown());
    tokio::task::yield_now().await;
    assert!(!shutdown.is_finished());
    assert!(matches!(
        Opened::open(&policy),
        Err(RuntimeError::Ownership)
    ));
    release.send(()).unwrap();
    shutdown.await.unwrap().unwrap();
    let reopened = Opened::open(&policy).unwrap();
    drop(reopened);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn panic_closes_admission_and_drop_owner_drains_without_resetting_locks() {
    let root = tempfile::tempdir().unwrap();
    let policy = build_policy(root.path());
    let runtime = RecoveryRuntime::start(policy.clone()).await.unwrap();
    assert_eq!(
        runtime
            .run_job(async {
                panic!("owned test fault");
                #[allow(unreachable_code)]
                Ok::<(), RuntimeError>(())
            })
            .await
            .unwrap_err(),
        RuntimeError::Closed
    );
    assert!(!runtime.status().accepting);
    assert!(runtime.shutdown().await.is_err());
    let runtime = RecoveryRuntime::start(policy.clone()).await.unwrap();
    let inode = fs::metadata(policy.control_directory.join(OWNER_LOCK))
        .unwrap()
        .ino();
    drop(runtime);
    // Probe the exact existing owner lock, not a broad startup error retry.
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let probe = OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(NOFOLLOW)
            .open(policy.control_directory.join(OWNER_LOCK))
            .unwrap();
        assert_eq!(probe.metadata().unwrap().ino(), inode);
        if probe.try_lock_exclusive().unwrap() {
            drop(probe);
            break;
        }
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let reopened = Opened::open(&policy).unwrap();
    drop(reopened);
    assert_eq!(
        fs::metadata(policy.control_directory.join(OWNER_LOCK))
            .unwrap()
            .ino(),
        inode
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_snapshot_builder_prevents_early_shutdown_success_and_allows_immediate_reopen() {
    use openraft::{storage::RaftStateMachine, RaftSnapshotBuilder};
    let root = tempfile::tempdir().unwrap();
    let policy = build_policy(root.path());
    let runtime = RecoveryRuntime::start(policy.clone()).await.unwrap();
    let metrics = runtime.inner.raft.metrics();
    let mut source = runtime.inner.opened.control.clone();
    let mut builder = source.get_snapshot_builder().await;
    drop(source);
    let inode = fs::metadata(policy.control_directory.join(OWNER_LOCK))
        .unwrap()
        .ino();
    let shutdown = tokio::spawn(runtime.shutdown());
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if metrics.borrow().state == openraft::ServerState::Shutdown {
                break;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    assert!(
        !shutdown.is_finished(),
        "Core shutdown hid a still-owned snapshot builder"
    );
    assert!(matches!(
        Opened::open(&policy),
        Err(RuntimeError::Ownership)
    ));
    builder.build_snapshot().await.unwrap();
    drop(builder);
    shutdown.await.unwrap().unwrap();
    let reopened = Opened::open(&policy).unwrap();
    drop(reopened);
    assert_eq!(
        fs::metadata(policy.control_directory.join(OWNER_LOCK))
            .unwrap()
            .ino(),
        inode
    );
}
