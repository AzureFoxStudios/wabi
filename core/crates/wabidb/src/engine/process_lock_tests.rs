use super::{locks::try_acquire_process_lock, WabiDbConfig, WabiDbEngine};
use crate::crypto::bootstrap::BootstrapSource;
use crate::error::WabiError;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

fn config(path: &Path) -> WabiDbConfig {
    let mut config = WabiDbConfig::new(path.to_owned(), BootstrapSource::Provided([0x8a; 32]));
    config.allow_init = true;
    config
}

// A real engine in a separate process holds its lock until stdin closes. The
// parent waits for the explicit ready message, never a guessed startup delay.
#[test]
#[ignore = "subprocess helper invoked by process lock regression tests"]
fn process_lock_subprocess_child() {
    let Some(path) = std::env::var_os("WABI_PROCESS_LOCK_CHILD_DIR") else {
        return;
    };
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let engine = runtime
        .block_on(WabiDbEngine::open(config(Path::new(&path))))
        .unwrap();
    println!("WABI_ENGINE_LOCK_READY");
    std::io::stdout().flush().unwrap();
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    runtime.block_on(engine.close_for_tests()).unwrap();
}

struct ChildGuard(Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn locked_child(path: &Path) -> ChildGuard {
    let child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "engine::process_lock_tests::process_lock_subprocess_child",
            "--ignored",
            "--nocapture",
        ])
        .env("WABI_PROCESS_LOCK_CHILD_DIR", path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let mut child = ChildGuard(child);
    let stdout = child.0.stdout.take().unwrap();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut announced = false;
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if !announced && line.contains("WABI_ENGINE_LOCK_READY") {
                let _ = ready_tx.send(());
                announced = true;
            }
        }
    });
    ready_rx
        .recv_timeout(Duration::from_secs(10))
        .expect("child engine did not acknowledge lock ownership");
    child
}

#[tokio::test]
async fn process_lock_excludes_another_engine_and_releases_after_kill() {
    let dir = tempfile::tempdir().unwrap();
    let mut child = locked_child(dir.path());
    let path = dir.path().join(".lock");
    let pid_before = std::fs::read(&path).unwrap();
    let error = WabiDbEngine::open(config(dir.path())).await.unwrap_err();
    assert!(matches!(error, WabiError::AlreadyRunning));
    assert_eq!(std::fs::read(&path).unwrap(), pid_before);

    child.0.kill().unwrap();
    child.0.wait().unwrap();
    assert!(
        path.exists(),
        "crash recovery must reuse the existing inode"
    );
    let engine = WabiDbEngine::open(config(dir.path())).await.unwrap();
    assert_eq!(engine.data_dir(), dir.path());
}

#[tokio::test]
async fn process_lock_lives_until_cloned_writer_sender_finishes() {
    let dir = tempfile::tempdir().unwrap();
    let engine = WabiDbEngine::open(config(dir.path())).await.unwrap();
    let sender = engine.sequencer().unwrap().sender().clone();
    drop(engine);
    let error = WabiDbEngine::open(config(dir.path())).await.unwrap_err();
    assert!(matches!(error, WabiError::AlreadyRunning));
    drop(sender);
    crate::tests::reopen_after_drop(config(dir.path()), None)
        .await
        .unwrap();
}

#[tokio::test]
async fn process_lock_releases_after_normal_subprocess_shutdown() {
    let dir = tempfile::tempdir().unwrap();
    let mut child = locked_child(dir.path());
    drop(child.0.stdin.take());
    assert!(child.0.wait().unwrap().success());
    assert!(dir.path().join(".lock").exists());
    WabiDbEngine::open(config(dir.path())).await.unwrap();
}

#[tokio::test]
async fn process_lock_releases_after_failed_open() {
    let dir = tempfile::tempdir().unwrap();
    let mut failed = config(dir.path());
    failed.bootstrap_source = BootstrapSource::Keychain;
    assert!(matches!(
        WabiDbEngine::open(failed).await.unwrap_err(),
        WabiError::KeychainUnavailable
    ));
    assert!(dir.path().join(".lock").exists());
    let engine = WabiDbEngine::open(config(dir.path())).await.unwrap();
    assert_eq!(engine.data_dir(), dir.path());
}

#[test]
fn process_lock_rejects_aliases_and_preserves_the_inode() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(".lock");
    let held = try_acquire_process_lock(&path).unwrap().unwrap();
    assert!(
        try_acquire_process_lock(&dir.path().join(".").join(".lock"))
            .unwrap()
            .is_none()
    );
    #[cfg(unix)]
    let inode = {
        use std::os::unix::fs::MetadataExt;
        std::fs::metadata(&path).unwrap().ino()
    };
    drop(held);
    let _next = try_acquire_process_lock(&path).unwrap().unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        assert_eq!(std::fs::metadata(&path).unwrap().ino(), inode);
    }
}

#[cfg(unix)]
#[test]
fn process_lock_rejects_a_symlink_without_mutating_its_target() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("outside");
    std::fs::write(&target, b"unchanged").unwrap();
    std::os::unix::fs::symlink(&target, dir.path().join(".lock")).unwrap();
    assert!(try_acquire_process_lock(&dir.path().join(".lock")).is_err());
    assert_eq!(std::fs::read(&target).unwrap(), b"unchanged");
}
