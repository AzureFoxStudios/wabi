//! The configured request cap applies to buffering extractors and direct body
//! readers, including Socket.IO polling, without buffering streaming requests.
//! Ordinary JSON has a separate small budget; raw JSON file uploads retain the
//! file budget and remain subject to the operator's transport ceiling.

use axum::{
    body::{to_bytes, Body, Bytes},
    extract::ConnectInfo,
    http::{Request, StatusCode},
    Router,
};
use futures::StreamExt;
use std::{
    convert::Infallible,
    net::SocketAddr,
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};
use tower::ServiceExt;
use wabi_server::{
    app_router::build_app_router,
    config::{LoreAddonConfig, ServerConfig, ServerRole},
    state::AppState,
};
use wabidb::engine::wabi_store::WabiStore;

fn config(path: &Path, limit: Option<usize>) -> ServerConfig {
    ServerConfig {
        host: "127.0.0.1".into(),
        port: 0,
        data_dir: path.to_string_lossy().into_owned(),
        uploads_dir: path.join("uploads").to_string_lossy().into_owned(),
        jwt_secret: "request-body-limit-contract-secret".into(),
        turn_enabled: false,
        turn_uri: None,
        turn_secret: None,
        node_id: "test".into(),
        is_primary: true,
        server_role: ServerRole::Authority,
        authority_url: None,
        admin_user_ids: vec![],
        blacklist_file: path.join("blacklist").to_string_lossy().into_owned(),
        max_body_size: limit,
        mesh_enabled: false,
        mesh_peers: vec![],
        lore: LoreAddonConfig::default(),
    }
}

fn peer() -> ConnectInfo<SocketAddr> {
    ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 3210)))
}

fn streamed(chunks: Vec<&'static [u8]>) -> (Body, Arc<AtomicUsize>) {
    streamed_bytes(chunks.into_iter().map(Bytes::from_static).collect())
}

fn streamed_bytes(chunks: Vec<Bytes>) -> (Body, Arc<AtomicUsize>) {
    let polled = Arc::new(AtomicUsize::new(0));
    let count = polled.clone();
    let chunks = chunks.into_iter().map(Ok::<_, Infallible>);
    let stream = futures::stream::iter(chunks).inspect(move |_| {
        count.fetch_add(1, Ordering::SeqCst);
    });
    (Body::from_stream(stream), polled)
}

const JSON_LIMIT: usize = 2 * 1024 * 1024;

fn padded_json(json: &str, length: usize) -> Bytes {
    assert!(length >= json.len());
    let mut bytes = json.as_bytes().to_vec();
    bytes.resize(length, b' ');
    Bytes::from(bytes)
}

async fn authenticated_fixture(
    limit: Option<usize>,
) -> (tempfile::TempDir, Arc<AppState>, Router, String, u64) {
    let directory = tempfile::tempdir().unwrap();
    let state = Arc::new(
        AppState::new(config(directory.path(), limit))
            .await
            .unwrap(),
    );
    let uid = state
        .wdb
        .create_user("body-budget-owner", None, "fixture-password-hash")
        .await
        .unwrap();
    state
        .claim_ownership(uid as i64, "body-budget-owner")
        .await
        .unwrap();
    let now = chrono::Utc::now().timestamp();
    let token = jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &wabi_server::auth_extractor::JwtClaims {
            sub: uid.to_string(),
            username: "body-budget-owner".into(),
            is_guest: false,
            iat: now,
            exp: now + 3600,
            jti: "body-budget-fixture-session".into(),
            stepup: false,
            token_type: "access".into(),
        },
        &jsonwebtoken::EncodingKey::from_secret(state.config.jwt_secret.as_bytes()),
    )
    .unwrap();
    let app = build_app_router(Arc::clone(&state));
    (directory, state, app, token, uid)
}

async fn polling_session(app: &Router) -> String {
    let response = app
        .clone()
        .oneshot(
            Request::get("/socket.io/?EIO=4&transport=polling")
                .extension(peer())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
    assert_eq!(bytes[0], b'0', "Engine.IO must return an open packet");
    serde_json::from_slice::<serde_json::Value>(&bytes[1..]).unwrap()["sid"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[tokio::test]
async fn declared_oversize_is_rejected_before_reading_or_dispatching() {
    let directory = tempfile::tempdir().unwrap();
    let state = Arc::new(
        AppState::new(config(directory.path(), Some(16)))
            .await
            .unwrap(),
    );
    let app = build_app_router(state);
    // Health never consumes a body. The global layer must still reject an
    // oversized declaration, including requests outside the API routes.
    let (body, polled) = streamed(vec![b"unread"]);
    let response = app
        .oneshot(
            Request::get("/health")
                .header("content-length", 17)
                .extension(peer())
                .body(body)
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(polled.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn direct_polling_reader_stops_when_unknown_or_false_length_crosses_cap() {
    let directory = tempfile::tempdir().unwrap();
    let state = Arc::new(
        AppState::new(config(directory.path(), Some(16)))
            .await
            .unwrap(),
    );
    let app = build_app_router(state);
    for declared_length in [None, Some(16)] {
        let sid = polling_session(&app).await;
        let (body, polled) = streamed(vec![b"4abcdefg", b"hijklmnop", b"must-not-be-read"]);
        let mut request = Request::post(format!("/socket.io/?EIO=4&transport=polling&sid={sid}"))
            .extension(peer());
        if let Some(length) = declared_length {
            request = request.header("content-length", length);
        }
        let response = app
            .clone()
            .oneshot(request.body(body).unwrap())
            .await
            .unwrap();
        // Engine.IO translates a streaming body error into Bad Request. The
        // over-limit chunk is never delivered and later chunks stay unread.
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(polled.load(Ordering::SeqCst), 2);
    }
    // Exact boundary succeeds through the same direct reader. No small JSON
    // default or full-body buffering is imposed on streamed transport traffic.
    let sid = polling_session(&app).await;
    let (body, polled) = streamed(vec![b"4abcdefg", b"hijklmno"]);
    let response = app
        .oneshot(
            Request::post(format!("/socket.io/?EIO=4&transport=polling&sid={sid}"))
                .extension(peer())
                .body(body)
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(polled.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn unknown_length_json_extractor_keeps_configured_limit() {
    let directory = tempfile::tempdir().unwrap();
    let state = Arc::new(
        AppState::new(config(directory.path(), Some(16)))
            .await
            .unwrap(),
    );
    let app = build_app_router(state);
    let (body, polled) = streamed(vec![
        b"{\"username\":\"one",
        b"more-than-limit\"}",
        b"unread",
    ]);
    let response = app
        .oneshot(
            Request::post("/api/auth/login")
                .header("content-type", "application/json")
                .extension(peer())
                .body(body)
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(polled.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn any_size_default_and_operator_override_keep_their_existing_boundaries() {
    const DEFAULT_BYTES: usize = 50 * 1024 * 1024 * 1024;
    for configured in [None, Some(DEFAULT_BYTES + 1024)] {
        let directory = tempfile::tempdir().unwrap();
        let state = Arc::new(
            AppState::new(config(directory.path(), configured))
                .await
                .unwrap(),
        );
        let app = build_app_router(state);
        let limit = configured.unwrap_or(DEFAULT_BYTES);
        // Exercise declarations without allocating multi-GiB fixture bodies.
        for (declared, expected) in [
            (limit, StatusCode::OK),
            (limit + 1, StatusCode::PAYLOAD_TOO_LARGE),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::get("/health")
                        .header("content-length", declared)
                        .extension(peer())
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
        }
    }
}

#[tokio::test]
async fn anonymous_auth_json_stops_at_small_budget_with_unknown_or_false_length_and_cors() {
    let directory = tempfile::tempdir().unwrap();
    let state = Arc::new(AppState::new(config(directory.path(), None)).await.unwrap());
    let app = build_app_router(state);
    let login = padded_json(r#"{"username":"missing-user","password":"x"}"#, JSON_LIMIT);
    for declared_length in [None, Some(JSON_LIMIT)] {
        let (body, polled) = streamed_bytes(vec![
            login.clone(),
            Bytes::from_static(b" "),
            Bytes::from_static(b"must-not-be-read"),
        ]);
        let mut request = Request::post("/api/auth/login")
            .header("content-type", "application/json")
            .header("origin", "http://localhost")
            .extension(peer());
        if let Some(length) = declared_length {
            request = request.header("content-length", length);
        }
        let response = app
            .clone()
            .oneshot(request.body(body).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(
            response.headers()["access-control-allow-origin"],
            "http://localhost"
        );
        assert_eq!(polled.load(Ordering::SeqCst), 2);
    }
    // The exact boundary remains valid JSON and reaches normal login logic.
    let response = app
        .oneshot(
            Request::post("/api/auth/login")
                .header("content-type", "application/json")
                .extension(peer())
                .body(Body::from(login))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn auth_declared_budget_is_independent_of_content_type_and_precedes_body_reads() {
    let directory = tempfile::tempdir().unwrap();
    let state = Arc::new(AppState::new(config(directory.path(), None)).await.unwrap());
    let app = build_app_router(state);
    for content_type in [
        None,
        Some("application/octet-stream"),
        Some("application/json"),
    ] {
        let (body, polled) = streamed(vec![b"must-not-be-read"]);
        let mut request = Request::post("/api/auth/login")
            .header("content-length", JSON_LIMIT + 1)
            .header("origin", "http://localhost")
            .extension(peer());
        if let Some(content_type) = content_type {
            request = request.header("content-type", content_type);
        }
        let response = app
            .clone()
            .oneshot(request.body(body).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(
            response.headers()["access-control-allow-origin"],
            "http://localhost"
        );
        assert_eq!(polled.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test]
async fn ordinary_json_budget_covers_parameters_and_json_suffixes_without_changing_small_writes() {
    let (_directory, state, app, token, uid) = authenticated_fixture(None).await;
    let layout = r#"{"layoutJson":"{}"}"#;
    for content_type in [
        "application/json",
        "Application/Json; charset=UTF-8",
        "application/vnd.wabi+json; charset=utf-8",
    ] {
        let (body, polled) = streamed_bytes(vec![
            padded_json(layout, JSON_LIMIT),
            Bytes::from_static(b" "),
            Bytes::from_static(b"must-not-be-read"),
        ]);
        let response = app
            .clone()
            .oneshot(
                Request::put("/api/user/layout")
                    .header("authorization", format!("Bearer {token}"))
                    .header("content-type", content_type)
                    .extension(peer())
                    .body(body)
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::PAYLOAD_TOO_LARGE,
            "{content_type}"
        );
        assert_eq!(polled.load(Ordering::SeqCst), 2);
        assert!(state.wdb.get_user_layout(uid).await.unwrap().is_none());
    }
    let response = app
        .oneshot(
            Request::put("/api/user/layout")
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/vnd.wabi+json")
                .extension(peer())
                .body(Body::from(layout))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        state
            .wdb
            .get_user_layout(uid)
            .await
            .unwrap()
            .unwrap()
            .layout_json,
        "{}"
    );
}

#[tokio::test]
async fn content_type_spoofing_cannot_reach_an_ordinary_json_handler_or_consume_its_body() {
    let (_directory, state, app, token, uid) = authenticated_fixture(None).await;
    for content_type in [
        None,
        Some("text/plain"),
        Some("application/json; charset=\"unfinished"),
    ] {
        let (body, polled) =
            streamed_bytes(vec![padded_json(r#"{"layoutJson":"{}"}"#, JSON_LIMIT + 1)]);
        let mut request = Request::put("/api/user/layout")
            .header("authorization", format!("Bearer {token}"))
            .extension(peer());
        if let Some(content_type) = content_type {
            request = request.header("content-type", content_type);
        }
        let response = app
            .clone()
            .oneshot(request.body(body).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
        assert_eq!(polled.load(Ordering::SeqCst), 0);
        assert!(state.wdb.get_user_layout(uid).await.unwrap().is_none());
    }
}

#[tokio::test]
async fn raw_json_file_keeps_file_budget_and_smaller_operator_ceiling_still_wins() {
    let file = padded_json(r#"{"file":"raw-json-upload"}"#, JSON_LIMIT + 1);
    for limit in [None, Some(JSON_LIMIT)] {
        let (_directory, state, app, token, _uid) = authenticated_fixture(limit).await;
        let (body, _) = streamed_bytes(vec![file.clone()]);
        let response = app
            .oneshot(
                Request::post(
                    "/api/blobs/upload?originalName=fixture.json&mimeType=application%2Fjson",
                )
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .extension(peer())
                .body(body)
                .unwrap(),
            )
            .await
            .unwrap();
        if limit.is_some() {
            assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
            assert!(state.blob_registry.list_blobs().await.is_empty());
        } else {
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
            let uploaded: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            let hash = uploaded["hash"].as_str().unwrap();
            let stored = tokio::fs::read(state.blob_registry.blob_path(hash))
                .await
                .unwrap();
            assert_eq!(stored.as_slice(), file.as_ref());
            assert_eq!(uploaded["meta"]["size"], file.len());
        }
    }
}

#[tokio::test]
async fn whiteboard_document_stops_at_existing_budget_even_with_non_json_content_type() {
    let (_directory, _state, app, token, _uid) = authenticated_fixture(None).await;
    let (body, polled) = streamed_bytes(vec![
        padded_json("{}", JSON_LIMIT),
        Bytes::from_static(b" "),
        Bytes::from_static(b"must-not-be-read"),
    ]);
    let response = app
        .oneshot(
            Request::put("/api/whiteboard/boards/fixture/document")
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/octet-stream")
                .extension(peer())
                .body(body)
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(polled.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn lower_route_and_operator_limits_keep_413_after_json_budget_wrapping() {
    // Boosters has a 64 KiB route-local extractor limit. Exercise both that
    // limit and a still-smaller operator limit through the real JSON route.
    for (operator_limit, expected_limit) in [(None, 64 * 1024), (Some(16), 16)] {
        let (_directory, _state, app, token, _uid) = authenticated_fixture(operator_limit).await;
        let (body, polled) = streamed_bytes(vec![
            padded_json("{}", expected_limit),
            Bytes::from_static(b" "),
            Bytes::from_static(b"must-not-be-read"),
        ]);
        let response = app
            .oneshot(
                Request::post("/api/boosters/sessions")
                    .header("authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .extension(peer())
                    .body(body)
                    .unwrap(),
                )
                .await
                .unwrap();
        let status = response.status();
        let rejection = to_bytes(response.into_body(), 4096).await.unwrap();
        assert_eq!(
            status,
            StatusCode::PAYLOAD_TOO_LARGE,
            "operator_limit={operator_limit:?}, expected_limit={expected_limit}, polled={}, body={}",
            polled.load(Ordering::SeqCst),
            String::from_utf8_lossy(&rejection),
        );
        assert_eq!(polled.load(Ordering::SeqCst), 2);
    }
}
