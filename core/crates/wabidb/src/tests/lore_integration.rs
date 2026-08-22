use crate::crypto::bootstrap::BootstrapSource;
use crate::engine::{WabiDbConfig, WabiDbEngine};
use crate::format::record::RecordKind;
use crate::projections::lore::{self, LoreCommitProjection, LoreRepoProjection};
use crate::sequencer::types::{CommandCommit, EventToWrite};

async fn setup_engine() -> (WabiDbEngine, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let config = WabiDbConfig {
        data_dir: dir.path().to_path_buf(),
        bootstrap_source: BootstrapSource::Provided([0u8; 32]),
        bootstrap_salt: None,
        allow_init: true,
        replication_config: None,
        sync_transport: None,
            test_boot_wallclock_override: None,
    };
    let engine = WabiDbEngine::open(config).await.unwrap();
    (engine, dir)
}

#[tokio::test]
async fn lore_repo_registered_via_command() {
    let (engine, _dir) = setup_engine().await;
    let channel_id = "42";
    engine.get_or_create_stream_key(channel_id).await.unwrap();

    let record = lore::LoreRepoRecord {
        channel_id: 42,
        repo_name: "test-assets".into(),
        lore_server_url: "lore://localhost:10000".into(),
        created_by: 1,
        created_at_micros: 1_000_000_000,
    };
    let payload = lore::encode_repo_record(&record);

    let (tx, _rx) = tokio::sync::oneshot::channel();
    let cmd = CommandCommit {
        caller_user_id: 1,
        caller_device_id: "dev_test".into(),
        command_name: "lore_create_repo".into(),
        idempotency_key: None,
        events: vec![EventToWrite {
            stream_id: channel_id.to_string(),
            event_type: "lore_repo_registered".into(),
            stream_kind: 6,
            record_kind: RecordKind::Event,
            plaintext: payload,
        }],
        essential: true,
        response_tx: tx,
    };

    let result = engine.run_command(cmd).await;
    assert!(
        result.is_ok(),
        "lore_repo_registered command failed: {:?}",
        result
    );

    let state = engine.projection_state();
    let loaded = LoreRepoProjection::get_repo(&state, 42).unwrap().unwrap();
    assert_eq!(loaded.repo_name, "test-assets");
    assert_eq!(loaded.created_by, 1);
}

#[tokio::test]
async fn lore_commit_via_command() {
    let (engine, _dir) = setup_engine().await;
    let channel_id = "99";
    engine.get_or_create_stream_key(channel_id).await.unwrap();

    let record = lore::LoreCommitRecord {
        commit_hash: "abc123".into(),
        channel_id: 99,
        repo_name: "game-assets".into(),
        file_path: "textures/wall.png".into(),
        message: "Added wall texture".into(),
        author_user_id: 42,
        timestamp_micros: 2_000_000_000,
    };
    let payload = lore::encode_record(&record);

    let (tx, _rx) = tokio::sync::oneshot::channel();
    let cmd = CommandCommit {
        caller_user_id: 42,
        caller_device_id: "dev_test".into(),
        command_name: "lore_commit".into(),
        idempotency_key: None,
        events: vec![EventToWrite {
            stream_id: channel_id.to_string(),
            event_type: "lore_commit".into(),
            stream_kind: 6,
            record_kind: RecordKind::Event,
            plaintext: payload,
        }],
        essential: true,
        response_tx: tx,
    };

    let result = engine.run_command(cmd).await;
    assert!(result.is_ok(), "lore_commit command failed: {:?}", result);

    let state = engine.projection_state();
    let loaded = LoreCommitProjection::get_commit(&state, 99, "abc123")
        .unwrap()
        .unwrap();
    assert_eq!(loaded.file_path, "textures/wall.png");
    assert_eq!(loaded.message, "Added wall texture");
    assert_eq!(loaded.author_user_id, 42);
}

#[tokio::test]
async fn lore_full_flow() {
    let (engine, _dir) = setup_engine().await;
    let channel_id = "77";
    engine.get_or_create_stream_key(channel_id).await.unwrap();

    // Register a repo
    let repo_record = lore::LoreRepoRecord {
        channel_id: 77,
        repo_name: "full-flow-repo".into(),
        lore_server_url: "lore://localhost:10000".into(),
        created_by: 7,
        created_at_micros: 1_000_000_000,
    };
    let (tx, _rx) = tokio::sync::oneshot::channel();
    let cmd = CommandCommit {
        caller_user_id: 7,
        caller_device_id: "dev_test".into(),
        command_name: "lore_create_repo".into(),
        idempotency_key: None,
        events: vec![EventToWrite {
            stream_id: channel_id.to_string(),
            event_type: "lore_repo_registered".into(),
            stream_kind: 6,
            record_kind: RecordKind::Event,
            plaintext: lore::encode_repo_record(&repo_record),
        }],
        essential: true,
        response_tx: tx,
    };
    engine.run_command(cmd).await.unwrap();

    // Commit a file
    let commit_record = lore::LoreCommitRecord {
        commit_hash: "def789".into(),
        channel_id: 77,
        repo_name: "full-flow-repo".into(),
        file_path: "models/character.fbx".into(),
        message: "Initial character model".into(),
        author_user_id: 7,
        timestamp_micros: 1_000_000_001,
    };
    let (tx, _rx) = tokio::sync::oneshot::channel();
    let cmd = CommandCommit {
        caller_user_id: 7,
        caller_device_id: "dev_test".into(),
        command_name: "lore_commit".into(),
        idempotency_key: None,
        events: vec![EventToWrite {
            stream_id: channel_id.to_string(),
            event_type: "lore_commit".into(),
            stream_kind: 6,
            record_kind: RecordKind::Event,
            plaintext: lore::encode_record(&commit_record),
        }],
        essential: true,
        response_tx: tx,
    };
    engine.run_command(cmd).await.unwrap();

    // Verify both projections
    let state = engine.projection_state();
    let repo = LoreRepoProjection::get_repo(&state, 77).unwrap().unwrap();
    assert_eq!(repo.repo_name, "full-flow-repo");

    let commit = LoreCommitProjection::get_commit(&state, 77, "def789")
        .unwrap()
        .unwrap();
    assert_eq!(commit.file_path, "models/character.fbx");
    assert_eq!(commit.message, "Initial character model");

    let commits = LoreCommitProjection::list_commits(&state, 77).unwrap();
    assert_eq!(commits.len(), 1);
}
