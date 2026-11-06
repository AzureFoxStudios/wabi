//! Promoting a chat attachment into a Lore repo must require membership of the
//! *target* repo channel, not only the channel that holds the message.
//! Real API router + real WabiDB; the Lore CLI is a protocol fixture that logs
//! every `commit` so the test can prove no commit happened.
#![cfg(all(feature = "wabi-lore", unix))]

use std::{os::unix::fs::PermissionsExt, path::Path, sync::Arc};

use axum::{
    body::{to_bytes, Body},
    http::{Method, Request, StatusCode},
};
use serde_json::{json, Value};
use tower::ServiceExt;
use wabi_server::{
    api::routes::create_api_router,
    auth_extractor::JwtClaims,
    config::{LoreAddonConfig, ServerConfig, ServerRole},
    state::AppState,
};
use wabidb::{
    domain::{ChannelKind, MemberRole},
    engine::wabi_store::WabiStore,
    projections::messages::FileAttachmentRecord,
};

fn server_config(path: &Path) -> ServerConfig {
    ServerConfig {
        host: "127.0.0.1".into(),
        port: 0,
        data_dir: path.to_string_lossy().into_owned(),
        uploads_dir: path.join("uploads").to_string_lossy().into_owned(),
        jwt_secret: "lore-promote-membership-test-only".into(),
        turn_enabled: false,
        turn_uri: None,
        turn_secret: None,
        node_id: "test".into(),
        is_primary: true,
        server_role: ServerRole::Authority,
        authority_url: None,
        admin_user_ids: vec![],
        blacklist_file: path.join("blacklist.txt").to_string_lossy().into_owned(),
        max_body_size: None,
        mesh_enabled: false,
        mesh_peers: vec![],
        lore: LoreAddonConfig::default(),
    }
}

fn jwt(state: &AppState, uid: u64, username: &str) -> String {
    let now = chrono::Utc::now().timestamp();
    jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &JwtClaims {
            sub: uid.to_string(),
            username: username.into(),
            is_guest: false,
            exp: now + 3600,
            iat: now,
            jti: uuid::Uuid::new_v4().to_string(),
            stepup: false,
            token_type: "access".into(),
        },
        &jsonwebtoken::EncodingKey::from_secret(state.config.jwt_secret.as_bytes()),
    )
    .unwrap()
}

fn numeric(channel: &str) -> i64 {
    i64::from_str_radix(channel.strip_prefix("ch_").unwrap(), 16).unwrap()
}

async fn promote(
    app: &axum::Router,
    token: &str,
    payload: Value,
) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/addons/lore/promote/from-message")
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(payload.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    let body =
        serde_json::from_slice(&bytes).unwrap_or_else(|_| json!(String::from_utf8_lossy(&bytes)));
    (status, body)
}

#[tokio::test]
async fn promote_requires_membership_of_the_target_repo_channel() {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(AppState::new(server_config(dir.path())).await.unwrap());

    // Owner exists so the artist is an ordinary, non-admin registered member.
    let owner = state
        .wdb
        .create_user("owner", None, "test-registered-hash")
        .await
        .unwrap();
    state.wdb.claim_owner(owner).await.unwrap();
    *state.owner_user_id.write().await = Some(owner as i64);

    // Artist: workspace role Artist (lore.stage, no lore.commit), member of X only.
    let artist = state
        .wdb
        .create_user("artist", None, "test-registered-hash")
        .await
        .unwrap();
    state
        .wdb
        .ingest_event(
            "rbac",
            "assign_role",
            &json!({
                "userId": artist,
                "workspaceId": "default-workspace",
                "role": "Artist",
                "assignedBy": owner,
            }),
        )
        .await
        .unwrap();

    let x = state
        .wdb
        .create_channel("x-chat", ChannelKind::Text, owner, false)
        .await
        .unwrap();
    let y = state
        .wdb
        .create_channel("y-lore", ChannelKind::Lore, owner, false)
        .await
        .unwrap();
    for (channel, uid) in [(&x, owner), (&x, artist), (&y, owner)] {
        state
            .wdb
            .add_channel_member(channel, uid, MemberRole::Member)
            .await
            .unwrap();
    }
    let y_id = numeric(&y);

    // Attachment bytes on disk + a message in X that references them.
    std::fs::create_dir_all(dir.path().join("uploads")).unwrap();
    std::fs::write(dir.path().join("uploads/art.png"), b"png-bytes").unwrap();
    let message_id = state
        .wdb
        .send_message(
            &x,
            artist,
            "look",
            false,
            &[FileAttachmentRecord {
                file_url: "/uploads/art.png".into(),
                file_name: "art.png".into(),
                file_size: 9,
            }],
        )
        .await
        .unwrap();

    // Lore repo on Y, backed by a CLI fixture that logs each commit.
    let commit_log = dir.path().join("commits.log");
    let binary = dir.path().join("lore-fixture");
    std::fs::write(
        &binary,
        format!(
            "#!/bin/sh\n\
             if [ \"$1\" = \"--offline\" ] && [ \"$2\" = \"--local\" ]; then shift 2; fi\n\
             case \"$1:$2\" in\n\
               repository:create|stage:*|status:--scan|branch:*) exit 0 ;;\n\
               commit:*) echo commit >> '{}'\n\
                 printf 'Revision  : 1\\nSignature : abcdef0123456789abcdef0123456789\\nDate      : Mon, 07 Sep 2026 00:00:00 +0000\\n    fixture\\nCommit succeeded\\n' ;;\n\
               *) echo unexpected >&2; exit 1 ;;\n\
             esac\n",
            commit_log.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
    let lore = Arc::new(wabi_lore::LoreService::new(wabi_lore::LoreConfig {
        lore_binary_path: binary,
        lore_data_dir: dir.path().join("lore"),
        ..Default::default()
    }));
    lore.create_repo(y_id, owner as i64, "y").await.unwrap();
    // Pre-existing file so a collision response would reveal that it exists.
    let tree = lore.repo_working_tree(y_id).await.unwrap();
    std::fs::create_dir_all(tree.join("probe")).unwrap();
    std::fs::write(tree.join("probe/art.png"), b"existing").unwrap();
    state.set_lore_service(lore).await;

    let app = create_api_router(state.clone()).with_state(state.clone());
    let token = jwt(&state, artist, "artist");

    // Fresh path, and a path that already exists (collision probe).
    for path in ["fresh", "probe"] {
        let (status, body) = promote(
            &app,
            &token,
            json!({
                "message_id": message_id,
                "file_url": "/uploads/art.png",
                "repo_channel_id": y_id,
                "path": path,
                "mode": "direct",
            }),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::FORBIDDEN,
            "non-member promote into {path} must be refused: {body}"
        );
    }

    assert!(
        !tree.join("fresh/art.png").exists(),
        "refused promote must not write into the target repo"
    );
    assert_eq!(
        std::fs::read(tree.join("probe/art.png")).unwrap(),
        b"existing",
        "refused promote must not overwrite existing repo files"
    );
    assert!(
        !commit_log.exists(),
        "refused promote must not create a Lore commit"
    );
    assert!(
        state.wdb.lore_promotes_for_message(&message_id).await.unwrap().is_empty(),
        "refused promote must not record provenance"
    );
}
