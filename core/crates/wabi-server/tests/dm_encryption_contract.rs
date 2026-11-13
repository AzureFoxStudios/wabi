//! Server-side contract for the experimental DM/group encryption boundary.
//!
//! These tests turn the server-provable parts of the checklist in
//! `docs/PRIVACY_STANCE.md` ("Experimental encryption is not a verified E2EE
//! guarantee") into regressions against the real API router, the real
//! Socket.IO layer, the raw `/ws` socket and real WabiDB storage on disposable
//! data directories. They prove what the Authority accepts and stores. They do
//! not prove anything about client cryptography, key verification, attachments
//! or a malicious Authority: the encryption remains experimental and is not an
//! independently verified operator-blind guarantee.
//!
//! The test client never holds real keys. Device "public keys", wrapped room
//! keys and message ciphertext are opaque random strings in the shapes the
//! server validates; the server cannot tell the difference, which is the point.
use axum::{
    body::{to_bytes, Body},
    http::{Method, Request, StatusCode},
    Router,
};
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tower::ServiceExt;
use wabi_server::{
    api::routes::create_api_router,
    app_router::build_app_router,
    auth_extractor::JwtClaims,
    config::{LoreAddonConfig, ServerConfig, ServerRole},
    state::AppState,
};
use wabidb::{domain::MemberRole, engine::wabi_store::WabiStore};

const PREFIX: &str = "wabi-e2ee-v1:";

// ---------------------------------------------------------------------------
// Fixture: server, credentials, router
// ---------------------------------------------------------------------------

fn server_config(path: &Path) -> ServerConfig {
    ServerConfig {
        host: "127.0.0.1".into(),
        port: 0,
        data_dir: path.to_string_lossy().into_owned(),
        uploads_dir: path.join("uploads").to_string_lossy().into_owned(),
        jwt_secret: "dm-encryption-contract-only".into(),
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

async fn server(path: &Path) -> Arc<AppState> {
    open_server(server_config(path)).await
}

/// A restarted writer may briefly still hold the advisory lock while its disk
/// workers drain. Retry only that, never unlink the lock.
async fn open_server(config: ServerConfig) -> Arc<AppState> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        match AppState::new(config.clone()).await {
            Ok(state) => return Arc::new(state),
            Err(error)
                if error
                    .downcast_ref::<wabidb::error::WabiError>()
                    .is_some_and(|e| matches!(e, wabidb::error::WabiError::AlreadyRunning))
                    && tokio::time::Instant::now() < deadline =>
            {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            Err(error) => panic!("could not open encryption fixture: {error:#}"),
        }
    }
}

fn token(state: &AppState, uid: u64) -> String {
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

fn bearer(state: &AppState, uid: u64) -> String {
    format!("Bearer {}", token(state, uid))
}

/// HTTP only. Use this for any phase that is followed by a restart: the
/// Socket.IO layer and `AppState` hold each other, so a server that ever had
/// the socket layer cannot release its WabiDB writer inside one process.
fn http(state: &Arc<AppState>) -> Router {
    create_api_router(state.clone()).with_state(state.clone())
}

fn router(state: &Arc<AppState>) -> Router {
    create_api_router(state.clone())
        .with_state(state.clone())
        .layer(wabi_server::socketio::create_socket_layer(state.clone()))
}

async fn request(
    app: &Router,
    method: Method,
    path: &str,
    authorization: &str,
    body: Value,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header("authorization", authorization);
    let body = if body.is_null() {
        Body::empty()
    } else {
        builder = builder.header("content-type", "application/json");
        Body::from(body.to_string())
    };
    let response = app.clone().oneshot(builder.body(body).unwrap()).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 4 * 1024 * 1024).await.unwrap();
    let value = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| json!(String::from_utf8_lossy(&bytes)));
    (status, value)
}

async fn user(state: &AppState, name: &str) -> u64 {
    state
        .wdb
        .create_user(name, None, "registered-test-hash")
        .await
        .unwrap()
}

// ---------------------------------------------------------------------------
// Socket.IO polling client (same protocol fixture as message_delivery_contract)
// ---------------------------------------------------------------------------

struct Client {
    app: Router,
    sid: String,
    events: Vec<Value>,
}

impl Client {
    async fn transport(app: &Router, method: Method, path: &str, body: String) -> String {
        let response = tokio::time::timeout(
            Duration::from_secs(5),
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
        .expect("socket timeout")
        .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        String::from_utf8(to_bytes(response.into_body(), 4 * 1024 * 1024).await.unwrap().to_vec())
            .unwrap()
    }
    fn path(&self) -> String {
        format!("/socket.io/?EIO=4&transport=polling&sid={}", self.sid)
    }
    async fn connect(app: &Router, token: &str) -> Self {
        let open =
            Self::transport(app, Method::GET, "/socket.io/?EIO=4&transport=polling", String::new())
                .await;
        let handshake: Value = serde_json::from_str(open.strip_prefix('0').unwrap()).unwrap();
        let mut client = Self {
            app: app.clone(),
            sid: handshake["sid"].as_str().unwrap().into(),
            events: vec![],
        };
        Self::transport(app, Method::POST, &client.path(), format!("40{}", json!({"token":token})))
            .await;
        let connected = Self::transport(app, Method::GET, &client.path(), String::new()).await;
        assert!(connected.starts_with("40"), "{connected}");
        client.emit("join", json!("encryption contract")).await;
        client.event("init").await;
        client
    }
    async fn emit(&self, event: &str, payload: Value) {
        Self::transport(&self.app, Method::POST, &self.path(), format!("42{}", json!([event, payload])))
            .await;
    }
    async fn event(&mut self, name: &str) -> Value {
        self.event_one_of(&[name]).await.1
    }
    async fn event_one_of(&mut self, names: &[&str]) -> (String, Value) {
        for _ in 0..30 {
            if let Some(index) = self
                .events
                .iter()
                .position(|event| names.iter().any(|name| event[0] == *name))
            {
                let event = self.events.remove(index);
                return (event[0].as_str().unwrap().into(), event[1].clone());
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
        panic!("missing {names:?} event; buffered: {:?}", self.events);
    }
    /// Send a chat message and return ("message-accepted" | "message-error", payload).
    async fn send(&mut self, payload: Value) -> (String, Value) {
        self.emit("message", payload).await;
        self.event_one_of(&["message-accepted", "message-error"]).await
    }
    /// Everything this client has seen so far, for leak scans.
    async fn drain(&mut self) -> String {
        let batch = Self::transport(&self.app, Method::GET, &self.path(), String::new()).await;
        format!("{batch}{}", serde_json::to_string(&self.events).unwrap())
    }
}

// ---------------------------------------------------------------------------
// Opaque key material and envelopes in the shapes the server validates
// ---------------------------------------------------------------------------

/// 44 base64-alphabet characters: passes the server's public-key shape check.
fn opaque_key() -> String {
    format!("{}AAAAAAAAAAAA", uuid::Uuid::new_v4().simple())
}

fn device_id(uid: u64, n: u32) -> String {
    format!("device-{uid}-{n}")
}

async fn register_device(app: &Router, state: &AppState, uid: u64, device: &str) {
    let (status, body) = request(
        app,
        Method::POST,
        "/e2ee/devices",
        &bearer(state, uid),
        json!({"deviceId":device,"label":"contract","encryptionPublicKey":opaque_key(),"signingPublicKey":opaque_key()}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "device registration refused: {body}");
}

async fn room_status(app: &Router, state: &AppState, uid: u64, ch: &str) -> (StatusCode, Value) {
    request(app, Method::GET, &format!("/e2ee/channels/{ch}"), &bearer(state, uid), Value::Null).await
}

fn wrapped(recipient: u64, recipient_device: &str, sender_device: &str) -> Value {
    json!({
        "recipientUserId": recipient, "recipientDeviceId": recipient_device,
        "ephemeralPublicKey": opaque_key(), "salt": "c2FsdA", "iv": "aXY",
        "ciphertext": format!("wrapped-{}", uuid::Uuid::new_v4().simple()),
        "senderDeviceId": sender_device, "signature": "c2ln",
    })
}

/// Enable (or rekey) the room as `actor` with keys wrapped to `recipients`.
async fn set_room(
    app: &Router,
    state: &AppState,
    actor: (u64, &str),
    ch: &str,
    epoch: u64,
    recipients: &[(u64, String)],
    rekey: bool,
) -> (StatusCode, Value) {
    let (_, status) = room_status(app, state, actor.0, ch).await;
    let revision = status["currentMembershipRevision"].as_str().unwrap_or("0").to_string();
    let envelopes: Vec<Value> =
        recipients.iter().map(|(uid, device)| wrapped(*uid, device, actor.1)).collect();
    request(
        app,
        Method::POST,
        &format!("/e2ee/channels/{ch}/{}", if rekey { "rekey" } else { "enable" }),
        &bearer(state, actor.0),
        json!({"senderDeviceId":actor.1,"epoch":epoch,"membershipRevision":revision,"envelopes":envelopes}),
    )
    .await
}

fn b64(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Opaque bytes in the sizes the client's AES-GCM / ECDSA output has.
fn random_bytes(len: usize) -> Vec<u8> {
    (0..len.div_ceil(16)).flat_map(|_| *uuid::Uuid::new_v4().as_bytes()).take(len).collect()
}

fn envelope(ch: &str, epoch: u64, revision: &str, sender_device: &str) -> String {
    format!(
        "{PREFIX}{}",
        json!({
            "v": 1, "room": ch, "epoch": epoch, "membershipRevision": revision,
            "senderDeviceId": sender_device, "iv": b64(&random_bytes(12)),
            "ciphertext": b64(&random_bytes(48)),
            "signature": b64(&random_bytes(64)),
        })
    )
}

async fn current_revision(app: &Router, state: &AppState, uid: u64, ch: &str) -> String {
    let (status, body) = room_status(app, state, uid, ch).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["currentMembershipRevision"].as_str().unwrap().to_string()
}

/// A group of `names` with one registered device each and encryption enabled.
/// Created as an existing (pre-policy) room, so only the room registry entry
/// stands between plaintext and storage: the strictest case for these tests.
struct Room {
    ch: String,
    users: Vec<u64>,
    devices: Vec<String>,
}

impl Room {
    fn device(&self, i: usize) -> (u64, &str) {
        (self.users[i], self.devices[i].as_str())
    }
    fn recipients(&self, members: &[usize]) -> Vec<(u64, String)> {
        members.iter().map(|&i| (self.users[i], self.devices[i].clone())).collect()
    }
    async fn envelope(&self, app: &Router, state: &AppState, sender: usize, epoch: u64) -> String {
        let revision = current_revision(app, state, self.users[sender], &self.ch).await;
        envelope(&self.ch, epoch, &revision, &self.devices[sender])
    }
}

async fn encrypted_group(app: &Router, state: &AppState, id: &str, names: &[&str]) -> Room {
    let mut users = vec![];
    for name in names {
        users.push(user(state, &format!("{id}-{name}")).await);
    }
    let ch = format!("group-{id}");
    state.wdb.create_group(&ch, id, users[0], &users).await.unwrap();
    let mut devices = vec![];
    for &uid in &users {
        let device = device_id(uid, 1);
        register_device(app, state, uid, &device).await;
        devices.push(device);
    }
    let room = Room { ch, users, devices };
    let all: Vec<usize> = (0..room.users.len()).collect();
    let (status, body) =
        set_room(app, state, room.device(0), &room.ch, 1, &room.recipients(&all), false).await;
    assert_eq!(status, StatusCode::OK, "enable: {body}");
    room
}

async fn stored(state: &AppState, ch: &str) -> Vec<String> {
    state
        .wdb
        .list_messages_typed(ch, 1000)
        .await
        .unwrap()
        .into_iter()
        .map(|m| m.content)
        .collect()
}

fn all_ciphertext(contents: &[String]) -> bool {
    contents.iter().all(|c| c.starts_with(PREFIX))
}

// ---------------------------------------------------------------------------
// Message entry paths
// ---------------------------------------------------------------------------

/// A refusal must come from the privacy boundary, not from a malformed probe.
fn policy_refusal(path: &str, status: StatusCode, body: &Value) {
    assert!(
        status == StatusCode::FORBIDDEN || status == StatusCode::BAD_REQUEST,
        "{path} refused for the wrong reason ({status}): {body}"
    );
    assert_policy_reason(path, body);
}

fn assert_policy_reason(path: &str, body: &Value) {
    let text = body.to_string().to_lowercase();
    assert!(
        ["encrypt", "server-readable", "e2ee"].iter().any(|word| text.contains(word)),
        "{path} was refused, but not by the encryption policy: {body}"
    );
}

/// Every server path that can put readable text into a channel, driven with
/// plaintext from a participant. Returns the paths that ACCEPTED plaintext.
async fn plaintext_entry_paths(
    app: &Router,
    state: &AppState,
    sio: &mut Client,
    uid: u64,
    ch: &str,
    marker: &str,
    tag: &str,
) -> Vec<String> {
    let mut accepted = vec![];
    let auth = bearer(state, uid);

    // Socket.IO `message`: plain text.
    let (event, body) = sio
        .send(json!({"channelId":ch,"clientMessageId":format!("{tag}-sio"),"text":format!("{marker} socket")}))
        .await;
    if event == "message-accepted" {
        accepted.push(format!("socket.io message ({body})"));
    } else {
        assert_eq!(body["code"], "e2ee_required", "{body}");
    }

    // Socket.IO `message` shaped as a reply/quote/forward: the client sends
    // quoted or forwarded text in `replyTo`/`entities` beside `text`.
    let (event, body) = sio
        .send(json!({
            "channelId":ch,"clientMessageId":format!("{tag}-reply"),"text":format!("{marker} reply"),
            "replyTo":{"id":"msg_x","text":format!("{marker} quoted")},
            "entities":[{"type":"quote","text":format!("{marker} forwarded")}],
        }))
        .await;
    if event == "message-accepted" {
        accepted.push(format!("socket.io reply/quote ({body})"));
    } else {
        assert_eq!(body["code"], "e2ee_required", "{body}");
    }

    // REST POST /api/messages.
    let (status, body) = request(
        app,
        Method::POST,
        "/messages",
        &auth,
        json!({"channel_id":ch,"content":format!("{marker} rest")}),
    )
    .await;
    if status.is_success() {
        accepted.push(format!("REST /api/messages ({body})"));
    } else {
        policy_refusal("REST /api/messages", status, &body);
    }

    // Shared conversation notes (readable form is a JSON title/text payload).
    let (status, body) = request(
        app,
        Method::POST,
        &format!("/conversation-notes/{ch}"),
        &auth,
        json!({"content": json!({"title":"note","text":format!("{marker} note")}).to_string()}),
    )
    .await;
    if status.is_success() {
        accepted.push(format!("REST conversation note ({body})"));
    } else {
        policy_refusal("REST conversation note", status, &body);
    }

    // Forum thread / post (REST) and thread creation (Socket.IO).
    let (status, body) = request(
        app,
        Method::POST,
        &format!("/forum/{ch}/threads"),
        &auth,
        json!({"title":format!("{marker} thread title"),"body":format!("{marker} thread body")}),
    )
    .await;
    if status.is_success() {
        accepted.push(format!("REST forum thread ({body})"));
        let thread = body["thread_id"].as_str().unwrap_or("").to_string();
        let (status, body) = request(
            app,
            Method::POST,
            &format!("/forum/{ch}/threads/{thread}/posts"),
            &auth,
            json!({"body":format!("{marker} forum post")}),
        )
        .await;
        if status.is_success() {
            accepted.push(format!("REST forum post ({body})"));
        } else {
            policy_refusal("REST forum post", status, &body);
        }
    } else {
        policy_refusal("REST forum thread", status, &body);
    }
    sio.emit("create-thread", json!({"parentChannelId":ch,"name":format!("{marker} socket thread")}))
        .await;
    let (event, body) = sio.event_one_of(&["thread-created", "create-thread-error"]).await;
    if event == "thread-created" {
        accepted.push(format!("socket.io create-thread ({body})"));
    } else {
        assert_policy_reason("socket.io create-thread", &body);
    }
    accepted
}

/// Point 1 for the message-shaped paths: Socket.IO `message` (plain and with
/// reply/quote metadata), REST `/api/messages`, shared conversation notes,
/// forum threads/posts and Socket.IO `create-thread`, the bot post and the
/// Socket.IO edit. Run for an existing room that a participant enabled and
/// for a new DM that went pending -> enabled through the real create path.
/// The other surfaces are covered by
/// `feature_surfaces_refuse_readable_text_in_encrypted_and_pending_conversations`
/// (wiki, albums, gallery, incidents, whiteboards, uploads) and
/// `encrypted_messages_carry_only_server_issued_upload_references` (files).
#[tokio::test]
async fn plaintext_is_refused_on_message_note_forum_bot_and_edit_paths_of_an_encrypted_room() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let app = router(&state);
    let marker = format!("PLAINTEXT-{}", uuid::Uuid::new_v4().simple());

    // (a) existing group, manually enabled.
    let group = encrypted_group(&app, &state, "enc-paths", &["a", "b"]).await;
    // (b) new DM: created pending through the real path, then enabled.
    let a = group.users[0];
    let c = user(&state, "enc-paths-c").await;
    let mut sio_a = Client::connect(&app, &token(&state, a)).await;
    sio_a.emit("create-dm", json!({"targetUserId":format!("user-{c}")})).await;
    let dm = sio_a.event("dm-created").await["channelId"].as_str().unwrap().to_string();
    let c_device = device_id(c, 1);
    register_device(&app, &state, c, &c_device).await;
    let (status, body) = set_room(
        &app,
        &state,
        group.device(0),
        &dm,
        1,
        &[(a, group.devices[0].clone()), (c, c_device.clone())],
        false,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "enable new DM: {body}");

    // A bot that is a participant of the group.
    let bot = user(&state, "enc-paths-bot").await;
    let (bot_token, _) = state.bot_registry.create(bot).await.unwrap();
    // Adding it changes the membership revision; the room is rekeyed after the
    // bot probe (a member without a device cannot be included in a rekey).
    state.wdb.add_channel_member(&group.ch, bot, MemberRole::Member).await.unwrap();

    for ch in [group.ch.as_str(), dm.as_str()] {
        let accepted =
            plaintext_entry_paths(&app, &state, &mut sio_a, a, ch, &marker, &format!("p1-{ch}")).await;
        assert!(accepted.is_empty(), "{ch}: plaintext accepted by {accepted:#?}");
    }

    // Bot / webhook-style post: refused whenever the room is encrypted.
    let (status, body) = request(
        &app,
        Method::POST,
        "/bot/send-message",
        &format!("Bot {bot_token}"),
        json!({"channel_id":group.ch,"content":format!("{marker} bot")}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "bot post: {body}");
    assert_policy_reason("bot post", &body);
    state.wdb.remove_channel_member(&group.ch, bot).await.unwrap();
    let all: Vec<usize> = vec![0, 1];
    let (status, body) =
        set_room(&app, &state, group.device(0), &group.ch, 2, &group.recipients(&all), true).await;
    assert_eq!(status, StatusCode::OK, "rekey after bot removal: {body}");

    // Positive control: the same paths accept a valid envelope where they
    // support one, so the refusals above are about plaintext, not breakage.
    let ciphertext = group.envelope(&app, &state, 0, 2).await;
    let (event, body) = sio_a
        .send(json!({"channelId":group.ch,"clientMessageId":"p1-cipher","text":ciphertext}))
        .await;
    assert_eq!(event, "message-accepted", "{body}");
    let cipher_id = body["messageId"].as_str().unwrap().to_string();
    let (status, body) = request(
        &app,
        Method::POST,
        "/messages",
        &bearer(&state, a),
        json!({"channel_id":group.ch,"content":group.envelope(&app, &state, 0, 2).await}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "REST envelope: {body}");

    // Wrong room / stale epoch envelopes are refused like plaintext.
    let other_room = envelope(&dm, 2, &current_revision(&app, &state, a, &group.ch).await, &group.devices[0]);
    let stale = group.envelope(&app, &state, 0, 1).await;
    for text in [other_room, stale] {
        let (event, body) = sio_a
            .send(json!({"channelId":group.ch,"clientMessageId":"p1-wrong","text":text}))
            .await;
        assert_eq!(event, "message-error", "{body}");
    }

    // Edit of an existing ciphertext message with plaintext (Socket.IO is the
    // only edit path the server has).
    sio_a
        .emit("edit-message", json!({"channelId":group.ch,"messageId":cipher_id,"newText":format!("{marker} edit")}))
        .await;
    let edit_error = sio_a.event("edit-error").await;
    assert!(edit_error["error"].as_str().unwrap().contains("encrypted"), "{edit_error}");

    // A ciphertext message with plaintext reply/quote/GIF metadata: the
    // envelope is accepted, and that metadata is neither stored nor relayed.
    // (File references beside an envelope have their own test.)
    let quoted = group.envelope(&app, &state, 0, 2).await;
    let (event, body) = sio_a
        .send(json!({
            "channelId":group.ch,"clientMessageId":"p1-quoted","text":quoted,
            "replyTo":{"id":cipher_id,"text":format!("{marker} quoted beside ciphertext")},
            "entities":[{"type":"quote","text":format!("{marker} entity")}],
            "gifUrl": format!("https://example.invalid/{marker}"), "emojiName": format!("{marker} emoji"),
        }))
        .await;
    assert_eq!(event, "message-accepted", "{body}");

    for ch in [group.ch.as_str(), dm.as_str()] {
        let contents = stored(&state, ch).await;
        assert!(all_ciphertext(&contents), "{ch} stored plaintext: {contents:?}");
        assert!(!contents.iter().any(|c| c.contains(&marker)));
        assert!(state.wdb.list_forum_threads(ch).await.unwrap().is_empty(), "{ch} forum threads stored");
        let session = state.session_messages.read().await;
        let cached = serde_json::to_string(&session.get(ch)).unwrap();
        assert!(!cached.contains(&marker), "{ch} session cache kept plaintext: {cached}");
    }
    let seen = sio_a.drain().await;
    assert!(!seen.contains(&format!("{marker} quoted beside")), "relayed reply plaintext: {seen}");
    assert!(!seen.contains(&format!("example.invalid/{marker}")), "relayed GIF URL: {seen}");
    assert!(!seen.contains(&format!("{marker} emoji")), "relayed emoji name: {seen}");
    let notes = std::fs::read_to_string(dir.path().join("conversation_notes.json")).unwrap_or_default();
    assert!(!notes.contains(&marker));
}

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

fn ws_text(value: Value) -> tokio_tungstenite::tungstenite::Message {
    tokio_tungstenite::tungstenite::Message::Text(value.to_string().into())
}

async fn ws_next(ws: &mut Ws) -> Value {
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
                other => return json!({"other": other.to_string()}),
            }
        }
    })
    .await
    .expect("raw socket reply timed out")
}

/// Forum text has no encrypted form. A room's forum keeps working while it is
/// server-readable; once experimental encryption is enabled, neither a new
/// thread nor a rewrite of an existing post is accepted.
#[tokio::test]
async fn forum_text_follows_the_plaintext_boundary_before_and_after_encryption() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let app = http(&state);
    let a = user(&state, "forum-a").await;
    let b = user(&state, "forum-b").await;
    let ch = "group-forum-boundary";
    state.wdb.create_group(ch, "forum", a, &[a, b]).await.unwrap();
    let auth = bearer(&state, a);
    let (status, thread) = request(
        &app,
        Method::POST,
        &format!("/forum/{ch}/threads"),
        &auth,
        json!({"title":"readable","body":"written while server-readable"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "readable room forum: {thread}");
    let thread_id = thread["thread_id"].as_str().unwrap().to_string();
    let (status, _) = request(
        &app,
        Method::POST,
        &format!("/forum/{ch}/threads/{thread_id}/posts"),
        &auth,
        json!({"body":"readable reply"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    for (uid, device) in [(a, device_id(a, 1)), (b, device_id(b, 1))] {
        register_device(&app, &state, uid, &device).await;
    }
    let (status, body) = set_room(
        &app,
        &state,
        (a, &device_id(a, 1)),
        ch,
        1,
        &[(a, device_id(a, 1)), (b, device_id(b, 1))],
        false,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = request(
        &app,
        Method::PUT,
        &format!("/forum/{ch}/threads/{thread_id}/posts/{thread_id}"),
        &auth,
        json!({"title":"readable","body":"PLAINTEXT rewrite after encryption"}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "rewrite after encryption: {body}");
    let posts = state.wdb.list_forum_posts(ch, &thread_id).await.unwrap();
    assert!(!serde_json::to_string(&posts).unwrap().contains("PLAINTEXT rewrite"));
}

/// The raw `/ws` socket is call-state only: it has no message ingress at all,
/// so a message-shaped frame is refused and nothing is written.
#[tokio::test]
async fn raw_websocket_has_no_message_entry_path() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let app = router(&state);
    let room = encrypted_group(&app, &state, "raw-ws", &["a", "b"]).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/ws", listener.local_addr().unwrap());
    let serve_state = state.clone();
    let server_task = tokio::spawn(async move {
        axum::serve(
            listener,
            build_app_router(serve_state)
                .into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap();
    });
    let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    ws.send(ws_text(json!({"type":"authenticate","token":token(&state, room.users[0])}))).await.unwrap();
    assert_eq!(ws_next(&mut ws).await["type"], "authenticated");
    for frame in [
        json!({"type":"message","channelId":room.ch,"text":"raw-ws plaintext"}),
        json!({"type":"send_message","channel_id":room.ch,"content":"raw-ws plaintext"}),
        json!({"type":"subscribe_call","session_id":"x","since":0,"content":"raw-ws plaintext"}),
    ] {
        ws.send(ws_text(frame)).await.unwrap();
        assert_eq!(ws_next(&mut ws).await["type"], "error");
    }
    assert!(stored(&state, &room.ch).await.is_empty());
    server_task.abort();
}

// ---------------------------------------------------------------------------
// Point 1 + 2: new rooms in pending-encryption mode
// ---------------------------------------------------------------------------

#[tokio::test]
async fn pending_room_refuses_plaintext_until_each_sender_consents_or_encryption_is_enabled() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let app = router(&state);
    let marker = format!("PENDING-{}", uuid::Uuid::new_v4().simple());
    let a = user(&state, "pending-a").await;
    let b = user(&state, "pending-b").await;
    let c = user(&state, "pending-c").await;
    let mut sio_a = Client::connect(&app, &token(&state, a)).await;
    let mut sio_b = Client::connect(&app, &token(&state, b)).await;

    // New group through the real create path (marks pending before the
    // channel becomes visible).
    sio_a
        .emit(
            "create-group",
            json!({"requestId":uuid::Uuid::new_v4().to_string(),"groupName":"pending","userIds":[format!("user-{b}"),format!("user-{c}")]}),
        )
        .await;
    let created = sio_a.event("group-created").await;
    let group = created["channelId"].as_str().unwrap().to_string();
    let (_, status) = room_status(&app, &state, a, &group).await;
    assert_eq!(status["pendingDefault"], true, "{status}");

    for (sio, uid) in [(&mut sio_a, a), (&mut sio_b, b)] {
        let accepted = plaintext_entry_paths(&app, &state, sio, uid, &group, &marker, "pending").await;
        assert!(accepted.is_empty(), "pending room accepted plaintext: {accepted:#?}");
    }
    // An envelope is not accepted either: the room has no key yet.
    let (event, _) = sio_a
        .send(json!({"channelId":group,"clientMessageId":"pending-env","text":envelope(&group, 1, "1", "device-x-1")}))
        .await;
    assert_eq!(event, "message-error");
    assert!(stored(&state, &group).await.is_empty());

    // a explicitly chooses server-readable: only a's plaintext is admitted.
    let (status, body) = request(
        &app,
        Method::POST,
        &format!("/e2ee/channels/{group}/allow-server-readable"),
        &bearer(&state, a),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (event, body) = sio_a
        .send(json!({"channelId":group,"clientMessageId":"a-consented","text":"a chose server-readable"}))
        .await;
    assert_eq!(event, "message-accepted", "{body}");
    let (status, _) = request(
        &app,
        Method::POST,
        "/messages",
        &bearer(&state, a),
        json!({"channel_id":group,"content":"a chose server-readable over REST"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    // b has not consented: every path still refuses b.
    let accepted = plaintext_entry_paths(&app, &state, &mut sio_b, b, &group, &marker, "b-no-consent").await;
    assert!(accepted.is_empty(), "a's consent admitted b's plaintext via {accepted:#?}");
    let (_, b_status) = room_status(&app, &state, b, &group).await;
    assert_eq!(b_status["serverReadableAllowedByMe"], false);
    assert_eq!(b_status["serverReadableSelected"], true);
    let contents = stored(&state, &group).await;
    assert_eq!(contents.len(), 2, "{contents:?}");
    assert!(!contents.iter().any(|m| m.contains(&marker)));

    // Second pending group: enabling encryption ends the pending state, and
    // consent can no longer be given.
    sio_a
        .emit(
            "create-group",
            json!({"requestId":uuid::Uuid::new_v4().to_string(),"groupName":"pending-2","userIds":[format!("user-{b}")]}),
        )
        .await;
    let second = sio_a.event("group-created").await["channelId"].as_str().unwrap().to_string();
    for (uid, device) in [(a, device_id(a, 1)), (b, device_id(b, 1))] {
        register_device(&app, &state, uid, &device).await;
    }
    let (status, body) = set_room(
        &app,
        &state,
        (a, &device_id(a, 1)),
        &second,
        1,
        &[(a, device_id(a, 1)), (b, device_id(b, 1))],
        false,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, _) = request(
        &app,
        Method::POST,
        &format!("/e2ee/channels/{second}/allow-server-readable"),
        &bearer(&state, b),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let accepted = plaintext_entry_paths(&app, &state, &mut sio_b, b, &second, &marker, "enabled").await;
    assert!(accepted.is_empty(), "{accepted:#?}");
}

// ---------------------------------------------------------------------------
// Point 7: no silent downgrade
// ---------------------------------------------------------------------------

#[tokio::test]
async fn encrypted_room_cannot_be_downgraded_by_api_role_membership_or_restart() {
    let dir = tempfile::tempdir().unwrap();
    let mut config = server_config(dir.path());
    let state = open_server(config.clone()).await;
    let app = http(&state);
    let room = encrypted_group(&app, &state, "downgrade", &["owner", "admin", "member"]).await;
    let (owner, admin, member) = (room.users[0], room.users[1], room.users[2]);
    state.wdb.claim_owner(owner).await.unwrap();
    let all = [0usize, 1, 2];
    let (status, body) = request(
        &app,
        Method::POST,
        "/messages",
        &bearer(&state, member),
        json!({"channel_id":room.ch,"content":room.envelope(&app, &state, 2, 1).await}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let member_message = body["id"].as_str().unwrap().to_string();
    drop(app);
    drop(state);

    // Restart (with one more admin by configuration): the registry is durable.
    config.admin_user_ids = vec![admin as i64];
    let state = open_server(config.clone()).await;
    *state.owner_user_id.write().await = Some(owner as i64);
    let app = http(&state);
    let (_, status) = room_status(&app, &state, owner, &room.ch).await;
    assert_eq!(status["enabled"], true, "{status}");
    let (status, _) = request(
        &app,
        Method::POST,
        "/messages",
        &bearer(&state, owner),
        json!({"channel_id":room.ch,"content":"plaintext after restart"}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // A damaged registry fails closed for every room, and is not rewritten.
    let registry = dir.path().join("e2ee_state.json");
    let original = std::fs::read(&registry).unwrap();
    std::fs::write(&registry, b"{damaged").unwrap();
    let (status, _) = request(
        &app,
        Method::POST,
        "/messages",
        &bearer(&state, owner),
        json!({"channel_id":room.ch,"content":"plaintext with damaged registry"}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = request(
        &app,
        Method::POST,
        &format!("/e2ee/channels/{}/allow-server-readable", room.ch),
        &bearer(&state, owner),
        Value::Null,
    )
    .await;
    assert!(!status.is_success());
    assert_eq!(std::fs::read(&registry).unwrap(), b"{damaged");
    std::fs::write(&registry, &original).unwrap();
    drop(app);

    // Staff roles (owner by claim, admin by configuration) do not unlock plaintext.
    let app = router(&state);
    assert!(state.is_admin(admin as i64).await, "fixture: admin role");
    assert!(state.is_owner(owner as i64).await, "fixture: owner role");
    let mut sio_owner = Client::connect(&app, &token(&state, owner)).await;
    let mut sio_admin = Client::connect(&app, &token(&state, admin)).await;
    for (sio, uid, name) in [(&mut sio_owner, owner, "owner"), (&mut sio_admin, admin, "admin")] {
        let (event, body) = sio
            .send(json!({"channelId":room.ch,"clientMessageId":format!("{name}-pt"),"text":format!("{name} plaintext")}))
            .await;
        assert_eq!(event, "message-error", "{name}: {body}");
        // Choosing server-readable on an encrypted room is a conflict for anyone.
        let (status, _) = request(
            &app,
            Method::POST,
            &format!("/e2ee/channels/{}/allow-server-readable", room.ch),
            &bearer(&state, uid),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT, "{name} downgrade");
        // Staff cannot overwrite a member's ciphertext with plaintext.
        sio.emit("edit-message", json!({"channelId":room.ch,"messageId":member_message,"newText":format!("{name} rewrote it")}))
            .await;
        sio.event("edit-error").await;
    }
    // Re-enable (which could reset the room) is refused; a rekey that drops a
    // member device is refused.
    let (status, _) =
        set_room(&app, &state, room.device(0), &room.ch, 1, &room.recipients(&all), false).await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, _) =
        set_room(&app, &state, room.device(0), &room.ch, 2, &room.recipients(&[0, 1]), true).await;
    assert_ne!(status, StatusCode::OK, "rekey that drops a member device");
    let (_, status) = room_status(&app, &state, member, &room.ch).await;
    assert_eq!(status["enabled"], true);
    assert_eq!(status["downgradeAllowed"], false);

    // The author cannot replace their own ciphertext with plaintext either.
    let mut sio_member = Client::connect(&app, &token(&state, member)).await;
    sio_member
        .emit("edit-message", json!({"channelId":room.ch,"messageId":member_message,"newText":"author plaintext edit"}))
        .await;
    sio_member.event("edit-error").await;

    // Device revocation pauses all sends until rekey; it never opens plaintext.
    let (status, _) = request(
        &app,
        Method::DELETE,
        &format!("/e2ee/devices/{}", room.devices[2]),
        &bearer(&state, member),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (event, _) = sio_member
        .send(json!({"channelId":room.ch,"clientMessageId":"after-revoke","text":"plaintext after revoke"}))
        .await;
    assert_eq!(event, "message-error");
    let new_device = device_id(member, 2);
    register_device(&app, &state, member, &new_device).await;
    let mut recipients = room.recipients(&[0, 1]);
    recipients.push((member, new_device.clone()));
    let (status, body) = set_room(&app, &state, room.device(0), &room.ch, 2, &recipients, true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (_, status) = room_status(&app, &state, member, &room.ch).await;
    assert_eq!(status["enabled"], true);

    // Membership change: adding someone moves the revision; still no plaintext.
    let late = user(&state, "downgrade-late").await;
    state.wdb.add_channel_member(&room.ch, late, MemberRole::Member).await.unwrap();
    let mut sio_late = Client::connect(&app, &token(&state, late)).await;
    for (sio, name) in [(&mut sio_late, "late"), (&mut sio_member, "member")] {
        let (event, body) = sio
            .send(json!({"channelId":room.ch,"clientMessageId":format!("{name}-after-add"),"text":"plaintext after add"}))
            .await;
        assert_eq!(event, "message-error", "{name}: {body}");
    }
    let contents = stored(&state, &room.ch).await;
    assert_eq!(contents.len(), 1);
    assert!(all_ciphertext(&contents), "{contents:?}");
}

// ---------------------------------------------------------------------------
// Point 7, durable marker: a missing or older registry never reopens a room
// ---------------------------------------------------------------------------
//
// WabiDB keeps a per-room encryption marker (`room_encryption` projection),
// written before the registry entry. A registry that is missing, older (lower
// epoch) or weaker (no entry, pending where the database says encrypted)
// than the marker refuses readable content in that room. Restoring a copy of
// `e2ee_state.json` into a stopped Authority is how these tests "lose" or
// "roll back" the registry; an atomic rename means a crash between the two
// writes leaves the file exactly as it was before the transition, so the
// same restore also reproduces that crash.

fn registry_file(dir: &Path) -> PathBuf {
    dir.join("e2ee_state.json")
}

fn install_registry(dir: &Path, bytes: Option<&[u8]>) {
    match bytes {
        Some(bytes) => std::fs::write(registry_file(dir), bytes).unwrap(),
        None => {
            let _ = std::fs::remove_file(registry_file(dir));
        }
    }
}

fn read_model_file(dir: &Path) -> PathBuf {
    dir.join("wabidb/projections/read-model.sqlite3")
}

fn snapshot_file(dir: &Path) -> PathBuf {
    dir.join("wabidb/projections/snapshot.json")
}

fn copy_tree(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

/// A new group through the same order as the real create path: pending
/// policy (marker, then registry) before the channel exists. HTTP-only tests
/// cannot use the Socket.IO `create-group` event and still restart.
async fn pending_group(state: &Arc<AppState>, id: &str, users: &[u64]) -> String {
    let ch = format!("group-{id}");
    wabi_server::api::e2ee::mark_new_room_pending(state, &ch).await.unwrap();
    state.wdb.create_group(&ch, id, users[0], users).await.unwrap();
    ch
}

fn room_marker(state: &AppState, ch: &str) -> Option<(room_encryption::RoomEncryptionMode, u64)> {
    room_encryption::get(state.wdb.engine().projection_state(), ch)
        .unwrap()
        .map(|record| (record.mode, record.epoch))
}

use wabidb::projections::room_encryption::{self, RoomEncryptionMode as Mode};

/// The refusal names the registry and what to restore: the operator-facing
/// reason, not a generic one.
fn assert_registry_reason(path: &str, body: &Value) {
    assert!(body.to_string().contains("e2ee_state.json"), "{path}: refusal does not name the registry: {body}");
}

/// Every readable-content path that needs no Socket.IO connection, as `uid`.
/// Returns the paths that ACCEPTED readable content.
async fn http_entry_paths(
    app: &Router,
    state: &AppState,
    uid: u64,
    ch: &str,
    m: &str,
    bot_token: &str,
    seeds: Option<&Seeds>,
) -> Vec<String> {
    let auth = bearer(state, uid);
    let mut accepted = vec![];
    let (status, body) = request(app, Method::POST, "/messages", &auth, json!({"channel_id":ch,"content":format!("{m} rest")})).await;
    if status.is_success() {
        accepted.push(format!("REST /api/messages ({body})"));
    } else {
        policy_refusal("REST /api/messages", status, &body);
        assert_registry_reason("REST /api/messages", &body);
    }
    let (status, body) = request(
        app,
        Method::POST,
        &format!("/conversation-notes/{ch}"),
        &auth,
        json!({"content": json!({"title":"note","text":format!("{m} note")}).to_string()}),
    )
    .await;
    if status.is_success() {
        accepted.push(format!("REST conversation note ({body})"));
    } else {
        policy_refusal("REST conversation note", status, &body);
    }
    let (status, body) = request(
        app,
        Method::POST,
        &format!("/forum/{ch}/threads"),
        &auth,
        json!({"title":format!("{m} thread title"),"body":format!("{m} thread body")}),
    )
    .await;
    if status.is_success() {
        accepted.push(format!("REST forum thread ({body})"));
    } else {
        policy_refusal("REST forum thread", status, &body);
        assert_registry_reason("REST forum thread", &body);
    }
    let (status, body) = request(
        app,
        Method::POST,
        "/bot/send-message",
        &format!("Bot {bot_token}"),
        json!({"channel_id":ch,"content":format!("{m} bot")}),
    )
    .await;
    if status.is_success() {
        accepted.push(format!("bot post ({body})"));
    } else {
        policy_refusal("bot post", status, &body);
        assert_registry_reason("bot post", &body);
    }
    accepted.extend(feature_text_paths(app, &auth, None, ch, m, seeds, true).await);
    accepted
}

/// Rooms in every state the marker records, built over HTTP only.
struct MarkerRooms {
    a: u64,
    b: u64,
    bot_token: String,
    /// Existing group, readable features seeded, encrypted at 1 then 2, with
    /// a ciphertext message.
    hist: String,
    seeds: Seeds,
    hist_message: String,
    /// New group, pending, then encrypted at 1 then 2, no messages.
    empty: String,
    /// New group, still pending.
    pending: String,
    /// New group in which both members chose server-readable; a posted.
    readable: String,
    readable_message: String,
    /// Registry before any room was encrypted.
    before_encryption: Vec<u8>,
    /// Registry with both encrypted rooms at epoch 1, the other two absent.
    older_epoch: Vec<u8>,
    current: Vec<u8>,
}

async fn marker_rooms(app: &Router, state: &Arc<AppState>, dir: &Path, id: &str) -> MarkerRooms {
    // Room ids are per test: whiteboard versions are process-global.
    let a = user(state, &format!("{id}-a")).await;
    let b = user(state, &format!("{id}-b")).await;
    let bot = user(state, &format!("{id}-bot")).await;
    let (bot_token, _) = state.bot_registry.create(bot).await.unwrap();
    let hist = format!("group-{id}-hist");
    state.wdb.create_group(&hist, "hist", a, &[a, b]).await.unwrap();
    let seeds = seed_readable_features(app, &bearer(state, a), &hist).await;
    let empty = pending_group(state, &format!("{id}-empty"), &[a, b]).await;
    let (da, db) = (device_id(a, 1), device_id(b, 1));
    register_device(app, state, a, &da).await;
    register_device(app, state, b, &db).await;
    let recipients = [(a, da.clone()), (b, db.clone())];
    let before_encryption = std::fs::read(registry_file(dir)).unwrap();
    for ch in [&hist, &empty] {
        let (status, body) = set_room(app, state, (a, &da), ch, 1, &recipients, false).await;
        assert_eq!(status, StatusCode::OK, "enable: {body}");
    }
    let older_epoch = std::fs::read(registry_file(dir)).unwrap();
    for ch in [&hist, &empty] {
        let (status, body) = set_room(app, state, (a, &da), ch, 2, &recipients, true).await;
        assert_eq!(status, StatusCode::OK, "rekey: {body}");
    }
    let revision = current_revision(app, state, a, &hist).await;
    let (status, body) = request(
        app,
        Method::POST,
        "/messages",
        &bearer(state, a),
        json!({"channel_id":hist,"content":envelope(&hist, 2, &revision, &da)}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let hist_message = body["id"].as_str().unwrap().to_string();
    let pending = pending_group(state, &format!("{id}-pending"), &[a, b]).await;
    let readable = pending_group(state, &format!("{id}-readable"), &[a, b]).await;
    for uid in [a, b] {
        let (status, body) = request(
            app,
            Method::POST,
            &format!("/e2ee/channels/{readable}/allow-server-readable"),
            &bearer(state, uid),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }
    let (status, body) = request(
        app,
        Method::POST,
        "/messages",
        &bearer(state, a),
        json!({"channel_id":readable,"content":"readable before the registry was lost"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let readable_message = body["id"].as_str().unwrap().to_string();
    // The bot joins every room. In the server-readable room it may post
    // (every human chose server-readable): the positive control for the
    // bot refusals below.
    for ch in [&hist, &empty, &pending, &readable] {
        state.wdb.add_channel_member(ch, bot, MemberRole::Member).await.unwrap();
    }
    let (status, body) = request(
        app,
        Method::POST,
        "/bot/send-message",
        &format!("Bot {bot_token}"),
        json!({"channel_id":readable,"content":"bot before the registry was lost"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(room_marker(state, &hist), Some((Mode::Enabled, 2)));
    assert_eq!(room_marker(state, &empty), Some((Mode::Enabled, 2)));
    assert_eq!(room_marker(state, &pending), Some((Mode::Pending, 0)));
    assert_eq!(room_marker(state, &readable), Some((Mode::ServerReadable, 0)));
    MarkerRooms {
        a,
        b,
        bot_token,
        hist,
        seeds,
        hist_message,
        empty,
        pending,
        readable,
        readable_message,
        before_encryption,
        older_epoch,
        current: std::fs::read(registry_file(dir)).unwrap(),
    }
}

impl MarkerRooms {
    fn all(&self) -> [&str; 4] {
        [&self.hist, &self.empty, &self.pending, &self.readable]
    }
    fn markers(&self, state: &AppState) -> Vec<Option<(Mode, u64)>> {
        self.all().iter().map(|ch| room_marker(state, ch)).collect()
    }
    fn variants(&self) -> [(&'static str, Option<Vec<u8>>); 3] {
        [
            ("missing registry", None),
            ("registry from before encryption", Some(self.before_encryption.clone())),
            ("registry at an older epoch", Some(self.older_epoch.clone())),
        ]
    }
    async fn assert_status_follows_the_marker(&self, app: &Router, state: &AppState, variant: &str) {
        for ch in [&self.hist, &self.empty] {
            let (code, status) = room_status(app, state, self.a, ch).await;
            assert_eq!(code, StatusCode::OK, "{variant}: {status}");
            assert_eq!(status["enabled"], true, "{variant}: {ch} no longer reports encryption: {status}");
            assert_eq!(status["epoch"], 2, "{variant}: {status}");
            assert_eq!(status["needsRekey"], true, "{variant}: {status}");
            assert_eq!(status["keyEnvelopes"], json!([]), "{variant}: old-epoch keys offered: {status}");
            assert_eq!(status["downgradeAllowed"], false);
            assert_registry_reason(variant, &status["registryBehind"]);
        }
        let (_, status) = room_status(app, state, self.a, &self.pending).await;
        assert_eq!(status["pendingDefault"], true, "{variant}: {status}");
        assert_eq!(status["enabled"], false, "{variant}: {status}");
        let (_, status) = room_status(app, state, self.a, &self.readable).await;
        assert_eq!(status["serverReadableSelected"], true, "{variant}: {status}");
        assert_eq!(status["serverReadableAllowedByMe"], false, "{variant}: {status}");
    }
}

/// The contract the ignored finding recorded: losing `e2ee_state.json` no
/// longer reopens a room whose history is ciphertext.
#[tokio::test]
async fn missing_registry_does_not_reopen_plaintext_in_a_room_with_ciphertext_history() {
    let dir = tempfile::tempdir().unwrap();
    let config = server_config(dir.path());
    let state = open_server(config.clone()).await;
    let app = http(&state);
    let room = encrypted_group(&app, &state, "missing-registry", &["a", "b"]).await;
    let (status, _) = request(
        &app,
        Method::POST,
        "/messages",
        &bearer(&state, room.users[0]),
        json!({"channel_id":room.ch,"content":room.envelope(&app, &state, 0, 1).await}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    drop(app);
    drop(state);
    std::fs::remove_file(dir.path().join("e2ee_state.json")).unwrap();
    let state = open_server(config).await;
    let app = http(&state);
    let (_, status) = room_status(&app, &state, room.users[0], &room.ch).await;
    assert_eq!(status["enabled"], true, "{status}");
    let (status, body) = request(
        &app,
        Method::POST,
        "/messages",
        &bearer(&state, room.users[0]),
        json!({"channel_id":room.ch,"content":"plaintext after registry loss"}),
    )
    .await;
    assert_ne!(status, StatusCode::OK, "plaintext accepted after registry loss: {body}");
    assert_registry_reason("REST after registry loss", &body);
}

/// Missing registry, a registry from before the rooms were encrypted, and a
/// registry at an older epoch, for an encrypted room with history, an
/// encrypted room without messages, a pending room and a room whose members
/// chose server-readable. Every HTTP entry path, after a restart, after the
/// SQLite read model is deleted, and after a full replay of the log; then
/// every Socket.IO path with the registry swapped under a running server.
#[tokio::test]
async fn missing_or_older_registry_refuses_readable_content_in_every_marked_room_on_every_path() {
    let dir = tempfile::tempdir().unwrap();
    let config = server_config(dir.path());
    let state = open_server(config.clone()).await;
    let app = http(&state);
    let rooms = marker_rooms(&app, &state, dir.path(), "marker-paths").await;
    let markers = rooms.markers(&state);
    let mut counts = vec![];
    for ch in rooms.all() {
        counts.push(stored(&state, ch).await.len());
    }
    drop(app);
    drop(state);
    let m = format!("MARKER-{}", uuid::Uuid::new_v4().simple());

    for (round, (variant, bytes)) in rooms.variants().into_iter().enumerate() {
        install_registry(dir.path(), bytes.as_deref());
        // Round 1: plain restart. Round 2: the SQLite read model is deleted
        // and rebuilt from the log. Round 3: the snapshot goes too, so every
        // projection, the marker included, is replayed from the log.
        if round >= 1 {
            assert!(read_model_file(dir.path()).exists(), "fixture: read model path");
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", read_model_file(dir.path()).display()));
            }
        }
        if round >= 2 {
            // Without a snapshot every projection replays from the log.
            let _ = std::fs::remove_file(snapshot_file(dir.path()));
        }
        let state = open_server(config.clone()).await;
        let app = http(&state);
        assert_eq!(rooms.markers(&state), markers, "{variant}: the marker changed across restart/rebuild");
        rooms.assert_status_follows_the_marker(&app, &state, variant).await;
        for ch in rooms.all() {
            for uid in [rooms.a, rooms.b] {
                let seeds = (ch == rooms.hist && uid == rooms.a).then_some(&rooms.seeds);
                let accepted = http_entry_paths(&app, &state, uid, ch, &m, &rooms.bot_token, seeds).await;
                assert!(accepted.is_empty(), "{variant}: {ch} accepted readable content via {accepted:#?}");
            }
        }
        // A server-readable choice cannot reopen an encrypted room either.
        let (status, _) = request(
            &app,
            Method::POST,
            &format!("/e2ee/channels/{}/allow-server-readable", rooms.hist),
            &bearer(&state, rooms.a),
            Value::Null,
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT, "{variant}");
        for (ch, count) in rooms.all().into_iter().zip(&counts) {
            assert_eq!(stored(&state, ch).await.len(), *count, "{variant}: {ch} stored a message");
        }
        // The refusals left the registry as it was: no repair from the weaker side.
        match &bytes {
            Some(bytes) => assert_eq!(&std::fs::read(registry_file(dir.path())).unwrap(), bytes, "{variant}"),
            None => assert!(!registry_file(dir.path()).exists(), "{variant}: a registry was invented"),
        }
        drop(app);
        drop(state);
    }

    // Socket.IO paths (this server cannot be restarted in-process again). The
    // registry is read on every decision, so a swap applies immediately.
    install_registry(dir.path(), Some(&rooms.current));
    let state = open_server(config.clone()).await;
    let app = router(&state);
    let mut sio_a = Client::connect(&app, &token(&state, rooms.a)).await;
    let mut sio_b = Client::connect(&app, &token(&state, rooms.b)).await;
    for (variant, bytes) in rooms.variants() {
        install_registry(dir.path(), bytes.as_deref());
        for ch in rooms.all() {
            for (sio, uid) in [(&mut sio_a, rooms.a), (&mut sio_b, rooms.b)] {
                let accepted = plaintext_entry_paths(&app, &state, sio, uid, ch, &m, &format!("{variant}-{ch}")).await;
                assert!(accepted.is_empty(), "{variant}: {ch} accepted via {accepted:#?}");
            }
            let accepted = feature_text_paths(&app, &bearer(&state, rooms.a), Some(&mut sio_a), ch, &m, None, true).await;
            assert!(accepted.is_empty(), "{variant}: {ch} accepted via {accepted:#?}");
        }
        for (ch, message) in [(&rooms.hist, &rooms.hist_message), (&rooms.readable, &rooms.readable_message)] {
            sio_a
                .emit("edit-message", json!({"channelId":ch,"messageId":message,"newText":format!("{m} edit")}))
                .await;
            let error = sio_a.event("edit-error").await;
            assert!(error.to_string().contains("e2ee_state.json"), "{variant}: edit in {ch}: {error}");
        }
    }

    // Positive control: the current registry admits what it admitted before.
    install_registry(dir.path(), Some(&rooms.current));
    let (event, body) = sio_a
        .send(json!({"channelId":rooms.readable,"clientMessageId":"control","text":"readable after restore"}))
        .await;
    assert_eq!(event, "message-accepted", "{body}");
    let (event, body) = sio_a
        .send(json!({"channelId":rooms.hist,"clientMessageId":"control-hist","text":"plaintext after restore"}))
        .await;
    assert_eq!(event, "message-error", "{body}");
    assert!(!body.to_string().contains("e2ee_state.json"), "the restored registry still reports a gap: {body}");

    for ch in rooms.all() {
        let contents = stored(&state, ch).await;
        assert!(!contents.iter().any(|c| c.contains(&m)), "{ch} stored readable content: {contents:?}");
        assert!(state.wdb.list_forum_threads(ch).await.unwrap().is_empty(), "{ch} stored a forum thread");
    }
    let hits: Vec<_> = files_containing(dir.path(), &m).into_iter().filter(|p| !p.ends_with("e2ee_state.json")).collect();
    assert!(hits.is_empty(), "{m} written to {hits:?}");
}

/// With the registry genuinely lost there is nothing that restores the keys
/// (the server never had them). Rooms stay closed to readable content;
/// members' clients run setup again: an encrypted room is rekeyed above the
/// highest epoch the database recorded, a pending room is enabled, and in a
/// server-readable room each sender chooses again. Nothing reopens a room
/// on the server's own initiative.
#[tokio::test]
async fn a_lost_registry_is_recovered_only_by_members_running_setup_again() {
    let dir = tempfile::tempdir().unwrap();
    let config = server_config(dir.path());
    let state = open_server(config.clone()).await;
    let app = http(&state);
    let rooms = marker_rooms(&app, &state, dir.path(), "marker-recover").await;
    drop(app);
    drop(state);
    install_registry(dir.path(), None);
    let state = open_server(config).await;
    let app = http(&state);
    let (a, b) = (rooms.a, rooms.b);
    // Device registrations lived in the registry; members' clients register again.
    let (da, db) = (device_id(a, 1), device_id(b, 1));
    register_device(&app, &state, a, &da).await;
    register_device(&app, &state, b, &db).await;
    // The bot member has no device; it leaves so the rooms can be rekeyed.
    let bot = state.wdb.list_channel_members(&rooms.hist).await.unwrap().into_iter().map(|m| m.user_id).find(|id| *id != a && *id != b).unwrap();
    let recipients = [(a, da.clone()), (b, db.clone())];

    for ch in [&rooms.hist, &rooms.empty] {
        state.wdb.remove_channel_member(ch, bot).await.unwrap();
        // Re-enabling at epoch 1, or reusing an epoch the database saw, is refused.
        let (status, body) = set_room(&app, &state, (a, &da), ch, 1, &recipients, false).await;
        assert_eq!(status, StatusCode::CONFLICT, "re-enable: {body}");
        let (status, body) = set_room(&app, &state, (a, &da), ch, 2, &recipients, true).await;
        assert_eq!(status, StatusCode::CONFLICT, "reused epoch: {body}");
        assert!(body.to_string().contains("must be 3"), "{body}");
        let (status, body) = set_room(&app, &state, (a, &da), ch, 3, &recipients, true).await;
        assert_eq!(status, StatusCode::OK, "rekey above the recorded epoch: {body}");
        assert_eq!(room_marker(&state, ch), Some((Mode::Enabled, 3)));
        let (_, status) = room_status(&app, &state, a, ch).await;
        assert_eq!(status["registryBehind"], Value::Null, "{status}");
        assert_eq!(status["needsRekey"], false, "{status}");
        let revision = current_revision(&app, &state, a, ch).await;
        let (status, body) = request(&app, Method::POST, "/messages", &bearer(&state, a), json!({"channel_id":ch,"content":envelope(ch, 3, &revision, &da)})).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let (status, body) = request(&app, Method::POST, "/messages", &bearer(&state, a), json!({"channel_id":ch,"content":"plaintext after recovery"})).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    }

    state.wdb.remove_channel_member(&rooms.pending, bot).await.unwrap();
    let (status, body) = set_room(&app, &state, (a, &da), &rooms.pending, 1, &recipients, false).await;
    assert_eq!(status, StatusCode::OK, "pending room set up again: {body}");
    assert_eq!(room_marker(&state, &rooms.pending), Some((Mode::Enabled, 1)));

    // Server-readable room: earlier choices are not carried over. a chooses
    // again; b has not, so b stays refused.
    let send = |uid: u64, text: &'static str| {
        let (app, auth, ch) = (app.clone(), bearer(&state, uid), rooms.readable.clone());
        async move { request(&app, Method::POST, "/messages", &auth, json!({"channel_id":ch,"content":text})).await }
    };
    let (status, body) = send(a, "a before choosing again").await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    let (status, body) = request(&app, Method::POST, &format!("/e2ee/channels/{}/allow-server-readable", rooms.readable), &bearer(&state, a), Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = send(a, "a after choosing again").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = send(b, "b without choosing").await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert!(body.to_string().contains("your own device"), "{body}");
    let (status, body) = request(&app, Method::POST, "/bot/send-message", &format!("Bot {}", rooms.bot_token), json!({"channel_id":rooms.readable,"content":"bot after loss"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
}

/// Crash between the two writes, in both orders, and a registry ahead of the
/// database. Marker ahead (registry write lost): the room refuses readable
/// content until setup runs again. Registry ahead (a data directory restored
/// older than its registry, or rooms from before markers existed): the
/// registry is the stricter source, it decides, and the marker catches up at
/// startup, once.
#[tokio::test]
async fn crash_between_marker_and_registry_writes_resolves_in_the_safe_direction() {
    let dir = tempfile::tempdir().unwrap();
    let config = server_config(dir.path());
    let state = open_server(config.clone()).await;
    let app = http(&state);
    let a = user(&state, "crash-a").await;
    let b = user(&state, "crash-b").await;
    let (da, db) = (device_id(a, 1), device_id(b, 1));
    register_device(&app, &state, a, &da).await;
    register_device(&app, &state, b, &db).await;
    let recipients = [(a, da.clone()), (b, db.clone())];
    let enabled = pending_group(&state, "crash-enable", &[a, b]).await;
    let chosen = pending_group(&state, "crash-choose", &[a, b]).await;
    let before = std::fs::read(registry_file(dir.path())).unwrap();
    let (status, body) = set_room(&app, &state, (a, &da), &enabled, 1, &recipients, false).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, _) = request(&app, Method::POST, &format!("/e2ee/channels/{chosen}/allow-server-readable"), &bearer(&state, a), Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    drop(app);
    drop(state);

    // Marker committed, registry write lost (the file is as it was before).
    install_registry(dir.path(), Some(&before));
    let state = open_server(config.clone()).await;
    let app = http(&state);
    assert_eq!(room_marker(&state, &enabled), Some((Mode::Enabled, 1)));
    assert_eq!(room_marker(&state, &chosen), Some((Mode::ServerReadable, 0)));
    let revision = current_revision(&app, &state, a, &enabled).await;
    for content in ["plaintext after a lost registry write".to_string(), envelope(&enabled, 1, &revision, &da)] {
        let (status, body) = request(&app, Method::POST, "/messages", &bearer(&state, a), json!({"channel_id":enabled,"content":content})).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        assert_registry_reason("marker ahead", &body);
    }
    let (_, status) = room_status(&app, &state, a, &enabled).await;
    assert_eq!((status["enabled"].clone(), status["epoch"].clone(), status["needsRekey"].clone()), (json!(true), json!(1), json!(true)), "{status}");
    let (status, body) = set_room(&app, &state, (a, &da), &enabled, 2, &recipients, true).await;
    assert_eq!(status, StatusCode::OK, "setup again: {body}");
    let revision = current_revision(&app, &state, a, &enabled).await;
    let (status, body) = request(&app, Method::POST, "/messages", &bearer(&state, a), json!({"channel_id":enabled,"content":envelope(&enabled, 2, &revision, &da)})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    // The server-readable choice was lost: the registry says pending, which
    // is stricter than the marker and decides. a chooses again.
    let (status, body) = request(&app, Method::POST, "/messages", &bearer(&state, a), json!({"channel_id":chosen,"content":"a before choosing again"})).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert!(body.to_string().contains("pending"), "{body}");
    let (status, _) = request(&app, Method::POST, &format!("/e2ee/channels/{chosen}/allow-server-readable"), &bearer(&state, a), Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = request(&app, Method::POST, "/messages", &bearer(&state, a), json!({"channel_id":chosen,"content":"a after choosing again"})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    drop(app);
    drop(state);

    // Registry ahead of the database: a stopped copy of the database is taken,
    // then `enabled` is rekeyed to 3, a room without any marker or policy
    // (as rooms were before markers existed) is encrypted, and a new pending
    // room is created. The old database is then opened with today's registry.
    let older = tempfile::tempdir().unwrap();
    let late = "group-crash-late";
    {
        let state = open_server(config.clone()).await;
        state.wdb.create_group(late, "late", a, &[a, b]).await.unwrap();
        drop(state);
        drop(open_server(config.clone()).await);
        copy_tree(dir.path(), older.path());
        let state = open_server(config.clone()).await;
        let app = http(&state);
        let (status, body) = set_room(&app, &state, (a, &da), late, 1, &recipients, false).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let (status, body) = set_room(&app, &state, (a, &da), &enabled, 3, &recipients, true).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        pending_group(&state, "crash-pending-late", &[a, b]).await;
        drop(app);
        drop(state);
    }
    std::fs::copy(registry_file(dir.path()), registry_file(older.path())).unwrap();
    let older_config = server_config(older.path());
    let state = open_server(older_config.clone()).await;
    // Startup brought every marker up to the registry before any decision.
    assert_eq!(room_marker(&state, &enabled), Some((Mode::Enabled, 3)));
    assert_eq!(room_marker(&state, late), Some((Mode::Enabled, 1)));
    // The pending group was created after the copy: in this database it does
    // not exist, so its registry entry writes no marker (a create would).
    assert_eq!(room_marker(&state, "group-crash-pending-late"), None);
    let app = http(&state);
    for (ch, epoch) in [(enabled.as_str(), 3), (late, 1)] {
        let revision = current_revision(&app, &state, a, ch).await;
        let (status, body) = request(&app, Method::POST, "/messages", &bearer(&state, a), json!({"channel_id":ch,"content":envelope(ch, epoch, &revision, &da)})).await;
        assert_eq!(status, StatusCode::OK, "registry ahead refused in {ch}: {body}");
        let (status, body) = request(&app, Method::POST, "/messages", &bearer(&state, a), json!({"channel_id":ch,"content":"plaintext"})).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        assert!(!body.to_string().contains("e2ee_state.json"), "{body}");
    }
    let applied = state.wdb.engine().projection_state().applied_commit_seq();
    drop(app);
    drop(state);
    // Once: a second start of the same directory writes no marker.
    let state = open_server(older_config).await;
    assert_eq!(state.wdb.engine().projection_state().applied_commit_seq(), applied, "a second start committed again");
    assert_eq!(room_marker(&state, &enabled), Some((Mode::Enabled, 3)));
}

/// A new DM through the real create path's order (marker, registry, channel).
async fn pending_dm(state: &Arc<AppState>, a: u64, b: u64) -> String {
    let mut members = vec![format!("user-{a}"), format!("user-{b}")];
    members.sort();
    let ch = format!("dm-{}", members.join("-"));
    wabi_server::api::e2ee::mark_new_room_pending(state, &ch).await.unwrap();
    state.wdb.create_dm_channel(&ch, "DM", Some(&members), a as i64).await.unwrap();
    ch
}

async fn choose_readable(app: &Router, state: &AppState, uid: u64, ch: &str) -> StatusCode {
    request(app, Method::POST, &format!("/e2ee/channels/{ch}/allow-server-readable"), &bearer(state, uid), Value::Null).await.0
}

async fn send_rest(app: &Router, state: &AppState, uid: u64, ch: &str, text: &str) -> (StatusCode, Value) {
    request(app, Method::POST, "/messages", &bearer(state, uid), json!({"channel_id":ch,"content":text})).await
}

fn registry_consents(dir: &Path, ch: &str) -> Vec<i64> {
    let registry: Value = serde_json::from_slice(&std::fs::read(registry_file(dir)).unwrap()).unwrap();
    serde_json::from_value(registry["newRoomPolicies"][ch]["consentingUserIds"].clone()).unwrap_or_default()
}

/// Per-sender server-readable consent is durable too. A registry that lists
/// a consenting sender the database does not record (an older copy from a
/// previous period of a recreated DM, or a copy from another data directory)
/// is not trusted for that sender: they are refused and their client is told
/// to ask again. Consent from before a return to pending is not carried over.
#[tokio::test]
async fn server_readable_consent_from_an_older_or_foreign_registry_is_not_trusted() {
    let dir = tempfile::tempdir().unwrap();
    let config = server_config(dir.path());
    let state = open_server(config.clone()).await;
    let app = http(&state);
    let a = user(&state, "consent-a").await;
    let b = user(&state, "consent-b").await;
    let dm = pending_dm(&state, a, b).await;
    for uid in [a, b] {
        assert_eq!(choose_readable(&app, &state, uid, &dm).await, StatusCode::OK);
    }
    assert_eq!(send_rest(&app, &state, b, &dm, "b in the first period").await.0, StatusCode::OK);
    let both_chose = std::fs::read(registry_file(dir.path())).unwrap();

    // Delete and recreate: the same stable id starts pending again.
    state.wdb.delete_channel(&dm, a).await.unwrap();
    assert_eq!(pending_dm(&state, a, b).await, dm);
    assert_eq!(room_marker(&state, &dm), Some((Mode::Pending, 0)));

    // (S2b) The older copy restored while the DM is still pending: it is
    // weaker than the marker, so everyone is refused; a's choice then starts
    // a fresh consent set in the registry that does not carry b over.
    let recreated = std::fs::read(registry_file(dir.path())).unwrap();
    std::fs::write(registry_file(dir.path()), &both_chose).unwrap();
    for uid in [a, b] {
        let (status, body) = send_rest(&app, &state, uid, &dm, "while pending").await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    }
    assert_eq!(choose_readable(&app, &state, a, &dm).await, StatusCode::OK);
    assert_eq!(registry_consents(dir.path(), &dm), vec![a as i64], "consent carried over from the earlier period");
    let (status, body) = send_rest(&app, &state, b, &dm, "b without choosing").await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert!(body.to_string().contains("your own device"), "{body}");
    let _ = recreated;

    // Scenario A: the older backup (a and b chose) restored over a restart.
    drop(app);
    drop(state);
    std::fs::write(registry_file(dir.path()), &both_chose).unwrap();
    let state = open_server(config).await;
    let app = http(&state);
    let (status, body) = send_rest(&app, &state, b, &dm, "b via the older backup").await;
    assert_ne!(status, StatusCode::OK, "older consent trusted: {body}");
    assert!(body.to_string().contains("your own device"), "{body}");
    let (_, status) = room_status(&app, &state, b, &dm).await;
    assert_eq!(status["serverReadableAllowedByMe"], false, "{status}");
    let (_, status) = room_status(&app, &state, a, &dm).await;
    assert_eq!(status["serverReadableAllowedByMe"], true, "{status}");
    assert_eq!(send_rest(&app, &state, a, &dm, "a chose in this period").await.0, StatusCode::OK);

    // Scenario B: a registry from elsewhere naming this room with more consent.
    let mut foreign: Value = serde_json::from_slice(&std::fs::read(registry_file(dir.path())).unwrap()).unwrap();
    foreign["newRoomPolicies"][&dm]["consentingUserIds"] = json!([a, b, 999]);
    std::fs::write(registry_file(dir.path()), serde_json::to_vec(&foreign).unwrap()).unwrap();
    let (status, body) = send_rest(&app, &state, b, &dm, "b via a foreign registry").await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    // b's own choice is what admits b.
    assert_eq!(choose_readable(&app, &state, b, &dm).await, StatusCode::OK);
    assert_eq!(send_rest(&app, &state, b, &dm, "b chose").await.0, StatusCode::OK);
}

/// (S2a) An older registry from a room's server-readable period, restored
/// after the room was encrypted, is weaker than the marker: refused, and the
/// marker stays encrypted.
#[tokio::test]
async fn a_server_readable_registry_restored_over_an_encrypted_room_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let config = server_config(dir.path());
    let state = open_server(config.clone()).await;
    let app = http(&state);
    let a = user(&state, "sr-enc-a").await;
    let b = user(&state, "sr-enc-b").await;
    let ch = pending_group(&state, "sr-enc", &[a, b]).await;
    for uid in [a, b] {
        assert_eq!(choose_readable(&app, &state, uid, &ch).await, StatusCode::OK);
    }
    let readable_period = std::fs::read(registry_file(dir.path())).unwrap();
    let (da, db) = (device_id(a, 1), device_id(b, 1));
    register_device(&app, &state, a, &da).await;
    register_device(&app, &state, b, &db).await;
    let (status, body) = set_room(&app, &state, (a, &da), &ch, 1, &[(a, da.clone()), (b, db)], false).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    drop(app);
    drop(state);
    std::fs::write(registry_file(dir.path()), &readable_period).unwrap();
    let state = open_server(config).await;
    let app = http(&state);
    let (status, body) = send_rest(&app, &state, a, &ch, "plaintext via the readable-period registry").await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_registry_reason("readable-period registry", &body);
    assert_eq!(room_marker(&state, &ch), Some((Mode::Enabled, 1)));
}

/// (M2) Valid JSON that holds invalid entries (an encrypted room at epoch 0,
/// a 300-byte or empty key) does not stop startup and never becomes a
/// marker; the entries keep refusing plaintext from the registry side.
#[tokio::test]
async fn invalid_registry_entries_neither_stop_startup_nor_become_markers() {
    let dir = tempfile::tempdir().unwrap();
    let config = server_config(dir.path());
    let state = open_server(config.clone()).await;
    let a = user(&state, "invalid-a").await;
    let b = user(&state, "invalid-b").await;
    let mut rooms = vec![];
    for id in ["epoch0", "longkey", "emptykey"] {
        let ch = format!("group-invalid-{id}");
        state.wdb.create_group(&ch, id, a, &[a, b]).await.unwrap();
        rooms.push(ch);
    }
    drop(state);
    let device = |uid: u64, key: &str| json!({"userId":uid,"deviceId":device_id(uid, 1),"label":null,"encryptionPublicKey":key,"signingPublicKey":opaque_key(),"createdAt":"","lastSeenAt":"","revokedAt":null});
    let envelope_to = |uid: u64| json!({"recipientUserId":uid,"recipientDeviceId":device_id(uid, 1),"ephemeralPublicKey":opaque_key(),"salt":"c2FsdA","iv":"aXY","ciphertext":"w","senderDeviceId":device_id(a, 1),"signature":"c2ln"});
    let room = |ch: &str, epoch: u64| json!({"channelId":ch,"enabled":true,"epoch":epoch,"membershipRevision":0,"enabledByUserId":a,"enabledAt":"","rekeyedAt":"","envelopes":[envelope_to(a), envelope_to(b)]});
    let registry = json!({
        "devices": [device(a, &"A".repeat(300)), device(b, "")],
        "rooms": { &rooms[0]: room(&rooms[0], 0), &rooms[1]: room(&rooms[1], 1), &rooms[2]: room(&rooms[2], 2) },
        "newRoomPolicies": {},
    });
    std::fs::write(registry_file(dir.path()), serde_json::to_vec(&registry).unwrap()).unwrap();
    let state = open_server(config).await;
    let app = http(&state);
    for ch in &rooms {
        assert_eq!(room_marker(&state, ch), None, "{ch}: invalid entry became a marker");
        let (status, body) = send_rest(&app, &state, a, ch, "plaintext").await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{ch}: {body}");
    }
}

/// (M6) After a lost registry a member who never comes back blocks the
/// rekey ("Missing user IDs"); the group removes them and then rekeys.
#[tokio::test]
async fn a_member_who_never_returns_is_removed_and_the_room_rekeyed() {
    let dir = tempfile::tempdir().unwrap();
    let config = server_config(dir.path());
    let state = open_server(config.clone()).await;
    let app = http(&state);
    let room = encrypted_group(&app, &state, "never-returns", &["a", "b", "gone"]).await;
    drop(app);
    drop(state);
    install_registry(dir.path(), None);
    let state = open_server(config).await;
    let app = http(&state);
    let (a, b, gone) = (room.users[0], room.users[1], room.users[2]);
    let (da, db) = (device_id(a, 1), device_id(b, 1));
    register_device(&app, &state, a, &da).await;
    register_device(&app, &state, b, &db).await;
    let recipients = [(a, da.clone()), (b, db.clone())];
    let (status, body) = set_room(&app, &state, (a, &da), &room.ch, 2, &recipients, true).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert!(body.to_string().contains("Missing user IDs"), "{body}");
    state.wdb.remove_channel_member(&room.ch, gone).await.unwrap();
    let (status, body) = set_room(&app, &state, (a, &da), &room.ch, 2, &recipients, true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let revision = current_revision(&app, &state, a, &room.ch).await;
    let (status, body) = send_rest(&app, &state, a, &room.ch, &envelope(&room.ch, 2, &revision, &da)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

/// An enable racing an upload completion: the completion's admission and its
/// publication happen under one hold of the encryption-policy lock, so a
/// plaintext upload is either published before the room's marker says
/// encrypted, or refused. A watcher polls both; with admission released
/// before hashing (the earlier code) it sees the room encrypted while the
/// plaintext upload is still unpublished, and then published.
#[tokio::test]
async fn an_enable_racing_an_upload_completion_never_publishes_plaintext_after_it() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let app = http(&state);
    let a = user(&state, "race-a").await;
    let b = user(&state, "race-b").await;
    let ch = "group-upload-race".to_string();
    state.wdb.create_group(&ch, "race", a, &[a, b]).await.unwrap();
    let (da, db) = (device_id(a, 1), device_id(b, 1));
    register_device(&app, &state, a, &da).await;
    register_device(&app, &state, b, &db).await;
    let auth = bearer(&state, a);
    // Large enough that hashing it takes a while; sent in 1 MiB chunks.
    const MIB: usize = 1024 * 1024;
    let size = 48 * MIB;
    let (status, init) = request(&app, Method::POST, "/upload/resumable/init", &auth,
        json!({"fileName":"race-plan.txt","fileSize":size,"mimeType":"text/plain","channelId":ch})).await;
    assert_eq!(status, StatusCode::OK, "{init}");
    let upload_id = init["uploadId"].as_str().unwrap().to_string();
    let upload_token = init["uploadToken"].as_str().unwrap().to_string();
    let chunk = vec![b'r'; MIB];
    for i in 0..48 {
        let (status, body) = raw_request(&app, Method::PUT,
            &format!("/upload/resumable/chunk?uploadId={upload_id}&offset={}", i * MIB), &auth,
            &[("x-upload-token", upload_token.clone()), ("content-type", "application/octet-stream".into())],
            chunk.clone()).await;
        assert!(status.is_success(), "chunk {i}: {status} {body}");
    }

    // Published = the bytes are at their public path.
    let final_path = Path::new(&state.config.uploads_dir).join(format!("{upload_id}.txt"));
    let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let watcher = {
        let (state, ch, done, final_path) = (state.clone(), ch.clone(), done.clone(), final_path.clone());
        tokio::spawn(async move {
            let mut encrypted_while_unpublished = false;
            while !done.load(std::sync::atomic::Ordering::SeqCst) {
                let encrypted = room_marker(&state, &ch).is_some_and(|(mode, _)| mode == Mode::Enabled);
                let published = final_path.exists();
                encrypted_while_unpublished |= encrypted && !published;
                tokio::task::yield_now().await;
            }
            encrypted_while_unpublished
        })
    };
    let completion = {
        let (app, auth) = (app.clone(), auth.clone());
        let body = json!({"uploadId":upload_id,"uploadToken":upload_token});
        tokio::spawn(async move { request(&app, Method::POST, "/upload/resumable/complete", &auth, body).await })
    };
    // Enable as soon as the completion has recorded the upload's name: it
    // has been admitted by then, and the earlier code had not yet hashed.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while state.upload_registry.by_channel(&ch).await.is_empty() && !completion.is_finished() {
        assert!(tokio::time::Instant::now() < deadline, "completion never recorded the upload");
        tokio::task::yield_now().await;
    }
    let (status, body) = set_room(&app, &state, (a, &da), &ch, 1, &[(a, da.clone()), (b, db)], false).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (completed, completion_body) = completion.await.unwrap();
    done.store(true, std::sync::atomic::Ordering::SeqCst);
    let encrypted_while_unpublished = watcher.await.unwrap();
    let published = final_path.exists();
    if completed.is_success() {
        assert!(published);
        assert!(!encrypted_while_unpublished, "a plaintext upload was published after the room became encrypted");
    } else {
        assert_eq!(completed, StatusCode::FORBIDDEN, "{completion_body}");
        assert!(!published, "a refused completion published its bytes");
    }
}

/// Init and chunk an upload into `ch` without completing it.
async fn staged_upload(app: &Router, auth: &str, ch: &str, name: &str, mime: &str, bytes: &[u8]) -> (String, String) {
    let (status, init) = request(app, Method::POST, "/upload/resumable/init", auth,
        json!({"fileName":name,"fileSize":bytes.len(),"mimeType":mime,"channelId":ch})).await;
    assert_eq!(status, StatusCode::OK, "{init}");
    let id = init["uploadId"].as_str().unwrap().to_string();
    let token = init["uploadToken"].as_str().unwrap().to_string();
    for (i, chunk) in bytes.chunks(1024 * 1024).enumerate() {
        let (status, body) = raw_request(app, Method::PUT, &format!("/upload/resumable/chunk?uploadId={id}&offset={}", i * 1024 * 1024), auth,
            &[("x-upload-token", token.clone()), ("content-type", "application/octet-stream".into())], chunk.to_vec()).await;
        assert!(status.is_success(), "chunk: {status} {body}");
    }
    (id, token)
}

/// A plaintext upload started while the room was readable and completed
/// after it became encrypted is refused: nothing is recorded or published,
/// and the staged plaintext and its session are removed. The refusal comes
/// before the expensive checks (a staged playlist is refused for the room,
/// not for being a playlist).
#[tokio::test]
async fn an_upload_completed_after_its_room_became_encrypted_is_refused_and_discarded() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let app = http(&state);
    let a = user(&state, "late-complete-a").await;
    let b = user(&state, "late-complete-b").await;
    let ch = "group-late-complete".to_string();
    state.wdb.create_group(&ch, "late", a, &[a, b]).await.unwrap();
    let auth = bearer(&state, a);
    let m = format!("STAGED-{}", uuid::Uuid::new_v4().simple());
    let plain = staged_upload(&app, &auth, &ch, "plan.txt", "text/plain", format!("{m} plaintext bytes").as_bytes()).await;
    let playlist = staged_upload(&app, &auth, &ch, "clip.mp4", "video/mp4", format!("#EXTM3U\n{m}.ts\n").as_bytes()).await;
    let (da, db) = (device_id(a, 1), device_id(b, 1));
    register_device(&app, &state, a, &da).await;
    register_device(&app, &state, b, &db).await;
    let (status, body) = set_room(&app, &state, (a, &da), &ch, 1, &[(a, da.clone()), (b, db)], false).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    for (id, token) in [&plain, &playlist] {
        let (status, body) = request(&app, Method::POST, "/upload/resumable/complete", &auth, json!({"uploadId":id,"uploadToken":token})).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        assert!(!body.to_string().contains("EXTM3U"), "refused for the playlist, not the room: {body}");
        assert_policy_reason("late completion", &body);
        // The session is gone: a retry fails without redoing any work. (The
        // existing "session not found" error is answered as a 500.)
        let (status, body) = request(&app, Method::POST, "/upload/resumable/complete", &auth, json!({"uploadId":id,"uploadToken":token})).await;
        assert!(!status.is_success(), "{status} {body}");
    }
    assert!(state.upload_registry.by_channel(&ch).await.is_empty(), "a refused upload was recorded");
    let left = files_containing(Path::new(&state.config.uploads_dir), &m);
    assert!(left.is_empty(), "refused plaintext left on disk: {left:?}");
}

/// The encryption-policy lock is held from the moment the upload's name is
/// recorded until its bytes are renamed into place. A watcher tries the lock
/// whenever it sees the name recorded but the file not yet published.
#[tokio::test]
async fn the_policy_lock_is_held_from_recording_an_upload_to_publishing_it() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let app = http(&state);
    let a = user(&state, "lock-hold-a").await;
    let b = user(&state, "lock-hold-b").await;
    let ch = "group-lock-hold".to_string();
    state.wdb.create_group(&ch, "lock", a, &[a, b]).await.unwrap();
    let auth = bearer(&state, a);
    let (mut observed, mut violations) = (0usize, 0usize);
    for round in 0..8 {
        let (id, token) = staged_upload(&app, &auth, &ch, "notes.txt", "text/plain", &vec![b'n'; 256 * 1024]).await;
        let final_path = Path::new(&state.config.uploads_dir).join(format!("{id}.txt"));
        let name = format!("{id}.txt");
        let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let watcher = {
            let (state, done, final_path, name) = (state.clone(), done.clone(), final_path.clone(), name.clone());
            tokio::spawn(async move {
                let (mut seen, mut free) = (0usize, 0usize);
                while !done.load(std::sync::atomic::Ordering::SeqCst) {
                    if state.upload_registry.get(&name).await.is_some() && !final_path.exists() {
                        seen += 1;
                        if state.retention_policy_lock.try_lock().is_ok() {
                            free += 1;
                        }
                    }
                    tokio::task::yield_now().await;
                }
                (seen, free)
            })
        };
        let (status, body) = request(&app, Method::POST, "/upload/resumable/complete", &auth, json!({"uploadId":id,"uploadToken":token})).await;
        assert_eq!(status, StatusCode::OK, "round {round}: {body}");
        done.store(true, std::sync::atomic::Ordering::SeqCst);
        let (seen, free) = watcher.await.unwrap();
        observed += seen;
        violations += free;
    }
    assert!(observed > 0, "the watcher never saw a recorded, unpublished upload");
    assert_eq!(violations, 0, "the policy lock was free between recording and publishing ({violations} of {observed})");
}

/// History reports a room's messages by the server's decision: a readable
/// message from before the room was encrypted stays not encrypted, the
/// envelope after it is encrypted, on REST history, join history and
/// load-history alike.
#[tokio::test]
async fn history_reports_readable_messages_from_before_encryption_as_not_encrypted() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let app = router(&state);
    let a = user(&state, "hist-shape-a").await;
    let b = user(&state, "hist-shape-b").await;
    let ch = "group-hist-shape".to_string();
    state.wdb.create_group(&ch, "hist", a, &[a, b]).await.unwrap();
    // Stored directly so that no session cache entry answers for it.
    state.wdb.send_message(&ch, a, "readable before encryption", false, &[]).await.unwrap();
    let (da, db) = (device_id(a, 1), device_id(b, 1));
    register_device(&app, &state, a, &da).await;
    register_device(&app, &state, b, &db).await;
    let (status, body) = set_room(&app, &state, (a, &da), &ch, 1, &[(a, da.clone()), (b, db)], false).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let revision = current_revision(&app, &state, a, &ch).await;
    state.wdb.send_message(&ch, a, &envelope(&ch, 1, &revision, &da), false, &[]).await.unwrap();
    let check = |path: &str, list: &[Value]| {
        assert_eq!(list.len(), 2, "{path}: {list:?}");
        for m in list {
            let text = m["text"].as_str().or(m["content"].as_str()).unwrap_or_default();
            let expected = text.starts_with(PREFIX);
            assert_eq!(m["encrypted"], expected, "{path}: {m}");
        }
    };
    let (_, listed) = request(&app, Method::GET, &format!("/messages/{ch}"), &bearer(&state, b), Value::Null).await;
    check("REST history", listed["messages"].as_array().unwrap());
    let mut sio = Client::connect(&app, &token(&state, b)).await;
    sio.emit("join-channel", json!(ch)).await;
    let joined = sio.event("channel-messages").await;
    check("join history", joined["messages"].as_array().unwrap());
    sio.emit("load-history", json!({"channelId":ch,"limit":50})).await;
    let loaded = sio.event("history-loaded").await;
    check("load-history", loaded["messages"].as_array().unwrap());
}

/// "encrypted" on a relayed or listed message is the server's decision, not
/// the sender's claim. A plaintext message sent with `encrypted: true` (and an
/// `iv`) in a public channel is relayed, cached and listed as not encrypted;
/// a valid envelope in an encrypted room is relayed as encrypted.
#[tokio::test]
async fn the_encrypted_flag_comes_from_the_server_not_the_sender() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let app = router(&state);
    let a = user(&state, "flag-a").await;
    let b = user(&state, "flag-b").await;
    let public = state.wdb.create_channel("flag-public", wabidb::domain::ChannelKind::Text, a, false).await.unwrap();
    for uid in [a, b] {
        state.wdb.add_channel_member(&public, uid, MemberRole::Member).await.unwrap();
    }
    let mut sio_a = Client::connect(&app, &token(&state, a)).await;
    let mut sio_b = Client::connect(&app, &token(&state, b)).await;
    sio_b.emit("join-channel", json!(public)).await;
    sio_b.event("channel-messages").await;
    let (event, body) = sio_a
        .send(json!({"channelId":public,"clientMessageId":"claims-encrypted","text":"ordinary text","encrypted":true,"iv":"AAAAAAAAAAAAAAAA"}))
        .await;
    assert_eq!(event, "message-accepted", "{body}");
    let relayed = sio_b.event("message").await;
    assert_eq!(relayed["message"]["text"], "ordinary text", "{relayed}");
    assert_eq!(relayed["message"]["encrypted"], false, "relayed with the sender's claim: {relayed}");
    assert!(relayed["message"].get("iv").is_none_or(Value::is_null), "relayed the sender's iv: {relayed}");
    let cached = serde_json::to_value(state.session_messages.read().await.get(&public)).unwrap();
    assert_eq!(cached[0]["encrypted"], false, "{cached}");
    let (status, listed) = request(&app, Method::GET, &format!("/messages/{public}"), &bearer(&state, b), Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    let listed = listed["messages"].as_array().cloned().unwrap_or_default();
    assert!(listed.iter().all(|m| m["encrypted"] == false), "{listed:?}");

    // A bot cannot post envelope-prefixed text: it is refused, as for people.
    let bot = user(&state, "flag-bot").await;
    let (bot_token, _) = state.bot_registry.create(bot).await.unwrap();
    state.wdb.add_channel_member(&public, bot, MemberRole::Member).await.unwrap();
    let fake = format!("{PREFIX}not an envelope at all, just readable text");
    let (status, body) = request(&app, Method::POST, "/bot/send-message", &format!("Bot {bot_token}"), json!({"channel_id":public,"content":fake})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    // Prefixed text that reached storage anyway (an older build, a direct
    // write), even a well-formed envelope, is listed as not encrypted
    // outside an encrypted room: history follows the room, not the prefix.
    let shaped = envelope(&public, 1, "1", "device-x-1");
    for content in [fake.as_str(), shaped.as_str()] {
        state.wdb.send_message(&public, a, content, false, &[]).await.unwrap();
    }
    let (_, listed) = request(&app, Method::GET, &format!("/messages/{public}"), &bearer(&state, b), Value::Null).await;
    let listed = listed["messages"].as_array().cloned().unwrap_or_default();
    assert_eq!(listed.len(), 3, "{listed:?}");
    assert!(listed.iter().all(|m| m["encrypted"] == false), "REST history: {listed:?}");
    let mut sio_late = Client::connect(&app, &token(&state, b)).await;
    sio_late.emit("join-channel", json!(public)).await;
    let history = sio_late.event("channel-messages").await;
    let history = history["messages"].as_array().cloned().unwrap_or_default();
    assert!(!history.is_empty(), "socket history empty");
    assert!(history.iter().all(|m| m["encrypted"] != true), "socket history: {history:?}");
    sio_late.emit("load-history", json!({"channelId":public,"limit":50})).await;
    let older = sio_late.event_one_of(&["history-loaded", "history-error"]).await;
    assert_eq!(older.0, "history-loaded", "{older:?}");
    let older = older.1["messages"].as_array().cloned().unwrap_or_default();
    assert_eq!(older.len(), 3, "{older:?}");
    assert!(older.iter().all(|m| m["encrypted"] == false), "load-history: {older:?}");

    // The server's own positive decision is still reported.
    let room = encrypted_group(&app, &state, "flag-room", &["c", "d"]).await;
    let mut sio_c = Client::connect(&app, &token(&state, room.users[0])).await;
    let mut sio_d = Client::connect(&app, &token(&state, room.users[1])).await;
    sio_d.emit("join-channel", json!(room.ch)).await;
    sio_d.event("channel-messages").await;
    let (event, body) = sio_c
        .send(json!({"channelId":room.ch,"clientMessageId":"real","text":room.envelope(&app, &state, 0, 1).await,"encrypted":false}))
        .await;
    assert_eq!(event, "message-accepted", "{body}");
    let relayed = sio_d.event("message").await;
    assert_eq!(relayed["message"]["encrypted"], true, "{relayed}");
    let (_, listed) = request(&app, Method::GET, &format!("/messages/{}", room.ch), &bearer(&state, room.users[1]), Value::Null).await;
    let listed = listed["messages"].as_array().cloned().unwrap_or_default();
    assert!(!listed.is_empty() && listed.iter().all(|m| m["encrypted"] == true), "{listed:?}");
}

// ---------------------------------------------------------------------------
// Point 6: plaintext does not leak into derived data
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct Captured(Arc<Mutex<Vec<u8>>>);
impl std::io::Write for Captured {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// One process-wide debug-level subscriber for this test binary.
fn captured_logs() -> Arc<Mutex<Vec<u8>>> {
    static LOGS: OnceLock<Arc<Mutex<Vec<u8>>>> = OnceLock::new();
    LOGS.get_or_init(|| {
        let buffer = Arc::new(Mutex::new(Vec::new()));
        let writer = Captured(buffer.clone());
        tracing_subscriber::fmt()
            .with_max_level(tracing::Level::DEBUG)
            .with_ansi(false)
            .with_writer(move || writer.clone())
            .try_init()
            .expect("tracing subscriber for leak capture");
        buffer
    })
    .clone()
}

/// Every file under `root` (recursively) whose bytes contain `needle`.
fn files_containing(root: &Path, needle: &str) -> Vec<PathBuf> {
    let mut hits = vec![];
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if let Ok(bytes) = std::fs::read(&path) {
                if bytes.windows(needle.len()).any(|w| w == needle.as_bytes()) {
                    hits.push(path);
                }
            }
        }
    }
    hits
}

fn files_named(root: &Path) -> Vec<String> {
    let mut names = vec![];
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                names.push(path.strip_prefix(root).unwrap().to_string_lossy().into_owned());
            }
        }
    }
    names
}

#[tokio::test]
async fn refused_plaintext_and_client_plaintext_leave_no_trace_in_server_data_or_logs() {
    let logs = captured_logs();
    let dir = tempfile::tempdir().unwrap();
    let config = server_config(dir.path());
    // CLIENT_MARKER is the plaintext a client would encrypt. It is never sent.
    let client_marker = format!("CLIENTSIDE-{}", uuid::Uuid::new_v4().simple());
    let refused_marker = format!("REFUSED-{}", uuid::Uuid::new_v4().simple());
    // Positive control: readable text in a server-readable room must be
    // findable by the same scans, or the scans prove nothing.
    let control_marker = format!("CONTROL-{}", uuid::Uuid::new_v4().simple());

    // A moderation hook that flags both markers, with private-content
    // automation on: if refused plaintext reached it, a report would appear.
    // Server Center state is loaded at startup, so write it first.
    std::fs::write(
        dir.path().join("server_center.json"),
        serde_json::to_vec(&json!({
            "safety": {"enabled": true, "defaultFlagChannelId": null, "rules": [
                {"id":"r1","enabled":true,"name":"refused","pattern":refused_marker,"match":"contains",
                 "caseSensitive":false,"action":"flag","timeoutMinutes":null,"reason":null},
                {"id":"r2","enabled":true,"name":"control","pattern":control_marker,"match":"contains",
                 "caseSensitive":false,"action":"flag","timeoutMinutes":null,"reason":null}]},
            "privacy": {"defaultRetention":"forever","privateContentAutomation":true,"analyticsMode":"off",
                        "externalProcessing":"none","reportEvidencePreservation":"explicit_report"},
        }))
        .unwrap(),
    )
    .unwrap();
    let state = open_server(config).await;
    let app = router(&state);
    let room = encrypted_group(&app, &state, "leak", &["a", "b"]).await;
    let (a, b) = (room.users[0], room.users[1]);
    let readable = "group-leak-readable".to_string();
    state.wdb.create_group(&readable, "readable", a, &[a, b]).await.unwrap();

    let mut sio_b = Client::connect(&app, &token(&state, b)).await;
    let mut sio_a = Client::connect(&app, &token(&state, a)).await;
    sio_b.emit("join-channel", json!(room.ch)).await;
    sio_b.event("channel-messages").await;

    // Accepted ciphertext (the client plaintext stays on the client).
    let (event, body) = sio_a
        .send(json!({"channelId":room.ch,"clientMessageId":"leak-ct","text":room.envelope(&app, &state, 0, 1).await}))
        .await;
    assert_eq!(event, "message-accepted", "{body}");
    let cipher_id = body["messageId"].as_str().unwrap().to_string();
    // Refused plaintext on every entry path, plus an edit and a link that a
    // server-side unfurler would fetch.
    let refused = format!("{refused_marker} https://{refused_marker}.example.invalid/");
    let accepted = plaintext_entry_paths(&app, &state, &mut sio_a, a, &room.ch, &refused, "leak").await;
    assert!(accepted.is_empty(), "{accepted:#?}");
    sio_a
        .emit("edit-message", json!({"channelId":room.ch,"messageId":cipher_id,"newText":refused}))
        .await;
    sio_a.event("edit-error").await;
    // Control: readable room, consented plaintext.
    let (status, body) = request(
        &app,
        Method::POST,
        "/messages",
        &bearer(&state, a),
        json!({"channel_id":readable,"content":format!("{control_marker} readable")}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // Push payloads are built without message text (structural: the builder
    // has no content parameter).
    let push = wabi_server::api::push::payload_for(
        wabi_server::api::push::PushKind::DirectMessage,
        "user-a",
        &room.ch,
    );
    let push = push.to_string();
    assert!(!push.contains(&refused_marker) && !push.contains(&client_marker));

    // What the recipient was sent over the socket.
    let delivered = sio_b.drain().await;
    for marker in [&client_marker, &refused_marker] {
        assert!(!delivered.contains(marker.as_str()), "delivered to recipient: {marker}");
    }
    // In-memory read paths and the moderation queue.
    let everything = serde_json::to_string(&state.wdb.list_all_messages_typed().await.unwrap()).unwrap();
    assert!(everything.contains(&control_marker), "control missing from the read model");
    let session = serde_json::to_string(&*state.session_messages.read().await).unwrap();
    let server_center = std::fs::read_to_string(dir.path().join("server_center.json")).unwrap();
    let reports: Value = serde_json::from_str(&server_center).unwrap();
    let report_count = reports["reports"].as_array().map(Vec::len).unwrap_or(0);
    assert_eq!(report_count, 1, "only the control message reaches the moderation hook: {server_center}");
    for marker in [&client_marker, &refused_marker] {
        assert!(!everything.contains(marker.as_str()), "read model: {marker}");
        assert!(!session.contains(marker.as_str()), "session cache: {marker}");
    }

    // Everything on disk (segments, commit index, read model and its WAL,
    // sidecars, uploads), plus a full projection snapshot written to a scratch
    // directory (the live process cannot be restarted here: see `http`).
    let snapshot = tempfile::tempdir().unwrap();
    state.wdb.engine().projection_state().save_snapshot(snapshot.path()).unwrap();
    // snapshot.json hex-encodes keys and values; scan both spellings. The
    // safety rule patterns live in server_center.json by design, so that file
    // is excluded (it is checked separately above for reports).
    let hits = |marker: &str| -> Vec<PathBuf> {
        let hex: String = marker.bytes().map(|b| format!("{b:02x}")).collect();
        [marker.to_string(), hex]
            .iter()
            .flat_map(|needle| {
                files_containing(dir.path(), needle).into_iter().chain(files_containing(snapshot.path(), needle))
            })
            .filter(|p| !p.ends_with("server_center.json"))
            .collect()
    };
    let control_hits = hits(&control_marker);
    // Message bodies live in the SQLite read model (and its WAL), so that is
    // where the control must show up. The projection snapshot holds no
    // message bodies today: it is scanned too, but without a positive control.
    assert!(
        control_hits.iter().any(|p| p.starts_with(dir.path())),
        "positive control: readable text was not found in the data dir, so the scan is blind; \
         found {control_hits:?} among {:?}",
        files_named(dir.path())
    );
    for marker in [&client_marker, &refused_marker] {
        let found = hits(marker);
        assert!(found.is_empty(), "{marker} written to {found:?}");
    }
    eprintln!("leak scan: control marker found in {control_hits:?}");

    // Debug-level tracing for the whole run.
    let logs = String::from_utf8_lossy(&logs.lock().unwrap()).into_owned();
    assert!(logs.contains("[e2ee] rejected message"), "log capture is not working");
    for marker in [&client_marker, &refused_marker] {
        assert!(!logs.contains(marker.as_str()), "{marker} in tracing output");
    }
}

// ---------------------------------------------------------------------------
// Point 2 as far as the server can show it: no server-unwrappable room key
// ---------------------------------------------------------------------------

#[tokio::test]
async fn server_stores_only_public_device_keys_and_keys_wrapped_to_registered_devices() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let app = router(&state);
    let room = encrypted_group(&app, &state, "escrow", &["a", "b"]).await;
    let (a, b) = (room.users[0], room.users[1]);
    let outsider = user(&state, "escrow-outsider").await;
    let outsider_device = device_id(outsider, 1);
    register_device(&app, &state, outsider, &outsider_device).await;

    // A room key or device private key a client might mistakenly send is not
    // a field the server accepts or keeps.
    let raw_room_key = format!("RAWROOMKEY-{}", uuid::Uuid::new_v4().simple());
    let private_key = format!("PRIVATEKEY-{}", uuid::Uuid::new_v4().simple());
    let (status, _) = request(
        &app,
        Method::POST,
        "/e2ee/devices",
        &bearer(&state, a),
        json!({"deviceId":device_id(a, 9),"encryptionPublicKey":opaque_key(),"signingPublicKey":opaque_key(),
               "privateKey":private_key,"encryptionPrivateKey":private_key}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    // a now has two devices; rekey to both, plus a stray plaintext room key.
    let revision = current_revision(&app, &state, a, &room.ch).await;
    let mut envelopes = vec![
        wrapped(a, &room.devices[0], &room.devices[0]),
        wrapped(a, &device_id(a, 9), &room.devices[0]),
        wrapped(b, &room.devices[1], &room.devices[0]),
    ];
    let (status, body) = request(
        &app,
        Method::POST,
        &format!("/e2ee/channels/{}/rekey", room.ch),
        &bearer(&state, a),
        json!({"senderDeviceId":room.devices[0],"epoch":2,"membershipRevision":revision,
               "envelopes":envelopes,"roomKey":raw_room_key,"rawKey":raw_room_key}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // Escrow attempts: an extra recipient that is not a registered device, or
    // a registered device outside the conversation, is refused.
    for (uid, device) in [(a, "server-escrow-device".to_string()), (outsider, outsider_device.clone())] {
        envelopes.push(wrapped(uid, &device, &room.devices[0]));
        let (status, body) = request(
            &app,
            Method::POST,
            &format!("/e2ee/channels/{}/rekey", room.ch),
            &bearer(&state, a),
            json!({"senderDeviceId":room.devices[0],"epoch":3,"membershipRevision":revision,"envelopes":envelopes}),
        )
        .await;
        assert_ne!(status, StatusCode::OK, "escrow recipient accepted: {body}");
        envelopes.pop();
    }
    // An envelope set that omits a member device is refused too (so a server
    // cannot be handed a set it would later "complete" itself).
    let (status, _) = request(
        &app,
        Method::POST,
        &format!("/e2ee/channels/{}/rekey", room.ch),
        &bearer(&state, a),
        json!({"senderDeviceId":room.devices[0],"epoch":3,"membershipRevision":revision,"envelopes":envelopes[..2]}),
    )
    .await;
    assert_ne!(status, StatusCode::OK);

    // The stored registry: only the documented fields, every wrapped key is
    // addressed to an active registered device of a current member.
    let registry: Value =
        serde_json::from_slice(&std::fs::read(dir.path().join("e2ee_state.json")).unwrap()).unwrap();
    let keys = |v: &Value| v.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
    for key in keys(&registry) {
        assert!(["devices", "rooms", "newRoomPolicies"].contains(&key.as_str()), "registry field {key}");
    }
    let device_fields = [
        "userId", "deviceId", "label", "encryptionPublicKey", "signingPublicKey", "createdAt",
        "lastSeenAt", "revokedAt",
    ];
    let mut registered = std::collections::BTreeSet::new();
    for device in registry["devices"].as_array().unwrap() {
        for key in keys(device) {
            assert!(device_fields.contains(&key.as_str()), "device field {key}");
        }
        if device["revokedAt"].is_null() {
            registered.insert((device["userId"].as_u64().unwrap(), device["deviceId"].as_str().unwrap().to_string()));
        }
    }
    let envelope_fields = [
        "recipientUserId", "recipientDeviceId", "ephemeralPublicKey", "salt", "iv", "ciphertext",
        "senderDeviceId", "signature",
    ];
    let room_fields = [
        "channelId", "enabled", "epoch", "membershipRevision", "enabledByUserId", "enabledAt",
        "rekeyedAt", "envelopes",
    ];
    let members: std::collections::BTreeSet<u64> = [a, b].into();
    let stored_room = &registry["rooms"][&room.ch];
    for key in keys(stored_room) {
        assert!(room_fields.contains(&key.as_str()), "room field {key}");
    }
    for envelope in stored_room["envelopes"].as_array().unwrap() {
        for key in keys(envelope) {
            assert!(envelope_fields.contains(&key.as_str()), "wrapped-key field {key}");
        }
        let recipient = (
            envelope["recipientUserId"].as_u64().unwrap(),
            envelope["recipientDeviceId"].as_str().unwrap().to_string(),
        );
        assert!(registered.contains(&recipient), "wrapped to unregistered device {recipient:?}");
        assert!(members.contains(&recipient.0), "wrapped to non-member {recipient:?}");
    }
    assert_eq!(stored_room["envelopes"].as_array().unwrap().len(), 3);
    // Nothing anywhere under the data directory holds the stray secrets.
    for secret in [&raw_room_key, &private_key] {
        assert!(files_containing(dir.path(), secret).is_empty(), "a room key or private key was stored under the data directory");
    }
    // A member only ever receives the wrapped keys addressed to them.
    let (_, status) = room_status(&app, &state, b, &room.ch).await;
    for envelope in status["keyEnvelopes"].as_array().unwrap() {
        assert_eq!(envelope["recipientUserId"].as_u64(), Some(b));
    }
}

// ---------------------------------------------------------------------------
// Membership: removal and account deletion require a rekey
// ---------------------------------------------------------------------------

#[tokio::test]
async fn removed_or_deleted_members_force_rekey_and_lose_access_to_new_wrapped_keys() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let app = router(&state);
    let room = encrypted_group(&app, &state, "membership", &["a", "b", "removed", "deleted"]).await;
    let (a, removed, deleted) = (room.users[0], room.users[2], room.users[3]);
    let send = |content: String| {
        let app = app.clone();
        let auth = bearer(&state, a);
        let ch = room.ch.clone();
        async move {
            request(&app, Method::POST, "/messages", &auth, json!({"channel_id":ch,"content":content})).await
        }
    };

    // Removal.
    let before = room.envelope(&app, &state, 0, 1).await;
    state.wdb.remove_channel_member(&room.ch, removed).await.unwrap();
    let (status, body) = send(before.clone()).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "old-revision envelope after removal: {body}");
    assert!(body.to_string().contains("Rekey"), "{body}");
    let (status, _) = send("plaintext after removal".into()).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = room_status(&app, &state, removed, &room.ch).await;
    assert!(!status.is_success(), "removed member still reads room key state");
    // Rekey cannot keep wrapping to the removed member's device.
    let (status, _) =
        set_room(&app, &state, room.device(0), &room.ch, 2, &room.recipients(&[0, 1, 2, 3]), true).await;
    assert_ne!(status, StatusCode::OK);
    let (status, body) =
        set_room(&app, &state, room.device(0), &room.ch, 2, &room.recipients(&[0, 1, 3]), true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = send(room.envelope(&app, &state, 0, 2).await).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, _) = room_status(&app, &state, removed, &room.ch).await;
    assert!(!status.is_success(), "removed member fetched new wrapped keys");
    let registry = std::fs::read_to_string(dir.path().join("e2ee_state.json")).unwrap();
    let registry: Value = serde_json::from_str(&registry).unwrap();
    assert!(registry["rooms"][&room.ch]["envelopes"]
        .as_array()
        .unwrap()
        .iter()
        .all(|e| e["recipientUserId"].as_u64() != Some(removed)));
    // The removed member's own sends are refused (no participation).
    let (status, _) = request(
        &app,
        Method::POST,
        "/messages",
        &bearer(&state, removed),
        json!({"channel_id":room.ch,"content":envelope(&room.ch, 2, &current_revision(&app, &state, a, &room.ch).await, &room.devices[2])}),
    )
    .await;
    assert_ne!(status, StatusCode::OK);

    // Account deletion (user_deleted cascade, PRs 349/350) is a membership change too.
    let before = room.envelope(&app, &state, 0, 2).await;
    state.wdb.delete_user(deleted).await.unwrap();
    let (status, body) = send(before).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "old-revision envelope after deletion: {body}");
    let (status, _) = room_status(&app, &state, deleted, &room.ch).await;
    assert_ne!(status, StatusCode::OK, "deleted account still reads room key state");
    let (status, _) =
        set_room(&app, &state, room.device(0), &room.ch, 3, &room.recipients(&[0, 1, 3]), true).await;
    assert_ne!(status, StatusCode::OK, "rekey wrapped to a deleted account");
    let (status, body) =
        set_room(&app, &state, room.device(0), &room.ch, 3, &room.recipients(&[0, 1]), true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = send(room.envelope(&app, &state, 0, 3).await).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(all_ciphertext(&stored(&state, &room.ch).await));
}

// ---------------------------------------------------------------------------
// Round 2: feature surfaces that store readable text against a conversation
// ---------------------------------------------------------------------------

fn multipart(field: &str, file_name: &str, mime: &str, bytes: &[u8]) -> (String, Vec<u8>) {
    let boundary = format!("wabi-contract-{}", uuid::Uuid::new_v4().simple());
    let mut body = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"; filename=\"{file_name}\"\r\nContent-Type: {mime}\r\n\r\n"
    )
    .into_bytes();
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={boundary}"), body)
}

async fn raw_request(
    app: &Router,
    method: Method,
    path: &str,
    authorization: &str,
    headers: &[(&str, String)],
    body: Vec<u8>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(path).header("authorization", authorization);
    for (name, value) in headers {
        builder = builder.header(*name, value);
    }
    let response = app.clone().oneshot(builder.body(Body::from(body)).unwrap()).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 4 * 1024 * 1024).await.unwrap();
    let value = serde_json::from_slice(&bytes).unwrap_or_else(|_| json!(String::from_utf8_lossy(&bytes)));
    (status, value)
}

/// Resumable upload bound to `ch`: init, one chunk, complete. Returns the
/// first non-success step, or the final response.
async fn resumable_upload(
    app: &Router,
    auth: &str,
    ch: &str,
    file_name: &str,
    mime: &str,
    bytes: &[u8],
) -> (StatusCode, Value) {
    let (status, init) = request(
        app,
        Method::POST,
        "/upload/resumable/init",
        auth,
        json!({"fileName":file_name,"fileSize":bytes.len(),"mimeType":mime,"channelId":ch}),
    )
    .await;
    if !status.is_success() {
        return (status, init);
    }
    let upload_id = init["uploadId"].as_str().unwrap().to_string();
    let upload_token = init["uploadToken"].as_str().unwrap().to_string();
    let (status, chunk) = raw_request(
        app,
        Method::PUT,
        &format!("/upload/resumable/chunk?uploadId={upload_id}&offset=0"),
        auth,
        &[("x-upload-token", upload_token.clone()), ("content-type", "application/octet-stream".into())],
        bytes.to_vec(),
    )
    .await;
    if !status.is_success() {
        return (status, chunk);
    }
    request(
        app,
        Method::POST,
        "/upload/resumable/complete",
        auth,
        json!({"uploadId":upload_id,"uploadToken":upload_token}),
    )
    .await
}

/// Objects created while a room is still server-readable, so that the update
/// paths can be probed after encryption is enabled.
struct Seeds {
    page: String,
    album: String,
    work: String,
    incident: String,
}

async fn seed_readable_features(app: &Router, auth: &str, ch: &str) -> Seeds {
    let ok = |what: &str, status: StatusCode, body: &Value| {
        assert!(status.is_success(), "seed {what} in a server-readable room: {status} {body}");
    };
    let (s, page) = request(app, Method::POST, &format!("/wiki/{ch}/pages"), auth, json!({"title":"seed","body":"seed"})).await;
    ok("wiki page", s, &page);
    let (s, album) = request(app, Method::POST, "/albums", auth, json!({"scopeType":"dm","scopeId":ch,"name":"seed"})).await;
    ok("album", s, &album);
    let (s, work) = request(
        app,
        Method::POST,
        &format!("/gallery/{ch}/works"),
        auth,
        json!({"title":"seed","caption":"seed","attachmentUrl":"/uploads/x.png","mimeType":"image/png","category":"art","isWip":false}),
    )
    .await;
    ok("gallery work", s, &work);
    let (s, incident) = request(app, Method::POST, &format!("/incidents/{ch}"), auth, json!({"title":"seed","description":"seed","severity":"low"})).await;
    ok("incident", s, &incident);
    let seeds = Seeds {
        page: page["page_id"].as_str().or(page["pageId"].as_str()).unwrap().to_string(),
        album: album["album"]["id"].as_str().or(album["album"]["album_id"].as_str()).unwrap().to_string(),
        work: work["work_id"].as_str().or(work["workId"].as_str()).unwrap().to_string(),
        incident: incident["incident_id"].as_str().or(incident["incidentId"].as_str()).unwrap().to_string(),
    };
    // Every update probe is valid in the readable room too.
    let accepted = feature_text_paths(app, auth, None, ch, "seed-probe", Some(&seeds), false).await;
    assert_eq!(accepted.len(), feature_path_count(true), "readable room must accept every probe: {accepted:#?}");
    seeds
}

fn feature_path_count(with_seeds: bool) -> usize {
    // wiki, album, gallery work, incident, whiteboard doc, image, font, upload
    8 + if with_seeds { 5 } else { 0 }
}

/// Probe every feature path that stores readable text against `ch`. With
/// `expect_refusal`, each refusal must name the encryption policy.
async fn feature_text_paths(
    app: &Router,
    auth: &str,
    mut sio: Option<&mut Client>,
    ch: &str,
    m: &str,
    seeds: Option<&Seeds>,
    expect_refusal: bool,
) -> Vec<String> {
    let mut accepted = vec![];
    let mut check = |path: &str, status: StatusCode, body: &Value| {
        if status.is_success() {
            accepted.push(format!("{path} ({status})"));
        } else if expect_refusal {
            policy_refusal(path, status, body);
        } else {
            panic!("{path} refused in a readable room: {status} {body}");
        }
    };
    let (s, b) = request(app, Method::POST, &format!("/wiki/{ch}/pages"), auth, json!({"title":format!("{m} wiki title"),"body":format!("{m} wiki body")})).await;
    check("POST wiki page", s, &b);
    let (s, b) = request(app, Method::POST, "/albums", auth, json!({"scopeType":"dm","scopeId":ch,"name":format!("{m} album name")})).await;
    check("POST album", s, &b);
    let (s, b) = request(
        app,
        Method::POST,
        &format!("/gallery/{ch}/works"),
        auth,
        json!({"title":format!("{m} work title"),"caption":format!("{m} work caption"),"attachmentUrl":"/uploads/x.png","mimeType":"image/png","category":"art","isWip":false}),
    )
    .await;
    check("POST gallery work", s, &b);
    let (s, b) = request(app, Method::POST, &format!("/incidents/{ch}"), auth, json!({"title":format!("{m} incident"),"description":format!("{m} incident body"),"severity":"low"})).await;
    check("POST incident", s, &b);
    let (_, doc) = request(app, Method::GET, &format!("/whiteboard/boards/{ch}/document"), auth, Value::Null).await;
    let version = doc["document"]["version"].as_u64().or(doc["version"].as_u64()).unwrap_or(0);
    let (s, b) = request(
        app,
        Method::PUT,
        &format!("/whiteboard/boards/{ch}/document"),
        auth,
        json!({"version":version,"elements":[{"id":"t1","type":"text","text":format!("{m} whiteboard text")}]}),
    )
    .await;
    check("PUT whiteboard document", s, &b);
    let (content_type, body) = multipart("file", &format!("{m}-sketch.png"), "image/png", format!("\u{89}PNG {m} image bytes").as_bytes());
    let (s, b) = raw_request(app, Method::POST, &format!("/whiteboard/boards/{ch}/images"), auth, &[("content-type", content_type)], body).await;
    check("POST whiteboard image", s, &b);
    let (content_type, body) = multipart("file", &format!("{m}-font.woff2"), "font/woff2", format!("wOF2 {m} font bytes").as_bytes());
    let (s, b) = raw_request(app, Method::POST, &format!("/whiteboard/boards/{ch}/fonts"), auth, &[("content-type", content_type)], body).await;
    check("POST whiteboard font", s, &b);
    let (s, b) = resumable_upload(app, auth, ch, &format!("{m}-secret-plan.txt"), "text/plain", format!("{m} upload bytes").as_bytes()).await;
    check("resumable upload (plaintext name and bytes)", s, &b);

    if let Some(seeds) = seeds {
        let (_, page) = request(app, Method::GET, &format!("/wiki/{ch}/pages/{}", seeds.page), auth, Value::Null).await;
        let updated = page["updated_at_micros"].as_i64().or(page["updatedAtMicros"].as_i64()).unwrap_or_else(|| panic!("wiki page: {page}"));
        let (s, b) = request(
            app,
            Method::PUT,
            &format!("/wiki/{ch}/pages/{}", seeds.page),
            auth,
            json!({"expectedUpdatedAtMicros":updated,"title":format!("{m} wiki edit"),"body":format!("{m} wiki edit body")}),
        )
        .await;
        check("PUT wiki page", s, &b);
        let (s, b) = request(
            app,
            Method::POST,
            &format!("/albums/{}/items", seeds.album),
            auth,
            json!({"attachmentUrl":"/uploads/x.png","attachmentName":format!("{m}-holiday.png"),"caption":format!("{m} album caption")}),
        )
        .await;
        check("POST album item", s, &b);
        let (s, b) = request(
            app,
            Method::PUT,
            &format!("/gallery/{ch}/works/{}", seeds.work),
            auth,
            json!({"title":format!("{m} work edit"),"caption":format!("{m} caption edit"),"category":"art","isWip":false}),
        )
        .await;
        check("PUT gallery work", s, &b);
        let (s, b) = request(
            app,
            Method::POST,
            &format!("/gallery/{ch}/works/{}/feedback", seeds.work),
            auth,
            json!({"comment":format!("{m} feedback"),"xPercent":1.0,"yPercent":1.0}),
        )
        .await;
        check("POST gallery feedback", s, &b);
        let (s, b) = request(
            app,
            Method::PUT,
            &format!("/incidents/{ch}/{}", seeds.incident),
            auth,
            json!({"title":format!("{m} incident edit"),"description":format!("{m} incident edit body")}),
        )
        .await;
        check("PUT incident", s, &b);
    }

    if let Some(sio) = sio.as_deref_mut() {
        let (_, doc) = request(app, Method::GET, &format!("/whiteboard/boards/{ch}/document"), auth, Value::Null).await;
        let version = doc["document"]["version"].as_u64().or(doc["version"].as_u64()).unwrap_or(0);
        sio.emit("whiteboard:join", json!({"boardId":ch})).await;
        let _ = sio.event_one_of(&["whiteboard:joined", "whiteboard:error"]).await;
        sio.emit(
            "whiteboard:snapshot",
            json!({"boardId":ch,"document":{"version":version,"elements":[{"id":"s1","type":"text","text":format!("{m} socket snapshot")}]}}),
        )
        .await;
        let (event, body) = sio.event_one_of(&["whiteboard:ack", "whiteboard:error"]).await;
        if event == "whiteboard:ack" {
            accepted.push("socket.io whiteboard:snapshot".into());
        } else if expect_refusal {
            assert_policy_reason("socket.io whiteboard:snapshot", &body);
        }
        sio.emit(
            "whiteboard:patch",
            json!({"boardId":ch,"patch":{"op":"create","patchId":"p1","element":{"id":"p1","type":"text","text":format!("{m} socket patch")}}}),
        )
        .await;
        let (event, body) = sio.event_one_of(&["whiteboard:ack", "whiteboard:error"]).await;
        if event == "whiteboard:ack" {
            accepted.push("socket.io whiteboard:patch".into());
        } else if expect_refusal {
            assert_policy_reason("socket.io whiteboard:patch", &body);
        }
    }
    accepted
}

#[tokio::test]
async fn feature_surfaces_refuse_readable_text_in_encrypted_and_pending_conversations() {
    let logs = captured_logs();
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let app = router(&state);
    let m = format!("FEATURE-{}", uuid::Uuid::new_v4().simple());
    let a = user(&state, "feature-a").await;
    let b = user(&state, "feature-b").await;
    let auth = bearer(&state, a);
    let mut sio_a = Client::connect(&app, &token(&state, a)).await;

    // Existing group: every probe is accepted while server-readable...
    let group = "group-feature-surfaces".to_string();
    state.wdb.create_group(&group, "features", a, &[a, b]).await.unwrap();
    let seeds = seed_readable_features(&app, &auth, &group).await;
    // ...and refused once experimental encryption is enabled.
    for (uid, device) in [(a, device_id(a, 1)), (b, device_id(b, 1))] {
        register_device(&app, &state, uid, &device).await;
    }
    let (status, body) = set_room(&app, &state, (a, &device_id(a, 1)), &group, 1, &[(a, device_id(a, 1)), (b, device_id(b, 1))], false).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let accepted = feature_text_paths(&app, &auth, Some(&mut sio_a), &group, &m, Some(&seeds), true).await;
    let mut failures = vec![format!("encrypted group: {accepted:?}")];
    let mut any = !accepted.is_empty();

    // New group and new DM, created pending through the real paths.
    sio_a.emit("create-group", json!({"requestId":uuid::Uuid::new_v4().to_string(),"groupName":"pending","userIds":[format!("user-{b}")]})).await;
    let pending_group = sio_a.event("group-created").await["channelId"].as_str().unwrap().to_string();
    let c = user(&state, "feature-c").await;
    sio_a.emit("create-dm", json!({"targetUserId":format!("user-{c}")})).await;
    let pending_dm = sio_a.event("dm-created").await["channelId"].as_str().unwrap().to_string();
    for (name, ch) in [("pending group", &pending_group), ("pending DM", &pending_dm)] {
        let accepted = feature_text_paths(&app, &auth, Some(&mut sio_a), ch, &m, None, true).await;
        any |= !accepted.is_empty();
        failures.push(format!("{name}: {accepted:?}"));
    }
    assert!(!any, "readable text accepted:\n{}", failures.join("\n"));

    // The opaque upload shape the shipped client sends is still accepted in
    // the encrypted room; nothing names the original file.
    let opaque = format!("e2ee-{}.wabi", uuid::Uuid::new_v4());
    let (status, body) = resumable_upload(&app, &auth, &group, &opaque, "application/octet-stream", b"opaque-ciphertext-bytes").await;
    assert!(status.is_success(), "opaque encrypted upload refused: {status} {body}");

    // Per-sender consent: after a chooses server-readable in the pending
    // group, a's feature writes are admitted and b's are still refused.
    let (status, _) = request(&app, Method::POST, &format!("/e2ee/channels/{pending_group}/allow-server-readable"), &auth, Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = request(&app, Method::POST, &format!("/wiki/{pending_group}/pages"), &auth, json!({"title":"a consented","body":"a consented"})).await;
    assert_eq!(status, StatusCode::OK, "consenting sender: {body}");
    let accepted = feature_text_paths(&app, &bearer(&state, b), None, &pending_group, &m, None, true).await;
    assert!(accepted.is_empty(), "a's consent admitted b's readable text: {accepted:?}");

    let hits: Vec<_> = files_containing(dir.path(), &m)
        .into_iter()
        .chain(files_containing(Path::new(&state.config.uploads_dir), &m))
        .collect();
    assert!(hits.is_empty(), "{m} written to {hits:?}");
    let logs = String::from_utf8_lossy(&logs.lock().unwrap()).into_owned();
    assert!(!logs.contains(&m), "{m} in tracing output");
}

// ---------------------------------------------------------------------------
// Round 2: what may ride beside or inside an envelope; reactions; bots
// ---------------------------------------------------------------------------

/// Upload an opaque, client-encrypted file to `ch` and return its served URL.
async fn opaque_upload(app: &Router, auth: &str, ch: &str) -> String {
    let name = format!("e2ee-{}.wabi", uuid::Uuid::new_v4());
    let (status, body) = resumable_upload(app, auth, ch, &name, "application/octet-stream", &random_bytes(64)).await;
    assert!(status.is_success(), "opaque upload: {status} {body}");
    body["fileUrl"].as_str().unwrap_or_else(|| panic!("no fileUrl: {body}")).to_string()
}

#[tokio::test]
async fn encrypted_messages_carry_only_server_issued_upload_references() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let app = router(&state);
    let room = encrypted_group(&app, &state, "attach", &["a", "b"]).await;
    let other = encrypted_group(&app, &state, "attach-other", &["c", "d"]).await;
    let a = room.users[0];
    let auth = bearer(&state, a);
    let m = format!("ATTACH-{}", uuid::Uuid::new_v4().simple());
    let issued = opaque_upload(&app, &auth, &room.ch).await;
    let foreign = opaque_upload(&app, &bearer(&state, other.users[0]), &other.ch).await;
    let mut sio = Client::connect(&app, &token(&state, a)).await;

    for (name, extra) in [
        ("free-text fileUrl", json!({"fileUrl":format!("https://example.invalid/{m}"),"fileName":"x"})),
        // `files[]` entries are decoded as snake_case records (see the PR notes:
        // camelCase entries are dropped before this check ever sees them).
        ("free-text files[]", json!({"files":[{"file_url":format!("/uploads/{m} meet at noon"),"file_name":"x","file_size":1}]})),
        ("another room's upload", json!({"files":[{"file_url":foreign,"file_name":"x","file_size":1}]})),
        ("path escape", json!({"files":[{"file_url":format!("/uploads/../{m}"),"file_name":"x","file_size":1}]})),
    ] {
        let mut payload = json!({"channelId":room.ch,"clientMessageId":name,"text":room.envelope(&app, &state, 0, 1).await});
        for (key, value) in extra.as_object().unwrap() {
            payload[key] = value.clone();
        }
        let (event, body) = sio.send(payload).await;
        assert_eq!(event, "message-error", "{name}: {body}");
        assert_eq!(body["code"], "e2ee_attachment_invalid", "{name}: {body}");
    }
    let (event, body) = sio
        .send(json!({"channelId":room.ch,"clientMessageId":"issued","text":room.envelope(&app, &state, 0, 1).await,
                     "files":[{"file_url":issued,"file_name":format!("{m}-original.pdf"),"file_size":12345}]}))
        .await;
    assert_eq!(event, "message-accepted", "{body}");
    let messages = state.wdb.list_messages_typed(&room.ch, 10).await.unwrap();
    assert_eq!(messages.len(), 1);
    let stored = serde_json::to_string(&messages).unwrap();
    assert!(!stored.contains(&m), "beside-envelope text stored: {stored}");
    assert_eq!(messages[0].files.len(), 1);
    assert_eq!(messages[0].files[0].file_url, issued);
    assert_eq!(messages[0].files[0].file_name, "encrypted.bin");
    let seen = sio.drain().await;
    assert!(!seen.contains(&m), "beside-envelope text relayed: {seen}");
}

#[tokio::test]
async fn envelopes_must_have_the_client_shape_and_nothing_else() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let app = http(&state);
    let room = encrypted_group(&app, &state, "shape", &["a", "b"]).await;
    let a = room.users[0];
    let revision = current_revision(&app, &state, a, &room.ch).await;
    let valid: Value = serde_json::from_str(room.envelope(&app, &state, 0, 1).await.strip_prefix(PREFIX).unwrap()).unwrap();
    let send = |content: String| {
        let (app, auth, ch) = (app.clone(), bearer(&state, a), room.ch.clone());
        async move { request(&app, Method::POST, "/messages", &auth, json!({"channel_id":ch,"content":content})).await }
    };
    let variant = |edit: &dyn Fn(&mut Value)| {
        let mut envelope = valid.clone();
        edit(&mut envelope);
        format!("{PREFIX}{envelope}")
    };
    let cases: Vec<(&str, String)> = vec![
        ("extra plaintext field", variant(&|e| e["plaintext"] = json!("meet at noon"))),
        ("extra preview field", variant(&|e| e["preview"] = json!("meet at noon"))),
        ("readable ciphertext", variant(&|e| e["ciphertext"] = json!("meet at noon, bring the documents"))),
        ("base64 of a short readable value", variant(&|e| e["ciphertext"] = json!(b64(b"hi there")))),
        ("empty iv", variant(&|e| e["iv"] = json!(""))),
        ("empty signature", variant(&|e| e["signature"] = json!(""))),
        ("wrong iv length", variant(&|e| e["iv"] = json!(b64(&random_bytes(16))))),
        ("wrong signature length", variant(&|e| e["signature"] = json!(b64(&random_bytes(32))))),
        ("signature not base64", variant(&|e| e["signature"] = json!("not base64 at all!"))),
        ("version 2", variant(&|e| e["v"] = json!(2))),
        ("membership revision as a number", variant(&|e| e["membershipRevision"] = json!(revision.parse::<u64>().unwrap()))),
    ];
    for (name, content) in cases {
        let (status, body) = send(content).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{name}: {body}");
    }
    let (status, body) = send(format!("{PREFIX}{valid}")).await;
    assert_eq!(status, StatusCode::OK, "the client's exact shape: {body}");
    let stored = stored(&state, &room.ch).await;
    assert_eq!(stored.len(), 1);
    assert!(!stored[0].contains("meet at noon"));

    // An envelope is refused outright in a room that is not encrypted.
    let plain = "group-shape-readable";
    state.wdb.create_group(plain, "readable", a, &[a, room.users[1]]).await.unwrap();
    let (status, _) = request(
        &app,
        Method::POST,
        "/messages",
        &bearer(&state, a),
        json!({"channel_id":plain,"content":envelope(plain, 1, "1", &room.devices[0])}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn reactions_are_emoji_identifiers_not_free_text() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let app = router(&state);
    let a = user(&state, "react-a").await;
    let b = user(&state, "react-b").await;
    let ch = "group-react";
    state.wdb.create_group(ch, "react", a, &[a, b]).await.unwrap();
    let message = state.wdb.send_message(ch, a, "hello", false, &[]).await.unwrap();
    let mut sio = Client::connect(&app, &token(&state, a)).await;
    for emoji in ["meet me at the station at noon", "x", "emo_", "emo_has space", "1F44D-hello", &"1F44D-".repeat(12)] {
        sio.emit("add-emoji-reaction", json!({"channelId":ch,"messageId":message,"emojiId":emoji})).await;
        let error = sio.event("reaction-error").await;
        assert_eq!(error["error"], "Unknown emoji", "{emoji}: {error}");
    }
    assert!(state.wdb.list_reactions(&message).await.unwrap().is_empty());
    sio.emit("join-channel", json!(ch)).await;
    sio.event("channel-messages").await;
    for emoji in ["1F44D", "1F468-200D-1F469-200D-1F467", "emo_party_parrot", "👍", "👍🏽"] {
        sio.emit("add-emoji-reaction", json!({"channelId":ch,"messageId":message,"emojiId":emoji})).await;
        assert_eq!(sio.event("emoji-reaction-added").await["emojiId"], emoji);
    }
    let stored = serde_json::to_string(&state.wdb.list_reactions(&message).await.unwrap()).unwrap();
    for emoji in ["1F44D", "1F468-200D-1F469-200D-1F467", "emo_party_parrot", "👍🏽"] {
        assert!(stored.contains(emoji), "{emoji} missing from {stored}");
    }
}

#[tokio::test]
async fn bots_post_in_a_new_room_only_after_every_human_member_chose_server_readable() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let app = router(&state);
    let a = user(&state, "botrule-a").await;
    let b = user(&state, "botrule-b").await;
    let bot = user(&state, "botrule-bot").await;
    let (bot_token, _) = state.bot_registry.create(bot).await.unwrap();
    let mut sio_a = Client::connect(&app, &token(&state, a)).await;
    sio_a
        .emit("create-group", json!({"requestId":uuid::Uuid::new_v4().to_string(),"groupName":"botrule","userIds":[format!("user-{b}")]}))
        .await;
    let group = sio_a.event("group-created").await["channelId"].as_str().unwrap().to_string();
    state.wdb.add_channel_member(&group, bot, MemberRole::Member).await.unwrap();
    let post = |text: &str| {
        let (app, credential, ch, text) = (app.clone(), format!("Bot {bot_token}"), group.clone(), text.to_string());
        async move { request(&app, Method::POST, "/bot/send-message", &credential, json!({"channel_id":ch,"content":text})).await }
    };
    let consent = |uid: u64| {
        let (app, auth, ch) = (app.clone(), bearer(&state, uid), group.clone());
        async move { request(&app, Method::POST, &format!("/e2ee/channels/{ch}/allow-server-readable"), &auth, Value::Null).await.0 }
    };

    let (status, body) = post("bot while pending").await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "pending: {body}");
    // The pending refusal itself, not only the every-member rule that would
    // also refuse here (nobody has chosen server-readable yet).
    assert!(body.to_string().contains("pending or enabled"), "pending: {body}");
    assert_eq!(consent(a).await, StatusCode::OK);
    let (status, body) = post("bot after one member chose").await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "b has not chosen server-readable: {body}");
    assert_policy_reason("bot before every member chose", &body);
    assert_eq!(consent(b).await, StatusCode::OK);
    let (status, body) = post("bot after everyone chose").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let contents = stored(&state, &group).await;
    assert_eq!(contents, vec!["bot after everyone chose".to_string()]);
}

// ---------------------------------------------------------------------------
// Round 2: one test per check that a mutation run showed was unguarded
// ---------------------------------------------------------------------------

#[tokio::test]
async fn new_forum_post_in_existing_thread_is_refused_after_encryption_and_on_a_damaged_registry() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let app = http(&state);
    let a = user(&state, "forum2-a").await;
    let b = user(&state, "forum2-b").await;
    let ch = "group-forum2";
    state.wdb.create_group(ch, "forum2", a, &[a, b]).await.unwrap();
    let auth = bearer(&state, a);
    let (status, thread) = request(&app, Method::POST, &format!("/forum/{ch}/threads"), &auth, json!({"title":"t","body":"before"})).await;
    assert_eq!(status, StatusCode::OK, "{thread}");
    let thread_id = thread["thread_id"].as_str().unwrap().to_string();
    for (uid, device) in [(a, device_id(a, 1)), (b, device_id(b, 1))] {
        register_device(&app, &state, uid, &device).await;
    }
    let (status, _) = set_room(&app, &state, (a, &device_id(a, 1)), ch, 1, &[(a, device_id(a, 1)), (b, device_id(b, 1))], false).await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = request(
        &app,
        Method::POST,
        &format!("/forum/{ch}/threads/{thread_id}/posts"),
        &auth,
        json!({"body":"PLAINTEXT reply after encryption"}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");

    // Damaged registry: conversations fail closed. An ordinary room never
    // reads the registry, so its forum keeps working.
    let text = state.wdb.create_channel("general", wabidb::domain::ChannelKind::Text, a, false).await.unwrap();
    state.wdb.add_channel_member(&text, a, MemberRole::Member).await.unwrap();
    std::fs::write(dir.path().join("e2ee_state.json"), b"{damaged").unwrap();
    let (status, body) = request(&app, Method::POST, &format!("/forum/{ch}/threads"), &auth, json!({"title":"t","body":"damaged"})).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "conversation with damaged registry: {body}");
    let (status, body) = request(&app, Method::POST, &format!("/forum/{text}/threads"), &auth, json!({"title":"t","body":"public"})).await;
    assert_eq!(status, StatusCode::OK, "ordinary room must not depend on the registry: {body}");
    assert!(state.wdb.list_forum_posts(ch, &thread_id).await.unwrap().iter().all(|p| !p.body.contains("PLAINTEXT")));
}

#[tokio::test]
async fn revision_device_set_and_sender_checks_each_refuse_on_their_own() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let app = http(&state);
    let room = encrypted_group(&app, &state, "standalone", &["a", "b"]).await;
    let (a, b) = (room.users[0], room.users[1]);
    let send = |content: String| {
        let (app, auth, ch) = (app.clone(), bearer(&state, a), room.ch.clone());
        async move { request(&app, Method::POST, "/messages", &auth, json!({"channel_id":ch,"content":content})).await }
    };
    let revision = current_revision(&app, &state, a, &room.ch).await;

    // Sender device must be registered to the sending account.
    let (status, body) = send(envelope(&room.ch, 1, &revision, &room.devices[1])).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "a used b's device: {body}");
    assert!(body.to_string().contains("unregistered or revoked device"), "{body}");

    // Device set changes, revision does not: only the device-set check refuses.
    let old = envelope(&room.ch, 1, &revision, &room.devices[0]);
    register_device(&app, &state, b, &device_id(b, 2)).await;
    assert_eq!(current_revision(&app, &state, a, &room.ch).await, revision);
    let (status, body) = send(old.clone()).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "device set changed: {body}");
    assert!(body.to_string().contains("device set changed"), "{body}");
    let mut recipients = room.recipients(&[0, 1]);
    recipients.push((b, device_id(b, 2)));
    let (status, body) = set_room(&app, &state, room.device(0), &room.ch, 2, &recipients, true).await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // Revision changes, device set does not (the new member has no device yet,
    // so the expected devices are unchanged): only the revision check refuses.
    let fresh = envelope(&room.ch, 2, &revision, &room.devices[0]);
    let late = user(&state, "standalone-late").await;
    state.wdb.add_channel_member(&room.ch, late, MemberRole::Member).await.unwrap();
    assert_ne!(current_revision(&app, &state, a, &room.ch).await, revision);
    let (status, body) = send(fresh).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "membership changed: {body}");
    assert!(body.to_string().contains("membership changed"), "{body}");
}

#[tokio::test]
async fn device_identities_cannot_be_silently_replaced_or_restored() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let app = http(&state);
    let a = user(&state, "devices-a").await;
    let device = device_id(a, 1);
    register_device(&app, &state, a, &device).await;
    let (status, _) = request(
        &app,
        Method::POST,
        "/e2ee/devices",
        &bearer(&state, a),
        json!({"deviceId":device,"encryptionPublicKey":opaque_key(),"signingPublicKey":opaque_key()}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "same device id, different keys");
    let registry = std::fs::read_to_string(dir.path().join("e2ee_state.json")).unwrap();
    let (status, _) = request(&app, Method::DELETE, &format!("/e2ee/devices/{device}"), &bearer(&state, a), Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    let original: Value = serde_json::from_str(&registry).unwrap();
    let keys = &original["devices"][0];
    let (status, _) = request(
        &app,
        Method::POST,
        "/e2ee/devices",
        &bearer(&state, a),
        json!({"deviceId":device,"encryptionPublicKey":keys["encryptionPublicKey"],"signingPublicKey":keys["signingPublicKey"]}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "revoked device restored with its own keys");
    let after: Value = serde_json::from_slice(&std::fs::read(dir.path().join("e2ee_state.json")).unwrap()).unwrap();
    assert!(!after["devices"][0]["revokedAt"].is_null());
}

#[tokio::test]
async fn room_key_changes_require_current_revision_registered_sender_next_epoch_and_every_member_device() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let app = http(&state);
    let room = encrypted_group(&app, &state, "setroom", &["a", "b"]).await;
    let (a, b) = (room.users[0], room.users[1]);
    let revision = current_revision(&app, &state, a, &room.ch).await;
    let rekey = |epoch: u64, revision: String, sender: String, recipients: Vec<(u64, String)>| {
        let (app, auth, ch) = (app.clone(), bearer(&state, a), room.ch.clone());
        async move {
            let envelopes: Vec<Value> = recipients.iter().map(|(uid, device)| wrapped(*uid, device, &sender)).collect();
            request(&app, Method::POST, &format!("/e2ee/channels/{ch}/rekey"), &auth,
                json!({"senderDeviceId":sender,"epoch":epoch,"membershipRevision":revision,"envelopes":envelopes})).await.0
        }
    };
    let all = room.recipients(&[0, 1]);
    let stale = (revision.parse::<u64>().unwrap() - 1).to_string();
    assert_eq!(rekey(2, stale, room.devices[0].clone(), all.clone()).await, StatusCode::CONFLICT, "stale revision");
    assert_eq!(rekey(2, revision.clone(), device_id(a, 7), all.clone()).await, StatusCode::FORBIDDEN, "unregistered sender device");
    assert_eq!(rekey(2, revision.clone(), room.devices[1].clone(), all.clone()).await, StatusCode::FORBIDDEN, "another account's device");
    assert_eq!(rekey(3, revision.clone(), room.devices[0].clone(), all.clone()).await, StatusCode::CONFLICT, "epoch skipped");
    assert_eq!(rekey(1, revision.clone(), room.devices[0].clone(), all.clone()).await, StatusCode::CONFLICT, "epoch repeated");
    assert_eq!(rekey(2, revision.clone(), room.devices[0].clone(), all.clone()).await, StatusCode::OK, "control");

    // Enabling requires every member to have a device.
    let c = user(&state, "setroom-c").await;
    let ch = "group-setroom-nodevice";
    state.wdb.create_group(ch, "nodevice", a, &[a, b, c]).await.unwrap();
    let (status, body) = set_room(&app, &state, room.device(0), ch, 1, &room.recipients(&[0, 1]), false).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert!(body.to_string().contains("Every participant needs an E2EE device"), "{body}");
    let (_, status) = room_status(&app, &state, a, ch).await;
    assert_eq!(status["enabled"], false);
}

#[tokio::test]
async fn staff_cannot_replace_a_members_ciphertext_even_with_a_valid_envelope() {
    let dir = tempfile::tempdir().unwrap();
    let mut config = server_config(dir.path());
    let state = open_server(config.clone()).await;
    let app = http(&state);
    let room = encrypted_group(&app, &state, "staffedit", &["member", "admin"]).await;
    let (member, admin) = (room.users[0], room.users[1]);
    let (status, body) = request(
        &app,
        Method::POST,
        "/messages",
        &bearer(&state, member),
        json!({"channel_id":room.ch,"content":room.envelope(&app, &state, 0, 1).await}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let message = body["id"].as_str().unwrap().to_string();
    drop(app);
    drop(state);
    // Restart (HTTP-only phase above) with the second account as a configured admin.
    config.admin_user_ids = vec![admin as i64];
    let state = open_server(config).await;
    let app = router(&state);
    assert!(state.is_admin(admin as i64).await);
    let original = stored(&state, &room.ch).await;
    let mut sio_admin = Client::connect(&app, &token(&state, admin)).await;
    sio_admin
        .emit("edit-message", json!({"channelId":room.ch,"messageId":message,"newText":room.envelope(&app, &state, 1, 1).await}))
        .await;
    let error = sio_admin.event("edit-error").await;
    assert_eq!(error["error"], "Cannot edit others' messages", "{error}");
    assert_eq!(stored(&state, &room.ch).await, original);
}
