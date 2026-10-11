//! Actual standalone binary lifecycle with isolated loopback peers. No real
//! community export, geographic uplinks, publication or writer activation.
#![cfg(target_os = "linux")]
use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, BufReader, Read},
    net::{TcpListener, TcpStream},
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    process::{Child, Command, Output, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};
use wabi_consensus::{
    model::{RecoveryPeer, StoreBinding},
    transport::Identity,
};
use wabi_server::recovery_node::RecoveryNodeConfig;

fn private(path: &Path) {
    fs::create_dir(path).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}
fn save(path: &Path, value: &RecoveryNodeConfig) {
    fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}
fn command(root: &Path, config: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_wabi-server"));
    command
        .env_clear()
        .current_dir(root)
        .args(["--recovery-node-config"])
        .arg(config);
    command
}
fn no_authority(root: &Path) {
    for name in [
        "data",
        "logs",
        "uploads",
        "jwt_secret",
        "wabidb",
        "auth-revocations.json",
    ] {
        assert!(
            !root.join(name).exists(),
            "unexpected Authority artifact: {name}"
        );
    }
}

const PIPE_CAPTURE_BYTES: usize = 8192;
fn capture(mut pipe: impl Read) -> std::io::Result<Vec<u8>> {
    let mut output = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let count = pipe.read(&mut chunk)?;
        if count == 0 {
            return Ok(output);
        }
        // Keep one overflow byte for a refusal assertion; keep draining the
        // pipe concurrently so excess output cannot block the owned process.
        let retain = count.min((PIPE_CAPTURE_BYTES + 1).saturating_sub(output.len()));
        output.extend_from_slice(&chunk[..retain]);
    }
}
struct RefusalProcess {
    child: Child,
    stdout: Option<thread::JoinHandle<std::io::Result<Vec<u8>>>>,
    stderr: Option<thread::JoinHandle<std::io::Result<Vec<u8>>>>,
}
impl Drop for RefusalProcess {
    fn drop(&mut self) {
        // Reap the exact owned child before joining readers, including panic
        // during thread creation, polling or assertions. No unrelated PID is signalled.
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
        if let Some(reader) = self.stdout.take() {
            let _ = reader.join();
        }
        if let Some(reader) = self.stderr.take() {
            let _ = reader.join();
        }
    }
}
fn refusal_output(mut command: Command) -> Output {
    let child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    // Guard ownership precedes pipe-reader allocation and every fallible step.
    let mut process = RefusalProcess {
        child,
        stdout: None,
        stderr: None,
    };
    let stdout = process.child.stdout.take().unwrap();
    process.stdout = Some(thread::spawn(move || capture(stdout)));
    let stderr = process.child.stderr.take().unwrap();
    process.stderr = Some(thread::spawn(move || capture(stderr)));
    let deadline = Instant::now() + Duration::from_secs(5);
    let (status, timed_out) = loop {
        if let Some(status) = process.child.try_wait().unwrap() {
            break (status, false);
        }
        if Instant::now() >= deadline {
            let _ = process.child.kill();
            break (process.child.wait().unwrap(), true);
        }
        thread::sleep(Duration::from_millis(10));
    };
    let stdout = process.stdout.take().unwrap().join().unwrap().unwrap();
    let stderr = process.stderr.take().unwrap().join().unwrap().unwrap();
    // All owned resources have terminated before a regression can fail here.
    assert!(!timed_out, "CLI refusal entered a long-lived process");
    assert!(
        stdout.len() <= PIPE_CAPTURE_BYTES && stderr.len() <= PIPE_CAPTURE_BYTES,
        "CLI refusal output exceeded the capture budget"
    );
    Output {
        status,
        stdout,
        stderr,
    }
}

struct Process {
    child: Child,
    address: std::net::SocketAddr,
}
impl Drop for Process {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}
impl Process {
    fn start(root: &Path, config: &Path, address: std::net::SocketAddr) -> Self {
        let child = command(root, config)
            .arg("--shutdown-on-stdin-close")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut process = Self { child, address };
        let stdout = process.child.stdout.take().unwrap();
        let (tx, rx) = mpsc::sync_channel(1);
        let reader = thread::spawn(move || {
            let mut bytes = String::new();
            let result = BufReader::new(stdout).read_line(&mut bytes);
            let _ = tx.send((result, bytes));
        });
        let received = rx.recv_timeout(Duration::from_secs(15));
        if received.is_err() {
            let _ = process.child.kill();
            let _ = process.child.wait();
            reader.join().unwrap();
            panic!("standalone recovery node did not report lifecycle status");
        }
        reader.join().unwrap();
        let (result, bytes) = received.unwrap();
        assert!(
            result.unwrap() > 0,
            "standalone recovery node exited before status"
        );
        let status: serde_json::Value = serde_json::from_str(&bytes).unwrap();
        assert_eq!(status["role"], "experimental_recovery_node");
        assert_eq!(status["status"]["accepting"], true);
        assert_eq!(status["status"]["fullInstanceReady"], false);
        assert_eq!(status["status"]["canonicalWriterPermitted"], false);
        assert!(status["status"]["membershipReady"].is_boolean());
        assert!(!bytes.contains("privateKey") && !bytes.contains("identityDirectory"));
        assert!(process.child.try_wait().unwrap().is_none());
        TcpStream::connect_timeout(&address, Duration::from_secs(1)).unwrap();
        no_authority(root);
        process
    }
    fn shutdown(mut self) {
        drop(self.child.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                assert!(status.success(), "standalone node did not drain cleanly");
                break;
            }
            assert!(
                Instant::now() < deadline,
                "standalone recovery node shutdown timed out"
            );
            thread::sleep(Duration::from_millis(10));
        }
        let listener =
            TcpListener::bind(self.address).expect("old listener remained after node exit");
        drop(listener);
    }
}

fn configs(root: &Path) -> Vec<(PathBuf, RecoveryNodeConfig)> {
    let community = "ab".repeat(32);
    let mut peers = BTreeMap::new();
    let mut ports = Vec::new();
    for id in 1..=3 {
        let node = root.join(format!("node-{id}"));
        private(&node);
        for name in ["control", "material", "identity"] {
            private(&node.join(name));
        }
        let identity = Identity::generate().unwrap();
        identity.persist_new(&node.join("identity")).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        peers.insert(
            id,
            RecoveryPeer {
                protocol: 1,
                community_id: community.clone(),
                site_id: format!("fixture-site-{id}"),
                public_key: identity.public_hex(),
                rpc_address: listener.local_addr().unwrap().to_string(),
            },
        );
        ports.push(listener);
    }
    let result = (1..=3)
        .map(|id| {
            let node = root.join(format!("node-{id}"));
            let value = RecoveryNodeConfig {
                schema_version: 1,
                binding: StoreBinding {
                    community_id: community.clone(),
                    partition_id: "community/control".into(),
                    node_id: id,
                },
                peers: peers.clone(),
                source_node_id: "fixture-authority".into(),
                identity_directory: node.join("identity"),
                control_directory: node.join("control"),
                material_directory: node.join("material"),
                bind_address: None,
                initialize: id == 1,
                work_timeout_seconds: 10,
                rpc_deadline_milliseconds: 1000,
                minimum_free_bytes: 64 * 1024 * 1024,
            };
            let config = node.join("recovery.json");
            save(&config, &value);
            (config, value)
        })
        .collect();
    drop(ports);
    result
}
fn inodes(value: &RecoveryNodeConfig) -> Vec<(PathBuf, u64)> {
    [
        value.identity_directory.join("recovery.key"),
        value.control_directory.join(".runtime.lock"),
        value.control_directory.join(".lock"),
        value.material_directory.join(".lock"),
        value.control_directory.join("runtime.enrollment.json"),
    ]
    .into_iter()
    .map(|path| {
        let inode = fs::metadata(&path).unwrap().ino();
        (path, inode)
    })
    .collect()
}

#[test]
fn binary_refuses_conflicting_modes_and_maintenance_before_authority_artifacts() {
    let root = tempfile::tempdir().unwrap();
    let config = root.path().join("absent-private-config.json");
    for flags in [
        vec!["--helper-mode"],
        vec!["--desktop-managed"],
        vec!["--personal-planner"],
        vec!["--build-info"],
        vec!["--port", "9001"],
        vec!["--host", "127.0.0.1"],
        vec!["--data-dir", "unused"],
        vec!["--primary-url", "http://127.0.0.1:9999"],
        vec!["--pairing-token", "fixture"],
        vec!["--lan-reachable-at", "127.0.0.1:9999"],
        vec!["--print-bound-address"],
    ] {
        let mut candidate = command(root.path(), &config);
        candidate.args(flags);
        let output = refusal_output(candidate);
        assert!(!output.status.success());
        assert_eq!(
            output.status.code(),
            Some(2),
            "expected a CLI usage conflict before config loading"
        );
        assert!(output.stdout.is_empty());
        no_authority(root.path());
    }
    for (name, value, reason) in [
        (
            "WABI_PURGE_ORPHANS",
            "1",
            "Recovery node mode cannot run Authority maintenance",
        ),
        (
            "WABI_SERVER_ROLE",
            "anchor",
            "Recovery node mode requires a dedicated role-free environment",
        ),
    ] {
        let mut candidate = command(root.path(), &config);
        candidate.env(name, value);
        let output = refusal_output(candidate);
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert!(
            String::from_utf8_lossy(&output.stderr).contains(reason),
            "wrong early mode refusal"
        );
        assert!(!String::from_utf8_lossy(&output.stderr).contains(config.to_str().unwrap()));
        no_authority(root.path());
    }
    let output = refusal_output(command(root.path(), &config));
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr)
        .contains("recovery node configuration ownership refused"));
    assert!(!String::from_utf8_lossy(&output.stderr).contains(config.to_str().unwrap()));
    no_authority(root.path());
}

#[test]
fn actual_three_binary_nodes_drain_and_reopen_original_keys_locks_and_enrollment() {
    let root = tempfile::tempdir().unwrap();
    let mut configs = configs(root.path());
    let mut children = Vec::new();
    for index in [1, 2, 0] {
        let (path, value) = &configs[index];
        children.push(Process::start(
            path.parent().unwrap(),
            path,
            value.peers[&value.binding.node_id]
                .rpc_address
                .parse()
                .unwrap(),
        ));
    }
    let initial: Vec<_> = configs.iter().map(|(_, value)| inodes(value)).collect();
    // Bootstrap writes fixed membership through actual managed Raft. This
    // contract checks lifecycle, not checkpoint content/control convergence.
    while let Some(process) = children.pop() {
        process.shutdown();
    }
    for (path, value) in &mut configs {
        value.initialize = false;
        save(path, value);
    }
    for (index, (path, value)) in configs.iter().enumerate() {
        let process = Process::start(
            path.parent().unwrap(),
            path,
            value.peers[&value.binding.node_id]
                .rpc_address
                .parse()
                .unwrap(),
        );
        assert_eq!(inodes(value), initial[index]);
        process.shutdown();
        no_authority(path.parent().unwrap());
    }
    no_authority(root.path());
}
