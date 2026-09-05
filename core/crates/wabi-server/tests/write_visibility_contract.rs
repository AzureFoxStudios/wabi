//! Verify the command completion guarantee through actual HTTP handlers,
//! their live-event payloads, and the real WabiDB adapter.
use std::{path::Path, sync::Arc};

use axum::{
    body::{to_bytes, Body},
    extract::ConnectInfo,
    http::{Request, StatusCode},
    Router,
};
use serde_json::{json, Value};
use tower::ServiceExt;
use wabi_server::{
    app_router::build_app_router,
    auth_extractor::JwtClaims,
    config::{LoreAddonConfig, ServerConfig, ServerRole},
    state::AppState,
    websocket::WsMessage,
};
use wabidb::{
    engine::wabi_store::WabiStore,
    format::record::RecordKind,
    sequencer::types::{CommandCommit, EventToWrite},
};

async fn server(path: &Path) -> Arc<AppState> {
    Arc::new(
        AppState::new(ServerConfig {
            host: "127.0.0.1".into(),
            port: 0,
            data_dir: path.to_string_lossy().into_owned(),
            uploads_dir: path.join("uploads").to_string_lossy().into_owned(),
            jwt_secret: "test-only-secret".into(),
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
        })
        .await
        .unwrap(),
    )
}

async fn post(app: &Router, token: &str, path: &str, body: Value) -> Value {
    let response = app
        .clone()
        .oneshot(
            Request::post(path)
                .extension(ConnectInfo(
                    "127.0.0.1:12345".parse::<std::net::SocketAddr>().unwrap(),
                ))
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let body: Value = serde_json::from_slice(&bytes)
        .unwrap_or_else(|e| panic!("{path}: {status}: {e}: {}", String::from_utf8_lossy(&bytes)));
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

fn get(path: &str) -> Request<Body> {
    Request::get(path)
        .extension(ConnectInfo(
            "127.0.0.1:12345".parse::<std::net::SocketAddr>().unwrap(),
        ))
        .body(Body::empty())
        .unwrap()
}

#[tokio::test]
async fn successful_call_http_writes_publish_current_session_and_roster() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let user_id = state
        .wdb
        .create_user("caller", None, "not-an-empty-guest-hash")
        .await
        .unwrap();
    let now = chrono::Utc::now().timestamp();
    let token = jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &JwtClaims {
            sub: user_id.to_string(),
            username: "caller".into(),
            is_guest: false,
            exp: now + 3600,
            iat: now,
            jti: "test-call".into(),
            stepup: false,
            token_type: "access".into(),
        },
        &jsonwebtoken::EncodingKey::from_secret(state.config.jwt_secret.as_bytes()),
    )
    .unwrap();
    let app = build_app_router(state.clone());
    let mut pushes = state.call_session_push.subscribe();
    post(
        &app,
        &token,
        "/api/calls/sessions",
        json!({
            "session_id": "visibility", "channel_id": "ch_test", "call_type": "audio-call",
            "max_participants": 10, "transport": "wabidb"
        }),
    )
    .await;
    let (_, message) = pushes
        .try_recv()
        .expect("create response must not precede its live snapshot");
    assert!(
        matches!(message.as_ref(), WsMessage::CallSessionChanged { session } if session.session_id == "visibility" && session.active)
    );
    post(
        &app,
        &token,
        "/api/calls/sessions/visibility/join",
        json!({ "stable_user_id": format!("user-{user_id}") }),
    )
    .await;
    let (_, message) = pushes
        .try_recv()
        .expect("join must publish the applied roster");
    assert!(
        matches!(message.as_ref(), WsMessage::CallParticipantChanged { participants, .. } if participants.len() == 1 && participants[0].user_id == user_id)
    );
    post(
        &app,
        &token,
        "/api/calls/sessions/visibility/leave",
        json!({}),
    )
    .await;
    let (_, message) = pushes.try_recv().unwrap();
    assert!(
        matches!(message.as_ref(), WsMessage::CallParticipantChanged { participants, .. }
        if participants.len() == 1 && participants[0].left_at_micros.is_some())
    );
    post(
        &app,
        &token,
        "/api/calls/sessions/visibility/end",
        json!({}),
    )
    .await;
    let (_, message) = pushes.try_recv().unwrap();
    assert!(
        matches!(message.as_ref(), WsMessage::CallSessionChanged { session } if !session.active)
    );
    // The album route used to compensate for the same race with 20 polls.
    let album = post(
        &app,
        &token,
        "/api/albums",
        json!({
            "name": "immediately visible", "scope_type": "channel", "scope_id": "ch_test"
        }),
    )
    .await;
    assert_eq!(album["album"]["name"], "immediately visible");
}

#[tokio::test]
async fn lore_metadata_is_queryable_before_its_change_cursor_is_returned() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    // No external Lore service required: this verifies Wabi's metadata contract.
    state
        .wdb
        .lore_create_repo(42, "assets", "lore://localhost:10000", 1)
        .await
        .unwrap();
    assert!(state.wdb.lore_get_repo(42).await.unwrap().is_some());
    let cursor = state
        .wdb
        .lore_file_change(42, "image.png", "upload", Some("etag"), "revision", 1)
        .await
        .unwrap();
    let changes = state.wdb.list_lore_file_changes(42, 0).await.unwrap();
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].seq, cursor);
}

#[tokio::test]
async fn health_and_readiness_fail_when_the_writer_has_stopped_but_reads_still_work() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let app = build_app_router(state.clone());
    for path in ["/health", "/readyz", "/livez"] {
        assert_eq!(
            app.clone().oneshot(get(path)).await.unwrap().status(),
            StatusCode::OK,
            "{path}"
        );
    }
    let engine = state.wdb.engine();
    engine.get_or_create_stream_key("bad").await.unwrap();
    assert!(engine
        .run_command(CommandCommit {
            caller_user_id: 1,
            caller_device_id: "test".into(),
            command_name: "bad".into(),
            idempotency_key: None,
            essential: true,
            response_tx: tokio::sync::oneshot::channel().0,
            events: vec![EventToWrite {
                stream_id: "bad".into(),
                stream_kind: 6,
                event_type: "user_registered".into(),
                record_kind: RecordKind::Event,
                plaintext: vec![]
            }],
        })
        .await
        .is_err());
    assert!(
        state.wdb.list_users().await.is_ok(),
        "old readiness probe would have succeeded"
    );
    for path in ["/health", "/readyz"] {
        assert_eq!(
            app.clone().oneshot(get(path)).await.unwrap().status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
    }
    assert_eq!(
        app.oneshot(get("/livez")).await.unwrap().status(),
        StatusCode::OK
    );
}
