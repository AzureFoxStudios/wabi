use std::{path::Path, process::Command};
use wabi_server::{
    adapter::WdbAdapter,
    upload_registry::{UploadKind, UploadRegistry},
};
use wabidb::projections::upload_assets;

fn run_backfill(data: &Path, uploads: &Path, apply: bool) -> std::process::Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_wabi-upload-backfill"));
    command
        .arg("--data-dir")
        .arg(data)
        .arg("--uploads-dir")
        .arg(uploads);
    if apply {
        command.arg("--apply");
    }
    command.output().unwrap()
}

#[tokio::test]
async fn stopped_backfill_previews_commits_and_refuses_fenced_data() {
    let tmp = tempfile::tempdir().unwrap();
    let data = tmp.path().join("data");
    let uploads = tmp.path().join("uploads");
    std::fs::create_dir_all(&uploads).unwrap();
    let adapter = WdbAdapter::open(&data.join("wabidb")).await.unwrap();
    let registry = UploadRegistry::new_persistent(&data).unwrap();
    registry
        .record(
            "legacy.bin",
            "legacy.bin",
            None,
            Some(7),
            UploadKind::Attachment,
            6,
        )
        .await
        .unwrap();
    std::fs::write(uploads.join("legacy.bin"), b"legacy").unwrap();
    drop(adapter);

    let preview = run_backfill(&data, &uploads, false);
    assert!(
        preview.status.success(),
        "{}",
        String::from_utf8_lossy(&preview.stderr)
    );
    let preview_json: serde_json::Value = serde_json::from_slice(&preview.stdout).unwrap();
    assert_eq!(preview_json["applied"], false);
    assert_eq!(preview_json["report"]["eligible"], 1);
    assert_eq!(preview_json["report"]["committed"], 0);
    let adapter = WdbAdapter::open(&data.join("wabidb")).await.unwrap();
    assert!(adapter
        .engine()
        .projection_state()
        .get(upload_assets::INDEX, b"legacy.bin")
        .is_none());
    drop(adapter);

    let applied = run_backfill(&data, &uploads, true);
    assert!(
        applied.status.success(),
        "{}",
        String::from_utf8_lossy(&applied.stderr)
    );
    let applied_json: serde_json::Value = serde_json::from_slice(&applied.stdout).unwrap();
    assert_eq!(applied_json["report"]["committed"], 1);
    let adapter = WdbAdapter::open(&data.join("wabidb")).await.unwrap();
    assert!(adapter
        .engine()
        .projection_state()
        .get(upload_assets::INDEX, b"legacy.bin")
        .is_some());
    drop(adapter);

    std::fs::write(data.join("wabidb/writer-fenced-v1"), b"fenced\n").unwrap();
    let fenced = run_backfill(&data, &uploads, true);
    assert!(!fenced.status.success());
    assert!(String::from_utf8_lossy(&fenced.stderr).contains("refusing to backfill"));
}
