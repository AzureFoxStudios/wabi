//! Lore chat-integration contract (spec 2026-08-28, Phase 1):
//! - channel bindings are durable: set → get → restart (replay) → still there
//! - promote provenance records survive message deletion (lifecycle decoupling)
//! - removing a binding is durable too

use std::path::Path;
use std::sync::Arc;

use wabidb::engine::wabi_store::WabiStore;
use wabidb::projections::lore::{LoreBindingRecord, LorePromoteRecord};

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

fn sample_binding(channel_id: i64, repo_channel_id: i64) -> LoreBindingRecord {
    LoreBindingRecord {
        channel_id,
        repo_channel_id,
        path: "/art/concepts/".into(),
        branch: "main".into(),
        mode: "hybrid".into(),
        allowed_types: vec!["image/*".into()],
        auto_stage: false,
        updated_by: 1,
        updated_at_micros: 1,
    }
}

fn ch_numeric(ch: &str) -> i64 {
    i64::from_str_radix(ch.strip_prefix("ch_").unwrap(), 16).unwrap()
}

#[tokio::test]
async fn bindings_and_promotes_survive_restart_and_message_deletion() {
    let tmp = tempfile::TempDir::new().unwrap();
    let chat_channel: i64;
    let message_id: String;
    {
        let state = open(tmp.path()).await;

        let chat_ch = state
            .wdb
            .create_channel("concept-art", wabidb::domain::ChannelKind::Text, 1, false)
            .await
            .unwrap();
        chat_channel = ch_numeric(&chat_ch);
        let repo_ch = state
            .wdb
            .create_channel("assets", wabidb::domain::ChannelKind::Lore, 1, false)
            .await
            .unwrap();
        let repo_channel = ch_numeric(&repo_ch);
        state
            .wdb
            .lore_create_repo(repo_channel, "assets", "embedded://assets", 1)
            .await
            .unwrap();

        // Set a binding, read it back.
        let binding = sample_binding(chat_channel, repo_channel);
        state.wdb.lore_set_binding(&binding).await.unwrap();
        let got = state.wdb.lore_get_binding(chat_channel).await.unwrap().unwrap();
        assert_eq!(got, binding);
        assert_eq!(state.wdb.list_lore_bindings().await.unwrap().len(), 1);

        // A message with an attachment, promoted to Lore.
        message_id = state
            .wdb
            .send_message(
                &chat_ch,
                7,
                "check this",
                false,
                &[wabidb::projections::messages::FileAttachmentRecord {
                    file_url: "/uploads/goku_v1.png".into(),
                    file_name: "goku_v1.png".into(),
                    file_size: 1234,
                }],
            )
            .await
            .unwrap();
        let promote = LorePromoteRecord {
            message_id: message_id.clone(),
            channel_id: chat_channel,
            repo_channel_id: repo_channel,
            file_url: "/uploads/goku_v1.png".into(),
            file_name: "goku_v1.png".into(),
            path: "/art/concepts/goku_v1.png".into(),
            branch: "main".into(),
            mode: "direct".into(),
            revision_hash: "abc123".into(),
            pending_review: false,
            review_branch: None,
            promoted_by: 7,
            timestamp_micros: 2,
        };
        state.wdb.lore_record_promote(&promote).await.unwrap();
        assert_eq!(
            state.wdb.lore_promotes_for_message(&message_id).await.unwrap().len(),
            1
        );

        // Lifecycle decoupling: soft-delete the chat message, provenance survives.
        state.wdb.delete_message(&message_id, 7).await.unwrap();
        let deleted = state.wdb.get_message_typed(&message_id).await.unwrap().unwrap();
        assert!(deleted.is_deleted, "message should be tombstoned");
        assert_eq!(
            state.wdb.lore_promotes_for_message(&message_id).await.unwrap().len(),
            1,
            "promote provenance must survive message deletion"
        );
    } // engine dropped → snapshot + shutdown flush

    // Reopen the same data dir: replay must restore binding + promote record.
    let state = open(tmp.path()).await;
    let got = state.wdb.lore_get_binding(chat_channel).await.unwrap().unwrap();
    assert_eq!(got.repo_channel_id, got.repo_channel_id);
    assert_eq!(got.mode, "hybrid");
    let promotes = state.wdb.lore_promotes_for_message(&message_id).await.unwrap();
    assert_eq!(promotes.len(), 1);
    assert_eq!(promotes[0].revision_hash, "abc123");
    assert_eq!(promotes[0].file_name, "goku_v1.png");
    assert_eq!(state.wdb.lore_promotes_for_channel(chat_channel).await.unwrap().len(), 1);

    // Binding removal is durable too.
    state.wdb.lore_remove_binding(chat_channel, 1).await.unwrap();
    assert!(state.wdb.lore_get_binding(chat_channel).await.unwrap().is_none());
}

#[tokio::test]
async fn removed_binding_stays_removed_across_restart() {
    let tmp = tempfile::TempDir::new().unwrap();
    let chat_channel: i64;
    {
        let state = open(tmp.path()).await;
        let chat_ch = state
            .wdb
            .create_channel("staging", wabidb::domain::ChannelKind::Text, 1, false)
            .await
            .unwrap();
        chat_channel = ch_numeric(&chat_ch);
        let repo_ch = state
            .wdb
            .create_channel("assets2", wabidb::domain::ChannelKind::Lore, 1, false)
            .await
            .unwrap();
        let repo_channel = ch_numeric(&repo_ch);
        state
            .wdb
            .lore_create_repo(repo_channel, "assets2", "embedded://assets2", 1)
            .await
            .unwrap();
        state
            .wdb
            .lore_set_binding(&sample_binding(chat_channel, repo_channel))
            .await
            .unwrap();
        state.wdb.lore_remove_binding(chat_channel, 1).await.unwrap();
    }
    let state = open(tmp.path()).await;
    assert!(
        state.wdb.lore_get_binding(chat_channel).await.unwrap().is_none(),
        "removed binding resurrected after replay"
    );
}
