//! Helper jobs and media metadata retain the Authority's account/resource boundary.
use axum::{
    body::{to_bytes, Body},
    http::{Method, Request, StatusCode},
    Router,
};
use serde_json::{json, Value};
use std::{path::Path, sync::Arc, time::Duration};
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

struct SocketClient {
    app: Router,
    sid: String,
    socket_id: String,
    events: Vec<Value>,
}

impl SocketClient {
    async fn transport(app: &Router, method: Method, path: &str, body: String) -> String {
        let response = tokio::time::timeout(
            Duration::from_secs(3),
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

    async fn namespace(app: &Router, token: &str) -> (Self, String) {
        let open = Self::transport(
            app,
            Method::GET,
            "/socket.io/?EIO=4&transport=polling",
            String::new(),
        )
        .await;
        let open: Value = serde_json::from_str(open.strip_prefix('0').unwrap()).unwrap();
        let mut client = Self {
            app: app.clone(),
            sid: open["sid"].as_str().unwrap().into(),
            socket_id: String::new(),
            events: vec![],
        };
        Self::transport(
            app,
            Method::POST,
            &client.path(),
            format!("40{}", json!({"token": token})),
        )
        .await;
        let result = Self::transport(app, Method::GET, &client.path(), String::new()).await;
        if let Some(payload) = result.strip_prefix("40") {
            let connected: Value = serde_json::from_str(payload).unwrap();
            client.socket_id = connected["sid"].as_str().unwrap().into();
        }
        (client, result)
    }

    async fn connect(app: &Router, token: &str) -> Self {
        let (mut client, result) = Self::namespace(app, token).await;
        assert!(result.starts_with("40"), "{result}");
        client
            .emit("join", json!("client-supplied identity is ignored"))
            .await;
        client.event("init").await;
        client
    }

    async fn emit(&self, name: &str, payload: Value) {
        Self::transport(
            &self.app,
            Method::POST,
            &self.path(),
            format!("42{}", json!([name, payload])),
        )
        .await;
    }

    async fn event(&mut self, name: &str) -> Value {
        for _ in 0..20 {
            if let Some(index) = self.events.iter().position(|event| event[0] == name) {
                return self.events.remove(index)[1].clone();
            }
            let result = Self::transport(&self.app, Method::GET, &self.path(), String::new()).await;
            for packet in result.split('\u{1e}') {
                if let Some(event) = packet.strip_prefix("42") {
                    self.events.push(serde_json::from_str(event).unwrap());
                } else if packet == "2" {
                    Self::transport(&self.app, Method::POST, &self.path(), "3".into()).await;
                }
            }
        }
        panic!("no {name} event");
    }

    async fn barrier(&mut self) {
        self.emit("get-role-definitions", json!(null)).await;
        self.event("role-definitions-updated").await;
    }
}

async fn server(path: &Path) -> Arc<AppState> {
    Arc::new(
        AppState::new(ServerConfig {
            host: "127.0.0.1".into(),
            port: 0,
            data_dir: path.to_string_lossy().into_owned(),
            uploads_dir: path.join("uploads").to_string_lossy().into_owned(),
            jwt_secret: "helper-resource-contract-secret".into(),
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

fn token(state: &AppState, id: u64, kind: &str, stepup: bool) -> String {
    let now = chrono::Utc::now().timestamp();
    jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &JwtClaims {
            sub: id.to_string(),
            username: format!("user-{id}"),
            is_guest: false,
            exp: now + 3600,
            iat: now,
            jti: uuid::Uuid::new_v4().to_string(),
            stepup,
            token_type: kind.into(),
        },
        &jsonwebtoken::EncodingKey::from_secret(state.config.jwt_secret.as_bytes()),
    )
    .unwrap()
}

async fn request(
    app: &Router,
    method: &str,
    path: &str,
    bearer: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if let Some(token) = bearer {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

async fn owner_voice_channel(state: &AppState) -> (u64, String) {
    let owner = state
        .wdb
        .create_user("owner", None, "registered-test-hash")
        .await
        .unwrap();
    state.wdb.claim_owner(owner).await.unwrap();
    *state.owner_user_id.write().await = Some(owner as i64);
    let channel = state
        .wdb
        .create_channel("voice", ChannelKind::Voice, owner, false)
        .await
        .unwrap();
    state
        .wdb
        .add_channel_member(&channel, owner, MemberRole::Member)
        .await
        .unwrap();
    (owner, channel)
}

async fn advertised_livekit_node(state: &AppState, app: &Router) -> String {
    use wabi_server::nodes::{
        JoinNodeRequest, NodeCapability, NodeHeartbeatRequest, NodeReachability,
    };
    let pairing = state
        .node_registry
        .create_pairing_token(
            "test media".into(),
            vec![NodeCapability::MediaRelay],
            std::time::Duration::from_secs(60),
        )
        .await
        .unwrap();
    let node = state
        .node_registry
        .join_with_token(JoinNodeRequest {
            token: pairing.token,
            display_name: "test media".into(),
            public_key: "fixture-key".into(),
            reachability: NodeReachability::OutboundOnly,
            endpoint: Some("https://media.example".into()),
        })
        .await
        .unwrap();
    state
        .node_registry
        .record_heartbeat(
            &node.node.node_id,
            &node.node_secret,
            NodeHeartbeatRequest::default(),
        )
        .await
        .unwrap();
    let advertisement = Request::builder()
        .method("POST")
        .uri(format!("/nodes/{}/media-advertisement", node.node.node_id))
        .header("x-wabi-node-secret", &node.node_secret)
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"provider":"livekit", "sfuEndpoint":"wss://media.example",
                "acceptingNewRooms":true})
            .to_string(),
        ))
        .unwrap();
    assert_eq!(
        app.clone().oneshot(advertisement).await.unwrap().status(),
        StatusCode::OK
    );
    node.node.node_id
}

async fn media_snapshot(state: &AppState) -> Value {
    let mut rooms = state.media_registry.list_rooms().await;
    rooms.sort_by(|a, b| a.room_id.cmp(&b.room_id));
    let mut jobs = state.job_queue.list_jobs(None).await;
    jobs.sort_by(|a, b| a.job_id.cmp(&b.job_id));
    let root = Path::new(&state.config.data_dir);
    json!({
        "rooms": rooms,
        "jobs": jobs,
        "roomFile": std::fs::read(root.join("media_rooms.json")).ok(),
        "jobFile": std::fs::read(root.join("job_queue.json")).ok(),
    })
}

#[tokio::test]
async fn job_administration_rejects_anonymous_member_wrong_purpose_and_revoked_tokens() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let owner = state
        .wdb
        .create_user("owner", None, "registered-test-hash")
        .await
        .unwrap();
    let member = state
        .wdb
        .create_user("member", None, "registered-test-hash")
        .await
        .unwrap();
    state.wdb.claim_owner(owner).await.unwrap();
    *state.owner_user_id.write().await = Some(owner as i64);
    let app = create_api_router(state.clone()).with_state(state.clone());
    let owner_token = token(&state, owner, "access", false);
    let member_token = token(&state, member, "access", false);
    let refresh = token(&state, owner, "refresh", false);
    let stepup = token(&state, owner, "access", true);
    let job = json!({"kind":"thumbnail", "payload":{"fileId":"fixture"}});
    for denied in [
        None,
        Some(member_token.as_str()),
        Some(refresh.as_str()),
        Some(stepup.as_str()),
    ] {
        for (method, path, body) in [
            ("POST", "/jobs", job.clone()),
            ("GET", "/jobs", Value::Null),
            ("POST", "/jobs/unknown/cancel", Value::Null),
        ] {
            let (status, _) = request(&app, method, path, denied, body).await;
            assert!(
                matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN),
                "{method} {path}: {status}"
            );
        }
    }
    assert!(state.job_queue.list_jobs(None).await.is_empty());
    assert_eq!(
        request(
            &app,
            "POST",
            "/jobs",
            Some(&owner_token),
            json!({"kind":"media_relay", "payload":{"operation":"mint_token",
                "externalRoomName":"foreign-room", "identity":"user:999"}})
        )
        .await
        .0,
        StatusCode::FORBIDDEN,
        "raw admin jobs must not bypass current media policy or the broker fence"
    );
    assert!(state.job_queue.list_jobs(None).await.is_empty());
    let (status, created) = request(&app, "POST", "/jobs", Some(&owner_token), job).await;
    assert_eq!(status, StatusCode::OK);
    let job_id = created["jobId"].as_str().unwrap();
    assert_eq!(
        request(&app, "GET", "/jobs", Some(&owner_token), Value::Null)
            .await
            .0,
        StatusCode::OK
    );
    let cancelled = request(
        &app,
        "POST",
        &format!("/jobs/{job_id}/cancel"),
        Some(&owner_token),
        Value::Null,
    )
    .await;
    assert_eq!(cancelled.0, StatusCode::OK);
    assert_eq!(cancelled.1["status"], "cancelled");
    state.revoke_user(owner as i64).await.unwrap();
    assert_eq!(
        request(&app, "GET", "/jobs", Some(&owner_token), Value::Null)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn media_room_and_endpoint_reads_require_current_channel_membership() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let member = state
        .wdb
        .create_user("member", None, "registered-test-hash")
        .await
        .unwrap();
    let outsider = state
        .wdb
        .create_user("outsider", None, "registered-test-hash")
        .await
        .unwrap();
    let owner = state
        .wdb
        .create_user("owner", None, "registered-test-hash")
        .await
        .unwrap();
    state.wdb.claim_owner(owner).await.unwrap();
    *state.owner_user_id.write().await = Some(owner as i64);
    let channel = state
        .wdb
        .create_channel("private room", ChannelKind::GroupDm, member, false)
        .await
        .unwrap();
    state
        .wdb
        .add_channel_member(&channel, member, MemberRole::Member)
        .await
        .unwrap();
    let room = state
        .media_registry
        .create_room(channel.clone(), 10)
        .await
        .unwrap();
    let app = create_api_router(state.clone()).with_state(state.clone());
    let member_token = token(&state, member, "access", false);
    for path in [
        format!("/media/rooms/{}", room.room_id),
        format!("/media/rooms/{}/endpoint", room.room_id),
    ] {
        for uid in [outsider, owner] {
            let outsider_token = token(&state, uid, "access", false);
            assert_eq!(
                request(&app, "GET", &path, Some(&outsider_token), Value::Null)
                    .await
                    .0,
                StatusCode::FORBIDDEN
            );
        }
        assert_eq!(
            request(&app, "GET", &path, Some(&member_token), Value::Null)
                .await
                .0,
            StatusCode::OK
        );
        state
            .wdb
            .remove_channel_member(&channel, member)
            .await
            .unwrap();
        assert_eq!(
            request(&app, "GET", &path, Some(&member_token), Value::Null)
                .await
                .0,
            StatusCode::FORBIDDEN
        );
        state
            .wdb
            .add_channel_member(&channel, member, MemberRole::Member)
            .await
            .unwrap();
    }
}

#[tokio::test]
#[cfg(feature = "experimental-livekit-broker")]
async fn delayed_media_credentials_recheck_revocation_and_moderation() {
    use wabi_server::{
        jobs::{ClaimJobRequest, JobKind, JobResultRequest},
        nodes::{JoinNodeRequest, NodeCapability, NodeReachability},
    };
    for change in [
        "none",
        "revoke",
        "mute",
        "deafen",
        "corrupt",
        "wrong_identity",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let state = server(dir.path()).await;
        let user = state
            .wdb
            .create_user("caller", None, "registered-test-hash")
            .await
            .unwrap();
        let channel = state
            .wdb
            .create_channel("voice", ChannelKind::Voice, user, false)
            .await
            .unwrap();
        state
            .wdb
            .add_channel_member(&channel, user, MemberRole::Member)
            .await
            .unwrap();
        let pairing = state
            .node_registry
            .create_pairing_token(
                "test media".into(),
                vec![NodeCapability::MediaRelay],
                std::time::Duration::from_secs(60),
            )
            .await
            .unwrap();
        let node = state
            .node_registry
            .join_with_token(JoinNodeRequest {
                token: pairing.token,
                display_name: "test media".into(),
                public_key: "fixture-key".into(),
                reachability: NodeReachability::OutboundOnly,
                endpoint: Some("https://media.example".into()),
            })
            .await
            .unwrap();
        let app = create_api_router(state.clone())
            .with_state(state.clone())
            .layer(wabi_server::socketio::create_socket_layer(state.clone()));
        let advertisement = Request::builder()
            .method("POST")
            .uri(format!("/nodes/{}/media-advertisement", node.node.node_id))
            .header("x-wabi-node-secret", &node.node_secret)
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"provider":"livekit","sfuEndpoint":"wss://media.example",
                "acceptingNewRooms":true})
                .to_string(),
            ))
            .unwrap();
        assert_eq!(
            app.clone().oneshot(advertisement).await.unwrap().status(),
            StatusCode::OK
        );
        let room = state
            .media_registry
            .create_room(channel.clone(), 10)
            .await
            .unwrap();
        state
            .media_registry
            .assign_room(
                &room.room_id,
                &node.node.node_id,
                Some("wss://media.example".into()),
            )
            .await
            .unwrap();
        state
            .media_registry
            .mark_active(
                &room.room_id,
                &node.node.node_id,
                "wss://media.example".into(),
            )
            .await
            .unwrap();
        let access = token(&state, user, "access", false);
        let mut client = SocketClient::connect(&app, &access).await;
        client
            .emit("voice-channel-join", json!({"channelId": channel}))
            .await;
        client.event("voice-channel-admitted").await;
        let socket_id = client.socket_id.clone();
        let pending = tokio::spawn(async move {
            request(
                &app,
                "POST",
                "/media/livekit/token",
                Some(&access),
                json!({"channelId":channel, "socketId":socket_id}),
            )
            .await
        });
        let job = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if let Some(job) = state
                    .job_queue
                    .list_jobs(None)
                    .await
                    .into_iter()
                    .find(|job| {
                        job.kind == JobKind::MediaRelay && job.payload["operation"] == "mint_token"
                    })
                {
                    break job;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let expected_identity = job.payload["identity"]
            .as_str()
            .expect("broker request has an exact device identity")
            .to_owned();
        assert!(expected_identity.starts_with(&format!("user:{user}:device:")));
        assert_ne!(expected_identity, format!("user:{user}"));
        assert_eq!(job.payload["grants"]["canPublish"], true);
        assert_eq!(job.payload["grants"]["canSubscribe"], true);
        match change {
            "revoke" => state.revoke_user(user as i64).await.unwrap(),
            "mute" => state
                .wdb
                .mute_user(&room.channel_id, user, user, i64::MAX)
                .await
                .unwrap(),
            "deafen" => state
                .wdb
                .deafen_user(&room.channel_id, user, user)
                .await
                .unwrap(),
            "corrupt" => {
                state
                    .wdb
                    .mute_user(&room.channel_id, user, user, i64::MAX)
                    .await
                    .unwrap();
                let projection = state.wdb.engine().projection_state();
                let mut key = None;
                projection.for_each("mutes", |stored, _| key = Some(stored.to_vec()));
                projection.insert(
                    "mutes",
                    key.expect("real mute command created a row"),
                    b"corrupt".to_vec(),
                    projection.applied_commit_seq(),
                );
            }
            _ => {}
        }
        let claimed = state
            .job_queue
            .claim_next(
                &state.node_registry,
                ClaimJobRequest {
                    node_id: node.node.node_id.clone(),
                    node_secret: node.node_secret.clone(),
                    capabilities: vec![NodeCapability::MediaRelay],
                },
            )
            .await
            .unwrap();
        assert_eq!(claimed.job_id, job.job_id);
        assert_eq!(claimed.payload["identity"], expected_identity);
        let result_identity = if change == "wrong_identity" {
            format!("user:{user}")
        } else {
            expected_identity.clone()
        };
        state
            .job_queue
            .report_result(
                &state.node_registry,
                &job.job_id,
                JobResultRequest {
                    node_id: node.node.node_id,
                    node_secret: node.node_secret,
                    success: true,
                    error_message: None,
                    result_payload: Some(
                        json!({"token":"fixture-media-token", "url":"wss://media.example",
                "roomName":room.external_room_name,"identity":result_identity}),
                    ),
                },
            )
            .await
            .unwrap();
        let (status, body) = pending.await.unwrap();
        if change == "none" {
            assert_eq!(status, StatusCode::OK);
            assert_eq!(body["token"], "fixture-media-token");
            assert_eq!(body["identity"], expected_identity);
            assert_eq!(body["stableUserId"], format!("user-{user}"));
            assert_eq!(body["canPublish"], true);
            assert_eq!(body["canPublishMicrophone"], true);
            assert_eq!(body["canSubscribe"], true);
        } else {
            let expected = if matches!(change, "corrupt" | "wrong_identity") {
                StatusCode::INTERNAL_SERVER_ERROR
            } else {
                StatusCode::FORBIDDEN
            };
            assert_eq!(status, expected, "change={change}");
            assert!(body.get("token").is_none());
        }
    }
}

#[tokio::test]
async fn job_submission_rejects_a_token_revoked_while_its_body_is_pending() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let owner = state
        .wdb
        .create_user("owner", None, "registered-test-hash")
        .await
        .unwrap();
    state.wdb.claim_owner(owner).await.unwrap();
    *state.owner_user_id.write().await = Some(owner as i64);
    let app = create_api_router(state.clone()).with_state(state.clone());
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (body_tx, body_rx) = tokio::sync::oneshot::channel::<Value>();
    let stream = futures::stream::once(async move {
        let _ = started_tx.send(());
        Ok::<axum::body::Bytes, std::io::Error>(axum::body::Bytes::from(
            body_rx.await.unwrap().to_string(),
        ))
    });
    let req = Request::builder()
        .method("POST")
        .uri("/jobs")
        .header(
            "authorization",
            format!("Bearer {}", token(&state, owner, "access", false)),
        )
        .header("content-type", "application/json")
        .body(Body::from_stream(stream))
        .unwrap();
    let pending = tokio::spawn(async move { app.oneshot(req).await.unwrap().status() });
    tokio::time::timeout(std::time::Duration::from_secs(5), started_rx)
        .await
        .unwrap()
        .unwrap();
    state.revoke_user(owner as i64).await.unwrap();
    body_tx
        .send(json!({"kind":"thumbnail","payload":{}}))
        .unwrap();
    assert_eq!(pending.await.unwrap(), StatusCode::UNAUTHORIZED);
    assert!(state.job_queue.list_jobs(None).await.is_empty());
}

#[tokio::test]
async fn media_create_and_assign_recheck_original_credential_after_body_wait() {
    for assigning in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let state = server(dir.path()).await;
        let (owner, channel) = owner_voice_channel(&state).await;
        let app = create_api_router(state.clone()).with_state(state.clone());
        let node_id = advertised_livekit_node(&state, &app).await;
        let (path, body) = if assigning {
            let room = state
                .media_registry
                .create_room(channel.clone(), 10)
                .await
                .unwrap();
            (
                format!("/media/rooms/{}/assign", room.room_id),
                json!({"nodeId":node_id, "sfuEndpoint":"wss://media.example"}),
            )
        } else {
            (
                "/media/rooms".into(),
                json!({"channelId":channel, "maxParticipants":10}),
            )
        };
        let before = media_snapshot(&state).await;
        let access = token(&state, owner, "access", false);
        let claims = wabi_server::auth_extractor::decode_token(&access, &state.config.jwt_secret)
            .await
            .unwrap();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (body_tx, body_rx) = tokio::sync::oneshot::channel::<Value>();
        let stream = futures::stream::once(async move {
            let _ = started_tx.send(());
            Ok::<axum::body::Bytes, std::io::Error>(axum::body::Bytes::from(
                body_rx.await.unwrap().to_string(),
            ))
        });
        let req = Request::builder()
            .method("POST")
            .uri(&path)
            .header("authorization", format!("Bearer {access}"))
            .header("content-type", "application/json")
            .body(Body::from_stream(stream))
            .unwrap();
        let pending_app = app.clone();
        let pending = tokio::spawn(async move { pending_app.oneshot(req).await.unwrap() });
        tokio::time::timeout(std::time::Duration::from_secs(5), started_rx)
            .await
            .unwrap()
            .unwrap();
        // Deny exactly the credential extracted before Json began buffering;
        // the account and a different valid owner credential remain usable.
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            state.revoke_token_with_exp(claims.jti, claims.exp),
        )
        .await
        .unwrap()
        .unwrap();
        let denied_seq = state.wdb.engine().projection_state().applied_commit_seq();
        body_tx.send(body.clone()).unwrap();
        let response = tokio::time::timeout(std::time::Duration::from_secs(5), pending)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "{path}");
        assert_eq!(media_snapshot(&state).await, before, "{path} side effects");
        assert_eq!(
            state.wdb.engine().projection_state().applied_commit_seq(),
            denied_seq,
            "{path} added a durable write after credential denial"
        );

        let healthy = token(&state, owner, "access", false);
        let (status, accepted) = request(&app, "POST", &path, Some(&healthy), body).await;
        assert_eq!(status, StatusCode::OK, "healthy owner {path}: {accepted}");
        let room = state
            .media_registry
            .find_by_channel(&channel)
            .await
            .unwrap();
        assert_eq!(accepted["room"]["roomId"], room.room_id);
        assert_eq!(room.assigned_node_id.as_deref(), Some(node_id.as_str()));
        assert_eq!(room.status, wabi_server::media::MediaRoomStatus::Assigned);
        let jobs = state.job_queue.list_jobs(None).await;
        assert_eq!(jobs.len(), 1, "healthy owner must queue room activation");
        assert_eq!(jobs[0].kind, wabi_server::jobs::JobKind::MediaRelay);
        assert_eq!(jobs[0].payload["operation"], "activate_room");
        assert_eq!(jobs[0].payload["assignedNodeId"], node_id);
        assert_eq!(jobs[0].payload["roomId"], room.room_id);
    }
}

#[tokio::test]
async fn waiting_media_reads_and_bodyless_close_recheck_original_credential() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (owner, channel) = owner_voice_channel(&state).await;
    let app = create_api_router(state.clone()).with_state(state.clone());
    let node_id = advertised_livekit_node(&state, &app).await;
    let room = state
        .media_registry
        .create_room(channel.clone(), 10)
        .await
        .unwrap();
    state
        .media_registry
        .assign_room(&room.room_id, &node_id, Some("wss://media.example".into()))
        .await
        .unwrap();
    state
        .media_registry
        .mark_active(&room.room_id, &node_id, "wss://media.example".into())
        .await
        .unwrap();
    let healthy = token(&state, owner, "access", false);
    let before = media_snapshot(&state).await;
    for (method, path) in [
        ("GET", "/media/rooms".into()),
        ("GET", format!("/media/rooms/{}", room.room_id)),
        ("GET", format!("/media/rooms/by-channel/{channel}")),
        ("GET", format!("/media/rooms/{}/endpoint", room.room_id)),
        ("POST", format!("/media/rooms/{}/close", room.room_id)),
    ] {
        if method == "GET" {
            assert_eq!(
                request(&app, method, &path, Some(&healthy), Value::Null)
                    .await
                    .0,
                StatusCode::OK,
                "healthy owner {path}"
            );
        }
        let access = token(&state, owner, "access", false);
        let claims = wabi_server::auth_extractor::decode_token(&access, &state.config.jwt_secret)
            .await
            .unwrap();
        let membership = state.membership_gate.write().await;
        let mut pending = Box::pin(
            app.clone().oneshot(
                Request::builder()
                    .method(method)
                    .uri(&path)
                    .header("authorization", format!("Bearer {access}"))
                    .body(Body::empty())
                    .unwrap(),
            ),
        );
        assert!(
            futures::poll!(pending.as_mut()).is_pending(),
            "{path} did not wait for membership admission"
        );
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            state.revoke_token_with_exp(claims.jti, claims.exp),
        )
        .await
        .unwrap()
        .unwrap();
        let denied_seq = state.wdb.engine().projection_state().applied_commit_seq();
        drop(membership);
        let response = tokio::time::timeout(std::time::Duration::from_secs(5), pending)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "{method} {path}");
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        assert_eq!(
            bytes.as_ref(),
            b"not authorized for media action",
            "{path} disclosed media metadata instead of the generic denial"
        );
        assert_eq!(media_snapshot(&state).await, before, "{path} side effects");
        assert_eq!(
            state.wdb.engine().projection_state().applied_commit_seq(),
            denied_seq
        );
    }
    let (status, closed) = request(
        &app,
        "POST",
        &format!("/media/rooms/{}/close", room.room_id),
        Some(&healthy),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "healthy owner close: {closed}");
    assert_eq!(
        state
            .media_registry
            .get_room(&room.room_id)
            .await
            .unwrap()
            .status,
        wabi_server::media::MediaRoomStatus::Closed
    );
    assert!(state.job_queue.list_jobs(None).await.is_empty());
}

#[tokio::test]
async fn corrupt_durable_mute_queues_deny_all_for_an_active_livekit_participant() {
    use wabi_server::api::media_permissions::refresh_participant_permissions;
    use wabidb::projections::voice_restrictions;

    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (user, channel) = owner_voice_channel(&state).await;
    let app = create_api_router(state.clone()).with_state(state.clone());
    let node_id = advertised_livekit_node(&state, &app).await;
    let room = state
        .media_registry
        .create_room(channel.clone(), 10)
        .await
        .unwrap();
    state
        .media_registry
        .assign_room(&room.room_id, &node_id, Some("wss://media.example".into()))
        .await
        .unwrap();
    state
        .media_registry
        .mark_active(&room.room_id, &node_id, "wss://media.example".into())
        .await
        .unwrap();
    let identity = format!("user:{user}");

    for restriction in ["healthy", "muted", "deafened", "corrupt"] {
        if restriction == "muted" {
            state
                .wdb
                .mute_user(&channel, user, user, i64::MAX)
                .await
                .unwrap();
            assert!(state.wdb.is_user_muted(&channel, user).await.unwrap());
        } else if restriction == "deafened" {
            state.wdb.deafen_user(&channel, user, user).await.unwrap();
            assert!(state.wdb.is_user_deafened(&channel, user).await.unwrap());
        } else if restriction == "corrupt" {
            // Corrupt only the real durable command's exact (channel, user) row.
            let projection = state.wdb.engine().projection_state();
            let key = voice_restrictions::encode_key(&channel, user);
            let bytes = projection
                .get(voice_restrictions::MUTES, &key)
                .expect("durable mute projection row");
            let row = voice_restrictions::decode_mute(&bytes).unwrap();
            assert_eq!(row.channel_id, channel);
            assert_eq!(row.user_id, user);
            assert_eq!(row.until_micros, i64::MAX);
            projection.insert(
                voice_restrictions::MUTES,
                key,
                b"corrupt".to_vec(),
                projection.applied_commit_seq(),
            );
            assert!(state.wdb.is_user_muted(&channel, user).await.is_err());
        }
        let before = state.job_queue.list_jobs(None).await;
        let seq = state.wdb.engine().projection_state().applied_commit_seq();
        let result = refresh_participant_permissions(&state, &channel, user as i64).await;
        if restriction == "corrupt" {
            assert!(result
                .unwrap_err()
                .contains("deny-all permission update was queued"));
        } else {
            result.unwrap();
        }
        let jobs = state.job_queue.list_jobs(None).await;
        assert_eq!(
            jobs.len(),
            before.len() + 1,
            "{restriction} must queue one update"
        );
        let new: Vec<_> = jobs
            .iter()
            .filter(|job| !before.iter().any(|old| old.job_id == job.job_id))
            .collect();
        assert_eq!(new.len(), 1);
        let job = new[0];
        assert_eq!(job.kind, wabi_server::jobs::JobKind::MediaRelay);
        assert_eq!(job.payload["operation"], "update_participant_permissions");
        assert_eq!(job.payload["roomId"], room.room_id);
        assert_eq!(job.payload["externalRoomName"], room.external_room_name);
        assert_eq!(job.payload["tenantNamespace"], room.tenant_namespace);
        assert_eq!(job.payload["channelId"], channel);
        assert_eq!(job.payload["assignedNodeId"], node_id);
        assert_eq!(job.payload["identity"], identity);
        assert_eq!(
            job.payload["grants"]["canPublish"],
            restriction == "healthy"
        );
        assert_eq!(
            job.payload["grants"]["canSubscribe"],
            matches!(restriction, "healthy" | "muted")
        );
        assert_eq!(
            job.payload["grants"]["canPublishData"],
            restriction != "corrupt"
        );
        let sources = match restriction {
            "healthy" => json!(["microphone", "camera", "screen_share", "screen_share_audio"]),
            _ => json!([]),
        };
        assert_eq!(job.payload["grants"]["canPublishSources"], sources);
        assert_eq!(
            state.wdb.engine().projection_state().applied_commit_seq(),
            seq
        );
    }
}

#[tokio::test]
#[cfg(not(feature = "experimental-livekit-broker"))]
async fn livekit_token_broker_is_off_by_default_even_for_a_valid_owner_and_media_node() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (owner, channel) = owner_voice_channel(&state).await;
    let app = create_api_router(state.clone()).with_state(state.clone());
    advertised_livekit_node(&state, &app).await;
    let before = media_snapshot(&state).await;
    let seq = state.wdb.engine().projection_state().applied_commit_seq();
    let access = token(&state, owner, "access", false);
    let (status, _) = request(
        &app,
        "POST",
        "/media/livekit/token",
        Some(&access),
        json!({"channelId":channel}),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(media_snapshot(&state).await, before);
    assert_eq!(
        state.wdb.engine().projection_state().applied_commit_seq(),
        seq
    );
    // Ordinary authorized media metadata remains available in a default build.
    assert_eq!(
        request(&app, "GET", "/media/rooms", Some(&access), Value::Null)
            .await
            .0,
        StatusCode::OK
    );
}
