//! Real REST, raw WebSocket and WabiDB call-state boundary contracts.
use axum::{
    body::{to_bytes, Body},
    http::{Method, Request, StatusCode},
    Router,
};
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{path::Path, sync::Arc, time::Duration};
use tower::ServiceExt;
use wabi_server::{
    app_router::build_app_router,
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
            data_dir: path.to_string_lossy().into(),
            uploads_dir: path.join("uploads").to_string_lossy().into(),
            jwt_secret: "call-state-test-only".into(),
            turn_enabled: false,
            turn_uri: None,
            turn_secret: None,
            node_id: "test".into(),
            is_primary: true,
            server_role: ServerRole::Authority,
            authority_url: None,
            admin_user_ids: vec![],
            blacklist_file: path.join("blacklist").to_string_lossy().into(),
            max_body_size: None,
            mesh_enabled: false,
            mesh_peers: vec![],
            lore: LoreAddonConfig::default(),
        })
        .await
        .unwrap(),
    )
}
fn token(state: &AppState, user: u64, lifetime: i64, kind: &str) -> String {
    let now = chrono::Utc::now().timestamp();
    jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &JwtClaims {
            sub: user.to_string(),
            username: format!("user-{user}"),
            is_guest: false,
            exp: now + lifetime,
            iat: now,
            jti: uuid::Uuid::new_v4().to_string(),
            stepup: false,
            token_type: kind.into(),
        },
        &jsonwebtoken::EncodingKey::from_secret(state.config.jwt_secret.as_bytes()),
    )
    .unwrap()
}
async fn seed(state: &AppState) -> (u64, u64, u64, String) {
    let host = state
        .wdb
        .create_user("host", None, "registered")
        .await
        .unwrap();
    let peer = state
        .wdb
        .create_user("peer", None, "registered")
        .await
        .unwrap();
    let outsider = state
        .wdb
        .create_user("outsider", None, "registered")
        .await
        .unwrap();
    let channel = state
        .wdb
        .create_channel("private", ChannelKind::GroupDm, host, false)
        .await
        .unwrap();
    for uid in [host, peer] {
        state
            .wdb
            .add_channel_member(&channel, uid, MemberRole::Member)
            .await
            .unwrap();
    }
    (host, peer, outsider, channel)
}
async fn http(
    app: &Router,
    method: Method,
    path: &str,
    token: &str,
    body: Value,
) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .extension(axum::extract::ConnectInfo(
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
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(json!(null)),
    )
}
fn create(id: &str, channel: &str) -> Value {
    json!({"session_id":id,"channel_id":channel,"call_type":"audio-call","max_participants":2,"transport":"wabidb"})
}
async fn post_ok(app: &Router, path: &str, token: &str, body: Value) -> Value {
    let (status, body) = http(app, Method::POST, path, token, body).await;
    assert_eq!(status, StatusCode::OK, "{path}: {body}");
    body
}
type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
struct RunningServer(tokio::task::JoinHandle<()>);
impl Drop for RunningServer {
    fn drop(&mut self) {
        self.0.abort();
    }
}
async fn listen(state: Arc<AppState>) -> (RunningServer, String) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/ws", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(
            listener,
            build_app_router(state).into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap();
    });
    (RunningServer(task), url)
}
async fn send(ws: &mut Ws, body: Value) {
    ws.send(tokio_tungstenite::tungstenite::Message::Text(
        body.to_string().into(),
    ))
    .await
    .unwrap();
}
async fn event(ws: &mut Ws) -> Value {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            match ws.next().await.expect("socket ended").unwrap() {
                tokio_tungstenite::tungstenite::Message::Text(text) => {
                    return serde_json::from_str(&text).unwrap()
                }
                tokio_tungstenite::tungstenite::Message::Ping(data) => ws
                    .send(tokio_tungstenite::tungstenite::Message::Pong(data))
                    .await
                    .unwrap(),
                message => panic!("unexpected {message:?}"),
            }
        }
    })
    .await
    .expect("call-state event timed out")
}

#[tokio::test]
async fn stale_group_call_http_cannot_join_or_leave_a_readmitted_account() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (host, peer, _, _) = seed(&state).await;
    let channel = "group-http-epoch";
    let initial = state.wdb.create_group(channel, "HTTP fence", host, &[host, peer]).await.unwrap();
    let id = format!("channel:{channel}");
    let app = build_app_router(state.clone());
    let credential = token(&state, peer, 3600, "access");
    post_ok(&app, &format!("/api/calls/sessions?membership_revision={initial}"), &credential, create(&id, channel)).await;
    post_ok(&app, &format!("/api/calls/sessions/{id}/join?membership_revision={initial}"), &credential,
        json!({"stable_user_id":format!("user-{peer}")})).await;
    state.wdb.change_group_membership(host, channel, None, Some(peer), host).await.unwrap();
    let fresh = state.wdb.change_group_membership(host, channel, Some(peer), None, host).await.unwrap();
    for (path, body) in [
        ("/api/calls/sessions".to_string(), create(&id, channel)),
        (format!("/api/calls/sessions/{id}/join"), json!({"stable_user_id":format!("user-{peer}")})),
    ] {
        assert_eq!(http(&app, Method::POST, &format!("{path}?membership_revision={initial}"), &credential, body).await.0, StatusCode::CONFLICT);
    }
    assert!(state.wdb.get_call_participants(&id).await.unwrap().iter().all(|p| p.left_at_micros.is_some()));
    post_ok(&app, &format!("/api/calls/sessions/{id}/join?membership_revision={fresh}"), &credential,
        json!({"stable_user_id":format!("user-{peer}")})).await;
    assert_eq!(http(&app, Method::POST, &format!("/api/calls/sessions/{id}/leave?membership_revision={initial}"),
        &credential, json!({})).await.0, StatusCode::CONFLICT);
    assert!(state.wdb.get_call_participants(&id).await.unwrap().iter().any(|p| p.user_id == peer && p.left_at_micros.is_none()));
}

#[tokio::test]
async fn private_call_rest_rejects_nonmembers_and_preserves_authoritative_state() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (host, _, outsider, channel) = seed(&state).await;
    let id = format!("channel:{channel}");
    let app = build_app_router(state.clone());
    post_ok(
        &app,
        "/api/calls/sessions",
        &token(&state, host, 3600, "access"),
        create(&id, &channel),
    )
    .await;
    let outsider_token = token(&state, outsider, 3600, "access");
    for (method, suffix, body) in [
        (Method::GET, "", json!(null)),
        (Method::GET, "/participants", json!(null)),
        (Method::GET, "/signals", json!(null)),
        (
            Method::POST,
            "/join",
            json!({"stable_user_id":format!("user-{host}")}),
        ),
        (Method::POST, "/leave", json!({})),
        (Method::POST, "/end", json!({})),
        (
            Method::POST,
            "/signals",
            json!({"signal_type":"offer","payload":"secret"}),
        ),
    ] {
        let (status, body) = http(
            &app,
            method,
            &format!("/api/calls/sessions/{id}{suffix}"),
            &outsider_token,
            body,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{suffix}: {body}");
    }
    assert!(
        state
            .wdb
            .get_call_session(&id)
            .await
            .unwrap()
            .unwrap()
            .active
    );
    assert!(state
        .wdb
        .get_call_participants(&id)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn unauthenticated_socket_cannot_forge_a_server_broadcast() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (_running, url) = listen(state).await;
    let (mut attacker, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    send(&mut attacker,json!({"type":"message-received","id":1,"channel_id":1,"user_id":999,"content":"forged-canary","message_type":"text","created_at":0})).await;
    let response = event(&mut attacker).await;
    assert_ne!(
        response["type"], "message-received",
        "a client must never mint server broadcasts"
    );
}

async fn joined(app: &Router, state: &AppState, id: &str, uid: u64) {
    post_ok(
        app,
        &format!("/api/calls/sessions/{id}/join"),
        &token(state, uid, 3600, "access"),
        json!({"stable_user_id":format!("user-{uid}")}),
    )
    .await;
}
async fn authenticated(ws: &mut Ws, state: &AppState, uid: u64) {
    send(
        ws,
        json!({"type":"authenticate","token":token(state,uid,3600,"access")}),
    )
    .await;
    let ack = event(ws).await;
    assert_eq!(ack["type"], "authenticated");
    assert_eq!(ack["user_id"], uid);
}

#[tokio::test]
async fn creation_join_capacity_and_host_authority_are_serialized() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (host, peer, third, channel) = seed(&state).await;
    state
        .wdb
        .add_channel_member(&channel, third, MemberRole::Member)
        .await
        .unwrap();
    let app = build_app_router(state.clone());
    let id = format!("channel:{channel}");
    let host_token = token(&state, host, 3600, "access");
    let peer_token = token(&state, peer, 3600, "access");
    post_ok(
        &app,
        "/api/calls/sessions",
        &host_token,
        create(&id, &channel),
    )
    .await;
    let original = state.wdb.get_call_session(&id).await.unwrap().unwrap();
    let retries = (0..8).map(|_| {
        post_ok(
            &app,
            "/api/calls/sessions",
            &peer_token,
            create(&id, &channel),
        )
    });
    for result in futures::future::join_all(retries).await {
        assert!(result["commit_seq"].is_null());
    }
    let after = state.wdb.get_call_session(&id).await.unwrap().unwrap();
    assert_eq!(after.host_user_id, host);
    assert_eq!(after.started_at_micros, original.started_at_micros);
    let path = format!("/api/calls/sessions/{id}/join");
    assert_eq!(
        http(
            &app,
            Method::POST,
            &path,
            &peer_token,
            json!({"stable_user_id":format!("user-{host}")})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    joined(&app, &state, &id, host).await;
    let before = state.wdb.get_call_participants(&id).await.unwrap();
    joined(&app, &state, &id, host).await;
    assert_eq!(
        state.wdb.get_call_participants(&id).await.unwrap()[0].joined_at_micros,
        before[0].joined_at_micros
    );
    assert!(before[0].is_host);
    let third_token = token(&state, third, 3600, "access");
    let (a, b) = tokio::join!(
        http(
            &app,
            Method::POST,
            &path,
            &peer_token,
            json!({"stable_user_id":format!("user-{peer}")})
        ),
        http(
            &app,
            Method::POST,
            &path,
            &third_token,
            json!({"stable_user_id":format!("user-{third}")})
        )
    );
    assert!([a.0, b.0].contains(&StatusCode::OK));
    assert!([a.0, b.0].contains(&StatusCode::CONFLICT));
    assert_eq!(
        http(
            &app,
            Method::POST,
            &format!("/api/calls/sessions/{id}/end"),
            &peer_token,
            json!({})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    post_ok(
        &app,
        &format!("/api/calls/sessions/{id}/end"),
        &host_token,
        json!({}),
    )
    .await;
    assert_eq!(
        http(
            &app,
            Method::POST,
            &path,
            &host_token,
            json!({"stable_user_id":format!("user-{host}")})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    post_ok(
        &app,
        "/api/calls/sessions",
        &peer_token,
        create(&id, &channel),
    )
    .await;
    assert_eq!(
        state
            .wdb
            .get_call_session(&id)
            .await
            .unwrap()
            .unwrap()
            .host_user_id,
        peer
    );
    assert!(state
        .wdb
        .get_call_participants(&id)
        .await
        .unwrap()
        .iter()
        .all(|p| p.left_at_micros.is_some()));
    assert_eq!(
        http(
            &app,
            Method::POST,
            "/api/calls/sessions/missing/join",
            &host_token,
            json!({"stable_user_id":format!("user-{host}")})
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert!(state
        .wdb
        .get_call_participants("missing")
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn direct_keys_ignore_ui_hints_but_never_authorize_a_third_account() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (host, peer, outsider, _) = seed(&state).await;
    let app = build_app_router(state.clone());
    let mut pair = [format!("user-{host}"), format!("user-{peer}")];
    pair.sort();
    let id = format!("dm:{}:{}", pair[0], pair[1]);
    let access = token(&state, host, 3600, "access");
    post_ok(
        &app,
        "/api/calls/sessions",
        &access,
        create(&id, "people-ui-peer-hint"),
    )
    .await;
    post_ok(
        &app,
        "/api/calls/sessions",
        &token(&state, peer, 3600, "access"),
        create(&id, "different-hint"),
    )
    .await;
    let row = state.wdb.get_call_session(&id).await.unwrap().unwrap();
    assert_eq!(row.channel_id, id);
    assert_eq!(row.host_user_id, host);
    assert_eq!(
        http(
            &app,
            Method::POST,
            "/api/calls/sessions",
            &token(&state, outsider, 3600, "access"),
            create(&id, "hint")
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    for invalid in [
        format!("dm:{}:{}", pair[1], pair[0]),
        format!("dm:user-{host}:user-{host}"),
        "dm:user-0:user-1".into(),
        "dm:user-01:user-2".into(),
    ] {
        assert_eq!(
            http(
                &app,
                Method::POST,
                "/api/calls/sessions",
                &access,
                create(&invalid, "hint")
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
}

#[tokio::test]
async fn colon_key_signal_history_is_durable_ordered_and_recipient_scoped() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (host, peer, third, channel) = seed(&state).await;
    state
        .wdb
        .add_channel_member(&channel, third, MemberRole::Member)
        .await
        .unwrap();
    // API router avoids the unrelated long-lived Socket.IO sweep task; this
    // fixture must release every engine owner to test an actual clean reopen.
    let app = Router::new()
        .nest(
            "/api",
            wabi_server::api::routes::create_api_router(state.clone()),
        )
        .with_state(state.clone());
    let id = format!("channel:{channel}");
    let access = token(&state, host, 3600, "access");
    let path = format!("/api/calls/sessions/{id}/signals");
    let mut body = create(&id, &channel);
    body["max_participants"] = json!(3);
    post_ok(&app, "/api/calls/sessions", &access, body).await;
    assert_eq!(
        http(
            &app,
            Method::POST,
            &path,
            &access,
            json!({"signal_type":"offer","payload":"not-joined"})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    for uid in [host, peer, third] {
        joined(&app, &state, &id, uid).await;
    }
    post_ok(
        &app,
        &path,
        &access,
        json!({"signal_type":"offer","payload":"secret","target_user_id":peer}),
    )
    .await;
    post_ok(
        &app,
        &path,
        &access,
        json!({"signal_type":"mute","payload":"public"}),
    )
    .await;
    for (uid, expected) in [(host, 2), (peer, 2), (third, 1)] {
        let (status, body) = http(
            &app,
            Method::GET,
            &path,
            &token(&state, uid, 3600, "access"),
            json!(null),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["signals"].as_array().unwrap().len(), expected);
    }
    let signals = state.wdb.get_call_signals(&id, 0).await.unwrap();
    assert_eq!(
        signals.iter().map(|s| s.signal_id).collect::<Vec<_>>(),
        vec![1, 2]
    );
    assert_eq!(state.wdb.get_call_signals(&id, 1).await.unwrap().len(), 1);
    // Drop every owner normally; engine snapshots/releases its own lock.
    drop(app);
    drop(state);
    let state = server(dir.path()).await;
    let app = Router::new()
        .nest(
            "/api",
            wabi_server::api::routes::create_api_router(state.clone()),
        )
        .with_state(state.clone());
    let access = token(&state, host, 3600, "access");
    let writes = (0..8).map(|_| {
        post_ok(
            &app,
            &path,
            &access,
            json!({"signal_type":"ice","payload":"candidate"}),
        )
    });
    futures::future::join_all(writes).await;
    let signals = state.wdb.get_call_signals(&id, 0).await.unwrap();
    assert_eq!(
        signals.iter().map(|s| s.signal_id).collect::<Vec<_>>(),
        (1..=10).collect::<Vec<_>>()
    );
    assert_eq!(signals[0].payload, "secret");
}

#[tokio::test]
async fn socket_auth_subscription_refresh_and_membership_revocation_are_enforced() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (host, peer, outsider, channel) = seed(&state).await;
    let app = build_app_router(state.clone());
    let id = format!("channel:{channel}");
    let access = token(&state, host, 3600, "access");
    post_ok(&app, "/api/calls/sessions", &access, create(&id, &channel)).await;
    joined(&app, &state, &id, host).await;
    joined(&app, &state, &id, peer).await;
    let (_running, url) = listen(state.clone()).await;
    for kind in ["refresh", "lore", "unknown"] {
        let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
        send(
            &mut ws,
            json!({"type":"authenticate","token":token(&state,host,3600,kind)}),
        )
        .await;
        assert_eq!(event(&mut ws).await["type"], "authentication_error");
    }
    let (mut other, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    authenticated(&mut other, &state, outsider).await;
    send(&mut other, json!({"type":"subscribe_call","session_id":id})).await;
    assert_eq!(event(&mut other).await["type"], "subscription_error");
    let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    authenticated(&mut ws, &state, peer).await;
    send(&mut ws, json!({"type":"subscribe_call","session_id":id})).await;
    assert_eq!(event(&mut ws).await["type"], "call_snapshot");
    authenticated(&mut ws, &state, peer).await; // same-account rotation keeps the subscription
    send(
        &mut ws,
        json!({"type":"call_session_changed","session":{"active":false}}),
    )
    .await;
    assert_eq!(event(&mut ws).await["type"], "error");
    post_ok(
        &app,
        &format!("/api/calls/sessions/{id}/signals"),
        &access,
        json!({"signal_type":"offer","payload":"private","target_user_id":peer}),
    )
    .await;
    let live = event(&mut ws).await;
    assert_eq!(live["type"], "call_signal_emitted");
    let durable = state.wdb.get_call_signals(&id, 0).await.unwrap();
    assert_eq!(live["signal"], serde_json::to_value(&durable[0]).unwrap());
    state
        .wdb
        .remove_channel_member(&channel, peer)
        .await
        .unwrap();
    post_ok(
        &app,
        &format!("/api/calls/sessions/{id}/signals"),
        &access,
        json!({"signal_type":"mute","payload":"not-for-former-member"}),
    )
    .await;
    assert_eq!(event(&mut ws).await["type"], "subscription_error");
    send(
        &mut ws,
        json!({"type":"authenticate","token":token(&state,host,3600,"access")}),
    )
    .await;
    assert_eq!(event(&mut ws).await["type"], "authentication_error");
}

#[tokio::test]
async fn expired_socket_token_is_rejected_even_inside_http_clock_leeway() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (host, _, _, _) = seed(&state).await;
    let (_running, url) = listen(state.clone()).await;
    let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    send(
        &mut ws,
        json!({"type":"authenticate","token":token(&state,host,-1,"access")}),
    )
    .await;
    assert_eq!(event(&mut ws).await["type"], "authentication_error");
}

#[tokio::test]
async fn revoked_credentials_close_an_idle_authenticated_connection() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (host, _, _, _) = seed(&state).await;
    let (_running, url) = listen(state.clone()).await;
    let access = token(&state, host, 3600, "access");
    let claims = wabi_server::auth_extractor::decode_token(&access, &state.config.jwt_secret)
        .await
        .unwrap();
    let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    send(&mut ws, json!({"type":"authenticate","token":access})).await;
    assert_eq!(event(&mut ws).await["type"], "authenticated");
    state.revoke_token_with_exp(claims.jti, claims.exp).await;
    assert_eq!(event(&mut ws).await["type"], "authentication_error");
}

#[tokio::test]
async fn socket_unicast_does_not_leak_to_another_authorized_call_participant() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (host, peer, third, channel) = seed(&state).await;
    let app = build_app_router(state.clone());
    state
        .wdb
        .add_channel_member(&channel, third, MemberRole::Member)
        .await
        .unwrap();
    let id = format!("channel:{channel}");
    let access = token(&state, host, 3600, "access");
    let mut body = create(&id, &channel);
    body["max_participants"] = json!(3);
    post_ok(&app, "/api/calls/sessions", &access, body).await;
    for uid in [host, peer, third] {
        joined(&app, &state, &id, uid).await;
    }
    let (_running, url) = listen(state.clone()).await;
    let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    authenticated(&mut ws, &state, third).await;
    send(&mut ws, json!({"type":"subscribe_call","session_id":id})).await;
    assert_eq!(event(&mut ws).await["type"], "call_snapshot");
    let path = format!("/api/calls/sessions/{id}/signals");
    post_ok(
        &app,
        &path,
        &access,
        json!({"signal_type":"offer","payload":"unicast-canary","target_user_id":peer}),
    )
    .await;
    post_ok(
        &app,
        &path,
        &access,
        json!({"signal_type":"mute","payload":"broadcast-barrier"}),
    )
    .await;
    // Ordered barrier proves the preceding unicast was filtered, not just late.
    let received = event(&mut ws).await;
    assert_eq!(received["signal"]["payload"], "broadcast-barrier");
    send(&mut ws, json!({"type":"subscribe_call","session_id":id})).await;
    let replay = event(&mut ws).await;
    assert_eq!(replay["signals"].as_array().unwrap().len(), 1);
    assert_eq!(replay["signals"][0]["payload"], "broadcast-barrier");
}
