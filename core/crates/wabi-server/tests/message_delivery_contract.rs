//! Real Socket.IO → WabiStore completion → sender/recipient outcome contract.
//! Temporary engines only; no fault injection or account changes on live data.
use axum::{
    body::{to_bytes, Body},
    http::{Method, Request, StatusCode},
    Json, Router,
};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tower::ServiceExt;
use wabi_server::{
    api::routes::create_api_router,
    auth_extractor::JwtClaims,
    config::{LoreAddonConfig, ServerConfig, ServerRole},
    state::AppState,
};
use wabidb::{
    domain::{ChannelKind, MemberRole, MuteRecord},
    engine::wabi_store::WabiStore,
    format::record::RecordKind,
    sequencer::types::{CommandCommit, EventToWrite},
};

async fn server(path: &Path) -> Arc<AppState> {
    Arc::new(
        AppState::new(ServerConfig {
            host: "127.0.0.1".into(),
            port: 0,
            data_dir: path.to_string_lossy().into_owned(),
            uploads_dir: path.join("uploads").to_string_lossy().into_owned(),
            jwt_secret: "message-delivery-contract-only".into(),
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

fn router(state: &Arc<AppState>) -> Router {
    create_api_router(state.clone())
        .with_state(state.clone())
        .layer(wabi_server::socketio::create_socket_layer(state.clone()))
}

async fn seed(state: &AppState) -> (u64, u64, String) {
    let sender = state
        .wdb
        .create_user("sender", None, "registered-test-hash")
        .await
        .unwrap();
    let recipient = state
        .wdb
        .create_user("recipient", None, "registered-test-hash")
        .await
        .unwrap();
    let channel = state
        .wdb
        .create_channel("Delivery", ChannelKind::Text, sender, false)
        .await
        .unwrap();
    for user in [sender, recipient] {
        state
            .wdb
            .add_channel_member(&channel, user, MemberRole::Member)
            .await
            .unwrap();
    }
    (sender, recipient, channel)
}

struct Client {
    app: Router,
    sid: String,
    events: Vec<Value>,
}
impl Client {
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
        .expect("socket timeout")
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
        if !token.is_empty() {
            client.emit("join", json!("test client")).await;
            client.event("init").await;
        }
        client
    }
    async fn emit(&self, event: &str, payload: Value) {
        Self::transport(
            &self.app,
            Method::POST,
            &self.path(),
            format!("42{}", json!([event, payload])),
        )
        .await;
    }
    async fn event(&mut self, name: &str) -> Value {
        self.event_one_of(&[name]).await.1
    }
    async fn event_one_of(&mut self, names: &[&str]) -> (String, Value) {
        for _ in 0..20 {
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
        panic!("missing {names:?} event");
    }
    async fn join_channel(&mut self, channel: &str) {
        self.emit("join-channel", json!(channel)).await;
        assert_eq!(self.event("channel-messages").await["channelId"], channel);
    }
    async fn assert_no_delivery(&mut self) {
        // Read-only socket round trip drains prior events, without a timeout
        // standing in for the sender's correlated application outcome.
        self.emit("get-role-definitions", json!(null)).await;
        self.event("role-definitions-updated").await;
        assert!(
            !self.events.iter().any(|event| matches!(
                event[0].as_str(),
                Some("message" | "message-accepted" | "retry-message-ack")
            )),
            "{:?}",
            self.events
        );
    }
}

struct WebhookProbe {
    url: String,
    received: tokio::sync::mpsc::UnboundedReceiver<Value>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for WebhookProbe {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl WebhookProbe {
    async fn start() -> Self {
        let (sent, received) = tokio::sync::mpsc::unbounded_channel();
        let app = Router::new().route(
            "/",
            axum::routing::post(move |Json(payload): Json<Value>| {
                let sent = sent.clone();
                async move {
                    sent.send(payload).unwrap();
                    StatusCode::NO_CONTENT
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self {
            url,
            received,
            task,
        }
    }
    async fn next(&mut self) -> Value {
        tokio::time::timeout(Duration::from_secs(3), self.received.recv())
            .await
            .expect("webhook not received")
            .unwrap()
    }
}

async fn poison_writer(state: &AppState) {
    // Same real durable-then-projection failure as write_visibility_contract.
    // The engine stops writes, but previously applied auth/channel reads work.
    let engine = state.wdb.engine();
    engine
        .get_or_create_stream_key("delivery-fault")
        .await
        .unwrap();
    assert!(engine
        .run_command(CommandCommit {
            caller_user_id: 1,
            caller_device_id: "test".into(),
            command_name: "delivery-fault".into(),
            idempotency_key: None,
            essential: true,
            response_tx: tokio::sync::oneshot::channel().0,
            events: vec![EventToWrite {
                stream_id: "delivery-fault".into(),
                stream_kind: 6,
                event_type: "user_registered".into(),
                record_kind: RecordKind::Event,
                plaintext: vec![]
            }],
        })
        .await
        .is_err());
    assert!(!engine.is_healthy());
}

#[tokio::test]
async fn committed_text_is_accepted_but_failed_text_and_file_writes_have_no_success_effects() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (sender_id, recipient_id, channel) = seed(&state).await;
    let mut webhook = WebhookProbe::start().await;
    state
        .wdb
        .upsert_webhook(&channel, "delivery fixture", &webhook.url)
        .await
        .unwrap();
    let app = router(&state);
    let mut sender = Client::connect(&app, &token(&state, sender_id)).await;
    let mut recipient = Client::connect(&app, &token(&state, recipient_id)).await;
    recipient.join_channel(&channel).await;
    sender
        .emit(
            "message",
            json!({"channelId":channel,"clientMessageId":"committed","text":"durable control"}),
        )
        .await;
    let accepted = sender.event("message-accepted").await;
    assert_eq!(accepted["clientMessageId"], "committed");
    let id = accepted["messageId"].as_str().unwrap();
    assert!(id.starts_with("msg_"));
    assert_eq!(
        state
            .wdb
            .get_message_typed(id)
            .await
            .unwrap()
            .unwrap()
            .content,
        "durable control"
    );
    assert_eq!(recipient.event("message").await["message"]["id"], id);
    assert_eq!(
        webhook.next().await["message_id"],
        id,
        "positive control proves webhook delivery is active"
    );
    let cached = state.session_messages.read().await.clone();
    poison_writer(&state).await;
    let watermark = state.wdb.engine().projection_state().applied_commit_seq();
    for (nonce, kind) in [("failed-text", "text"), ("failed-file", "file")] {
        sender
            .emit(
                "message",
                json!({"channelId":channel,"clientMessageId":nonce,"text":"must not publish",
            "type":kind,"fileUrl":"/uploads/fixture.txt","fileName":"fixture.txt","fileSize":1}),
            )
            .await;
        let (event, error) = sender
            .event_one_of(&["message-error", "message-accepted"])
            .await;
        assert_eq!(
            event, "message-error",
            "failed persistence must never be accepted"
        );
        assert_eq!(
            error,
            json!({
                "channelId":channel,"clientMessageId":nonce,"code":"persistence_unconfirmed","outcome":"unknown",
                "error":"Delivery could not be confirmed. Check history before sending again."
            }),
            "wire errors are correlated and never expose database internals"
        );
        sender.assert_no_delivery().await;
        recipient.assert_no_delivery().await;
        assert_eq!(*state.session_messages.read().await, cached);
        assert_eq!(
            state
                .wdb
                .list_messages_typed(&channel, 100)
                .await
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            state.wdb.engine().projection_state().applied_commit_seq(),
            watermark
        );
    }
    // The only negative network observation is bounded, with an actual HTTP
    // positive control above. No external destination or timing sleep is used.
    assert!(
        tokio::time::timeout(Duration::from_millis(200), webhook.received.recv())
            .await
            .is_err(),
        "a rejected/unknown send must not trigger a webhook"
    );
}

fn segment_sizes(path: &Path) -> Vec<(PathBuf, u64)> {
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(path).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            entries.extend(segment_sizes(&path));
        } else if path.extension().is_some_and(|ext| ext == "wseg") {
            entries.push((path.clone(), std::fs::metadata(path).unwrap().len()));
        }
    }
    entries.sort();
    entries
}

#[tokio::test]
async fn live_text_is_accepted_and_broadcast_without_a_durable_write() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (sender_id, recipient_id, channel) = seed(&state).await;
    state
        .channel_auto_delete_label
        .write()
        .await
        .insert(channel.clone(), "live".into());
    let app = router(&state);
    let mut sender = Client::connect(&app, &token(&state, sender_id)).await;
    let mut recipient = Client::connect(&app, &token(&state, recipient_id)).await;
    recipient.join_channel(&channel).await;
    let before = segment_sizes(dir.path());
    let watermark = state.wdb.engine().projection_state().applied_commit_seq();
    sender
        .emit(
            "message",
            json!({"channelId":channel,"clientMessageId":"live-control","text":"session only"}),
        )
        .await;
    let accepted = sender.event("message-accepted").await;
    assert_eq!(accepted["clientMessageId"], "live-control");
    assert!(accepted["messageId"].as_str().unwrap().starts_with("live_"));
    assert_eq!(
        recipient.event("message").await["message"]["id"],
        accepted["messageId"]
    );
    assert_eq!(
        state.session_messages.read().await[&channel][0]["text"],
        "session only"
    );
    assert!(state
        .wdb
        .list_messages_typed(&channel, 100)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        state.wdb.engine().projection_state().applied_commit_seq(),
        watermark
    );
    assert_eq!(
        segment_sizes(dir.path()),
        before,
        "the real live handler neither creates nor appends a segment"
    );
}

#[tokio::test]
async fn prewrite_validation_auth_access_and_mute_denials_are_correlated_rejections() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (member_id, outsider_id, channel) = seed(&state).await;
    let private = state
        .wdb
        .create_channel("Private", ChannelKind::GroupDm, member_id, false)
        .await
        .unwrap();
    state
        .wdb
        .add_channel_member(&private, member_id, MemberRole::Member)
        .await
        .unwrap();
    let app = router(&state);
    let mut anonymous = Client::connect(&app, "").await;
    let mut member = Client::connect(&app, &token(&state, member_id)).await;
    let mut outsider = Client::connect(&app, &token(&state, outsider_id)).await;
    let watermark = state.wdb.engine().projection_state().applied_commit_seq();
    for (client, target, nonce, code) in [
        (
            &mut anonymous,
            &channel,
            "auth-denied",
            "authentication_required",
        ),
        (&mut outsider, &private, "access-denied", "access_denied"),
    ] {
        client
            .emit(
                "message",
                json!({"channelId":target,"clientMessageId":nonce,"text":"denied"}),
            )
            .await;
        let error = client.event("message-error").await;
        assert_eq!(error["channelId"], target.as_str());
        assert_eq!(error["clientMessageId"], nonce);
        assert_eq!(error["outcome"], "rejected");
        assert_eq!(error["code"], code);
        client.assert_no_delivery().await;
    }
    for request in [
        json!({"clientMessageId":"invalid","text":"missing channel"}),
        json!({"channelId":channel,"clientMessageId":"invalid","text":10}),
        json!({"channelId":channel,"clientMessageId":"invalid","text":"   "}),
    ] {
        member.emit("message", request.clone()).await;
        let error = member.event("message-error").await;
        assert_eq!(error["clientMessageId"], "invalid");
        assert_eq!(error["channelId"], request["channelId"]);
        assert_eq!(error["outcome"], "rejected");
        assert_eq!(error["code"], "invalid_request");
    }
    // Isolate the existing mute-read boundary. This is not a claim that the
    // separate mute command/projection implementation has been validated.
    state.wdb.engine().projection_state().insert(
        "mutes",
        b"fixture".to_vec(),
        serde_json::to_vec(&MuteRecord {
            channel_id: channel.clone(),
            user_id: member_id,
            muted_by_user_id: member_id,
            until_micros: i64::MAX,
            set_at_micros: 1,
        })
        .unwrap(),
        watermark,
    );
    assert!(state.wdb.is_user_muted(&channel, member_id).await.unwrap());
    member
        .emit(
            "message",
            json!({"channelId":channel,"clientMessageId":"muted","text":"denied"}),
        )
        .await;
    let error = member.event("message-error").await;
    assert_eq!(error["clientMessageId"], "muted");
    assert_eq!(error["channelId"], channel);
    assert_eq!(error["code"], "muted");
    assert_eq!(error["outcome"], "rejected");
    member.assert_no_delivery().await;
    assert_eq!(
        state.wdb.engine().projection_state().applied_commit_seq(),
        watermark
    );
    assert!(state
        .wdb
        .list_messages_typed(&channel, 100)
        .await
        .unwrap()
        .is_empty());
    assert!(state
        .session_messages
        .read()
        .await
        .values()
        .all(Vec::is_empty));
}

#[tokio::test]
async fn legacy_persistence_retry_reports_unsupported_without_acknowledging_or_mutating() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (member, _, channel) = seed(&state).await;
    let app = router(&state);
    let mut client = Client::connect(&app, &token(&state, member)).await;
    let before = state.wdb.engine().projection_state().applied_commit_seq();
    client
        .emit(
            "retry-message",
            json!({"channelId":channel,"messageId":"unknown-original"}),
        )
        .await;
    assert_eq!(
        client.event("retry-message-error").await,
        json!({
            "channelId":channel,"messageId":"unknown-original","code":"unsupported",
            "error":"Persistence retry is unavailable. Check history before sending again."
        })
    );
    client.assert_no_delivery().await;
    assert_eq!(
        state.wdb.engine().projection_state().applied_commit_seq(),
        before
    );
    assert!(state
        .session_messages
        .read()
        .await
        .values()
        .all(Vec::is_empty));
}

#[tokio::test]
async fn direct_message_reaches_unopened_recipient_and_history_uses_latest_durable_row() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let sender_id = state.wdb.create_user("sender", None, "registered-test-hash").await.unwrap();
    let recipient_id = state.wdb.create_user("recipient", None, "registered-test-hash").await.unwrap();
    let app = router(&state);
    let mut sender = Client::connect(&app, &token(&state, sender_id)).await;
    let mut recipient = Client::connect(&app, &token(&state, recipient_id)).await;
    sender.emit("create-dm", json!({"targetUserId": format!("user-{recipient_id}")})).await;
    let created = sender.event("dm-created").await;
    let channel = created["channelId"].as_str().unwrap().to_string();
    assert_eq!(recipient.event("dm-channel-added").await["channelId"], channel);
    assert_eq!(state.wdb.list_channel_members(&channel).await.unwrap().len(), 2);

    // Reopening is a success, and sending does not depend on a join-channel
    // round trip on either the desktop or the recipient's phone.
    sender.emit("create-dm", json!({"targetUserId": format!("user-{recipient_id}")})).await;
    assert_eq!(sender.event("dm-created").await["channelId"], channel);
    sender.emit("message", json!({"channelId":channel,"clientMessageId":"dm-first","text":"hello from first device"})).await;
    assert_eq!(sender.event("message-accepted").await["clientMessageId"], "dm-first");
    assert_eq!(recipient.event("message").await["message"]["text"], "hello from first device");
    assert_eq!(state.wdb.list_messages_typed(&channel, 10).await.unwrap().len(), 1);

    // A second writer can add a durable row while the first is still cached
    // in session memory. limit:1 must return the actual durable tail.
    state.wdb.send_message(&channel, recipient_id, "newest durable DM", false, &[]).await.unwrap();
    sender.emit("load-history", json!({"channelId":channel,"limit":1,"requestId":"dm-preview"})).await;
    let history = sender.event("history-loaded").await;
    assert_eq!(history["requestId"], "dm-preview");
    assert_eq!(history["messages"].as_array().unwrap().len(), 1);
    assert_eq!(history["messages"][0]["text"], "newest durable DM");
    sender.emit("join-channel", json!(channel)).await;
    let joined = sender.event("channel-messages").await;
    assert_eq!(joined["messages"].as_array().unwrap().last().unwrap()["text"], "newest durable DM");
}

#[tokio::test]
async fn direct_message_history_pages_past_one_hundred_and_survives_reconnect() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let sender_id = state.wdb.create_user("page_sender", None, "registered-test-hash").await.unwrap();
    let recipient_id = state.wdb.create_user("page_recipient", None, "registered-test-hash").await.unwrap();
    let app = router(&state);
    let credential = token(&state, sender_id);
    let mut sender = Client::connect(&app, &credential).await;
    sender.emit("create-dm", json!({"targetUserId": format!("user-{recipient_id}")})).await;
    let channel = sender.event("dm-created").await["channelId"].as_str().unwrap().to_string();
    let mut ids = Vec::new();
    for index in 0..125 {
        ids.push(state.wdb.send_message(&channel, sender_id, &format!("page-{index}"), false, &[]).await.unwrap());
    }

    sender.emit("load-history", json!({"channelId":channel,"limit":100,"requestId":"latest"})).await;
    let latest = sender.event("history-loaded").await;
    let latest_ids: Vec<_> = latest["messages"].as_array().unwrap().iter()
        .map(|row| row["id"].as_str().unwrap().to_string()).collect();
    assert_eq!(latest["requestId"], "latest");
    assert_eq!(latest_ids.len(), 100);
    assert_eq!(latest["hasMore"], true);
    assert_eq!(latest_ids, ids[25..].to_vec());

    // A fresh phone/desktop connection can resume from a message ID without
    // relying on the original socket's in-memory message cache.
    let mut reconnected = Client::connect(&app, &credential).await;
    reconnected.emit("join-channel", json!(channel)).await;
    let snapshot = reconnected.event("channel-messages").await;
    assert_eq!(snapshot["messages"].as_array().unwrap().len(), 50);
    reconnected.emit("load-history", json!({
        "channelId":channel,"beforeMessageId":latest_ids[0],"limit":30,"requestId":"older"
    })).await;
    let older = reconnected.event("history-loaded").await;
    let older_ids: Vec<_> = older["messages"].as_array().unwrap().iter()
        .map(|row| row["id"].as_str().unwrap().to_string()).collect();
    assert_eq!(older["requestId"], "older");
    assert_eq!(older_ids, ids[..25].to_vec());
    assert_eq!(older["hasMore"], false);

    reconnected.emit("load-history", json!({
        "channelId":channel,"afterMessageId":ids[10],"limit":30,"requestId":"newer"
    })).await;
    let newer = reconnected.event("history-loaded").await;
    let newer_ids: Vec<_> = newer["messages"].as_array().unwrap().iter()
        .map(|row| row["id"].as_str().unwrap().to_string()).collect();
    assert_eq!(newer_ids, ids[11..41].to_vec());
    assert_eq!(newer["hasMore"], true);
    reconnected.emit("load-history", json!({
        "channelId":channel,"afterMessageId":ids[124],"limit":30,"requestId":"end"
    })).await;
    let end = reconnected.event("history-loaded").await;
    assert_eq!(end["messages"], json!([]));
    assert_eq!(end["hasMore"], false);

    reconnected.emit("load-history", json!({
        "channelId":channel,"beforeMessageId":"missing-row","limit":30,"requestId":"bad-cursor"
    })).await;
    assert_eq!(reconnected.event("history-error").await["requestId"], "bad-cursor");
}

#[tokio::test]
async fn group_message_history_pages_past_one_hundred_and_survives_reconnect() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let owner = state.wdb.create_user("group_owner", None, "registered-test-hash").await.unwrap();
    let member = state.wdb.create_user("group_member", None, "registered-test-hash").await.unwrap();
    let group = "group-history-pages";
    state.wdb.create_group(group, "History room", owner, &[owner, member]).await.unwrap();
    let app = router(&state);
    let credential = token(&state, member);
    let mut client = Client::connect(&app, &credential).await;
    let mut ids = Vec::new();
    for index in 0..125 {
        ids.push(state.wdb.send_message(group, owner, &format!("group-page-{index}"), false, &[]).await.unwrap());
    }

    client.emit("load-history", json!({"channelId":group,"limit":100,"requestId":"latest"})).await;
    let latest = client.event("history-loaded").await;
    let latest_ids: Vec<_> = latest["messages"].as_array().unwrap().iter()
        .map(|row| row["id"].as_str().unwrap().to_string()).collect();
    assert_eq!(latest["requestId"], "latest");
    assert_eq!(latest_ids, ids[25..].to_vec());
    assert_eq!(latest["hasMore"], true);

    let mut reconnected = Client::connect(&app, &credential).await;
    reconnected.emit("join-channel", json!(group)).await;
    let snapshot = reconnected.event("channel-messages").await;
    assert_eq!(snapshot["messages"].as_array().unwrap().len(), 50);
    reconnected.emit("load-history", json!({
        "channelId":group,"beforeMessageId":latest_ids[0],"limit":30,"requestId":"older"
    })).await;
    let older = reconnected.event("history-loaded").await;
    let older_ids: Vec<_> = older["messages"].as_array().unwrap().iter()
        .map(|row| row["id"].as_str().unwrap().to_string()).collect();
    assert_eq!(older_ids, ids[..25].to_vec());
    assert_eq!(older["hasMore"], false);

    reconnected.emit("load-history", json!({
        "channelId":group,"afterMessageId":ids[100],"limit":30,"requestId":"newer"
    })).await;
    let newer = reconnected.event("history-loaded").await;
    let newer_ids: Vec<_> = newer["messages"].as_array().unwrap().iter()
        .map(|row| row["id"].as_str().unwrap().to_string()).collect();
    assert_eq!(newer_ids, ids[101..].to_vec());
    assert_eq!(newer["hasMore"], false);

    reconnected.emit("load-history", json!({
        "channelId":group,"beforeMessageId":"missing-row","limit":30,"requestId":"bad-cursor"
    })).await;
    assert_eq!(reconnected.event("history-error").await["requestId"], "bad-cursor");
}
