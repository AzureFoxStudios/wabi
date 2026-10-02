//! Wait for a dropped fixture's admitted disk writes to release their OS lock.
//! First opens stay strict; non-lock startup errors must reach their assertions.

use std::{fmt::Display, future::Future, time::Duration};

pub async fn retry<Open, Opening, State, Error>(
    mut open: Open,
    is_busy: impl Fn(&Error) -> bool,
) -> Result<State, Error>
where
    Open: FnMut() -> Opening,
    Opening: Future<Output = Result<State, Error>>,
    Error: Display,
{
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        match open().await {
            Err(error) if is_busy(&error) => {
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "fixture disk writers did not release their advisory lock within five seconds: {error}"
                );
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            result => return result,
        }
    }
}

#[allow(dead_code)] // Adapter-only fixtures use retry directly.
pub async fn app_state(
    config: &wabi_server::config::ServerConfig,
) -> anyhow::Result<wabi_server::state::AppState> {
    retry(
        || wabi_server::state::AppState::new(config.clone()),
        is_already_running,
    )
    .await
}

pub fn is_already_running(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<wabidb::error::WabiError>()
        .is_some_and(|error| matches!(error, wabidb::error::WabiError::AlreadyRunning))
}

#[allow(dead_code)] // Only stopped-data fixtures need an offline drain probe.
pub async fn wait_for_stopped_engine(engine_dir: &std::path::Path) -> std::fs::File {
    use fs4::fs_std::FileExt;

    let path = engine_dir.join(".lock");
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&path)
        .unwrap_or_else(|error| {
            panic!(
                "could not open existing fixture lock {}: {error}",
                path.display()
            )
        });
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while !FileExt::try_lock_exclusive(&lock)
        .unwrap_or_else(|error| panic!("could not probe fixture lock {}: {error}", path.display()))
    {
        assert!(
            tokio::time::Instant::now() < deadline,
            "fixture disk writers did not release {} within five seconds",
            path.display()
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    // Keep the exact inode locked across the caller's stopped-data operation.
    // The caller closes this descriptor before reopening its fixture.
    lock
}
