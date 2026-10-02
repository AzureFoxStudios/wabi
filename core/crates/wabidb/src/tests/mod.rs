#[cfg(test)]
pub mod crash_tests;
#[cfg(test)]
pub mod integration;
#[cfg(test)]
pub mod lore_integration;
#[cfg(test)]
pub mod power_loss;
#[cfg(test)]
pub mod property_tests;
#[cfg(test)]
pub mod replay_test;
#[cfg(test)]
pub mod send_message_flow;
#[cfg(test)]
pub mod write_completion;

/// Hold the existing lock inode while changing a stopped fixture's files.
pub(crate) async fn wait_for_stopped_engine(engine_dir: &std::path::Path) -> std::fs::File {
    use fs4::fs_std::FileExt;
    use std::time::Duration;

    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(engine_dir.join(".lock"))
        .expect("stopped fixture must retain its existing advisory-lock inode");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        if FileExt::try_lock_exclusive(&lock).expect("could not lock stopped fixture") {
            return lock;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "fixture writer did not release its advisory lock within five seconds"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// Reopen a dropped fixture after its admitted disk work releases the same
/// advisory-lock inode. Unrelated startup errors remain available to the test.
pub(crate) async fn reopen_after_drop(
    config: crate::engine::WabiDbConfig,
    node_id: Option<&str>,
) -> crate::error::Result<crate::engine::WabiDbEngine> {
    use crate::engine::WabiDbEngine;
    use crate::error::WabiError;
    use std::time::Duration;

    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let result = match node_id {
            Some(node_id) => WabiDbEngine::open_with_node_id(config.clone(), node_id.into()).await,
            None => WabiDbEngine::open(config.clone()).await,
        };
        match result {
            Err(WabiError::AlreadyRunning) => {
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "fixture writer did not release its advisory lock within five seconds"
                );
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            result => return result,
        }
    }
}
