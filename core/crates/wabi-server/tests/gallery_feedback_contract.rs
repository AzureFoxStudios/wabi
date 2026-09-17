//! GF06: gallery feedback on album-derived items vs real gallery works.
//!
//! The gallery list shows media-album items with derived ids
//! `album-{albumId}-item-{itemId}`, while the feedback routes historically
//! required an existing GalleryWork by that id (always 404 for album items).
//! These tests pin the safe resolution: an album-derived id must resolve
//! against the actual album ownership/channel without weakening channel
//! authorization and without manufacturing GalleryWork records on view.
//! Real gallery-work feedback keeps working. Uses the existing local
//! contract-test conventions (real router + real WabiDB, no live data).
use std::{path::Path, sync::Arc};

use axum::{
    body::{to_bytes, Body},
    http::{Method, Request, StatusCode},
    Router,
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
};

async fn server(path: &Path) -> Arc<AppState> {
    Arc::new(
        AppState::new(ServerConfig {
            host: "127.0.0.1".into(),
            port: 0,
            data_dir: path.to_string_lossy().into_owned(),
            uploads_dir: path.join("uploads").to_string_lossy().into_owned(),
            jwt_secret: "gallery-feedback-test-only".into(),
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

fn jwt(state: &AppState, uid: u64) -> String {
    let now = chrono::Utc::now().timestamp();
    jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &JwtClaims {
            sub: uid.to_string(),
            username: format!("user-{uid}"),
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

async fn request(
    app: &Router,
    method: Method,
    path: &str,
    token: &str,
    body: Value,
) -> (StatusCode, Value) {
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if !token.is_empty() {
        req = req.header("authorization", format!("Bearer {token}"));
    }
    let res = app
        .clone()
        .oneshot(req.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let bytes = to_bytes(res.into_body(), 1024 * 1024).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or_else(|_| json!(String::from_utf8_lossy(&bytes))),
    )
}

async fn users(state: &AppState) -> (u64, u64) {
    let mut ids = Vec::new();
    for name in ["member", "outsider"] {
        ids.push(
            state
                .wdb
                .create_user(name, None, "registered-test-hash")
                .await
                .unwrap(),
        );
    }
    (ids[0], ids[1])
}

async fn gallery_channel(state: &AppState, member: u64) -> String {
    let id = state
        .wdb
        .create_channel("gallery", ChannelKind::Gallery, member, false)
        .await
        .unwrap();
    state
        .wdb
        .add_channel_member(&id, member, MemberRole::Member)
        .await
        .unwrap();
    id
}

async fn album_item(state: &AppState, channel: &str, member: u64) -> (String, String, String) {
    let album = state
        .wdb
        .create_album("channel", channel, "Gallery", member)
        .await
        .unwrap();
    let item = state
        .wdb
        .add_item(&album, "/uploads/pic.png", "pic.png", None, member)
        .await
        .unwrap();
    let derived = format!("album-{album}-item-{item}");
    (album, item, derived)
}

fn feedback_payload(comment: &str) -> Value {
    json!({"comment": comment, "xPercent": 12.5, "yPercent": 40.0})
}

#[tokio::test]
async fn album_item_feedback_round_trip_for_channel_member() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (member, _) = users(&state).await;
    let channel = gallery_channel(&state, member).await;
    let (_album, _item, derived) = album_item(&state, &channel, member).await;
    let app = create_api_router(state.clone()).with_state(state.clone());
    let token = jwt(&state, member);
    let path = format!("/gallery/{channel}/works/{derived}/feedback");

    let (status, body) = request(&app, Method::GET, &path, &token, json!(null)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["feedback"].as_array().unwrap().len(), 0);

    let (status, body) = request(&app, Method::POST, &path, &token, feedback_payload("Nice light")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let feedback_id = body["feedbackId"].as_str().unwrap().to_string();
    assert!(!feedback_id.is_empty());

    let (status, body) = request(&app, Method::GET, &path, &token, json!(null)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let items = body["feedback"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["comment"], "Nice light");

    // Resolving an album item must not manufacture a GalleryWork on view.
    assert!(state.wdb.list_gallery_works(&channel).await.unwrap().is_empty());

    let (status, body) = request(
        &app,
        Method::DELETE,
        &format!("{path}/{feedback_id}"),
        &token,
        json!(null),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = request(&app, Method::GET, &path, &token, json!(null)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["feedback"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn real_gallery_work_feedback_still_supported() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (member, _) = users(&state).await;
    let channel = gallery_channel(&state, member).await;
    let work = state
        .wdb
        .upload_gallery_work(
            &channel,
            "Sunset",
            "canary",
            "/uploads/sunset.png",
            "image/png",
            "",
            false,
            member,
        )
        .await
        .unwrap();
    let app = create_api_router(state.clone()).with_state(state.clone());
    let token = jwt(&state, member);
    let path = format!("/gallery/{channel}/works/{work}/feedback");
    let (status, body) = request(&app, Method::POST, &path, &token, feedback_payload("Great")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = request(&app, Method::GET, &path, &token, json!(null)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["feedback"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn feedback_denied_without_membership_and_leaves_no_residue() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (member, outsider) = users(&state).await;
    let channel = gallery_channel(&state, member).await;
    let (_album, _item, derived) = album_item(&state, &channel, member).await;
    let app = create_api_router(state.clone()).with_state(state.clone());
    let path = format!("/gallery/{channel}/works/{derived}/feedback");
    let stranger = jwt(&state, outsider);

    for (method, target, payload) in [
        (Method::GET, path.clone(), json!(null)),
        (Method::POST, path.clone(), feedback_payload("stolen")),
        (Method::DELETE, format!("{path}/feedback_missing"), json!(null)),
    ] {
        let (status, body) = request(&app, method.clone(), &target, &stranger, payload.clone()).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{target}: {body}");
        let (status, _) = request(&app, method, &target, "", payload).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{target}");
    }
    assert!(state.wdb.list_gallery_feedback(&channel, &derived).await.unwrap().is_empty());

    // A removed member loses feedback access too.
    state.wdb.remove_channel_member(&channel, member).await.unwrap();
    let (status, body) = request(&app, Method::GET, &path, &jwt(&state, member), json!(null)).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
}

#[tokio::test]
async fn feedback_missing_or_foreign_resources_are_not_found() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (member, _) = users(&state).await;
    let channel = gallery_channel(&state, member).await;
    let other = gallery_channel(&state, member).await;
    let (album, item, derived) = album_item(&state, &channel, member).await;
    let (_foreign_album, _foreign_item, foreign_derived) = album_item(&state, &other, member).await;
    let app = create_api_router(state.clone()).with_state(state.clone());
    let token = jwt(&state, member);

    // An album id from another channel cannot alias into this channel's path.
    for target in [
        format!("/gallery/{channel}/works/work_missing/feedback"),
        format!("/gallery/{channel}/works/album-alb_missing-item-item_missing/feedback"),
        format!("/gallery/{channel}/works/album-{album}-item-item_missing/feedback"),
        format!("/gallery/{channel}/works/{foreign_derived}/feedback"),
        format!("/gallery/{channel}/works/album--item-/feedback"),
        format!("/gallery/{channel}/works/album-{album}-item-/feedback"),
    ] {
        let (status, body) = request(&app, Method::GET, &target, &token, json!(null)).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{target}: {body}");
        let (status, body) =
            request(&app, Method::POST, &target, &token, feedback_payload("ghost")).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{target}: {body}");
        let (status, body) = request(
            &app,
            Method::DELETE,
            &format!("{target}/feedback_missing"),
            &token,
            json!(null),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{target}: {body}");
    }

    // A deleted album item closes its feedback surface.
    state.wdb.delete_item(&album, &item, member).await.unwrap();
    let target = format!("/gallery/{channel}/works/{derived}/feedback");
    let (status, body) = request(&app, Method::GET, &target, &token, json!(null)).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    let (status, body) = request(&app, Method::POST, &target, &token, feedback_payload("ghost")).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert!(state.wdb.list_gallery_feedback(&channel, &derived).await.unwrap().is_empty());
}
