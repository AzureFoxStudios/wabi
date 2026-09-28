//! Disposable coordinated local boundary. These fixture copies are plaintext,
//! not a shipped encrypted exporter, complete operator inventory or promotion.
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use wabi_server::{
    config::{LoreAddonConfig, ServerConfig, ServerRole},
    instance_checkpoint::InstanceCheckpointBoundary,
    state::AppState,
    upload_registry::UploadKind,
};
use wabidb::{
    domain::{ChannelKind, MemberRole},
    engine::wabi_store::WabiStore,
};

fn config(data: &Path, uploads: &Path) -> ServerConfig {
    ServerConfig {
        host: "127.0.0.1".into(),
        port: 0,
        data_dir: data.to_string_lossy().into_owned(),
        uploads_dir: uploads.to_string_lossy().into_owned(),
        jwt_secret: "checkpoint-fixture-secret-only".into(),
        turn_enabled: false,
        turn_uri: None,
        turn_secret: None,
        node_id: "checkpoint-site".into(),
        is_primary: true,
        server_role: ServerRole::Authority,
        authority_url: None,
        admin_user_ids: vec![],
        blacklist_file: data.join("blacklist.txt").to_string_lossy().into_owned(),
        max_body_size: None,
        mesh_enabled: false,
        mesh_peers: vec![],
        lore: LoreAddonConfig::default(),
    }
}

fn copy_tree(source: &Path, target: &Path, relative: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(target)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let path = relative.join(entry.file_name());
        // Known process identity only. The new fixture tree has no running
        // engine; arbitrary unknown files and directories are still copied.
        if path == Path::new("wabidb/.lock") {
            continue;
        }
        let metadata = std::fs::symlink_metadata(entry.path())?;
        let destination = target.join(entry.file_name());
        if metadata.is_dir() {
            copy_tree(&entry.path(), &destination, &path)?;
        } else if metadata.is_file() && !metadata.file_type().is_symlink() {
            std::fs::copy(entry.path(), destination)?;
        } else {
            return Err(std::io::Error::other(
                "fixture tree contains an unsupported file",
            ));
        }
    }
    Ok(())
}

fn inventory(root: &Path) -> BTreeMap<PathBuf, (u64, String)> {
    fn walk(root: &Path, path: &Path, rows: &mut BTreeMap<PathBuf, (u64, String)>) {
        for entry in std::fs::read_dir(path).unwrap() {
            let entry = entry.unwrap();
            let relative = entry.path().strip_prefix(root).unwrap().to_owned();
            if relative == Path::new("wabidb/.lock") {
                continue;
            }
            if entry.file_type().unwrap().is_dir() {
                walk(root, &entry.path(), rows);
            } else {
                let bytes = std::fs::read(entry.path()).unwrap();
                rows.insert(
                    relative,
                    (bytes.len() as u64, hex::encode(Sha256::digest(&bytes))),
                );
            }
        }
    }
    let mut rows = BTreeMap::new();
    walk(root, root, &mut rows);
    rows
}

#[tokio::test]
async fn coordinated_fixture_copy_preserves_matching_database_sidecars_uploads_and_unknown_files() {
    let source = tempfile::tempdir().unwrap();
    let restored = tempfile::tempdir().unwrap();
    let data = source.path().join("data");
    let uploads = source.path().join("outside-data-uploads");
    let state = Arc::new(AppState::new(config(&data, &uploads)).await.unwrap());
    let owner = state
        .wdb
        .create_user("owner", None, "fixture-password-hash")
        .await
        .unwrap();
    state.claim_ownership(owner as i64, "owner").await.unwrap();
    let code = state
        .generate_recovery_codes(owner as i64, 1)
        .await
        .unwrap()
        .remove(0);
    state
        .revoke_token_with_exp(
            "fixture-denied".into(),
            chrono::Utc::now().timestamp() + 3600,
        )
        .await
        .unwrap();
    let channel = state
        .wdb
        .create_channel("Fixture", ChannelKind::Text, owner, false)
        .await
        .unwrap();
    state
        .wdb
        .add_channel_member(&channel, owner, MemberRole::Owner)
        .await
        .unwrap();
    let retained = state
        .wdb
        .send_message(&channel, owner, "retained fixture text", false, &[])
        .await
        .unwrap();
    let deleted = state
        .wdb
        .send_message(&channel, owner, "deleted fixture text", false, &[])
        .await
        .unwrap();
    state.wdb.delete_message(&deleted, owner).await.unwrap();
    for (name, bytes) in [
        ("kept.bin", b"kept bytes".as_slice()),
        ("revoked.bin", b"denied bytes".as_slice()),
    ] {
        state
            .upload_registry
            .publish_bytes(
                &uploads,
                state.wdb.engine(),
                name,
                name,
                Some(channel.clone()),
                Some(wabidb::sequencer::types::RoomOwnerPrecondition {
                    channel_id: channel.clone(),
                    owner_node_id: state.config.node_id.clone(),
                    expected_epoch: Some(1),
                }),
                Some(owner as i64),
                UploadKind::Attachment,
                bytes,
            )
            .await
            .unwrap();
    }
    state
        .upload_registry
        .revoke_canonical("revoked.bin", state.wdb.engine(), owner)
        .await
        .unwrap();
    std::fs::remove_file(uploads.join("revoked.bin")).unwrap();
    std::fs::create_dir_all(data.join("unknown/empty")).unwrap();
    std::fs::write(data.join("unknown/component.json"), b"{\"fixture\":true}").unwrap();
    std::fs::create_dir_all(uploads.join("unknown")).unwrap();
    std::fs::write(
        uploads.join("unknown/extra.bin"),
        b"opaque upload-tree fixture",
    )
    .unwrap();

    let boundary = InstanceCheckpointBoundary::prepare(state.clone())
        .await
        .unwrap();
    let position = boundary.applied_seq();
    let prefix = boundary.prefix_fingerprint().to_owned();
    let copy_data = restored.path().join("data");
    let copy_uploads = restored.path().join("uploads");
    let copied_data = copy_data.clone();
    let copied_uploads = copy_uploads.clone();
    let (source_data, source_uploads) = boundary
        .with_files(move |state, seq, fingerprint| {
            assert_eq!(seq, position);
            assert_eq!(fingerprint, prefix);
            let data = Path::new(&state.config.data_dir);
            let uploads = Path::new(&state.config.uploads_dir);
            let expected_data = inventory(data);
            let expected_uploads = inventory(uploads);
            copy_tree(data, &copied_data, Path::new(""))?;
            copy_tree(uploads, &copied_uploads, Path::new(""))?;
            assert_eq!(inventory(data), expected_data);
            assert_eq!(inventory(uploads), expected_uploads);
            assert_eq!(inventory(&copied_data), expected_data);
            assert_eq!(inventory(&copied_uploads), expected_uploads);
            Ok((expected_data, expected_uploads))
        })
        .await
        .unwrap()
        .unwrap();
    assert!(!source_data.is_empty() && !source_uploads.is_empty());
    let recovered = AppState::new(config(&copy_data, &copy_uploads))
        .await
        .unwrap();
    assert_eq!(recovered.wdb.engine().barrier().current(), position);
    assert_eq!(*recovered.owner_user_id.read().await, Some(owner as i64));
    assert!(
        recovered
            .is_token_revoked(
                "fixture-denied",
                owner as i64,
                chrono::Utc::now().timestamp()
            )
            .await
    );
    assert!(recovered
        .consume_recovery_code(&code, owner as i64)
        .await
        .unwrap());
    let history = recovered
        .wdb
        .list_messages_typed(&channel, 20)
        .await
        .unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].message_id, retained);
    assert!(recovered.upload_registry.is_revoked("revoked.bin").await);
    assert!(!copy_uploads.join("revoked.bin").exists());
    assert_eq!(
        std::fs::read(copy_uploads.join("kept.bin")).unwrap(),
        b"kept bytes"
    );
    assert!(copy_data.join("unknown/empty").is_dir());
    assert_eq!(
        std::fs::read(copy_uploads.join("unknown/extra.bin")).unwrap(),
        b"opaque upload-tree fixture"
    );
    // Both are isolated fixture Authorities, not a safe promotion. No user
    // endpoint is listening. The source remains usable after its pause.
    state
        .wdb
        .send_message(&channel, owner, "source resumed", false, &[])
        .await
        .unwrap();
    assert_eq!(
        state
            .wdb
            .list_messages_typed(&channel, 20)
            .await
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        recovered
            .wdb
            .list_messages_typed(&channel, 20)
            .await
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn cancelling_a_started_copy_caller_keeps_both_guards_until_blocking_work_finishes() {
    let source = tempfile::tempdir().unwrap();
    let copied = tempfile::tempdir().unwrap();
    let state = Arc::new(
        AppState::new(config(
            &source.path().join("data"),
            &source.path().join("uploads"),
        ))
        .await
        .unwrap(),
    );
    let boundary = InstanceCheckpointBoundary::prepare(state.clone())
        .await
        .unwrap();
    let before = boundary.applied_seq();
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let (finished_tx, finished_rx) = tokio::sync::oneshot::channel();
    let target = copied.path().join("data");
    let caller = tokio::spawn(async move {
        boundary
            .with_files(move |state, seq, _| {
                assert_eq!(seq, before);
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                copy_tree(Path::new(&state.config.data_dir), &target, Path::new(""))?;
                finished_tx.send(()).unwrap();
                Ok(())
            })
            .await
            .unwrap()
            .unwrap();
    });
    entered_rx.await.unwrap();
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    let admitted = state.clone();
    let waiting = state.instance_operations.spawn(async move {
        let id = admitted
            .wdb
            .create_user("after-copy", None, "fixture-hash")
            .await
            .unwrap();
        std::fs::write(
            Path::new(&admitted.config.data_dir).join("after-copy.json"),
            b"after",
        )
        .unwrap();
        id
    });
    tokio::time::timeout(Duration::from_secs(3), async {
        while state.instance_operations.waiting_operations() == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(state.wdb.engine().barrier().current(), before);
    assert!(!waiting.is_finished());
    release_tx.send(()).unwrap();
    finished_rx.await.unwrap();
    let user = tokio::time::timeout(Duration::from_secs(3), waiting)
        .await
        .unwrap()
        .unwrap();
    assert!(user > 0);
    assert!(state.instance_operations.healthy_for_checkpoint());
    assert!(Path::new(&state.config.data_dir)
        .join("after-copy.json")
        .exists());
    assert!(!copied.path().join("data/after-copy.json").exists());
    let (_, watermark) =
        wabidb::engine::locks::ProjectionState::load_snapshot(&copied.path().join("data/wabidb"))
            .unwrap()
            .unwrap();
    assert_eq!(watermark, before);
    drop(
        InstanceCheckpointBoundary::prepare(state.clone())
            .await
            .unwrap(),
    );
}

#[tokio::test]
async fn interrupted_application_work_vetoes_a_checkpoint_boundary() {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(
        AppState::new(config(
            &dir.path().join("data"),
            &dir.path().join("uploads"),
        ))
        .await
        .unwrap(),
    );
    let task = state
        .instance_operations
        .spawn(async { panic!("fixture worker interrupted") });
    assert!(task.await.unwrap_err().is_panic());
    assert!(!state.instance_operations.healthy_for_checkpoint());
    assert!(InstanceCheckpointBoundary::prepare(state.clone())
        .await
        .is_err());
    state.instance_operations.run(async {}).await;
}

#[tokio::test]
async fn an_error_copy_releases_admission_and_an_admitted_controller_refuses_itself() {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(
        AppState::new(config(
            &dir.path().join("data"),
            &dir.path().join("uploads"),
        ))
        .await
        .unwrap(),
    );
    state
        .instance_operations
        .run(async {
            assert!(InstanceCheckpointBoundary::prepare(state.clone())
                .await
                .is_err());
        })
        .await;
    let boundary = InstanceCheckpointBoundary::prepare(state.clone())
        .await
        .unwrap();
    let result = boundary
        .with_files(|_, _, _| -> wabidb::error::Result<()> {
            Err(std::io::Error::other("fixture copy refused").into())
        })
        .await
        .unwrap();
    assert!(result.is_err());
    assert!(state.instance_operations.healthy_for_checkpoint());
    drop(
        InstanceCheckpointBoundary::prepare(state.clone())
            .await
            .unwrap(),
    );
}

#[tokio::test]
async fn a_drain_deadline_releases_the_queued_pause_without_interrupting_admitted_work() {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(
        AppState::new(config(
            &dir.path().join("data"),
            &dir.path().join("uploads"),
        ))
        .await
        .unwrap(),
    );
    assert!(
        InstanceCheckpointBoundary::prepare_with_timeout(state.clone(), Duration::ZERO)
            .await
            .is_err()
    );
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let task = state.instance_operations.spawn(async move {
        entered_tx.send(()).unwrap();
        release_rx.await.unwrap();
    });
    entered_rx.await.unwrap();
    let result =
        InstanceCheckpointBoundary::prepare_with_timeout(state.clone(), Duration::from_millis(10))
            .await;
    assert_eq!(
        result.err().unwrap().to_string(),
        "checkpoint drain deadline elapsed"
    );
    assert!(!task.is_finished());
    assert!(state.instance_operations.healthy_for_checkpoint());
    // New work can enter after the timed-out writer is removed, even though
    // the originally admitted operation is still completing.
    tokio::time::timeout(
        Duration::from_secs(3),
        state.instance_operations.run(async {}),
    )
    .await
    .unwrap();
    release_tx.send(()).unwrap();
    task.await.unwrap();
    drop(
        InstanceCheckpointBoundary::prepare_with_timeout(state, Duration::from_secs(3))
            .await
            .unwrap(),
    );
}

#[tokio::test]
async fn a_panicking_copy_refuses_a_later_database_boundary() {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(
        AppState::new(config(
            &dir.path().join("data"),
            &dir.path().join("uploads"),
        ))
        .await
        .unwrap(),
    );
    let boundary = InstanceCheckpointBoundary::prepare(state.clone())
        .await
        .unwrap();
    let failed = boundary
        .with_files(|_, _, _| -> wabidb::error::Result<()> { panic!("fixture copy panic") })
        .await;
    assert!(failed.unwrap_err().is_panic());
    assert!(!state.wdb.engine().is_healthy());
    assert!(InstanceCheckpointBoundary::prepare(state.clone())
        .await
        .is_err());
}
