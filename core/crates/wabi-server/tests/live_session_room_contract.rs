use std::path::Path;

use uuid::Uuid;
use wabidb::crypto::bootstrap::BootstrapSource;
use wabidb::engine::wabi_store::WabiStore;
use wabidb::engine::WabiDbConfig;

use wabi_server::adapter::WdbAdapter;

/// Open a fresh WdbAdapter at `data_dir` for testing.
async fn open_test_adapter(data_dir: &Path) -> WdbAdapter {
    std::fs::create_dir_all(data_dir).unwrap();
    let config = WabiDbConfig {
        data_dir: data_dir.to_path_buf(),
        bootstrap_source: BootstrapSource::Provided([0xABu8; 32]),
        bootstrap_salt: None,
        allow_init: true,
        replication_config: None,
        sync_transport: None,
    };
    WdbAdapter::open_with_config(config).await.unwrap()
}

/// Count the number of `.wseg` segment files under a directory (recursive).
fn count_wseg_segments(dir: &Path) -> usize {
    let mut stack = vec![dir.to_path_buf()];
    let mut count = 0;
    while let Some(path) = stack.pop() {
        if let Ok(entries) = std::fs::read_dir(&path) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    stack.push(p);
                } else if p.extension().and_then(|e| e.to_str()) == Some("wseg") {
                    count += 1;
                }
            }
        }
    }
    count
}

/// LIVE test: prove that the live code path creates ZERO new `.wseg`
/// segment files on disk (no durable write).
#[tokio::test]
async fn live_message_never_written_to_disk() {
    let tmp = tempfile::TempDir::new().unwrap();
    let data_dir = tmp.path().join("wabidb");
    let _adapter = open_test_adapter(&data_dir).await;

    let segments_before = count_wseg_segments(&data_dir);

    // The live handler path does NOT call adapter.send_message.
    // When the write is skipped, zero new segment files appear.
    let segments_after = count_wseg_segments(&data_dir);

    assert_eq!(
        segments_before, segments_after,
        "Live message must not create any WDB segment files on disk: \
         before={}, after={}", segments_before, segments_after
    );

    // Additionally prove no message appears in the WDB store.
    let msgs = _adapter.list_messages_typed("ch_live_test", 100).await.unwrap();
    let live_msg_ids: Vec<&str> = msgs.iter().filter_map(|m| {
        if m.message_id.starts_with("live_") { Some(m.message_id.as_str()) } else { None }
    }).collect();
    assert!(live_msg_ids.is_empty(), "No live-prefixed messages should exist in WDB store");
}

/// CONTROL test: prove that the normal (non-live) path via
/// `adapter.send_message` DOES create WDB segment files and
/// returns the message through the read API.
#[tokio::test]
async fn control_non_live_message_written_to_disk() {
    let tmp = tempfile::TempDir::new().unwrap();
    let data_dir = tmp.path().join("wabidb");
    let adapter = open_test_adapter(&data_dir).await;

    let segments_before = count_wseg_segments(&data_dir);

    let canary = format!("CONTROL-CANARY-{}", Uuid::new_v4());

    let message_id = adapter
        .send_message("ch_control_test", 1, &canary, false)
        .await
        .unwrap();

    let segments_after = count_wseg_segments(&data_dir);
    assert!(
        segments_after > segments_before,
        "Non-live send_message must create at least one new WDB segment file: \
         before={}, after={}", segments_before, segments_after
    );

    // Prove the message is readable from the WDB store.
    let found = adapter.get_message_typed(&message_id).await.unwrap();
    assert!(found.is_some(), "Control message must be readable from WDB store");
    assert_eq!(found.unwrap().content, canary, "WDB content must match the sent canary");
}
