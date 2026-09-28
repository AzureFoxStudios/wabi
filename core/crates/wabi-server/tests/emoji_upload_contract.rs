//! The public upload route creates bounded emotes without replacing another
//! member's existing server-wide asset, including concurrent same-name creates.
use std::{path::Path, sync::Arc};

use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use serde_json::Value;
use tower::ServiceExt;
use wabi_server::{
    api::routes::create_api_router,
    auth_extractor::JwtClaims,
    config::{LoreAddonConfig, ServerConfig, ServerRole},
    state::AppState,
};
use wabidb::engine::wabi_store::WabiStore;

async fn server(path: &Path) -> Arc<AppState> {
    Arc::new(
        AppState::new(ServerConfig {
            host: "127.0.0.1".into(),
            port: 0,
            data_dir: path.to_string_lossy().into_owned(),
            uploads_dir: path.join("uploads").to_string_lossy().into_owned(),
            jwt_secret: "emoji-test-only".into(),
            turn_enabled: false,
            turn_uri: None,
            turn_secret: None,
            node_id: "test".into(),
            is_primary: true,
            server_role: ServerRole::Authority,
            authority_url: None,
            admin_user_ids: vec![],
            blacklist_file: path.join("blacklist").to_string_lossy().into_owned(),
            max_body_size: None,
            mesh_enabled: false,
            mesh_peers: vec![],
            lore: LoreAddonConfig::default(),
        })
        .await
        .unwrap(),
    )
}

fn jwt(state: &AppState, user_id: u64, guest: bool) -> String {
    let now = chrono::Utc::now().timestamp();
    jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &JwtClaims {
            sub: user_id.to_string(),
            username: format!("user-{user_id}"),
            is_guest: guest,
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

async fn upload(
    app: &Router,
    token: &str,
    fields: &[(&str, &str)],
    filename: &str,
    bytes: &[u8],
) -> (StatusCode, Value) {
    let boundary = "wabi-emoji-test-boundary";
    let mut body = Vec::new();
    for (name, value) in fields {
        body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").as_bytes());
    }
    body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: image/webp\r\n\r\n").as_bytes());
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let response = app
        .clone()
        .oneshot(
            Request::post("/emoji/upload")
                .header("authorization", format!("Bearer {token}"))
                .header(
                    "content-type",
                    format!("multipart/form-data; boundary={boundary}"),
                )
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

const WEBP: &[u8] = b"RIFF\x10\x00\x00\x00WEBPVP8Lfixture";

fn published_file_count(directory: &Path) -> usize {
    std::fs::read_dir(directory)
        .unwrap()
        .filter(|entry| entry.as_ref().unwrap().file_type().unwrap().is_file())
        .count()
}

#[tokio::test]
async fn members_can_create_but_cannot_replace_existing_server_emotes() {
    let directory = tempfile::tempdir().unwrap();
    let state = server(directory.path()).await;
    let owner = state
        .wdb
        .create_user("owner", None, "registered-hash")
        .await
        .unwrap();
    let creator = state
        .wdb
        .create_user("creator", None, "registered-hash")
        .await
        .unwrap();
    let other = state
        .wdb
        .create_user("other", None, "registered-hash")
        .await
        .unwrap();
    let app = create_api_router(state.clone()).with_state(state.clone());
    let token = jwt(&state, creator, false);
    let (status, body) = upload(
        &app,
        &token,
        &[
            ("name", " wave "),
            ("displayName", " Wave "),
            ("type", "sticker"),
        ],
        "claimed.html",
        WEBP,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["emoji"]["name"], "wave");
    assert_eq!(body["emoji"]["displayName"], "Wave");
    assert_eq!(body["emoji"]["type"], "sticker");
    let url = body["emoji"]["url"].as_str().unwrap();
    assert!(
        url.ends_with(".webp"),
        "Image format owns stored extension: {url}"
    );
    let saved = state.wdb.get_emotes().await.unwrap();
    assert_eq!(saved.len(), 1);
    assert_eq!(saved[0].created_by_user_id, creator);
    assert_eq!(saved[0].image_url, url);
    assert_eq!(
        std::fs::read(
            directory
                .path()
                .join("uploads")
                .join(url.strip_prefix("/uploads/").unwrap())
        )
        .unwrap(),
        WEBP
    );
    for user in [creator, other, owner] {
        let (status, body) = upload(
            &app,
            &jwt(&state, user, false),
            &[("name", "wave")],
            "replacement.webp",
            WEBP,
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
    }
    assert_eq!(state.wdb.get_emotes().await.unwrap(), saved);
    assert_eq!(published_file_count(&directory.path().join("uploads")), 1);
}

#[tokio::test]
async fn invalid_metadata_and_images_fail_before_publication() {
    let directory = tempfile::tempdir().unwrap();
    let state = server(directory.path()).await;
    let user = state
        .wdb
        .create_user("member", None, "registered-hash")
        .await
        .unwrap();
    let app = create_api_router(state.clone()).with_state(state.clone());
    let token = jwt(&state, user, false);
    let long_label = "x".repeat(61);
    for fields in [
        vec![("name", "bad:name")],
        vec![("name", "wave"), ("type", "script")],
        vec![("name", "wave"), ("artist", long_label.as_str())],
    ] {
        let (status, body) = upload(&app, &token, &fields, "asset.webp", WEBP).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    }
    let (status, body) = upload(
        &app,
        &token,
        &[("name", "wave")],
        "asset.webp",
        b"RIFFnot-an-imageWEBP",
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let mut oversized_image = WEBP.to_vec();
    oversized_image.resize(2 * 1024 * 1024 + 1, 0);
    let (status, body) = upload(
        &app,
        &token,
        &[("name", "wave")],
        "asset.webp",
        &oversized_image,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let (status, body) = upload(
        &app,
        &jwt(&state, user, true),
        &[("name", "wave")],
        "asset.webp",
        WEBP,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert!(state.wdb.get_emotes().await.unwrap().is_empty());
    assert!(
        !directory.path().join("uploads").exists()
            || std::fs::read_dir(directory.path().join("uploads"))
                .unwrap()
                .next()
                .is_none()
    );
}

#[tokio::test]
async fn file_storage_failure_returns_an_error_without_creating_an_emote() {
    let directory = tempfile::tempdir().unwrap();
    let state = server(directory.path()).await;
    let user = state
        .wdb
        .create_user("member", None, "registered-hash")
        .await
        .unwrap();
    let app = create_api_router(state.clone()).with_state(state.clone());
    let uploads = directory.path().join("uploads");
    // The configured upload directory cannot be created over an ordinary file.
    std::fs::write(&uploads, b"storage-failure-canary").unwrap();
    let (status, body) = upload(
        &app,
        &jwt(&state, user, false),
        &[("name", "wave")],
        "asset.webp",
        WEBP,
    )
    .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
    assert!(body.get("emoji").is_none(), "{body}");
    assert!(state.wdb.get_emotes().await.unwrap().is_empty());
    assert!(state.upload_registry.list().await.is_empty());
    assert_eq!(std::fs::read(uploads).unwrap(), b"storage-failure-canary");
}

#[tokio::test]
async fn simultaneous_shortcode_claims_publish_exactly_one_asset() {
    let directory = tempfile::tempdir().unwrap();
    let state = server(directory.path()).await;
    let a = state
        .wdb
        .create_user("a", None, "registered-hash")
        .await
        .unwrap();
    let b = state
        .wdb
        .create_user("b", None, "registered-hash")
        .await
        .unwrap();
    let app = create_api_router(state.clone()).with_state(state.clone());
    let token_a = jwt(&state, a, false);
    let token_b = jwt(&state, b, false);
    let fields = [("name", "shared")];
    let (first, second) = tokio::join!(
        upload(&app, &token_a, &fields, "a.webp", WEBP),
        upload(&app, &token_b, &fields, "b.webp", WEBP)
    );
    assert!(
        matches!(
            (first.0, second.0),
            (StatusCode::OK, StatusCode::CONFLICT) | (StatusCode::CONFLICT, StatusCode::OK)
        ),
        "{first:?} {second:?}"
    );
    let saved = state.wdb.get_emotes().await.unwrap();
    assert_eq!(saved.len(), 1);
    assert_eq!(saved[0].name, "shared");
    assert_eq!(published_file_count(&directory.path().join("uploads")), 1);
}
