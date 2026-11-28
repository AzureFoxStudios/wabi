//! An uploaded file can be read in parts, so a client can look inside a large
//! archive without downloading all of it.

use axum::{
    body::{to_bytes, Body},
    extract::ConnectInfo,
    http::{header, Request, StatusCode},
};
use std::{net::SocketAddr, path::Path, sync::Arc};
use tower::ServiceExt;
use wabi_server::{
    app_router::build_app_router,
    config::{LoreAddonConfig, ServerConfig, ServerRole},
    state::AppState,
};

fn config(path: &Path) -> ServerConfig {
    ServerConfig {
        host: "127.0.0.1".into(),
        port: 0,
        data_dir: path.to_string_lossy().into_owned(),
        uploads_dir: path.join("uploads").to_string_lossy().into_owned(),
        jwt_secret: "upload-range-test-secret".into(),
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

async fn get(
    state: &Arc<AppState>,
    range: Option<&str>,
) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
    let mut request = Request::get("/uploads/letters.bin")
        .extension(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 3001))));
    if let Some(range) = range {
        request = request.header(header::RANGE, range);
    }
    let response = build_app_router(state.clone())
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let (parts, body) = response.into_parts();
    let bytes = to_bytes(body, usize::MAX).await.unwrap().to_vec();
    (parts.status, parts.headers, bytes)
}

#[tokio::test]
async fn an_upload_can_be_read_in_parts() {
    let temp = tempfile::tempdir().unwrap();
    let state = Arc::new(AppState::new(config(temp.path())).await.unwrap());
    let uploads = temp.path().join("uploads");
    std::fs::create_dir_all(&uploads).unwrap();
    std::fs::write(uploads.join("letters.bin"), b"abcdefghijklmnopqrstuvwxyz").unwrap();

    let (status, headers, body) = get(&state, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::ACCEPT_RANGES], "bytes");
    assert_eq!(body, b"abcdefghijklmnopqrstuvwxyz");

    let (status, headers, body) = get(&state, Some("bytes=2-5")).await;
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(headers[header::CONTENT_RANGE], "bytes 2-5/26");
    assert_eq!(headers[header::CONTENT_LENGTH], "4");
    assert_eq!(body, b"cdef");

    let (status, headers, body) = get(&state, Some("bytes=20-")).await;
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(headers[header::CONTENT_RANGE], "bytes 20-25/26");
    assert_eq!(body, b"uvwxyz");

    let (status, _, body) = get(&state, Some("bytes=-3")).await;
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(body, b"xyz");

    let (status, _, body) = get(&state, Some("bytes=24-900")).await;
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(body, b"yz");

    let (status, headers, _) = get(&state, Some("bytes=26-30")).await;
    assert_eq!(status, StatusCode::RANGE_NOT_SATISFIABLE);
    assert_eq!(headers[header::CONTENT_RANGE], "bytes */26");

    // The desktop app reads from another origin, where a browser first asks
    // whether it may send Range and afterwards whether it may read the answer.
    let preflight = build_app_router(state.clone())
        .oneshot(
            Request::builder()
                .method("OPTIONS")
                .uri("/uploads/letters.bin")
                .header(header::ORIGIN, "http://localhost:1420")
                .header(header::ACCESS_CONTROL_REQUEST_METHOD, "GET")
                .header(header::ACCESS_CONTROL_REQUEST_HEADERS, "range")
                .extension(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 3001))))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let allowed = preflight.headers()[header::ACCESS_CONTROL_ALLOW_HEADERS]
        .to_str()
        .unwrap()
        .to_ascii_lowercase();
    assert!(allowed.contains("range"), "preflight allowed: {allowed}");
}
