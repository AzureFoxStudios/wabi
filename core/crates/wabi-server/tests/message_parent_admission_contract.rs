//! Real adapter lookups and parent admission on disposable main Wabi storage.

#[path = "fixtures/writer_drain.rs"]
mod writer_drain;

use wabi_server::adapter::WdbAdapter;
use wabidb::{
    crypto::bootstrap::BootstrapSource,
    domain::ChannelKind,
    engine::{locks::ProjectionState, wabi_store::WabiStore, WabiDbConfig},
    projections::message_lookup,
};

fn config(path: &std::path::Path) -> WabiDbConfig {
    let mut config = WabiDbConfig::new(path.into(), BootstrapSource::Provided([0xB8; 32]));
    config.allow_init = true;
    config
}

#[tokio::test]
async fn missing_parent_reactions_fail_without_commits_or_projection_changes() {
    let dir = tempfile::tempdir().unwrap();
    let store = WdbAdapter::open_with_config_and_node_id(config(dir.path()), "site-a".into())
        .await
        .unwrap();
    let before = store.engine().barrier().current();
    assert!(store
        .add_reaction("missing-message", 1, "thumbsup")
        .await
        .is_err());
    assert!(store
        .remove_reaction("missing-message", 1, "thumbsup")
        .await
        .is_err());
    assert_eq!(store.engine().barrier().current(), before);
    assert_eq!(store.engine().projection_state().index_len("reactions"), 0);
    assert_eq!(store.engine().projection_state().index_len("messages"), 0);
    assert_eq!(
        wabidb::commit_index::batcher::read_all_entries(&dir.path().join("global/commit-index"))
            .unwrap()
            .len(),
        0
    );
    assert!(store.engine().is_healthy());
}

#[tokio::test]
async fn adapter_id_lookup_tracks_edits_clear_and_event_replay() {
    let dir = tempfile::tempdir().unwrap();
    let store = WdbAdapter::open_with_config_and_node_id(config(dir.path()), "site-a".into())
        .await
        .unwrap();
    let room = store
        .create_channel("Local", ChannelKind::Text, 1, false)
        .await
        .unwrap();
    let id = store
        .send_message(&room, 1, "original", false, &[])
        .await
        .unwrap();
    let initial = store.get_message_typed(&id).await.unwrap().unwrap();
    assert_eq!(initial.channel_id, room);
    assert_eq!(initial.content, "original");
    store.edit_message(&id, 1, "edited").await.unwrap();
    assert_eq!(
        store.get_message_typed(&id).await.unwrap().unwrap().content,
        "edited"
    );
    store.add_reaction(&id, 1, "thumbsup").await.unwrap();
    assert_eq!(store.list_reactions(&id).await.unwrap().len(), 1);
    store.clear_channel_messages(&room, 1).await.unwrap();
    let cleared = store.get_message_typed(&id).await.unwrap().unwrap();
    assert!(cleared.is_deleted);
    assert!(store
        .list_messages_typed(&room, 10)
        .await
        .unwrap()
        .is_empty());
    let before = store.engine().barrier().current();
    drop(store);
    let stopped = writer_drain::wait_for_stopped_engine(dir.path()).await;
    ProjectionState::remove_snapshot(dir.path());
    drop(stopped);
    let reopened = writer_drain::retry(
        || WdbAdapter::open_with_config_and_node_id(config(dir.path()), "site-a".into()),
        |error| matches!(error, wabidb::error::WabiError::AlreadyRunning),
    )
    .await
    .unwrap();
    assert_eq!(reopened.engine().barrier().current(), before);
    assert_eq!(
        reopened.get_message_typed(&id).await.unwrap(),
        Some(cleared)
    );
    assert_eq!(
        reopened
            .engine()
            .projection_state()
            .index_len(message_lookup::INDEX),
        1
    );
    assert!(reopened
        .list_messages_typed(&room, 10)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn identity_is_selected_before_open_and_cannot_be_changed_by_adapter_builder() {
    let dir = tempfile::tempdir().unwrap();
    let store = WdbAdapter::open_with_config_and_node_id(config(dir.path()), "site-a".into())
        .await
        .unwrap();
    assert_eq!(store.engine().local_node_id(), "site-a");
    let store = store.with_local_node_id("site-a".into()).unwrap();
    assert!(store.engine().is_healthy());
    assert_eq!(store.engine().barrier().current(), 0);
    assert!(store.with_local_node_id("site-b".into()).is_err());
    let reopened = writer_drain::retry(
        || WdbAdapter::open_with_config_and_node_id(config(dir.path()), "site-a".into()),
        |error| matches!(error, wabidb::error::WabiError::AlreadyRunning),
    )
    .await
    .unwrap();
    assert_eq!(reopened.engine().local_node_id(), "site-a");
    assert!(reopened.engine().is_healthy());
    assert_eq!(reopened.engine().barrier().current(), 0);
}

#[tokio::test]
async fn invalid_adapter_node_id_does_not_create_a_root_key_or_engine_directory() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("not-created");
    assert!(WdbAdapter::open_with_node_id(&path, "site/other".into())
        .await
        .is_err());
    assert!(!path.exists());
}
