//! Channel lifecycle contract (zombie-channel remediation):
//! - deleting a channel removes it from every read path immediately
//! - the deletion is DURABLE: after an engine close/reopen (event-log
//!   replay) the deleted channel stays gone — no zombie resurrection
//! - DM/group channels created with caller-assigned ids are stored under
//!   THAT id (not a commit-seq phantom), so lookups and deletes by the
//!   real id work
//! - delete is idempotent

use std::path::Path;
use std::sync::Arc;

use wabidb::domain::ChannelKind;
use wabidb::engine::wabi_store::WabiStore;

use wabi_server::config::{LoreAddonConfig, ServerConfig, ServerRole};
use wabi_server::state::AppState;

fn test_config(data_dir: &Path) -> ServerConfig {
    ServerConfig {
        host: "127.0.0.1".into(),
        port: 0,
        data_dir: data_dir.to_string_lossy().into_owned(),
        uploads_dir: data_dir.join("uploads").to_string_lossy().into_owned(),
        jwt_secret: "test-jwt-secret".into(),
        turn_enabled: false,
        turn_uri: None,
        turn_secret: None,
        node_id: "node-test".into(),
        is_primary: true,
        server_role: ServerRole::Authority,
        authority_url: None,
        admin_user_ids: vec![],
        blacklist_file: data_dir.join("blacklist.txt").to_string_lossy().into_owned(),
        max_body_size: None,
        mesh_enabled: false,
        mesh_peers: vec![],
        lore: LoreAddonConfig {
            enabled: false,
            mode: "sidecar".into(),
            server_url: "lore://localhost:10000".into(),
            binary_path: "lore".into(),
            data_dir: "/var/wabi/lore".into(),
            default_blob_max_size_mb: 1024,
            auto_create_repos: true,
            recordings_channel_name: None,
        },
    }
}

async fn open(data_dir: &Path) -> Arc<AppState> {
    Arc::new(AppState::new(test_config(data_dir)).await.unwrap())
}

#[tokio::test]
async fn deleted_channel_is_gone_immediately() {
    let tmp = tempfile::TempDir::new().unwrap();
    let state = open(tmp.path()).await;

    let channel_id = state
        .wdb
        .create_channel("derek's speaking corner", ChannelKind::Voice, 1, false)
        .await
        .unwrap();
    assert!(state.wdb.get_channel(&channel_id).await.unwrap().is_some());
    assert!(state
        .wdb
        .list_channels(None)
        .await
        .unwrap()
        .iter()
        .any(|c| c.channel_id == channel_id));

    state.wdb.delete_channel(&channel_id, 1).await.unwrap();

    // Tombstone + durable event: every read path reports it gone.
    assert!(state.wdb.get_channel(&channel_id).await.unwrap().is_none());
    assert!(state
        .wdb
        .list_channels(None)
        .await
        .unwrap()
        .iter()
        .all(|c| c.channel_id != channel_id));
    let raw_rows = state.wdb.get_channels_raw().await.unwrap();
    assert!(
        raw_rows.iter().all(|row| {
            row.get("channel_id").and_then(|v| v.as_str()) != Some(channel_id.as_str())
        }),
        "deleted channel still served in the socket-init channel list"
    );
}

#[tokio::test]
async fn deleted_channel_stays_deleted_across_restart() {
    let tmp = tempfile::TempDir::new().unwrap();
    {
        let state = open(tmp.path()).await;
        let channel_id = state
            .wdb
            .create_channel("doomed", ChannelKind::Text, 1, false)
            .await
            .unwrap();
        state.wdb.delete_channel(&channel_id, 1).await.unwrap();
        assert!(state.wdb.get_channel(&channel_id).await.unwrap().is_none());
    } // engine dropped → snapshot + shutdown flush

    // Reopen the same data dir: replay/snapshot must keep the channel gone.
    // (Before the channel_deleted event existed, the projection-only
    // overwrite was lost here and the channel resurrected — a zombie.)
    let reopened = open(tmp.path()).await;
    let channels = reopened.wdb.list_channels(None).await.unwrap();
    assert!(
        channels.iter().all(|c| c.name != "doomed"),
        "deleted channel resurrected on restart: {channels:?}"
    );
}

#[tokio::test]
async fn delete_channel_is_idempotent() {
    let tmp = tempfile::TempDir::new().unwrap();
    let state = open(tmp.path()).await;
    let channel_id = state
        .wdb
        .create_channel("double-tap", ChannelKind::Text, 1, false)
        .await
        .unwrap();
    state.wdb.delete_channel(&channel_id, 1).await.unwrap();
    // Second delete on a gone channel is a no-op, not an error.
    state.wdb.delete_channel(&channel_id, 1).await.unwrap();
    assert!(state.wdb.get_channel(&channel_id).await.unwrap().is_none());
}

#[tokio::test]
async fn dm_channel_lives_under_its_caller_assigned_id() {
    let tmp = tempfile::TempDir::new().unwrap();
    let state = open(tmp.path()).await;

    let dm_id = "dm-user-1-user-2";
    state
        .wdb
        .create_dm_channel(dm_id, "DM with bob", Some(&["user-1", "user-2"]), 1)
        .await
        .unwrap();

    // The row must be reachable under the REAL id every other subsystem
    // uses — a seq-derived phantom row made deletes/lookups miss forever.
    let row = state
        .wdb
        .get_channel(dm_id)
        .await
        .unwrap()
        .expect("DM channel must be stored under its caller-assigned id");
    assert_eq!(row.name, "DM with bob");
    assert_eq!(row.channel_kind, ChannelKind::Dm);

    // No phantom ch_{seq} duplicates in the list.
    let all = state.wdb.list_channels(None).await.unwrap();
    assert!(
        all.iter().all(|c| c.channel_id.starts_with("dm-")),
        "phantom channel rows leaked into the list: {all:?}"
    );

    // And the delete-by-real-id path works.
    state.wdb.delete_dm_channel(dm_id).await.unwrap();
    assert!(state.wdb.get_channel(dm_id).await.unwrap().is_none());
}

#[tokio::test]
async fn group_channel_lives_under_its_caller_assigned_id() {
    let tmp = tempfile::TempDir::new().unwrap();
    let state = open(tmp.path()).await;

    let group_id = "group-1234";
    state
        .wdb
        .upsert_group(group_id, "the crew", "group", Some(&["user-1", "user-2"]), None, None)
        .await
        .unwrap();

    let row = state
        .wdb
        .get_channel(group_id)
        .await
        .unwrap()
        .expect("group channel must be stored under its caller-assigned id");
    assert_eq!(row.name, "the crew");
    assert_eq!(row.channel_kind, ChannelKind::GroupDm);

    state.wdb.delete_channel(group_id, 1).await.unwrap();
    assert!(state.wdb.get_channel(group_id).await.unwrap().is_none());
}
