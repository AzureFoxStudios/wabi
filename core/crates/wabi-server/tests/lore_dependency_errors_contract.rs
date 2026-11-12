//! Absent or rejected Lore dependencies must answer with a stated status, not
//! a bare 500: missing `lore` -> 503, invalid import URL -> 400, a path the
//! repo's .wabiignore excludes -> 422. Real API router and real WabiDB; the
//! Lore CLI is a shell stand-in (not the real `lore` binary).
#![cfg(all(feature = "wabi-lore", unix))]

use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::Arc,
};

use axum::{
    body::{to_bytes, Body},
    http::{Request, Response, StatusCode},
};
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
};


fn jwt(state: &AppState, uid: u64) -> String {
    let now = chrono::Utc::now().timestamp();
    jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &JwtClaims {
            sub: uid.to_string(),
            username: "artist".into(),
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

struct Fixture {
    _dir: tempfile::TempDir,
    app: axum::Router,
    #[allow(dead_code)]
    lore: Arc<wabi_lore::LoreService>,
    #[allow(dead_code)]
    tree: PathBuf,
    channel: i64,
    token: String,
    owner_token: String,
    binary: PathBuf,
}

async fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path();
    let config = ServerConfig {
        host: "127.0.0.1".into(),
        port: 0,
        data_dir: path.to_string_lossy().into_owned(),
        uploads_dir: path.join("uploads").to_string_lossy().into_owned(),
        jwt_secret: "lore-dependency-errors-test".into(),
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
    };
    let state = Arc::new(AppState::new(config).await.unwrap());
    let owner = state.wdb.create_user("owner", None, "h").await.unwrap();
    state.wdb.claim_owner(owner).await.unwrap();
    *state.owner_user_id.write().await = Some(owner as i64);
    let artist = state.wdb.create_user("artist", None, "h").await.unwrap();
    state
        .wdb
        .ingest_event(
            "rbac",
            "assign_role",
            &serde_json::json!({"userId": artist, "workspaceId": "default-workspace",
                "role": "Artist", "assignedBy": owner}),
        )
        .await
        .unwrap();
    let assets = state
        .wdb
        .create_channel("assets", ChannelKind::Lore, owner, false)
        .await
        .unwrap();
    for uid in [owner, artist] {
        state.wdb.add_channel_member(&assets, uid, MemberRole::Member).await.unwrap();
    }
    // Shell stand-in for the lore binary: every commit gets a fresh signature.
    let counter = path.join("commit-counter");
    let binary = path.join("lore-fixture");
    std::fs::write(
        &binary,
        format!(
            "#!/bin/sh\n\
             if [ \"$1\" = \"--offline\" ] && [ \"$2\" = \"--local\" ]; then shift 2; fi\n\
             case \"$1\" in\n\
               commit) n=$(( $(cat '{c}' 2>/dev/null || echo 0) + 1 )); echo $n > '{c}'\n\
                 printf 'Revision  : %s\\nSignature : %032d\\nBranch    : main\\nDate      : Mon, 07 Sep 2026 00:00:00 +0000\\n    fixture\\nCommit succeeded\\n' $n $n ;;\n\
               branch) [ \"$2\" = list ] && echo '* main' ; exit 0 ;;\n\
               *) exit 0 ;;\n\
             esac\n",
            c = counter.display(),
        ),
    )
    .unwrap();
    std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
    let lore = Arc::new(wabi_lore::LoreService::new(wabi_lore::LoreConfig {
        enabled: true,
        lore_binary_path: binary.clone(),
        lore_data_dir: path.join("lore"),
        default_blob_max_size_mb: 1,
        ..Default::default()
    }));
    let channel = i64::from_str_radix(assets.strip_prefix("ch_").unwrap(), 16).unwrap();
    lore.create_repo(channel, owner as i64, "assets").await.unwrap();
    let tree = lore.repo_working_tree(channel).await.unwrap();
    state.set_lore_service(lore.clone()).await;
    let app = create_api_router(state.clone()).with_state(state.clone());
    Fixture { token: jwt(&state, artist), owner_token: jwt(&state, owner), binary, _dir: dir, app, lore, tree, channel }
}


async fn send(f: &Fixture, method: &str, uri: String, token: &str, body: Option<serde_json::Value>) -> (StatusCode, serde_json::Value) {
    let mut req = Request::builder()
        .method(method)
        .uri(uri)
        .header("authorization", format!("Bearer {token}"));
    let body = match body {
        Some(json) => {
            req = req.header("content-type", "application/json");
            Body::from(json.to_string())
        }
        None => Body::from("bytes"),
    };
    let response = f.app.clone().oneshot(req.body(body).unwrap()).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or_default())
}

fn upload_uri(f: &Fixture, path: &str) -> String {
    format!("/addons/lore/repos/{}/files/{path}", f.channel)
}

/// The lore binary disappears after the server started: the request is a 503
/// that names the dependency, not a 500.
#[tokio::test]
async fn missing_lore_binary_at_request_time_is_503() {
    let f = fixture().await;
    std::fs::remove_file(&f.binary).unwrap();
    let (status, body) = send(&f, "PUT", upload_uri(&f, "a.txt"), &f.token, None).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    let message = body["error"].as_str().unwrap();
    assert!(message.starts_with("Lore addon dependency missing"), "{message}");
    assert!(message.contains("lore"), "{message}");
}

/// An import URL that fails validation is a 400 carrying the reason.
#[tokio::test]
async fn invalid_import_url_is_400_with_the_reason() {
    let f = fixture().await;
    let (status, body) = send(
        &f,
        "POST",
        "/addons/lore/repos/import".into(),
        &f.owner_token,
        Some(serde_json::json!({
            "channel_id": f.channel, "name": "x", "upstream_url": "http://example.com/repo.git"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(
        body["error"].as_str().unwrap().contains("public HTTPS repository URL"),
        "{body}"
    );
}

/// An upload to a path the repo's .wabiignore excludes is a 422, and nothing
/// reaches the working tree.
#[tokio::test]
async fn upload_blocked_by_wabiignore_is_422() {
    let f = fixture().await;
    let ignored = std::fs::read_to_string(f.tree.join(".wabiignore")).unwrap_or_default();
    assert!(ignored.contains("node_modules"), "seeded .wabiignore changed: {ignored}");
    let (status, body) =
        send(&f, "PUT", upload_uri(&f, "node_modules/pkg/x.js"), &f.token, None).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"], "path is ignored by .wabiignore");
    assert!(!f.tree.join("node_modules").exists());
}
