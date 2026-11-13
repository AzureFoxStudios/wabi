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

fn multipart(field: &str, file_name: &str, mime: &str, bytes: &[u8]) -> (String, Vec<u8>) {
    let boundary = format!("wabi-playlist-{}", uuid::Uuid::new_v4().simple());
    let mut body = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"; filename=\"{file_name}\"\r\nContent-Type: {mime}\r\n\r\n"
    )
    .into_bytes();
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={boundary}"), body)
}

async fn raw_post(app: &Router, path: &str, bearer: &str, content_type: &str, body: Vec<u8>) -> (StatusCode, String) {
    let response = app
        .clone()
        .oneshot(
            Request::post(path)
                .header("authorization", format!("Bearer {bearer}"))
                .header("content-type", content_type)
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

fn files_containing(root: &Path, needle: &[u8]) -> Vec<std::path::PathBuf> {
    let mut hits = vec![];
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if std::fs::read(&path).is_ok_and(|b| b.windows(needle.len()).any(|w| w == needle)) {
                hits.push(path);
            }
        }
    }
    hits
}

/// An HLS playlist makes a browser that plays HLS fetch segments from the
/// hosts it names, even when served as `video/mp4` with `nosniff`. No upload
/// path publishes one, whatever name and type it claims; the refusal is a
/// 4xx that says why. Paths that already accept only sniffed image/video
/// bytes refuse it for that reason first.
#[tokio::test]
async fn hls_playlists_are_refused_on_every_upload_path() {
    let temp = tempfile::tempdir().unwrap();
    let mut cfg = config(temp.path());
    let state = Arc::new(AppState::new(cfg.clone()).await.unwrap());
    let admin = state.wdb.create_user("playlist-admin", None, "registered-hash").await.unwrap();
    drop(state);
    cfg.admin_user_ids = vec![admin as i64];
    let state = loop {
        match AppState::new(cfg.clone()).await {
            Ok(state) => break Arc::new(state),
            Err(_) => tokio::time::sleep(std::time::Duration::from_millis(20)).await,
        }
    };
    let bearer = token(admin, &state.config.jwt_secret);
    let channel = state
        .wdb
        .create_channel("playlist", wabidb::domain::ChannelKind::Text, admin, false)
        .await
        .unwrap();
    let app = create_api_router(state.clone()).with_state(state.clone());
    // Padding of any length does not get past the check (a 4 KiB window did).
    let padded = |n: usize, pad: u8| {
        let mut v = vec![pad; n];
        v.extend_from_slice(b"#EXTM3U\nhttps://media.example.invalid/seg0.ts\n");
        v
    };
    let playlists: Vec<Vec<u8>> = vec![
        b"#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nhttps://media.example.invalid/seg0.ts\n".to_vec(),
        b"\xEF\xBB\xBF \r\n\t#EXTM3U\nhttps://media.example.invalid/seg0.ts\n".to_vec(),
        b"#extm3u\nhttps://media.example.invalid/seg0.ts\n".to_vec(),
        padded(4093, b' '),
        padded(5000, b'\n'),
    ];
    let mut outcomes = vec![];
    for (i, bytes) in playlists.iter().enumerate() {
        let bytes = bytes.as_slice();
        let (status, init) = json_call(
            &app,
            "/upload/resumable/init",
            &bearer,
            json!({"fileName":"clip.mp4","fileSize":bytes.len(),"mimeType":"video/mp4","channelId":channel}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{init}");
        let (id, upload_token) = (init["uploadId"].as_str().unwrap(), init["uploadToken"].as_str().unwrap());
        let chunk = app
            .clone()
            .oneshot(
                Request::put(format!("/upload/resumable/chunk?uploadId={id}&offset=0"))
                    .header("x-upload-token", upload_token)
                    .body(Body::from(bytes.to_vec()))
                    .unwrap(),
            )
            .await
            .unwrap()
            .status();
        assert_eq!(chunk, StatusCode::OK);
        let (status, body) =
            json_call(&app, "/upload/resumable/complete", &bearer, json!({"uploadId":id,"uploadToken":upload_token})).await;
        outcomes.push((format!("resumable #{i}"), status, body.to_string(), true));

        let (status, body) = raw_post(
            &app,
            "/blobs/upload?original_name=clip.mp4&mime_type=video%2Fmp4",
            &bearer,
            "application/octet-stream",
            bytes.to_vec(),
        )
        .await;
        outcomes.push((format!("blob #{i}"), status, body, true));
        for (path, field, name, mime, reason) in [
            ("/upload".to_string(), "file", "clip.mp4", "video/mp4", true),
            ("/upload-profile-picture".to_string(), "profilePicture", "me.png", "image/png", true),
            (format!("/whiteboard/boards/{channel}/images"), "file", "sketch.png", "image/png", true),
            (format!("/whiteboard/boards/{channel}/fonts"), "file", "font.woff2", "font/woff2", true),
            ("/upload-profile-media".to_string(), "file", "banner.mp4", "video/mp4", true),
            ("/upload-background-image".to_string(), "backgroundImage", "loop.mp4", "video/mp4", true),
            ("/emoji/upload".to_string(), "file", "wave.png", "image/png", true),
        ] {
            let (content_type, mut body) = multipart(field, name, mime, bytes);
            if path == "/emoji/upload" {
                // The emoji path validates its shortcode before the bytes.
                let boundary = content_type.rsplit('=').next().unwrap().to_string();
                let mut with_name = format!(
                    "--{boundary}\r\nContent-Disposition: form-data; name=\"name\"\r\n\r\nwave{i}\r\n"
                )
                .into_bytes();
                with_name.extend_from_slice(&body);
                body = with_name;
            }
            let (status, body) = raw_post(&app, &path, &bearer, &content_type, body).await;
            outcomes.push((format!("{path} #{i}"), status, body, reason));
        }
    }
    for (path, status, body, names_playlist) in &outcomes {
        assert!(status.is_client_error(), "{path} accepted a playlist: {status} {body}");
        if *names_playlist {
            assert!(body.contains("#EXTM3U"), "{path} refused for another reason: {status} {body}");
        }
    }
    let hits = files_containing(temp.path(), b"seg0.ts");
    let published: Vec<_> = hits.iter().filter(|p| !p.to_string_lossy().contains("/.tmp/")).collect();
    assert!(published.is_empty(), "playlist bytes published at {published:?}");

    // A note that starts with a longer tag is not a playlist.
    let (content_type, body) = multipart("file", "notes.txt", "text/plain", b"#EXTM3U8 notes");
    let (status, body) = raw_post(&app, "/upload", &bearer, &content_type, body).await;
    assert!(status.is_success(), "{status} {body}");

    // Positive control: ordinary bytes under the same name still upload.
    let (content_type, body) = multipart("file", "clip.mp4", "video/mp4", b"\x00\x00\x00\x18ftypmp42 not a playlist");
    let (status, body) = raw_post(&app, "/upload", &bearer, &content_type, body).await;
    assert!(status.is_success(), "{status} {body}");
}
