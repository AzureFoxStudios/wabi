//! Exercise the persistent process-lock / server bootstrap boundary through
//! the real adapter, with a hermetic root-key environment in a subprocess.
#[path = "fixtures/writer_drain.rs"]
mod writer_drain;

use wabi_server::adapter::WdbAdapter;
use wabidb::{
    crypto::bootstrap::BootstrapSource,
    engine::{WabiDbConfig, WabiDbEngine},
    error::WabiError,
};

#[test]
fn failed_first_boot_retries_through_the_adapter_without_replacing_existing_keys() {
    let dir = tempfile::tempdir().unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "adapter_retry_child", "--ignored", "--nocapture"])
        .env("WABI_TEST_ADAPTER_RETRY_DIR", dir.path())
        .env_remove("WABIDB_ROOT_KEY")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "adapter retry child failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test]
#[ignore = "subprocess fixture with an isolated bootstrap environment"]
async fn adapter_retry_child() {
    let path = std::path::PathBuf::from(std::env::var_os("WABI_TEST_ADAPTER_RETRY_DIR").unwrap());
    let mut failed = WabiDbConfig::new(path.clone(), BootstrapSource::Keychain);
    failed.allow_init = true;
    assert!(matches!(
        WabiDbEngine::open(failed).await.unwrap_err(),
        WabiError::KeychainUnavailable
    ));
    assert!(path.join(".lock").exists());
    assert!(!path.join("root_key").exists());
    assert!(!path.join("storage-manifest.json").exists());

    let adapter = WdbAdapter::open(&path).await.unwrap();
    let persisted = std::fs::read(path.join("root_key")).unwrap();
    let first_key = *adapter.engine().bootstrap_key();
    drop(adapter);
    let reopened = writer_drain::retry(
        || WdbAdapter::open(&path),
        |error| matches!(error, wabidb::error::WabiError::AlreadyRunning),
    )
    .await
    .unwrap();
    assert_eq!(reopened.engine().bootstrap_key(), &first_key);
    assert_eq!(std::fs::read(path.join("root_key")).unwrap(), persisted);

    // A benign lock inode does not make real incomplete storage first boot.
    let damaged = path.join("damaged");
    std::fs::create_dir_all(damaged.join("streams")).unwrap();
    std::fs::write(damaged.join(".lock"), b"diagnostic-pid").unwrap();
    assert!(WdbAdapter::open(&damaged).await.is_err());
    assert!(!damaged.join("root_key").exists());
}
