//! Whiteboard policy ownership and live-edit boundaries through real REST/Socket.IO.
use std::{path::Path, sync::Arc, time::Duration};

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
            jwt_secret: "realtime-security-test-only".into(),
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

async fn accounts(state: &AppState) -> (u64, u64, u64) {
    let member = state
        .wdb
        .create_user("member", None, "registered-test-hash")
        .await
        .unwrap();
    let owner = state
        .wdb
        .create_user("owner", None, "registered-test-hash")
        .await
        .unwrap();
    let guest = state.wdb.create_user("guest", None, "").await.unwrap();
    state.wdb.claim_owner(owner).await.unwrap();
    *state.owner_user_id.write().await = Some(owner as i64);
    (member, owner, guest)
}

fn claims(uid: u64, guest: bool) -> JwtClaims {
    let now = chrono::Utc::now().timestamp();
    JwtClaims {
        sub: uid.to_string(),
        username: format!("account-{uid}"),
        is_guest: guest,
        exp: now + 3600,
        iat: now,
        jti: uuid::Uuid::new_v4().to_string(),
        stepup: false,
        token_type: "access".into(),
    }
}

fn jwt(state: &AppState, claims: &JwtClaims) -> String {
    jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        claims,
        &jsonwebtoken::EncodingKey::from_secret(state.config.jwt_secret.as_bytes()),
    )
    .unwrap()
}

fn app(state: &Arc<AppState>) -> Router {
    create_api_router(state.clone())
        .with_state(state.clone())
        .layer(wabi_server::socketio::create_socket_layer(state.clone()))
}

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

async fn unique_channel(state: &AppState, name: &str, kind: ChannelKind, owner: u64) -> String {
    // Whiteboard versions are process-wide. Independent AppStates start their
    // commit sequences at the same value, so create_channel's sequence-derived
    // IDs let parallel fixtures overwrite each other's version entries.
    // A real durable own-stream creation keeps the fixture identity isolated.
    let channel_id = format!("whiteboard-fixture-{}", uuid::Uuid::new_v4());
    let mut channel = wabidb::domain::Channel::new(&channel_id, name, owner);
    channel.channel_kind = kind;
    let engine = state.wdb.engine();
    engine.get_or_create_stream_key(&channel_id).await.unwrap();
    engine
        .run_command(wabidb::sequencer::types::CommandCommit {
            caller_user_id: owner,
            caller_device_id: "fixture".into(),
            command_name: "unique_whiteboard_channel_fixture".into(),
            idempotency_key: None,
            room_owner_precondition: None,
            essential: true,
            response_tx: tokio::sync::oneshot::channel().0,
            events: vec![wabidb::sequencer::types::EventToWrite {
                stream_id: channel_id.clone(),
                event_type: "channel_created".into(),
                stream_kind: 6,
                record_kind: wabidb::format::record::RecordKind::Event,
                plaintext: serde_json::to_vec(&channel).unwrap(),
            }],
        })
        .await
        .unwrap();
    let persisted = state.wdb.get_channel(&channel_id).await.unwrap().unwrap();
    assert_eq!(persisted.channel_id, channel_id);
    assert_eq!(persisted.channel_kind, kind);
    channel_id
}

async fn board(state: &AppState, owner: u64, members: &[u64]) -> String {
    let channel = unique_channel(state, "policy board", ChannelKind::GroupDm, owner).await;
    for &member in members {
        state
            .wdb
            .add_channel_member(&channel, member, MemberRole::Member)
            .await
            .unwrap();
    }
    format!("channel:{channel}")
}

async fn set_role(state: &AppState, uid: u64, name: &str) {
    state
        .wdb
        .ingest_event(
            "rbac",
            "assign_role",
            &json!({
                "userId":uid, "workspaceId":"default-workspace", "role":name, "assignedBy":uid
            }),
        )
        .await
        .unwrap();
}

async fn saved(state: &AppState, board: &str) -> Value {
    let raw = state.wdb.get_whiteboard_doc(board).await.unwrap().unwrap();
    serde_json::from_str(&raw).unwrap()
}

async fn put_document(
    app: &Router,
    state: &AppState,
    uid: u64,
    board: &str,
    doc: Value,
) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri(format!("/whiteboard/boards/{board}/document"))
                .header(
                    "authorization",
                    format!("Bearer {}", jwt(state, &claims(uid, false))),
                )
                .header("content-type", "application/json")
                .body(Body::from(doc.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn policy(role: &str) -> Value {
    json!({"access":"open", "writeAccess":"anyone", "drawRole":role})
}

#[tokio::test]
async fn rest_whiteboard_policy_requires_owner_and_enforces_current_role_rank() {
    let directory = tempfile::tempdir().unwrap();
    let state = server(directory.path()).await;
    let (member, owner, _) = accounts(&state).await;
    let moderator = state
        .wdb
        .create_user("moderator", None, "registered-test-hash")
        .await
        .unwrap();
    let admin = state
        .wdb
        .create_user("admin", None, "registered-test-hash")
        .await
        .unwrap();
    set_role(&state, moderator, "Moderator").await;
    set_role(&state, admin, "Admin").await;
    let board = board(&state, owner, &[owner, member, moderator, admin]).await;
    let app = app(&state);

    // An absent policy deliberately retains legacy participant drawing.
    assert_eq!(
        put_document(
            &app,
            &state,
            member,
            &board,
            json!({"version":0,"elements":[{"id":"legacy-drawing"}]})
        )
        .await
        .0,
        StatusCode::OK
    );
    for uid in [member, moderator, admin] {
        let before = saved(&state, &board).await;
        let seq = state.wdb.engine().projection_state().applied_commit_seq();
        let mut changed = before.clone();
        changed["policy"] = policy("owner");
        assert_eq!(
            put_document(&app, &state, uid, &board, changed).await.0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(saved(&state, &board).await, before);
        assert_eq!(
            state.wdb.engine().projection_state().applied_commit_seq(),
            seq
        );
    }

    for (draw_role, minimum) in [
        ("participants", 1),
        ("moderators", 2),
        ("admins", 3),
        ("owner", 4),
    ] {
        let mut next = saved(&state, &board).await;
        next["policy"] = policy(draw_role);
        let (status, response) = put_document(&app, &state, owner, &board, next).await;
        assert_eq!(status, StatusCode::OK, "owner sets {draw_role}: {response}");
        for (uid, rank) in [(member, 1), (moderator, 2), (admin, 3), (owner, 4)] {
            let before = saved(&state, &board).await;
            let mut drawing = before.clone();
            drawing["elements"] = json!([{"id":format!("drawing-{uid}-{draw_role}")}]);
            let seq = state.wdb.engine().projection_state().applied_commit_seq();
            let (status, response) = put_document(&app, &state, uid, &board, drawing).await;
            if rank >= minimum {
                assert_eq!(
                    status,
                    StatusCode::OK,
                    "{draw_role} rank {rank}: {response}"
                );
                assert_eq!(saved(&state, &board).await["policy"], policy(draw_role));
            } else {
                assert_eq!(status, StatusCode::FORBIDDEN, "{draw_role} rank {rank}");
                assert_eq!(saved(&state, &board).await, before);
                assert_eq!(
                    state.wdb.engine().projection_state().applied_commit_seq(),
                    seq
                );
            }
        }
    }
}

#[tokio::test]
async fn malformed_whiteboard_policies_and_live_replace_are_denied_before_publication() {
    let directory = tempfile::tempdir().unwrap();
    let state = server(directory.path()).await;
    let (member, owner, _) = accounts(&state).await;
    let board = board(&state, owner, &[owner, member]).await;
    let app = app(&state);
    assert_eq!(
        put_document(
            &app,
            &state,
            member,
            &board,
            json!({"version":0,"elements":[{"id":"legacy"}]})
        )
        .await
        .0,
        StatusCode::OK
    );
    let mut participant = SocketClient::connect(&app, &jwt(&state, &claims(member, false))).await;
    let mut owner_socket = SocketClient::connect(&app, &jwt(&state, &claims(owner, false))).await;
    for socket in [&mut participant, &mut owner_socket] {
        socket
            .emit("whiteboard:join", json!({"boardId":board}))
            .await;
        assert_eq!(
            socket.event("whiteboard:joined").await["capability"]["write"],
            true
        );
    }
    participant
        .emit(
            "whiteboard:patch",
            json!({"boardId":board, "patch":{
                "op":"update", "id":"legacy", "changes":{"x":10}, "patchId":"normal-drawing"
            }}),
        )
        .await;
    assert_eq!(
        participant.event("whiteboard:ack").await["patchId"],
        "normal-drawing"
    );
    assert_eq!(
        owner_socket.event("whiteboard:patch").await["patch"]["patchId"],
        "normal-drawing"
    );

    for sender_is_owner in [false, true] {
        let before = saved(&state, &board).await;
        let seq = state.wdb.engine().projection_state().applied_commit_seq();
        let (sender, observer) = if sender_is_owner {
            (&mut owner_socket, &mut participant)
        } else {
            (&mut participant, &mut owner_socket)
        };
        sender
            .emit(
                "whiteboard:patch",
                json!({"boardId":board,"patch":{
                    "op":"replace", "patchId":"forbidden-replace",
                    "document":{"version":before["version"], "policy":policy("owner"),"elements":[]}
                }}),
            )
            .await;
        let error = sender.event("whiteboard:error").await;
        assert_eq!(error["boardId"], board);
        observer.barrier().await;
        sender.barrier().await;
        assert!(!observer
            .events
            .iter()
            .any(|event| event[0] == "whiteboard:patch"
                && event[1]["patch"]["patchId"] == "forbidden-replace"));
        assert!(!sender.events.iter().any(
            |event| event[0] == "whiteboard:ack" && event[1]["patchId"] == "forbidden-replace"
        ));
        assert_eq!(saved(&state, &board).await, before);
        assert_eq!(
            state.wdb.engine().projection_state().applied_commit_seq(),
            seq
        );
    }

    for malformed in [
        Value::Null,
        json!([]),
        json!("open"),
        json!({"drawRole":null}),
        json!({"drawRole":17}),
        json!({"drawRole":{}}),
        json!({"drawRole":"unknown"}),
        json!({"access":null}),
        json!({"access":true}),
        json!({"access":"unknown"}),
        json!({"writeAccess":null}),
        json!({"writeAccess":[]}),
        json!({"writeAccess":"unknown"}),
    ] {
        let before = saved(&state, &board).await;
        let seq = state.wdb.engine().projection_state().applied_commit_seq();
        for uid in [member, owner] {
            let mut incoming = before.clone();
            incoming["policy"] = malformed.clone();
            let (status, _) = put_document(&app, &state, uid, &board, incoming).await;
            assert_eq!(
                status,
                StatusCode::FORBIDDEN,
                "incoming policy {malformed} uid {uid}"
            );
        }
        assert_eq!(saved(&state, &board).await, before);
        assert_eq!(
            state.wdb.engine().projection_state().applied_commit_seq(),
            seq
        );

        // This is a stored legacy/UI record, created through a real durable
        // command; current clients may never interpret present malformed policy as open.
        let mut stored = before.clone();
        stored["policy"] = malformed.clone();
        state
            .wdb
            .put_whiteboard_doc(&board, &stored.to_string())
            .await
            .unwrap();
        let denied_seq = state.wdb.engine().projection_state().applied_commit_seq();
        let (status, _) = put_document(&app, &state, member, &board, stored.clone()).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "stored policy {malformed}");
        participant
            .emit(
                "whiteboard:snapshot",
                json!({"boardId":board,"document":stored}),
            )
            .await;
        participant.event("whiteboard:error").await;
        participant.emit("whiteboard:patch", json!({"boardId":board,"patch":{
            "op":"update","id":"legacy","changes":{"x":99},"patchId":"malformed-policy-patch"
        }})).await;
        participant.event("whiteboard:error").await;
        owner_socket.barrier().await;
        assert!(!owner_socket
            .events
            .iter()
            .any(|event| event[0] == "whiteboard:snapshot"
                || (event[0] == "whiteboard:patch"
                    && event[1]["patch"]["patchId"] == "malformed-policy-patch")));
        assert_eq!(saved(&state, &board).await["policy"], malformed);
        assert_eq!(
            state.wdb.engine().projection_state().applied_commit_seq(),
            denied_seq
        );

        let mut recovery = saved(&state, &board).await;
        recovery["policy"] = policy("participants");
        assert_eq!(
            put_document(&app, &state, owner, &board, recovery).await.0,
            StatusCode::OK,
            "owner recovers malformed stored policy {malformed}"
        );
    }
    participant
        .emit(
            "whiteboard:patch",
            json!({"boardId":board,"patch":{
                "op":"update","id":"legacy","changes":{"x":42},"patchId":"recovered-drawing"
            }}),
        )
        .await;
    assert_eq!(
        participant.event("whiteboard:ack").await["patchId"],
        "recovered-drawing"
    );
    assert_eq!(
        owner_socket.event("whiteboard:patch").await["patch"]["patchId"],
        "recovered-drawing"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn queued_owner_restriction_orders_before_participant_rest_snapshot_and_live_patch() {
    use wabi_server::api::whiteboard_policy::write_gate;

    let directory = tempfile::tempdir().unwrap();
    let state = server(directory.path()).await;
    let (member, owner, _) = accounts(&state).await;
    let board = board(&state, owner, &[owner, member]).await;
    let app = app(&state);
    assert_eq!(
        put_document(
            &app,
            &state,
            member,
            &board,
            json!({"version":0,"elements":[{"id":"retained-drawing"}]})
        )
        .await
        .0,
        StatusCode::OK
    );
    let mut participant = SocketClient::connect(&app, &jwt(&state, &claims(member, false))).await;
    let mut observer = SocketClient::connect(&app, &jwt(&state, &claims(owner, false))).await;
    for socket in [&mut participant, &mut observer] {
        socket
            .emit("whiteboard:join", json!({"boardId":board}))
            .await;
        assert_eq!(
            socket.event("whiteboard:joined").await["capability"]["write"],
            true
        );
    }
    let before = saved(&state, &board).await;
    let seq = state.wdb.engine().projection_state().applied_commit_seq();
    let gate = write_gate(&state, &board).lock().await;
    let mut restriction = before.clone();
    restriction["policy"] = policy("owner");
    restriction["canary"] = json!("owner accepted restriction");
    let mut owner_write = Box::pin(put_document(&app, &state, owner, &board, restriction));
    assert!(futures::poll!(owner_write.as_mut()).is_pending());
    // Let the owner-owned worker poll to the held gate before any later writer
    // is dispatched. The current-thread runtime and FIFO mutex preserve order.
    assert!(
        tokio::time::timeout(Duration::from_millis(25), owner_write.as_mut())
            .await
            .is_err()
    );

    let mut stale = before.clone();
    stale["elements"] = json!([{"id":"must-never-publish"}]);
    let mut participant_write = Box::pin(put_document(&app, &state, member, &board, stale.clone()));
    assert!(futures::poll!(participant_write.as_mut()).is_pending());
    assert!(
        tokio::time::timeout(Duration::from_millis(25), participant_write.as_mut())
            .await
            .is_err()
    );
    participant
        .emit(
            "whiteboard:snapshot",
            json!({"boardId":board,"document":stale}),
        )
        .await;
    participant
        .emit(
            "whiteboard:patch",
            json!({"boardId":board,"patch":{
                "op":"update", "id":"retained-drawing", "changes":{"x":900},
                "patchId":"stale-open-policy-patch"
            }}),
        )
        .await;
    participant.barrier().await;
    assert_eq!(saved(&state, &board).await, before);
    assert_eq!(
        state.wdb.engine().projection_state().applied_commit_seq(),
        seq
    );
    assert!(!participant
        .events
        .iter()
        .any(|event| event[0] == "whiteboard:ack"));
    drop(gate);

    let (status, response) = tokio::time::timeout(Duration::from_secs(3), owner_write)
        .await
        .unwrap();
    assert_eq!(status, StatusCode::OK, "owner restriction: {response}");
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(3), participant_write)
            .await
            .unwrap()
            .0,
        StatusCode::FORBIDDEN
    );
    for _ in 0..2 {
        let error = participant.event("whiteboard:error").await;
        assert_eq!(error["boardId"], board);
        assert_eq!(error["code"], "READ_ONLY");
    }
    participant.barrier().await;
    observer.barrier().await;
    assert!(!participant
        .events
        .iter()
        .any(|event| event[0] == "whiteboard:ack"));
    assert!(!observer
        .events
        .iter()
        .any(|event| event[0] == "whiteboard:snapshot"
            || (event[0] == "whiteboard:patch"
                && event[1]["patch"]["patchId"] == "stale-open-policy-patch")));
    let current = saved(&state, &board).await;
    assert_eq!(current["policy"], policy("owner"));
    assert_eq!(current["elements"], before["elements"]);
    assert_eq!(current["canary"], "owner accepted restriction");
    assert_eq!(
        current["version"].as_u64().unwrap(),
        before["version"].as_u64().unwrap() + 1
    );
    assert_eq!(
        state.wdb.engine().projection_state().applied_commit_seq(),
        seq + 1
    );

    observer.emit("whiteboard:patch", json!({"boardId":board,"patch":{
        "op":"update", "id":"retained-drawing", "changes":{"x":1}, "patchId":"healthy-owner-patch"
    }})).await;
    assert_eq!(
        observer.event("whiteboard:ack").await["patchId"],
        "healthy-owner-patch"
    );
    assert_eq!(
        participant.event("whiteboard:patch").await["patch"]["patchId"],
        "healthy-owner-patch"
    );
}

async fn publish_board_updates(
    state: &AppState,
    sender: &mut SocketClient,
    retained: &mut SocketClient,
    board: &str,
    canary: &str,
) {
    let version = state
        .wdb
        .get_whiteboard_doc(board)
        .await
        .unwrap()
        .map(|raw| {
            serde_json::from_str::<Value>(&raw).unwrap()["version"]
                .as_u64()
                .unwrap()
        })
        .unwrap_or(0);
    sender
        .emit(
            "whiteboard:snapshot",
            json!({"boardId":board,"document":{
                "version":version, "policy":policy("participants"),
                "elements":[{"id":canary}], "canary":canary
            }}),
        )
        .await;
    let ack = sender.event("whiteboard:ack").await;
    assert_eq!(ack["boardId"], board);
    assert_eq!(ack["version"], version + 1);
    let snapshot = retained.event("whiteboard:snapshot").await;
    assert_eq!(snapshot["boardId"], board);
    assert_eq!(snapshot["document"]["canary"], canary);
    sender
        .emit(
            "whiteboard:patch",
            json!({"boardId":board,"patch":{
                "op":"update", "id":canary, "changes":{"x":42}, "patchId":canary
            }}),
        )
        .await;
    assert_eq!(sender.event("whiteboard:ack").await["patchId"], canary);
    let patch = retained.event("whiteboard:patch").await;
    assert_eq!(patch["boardId"], board);
    assert_eq!(patch["patch"]["patchId"], canary);
    sender
        .emit(
            "whiteboard:cursor",
            json!({"boardId":board,"cursor":{
                "x":9,"y":11,"canary":canary
            }}),
        )
        .await;
    let cursor = retained.event("whiteboard:cursor").await;
    assert_eq!(cursor["boardId"], board);
    assert_eq!(cursor["cursor"]["canary"], canary);
}

async fn assert_board_updates_received(socket: &mut SocketClient, board: &str, canary: &str) {
    let snapshot = socket.event("whiteboard:snapshot").await;
    assert_eq!(snapshot["boardId"], board);
    assert_eq!(snapshot["document"]["canary"], canary);
    let patch = socket.event("whiteboard:patch").await;
    assert_eq!(patch["boardId"], board);
    assert_eq!(patch["patch"]["patchId"], canary);
    let cursor = socket.event("whiteboard:cursor").await;
    assert_eq!(cursor["boardId"], board);
    assert_eq!(cursor["cursor"]["canary"], canary);
}

async fn assert_no_board_updates(socket: &mut SocketClient, boards: &[String]) {
    // This unrelated authorized response is a delivery barrier. The removed
    // socket stays idle through publication and remains a healthy account.
    socket.barrier().await;
    assert!(
        !socket.events.iter().any(|event| {
            matches!(
                event[0].as_str(),
                Some("whiteboard:snapshot" | "whiteboard:patch" | "whiteboard:cursor")
            ) && boards
                .iter()
                .any(|board| event[1]["boardId"] == board.as_str())
        }),
        "removed idle socket received whiteboard content: {:?}",
        socket.events
    );
}

#[tokio::test]
async fn tightened_channel_role_gate_evicts_idle_standard_and_cad_whiteboard_receivers() {
    let directory = tempfile::tempdir().unwrap();
    let state = server(directory.path()).await;
    let (member, owner, _) = accounts(&state).await;
    let retained = state
        .wdb
        .create_user("allowed admin", None, "registered-test-hash")
        .await
        .unwrap();
    set_role(&state, retained, "Admin").await;
    let channel = unique_channel(&state, "role gated drawing", ChannelKind::Text, owner).await;
    for uid in [owner, member, retained] {
        state
            .wdb
            .add_channel_member(&channel, uid, MemberRole::Member)
            .await
            .unwrap();
    }
    let boards = [
        format!("channel:{channel}"),
        format!("cad-review:{channel}:asset-role-test"),
    ];
    let app = app(&state);
    let mut author = SocketClient::connect(&app, &jwt(&state, &claims(owner, false))).await;
    let mut allowed = SocketClient::connect(&app, &jwt(&state, &claims(retained, false))).await;
    let mut removed = SocketClient::connect(&app, &jwt(&state, &claims(member, false))).await;
    for (index, board) in boards.iter().enumerate() {
        for socket in [&mut author, &mut allowed, &mut removed] {
            socket
                .emit("whiteboard:join", json!({"boardId":board}))
                .await;
            assert_eq!(
                socket.event("whiteboard:joined").await["boardId"],
                board.as_str()
            );
        }
        let canary = format!("before-role-gate-{index}");
        publish_board_updates(&state, &mut author, &mut allowed, board, &canary).await;
        assert_board_updates_received(&mut removed, board, &canary).await;
    }
    removed.barrier().await;
    removed.events.clear();
    let response = app
        .clone()
        .oneshot(
            Request::put(format!("/server-center/channel-gates/{channel}"))
                .header(
                    "authorization",
                    format!("Bearer {}", jwt(&state, &claims(owner, false))),
                )
                .header("content-type", "application/json")
                .body(Body::from(json!({"minRole":"admin"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        wabi_server::channel_access::require_access(&state, member as i64, &channel)
            .await
            .is_err()
    );
    assert!(
        wabi_server::channel_access::require_access(&state, retained as i64, &channel)
            .await
            .is_ok()
    );
    // Removed member sends no board message or rejoin after the policy changes.
    for (index, board) in boards.iter().enumerate() {
        publish_board_updates(
            &state,
            &mut author,
            &mut allowed,
            board,
            &format!("after-role-gate-{index}"),
        )
        .await;
    }
    assert_no_board_updates(&mut removed, &boards).await;
}

#[tokio::test]
async fn group_kick_and_leave_evict_idle_standard_and_cad_whiteboard_receivers() {
    for operation in ["kick", "leave"] {
        let directory = tempfile::tempdir().unwrap();
        let state = server(directory.path()).await;
        let (member, owner, _) = accounts(&state).await;
        let retained = state
            .wdb
            .create_user("retained member", None, "registered-test-hash")
            .await
            .unwrap();
        let group = format!("group-{}", uuid::Uuid::new_v4());
        let revision = state
            .wdb
            .create_group(
                &group,
                "private drawings",
                owner,
                &[owner, member, retained],
            )
            .await
            .unwrap();
        let boards = [
            format!("channel:{group}"),
            format!("cad-review:{group}:asset-group-test"),
        ];
        let app = app(&state);
        let mut author = SocketClient::connect(&app, &jwt(&state, &claims(owner, false))).await;
        let mut allowed = SocketClient::connect(&app, &jwt(&state, &claims(retained, false))).await;
        let mut removed = SocketClient::connect(&app, &jwt(&state, &claims(member, false))).await;
        for (index, board) in boards.iter().enumerate() {
            for socket in [&mut author, &mut allowed, &mut removed] {
                socket
                    .emit("whiteboard:join", json!({"boardId":board}))
                    .await;
                assert_eq!(
                    socket.event("whiteboard:joined").await["boardId"],
                    board.as_str()
                );
            }
            let canary = format!("before-{operation}-{index}");
            publish_board_updates(&state, &mut author, &mut allowed, board, &canary).await;
            assert_board_updates_received(&mut removed, board, &canary).await;
        }
        removed.barrier().await;
        removed.events.clear();
        let request_id = uuid::Uuid::new_v4().to_string();
        let change = json!({"channelId":group,"requestId":request_id,
            "expectedRevision":revision.to_string(), "userId":format!("user-{member}"),
            "targetUserId":format!("user-{member}")});
        let result = if operation == "kick" {
            author.emit("kick-group-member", change).await;
            author.event("group-operation-result").await
        } else {
            removed.emit("leave-group", change).await;
            removed.event("group-operation-result").await
        };
        assert_eq!(result["ok"], true, "{operation}: {result}");
        assert_eq!(result["requestId"], request_id);
        assert!(
            result["membershipRevision"]
                .as_str()
                .unwrap()
                .parse::<u64>()
                .unwrap()
                > revision
        );
        assert!(
            wabi_server::channel_access::require_access(&state, member as i64, &group)
                .await
                .is_err()
        );
        assert!(
            wabi_server::channel_access::require_access(&state, retained as i64, &group)
                .await
                .is_ok()
        );
        for (index, board) in boards.iter().enumerate() {
            publish_board_updates(
                &state,
                &mut author,
                &mut allowed,
                board,
                &format!("after-{operation}-{index}"),
            )
            .await;
        }
        assert_no_board_updates(&mut removed, &boards).await;
    }
}

#[tokio::test(flavor = "current_thread")]
async fn persisted_channel_ban_orders_pending_board_joins_before_completed_eviction() {
    use wabi_server::api::whiteboard_policy::write_gate;

    let directory = tempfile::tempdir().unwrap();
    let state = server(directory.path()).await;
    let (member, owner, _) = accounts(&state).await;
    let retained = state
        .wdb
        .create_user("retained viewer", None, "registered-test-hash")
        .await
        .unwrap();
    let channel = unique_channel(&state, "ban race drawings", ChannelKind::Text, owner).await;
    for uid in [owner, member, retained] {
        state
            .wdb
            .add_channel_member(&channel, uid, MemberRole::Member)
            .await
            .unwrap();
    }
    let boards = [
        format!("channel:{channel}"),
        format!("cad-review:{channel}:asset-ban-race"),
    ];
    assert!(std::ptr::eq(
        write_gate(&state, &channel),
        write_gate(&state, &boards[0])
    ));
    assert!(std::ptr::eq(
        write_gate(&state, &channel),
        write_gate(&state, &boards[1])
    ));
    let app = app(&state);
    let io = state.socket_io().unwrap();
    let mut author = SocketClient::connect(&app, &jwt(&state, &claims(owner, false))).await;
    let mut allowed = SocketClient::connect(&app, &jwt(&state, &claims(retained, false))).await;
    let mut removed = SocketClient::connect(&app, &jwt(&state, &claims(member, false))).await;
    for (index, board) in boards.iter().enumerate() {
        for socket in [&mut author, &mut allowed, &mut removed] {
            socket
                .emit("whiteboard:join", json!({"boardId":board}))
                .await;
            socket.event("whiteboard:joined").await;
        }
        let canary = format!("before-ban-{index}");
        publish_board_updates(&state, &mut author, &mut allowed, board, &canary).await;
        assert_board_updates_received(&mut removed, board, &canary).await;
    }
    removed.barrier().await;
    removed.events.clear();
    // A second, never-admitted device also tries to enter while the transition
    // is queued; the old device tries to restore its existing rooms.
    let mut pending = SocketClient::connect(&app, &jwt(&state, &claims(member, false))).await;
    let gate = write_gate(&state, &channel).lock().await;
    for board in &boards {
        removed
            .emit("whiteboard:join", json!({"boardId":board}))
            .await;
        pending
            .emit("whiteboard:join", json!({"boardId":board}))
            .await;
    }
    removed.barrier().await;
    pending.barrier().await;
    assert!(!removed
        .events
        .iter()
        .any(|event| event[0] == "whiteboard:joined"));
    assert!(!pending
        .events
        .iter()
        .any(|event| event[0] == "whiteboard:joined"));

    // Automatic safety/report bans persist before requesting this public
    // eviction seam; the same sequence is exercised without classifier inputs.
    let blacklist = state.get_blacklist().await.unwrap();
    blacklist
        .restrict_channel(&channel, member as i64, "persisted race regression", None)
        .await
        .unwrap();
    assert!(blacklist
        .is_channel_banned(&channel, member as i64)
        .await
        .is_some());
    assert!(!std::fs::read(&state.config.blacklist_file)
        .unwrap()
        .is_empty());
    let mut eviction = Box::pin(wabi_server::socketio::evict_channel_user(
        &io,
        &state,
        &channel,
        member as i64,
    ));
    assert!(
        futures::poll!(eviction.as_mut()).is_pending(),
        "completed eviction must wait for the same channel board gate"
    );
    drop(gate);
    tokio::time::timeout(Duration::from_secs(3), eviction)
        .await
        .unwrap();
    for socket in [&mut removed, &mut pending] {
        let mut denied = Vec::new();
        for _ in 0..boards.len() {
            let error = socket.event("whiteboard:error").await;
            assert_eq!(error["code"], "UNAUTHORIZED");
            denied.push(error["boardId"].as_str().unwrap().to_owned());
        }
        denied.sort();
        let mut expected = boards.to_vec();
        expected.sort();
        assert_eq!(denied, expected);
        socket.barrier().await;
        assert!(
            !socket
                .events
                .iter()
                .any(|event| event[0] == "whiteboard:joined"),
            "pending join restored a receiver after the completed ban"
        );
    }
    for (index, board) in boards.iter().enumerate() {
        publish_board_updates(
            &state,
            &mut author,
            &mut allowed,
            board,
            &format!("after-completed-ban-{index}"),
        )
        .await;
    }
    assert_no_board_updates(&mut removed, &boards).await;
    assert_no_board_updates(&mut pending, &boards).await;
}
