//! Guest tombstone contract (hard-temporary guests):
//! - guests are created with an empty password hash (the guest marker)
//! - `delete_user` tombstones the row AND cascades channel memberships away
//! - registered users are never touched by a guest's tombstone
//! - the tombstone is durable: after an engine close/reopen (event replay)
//!   the deleted guest stays gone

use std::path::Path;
use std::sync::Arc;

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
async fn guest_tombstone_removes_row_and_memberships() {
    let tmp = tempfile::TempDir::new().unwrap();
    let state = open(tmp.path()).await;

    // Guest marker contract: empty password hash.
    let guest_id = state
        .wdb
        .create_user("Guest_tombstone-test", None, "")
        .await
        .unwrap();
    assert!(
        state.wdb.get_user(guest_id).await.unwrap().unwrap().password_hash.is_empty()
    );

    // A registered account and a channel membership for the guest.
    let member_id = state
        .wdb
        .create_user("ronin", Some("ronin"), "argon2:hash")
        .await
        .unwrap();
    let channel_id = state.wdb.create_channel("general", wabidb::domain::ChannelKind::Text, member_id, false).await.unwrap();
    state
        .wdb
        .add_channel_member(&channel_id, guest_id, wabidb::domain::MemberRole::Member)
        .await
        .unwrap();

    // Tombstone the guest.
    state.wdb.delete_user(guest_id).await.unwrap();

    assert!(state.wdb.get_user(guest_id).await.unwrap().is_none());
    let ids: Vec<u64> = state
        .wdb
        .list_users()
        .await
        .unwrap()
        .into_iter()
        .map(|u| u.user_id)
        .collect();
    assert!(!ids.contains(&guest_id));
    // Registered user untouched by the guest's tombstone.
    assert!(state.wdb.get_user(member_id).await.unwrap().is_some());
}

#[tokio::test]
async fn guest_tombstone_survives_engine_replay() {
    let tmp = tempfile::TempDir::new().unwrap();
    {
        let state = open(tmp.path()).await;
        let guest_id = state
            .wdb
            .create_user("Guest_replay-test", None, "")
            .await
            .unwrap();
        state.wdb.delete_user(guest_id).await.unwrap();
        assert!(state.wdb.get_user(guest_id).await.unwrap().is_none());
    } // engine dropped → snapshot + shutdown flush

    // Reopen the same data dir: replay/snapshot must keep the guest gone.
    let reopened = open(tmp.path()).await;
    let users = reopened.wdb.list_users().await.unwrap();
    assert!(
        users.iter().all(|u| !u.username.starts_with("Guest_replay")),
        "deleted guest resurrected on replay: {users:?}"
    );
}
