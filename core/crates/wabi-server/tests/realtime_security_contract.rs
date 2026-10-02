//! Real Socket.IO polling through the production router, with durable WabiDB.
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

#[tokio::test]
async fn namespace_admission_rejects_anonymous_scoped_revoked_and_inactive_credentials_but_allows_signed_guests(
) {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (member, owner, guest) = accounts(&state).await;
    let app = app(&state);
    let io = state.socket_io().unwrap();
    let revoked = claims(owner, false);
    state
        .revoke_token_with_exp(revoked.jti.clone(), revoked.exp)
        .await
        .unwrap();
    let mut refresh = claims(owner, false);
    refresh.token_type = "refresh".into();
    let mut stepup = claims(owner, false);
    stepup.stepup = true;
    let mut expired = claims(owner, false);
    expired.exp = chrono::Utc::now().timestamp() - 3600;
    // Profile patches deliberately cannot change account activation. Build
    // an inactive fixture through the existing encoded registration event.
    let engine = state.wdb.engine();
    let mut inactive_record = wabidb::projections::users::decode_record(
        &engine
            .projection_state()
            .get("users", &member.to_be_bytes())
            .unwrap(),
    )
    .unwrap();
    inactive_record.user_id = 0; // Assigned from the registration commit sequence.
    inactive_record.username = "inactive-member".into();
    inactive_record.is_active = false;
    let inactive = engine
        .run_command(wabidb::sequencer::types::CommandCommit {
            caller_user_id: 0,
            caller_device_id: "fixture".into(),
            command_name: "inactive_account_fixture".into(),
            idempotency_key: None,
            room_owner_precondition: None,
            essential: true,
            response_tx: tokio::sync::oneshot::channel().0,
            events: vec![wabidb::sequencer::types::EventToWrite {
                stream_id: "users".into(),
                event_type: "user_registered".into(),
                stream_kind: 6,
                record_kind: wabidb::format::record::RecordKind::Event,
                plaintext: wabidb::projections::users::encode_record(&inactive_record),
            }],
        })
        .await
        .unwrap()
        .commit_seq;
    assert!(
        !state
            .wdb
            .get_user(inactive)
            .await
            .unwrap()
            .unwrap()
            .is_active
    );
    for token in [
        "".into(),
        "invalid".into(),
        jwt(&state, &refresh),
        jwt(&state, &stepup),
        jwt(&state, &revoked),
        jwt(&state, &expired),
        jwt(&state, &claims(inactive, false)),
        jwt(&state, &claims(999_999, false)),
    ] {
        let (_, result) = SocketClient::namespace(&app, &token).await;
        assert!(
            result.starts_with("44"),
            "denied credential joined namespace: {result}"
        );
        assert!(
            io.sockets().is_empty(),
            "rejected connections must not receive namespace fanout"
        );
    }
    state
        .get_blacklist()
        .await
        .unwrap()
        .add_user(owner as i64, "contract ban", None)
        .await
        .unwrap();
    let (_, result) = SocketClient::namespace(&app, &jwt(&state, &claims(owner, false))).await;
    assert!(result.starts_with("44"));
    assert!(io.sockets().is_empty());
    let mut signed_guest = SocketClient::connect(&app, &jwt(&state, &claims(guest, true))).await;
    signed_guest
        .emit("set-presence", json!({"presence": "away"}))
        .await;
    assert_eq!(
        signed_guest.event("presence-changed").await["dbUserId"],
        guest
    );
    assert_eq!(io.sockets().len(), 1);
}

#[tokio::test]
async fn cached_event_identities_cannot_mutate_after_current_revocation() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (member, owner, _) = accounts(&state).await;
    let app = app(&state);
    let mut observer = SocketClient::connect(&app, &jwt(&state, &claims(member, false))).await;
    let mut healthy = SocketClient::connect(&app, &jwt(&state, &claims(owner, false))).await;
    for name in ["permitted", "keep"] {
        state
            .wdb
            .upsert_emote(name, "/uploads/canary", name, "", "custom", "emoji", owner)
            .await
            .unwrap();
    }
    healthy
        .emit("delete-emoji", json!({"name": "permitted"}))
        .await;
    healthy.event("delete-emoji-success").await;
    assert!(!state
        .wdb
        .get_emotes()
        .await
        .unwrap()
        .iter()
        .any(|emote| emote.name == "permitted"));
    healthy
        .emit(
            "update-profile",
            json!({"requestId": "valid-profile", "bio": "keep profile"}),
        )
        .await;
    healthy.event("profile-updated").await;
    healthy
        .emit("set-presence", json!({"presence": "away"}))
        .await;
    assert_eq!(healthy.event("presence-changed").await["status"], "away");
    healthy
        .emit("toggle-reception", json!({"enabled": false}))
        .await;
    assert_eq!(
        healthy.event("toggle-reception-success").await["enabled"],
        false
    );

    let attempts = [
        ("delete-emoji", json!({"name": "keep"})),
        (
            "update-profile",
            json!({"requestId": "revoked-profile", "bio": "forged profile"}),
        ),
        ("set-presence", json!({"presence": "busy"})),
        ("toggle-reception", json!({"enabled": true})),
    ];
    let mut clients = Vec::new();
    for _ in &attempts {
        let credential = claims(owner, false);
        let client = SocketClient::connect(&app, &jwt(&state, &credential)).await;
        clients.push((client, credential));
    }
    observer.barrier().await;
    observer.events.clear();
    let before_seq = state.wdb.engine().projection_state().applied_commit_seq();
    // Publish only the auth view here to exercise each per-event guard itself,
    // independently of the separately tested proactive revocation disconnect.
    for (_, credential) in &clients {
        state
            .revocations
            .write()
            .await
            .jtis
            .insert(credential.jti.clone(), credential.exp as u64);
    }
    for ((mut client, _), (event, payload)) in clients.into_iter().zip(attempts) {
        client.emit(event, payload).await;
        client.event("auth-revoked").await;
    }
    observer.barrier().await;
    assert!(!observer
        .events
        .iter()
        .any(|event| event[0] == "toggle-reception-success"
            || event[0] == "user-updated"
            || (event[0] == "presence-changed" && event[1]["status"] == "busy")));
    assert!(state
        .wdb
        .get_emotes()
        .await
        .unwrap()
        .iter()
        .any(|emote| emote.name == "keep"));
    assert_eq!(
        state
            .wdb
            .get_user(owner)
            .await
            .unwrap()
            .unwrap()
            .bio
            .as_deref(),
        Some("keep profile")
    );
    assert_eq!(
        state.wdb.engine().projection_state().applied_commit_seq(),
        before_seq
    );
}

#[tokio::test]
async fn durable_revocation_evicts_idle_receivers_before_return_and_preserves_other_sessions() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (member, _, guest) = accounts(&state).await;
    let app = app(&state);
    let io = state.socket_io().unwrap();
    let denied = claims(member, false);
    let retained = claims(member, false);
    let guest_claims = claims(guest, true);
    let mut victim = SocketClient::connect(&app, &jwt(&state, &denied)).await;
    let mut sibling = SocketClient::connect(&app, &jwt(&state, &retained)).await;
    let mut guest_socket = SocketClient::connect(&app, &jwt(&state, &guest_claims)).await;
    io.to(format!("user-{member}"))
        .emit("private-canary", &json!({"content": "before denial"}))
        .await
        .unwrap();
    victim.event("private-canary").await;
    sibling.event("private-canary").await;
    state
        .revoke_token_with_exp(denied.jti.clone(), denied.exp)
        .await
        .unwrap();
    assert!(!io
        .sockets()
        .iter()
        .any(|socket| socket.id.to_string() == victim.socket_id));
    victim.event("auth-revoked").await;
    io.to(format!("user-{member}"))
        .emit("private-canary", &json!({"content": "after denial"}))
        .await
        .unwrap();
    assert_eq!(
        sibling.event("private-canary").await["content"],
        "after denial"
    );
    state
        .revoke_user_other_sessions(member as i64, &retained.jti)
        .await
        .unwrap();
    assert!(io
        .sockets()
        .iter()
        .any(|socket| socket.id.to_string() == sibling.socket_id));
    state.revoke_all_tokens().await.unwrap();
    sibling.event("auth-revoked").await;
    guest_socket.event("auth-revoked").await;
    assert!(io.sockets().is_empty());
}

#[tokio::test]
async fn breakout_controls_require_moderation_and_preserve_self_move_and_parent_access() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (member, owner, _) = accounts(&state).await;
    let parent = state
        .wdb
        .create_channel("parent", ChannelKind::Voice, owner, false)
        .await
        .unwrap();
    state
        .wdb
        .add_channel_member(&parent, member, MemberRole::Member)
        .await
        .unwrap();
    let app = app(&state);
    let mut normal = SocketClient::connect(&app, &jwt(&state, &claims(member, false))).await;
    let mut moderator = SocketClient::connect(&app, &jwt(&state, &claims(owner, false))).await;
    let before = state.wdb.list_channels(None).await.unwrap().len();
    normal
        .emit(
            "create-breakout-rooms",
            json!({"parentChannelId": parent, "roomCount": 2}),
        )
        .await;
    normal.event("breakout-rooms-error").await;
    assert_eq!(state.wdb.list_channels(None).await.unwrap().len(), before);
    moderator
        .emit(
            "create-breakout-rooms",
            json!({"parentChannelId": parent, "roomCount": 2}),
        )
        .await;
    let rooms = moderator.event("breakout-rooms-created").await;
    let destination = rooms["rooms"][0]["id"].as_str().unwrap();
    assert_eq!(
        state
            .wdb
            .get_channel(destination)
            .await
            .unwrap()
            .unwrap()
            .parent_id
            .as_deref(),
        Some(parent.as_str())
    );
    normal
        .emit("voice-channel-join", json!({"channelId": parent}))
        .await;
    assert_eq!(
        normal.event("voice-channel-admitted").await["channelId"],
        parent
    );
    normal.emit("move-user-to-breakout", json!({"parentChannelId": parent, "targetUserId": format!("user-{owner}"), "toChannelId": destination})).await;
    normal.event("breakout-rooms-error").await;
    normal.emit("move-user-to-breakout", json!({"parentChannelId": parent, "targetUserId": format!("user-{member}"), "toChannelId": destination})).await;
    normal.event("breakout-user-moved").await;
    normal
        .emit("close-breakout-rooms", json!({"parentChannelId": parent}))
        .await;
    normal.event("breakout-rooms-error").await;
    assert!(state.wdb.get_channel(destination).await.unwrap().is_some());
    moderator
        .emit("close-breakout-rooms", json!({"parentChannelId": parent}))
        .await;
    moderator.event("breakout-rooms-closed").await;
    assert!(state.wdb.get_channel(destination).await.unwrap().is_none());
}

#[tokio::test]
async fn breakout_children_inherit_persisted_parent_role_gate_before_admission() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (member, owner, _) = accounts(&state).await;
    let parent = state
        .wdb
        .create_channel("staff parent", ChannelKind::Voice, owner, false)
        .await
        .unwrap();
    state
        .wdb
        .add_channel_member(&parent, member, MemberRole::Member)
        .await
        .unwrap();
    let app = app(&state);
    let owner_token = jwt(&state, &claims(owner, false));
    let response = app
        .clone()
        .oneshot(
            Request::put(format!("/server-center/channel-gates/{parent}"))
                .header("authorization", format!("Bearer {owner_token}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({"minRole": "admin"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let mut moderator = SocketClient::connect(&app, &owner_token).await;
    let mut normal = SocketClient::connect(&app, &jwt(&state, &claims(member, false))).await;
    moderator
        .emit(
            "create-breakout-rooms",
            json!({"parentChannelId": parent, "roomCount": 1}),
        )
        .await;
    let rooms = moderator.event("breakout-rooms-created").await;
    let child = rooms["rooms"][0]["id"].as_str().unwrap();
    assert_eq!(
        wabi_server::api::server_center::channel_min_role(&state, child)
            .await
            .as_deref(),
        Some("admin")
    );
    assert!(state
        .wdb
        .list_channel_members(child)
        .await
        .unwrap()
        .iter()
        .any(|membership| membership.user_id == member));
    normal
        .emit("voice-channel-join", json!({"channelId": child}))
        .await;
    normal.event("voice-channel-error").await;
    moderator
        .emit("voice-channel-join", json!({"channelId": child}))
        .await;
    assert_eq!(
        moderator.event("voice-channel-admitted").await["channelId"],
        child
    );
}

#[tokio::test]
async fn existing_breakout_applies_later_parent_gate_changes_and_fails_closed_on_missing_parent() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (member, owner, _) = accounts(&state).await;
    let parent = state
        .wdb
        .create_channel("open parent", ChannelKind::Voice, owner, false)
        .await
        .unwrap();
    state
        .wdb
        .add_channel_member(&parent, member, MemberRole::Member)
        .await
        .unwrap();
    let app = app(&state);
    let owner_token = jwt(&state, &claims(owner, false));
    let mut moderator = SocketClient::connect(&app, &owner_token).await;
    let mut normal = SocketClient::connect(&app, &jwt(&state, &claims(member, false))).await;
    moderator
        .emit(
            "create-breakout-rooms",
            json!({"parentChannelId": parent, "roomCount": 1}),
        )
        .await;
    let rooms = moderator.event("breakout-rooms-created").await;
    let child = rooms["rooms"][0]["id"].as_str().unwrap();
    normal
        .emit("voice-channel-join", json!({"channelId": child}))
        .await;
    assert_eq!(
        normal.event("voice-channel-admitted").await["channelId"],
        child
    );
    normal
        .emit(
            "join-wabidb-call",
            json!({"sessionId": format!("channel:{child}"), "channelId": child}),
        )
        .await;
    normal.event("wabidb-call-joined").await;
    let io = state.socket_io().unwrap();
    let receiver = io
        .sockets()
        .into_iter()
        .find(|socket| socket.id.to_string() == normal.socket_id)
        .unwrap();
    let media_room = format!("wabidb-call-channel:{child}");
    assert!(receiver
        .rooms()
        .iter()
        .any(|room| room.as_ref() == media_room));
    let response = app
        .clone()
        .oneshot(
            Request::put(format!("/server-center/channel-gates/{parent}"))
                .header("authorization", format!("Bearer {owner_token}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({"minRole": "admin"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        !receiver
            .rooms()
            .iter()
            .any(|room| room.as_ref() == media_room),
        "idle child receiver must leave media before parent policy update returns"
    );
    normal
        .emit("voice-channel-join", json!({"channelId": child}))
        .await;
    normal.event("voice-channel-error").await;
    state.wdb.delete_channel(&parent, owner).await.unwrap();
    assert!(
        wabi_server::channel_access::require_access(&state, owner as i64, child)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn voice_parent_policy_rejects_cycles_and_preserves_category_organization() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (member, owner, _) = accounts(&state).await;
    let first = state
        .wdb
        .create_channel("first", ChannelKind::Voice, owner, false)
        .await
        .unwrap();
    let second = state
        .wdb
        .create_channel("second", ChannelKind::Voice, owner, false)
        .await
        .unwrap();
    let category = state
        .wdb
        .create_channel("folder", ChannelKind::Category, owner, false)
        .await
        .unwrap();
    for id in [&first, &second] {
        state
            .wdb
            .add_channel_member(id, member, MemberRole::Member)
            .await
            .unwrap();
    }
    state
        .wdb
        .update_channel(&first, &json!({"parent_id": category}), owner)
        .await
        .unwrap();
    assert!(
        wabi_server::channel_access::require_access(&state, member as i64, &first)
            .await
            .is_ok()
    );
    state
        .wdb
        .update_channel(&first, &json!({"parent_id": second}), owner)
        .await
        .unwrap();
    state
        .wdb
        .update_channel(&second, &json!({"parent_id": first}), owner)
        .await
        .unwrap();
    assert!(
        wabi_server::channel_access::require_access(&state, member as i64, &first)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn transfer_signaling_cannot_address_channel_rooms_and_attests_the_sender() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (member, owner, _) = accounts(&state).await;
    let room = state
        .wdb
        .create_channel("shared", ChannelKind::Text, owner, false)
        .await
        .unwrap();
    state
        .wdb
        .add_channel_member(&room, member, MemberRole::Member)
        .await
        .unwrap();
    let app = app(&state);
    let sender = SocketClient::connect(&app, &jwt(&state, &claims(member, false))).await;
    let mut receiver = SocketClient::connect(&app, &jwt(&state, &claims(owner, false))).await;
    receiver.emit("join-channel", json!(room)).await;
    receiver.barrier().await;
    receiver.events.clear();
    for (event, payload) in [
        (
            "p2p-offer",
            json!({"transferId": "forged", "targetId": room, "offer": {"type": "offer"}}),
        ),
        (
            "p2p-answer",
            json!({"transferId": "forged", "targetId": room, "answer": {"type": "answer"}}),
        ),
        (
            "p2p-ice-candidate",
            json!({"transferId": "forged", "targetId": room, "candidate": {}}),
        ),
    ] {
        sender.emit(event, payload).await;
    }
    // Same account-targeted transport is the delivery barrier and positive control.
    sender.emit("p2p-offer", json!({"transferId": "valid", "targetId": format!("user-{owner}"), "senderId": "forged-owner", "offer": {"type": "offer"}})).await;
    let received = receiver.event("p2p-offer").await;
    assert_eq!(received["transferId"], "valid");
    assert_eq!(received["senderId"], format!("user-{member}"));
    receiver.barrier().await;
    assert!(!receiver
        .events
        .iter()
        .any(|event| event[1]["transferId"] == "forged"));
}

#[tokio::test]
async fn account_ban_callback_uses_writer_admission_without_deadlock_and_rejects_stale_actor() {
    let directory = tempfile::tempdir().unwrap();
    let state = server(directory.path()).await;
    let (member, owner, _) = accounts(&state).await;
    let app = app(&state);
    let owner_credential = claims(owner, false);
    let mut owner_socket = SocketClient::connect(&app, &jwt(&state, &owner_credential)).await;
    let member_credential = claims(member, false);
    let mut member_socket = SocketClient::connect(&app, &jwt(&state, &member_credential)).await;
    owner_socket.emit("admin-ban-user", json!({
        "requestId":"current-writer-ban", "targetUserId":member, "reason":"writer proof canary"
    })).await;
    let result = owner_socket.event("admin-ban-success").await;
    assert_eq!(result["targetUserId"], member);
    assert!(state.get_blacklist().await.unwrap().is_user_banned(member as i64).await.is_some());
    assert!(state.is_token_revoked(&member_credential.jti, member as i64, member_credential.iat).await);
    member_socket.event("auth-revoked").await;
    assert!(!state.socket_io().unwrap().sockets().iter().any(|socket|
        socket.id.to_string() == member_socket.socket_id));

    let canary = state.wdb.create_user("stale-ban-canary", None, "registered-hash").await.unwrap();
    let stale_credential = claims(owner, false);
    let mut stale_socket = SocketClient::connect(&app, &jwt(&state, &stale_credential)).await;
    // The request is received on a cached authenticated transport but waits
    // for membership admission. Publish its denial while that wait is held;
    // skip proactive eviction here so the callback's writer check is exercised.
    let membership = state.membership_gate.write().await;
    stale_socket.emit("admin-ban-user", json!({
        "requestId":"stale-writer-ban", "targetUserId":canary, "reason":"must not publish"
    })).await;
    state.revocations.write().await.jtis.insert(stale_credential.jti, stale_credential.exp as u64);
    let sequence = state.wdb.engine().projection_state().applied_commit_seq();
    drop(membership);
    stale_socket.event("auth-revoked").await;
    assert!(state.get_blacklist().await.unwrap().is_user_banned(canary as i64).await.is_none());
    assert!(!state.revocations.read().await.user_iat_revoked.contains_key(&(canary as i64)));
    assert_eq!(state.wdb.engine().projection_state().applied_commit_seq(), sequence);

    // A separate current owner credential still completes the same operation.
    owner_socket.emit("admin-ban-user", json!({
        "requestId":"fresh-writer-ban", "targetUserId":canary
    })).await;
    assert_eq!(owner_socket.event("admin-ban-success").await["targetUserId"], canary);
    assert!(state.get_blacklist().await.unwrap().is_user_banned(canary as i64).await.is_some());
}

#[tokio::test]
async fn corrupt_voice_restrictions_refuse_admission_and_fanout_then_durable_policy_recovers() {
    use wabidb::projections::voice_restrictions::{encode_key, DEAFENS, MUTES};
    let directory = tempfile::tempdir().unwrap();
    let state = server(directory.path()).await;
    let (member, owner, _) = accounts(&state).await;
    let channel = state.wdb.create_channel("restricted voice", ChannelKind::Voice, owner, false)
        .await.unwrap();
    state.wdb.add_channel_member(&channel, member, MemberRole::Member).await.unwrap();
    let app = app(&state);
    let mut sender = SocketClient::connect(&app, &jwt(&state, &claims(member, false))).await;
    let mut observer = SocketClient::connect(&app, &jwt(&state, &claims(owner, false))).await;
    sender.barrier().await;
    observer.barrier().await;
    sender.events.clear();
    observer.events.clear();
    for index in [MUTES, DEAFENS] {
        state.wdb.engine().projection_state().insert(index, encode_key(&channel, member),
            b"CORRUPT-VOICE-RESTRICTION-FIXTURE".to_vec(),
            state.wdb.engine().projection_state().applied_commit_seq());
        let request_id = format!("corrupt-{index}");
        sender.emit("voice-channel-join", json!({"channelId": channel, "requestId": request_id})).await;
        let error = sender.event("voice-channel-error").await;
        assert_eq!(error["channelId"], channel);
        assert_eq!(error["requestId"], request_id);
        assert_eq!(error["error"], "Channel moderation state unavailable");
        sender.emit("join-wabidb-call", json!({"channelId": channel,
            "sessionId": format!("channel:{channel}"), "requestId":"denied-media-consent"})).await;
        sender.event("wabidb-call-denied").await;
        sender.barrier().await;
        observer.barrier().await;
        assert!(!sender.events.iter().any(|event| event[0] == "voice-channel-admitted"));
        assert!(!observer.events.iter().any(|event| event[0] == "voice-channel-joined"));
        state.wdb.engine().projection_state().remove(index, &encode_key(&channel, member));
    }
    state.wdb.mute_user(&channel, owner, member, i64::MAX).await.unwrap();
    sender.emit("voice-channel-join", json!({"channelId": channel})).await;
    assert_eq!(sender.event("voice-channel-error").await["error"], "You are muted in this channel");
    state.wdb.unmute_user(&channel, owner, member).await.unwrap();
    state.wdb.deafen_user(&channel, owner, member).await.unwrap();
    sender.emit("voice-channel-join", json!({"channelId": channel})).await;
    assert_eq!(sender.event("voice-channel-admitted").await["channelId"], channel);
    let snapshot = sender.event("voice-channel-state").await;
    let participant = snapshot["members"].as_array().unwrap().iter()
        .find(|participant| participant["userId"] == format!("user-{member}")).unwrap();
    assert_eq!(participant["isDeafened"], true);
    assert_eq!(participant["isMuted"], false);
}

#[tokio::test]
async fn livekit_voice_moderation_queues_current_grants_and_denies_non_admins_and_corrupt_policy() {
    use wabi_server::nodes::{JoinNodeRequest, NodeCapability, NodeReachability};
    use wabidb::projections::voice_restrictions::{decode_mute, encode_key, MUTES};

    let directory = tempfile::tempdir().unwrap();
    let state = server(directory.path()).await;
    let (member, owner, _) = accounts(&state).await;
    let channel = state
        .wdb
        .create_channel("active LiveKit voice", ChannelKind::Voice, owner, false)
        .await
        .unwrap();
    state
        .wdb
        .add_channel_member(&channel, member, MemberRole::Member)
        .await
        .unwrap();
    let app = app(&state);
    let pairing = state
        .node_registry
        .create_pairing_token(
            "moderation fixture".into(),
            vec![NodeCapability::MediaRelay],
            Duration::from_secs(60),
        )
        .await
        .unwrap();
    let node = state
        .node_registry
        .join_with_token(JoinNodeRequest {
            token: pairing.token,
            display_name: "moderation fixture".into(),
            public_key: "fixture-key".into(),
            reachability: NodeReachability::OutboundOnly,
            endpoint: Some("https://media.example".into()),
        })
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
    let mut caller = SocketClient::connect(&app, &jwt(&state, &claims(member, false))).await;
    let mut admin = SocketClient::connect(&app, &jwt(&state, &claims(owner, false))).await;
    caller
        .emit("voice-channel-join", json!({"channelId":channel}))
        .await;
    assert_eq!(
        caller.event("voice-channel-admitted").await["channelId"],
        channel
    );
    let participants = caller.event("voice-channel-state").await;
    let participant = participants["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|participant| participant["userId"] == format!("user-{member}"))
        .unwrap();
    assert_eq!(participant["isMuted"], false);
    assert_eq!(participant["isDeafened"], false);

    for (command, error) in [
        ("voice-mute", "voice-mute-error"),
        ("voice-unmute", "voice-unmute-error"),
        ("voice-deafen", "voice-deafen-error"),
        ("voice-undeafen", "voice-undeafen-error"),
    ] {
        let before = serde_json::to_value(state.job_queue.list_jobs(None).await).unwrap();
        let seq = state.wdb.engine().projection_state().applied_commit_seq();
        caller
            .emit(command, json!({"channelId":channel,"targetUserId":member}))
            .await;
        assert!(caller.event(error).await["error"]
            .as_str()
            .unwrap()
            .contains("Only admins"));
        assert_eq!(
            serde_json::to_value(state.job_queue.list_jobs(None).await).unwrap(),
            before
        );
        assert_eq!(
            state.wdb.engine().projection_state().applied_commit_seq(),
            seq
        );
        assert!(!state.wdb.is_user_muted(&channel, member).await.unwrap());
        assert!(!state.wdb.is_user_deafened(&channel, member).await.unwrap());
    }

    // Invalid IDs must be rejected before strict durable moderation records
    // are constructed; zero/negative targets must not poison later commands.
    for target in [0_i64, -1] {
        for (command, error) in [
            ("voice-mute", "voice-mute-error"),
            ("voice-unmute", "voice-unmute-error"),
            ("voice-deafen", "voice-deafen-error"),
            ("voice-undeafen", "voice-undeafen-error"),
        ] {
            let before = serde_json::to_value(state.job_queue.list_jobs(None).await).unwrap();
            let seq = state.wdb.engine().projection_state().applied_commit_seq();
            admin
                .emit(command, json!({"channelId":channel,"targetUserId":target}))
                .await;
            assert_eq!(admin.event(error).await["error"], "Invalid targetUserId");
            assert_eq!(
                serde_json::to_value(state.job_queue.list_jobs(None).await).unwrap(),
                before
            );
            assert_eq!(
                state.wdb.engine().projection_state().applied_commit_seq(),
                seq
            );
        }
    }
    admin.barrier().await;
    assert!(!admin.events.iter().any(|event| matches!(
        event[0].as_str(),
        Some(
            "voice-user-muted"
                | "voice-user-unmuted"
                | "voice-user-deafened"
                | "voice-user-undeafened"
        )
    )));

    // Every healthy owner callback still works after the rejected targets.
    for (command, event, muted, deafened) in [
        ("voice-unmute", "voice-user-unmuted", false, false),
        ("voice-mute", "voice-user-muted", true, false),
        ("voice-unmute", "voice-user-unmuted", false, false),
        ("voice-deafen", "voice-user-deafened", false, true),
        ("voice-undeafen", "voice-user-undeafened", false, false),
    ] {
        let before = state.job_queue.list_jobs(None).await;
        admin
            .emit(command, json!({"channelId":channel,"targetUserId":member}))
            .await;
        let success = admin.event(event).await;
        assert_eq!(success["channelId"], channel);
        assert_eq!(success["dbUserId"], member);
        assert_eq!(
            state.wdb.is_user_muted(&channel, member).await.unwrap(),
            muted
        );
        assert_eq!(
            state.wdb.is_user_deafened(&channel, member).await.unwrap(),
            deafened
        );
        let job = new_livekit_permission_job(&state, &before).await;
        assert_eq!(job.payload["assignedNodeId"], node.node.node_id);
        assert_eq!(job.payload["roomId"], room.room_id);
        assert_eq!(job.payload["externalRoomName"], room.external_room_name);
        assert_eq!(job.payload["tenantNamespace"], room.tenant_namespace);
        assert_eq!(job.payload["channelId"], channel);
        assert_eq!(job.payload["identity"], format!("user:{member}"));
        assert_eq!(job.payload["grants"]["canPublish"], !muted);
        assert_eq!(job.payload["grants"]["canSubscribe"], !deafened);
        assert_eq!(job.payload["grants"]["canPublishData"], true);
        assert_eq!(
            job.payload["grants"]["canPublishSources"],
            if muted {
                json!([])
            } else {
                json!(["microphone", "camera", "screen_share", "screen_share_audio"])
            }
        );
    }

    // Establish a currently transmitting participant again, then corrupt an
    // actual durable mute row while that old permissive session remains open.
    caller
        .emit("voice-channel-join", json!({"channelId":channel}))
        .await;
    caller.event("voice-channel-admitted").await;
    state
        .wdb
        .mute_user(&channel, owner, member, i64::MAX)
        .await
        .unwrap();
    let projection = state.wdb.engine().projection_state();
    let key = encode_key(&channel, member);
    let row = decode_mute(&projection.get(MUTES, &key).expect("durable mute row")).unwrap();
    assert_eq!(row.user_id, member);
    assert_eq!(row.channel_id, channel);
    projection.insert(
        MUTES,
        key,
        b"CORRUPT-MUTE-FIXTURE".to_vec(),
        projection.applied_commit_seq(),
    );
    assert!(state.wdb.is_user_muted(&channel, member).await.is_err());
    let before = state.job_queue.list_jobs(None).await;
    admin
        .emit(
            "voice-deafen",
            json!({"channelId":channel,"targetUserId":member}),
        )
        .await;
    let failure = admin.event("voice-deafen-error").await;
    assert!(!failure["error"].as_str().unwrap().is_empty());
    let job = new_livekit_permission_job(&state, &before).await;
    assert_eq!(job.payload["roomId"], room.room_id);
    assert_eq!(job.payload["assignedNodeId"], node.node.node_id);
    assert_eq!(job.payload["identity"], format!("user:{member}"));
    assert_eq!(
        job.payload["grants"],
        json!({
            "canPublish":false, "canSubscribe":false, "canPublishData":false,
            "canPublishSources":[],
        })
    );
    admin.barrier().await;
    assert!(!admin
        .events
        .iter()
        .any(|event| event[0] == "voice-user-deafened"));
}

async fn new_livekit_permission_job(
    state: &AppState,
    before: &[wabi_server::jobs::Job],
) -> wabi_server::jobs::Job {
    let jobs = state.job_queue.list_jobs(None).await;
    let mut new: Vec<_> = jobs
        .into_iter()
        .filter(|job| !before.iter().any(|old| old.job_id == job.job_id))
        .collect();
    assert_eq!(
        new.len(),
        2,
        "moderation queues the admitted device plus legacy account identity"
    );
    for job in &new {
        assert_eq!(job.kind, wabi_server::jobs::JobKind::MediaRelay);
        assert_eq!(job.payload["operation"], "update_participant_permissions");
    }
    let account = new
        .iter()
        .position(|job| {
            !job.payload["identity"]
                .as_str()
                .unwrap()
                .contains(":device:")
        })
        .unwrap();
    let legacy = new.remove(account);
    assert_eq!(new[0].payload["grants"], legacy.payload["grants"]);
    legacy
}

#[tokio::test(flavor = "current_thread")]
async fn persisted_channel_ban_denies_queued_ordinary_joins_and_idle_message_receivers() {
    use wabi_server::channel_access::publication_gate;
    let directory = tempfile::tempdir().unwrap();
    let state = server(directory.path()).await;
    let (member, owner, _) = accounts(&state).await;
    let retained = state
        .wdb
        .create_user("retained chat member", None, "registered-test-hash")
        .await
        .unwrap();
    let channel = state
        .wdb
        .create_channel("queued chat join", ChannelKind::Text, owner, false)
        .await
        .unwrap();
    for uid in [owner, member, retained] {
        state
            .wdb
            .add_channel_member(&channel, uid, MemberRole::Member)
            .await
            .unwrap();
    }
    let app = app(&state);
    let io = state.socket_io().unwrap();
    let mut sender = SocketClient::connect(&app, &jwt(&state, &claims(owner, false))).await;
    let mut allowed = SocketClient::connect(&app, &jwt(&state, &claims(retained, false))).await;
    let mut removed = SocketClient::connect(&app, &jwt(&state, &claims(member, false))).await;
    for client in [&mut sender, &mut allowed, &mut removed] {
        client.emit("join-channel", json!(channel)).await;
        assert_eq!(client.event("channel-messages").await["channelId"], channel);
    }
    sender
        .emit(
            "message",
            json!({"channelId":channel,"text":"before channel ban",
        "clientMessageId":"before-channel-ban"}),
        )
        .await;
    sender.event("message-accepted").await;
    assert_eq!(
        allowed.event("message").await["message"]["text"],
        "before channel ban"
    );
    assert_eq!(
        removed.event("message").await["message"]["text"],
        "before channel ban"
    );
    removed.barrier().await;
    removed.events.clear();
    let mut waiting = SocketClient::connect(&app, &jwt(&state, &claims(member, false))).await;

    let gate = publication_gate(&state, &channel).lock().await;
    removed.emit("join-channel", json!(channel)).await;
    waiting.emit("join-channel", json!(channel)).await;
    removed.barrier().await;
    waiting.barrier().await;
    for client in [&removed, &waiting] {
        assert!(
            !client
                .events
                .iter()
                .any(|event| event[0] == "channel-messages"),
            "ordinary join/history escaped the held publication gate"
        );
    }
    state
        .get_blacklist()
        .await
        .unwrap()
        .restrict_channel(&channel, member as i64, "queued ordinary join ban", None)
        .await
        .unwrap();
    let mut eviction = Box::pin(wabi_server::socketio::evict_channel_user(
        &io,
        &state,
        &channel,
        member as i64,
    ));
    assert!(
        futures::poll!(eviction.as_mut()).is_pending(),
        "ban eviction bypassed the channel publication gate"
    );
    drop(gate);
    tokio::time::timeout(Duration::from_secs(3), eviction)
        .await
        .unwrap();
    for client in [&mut removed, &mut waiting] {
        let denied = client.event("join-error").await;
        assert_eq!(denied["channelId"], channel);
        assert_eq!(denied["error"], "access denied");
    }
    sender
        .emit(
            "message",
            json!({"channelId":channel,"text":"after completed channel ban",
        "clientMessageId":"after-channel-ban"}),
        )
        .await;
    let accepted = sender.event("message-accepted").await;
    let delivered = allowed.event("message").await;
    assert_eq!(delivered["channelId"], channel);
    assert_eq!(delivered["message"]["text"], "after completed channel ban");
    assert_eq!(delivered["message"]["id"], accepted["messageId"]);
    assert!(state
        .wdb
        .list_messages_typed(&channel, 100)
        .await
        .unwrap()
        .iter()
        .any(|message| message.content == "after completed channel ban"));
    for client in [&mut removed, &mut waiting] {
        client.barrier().await;
        assert!(
            !client.events.iter().any(|event| {
                matches!(
                    event[0].as_str(),
                    Some("channel-messages" | "live-buffer-snapshot" | "message")
                ) && event[1]["channelId"] == channel
            }),
            "denied idle client received history/live content: {:?}",
            client.events
        );
    }
    // A permitted rejoin still returns the real current history.
    allowed.emit("join-channel", json!(channel)).await;
    let history = allowed.event("channel-messages").await;
    assert!(history["messages"]
        .as_array()
        .unwrap()
        .iter()
        .any(|message| message["text"] == "after completed channel ban"));
}

async fn unique_relay_channel(state: &Arc<AppState>, name: &str, owner: u64) -> String {
    // Media replay is process-wide, so independent server fixtures must not
    // reuse the ordinary sequence-derived channel ID for their sessions.
    let channel_id = format!("voice-fixture-{}", uuid::Uuid::new_v4());
    let mut channel = wabidb::domain::Channel::new(&channel_id, name, owner);
    channel.channel_kind = ChannelKind::Voice;
    let engine = state.wdb.engine();
    engine.get_or_create_stream_key(&channel_id).await.unwrap();
    engine
        .run_command(wabidb::sequencer::types::CommandCommit {
            caller_user_id: owner,
            caller_device_id: "fixture".into(),
            command_name: "unique_relay_channel_fixture".into(),
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
    assert_eq!(persisted.channel_kind, ChannelKind::Voice);
    channel_id
}

#[tokio::test(flavor = "current_thread")]
async fn persisted_channel_ban_denies_queued_relay_joins_header_replay_and_idle_media_receivers() {
    use wabi_server::channel_access::publication_gate;
    let directory = tempfile::tempdir().unwrap();
    let state = server(directory.path()).await;
    let (member, owner, _) = accounts(&state).await;
    let retained = state
        .wdb
        .create_user("retained voice member", None, "registered-test-hash")
        .await
        .unwrap();
    let channel = unique_relay_channel(&state, "queued relay join", owner).await;
    for uid in [owner, member, retained] {
        state
            .wdb
            .add_channel_member(&channel, uid, MemberRole::Member)
            .await
            .unwrap();
    }
    let session = format!("channel:{channel}");
    let app = app(&state);
    let io = state.socket_io().unwrap();
    let mut sender = SocketClient::connect(&app, &jwt(&state, &claims(owner, false))).await;
    let mut allowed = SocketClient::connect(&app, &jwt(&state, &claims(retained, false))).await;
    let mut removed = SocketClient::connect(&app, &jwt(&state, &claims(member, false))).await;
    let mut waiting = SocketClient::connect(&app, &jwt(&state, &claims(member, false))).await;
    // Every device has real per-device voice consent, so a denial cannot be
    // mistaken for a missing-roster fixture. The new device has not joined relay.
    for client in [&mut sender, &mut allowed, &mut removed, &mut waiting] {
        client
            .emit("voice-channel-join", json!({"channelId":channel}))
            .await;
        assert_eq!(
            client.event("voice-channel-admitted").await["channelId"],
            channel
        );
    }
    for client in [&mut sender, &mut allowed, &mut removed] {
        client
            .emit(
                "join-wabidb-call",
                json!({"channelId":channel,"sessionId":session,
            "requestId":"healthy-relay"}),
            )
            .await;
        assert_eq!(
            client.event("wabidb-call-joined").await["requestId"],
            "healthy-relay"
        );
    }
    sender
        .emit(
            "wabidb-media",
            json!({"sessionId":session,"kind":"audio","seq":0,
        "data":"before-ban-header"}),
        )
        .await;
    assert_eq!(
        allowed.event("wabidb-media").await["data"],
        "before-ban-header"
    );
    assert_eq!(
        removed.event("wabidb-media").await["data"],
        "before-ban-header"
    );
    removed.barrier().await;
    waiting.barrier().await;
    removed.events.clear();
    waiting.events.clear();

    let gate = publication_gate(&state, &channel).lock().await;
    for client in [&mut removed, &mut waiting] {
        client
            .emit(
                "join-wabidb-call",
                json!({"channelId":channel,"sessionId":session,
            "requestId":"queued-relay"}),
            )
            .await;
        client.barrier().await;
        assert!(
            !client.events.iter().any(|event| matches!(
                event[0].as_str(),
                Some("wabidb-call-joined" | "wabidb-media")
            )),
            "relay join/header replay escaped the held publication gate"
        );
    }
    state
        .get_blacklist()
        .await
        .unwrap()
        .restrict_channel(&channel, member as i64, "queued relay join ban", None)
        .await
        .unwrap();
    let mut eviction = Box::pin(wabi_server::socketio::evict_channel_user(
        &io,
        &state,
        &channel,
        member as i64,
    ));
    assert!(futures::poll!(eviction.as_mut()).is_pending());
    drop(gate);
    tokio::time::timeout(Duration::from_secs(3), eviction)
        .await
        .unwrap();
    for client in [&mut removed, &mut waiting] {
        let denied = client.event("wabidb-call-denied").await;
        assert_eq!(denied["sessionId"], session);
        assert_eq!(denied["requestId"], "queued-relay");
        assert_eq!(denied["reason"], "call channel access denied");
    }
    sender
        .emit(
            "wabidb-media",
            json!({"sessionId":session,"kind":"audio","seq":1,
        "data":"after-completed-ban-media"}),
        )
        .await;
    let delivered = allowed.event("wabidb-media").await;
    assert_eq!(delivered["data"], "after-completed-ban-media");
    assert_eq!(delivered["userId"], owner.to_string());
    assert_eq!(delivered["senderSocket"], sender.socket_id);
    for client in [&mut removed, &mut waiting] {
        client.barrier().await;
        assert!(
            !client.events.iter().any(|event| matches!(
                event[0].as_str(),
                Some("wabidb-call-joined" | "wabidb-media")
            )),
            "denied idle client received relay admission/header/live frames: {:?}",
            client.events
        );
    }
    allowed
        .emit(
            "join-wabidb-call",
            json!({"channelId":channel,"sessionId":session,
        "requestId":"healthy-replay"}),
        )
        .await;
    assert_eq!(
        allowed.event("wabidb-call-joined").await["requestId"],
        "healthy-replay"
    );
    assert!(
        allowed
            .events
            .iter()
            .any(|event| event[0] == "wabidb-media"
                && event[1]["data"] == "after-completed-ban-media"),
        "healthy admitted device lost the cached header replay"
    );
}

#[tokio::test]
async fn live_relay_enforces_durable_mute_deafen_and_corrupt_policy_then_recovers() {
    use wabidb::projections::voice_restrictions::{
        decode_deafen, decode_mute, encode_key, DEAFENS, MUTES,
    };

    async fn publish(sender: &SocketClient, session: &str, seq: u64, data: &str) {
        sender
            .emit(
                "wabidb-media",
                json!({"sessionId":session,"kind":"audio","seq":seq,"data":data}),
            )
            .await;
    }
    async fn received(receiver: &mut SocketClient, data: &str) {
        assert_eq!(receiver.event("wabidb-media").await["data"], data);
    }
    async fn not_received(receiver: &mut SocketClient, data: &str) {
        receiver.barrier().await;
        assert!(
            !receiver
                .events
                .iter()
                .any(|event| event[0] == "wabidb-media" && event[1]["data"] == data),
            "current durable restriction leaked {data}: {:?}",
            receiver.events
        );
    }
    async fn join_relay(client: &mut SocketClient, channel: &str, session: &str, request: &str) {
        client
            .emit(
                "join-wabidb-call",
                json!({"channelId":channel,"sessionId":session,"requestId":request}),
            )
            .await;
        assert_eq!(
            client.event("wabidb-call-joined").await["requestId"],
            request
        );
    }

    let directory = tempfile::tempdir().unwrap();
    let state = server(directory.path()).await;
    let (publisher, owner, _) = accounts(&state).await;
    let target = state
        .wdb
        .create_user("moderated receiver", None, "registered-test-hash")
        .await
        .unwrap();
    let channel = unique_relay_channel(&state, "durable relay policy", owner).await;
    for uid in [owner, publisher, target] {
        state
            .wdb
            .add_channel_member(&channel, uid, MemberRole::Member)
            .await
            .unwrap();
    }
    let session = format!("channel:{channel}");
    let app = app(&state);
    let mut sender = SocketClient::connect(&app, &jwt(&state, &claims(publisher, false))).await;
    let mut healthy = SocketClient::connect(&app, &jwt(&state, &claims(owner, false))).await;
    let mut restricted = SocketClient::connect(&app, &jwt(&state, &claims(target, false))).await;
    for client in [&mut sender, &mut healthy, &mut restricted] {
        client
            .emit("voice-channel-join", json!({"channelId":channel}))
            .await;
        client.event("voice-channel-admitted").await;
        join_relay(client, &channel, &session, "healthy-policy-relay").await;
    }
    publish(&sender, &session, 0, "healthy-header").await;
    received(&mut healthy, "healthy-header").await;
    received(&mut restricted, "healthy-header").await;
    assert!(
        wabi_server::socketio::wabidb_header_cache_snapshot(&session)
            .iter()
            .any(|frame| frame["data"] == "healthy-header")
    );

    // Change real durable policy without updating the permissive cached voice
    // roster. An existing relay sender must recheck it on every actual frame.
    state
        .wdb
        .mute_user(&channel, owner, publisher, i64::MAX)
        .await
        .unwrap();
    assert!(state.wdb.is_user_muted(&channel, publisher).await.unwrap());
    publish(&sender, &session, 1, "muted-publisher-drop").await;
    sender.barrier().await;
    not_received(&mut healthy, "muted-publisher-drop").await;
    not_received(&mut restricted, "muted-publisher-drop").await;
    assert!(
        !wabi_server::socketio::wabidb_header_cache_snapshot(&session)
            .iter()
            .any(|frame| frame["data"] == "muted-publisher-drop")
    );
    state
        .wdb
        .unmute_user(&channel, owner, publisher)
        .await
        .unwrap();
    publish(&sender, &session, 1, "unmuted-publisher-recovers").await;
    received(&mut healthy, "unmuted-publisher-recovers").await;
    received(&mut restricted, "unmuted-publisher-recovers").await;

    state
        .wdb
        .deafen_user(&channel, owner, target)
        .await
        .unwrap();
    assert!(state.wdb.is_user_deafened(&channel, target).await.unwrap());
    publish(&sender, &session, 2, "deafened-receiver-drop").await;
    received(&mut healthy, "deafened-receiver-drop").await;
    not_received(&mut restricted, "deafened-receiver-drop").await;
    let mut late = SocketClient::connect(&app, &jwt(&state, &claims(target, false))).await;
    late.emit("voice-channel-join", json!({"channelId":channel}))
        .await;
    late.event("voice-channel-admitted").await;
    late.emit(
        "join-wabidb-call",
        json!({"channelId":channel,"sessionId":session,
        "requestId":"deafened-late-join"}),
    )
    .await;
    assert_eq!(
        late.event("wabidb-call-denied").await["requestId"],
        "deafened-late-join"
    );
    late.barrier().await;
    assert!(!late.events.iter().any(|event| matches!(
        event[0].as_str(),
        Some("wabidb-call-joined" | "wabidb-media")
    )));
    state
        .wdb
        .undeafen_user(&channel, owner, target)
        .await
        .unwrap();
    join_relay(&mut restricted, &channel, &session, "undeafened-rejoin").await;
    restricted.events.retain(|event| event[0] != "wabidb-media");
    publish(&sender, &session, 3, "undeafened-receiver-recovers").await;
    received(&mut healthy, "undeafened-receiver-recovers").await;
    received(&mut restricted, "undeafened-receiver-recovers").await;

    // Corrupt only the exact projection row written by a real mute command.
    state
        .wdb
        .mute_user(&channel, owner, publisher, i64::MAX)
        .await
        .unwrap();
    let projection = state.wdb.engine().projection_state();
    let key = encode_key(&channel, publisher);
    let row = decode_mute(&projection.get(MUTES, &key).unwrap()).unwrap();
    assert_eq!(row.channel_id, channel);
    assert_eq!(row.user_id, publisher);
    projection.insert(
        MUTES,
        key,
        b"CORRUPT-RELAY-MUTE".to_vec(),
        projection.applied_commit_seq(),
    );
    assert!(state.wdb.is_user_muted(&channel, publisher).await.is_err());
    publish(&sender, &session, 0, "corrupt-muted-publisher-drop").await;
    sender.barrier().await;
    not_received(&mut healthy, "corrupt-muted-publisher-drop").await;
    not_received(&mut restricted, "corrupt-muted-publisher-drop").await;
    assert!(
        !wabi_server::socketio::wabidb_header_cache_snapshot(&session)
            .iter()
            .any(|frame| frame["data"] == "corrupt-muted-publisher-drop")
    );
    state
        .wdb
        .unmute_user(&channel, owner, publisher)
        .await
        .unwrap();
    assert!(!state.wdb.is_user_muted(&channel, publisher).await.unwrap());
    publish(&sender, &session, 0, "durable-mute-repair-recovers").await;
    received(&mut healthy, "durable-mute-repair-recovers").await;
    received(&mut restricted, "durable-mute-repair-recovers").await;

    state
        .wdb
        .deafen_user(&channel, owner, target)
        .await
        .unwrap();
    let key = encode_key(&channel, target);
    let row = decode_deafen(&projection.get(DEAFENS, &key).unwrap()).unwrap();
    assert_eq!(row.channel_id, channel);
    assert_eq!(row.user_id, target);
    projection.insert(
        DEAFENS,
        key,
        b"CORRUPT-RELAY-DEAFEN".to_vec(),
        projection.applied_commit_seq(),
    );
    assert!(state.wdb.is_user_deafened(&channel, target).await.is_err());
    publish(&sender, &session, 1, "corrupt-deafened-receiver-drop").await;
    received(&mut healthy, "corrupt-deafened-receiver-drop").await;
    not_received(&mut restricted, "corrupt-deafened-receiver-drop").await;
    late.emit(
        "join-wabidb-call",
        json!({"channelId":channel,"sessionId":session,
        "requestId":"corrupt-deafened-late-join"}),
    )
    .await;
    assert_eq!(
        late.event("wabidb-call-denied").await["requestId"],
        "corrupt-deafened-late-join"
    );
    not_received(&mut late, "corrupt-deafened-receiver-drop").await;
    state
        .wdb
        .undeafen_user(&channel, owner, target)
        .await
        .unwrap();
    assert!(!state.wdb.is_user_deafened(&channel, target).await.unwrap());
    join_relay(
        &mut restricted,
        &channel,
        &session,
        "repaired-deafen-rejoin",
    )
    .await;
    restricted.events.retain(|event| event[0] != "wabidb-media");
    publish(&sender, &session, 4, "durable-deafen-repair-recovers").await;
    received(&mut healthy, "durable-deafen-repair-recovers").await;
    received(&mut restricted, "durable-deafen-repair-recovers").await;
}
