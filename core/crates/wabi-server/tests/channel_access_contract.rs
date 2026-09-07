//! Exercise authorization through the production REST router and real WabiDB.
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
            jwt_secret: "channel-access-test-only".into(),
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

async fn users(state: &AppState) -> (u64, u64, u64) {
    let mut ids = Vec::new();
    for name in ["member", "outsider", "owner"] {
        ids.push(
            state
                .wdb
                .create_user(name, None, "registered-test-hash")
                .await
                .unwrap(),
        );
    }
    state.wdb.claim_owner(ids[2]).await.unwrap();
    *state.owner_user_id.write().await = Some(ids[2] as i64);
    (ids[0], ids[1], ids[2])
}

async fn channel(state: &AppState, member: u64, kind: ChannelKind) -> String {
    let id = state
        .wdb
        .create_channel("private canary", kind, member, false)
        .await
        .unwrap();
    state
        .wdb
        .add_channel_member(&id, member, MemberRole::Member)
        .await
        .unwrap();
    id
}

#[tokio::test]
async fn unsupported_group_avatar_upload_cannot_rewrite_group_or_store_a_file() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (member, outsider, _) = users(&state).await;
    state.wdb.create_group("group-avatar-safe", "keep group metadata", member, &[member, outsider]).await.unwrap();
    let before = state.wdb.get_channel("group-avatar-safe").await.unwrap().unwrap();
    let before_seq = state.wdb.engine().projection_state().applied_commit_seq();
    let app = create_api_router(state.clone()).with_state(state.clone());
    let multipart = "--wabi-test\r\nContent-Disposition: form-data; name=\"channelId\"\r\n\r\ngroup-avatar-safe\r\n--wabi-test\r\nContent-Disposition: form-data; name=\"file\"; filename=\"avatar.png\"\r\nContent-Type: image/png\r\n\r\nnot-a-real-image\r\n--wabi-test--\r\n";
    let response = app.oneshot(Request::post("/upload/group-avatar")
        .header("authorization", format!("Bearer {}", jwt(&state, member)))
        .header("content-type", "multipart/form-data; boundary=wabi-test")
        .body(Body::from(multipart)).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::NOT_IMPLEMENTED);
    assert_eq!(state.wdb.get_channel("group-avatar-safe").await.unwrap().unwrap(), before);
    assert_eq!(state.wdb.engine().projection_state().applied_commit_seq(), before_seq);
    let uploads = std::path::Path::new(&state.config.uploads_dir);
    if uploads.exists() { assert_eq!(std::fs::read_dir(uploads).unwrap().count(), 0); }
}

#[tokio::test]
async fn workspace_reads_require_authentication_and_channel_access() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (member, outsider, owner) = users(&state).await;
    let id = channel(&state, member, ChannelKind::Wiki).await;
    state
        .wdb
        .create_wiki_page(&id, "private canary", "secret body", member, "", "", 0)
        .await
        .unwrap();
    let app = create_api_router(state.clone()).with_state(state.clone());
    for (token, expected) in [
        ("".into(), StatusCode::UNAUTHORIZED),
        (jwt(&state, outsider), StatusCode::FORBIDDEN),
        (jwt(&state, member), StatusCode::OK),
        (jwt(&state, owner), StatusCode::OK),
    ] {
        for path in [
            format!("/messages/{id}"),
            format!("/channels/{id}/reactions"),
            format!("/wiki/{id}/pages"),
            format!("/forum/{id}/threads"),
            format!("/gallery/{id}/works"),
            format!("/incidents/{id}"),
        ] {
            let (status, body) = request(&app, Method::GET, &path, &token, json!(null)).await;
            assert_eq!(status, expected, "{path}: {body}");
        }
    }
}

#[tokio::test]
async fn denied_writes_do_not_reach_projections_or_live_cache() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (member, outsider, _) = users(&state).await;
    let id = channel(&state, member, ChannelKind::Text).await;
    let app = create_api_router(state.clone()).with_state(state.clone());
    let token = jwt(&state, outsider);
    for (path, payload) in [
        (
            "/messages".into(),
            json!({"channel_id":id, "content":"unauthorized"}),
        ),
        (
            format!("/wiki/{id}/pages"),
            json!({"title":"unauthorized", "body":"secret"}),
        ),
        (
            format!("/forum/{id}/threads"),
            json!({"body":"unauthorized"}),
        ),
        (
            format!("/gallery/{id}/works"),
            json!({"title":"unauthorized", "caption":"", "attachmentUrl":"/uploads/canary", "mimeType":"image/png", "category":"", "isWip":false}),
        ),
        (
            format!("/incidents/{id}"),
            json!({"title":"unauthorized", "description":"", "severity":"low"}),
        ),
    ] {
        let (status, body) = request(&app, Method::POST, &path, &token, payload).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{path}: {body}");
    }
    assert!(state
        .wdb
        .list_messages_typed(&id, 100)
        .await
        .unwrap()
        .is_empty());
    assert!(state.wdb.list_wiki_pages(&id).await.unwrap().is_empty());
    assert!(state.wdb.list_forum_threads(&id).await.unwrap().is_empty());
    assert!(state.wdb.list_gallery_works(&id).await.unwrap().is_empty());
    assert!(state.wdb.list_incidents(&id).await.unwrap().is_empty());
    state
        .channel_auto_delete_label
        .write()
        .await
        .insert(id.clone(), "live".into());
    assert_eq!(
        request(
            &app,
            Method::POST,
            "/messages",
            &token,
            json!({"channel_id":id,"content":"live leak"})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert!(!state.session_messages.read().await.contains_key(&id));
}

#[tokio::test]
async fn private_conversations_cannot_be_discovered_or_self_joined_even_by_owner() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (member, outsider, owner) = users(&state).await;
    let public = channel(&state, member, ChannelKind::Text).await;
    // Deliberately not dm-/group- IDs: the persisted kind, not spelling, decides privacy.
    let dm = channel(&state, member, ChannelKind::Dm).await;
    let group = channel(&state, member, ChannelKind::GroupDm).await;
    let app = create_api_router(state.clone()).with_state(state.clone());
    for uid in [outsider, owner] {
        let token = jwt(&state, uid);
        for id in [&dm, &group] {
            for (method, path) in [
                (Method::POST, format!("/channels/{id}/join")),
                (Method::GET, format!("/messages/{id}")),
                (Method::GET, format!("/channels/{id}")),
            ] {
                let (status, body) = request(&app, method, &path, &token, json!(null)).await;
                assert_eq!(status, StatusCode::FORBIDDEN, "{path}: {body}");
            }
            assert!(!state
                .wdb
                .list_channel_members(id)
                .await
                .unwrap()
                .iter()
                .any(|m| m.user_id == uid));
        }
        let (status, body) = request(&app, Method::GET, "/channels", &token, json!(null)).await;
        assert_eq!(status, StatusCode::OK);
        let ids: Vec<_> = body["channels"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["id"].as_str().unwrap())
            .collect();
        assert!(ids.contains(&public.as_str()));
        assert!(
            !ids.contains(&dm.as_str()) && !ids.contains(&group.as_str()),
            "{body}"
        );
    }
    assert_eq!(
        request(&app, Method::GET, "/channels", "", json!(null))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(
            &app,
            Method::POST,
            &format!("/channels/{dm}/join"),
            &jwt(&state, member),
            json!(null)
        )
        .await
        .0,
        StatusCode::OK
    );
    let token = jwt(&state, outsider);
    assert_eq!(
        request(
            &app,
            Method::POST,
            &format!("/channels/{public}/join"),
            &token,
            json!(null)
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        request(
            &app,
            Method::POST,
            "/messages",
            &token,
            json!({"channel_id":public,"content":"joined"})
        )
        .await
        .0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn album_ids_resolve_to_their_persisted_channel_before_access() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (member, outsider, owner) = users(&state).await;
    let dm = channel(&state, member, ChannelKind::Dm).await;
    let album = state
        .wdb
        .create_album("dm", &dm, "private album", member)
        .await
        .unwrap();
    let item = state
        .wdb
        .add_item(
            &album,
            "/uploads/private-canary",
            "private file",
            None,
            member,
        )
        .await
        .unwrap();
    let app = create_api_router(state.clone()).with_state(state.clone());
    for (token, expected) in [
        (String::new(), StatusCode::UNAUTHORIZED),
        (jwt(&state, outsider), StatusCode::FORBIDDEN),
        (jwt(&state, owner), StatusCode::FORBIDDEN),
    ] {
        for (method, path, payload) in [
            (
                Method::GET,
                format!("/albums?scopeType=dm&scopeId={dm}"),
                json!(null),
            ),
            (Method::GET, format!("/albums/{album}"), json!(null)),
            (Method::GET, format!("/albums/{album}/items"), json!(null)),
            (
                Method::POST,
                "/albums".into(),
                json!({"scopeType":"channel", "scopeId":dm, "name":"spoofed scope"}),
            ),
            (
                Method::POST,
                format!("/albums/{album}/items"),
                json!({"attachmentUrl":"/uploads/x","attachmentName":"x"}),
            ),
            (
                Method::PUT,
                format!("/albums/{album}/items/reorder"),
                json!({"itemIds":[item]}),
            ),
            (
                Method::PUT,
                format!("/albums/{album}/featured"),
                json!({"featured":true}),
            ),
            (
                Method::DELETE,
                format!("/albums/{album}/items/{item}"),
                json!(null),
            ),
            (Method::DELETE, format!("/albums/{album}"), json!(null)),
        ] {
            let (status, body) = request(&app, method, &path, &token, payload).await;
            assert_eq!(status, expected, "{path}: {body}");
        }
    }
    assert_eq!(state.wdb.list_items(&album).await.unwrap().len(), 1);
    let token = jwt(&state, member);
    let (status, body) = request(
        &app,
        Method::GET,
        &format!("/albums/{album}/items"),
        &token,
        json!(null),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["album"]["id"], album,
        "list-items must return the album its client expects"
    );
    state.wdb.remove_channel_member(&dm, member).await.unwrap();
    assert_eq!(
        request(
            &app,
            Method::GET,
            &format!("/albums/{album}/items"),
            &token,
            json!(null)
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn socket_policy_denies_removed_or_fabricated_membership_and_group_admin_override() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (member, outsider, owner) = users(&state).await;
    let sio = wabi_server::socketio::SioState {
        app: state.clone(),
        connected_users: Default::default(),
        voice_channels: Default::default(),
        group_call_sessions: Default::default(),
        breakout_rooms: Default::default(),
    };
    let group = channel(&state, member, ChannelKind::GroupDm).await;
    for uid in [outsider, owner] {
        assert!(!wabi_server::socketio::can_access_channel(&sio, uid as i64, &group).await);
    }
    assert!(wabi_server::socketio::can_access_channel(&sio, member as i64, &group).await);
    let dm = format!("dm-user-{member}-user-{outsider}");
    assert!(
        !wabi_server::socketio::can_access_dm(&sio, member as i64, &dm).await,
        "an ID cannot create authority"
    );
    state
        .wdb
        .create_dm_channel(
            &dm,
            "canary",
            Some(&[format!("user-{member}")]),
            member as i64,
        )
        .await
        .unwrap();
    assert!(wabi_server::socketio::can_access_dm(&sio, member as i64, &dm).await);
    state.wdb.remove_channel_member(&dm, member).await.unwrap();
    assert!(
        !wabi_server::socketio::can_access_dm(&sio, member as i64, &dm).await,
        "empty membership must not restore the ID fallback"
    );
    state.wdb.delete_channel(&group, member).await.unwrap();
    assert!(!wabi_server::socketio::can_access_channel(&sio, owner as i64, &group).await);
}

#[tokio::test]
async fn authorized_album_lifecycle_is_truthful_and_cannot_change_a_different_parent() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (member, peer, _) = users(&state).await;
    let channel = channel(&state, member, ChannelKind::Text).await;
    state
        .wdb
        .add_channel_member(&channel, peer, MemberRole::Member)
        .await
        .unwrap();
    let album = state
        .wdb
        .create_album("channel", &channel, "owned", member)
        .await
        .unwrap();
    let other = state
        .wdb
        .create_album("channel", &channel, "other", member)
        .await
        .unwrap();
    let other_item = state
        .wdb
        .add_item(&other, "/uploads/other", "other", None, member)
        .await
        .unwrap();
    let app = create_api_router(state.clone()).with_state(state.clone());
    let token = jwt(&state, member);
    assert_eq!(
        request(
            &app,
            Method::DELETE,
            &format!("/albums/{album}"),
            &jwt(&state, peer),
            json!(null)
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(
            &app,
            Method::DELETE,
            &format!("/albums/{album}/items/{other_item}"),
            &token,
            json!(null)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(state.wdb.list_items(&other).await.unwrap().len(), 1);
    for (path, payload) in [
        (
            format!("/albums/{album}/items/reorder"),
            json!({"itemIds":[]}),
        ),
        (
            format!("/albums/{album}/featured"),
            json!({"featured":true}),
        ),
    ] {
        let (status, body) = request(&app, Method::PUT, &path, &token, payload).await;
        assert_eq!(status, StatusCode::NOT_IMPLEMENTED, "{path}: {body}");
    }
    assert_eq!(
        request(
            &app,
            Method::DELETE,
            &format!("/albums/{album}"),
            &token,
            json!(null)
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        request(
            &app,
            Method::GET,
            &format!("/albums/{album}"),
            &token,
            json!(null)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(
            &app,
            Method::POST,
            &format!("/albums/{album}/items"),
            &token,
            json!({"attachmentUrl":"/uploads/x","attachmentName":"orphan"})
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert!(state.wdb.list_items(&album).await.unwrap().is_empty());
}

// Real Engine.IO polling through Axum, not mocked socket handlers. No external
// port or browser is needed to exercise auth, rooms, init and event routing.
struct SocketClient {
    app: Router,
    sid: String,
    socket_id: String,
    events: Vec<Value>,
}

#[tokio::test]
async fn voice_admission_rejects_private_missing_and_nonmember_channels() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (member, outsider, _) = users(&state).await;
    let voice = channel(&state, member, ChannelKind::Voice).await;
    let group = channel(&state, outsider, ChannelKind::GroupDm).await;
    let app = create_api_router(state.clone()).with_state(state.clone())
        .layer(wabi_server::socketio::create_socket_layer(state.clone()));
    let mut client = SocketClient::connect(&app, &jwt(&state, outsider)).await;
    for id in [&voice, &group, &"missing".to_string()] {
        for event in ["voice-channel-join", "voice-channel-subscribe"] {
            client.emit(event, json!({"channelId":id,"requestId":event})).await;
            let error = client.event("voice-channel-error").await;
            assert_eq!(error["channelId"], *id);
            assert_eq!(error["requestId"], event);
            client.emit("join-wabidb-call", json!({"channelId":id,"sessionId":format!("channel:{id}"),"requestId":"relay"})).await;
            assert_eq!(client.event("wabidb-call-denied").await["requestId"], "relay");
        }
    }
}

#[tokio::test]
async fn group_answer_requires_current_membership_even_when_call_exists() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (member, peer, outsider) = users(&state).await;
    let group = channel(&state, member, ChannelKind::GroupDm).await;
    state.wdb.add_channel_member(&group, peer, MemberRole::Member).await.unwrap();
    let app = create_api_router(state.clone()).with_state(state.clone())
        .layer(wabi_server::socketio::create_socket_layer(state.clone()));
    let mut caller = SocketClient::connect(&app, &jwt(&state, member)).await;
    let mut invited = SocketClient::connect(&app, &jwt(&state, peer)).await;
    let mut stranger = SocketClient::connect(&app, &jwt(&state, outsider)).await;
    caller.emit("call-initiate", json!({"channelId":group,"requestId":"start"})).await;
    assert_eq!(caller.event("group-call-started").await["requestId"], "start");
    assert_eq!(invited.event("call-incoming").await["channelId"], group);
    stranger.emit("call-initiate", json!({"channelId":group,"requestId":"outsider-start"})).await;
    let denied = stranger.event("call-error").await;
    assert_eq!(denied["channelId"], group);
    assert_eq!(denied["requestId"], "outsider-start");
    stranger.emit("call-answer", json!({"channelId":group})).await;
    assert_eq!(stranger.event("call-error").await["channelId"], group);
    invited.emit("call-answer", json!({"channelId":group,"requestId":"answer"})).await;
    assert_eq!(invited.event("group-call-admitted").await["requestId"], "answer");
    caller.emit("call-initiate", json!({"channelId":group,"requestId":"existing"})).await;
    let existing = caller.event("group-call-started").await;
    assert_eq!(existing["requestId"], "existing");
    assert_eq!(existing["established"], true);
    assert_eq!(invited.event("group-call-participant-joined").await["userId"], format!("user-{member}"));
    invited.emit("join-wabidb-call", json!({"channelId":group,"sessionId":format!("channel:{group}"),"requestId":"group-media"})).await;
    assert_eq!(invited.event("wabidb-call-joined").await["requestId"], "group-media");
    state.wdb.remove_channel_member(&group, peer).await.unwrap();
    invited.emit("call-answer", json!({"channelId":group})).await;
    assert_eq!(invited.event("call-error").await["channelId"], group);
    invited.emit("join-wabidb-call", json!({"channelId":group,"sessionId":format!("channel:{group}")})).await;
    invited.event("wabidb-call-denied").await;
}

impl SocketClient {
    async fn transport(app: &Router, method: Method, path: &str, body: String) -> String {
        let response = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            app.clone().oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header("content-type", "text/plain;charset=UTF-8")
                    .body(Body::from(body))
                    .unwrap(),
            ),
        )
        .await
        .expect("socket transport timed out")
        .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        String::from_utf8(
            to_bytes(response.into_body(), 1024 * 1024)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap()
    }
    fn path(&self) -> String {
        format!("/socket.io/?EIO=4&transport=polling&sid={}", self.sid)
    }
    async fn connect(app: &Router, token: &str) -> Self {
        let mut client = Self::handshake(app, token).await;
        client.emit("join", json!("client-supplied name is not identity")).await;
        client.event("init").await;
        client
    }
    async fn handshake(app: &Router, token: &str) -> Self {
        let open = Self::transport(
            app,
            Method::GET,
            "/socket.io/?EIO=4&transport=polling",
            String::new(),
        )
        .await;
        let handshake: Value = serde_json::from_str(open.strip_prefix('0').unwrap()).unwrap();
        let mut client = Self {
            app: app.clone(),
            sid: handshake["sid"].as_str().unwrap().into(),
            socket_id: String::new(),
            events: vec![],
        };
        Self::transport(
            app,
            Method::POST,
            &client.path(),
            format!("40{}", json!({"token":token})),
        )
        .await;
        let connected = Self::transport(app, Method::GET, &client.path(), String::new()).await;
        assert!(connected.starts_with("40"), "{connected}");
        let namespace: Value = serde_json::from_str(&connected[2..]).unwrap();
        client.socket_id = namespace["sid"].as_str().unwrap().into();
        client
    }
    async fn emit(&self, event: &str, data: Value) {
        Self::transport(
            &self.app,
            Method::POST,
            &self.path(),
            format!("42{}", json!([event, data])),
        )
        .await;
    }
    async fn event(&mut self, name: &str) -> Value {
        for _ in 0..20 {
            if let Some(index) = self.events.iter().position(|e| e[0] == name) {
                return self.events.remove(index)[1].clone();
            }
            let batch = Self::transport(&self.app, Method::GET, &self.path(), String::new()).await;
            for packet in batch.split('\u{1e}') {
                if let Some(payload) = packet.strip_prefix("42") {
                    self.events.push(serde_json::from_str(payload).unwrap());
                } else if packet == "2" {
                    Self::transport(&self.app, Method::POST, &self.path(), "3".into()).await;
                }
            }
        }
        panic!("no {name} event");
    }
}

#[tokio::test]
async fn voice_consent_is_device_owned_and_kick_revokes_only_that_channels_media() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (member, _, owner) = users(&state).await;
    let channel_id = channel(&state, member, ChannelKind::Voice).await;
    let other = channel(&state, member, ChannelKind::Voice).await;
    let private = channel(&state, member, ChannelKind::GroupDm).await;
    let app = create_api_router(state.clone()).with_state(state.clone())
        .layer(wabi_server::socketio::create_socket_layer(state.clone()));
    let mut first = SocketClient::connect(&app, &jwt(&state, member)).await;
    let mut second = SocketClient::connect(&app, &jwt(&state, member)).await;
    let moderator = SocketClient::connect(&app, &jwt(&state, owner)).await;
    let room = format!("wabidb-call-channel:{channel_id}");
    let other_room = format!("wabidb-call-channel:{other}");
    for id in [&channel_id, &other] {
        first.emit("voice-channel-join", json!({"channelId":id,"requestId":"primary"})).await;
        assert_eq!(first.event("voice-channel-admitted").await["requestId"], "primary");
        first.emit("join-wabidb-call", json!({"channelId":id,"sessionId":format!("channel:{id}")})).await;
        first.event("wabidb-call-joined").await;
    }
    second.emit("join-wabidb-call", json!({"channelId":channel_id,"sessionId":format!("channel:{channel_id}")})).await;
    second.event("wabidb-call-denied").await;
    second.emit("voice-channel-subscribe", json!({"channelId":channel_id,"requestId":"listen"})).await;
    second.event("voice-channel-admitted").await;
    second.emit("join-wabidb-call", json!({"channelId":channel_id,"sessionId":format!("channel:{channel_id}")})).await;
    second.event("wabidb-call-joined").await;
    // An unsolicited primary leave cannot eject the listener.
    first.emit("webrtc-offer", json!({"channelId":channel_id,"targetId":second.socket_id,"offer":{"type":"offer","sdp":"authorized-canary"}})).await;
    assert_eq!(second.event("webrtc-offer").await["offer"]["sdp"], "authorized-canary");
    second.emit("voice-channel-leave", json!({"channelId":channel_id})).await;
    second.emit("join-wabidb-call", json!({"channelId":channel_id,"sessionId":format!("channel:{channel_id}")})).await;
    second.event("wabidb-call-joined").await;
    first.emit("wabidb-media", json!({"sessionId":format!("channel:{channel_id}"),"kind":"audio","seq":0,"data":"header-canary"})).await;
    assert_eq!(second.event("wabidb-media").await["data"], "header-canary");
    first.emit("move-user-to-voice-channel", json!({"targetUserId":format!("user-{member}"),"toChannelId":private})).await;
    first.event("move-user-to-voice-channel-error").await;
    moderator.emit("voice-channel-kick", json!({"channelId":channel_id,"targetUserId":format!("user-{member}")})).await;
    first.event("voice-self-kicked").await;
    second.event("voice-self-kicked").await;
    // Inspect the real server rooms, not the UI's reaction to a kick.
    let io = state.sio.read().await.clone().unwrap();
    for client in [&first, &second] {
        let socket = io.sockets().into_iter().find(|s| s.id.to_string() == client.socket_id).unwrap();
        assert!(!socket.rooms().iter().any(|r| r.as_ref() == room));
        if client.socket_id == first.socket_id {
            assert!(socket.rooms().iter().any(|r| r.as_ref() == other_room));
        }
    }
    assert!(wabi_server::socketio::wabidb_header_cache_snapshot(&format!("channel:{channel_id}")).is_empty());
    second.emit("join-wabidb-call", json!({"channelId":channel_id,"sessionId":format!("channel:{channel_id}")})).await;
    second.event("wabidb-call-denied").await;
}

#[tokio::test]
async fn screen_and_peer_signaling_stay_in_one_call_and_reject_old_membership() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (member, peer, background) = users(&state).await;
    let group = "group-screen-boundary";
    let revision = state.wdb.create_group(group, "Screen", member, &[member, peer]).await.unwrap();
    let voice = channel(&state, member, ChannelKind::Voice).await;
    state.wdb.add_channel_member(&voice, background, MemberRole::Member).await.unwrap();
    let app = create_api_router(state.clone()).with_state(state.clone())
        .layer(wabi_server::socketio::create_socket_layer(state.clone()));
    let mut sender = SocketClient::connect(&app, &jwt(&state, member)).await;
    let mut recipient = SocketClient::connect(&app, &jwt(&state, peer)).await;
    let mut listener = SocketClient::connect(&app, &jwt(&state, background)).await;
    for client in [&mut sender, &mut listener] {
        client.emit("voice-channel-join", json!({"channelId":voice})).await;
        client.event("voice-channel-admitted").await;
    }
    sender.emit("call-initiate", json!({"channelId":group})).await;
    sender.event("group-call-started").await;
    recipient.emit("call-answer", json!({"channelId":group})).await;
    recipient.event("group-call-admitted").await;
    let share = json!({"channelId":group,"membershipRevision":revision.to_string(),"requestId":"group-share"});
    sender.emit("start-screen-share", share.clone()).await;
    let targets = sender.event("screen-share-targets").await;
    assert_eq!(targets["requestId"], "group-share");
    assert_eq!(targets["targets"].as_array().unwrap().len(), 1);
    assert_eq!(targets["targets"][0]["userId"], format!("user-{peer}"));
    assert_eq!(recipient.event("screen-share-started").await["channelId"], group);

    // An independently valid voice relationship must not authorize group SDP.
    for (event, field) in [("webrtc-offer", "offer"), ("webrtc-answer", "answer"),
        ("webrtc-ice-candidate", "candidate"), ("call-offer", "offer"),
        ("call-answer-sdp", "answer"), ("call-ice-candidate", "candidate")] {
        sender.emit(event, json!({"targetId":listener.socket_id,"channelId":group,field:{"canary":"wrong-call"}})).await;
        sender.emit(event, json!({"targetId":recipient.socket_id,"channelId":group,"requestId":"group-share",field:{"canary":"right-call"}})).await;
        let signal = recipient.event(event).await;
        assert_eq!(signal["channelId"], group);
        assert_eq!(signal[field]["canary"], "right-call");
    }
    sender.emit("start-screen-share", json!({"channelId":voice,"requestId":"voice-barrier"})).await;
    let barrier = listener.event("screen-share-started").await;
    assert_eq!(barrier["requestId"], "voice-barrier", "group notification must not leak to the background call");
    assert!(!listener.events.iter().any(|event| event[1].to_string().contains("wrong-call")));
    sender.emit("stop-screen-share", share.clone()).await;
    let stop = recipient.event("screen-share-stopped").await;
    assert_eq!(stop["requestId"], "group-share");
    assert_eq!(stop["channelId"], group);

    // Do not silently choose every active call for an old unscoped start.
    sender.emit("start-screen-share", json!({"requestId":"ambiguous"})).await;
    assert_eq!(sender.event("screen-share-error").await["requestId"], "ambiguous");
    state.wdb.change_group_membership(member, group, None, Some(peer), member).await.unwrap();
    state.wdb.change_group_membership(member, group, Some(peer), None, member).await.unwrap();
    sender.emit("start-screen-share", share).await;
    assert_eq!(sender.event("screen-share-error").await["requestId"], "group-share", "old scope cannot start after re-add");
}

#[tokio::test]
async fn group_consent_is_device_owned_and_old_disconnect_cannot_evict_a_replacement() {
    async fn disconnect(client: &SocketClient, state: &AppState) {
        // Queue the disconnect behind the gate, then wait for its read-side
        // cleanup to finish. No timing sleeps or assumptions about HTTP flush.
        let gate = state.membership_gate.write().await;
        SocketClient::transport(&client.app, Method::POST, &client.path(), "41".into()).await;
        tokio::task::yield_now().await;
        drop(gate);
        drop(state.membership_gate.write().await);
    }
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (member, peer, _) = users(&state).await;
    let group = "group-device-reconnect";
    let revision = state.wdb.create_group(group, "Devices", member, &[member, peer]).await.unwrap();
    let app = create_api_router(state.clone()).with_state(state.clone())
        .layer(wabi_server::socketio::create_socket_layer(state.clone()));
    let mut original = SocketClient::connect(&app, &jwt(&state, member)).await;
    let mut other_device = SocketClient::connect(&app, &jwt(&state, member)).await;
    let mut partner = SocketClient::connect(&app, &jwt(&state, peer)).await;
    original.emit("call-initiate", json!({"channelId":group})).await;
    original.event("group-call-started").await;
    partner.emit("call-answer", json!({"channelId":group,"requestId":"answer"})).await;
    partner.event("group-call-admitted").await;
    other_device.emit("join-wabidb-call", json!({"channelId":group,"sessionId":format!("channel:{group}")})).await;
    other_device.event("wabidb-call-denied").await;
    disconnect(&other_device, &state).await;
    original.emit("join-wabidb-call", json!({"channelId":group,"sessionId":format!("channel:{group}")})).await;
    original.event("wabidb-call-joined").await;

    // Reconnect can win before the old socket's disconnect is processed.
    let mut replacement = SocketClient::connect(&app, &jwt(&state, member)).await;
    replacement.emit("call-initiate", json!({"channelId":group,"rejoin":true,"membershipRevision":revision.to_string(),"requestId":"resume"})).await;
    let admitted = replacement.event("group-call-started").await;
    assert_eq!(admitted["requestId"], "resume");
    assert_eq!(admitted["established"], true);
    partner.event("group-call-participant-joined").await;
    disconnect(&original, &state).await;
    replacement.emit("join-wabidb-call", json!({"channelId":group,"sessionId":format!("channel:{group}")})).await;
    replacement.event("wabidb-call-joined").await;
    replacement.emit("webrtc-offer", json!({"channelId":group,"targetId":partner.socket_id,"offer":{"sdp":"replacement-alive"}})).await;
    assert_eq!(partner.event("webrtc-offer").await["offer"]["sdp"], "replacement-alive");
    assert!(!partner.events.iter().any(|e| e[0] == "group-call-participant-left" || e[0] == "call-ended"));

    replacement.emit("group-call-leave", json!({"channelId":group})).await;
    let left = partner.event("group-call-participant-left").await;
    assert_eq!(left["userId"], format!("user-{member}"), "departure addresses the same stable key as admission");
    assert_eq!(left["socketId"], replacement.socket_id);
    replacement.emit("join-wabidb-call", json!({"channelId":group,"sessionId":format!("channel:{group}")})).await;
    replacement.event("wabidb-call-denied").await;

    state.wdb.change_group_membership(member, group, None, Some(peer), member).await.unwrap();
    state.wdb.change_group_membership(member, group, Some(peer), None, member).await.unwrap();
    replacement.emit("call-initiate", json!({"channelId":group,"rejoin":true,"membershipRevision":revision.to_string(),"requestId":"stale-resume"})).await;
    let denied = replacement.event("call-error").await;
    assert_eq!(denied["code"], "membership_changed");
    assert_eq!(denied["requestId"], "stale-resume");
}

#[tokio::test]
async fn group_readmission_can_rebuild_empty_runtime_state_without_ringing_members() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (member, peer, _) = users(&state).await;
    let group = "group-cold-readmission";
    let revision = state.wdb.create_group(group, "Cold", member, &[member, peer]).await.unwrap();
    // Durable membership exists, but the newly constructed Socket.IO layer has
    // no ephemeral call roster (the same boundary as a server restart).
    let app = create_api_router(state.clone()).with_state(state.clone())
        .layer(wabi_server::socketio::create_socket_layer(state.clone()));
    let mut first = SocketClient::connect(&app, &jwt(&state, member)).await;
    let mut second = SocketClient::connect(&app, &jwt(&state, peer)).await;
    first.emit("call-initiate", json!({"channelId":group,"rejoin":true,"membershipRevision":revision.to_string(),"requestId":"first"})).await;
    assert_eq!(first.event("group-call-started").await["requestId"], "first");
    second.emit("join-wabidb-call", json!({"channelId":group,"sessionId":format!("channel:{group}")})).await;
    second.event("wabidb-call-denied").await;
    assert!(!second.events.iter().any(|e| e[0] == "call-incoming"), "recovery is not a new ringing invitation");
    second.emit("call-initiate", json!({"channelId":group,"rejoin":true,"membershipRevision":revision.to_string(),"requestId":"second"})).await;
    assert_eq!(second.event("group-call-started").await["established"], true);
    for client in [&mut first, &mut second] {
        client.emit("join-wabidb-call", json!({"channelId":group,"sessionId":format!("channel:{group}")})).await;
        client.event("wabidb-call-joined").await;
    }
}

#[tokio::test]
async fn direct_relay_accepts_both_named_peers_with_legacy_ui_channel_hints_only() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (first_id, second_id, outsider) = users(&state).await;
    let app = create_api_router(state.clone()).with_state(state.clone())
        .layer(wabi_server::socketio::create_socket_layer(state.clone()));
    let session = format!("dm:user-{first_id}:user-{second_id}");
    for uid in [first_id, second_id, outsider] {
        let mut client = SocketClient::connect(&app, &jwt(&state, uid)).await;
        client.emit("join-wabidb-call", json!({"sessionId":session,"channelId":format!("user-{second_id}"),"requestId":"direct"})).await;
        let event = if uid == outsider { "wabidb-call-denied" } else { "wabidb-call-joined" };
        assert_eq!(client.event(event).await["requestId"], "direct");
    }
}

#[tokio::test]
async fn socket_discovery_sync_and_message_mutations_obey_private_membership() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (member, outsider, owner) = users(&state).await;
    let dm = channel(&state, member, ChannelKind::Dm).await;
    let group = channel(&state, member, ChannelKind::GroupDm).await;
    let public = channel(&state, outsider, ChannelKind::Text).await;
    let message = state
        .wdb
        .send_message(&dm, member, "private canary", false, &[])
        .await
        .unwrap();
    state.session_messages.write().await.insert(
        dm.clone(),
        vec![json!({"id":"live-canary","text":"private live body"})],
    );
    let app = create_api_router(state.clone())
        .with_state(state.clone())
        .layer(wabi_server::socketio::create_socket_layer(state.clone()));
    let mut stranger = SocketClient::connect(&app, &jwt(&state, owner)).await;
    stranger.emit("join", json!("owner")).await;
    let init = stranger.event("init").await;
    let visible = init["channels"].as_array().unwrap();
    assert!(
        visible.iter().all(|c| c["id"] != dm && c["id"] != group),
        "{init}"
    );
    assert!(visible.iter().any(|c| c["id"] == public));
    for id in [&dm, &group] {
        stranger.emit("join-channel", json!(id)).await;
        assert_eq!(stranger.event("join-error").await["error"], "access denied");
    }
    stranger.emit("sync-newer", json!({"channelId":dm})).await;
    assert_eq!(
        stranger.event("sync-error").await["error"],
        "Channel access denied"
    );
    // A permitted channel ID must not authorize a message ID in a different DM.
    for (event, error_event, extra) in [
        ("edit-message", "edit-error", json!({"newText":"stolen"})),
        ("delete-message", "delete-error", json!({})),
        (
            "add-emoji-reaction",
            "reaction-error",
            json!({"emojiId":"x"}),
        ),
        ("toggle-pin-message", "pin-error", json!({})),
    ] {
        let mut payload = extra;
        payload["channelId"] = json!(public);
        payload["messageId"] = json!(message);
        stranger.emit(event, payload).await;
        assert_eq!(
            stranger.event(error_event).await["error"],
            "Message not found in channel",
            "{event}"
        );
    }
    assert_eq!(
        state
            .wdb
            .get_message_typed(&message)
            .await
            .unwrap()
            .unwrap()
            .content,
        "private canary"
    );
    assert!(state.wdb.list_reactions(&message).await.unwrap().is_empty());
    let mut participant = SocketClient::connect(&app, &jwt(&state, member)).await;
    participant
        .emit("sync-newer", json!({"channelId":dm}))
        .await;
    assert_eq!(
        participant.event("sync-newer-result").await["messages"][0]["text"],
        "private live body"
    );
    state.wdb.remove_channel_member(&dm, member).await.unwrap();
    participant
        .emit("sync-newer", json!({"channelId":dm}))
        .await;
    assert_eq!(
        participant.event("sync-error").await["error"],
        "Channel access denied"
    );
}

#[tokio::test]
async fn conversation_events_reach_only_participants_and_legacy_changes_do_not_lie() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (member, invited, owner) = users(&state).await;
    let app = create_api_router(state.clone())
        .with_state(state.clone())
        .layer(wabi_server::socketio::create_socket_layer(state.clone()));
    let mut creator = SocketClient::connect(&app, &jwt(&state, member)).await;
    let mut stranger = SocketClient::connect(&app, &jwt(&state, owner)).await;
    let mut participant = SocketClient::connect(&app, &jwt(&state, invited)).await;
    creator
        .emit(
            "create-group",
            json!({"requestId":uuid::Uuid::new_v4().to_string(), "groupName":"private group canary", "userIds":[format!("user-{invited}")]}),
        )
        .await;
    let created = creator.event("group-created").await;
    let group = created["channelId"].as_str().unwrap();
    assert_eq!(
        participant.event("group-channel-added").await["channelId"],
        group
    );
    stranger.emit("join", json!("owner")).await;
    let init = stranger.event("init").await;
    assert!(init["channels"]
        .as_array()
        .unwrap()
        .iter()
        .all(|c| c["id"] != group));
    assert!(stranger
        .events
        .iter()
        .all(|e| e[0] != "group-channel-added"));
    participant.emit("join", json!("participant")).await;
    let init = participant.event("init").await;
    let view = init["channels"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == group)
        .unwrap();
    assert_eq!(
        view["members"].as_array().unwrap().len(),
        2,
        "reconnect must retain participant IDs"
    );
    creator.event("group-operation-result").await;
    for (event, error, code) in [
        ("leave-group", "group-operation-result", "INVALID_REQUEST"),
        ("kick-group-member", "group-operation-result", "INVALID_REQUEST"),
        ("add-group-member", "group-operation-result", "INVALID_REQUEST"),
        ("update-group-avatar", "avatar-error", "NOT_IMPLEMENTED"),
    ] {
        creator.emit(event, json!({"channelId":group,"userId":format!("user-{owner}"),"targetUserId":format!("user-{invited}"),"avatarUrl":"/uploads/anything"})).await;
        assert_eq!(
            creator.event(error).await["code"],
            code,
            "{event}"
        );
    }
    assert_eq!(
        state.wdb.list_channel_members(group).await.unwrap().len(),
        2
    );
    assert_eq!(
        state.wdb.get_channel(group).await.unwrap().unwrap().name,
        "private group canary"
    );
    let dm = format!("dm-user-{member}-user-{invited}");
    state
        .wdb
        .create_dm_channel(
            &dm,
            "secret DM",
            Some(&[format!("user-{member}"), format!("user-{invited}")]),
            member as i64,
        )
        .await
        .unwrap();
    stranger.emit("delete-dm", json!({"channelId":dm})).await;
    assert_eq!(
        stranger.event("dm-error").await["error"],
        "Channel access denied"
    );
    assert!(state.wdb.get_channel(&dm).await.unwrap().is_some());
    creator.emit("delete-dm", json!({"channelId":dm})).await;
    creator.event("dm-deleted").await;
    assert_eq!(participant.event("dm-deleted").await["channelId"], dm);
    stranger.emit("join", json!("owner")).await;
    stranger.event("init").await;
    assert!(stranger.events.iter().all(|e| e[0] != "dm-deleted"));
    assert!(state.wdb.get_channel(&dm).await.unwrap().is_none());
}

#[path = "fixtures/group_revocation.rs"]
mod group_revocation;

#[tokio::test]
async fn nested_workspace_paths_cannot_alias_another_channels_records() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (member, outsider, _) = users(&state).await;
    let private = channel(&state, member, ChannelKind::Dm).await;
    let allowed = channel(&state, outsider, ChannelKind::Text).await;
    let page = state
        .wdb
        .create_wiki_page(&private, "secret", "canary", member, "", "", 0)
        .await
        .unwrap();
    let thread = state
        .wdb
        .create_forum_thread(&private, "canary", member, Some("secret"), None, None)
        .await
        .unwrap();
    let work = state
        .wdb
        .upload_gallery_work(
            &private,
            "secret",
            "canary",
            "/uploads/canary",
            "image/png",
            "",
            false,
            member,
        )
        .await
        .unwrap();
    let incident = state
        .wdb
        .create_incident(&private, "secret", "canary", "low", member)
        .await
        .unwrap();
    let app = create_api_router(state.clone()).with_state(state.clone());
    let token = jwt(&state, outsider);
    for (path, payload) in [
        (
            format!("/wiki/{allowed}/pages/{page}"),
            json!({"title":"stolen","body":"overwritten"}),
        ),
        (
            format!("/forum/{allowed}/threads/{thread}/posts/{thread}"),
            json!({"body":"overwritten"}),
        ),
        (
            format!("/gallery/{allowed}/works/{work}"),
            json!({"title":"stolen","caption":"overwritten","category":"","isWip":false}),
        ),
        (
            format!("/incidents/{allowed}/{incident}"),
            json!({"description":"overwritten"}),
        ),
    ] {
        let (status, body) = request(&app, Method::PUT, &path, &token, payload).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path}: {body}");
    }
    assert_eq!(
        state
            .wdb
            .get_wiki_page(&private, &page)
            .await
            .unwrap()
            .unwrap()
            .body,
        "canary"
    );
    assert_eq!(
        state
            .wdb
            .get_forum_post(&private, &thread, &thread)
            .await
            .unwrap()
            .unwrap()
            .body,
        "canary"
    );
    assert_eq!(
        state
            .wdb
            .get_gallery_work(&private, &work)
            .await
            .unwrap()
            .unwrap()
            .caption,
        "canary"
    );
    assert_eq!(
        state
            .wdb
            .get_incident(&private, &incident)
            .await
            .unwrap()
            .unwrap()
            .description,
        "canary"
    );
}
