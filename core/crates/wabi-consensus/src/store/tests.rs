use super::*;
use openraft::storage::RaftLogStorage;
use std::time::Duration;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_caller_does_not_release_unfinished_commit_or_store_ownership() {
    let root = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let binding = StoreBinding {
        community_id: "ab".repeat(32),
        partition_id: "community/control".into(),
        node_id: 1,
    };
    let store = Store::open(root.path(), binding.clone(), StoreLimits::default()).unwrap();
    let (entered, started) = tokio::sync::oneshot::channel();
    let (release, held) = std::sync::mpsc::channel();
    let task_store = store.clone();
    let writer = tokio::spawn(async move {
        task_store
            .run(move |inner| {
                let tx = transaction(inner, 1024 * 1024)?;
                put(&tx, "vote", &Some(Vote::new_committed(4, 2)))?;
                let _ = entered.send(());
                held.recv_timeout(Duration::from_secs(5))
                    .map_err(|_| StoreError::Io)?;
                io(tx.commit())
            })
            .await
    });
    started.await.unwrap();
    writer.abort();
    assert!(writer.await.unwrap_err().is_cancelled());
    assert!(matches!(
        Store::open(root.path(), binding.clone(), StoreLimits::default()),
        Err(StoreError::Ownership)
    ));
    let mut reader_store = store.clone();
    let mut reader = tokio::spawn(async move { reader_store.read_vote().await });
    assert!(
        tokio::time::timeout(Duration::from_millis(100), &mut reader)
            .await
            .is_err()
    );
    release.send(()).unwrap();
    assert_eq!(
        reader.await.unwrap().unwrap(),
        Some(Vote::new_committed(4, 2))
    );
    drop(store);
    let mut reopened = Store::open(root.path(), binding, StoreLimits::default()).unwrap();
    assert_eq!(
        reopened.read_vote().await.unwrap(),
        Some(Vote::new_committed(4, 2))
    );
}
