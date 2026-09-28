//! A successful upload acknowledgement must describe complete, published bytes.

use axum::{
    body::{to_bytes, Body},
    extract::ConnectInfo,
    http::{Request, StatusCode},
    Router,
};
use serde_json::{json, Value};
use std::{net::SocketAddr, path::Path, sync::Arc};
use tower::ServiceExt;
use wabi_server::{
    api::routes::create_api_router,
    app_router::build_app_router,
    auth_extractor::JwtClaims,
    config::{LoreAddonConfig, ServerConfig, ServerRole},
    state::AppState,
};
use wabidb::engine::wabi_store::WabiStore;

fn config(path: &Path) -> ServerConfig {
    ServerConfig {
        host: "127.0.0.1".into(),
        port: 0,
        data_dir: path.to_string_lossy().into_owned(),
        uploads_dir: path.join("uploads").to_string_lossy().into_owned(),
        jwt_secret: "resumable-upload-test-secret".into(),
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
    }
}

fn token(id: u64, secret: &str) -> String {
    let now = chrono::Utc::now().timestamp();
    let claims = JwtClaims {
        sub: id.to_string(),
        username: format!("user-{id}"),
        is_guest: false,
        exp: now + 3600,
        iat: now,
        jti: uuid::Uuid::new_v4().to_string(),
        stepup: false,
        token_type: "access".into(),
    };
    jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &claims,
        &jsonwebtoken::EncodingKey::from_secret(secret.as_bytes()),
    )
    .unwrap()
}

async fn json_call(app: &Router, path: &str, bearer: &str, body: Value) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::post(path)
                .header("authorization", format!("Bearer {bearer}"))
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, body)
}

async fn chunk_call(
    app: &Router,
    upload_id: &str,
    upload_token: &str,
    offset: u64,
    bytes: &'static [u8],
) -> StatusCode {
    app.clone()
        .oneshot(
            Request::put(format!(
                "/upload/resumable/chunk?uploadId={upload_id}&offset={offset}"
            ))
            .header("x-upload-token", upload_token)
            .body(Body::from(bytes))
            .unwrap(),
        )
        .await
        .unwrap()
        .status()
}

#[tokio::test]
async fn resumable_upload_rejects_gaps_and_overrun_then_publishes_complete_bytes() {
    let temp = tempfile::tempdir().unwrap();
    let state = Arc::new(AppState::new(config(temp.path())).await.unwrap());
    let user = state
        .wdb
        .create_user("uploader", None, "registered-hash")
        .await
        .unwrap();
    let bearer = token(user, &state.config.jwt_secret);
    let app = create_api_router(state.clone()).with_state(state.clone());

    let (status, init) = json_call(
        &app,
        "/upload/resumable/init",
        &bearer,
        json!({
            "fileName": "note.txt",
            "fileSize": 4,
            "mimeType": "application/octet-stream",
            "channelId": ""
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let upload_id = init["uploadId"].as_str().unwrap();
    let upload_token = init["uploadToken"].as_str().unwrap();

    assert_eq!(
        chunk_call(&app, upload_id, upload_token, 0, b"ab").await,
        StatusCode::OK
    );
    let complete = json!({"uploadId": upload_id, "uploadToken": upload_token});
    assert!(!json_call(
        &app,
        "/upload/resumable/complete",
        &bearer,
        complete.clone()
    )
    .await
    .0
    .is_success());
    assert!(!chunk_call(&app, upload_id, upload_token, 1, b"cd")
        .await
        .is_success());
    assert!(!chunk_call(&app, upload_id, upload_token, 2, b"cde")
        .await
        .is_success());
    // The full server installs a larger default limit. The upload route must
    // retain its own bound before its Bytes extractor allocates the body.
    let full_app = build_app_router(state.clone());
    let oversized = full_app
        .oneshot(
            Request::put(format!(
                "/api/upload/resumable/chunk?uploadId={upload_id}&offset=2"
            ))
            .header("x-upload-token", upload_token)
            .extension(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 3001))))
            .body(Body::from(vec![0_u8; 8 * 1024 * 1024 + 1]))
            .unwrap(),
        )
        .await
        .unwrap();
    let oversized_status = oversized.status();
    let oversized_body = to_bytes(oversized.into_body(), 4096).await.unwrap();
    assert_eq!(
        oversized_status,
        StatusCode::PAYLOAD_TOO_LARGE,
        "oversized response: {}",
        String::from_utf8_lossy(&oversized_body)
    );
    let staging = temp.path().join("uploads/.tmp").join(upload_id);
    std::fs::write(&staging, b"a").unwrap();
    assert!(!chunk_call(&app, upload_id, upload_token, 2, b"cd")
        .await
        .is_success());
    std::fs::write(&staging, b"ab").unwrap();
    assert_eq!(
        chunk_call(&app, upload_id, upload_token, 2, b"cd").await,
        StatusCode::OK
    );
    let (status, done) = json_call(&app, "/upload/resumable/complete", &bearer, complete).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(done["fileSize"], 4);
    let filename = done["fileUrl"]
        .as_str()
        .unwrap()
        .strip_prefix("/uploads/")
        .unwrap();
    assert_eq!(
        std::fs::read(temp.path().join("uploads").join(filename)).unwrap(),
        b"abcd"
    );
    assert!(state.upload_registry.get(filename).await.is_some());
    let record = state
        .wdb
        .engine()
        .projection_state()
        .get(
            wabidb::projections::upload_assets::INDEX,
            filename.as_bytes(),
        )
        .expect("upload hash must be durable before successful completion");
    let record = wabidb::projections::upload_assets::decode(&record).unwrap();
    assert_eq!(record.size, 4);
    assert_eq!(
        record.sha256,
        "88d4266fd4e6338d13b845fcf289579d209c897823b9217da3e161936f031589"
    );
    assert!(state.upload_state.sessions.read().await.is_empty());
}
