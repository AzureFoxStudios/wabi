//! Authored content must retain its owner across REST mutations and revocation.
use std::{path::Path, sync::Arc};

use axum::{
    body::{to_bytes, Body, Bytes},
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
            jwt_secret: "resource-ownership-test-only".into(),
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
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = res.status();
    let bytes = to_bytes(res.into_body(), 1024 * 1024).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

async fn users(state: &AppState) -> (u64, u64, u64) {
    let mut ids = Vec::new();
    for name in ["author", "other member", "staff"] {
        ids.push(
            state
                .wdb
                .create_user(name, None, "registered-test-hash")
                .await
                .unwrap(),
        );
    }
    (ids[0], ids[1], ids[2])
}

async fn channel(state: &AppState, members: &[u64], kind: ChannelKind) -> String {
    let id = state
        .wdb
        .create_channel("ownership canary", kind, members[0], false)
        .await
        .unwrap();
    for &member in members {
        state
            .wdb
            .add_channel_member(&id, member, MemberRole::Member)
            .await
            .unwrap();
    }
    id
}

async fn role(state: &AppState, uid: u64, name: &str) {
    state
        .wdb
        .ingest_event(
            "rbac",
            "assign_role",
            &json!({
                "userId": uid, "workspaceId": "default-workspace", "role": name, "assignedBy": uid,
            }),
        )
        .await
        .unwrap();
}

fn forum_edit(body: &str) -> Value {
    json!({"body": body, "title": "original title", "tags": [], "category": "General"})
}

fn work_edit(title: &str) -> Value {
    json!({"title": title, "caption": "caption", "category": "General", "isWip": false})
}

#[tokio::test]
async fn another_channel_member_cannot_rewrite_or_destroy_authored_content() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (author, other, _) = users(&state).await;
    let ch = channel(&state, &[author, other], ChannelKind::Forum).await;
    let thread = state
        .wdb
        .create_forum_thread(
            &ch,
            "original body",
            author,
            Some("original title"),
            None,
            Some("General"),
        )
        .await
        .unwrap();
    let work = state
        .wdb
        .upload_gallery_work(
            &ch,
            "original work",
            "caption",
            "/uploads/example.png",
            "image/png",
            "General",
            false,
            author,
        )
        .await
        .unwrap();
    let feedback = state
        .wdb
        .add_gallery_feedback(&ch, &work, "original feedback", 10.0, 20.0, author)
        .await
        .unwrap();
    let app = create_api_router(state.clone()).with_state(state.clone());
    let token = jwt(&state, other);
    let seq = state.wdb.engine().projection_state().applied_commit_seq();
    for (method, path, body) in [
        (
            Method::PUT,
            format!("/forum/{ch}/threads/{thread}/posts/{thread}"),
            forum_edit("forged victim body"),
        ),
        (
            Method::DELETE,
            format!("/forum/{ch}/threads/{thread}/posts/{thread}"),
            Value::Null,
        ),
        (
            Method::PUT,
            format!("/gallery/{ch}/works/{work}"),
            work_edit("forged work"),
        ),
        (
            Method::DELETE,
            format!("/gallery/{ch}/works/{work}"),
            Value::Null,
        ),
        (
            Method::DELETE,
            format!("/gallery/{ch}/works/{work}/feedback/{feedback}"),
            Value::Null,
        ),
    ] {
        assert_eq!(
            request(&app, method, &path, &token, body).await.0,
            StatusCode::FORBIDDEN,
            "{path}"
        );
    }
    assert_eq!(
        state.wdb.engine().projection_state().applied_commit_seq(),
        seq
    );
    let post = state
        .wdb
        .get_forum_post(&ch, &thread, &thread)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(post.body, "original body");
    assert!(!post.is_deleted);
    let gallery = state
        .wdb
        .get_gallery_work(&ch, &work)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(gallery.title, "original work");
    assert!(!gallery.is_deleted);
    assert_eq!(
        state
            .wdb
            .list_gallery_feedback(&ch, &work)
            .await
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn author_and_current_moderator_can_mutate_but_removed_role_cannot() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (author, other, staff) = users(&state).await;
    let ch = channel(&state, &[author, other, staff], ChannelKind::Forum).await;
    let thread = state
        .wdb
        .create_forum_thread(
            &ch,
            "original body",
            author,
            Some("original title"),
            None,
            Some("General"),
        )
        .await
        .unwrap();
    let work = state
        .wdb
        .upload_gallery_work(
            &ch,
            "original work",
            "caption",
            "/uploads/example.png",
            "image/png",
            "General",
            false,
            author,
        )
        .await
        .unwrap();
    let feedback = state
        .wdb
        .add_gallery_feedback(&ch, &work, "original feedback", 10.0, 20.0, author)
        .await
        .unwrap();
    let app = create_api_router(state.clone()).with_state(state.clone());
    let path = format!("/forum/{ch}/threads/{thread}/posts/{thread}");
    assert_eq!(
        request(
            &app,
            Method::PUT,
            &path,
            &jwt(&state, author),
            forum_edit("author edit")
        )
        .await
        .0,
        StatusCode::OK
    );
    // Category organization remains collaborative, without author impersonation.
    let mut metadata = forum_edit("author edit");
    metadata["category"] = json!("Collaborative category");
    assert_eq!(
        request(&app, Method::PUT, &path, &jwt(&state, other), metadata)
            .await
            .0,
        StatusCode::OK
    );
    role(&state, staff, "Moderator").await;
    let token = jwt(&state, staff);
    assert_eq!(
        request(
            &app,
            Method::PUT,
            &path,
            &token,
            forum_edit("moderator edit")
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        request(
            &app,
            Method::PUT,
            &format!("/gallery/{ch}/works/{work}"),
            &token,
            work_edit("moderator work edit")
        )
        .await
        .0,
        StatusCode::OK
    );
    role(&state, staff, "Artist").await;
    assert_eq!(
        request(&app, Method::DELETE, &path, &token, Value::Null)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(
            &app,
            Method::DELETE,
            &format!("/gallery/{ch}/works/{work}"),
            &token,
            Value::Null
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(
            &app,
            Method::DELETE,
            &format!("/gallery/{ch}/works/{work}/feedback/{feedback}"),
            &jwt(&state, author),
            Value::Null
        )
        .await
        .0,
        StatusCode::OK
    );
    role(&state, staff, "Moderator").await;
    assert_eq!(
        request(&app, Method::DELETE, &path, &token, Value::Null)
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        request(
            &app,
            Method::DELETE,
            &format!("/gallery/{ch}/works/{work}"),
            &jwt(&state, author),
            Value::Null
        )
        .await
        .0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn private_conversation_staff_members_cannot_moderate_other_authors() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (author, member, staff) = users(&state).await;
    let ch = channel(&state, &[author, member], ChannelKind::GroupDm).await;
    let thread = state
        .wdb
        .create_forum_thread(
            &ch,
            "private body",
            author,
            Some("original title"),
            None,
            Some("General"),
        )
        .await
        .unwrap();
    role(&state, staff, "Admin").await;
    let app = create_api_router(state.clone()).with_state(state.clone());
    let path = format!("/forum/{ch}/threads/{thread}/posts/{thread}");
    assert_eq!(
        request(
            &app,
            Method::DELETE,
            &path,
            &jwt(&state, staff),
            Value::Null
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    state
        .wdb
        .add_channel_member(&ch, staff, MemberRole::Member)
        .await
        .unwrap();
    assert_eq!(
        request(
            &app,
            Method::DELETE,
            &path,
            &jwt(&state, staff),
            Value::Null
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert!(
        !state
            .wdb
            .get_forum_post(&ch, &thread, &thread)
            .await
            .unwrap()
            .unwrap()
            .is_deleted
    );
}

#[tokio::test]
async fn nonexistent_solution_target_cannot_clear_the_existing_solution() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (author, member, _) = users(&state).await;
    let ch = channel(&state, &[author, member], ChannelKind::Forum).await;
    let thread = state
        .wdb
        .create_forum_thread(&ch, "question", author, Some("original title"), None, None)
        .await
        .unwrap();
    let reply = state
        .wdb
        .create_forum_post(&ch, &thread, "answer", member, None)
        .await
        .unwrap();
    state
        .wdb
        .mark_forum_solution(&ch, &thread, &reply, author)
        .await
        .unwrap();
    let seq = state.wdb.engine().projection_state().applied_commit_seq();
    let app = create_api_router(state.clone()).with_state(state.clone());
    assert_eq!(
        request(
            &app,
            Method::POST,
            &format!("/forum/{ch}/threads/{thread}/posts/missing/solution"),
            &jwt(&state, member),
            Value::Null
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        state.wdb.engine().projection_state().applied_commit_seq(),
        seq
    );
    assert!(
        state
            .wdb
            .get_forum_post(&ch, &thread, &reply)
            .await
            .unwrap()
            .unwrap()
            .is_solution
    );
}

#[tokio::test]
async fn foreign_nested_ids_cannot_alias_into_a_permitted_channel() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (author, other, _) = users(&state).await;
    let allowed = channel(&state, &[other], ChannelKind::Forum).await;
    let hidden = channel(&state, &[author], ChannelKind::Forum).await;
    let thread = state
        .wdb
        .create_forum_thread(
            &hidden,
            "secret",
            author,
            Some("original title"),
            None,
            None,
        )
        .await
        .unwrap();
    let work = state
        .wdb
        .upload_gallery_work(
            &hidden,
            "secret",
            "caption",
            "/uploads/example.png",
            "image/png",
            "General",
            false,
            author,
        )
        .await
        .unwrap();
    let app = create_api_router(state.clone()).with_state(state.clone());
    let before = state.wdb.engine().projection_state().applied_commit_seq();
    for (method, path, body) in [
        (
            Method::PUT,
            format!("/forum/{allowed}/threads/{thread}/posts/{thread}"),
            forum_edit("alias"),
        ),
        (
            Method::POST,
            format!("/forum/{allowed}/threads/{thread}/posts/{thread}/solution"),
            Value::Null,
        ),
        (
            Method::PUT,
            format!("/gallery/{allowed}/works/{work}"),
            work_edit("alias"),
        ),
        (
            Method::DELETE,
            format!("/gallery/{allowed}/works/{work}"),
            Value::Null,
        ),
    ] {
        assert_eq!(
            request(&app, method, &path, &jwt(&state, other), body)
                .await
                .0,
            StatusCode::NOT_FOUND,
            "{path}"
        );
    }
    assert_eq!(
        state.wdb.engine().projection_state().applied_commit_seq(),
        before
    );
    assert!(state
        .wdb
        .get_forum_post(&allowed, &thread, &thread)
        .await
        .unwrap()
        .is_none());
    assert!(state
        .wdb
        .get_gallery_work(&allowed, &work)
        .await
        .unwrap()
        .is_none());
}

/// The first poll is a deterministic checkpoint: channel middleware admitted
/// the request and the handler is now awaiting the attacker's unfinished body.
async fn removed_while_reading_body(
    state: Arc<AppState>,
    app: Router,
    uid: u64,
    ch: String,
    method: Method,
    path: String,
    body: Value,
) -> StatusCode {
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (body_tx, body_rx) = tokio::sync::oneshot::channel::<Value>();
    let stream = futures::stream::once(async move {
        let _ = started_tx.send(());
        Ok::<Bytes, std::io::Error>(Bytes::from(body_rx.await.unwrap().to_string()))
    });
    let req = Request::builder()
        .method(method)
        .uri(&path)
        .header("authorization", format!("Bearer {}", jwt(&state, uid)))
        .header("content-type", "application/json")
        .body(Body::from_stream(stream))
        .unwrap();
    let task = tokio::spawn(async move { app.oneshot(req).await.unwrap().status() });
    let checkpoint = tokio::time::timeout(std::time::Duration::from_secs(2), started_rx)
        .await
        .unwrap_or_else(|_| panic!("{path} did not poll the request body"));
    if checkpoint.is_err() {
        let status = task.await.unwrap();
        panic!("{path} returned {status} without reading the request body");
    }
    {
        let _gate = state.membership_gate.write().await;
        state.wdb.remove_channel_member(&ch, uid).await.unwrap();
    }
    body_tx.send(body).unwrap();
    task.await.unwrap()
}

#[tokio::test]
async fn removal_during_streamed_body_denies_all_workspace_mutations() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (author, member, _) = users(&state).await;
    let ch = channel(&state, &[author, member], ChannelKind::Forum).await;
    let album = state
        .wdb
        .create_album("channel", &ch, "album", author)
        .await
        .unwrap();
    let app = create_api_router(state.clone()).with_state(state.clone());
    for (method, path, body) in [
        (
            Method::POST,
            "/messages".into(),
            json!({"channel_id":ch, "content":"post removal canary"}),
        ),
        (
            Method::POST,
            format!("/forum/{ch}/threads"),
            json!({"body":"post removal canary", "title":"canary"}),
        ),
        (
            Method::POST,
            format!("/gallery/{ch}/works"),
            json!({"title":"canary", "caption":"post removal canary", "attachmentUrl":"/uploads/test.png", "mimeType":"image/png", "category":"General", "isWip":false}),
        ),
        (
            Method::POST,
            format!("/incidents/{ch}"),
            json!({"title":"canary", "description":"post removal canary", "severity":"low"}),
        ),
        (
            Method::POST,
            "/albums".into(),
            json!({"scopeType":"channel", "scopeId":ch, "name":"canary"}),
        ),
        (
            Method::POST,
            format!("/albums/{album}/items"),
            json!({"attachmentUrl":"/uploads/test.png", "attachmentName":"canary"}),
        ),
        (
            Method::PUT,
            format!("/whiteboard/boards/channel%3A{ch}/document"),
            json!({"version":0, "elements":[]}),
        ),
    ] {
        state
            .wdb
            .add_channel_member(&ch, member, MemberRole::Member)
            .await
            .unwrap();
        assert_eq!(
            removed_while_reading_body(
                state.clone(),
                app.clone(),
                member,
                ch.clone(),
                method,
                path.clone(),
                body
            )
            .await,
            StatusCode::FORBIDDEN,
            "{path}"
        );
    }
    assert!(state.wdb.list_forum_threads(&ch).await.unwrap().is_empty());
    assert!(state
        .wdb
        .list_messages_typed(&ch, 100)
        .await
        .unwrap()
        .is_empty());
    assert!(state.wdb.list_gallery_works(&ch).await.unwrap().is_empty());
    assert!(state.wdb.list_incidents(&ch).await.unwrap().is_empty());
    assert_eq!(
        state.wdb.list_albums("channel", &ch).await.unwrap().len(),
        1
    );
    assert!(state.wdb.list_items(&album).await.unwrap().is_empty());
    assert!(state
        .wdb
        .get_whiteboard_doc(&format!("channel:{ch}"))
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn revoked_credential_during_body_cannot_publish_even_while_member() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (author, member, _) = users(&state).await;
    let ch = channel(&state, &[author, member], ChannelKind::Forum).await;
    let album = state
        .wdb
        .create_album("channel", &ch, "album", author)
        .await
        .unwrap();
    let app = create_api_router(state.clone()).with_state(state.clone());
    for (method, path, body) in [
        (
            Method::POST,
            "/messages".into(),
            json!({"channel_id":ch,"content":"revoked canary"}),
        ),
        (
            Method::POST,
            format!("/forum/{ch}/threads"),
            json!({"body":"revoked canary","title":"canary"}),
        ),
        (
            Method::POST,
            format!("/gallery/{ch}/works"),
            json!({"title":"canary","caption":"revoked canary","attachmentUrl":"/uploads/test.png","mimeType":"image/png","category":"General","isWip":false}),
        ),
        (
            Method::POST,
            format!("/incidents/{ch}"),
            json!({"title":"canary","description":"revoked canary","severity":"low"}),
        ),
        (
            Method::POST,
            "/albums".into(),
            json!({"scopeType":"channel","scopeId":ch,"name":"canary"}),
        ),
        (
            Method::POST,
            format!("/albums/{album}/items"),
            json!({"attachmentUrl":"/uploads/test.png","attachmentName":"canary"}),
        ),
        (
            Method::PUT,
            format!("/whiteboard/boards/channel%3A{ch}/document"),
            json!({"version":0,"elements":[]}),
        ),
        (
            Method::POST,
            "/e2ee/devices".into(),
            json!({"deviceId":"revoked-device","encryptionPublicKey":"A".repeat(44),"signingPublicKey":"B".repeat(44)}),
        ),
        (
            Method::POST,
            "/following/poll".into(),
            json!({"channels":[{"channelId":ch}]}),
        ),
    ] {
        let token = jwt(&state, member);
        let claims = wabi_server::auth_extractor::decode_token(&token, &state.config.jwt_secret)
            .await
            .unwrap();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (body_tx, body_rx) = tokio::sync::oneshot::channel::<Value>();
        let stream = futures::stream::once(async move {
            let _ = started_tx.send(());
            Ok::<Bytes, std::io::Error>(Bytes::from(body_rx.await.unwrap().to_string()))
        });
        let req = Request::builder()
            .method(method)
            .uri(&path)
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .body(Body::from_stream(stream))
            .unwrap();
        let request_app = app.clone();
        let task = tokio::spawn(async move { request_app.oneshot(req).await.unwrap().status() });
        let checkpoint = tokio::time::timeout(std::time::Duration::from_secs(2), started_rx)
            .await
            .unwrap_or_else(|_| panic!("{path} did not poll the request body"));
        if checkpoint.is_err() {
            let status = task.await.unwrap();
            panic!("{path} returned {status} without reading the request body");
        }
        // The request has passed both authentication and any channel middleware.
        // Revocation must remain possible while its body is unfinished.
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            state.revoke_token_with_exp(claims.jti, claims.exp),
        )
        .await
        .unwrap()
        .unwrap();
        // Credential denial is itself a durable event. Only the subsequently
        // released unauthorized body must leave the sequencer unchanged.
        let sequence = state.wdb.engine().projection_state().applied_commit_seq();
        body_tx.send(body).unwrap();
        assert_eq!(task.await.unwrap(), StatusCode::UNAUTHORIZED, "{path}");
        assert_eq!(
            state.wdb.engine().projection_state().applied_commit_seq(),
            sequence,
            "{path} persisted content after credential denial",
        );
        assert!(
            wabi_server::channel_access::is_member(&state, member as i64, &ch)
                .await
                .unwrap()
        );
    }
    assert!(state.wdb.list_forum_threads(&ch).await.unwrap().is_empty());
    assert!(state
        .wdb
        .list_messages_typed(&ch, 100)
        .await
        .unwrap()
        .is_empty());
    assert!(state.wdb.list_gallery_works(&ch).await.unwrap().is_empty());
    assert!(state.wdb.list_incidents(&ch).await.unwrap().is_empty());
    assert_eq!(
        state.wdb.list_albums("channel", &ch).await.unwrap().len(),
        1
    );
    assert!(state.wdb.list_items(&album).await.unwrap().is_empty());
    assert!(state
        .wdb
        .get_whiteboard_doc(&format!("channel:{ch}"))
        .await
        .unwrap()
        .is_none());
    assert!(!dir.path().join("e2ee_state.json").exists());
}

#[tokio::test]
async fn removed_member_waiting_for_encryption_policy_cannot_select_plaintext() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (author, member, _) = users(&state).await;
    let ch = channel(&state, &[author, member], ChannelKind::GroupDm).await;
    // Seed the documented JSON policy sidecar; production's initializer is
    // crate-private and must stay out of the public API just for this fixture.
    std::fs::write(
        std::path::Path::new(&state.config.data_dir).join("e2ee_state.json"),
        serde_json::to_vec(&json!({
            "devices": [], "rooms": {},
            "newRoomPolicies": { (ch.clone()): {
                "mode": "pending_encryption", "createdAt": "2026-10-01T00:00:00Z",
                "chosenByUserId": null, "consentingUserIds": []
            }}
        }))
        .unwrap(),
    )
    .unwrap();
    let app = create_api_router(state.clone()).with_state(state.clone());
    let membership = state.membership_gate.write().await;
    let policy = state.retention_policy_lock.lock().await;
    let req = Request::post(format!("/e2ee/channels/{ch}/allow-server-readable"))
        .header("authorization", format!("Bearer {}", jwt(&state, member)))
        .body(Body::empty())
        .unwrap();
    let mut response = Box::pin(app.clone().oneshot(req));
    // Legacy admission passes membership and parks on the policy mutex. The
    // fixed route instead parks on membership before observing mutable state.
    assert!(futures::poll!(response.as_mut()).is_pending());
    state.wdb.remove_channel_member(&ch, member).await.unwrap();
    drop(membership);
    drop(policy);
    assert_eq!(response.await.unwrap().status(), StatusCode::FORBIDDEN);
    let (status, value) = request(
        &app,
        Method::GET,
        &format!("/e2ee/channels/{ch}"),
        &jwt(&state, author),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(value["serverReadableSelected"], false);
    assert_eq!(value["pendingDefault"], true);
}

#[tokio::test]
async fn channel_deletion_waits_for_admitted_content_operations() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (author, _, staff) = users(&state).await;
    let ch = channel(&state, &[author], ChannelKind::Forum).await;
    role(&state, staff, "Admin").await;
    let app = create_api_router(state.clone()).with_state(state.clone());
    let admitted = state.membership_gate.read().await;
    let token = jwt(&state, staff);
    let path = format!("/channels/{ch}");
    let mut deletion = tokio::spawn(async move {
        request(&app, Method::DELETE, &path, &token, Value::Null)
            .await
            .0
    });
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(50), &mut deletion)
            .await
            .is_err()
    );
    assert!(state.wdb.get_channel(&ch).await.unwrap().is_some());
    drop(admitted);
    assert_eq!(deletion.await.unwrap(), StatusCode::OK);
    assert!(state.wdb.get_channel(&ch).await.unwrap().is_none());
}

#[tokio::test]
async fn pending_private_content_readers_recheck_after_membership_removal() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (author, member, _) = users(&state).await;
    let ch = channel(&state, &[author, member], ChannelKind::GroupDm).await;
    let album = state
        .wdb
        .create_album("dm", &ch, "private album", author)
        .await
        .unwrap();
    let board = format!("channel:{ch}");
    state
        .wdb
        .put_whiteboard_doc(&board, r#"{"version":1,"canary":"private content"}"#)
        .await
        .unwrap();
    let app = create_api_router(state.clone()).with_state(state.clone());
    let token = jwt(&state, member);
    let cases = vec![
        (Method::GET, format!("/forum/{ch}/threads"), Value::Null),
        (Method::HEAD, format!("/gallery/{ch}/works"), Value::Null),
        (Method::GET, format!("/gallery/{ch}/works"), Value::Null),
        (Method::GET, format!("/incidents/{ch}"), Value::Null),
        (
            Method::GET,
            format!("/albums?scopeType=dm&scopeId={ch}"),
            Value::Null,
        ),
        (Method::GET, format!("/albums/{album}"), Value::Null),
        (Method::GET, format!("/albums/{album}/items"), Value::Null),
        (
            Method::GET,
            format!("/whiteboard/boards/{board}/document"),
            Value::Null,
        ),
        (
            Method::GET,
            format!("/whiteboard/boards/{board}/fonts"),
            Value::Null,
        ),
        (
            Method::POST,
            "/following/poll".into(),
            json!({"channels":[{"channelId":ch}]}),
        ),
    ];
    for (method, path, body) in cases {
        let membership = state.membership_gate.write().await;
        let mut pending = Box::pin(
            app.clone().oneshot(
                Request::builder()
                    .method(method)
                    .uri(&path)
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            ),
        );
        assert!(
            futures::poll!(pending.as_mut()).is_pending(),
            "{path} read content while a membership change owned admission"
        );
        state.wdb.remove_channel_member(&ch, member).await.unwrap();
        drop(membership);
        let response = tokio::time::timeout(std::time::Duration::from_secs(1), pending)
            .await
            .unwrap()
            .unwrap();
        if path == "/following/poll" {
            assert_eq!(response.status(), StatusCode::OK);
            let body = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
            let value: Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(value["channels"], json!([]));
        } else {
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{path}");
        }
        let membership = state.membership_gate.write().await;
        state
            .wdb
            .add_channel_member(&ch, member, MemberRole::Member)
            .await
            .unwrap();
        drop(membership);
    }
    let (status, value) = request(
        &app,
        Method::GET,
        &format!("/whiteboard/boards/{board}/document"),
        &jwt(&state, author),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(value["canary"], "private content");
}

#[tokio::test]
async fn waiting_private_readers_recheck_credentials_without_nested_auth_reads() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (author, member, _) = users(&state).await;
    let ch = channel(&state, &[author, member], ChannelKind::GroupDm).await;
    let board = format!("channel:{ch}");
    state
        .wdb
        .put_whiteboard_doc(&board, r#"{"version":1,"canary":"private content"}"#)
        .await
        .unwrap();
    let app = create_api_router(state.clone()).with_state(state.clone());
    for (method, path, body) in [
        (Method::GET, format!("/forum/{ch}/threads"), Value::Null),
        (Method::HEAD, format!("/gallery/{ch}/works"), Value::Null),
        (Method::GET, format!("/incidents/{ch}"), Value::Null),
        (
            Method::GET,
            format!("/albums?scopeType=dm&scopeId={ch}"),
            Value::Null,
        ),
        (
            Method::GET,
            format!("/whiteboard/boards/{board}/document"),
            Value::Null,
        ),
        (Method::GET, format!("/e2ee/channels/{ch}"), Value::Null),
        (Method::GET, format!("/messages/{ch}"), Value::Null),
        (
            Method::POST,
            "/following/poll".into(),
            json!({"channels":[{"channelId":ch}]}),
        ),
    ] {
        let token = jwt(&state, member);
        let claims = wabi_server::auth_extractor::decode_token(&token, &state.config.jwt_secret)
            .await
            .unwrap();
        let membership = state.membership_gate.write().await;
        let mut pending = Box::pin(
            app.clone().oneshot(
                Request::builder()
                    .method(method)
                    .uri(&path)
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            ),
        );
        assert!(
            futures::poll!(pending.as_mut()).is_pending(),
            "{path} did not wait for membership admission"
        );
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            state.revoke_token_with_exp(claims.jti, claims.exp),
        )
        .await
        .unwrap()
        .unwrap();
        drop(membership);
        let response = tokio::time::timeout(std::time::Duration::from_secs(2), pending)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{path}");
        assert!(
            wabi_server::channel_access::is_member(&state, member as i64, &ch)
                .await
                .unwrap()
        );
    }
    assert_eq!(
        state.wdb.get_whiteboard_doc(&board).await.unwrap().unwrap(),
        r#"{"version":1,"canary":"private content"}"#
    );
}

/// Successful controls keep the adversarial tests honest: every paused route
/// must be a real endpoint admitting the same ordinary authenticated principal.
#[tokio::test]
async fn valid_members_can_use_every_body_and_read_admission_route() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (author, member, _) = users(&state).await;
    let ch = channel(&state, &[author, member], ChannelKind::Forum).await;
    let album = state
        .wdb
        .create_album("channel", &ch, "control album", author)
        .await
        .unwrap();
    let app = create_api_router(state.clone()).with_state(state.clone());
    let token = jwt(&state, member);
    for (method, path, body) in [
        (
            Method::POST,
            "/messages".into(),
            json!({"channel_id":ch,"content":"allowed message"}),
        ),
        (
            Method::POST,
            format!("/forum/{ch}/threads"),
            json!({"body":"allowed thread","title":"control"}),
        ),
        (
            Method::POST,
            format!("/gallery/{ch}/works"),
            json!({"title":"control","caption":"allowed work","attachmentUrl":"/uploads/test.png","mimeType":"image/png","category":"General","isWip":false}),
        ),
        (
            Method::POST,
            format!("/incidents/{ch}"),
            json!({"title":"control","description":"allowed incident","severity":"low"}),
        ),
        (
            Method::POST,
            "/albums".into(),
            json!({"scopeType":"channel","scopeId":ch,"name":"allowed album"}),
        ),
        (
            Method::POST,
            format!("/albums/{album}/items"),
            json!({"attachmentUrl":"/uploads/test.png","attachmentName":"allowed item"}),
        ),
        (
            Method::PUT,
            format!("/whiteboard/boards/channel%3A{ch}/document"),
            json!({"version":0,"elements":[]}),
        ),
        (
            Method::POST,
            "/e2ee/devices".into(),
            json!({"deviceId":"allowed-device","encryptionPublicKey":"A".repeat(44),"signingPublicKey":"B".repeat(44)}),
        ),
        (
            Method::POST,
            "/following/poll".into(),
            json!({"channels":[{"channelId":ch}]}),
        ),
    ] {
        let (status, response) = request(&app, method, &path, &token, body).await;
        assert!(
            status.is_success(),
            "authorized write control {path}: {status} {response}"
        );
    }
    assert_eq!(
        state.wdb.list_messages_typed(&ch, 100).await.unwrap().len(),
        1
    );
    assert_eq!(state.wdb.list_forum_threads(&ch).await.unwrap().len(), 1);
    assert_eq!(state.wdb.list_gallery_works(&ch).await.unwrap().len(), 1);
    assert_eq!(state.wdb.list_incidents(&ch).await.unwrap().len(), 1);
    assert_eq!(
        state.wdb.list_albums("channel", &ch).await.unwrap().len(),
        2
    );
    assert_eq!(state.wdb.list_items(&album).await.unwrap().len(), 1);
    assert!(state
        .wdb
        .get_whiteboard_doc(&format!("channel:{ch}"))
        .await
        .unwrap()
        .is_some());
    let private = channel(&state, &[author, member], ChannelKind::GroupDm).await;
    let board = format!("channel:{private}");
    let private_album = state
        .wdb
        .create_album("dm", &private, "private control", author)
        .await
        .unwrap();
    state
        .wdb
        .put_whiteboard_doc(
            &board,
            r#"{"version":1,"canary":"allowed private content"}"#,
        )
        .await
        .unwrap();
    for (method, path, body) in [
        (
            Method::GET,
            format!("/forum/{private}/threads"),
            Value::Null,
        ),
        (
            Method::HEAD,
            format!("/gallery/{private}/works"),
            Value::Null,
        ),
        (
            Method::GET,
            format!("/gallery/{private}/works"),
            Value::Null,
        ),
        (Method::GET, format!("/incidents/{private}"), Value::Null),
        (
            Method::GET,
            format!("/albums?scopeType=dm&scopeId={private}"),
            Value::Null,
        ),
        (Method::GET, format!("/albums/{private_album}"), Value::Null),
        (
            Method::GET,
            format!("/albums/{private_album}/items"),
            Value::Null,
        ),
        (
            Method::GET,
            format!("/whiteboard/boards/{board}/document"),
            Value::Null,
        ),
        (
            Method::GET,
            format!("/whiteboard/boards/{board}/fonts"),
            Value::Null,
        ),
        (
            Method::GET,
            format!("/e2ee/channels/{private}"),
            Value::Null,
        ),
        (Method::GET, format!("/messages/{private}"), Value::Null),
        (
            Method::POST,
            "/following/poll".into(),
            json!({"channels":[{"channelId":private}]}),
        ),
    ] {
        let (status, response) = request(&app, method, &path, &token, body).await;
        assert_eq!(
            status,
            StatusCode::OK,
            "authorized read control {path}: {response}"
        );
    }
}
