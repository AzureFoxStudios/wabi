//! Uses the parent contract's real Engine.IO/Axum clients and temporary WabiDB.
use super::*;
use futures::{SinkExt, StreamExt};

type CallSocket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
struct RunningCallSocket(tokio::task::JoinHandle<()>);
impl Drop for RunningCallSocket {
    fn drop(&mut self) {
        self.0.abort();
    }
}
async fn ws_send(socket: &mut CallSocket, value: Value) {
    socket
        .send(tokio_tungstenite::tungstenite::Message::Text(
            value.to_string().into(),
        ))
        .await
        .unwrap();
}
async fn ws_event(socket: &mut CallSocket) -> Value {
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            match socket.next().await.unwrap().unwrap() {
                tokio_tungstenite::tungstenite::Message::Text(text) => {
                    return serde_json::from_str(&text).unwrap()
                }
                tokio_tungstenite::tungstenite::Message::Ping(bytes) => socket
                    .send(tokio_tungstenite::tungstenite::Message::Pong(bytes))
                    .await
                    .unwrap(),
                message => panic!("unexpected call-state frame: {message:?}"),
            }
        }
    })
    .await
    .expect("call-state response timed out")
}

#[tokio::test]
async fn removal_invalidates_raw_subscriptions_and_readd_requires_new_consent() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (owner, member, _) = users(&state).await;
    let id = "group-ws-revocation";
    let initial = state
        .wdb
        .create_group(id, "private", owner, &[owner, member])
        .await
        .unwrap();
    let call = format!("channel:{id}");
    state
        .wdb
        .create_call_session(
            call.clone(),
            id.into(),
            "audio-call".into(),
            member,
            8,
            "wabidb".into(),
        )
        .await
        .unwrap();
    state
        .wdb
        .join_call_session(call.clone(), member, format!("user-{member}"), true)
        .await
        .unwrap();
    let app = create_api_router(state.clone())
        .with_state(state.clone())
        .layer(wabi_server::socketio::create_socket_layer(state.clone()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/", listener.local_addr().unwrap());
    let ws_router = wabi_server::websocket::ws_router(state.clone()).with_state(state.clone());
    let _running = RunningCallSocket(tokio::spawn(async move {
        axum::serve(listener, ws_router).await.unwrap();
    }));
    let (mut first, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    let (mut second, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    for ws in [&mut first, &mut second] {
        ws_send(
            ws,
            json!({"type":"authenticate","token":jwt(&state, member)}),
        )
        .await;
        assert_eq!(ws_event(ws).await["type"], "authenticated");
        ws_send(ws, json!({"type":"subscribe_call","session_id":call})).await;
        assert_eq!(ws_event(ws).await["type"], "call_snapshot");
    }
    let mut caller = SocketClient::connect(&app, &jwt(&state, owner)).await;
    caller
        .emit("kick-group-member", command(id, initial, member))
        .await;
    assert_eq!(caller.event("group-operation-result").await["ok"], true);
    let removed = revision(&state, id);
    for ws in [&mut first, &mut second] {
        let error = ws_event(ws).await;
        assert_eq!(error["type"], "subscription_error", "{error}");
        assert_eq!(error["membership_revision"], removed.to_string());
    }
    // The original host is gone, so the remaining group owner can end the call.
    let (status, body) = request(
        &app,
        Method::POST,
        &format!("/calls/sessions/{call}/end"),
        &jwt(&state, owner),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    caller
        .emit("add-group-member", command(id, removed, member))
        .await;
    assert_eq!(caller.event("group-operation-result").await["ok"], true);
    assert!(state
        .wdb
        .get_call_participants(&call)
        .await
        .unwrap()
        .iter()
        .all(|p| p.left_at_micros.is_some()));
    ws_send(
        &mut first,
        json!({"type":"subscribe_call","session_id":call}),
    )
    .await;
    let snapshot = ws_event(&mut first).await;
    assert_eq!(snapshot["type"], "call_snapshot");
    assert_eq!(
        snapshot["membership_revision"],
        revision(&state, id).to_string()
    );
    // Model an old bus notification delayed behind the new explicit admission.
    // A later valid subscription must not be erased by that older revocation.
    state
        .call_session_push
        .send((
            call.clone(),
            Arc::new(wabi_server::websocket::WsMessage::CallAccessRevoked {
                user_id: member,
                membership_revision: removed,
            }),
        ))
        .unwrap();
    state
        .call_session_push
        .send((
            call.clone(),
            Arc::new(wabi_server::websocket::WsMessage::CallSessionChanged {
                session: state.wdb.get_call_session(&call).await.unwrap().unwrap(),
            }),
        ))
        .unwrap();
    assert_eq!(ws_event(&mut first).await["type"], "call_session_changed");
    first.close(None).await.unwrap();
    second.close(None).await.unwrap();
}

fn command(id: &str, revision: u64, target: u64) -> Value {
    json!({"channelId":id, "requestId":uuid::Uuid::new_v4().to_string(),
        "expectedRevision":revision.to_string(), "userId":format!("user-{target}"), "targetUserId":format!("user-{target}")})
}

fn revision(state: &AppState, id: &str) -> u64 {
    wabidb::projections::channel_members::ChannelMembersProjection::revision(
        &state.wdb.engine().projection_state(),
        id,
    )
    .unwrap()
}

fn has_room(state: &AppState, socket_id: &str, room: &str) -> bool {
    let guard = state.sio.try_read().unwrap();
    guard
        .as_ref()
        .unwrap()
        .sockets()
        .iter()
        .find(|s| s.id.to_string() == socket_id)
        .unwrap()
        .rooms()
        .iter()
        .any(|r| r.as_ref() == room)
}

async fn wait_until(mut ready: impl FnMut() -> bool) {
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while !ready() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("expected server boundary was never reached");
}

#[tokio::test]
async fn only_current_group_owner_can_change_membership_and_competing_intents_conflict() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (owner, member, admin) = users(&state).await;
    let target = state
        .wdb
        .create_user("offline target", None, "registered-hash")
        .await
        .unwrap();
    let id = "group-authorization";
    let initial = state
        .wdb
        .create_group(id, "private", owner, &[owner, member])
        .await
        .unwrap();
    let app = create_api_router(state.clone())
        .with_state(state.clone())
        .layer(wabi_server::socketio::create_socket_layer(state.clone()));
    let mut owner_a = SocketClient::connect(&app, &jwt(&state, owner)).await;
    let mut owner_b = SocketClient::connect(&app, &jwt(&state, owner)).await;
    let mut peer = SocketClient::connect(&app, &jwt(&state, member)).await;
    let mut outsider = SocketClient::connect(&app, &jwt(&state, admin)).await;
    outsider
        .emit("add-group-member", command(id, initial, target))
        .await;
    assert_eq!(
        outsider.event("group-operation-result").await["code"],
        "UNAVAILABLE"
    );
    peer.emit("kick-group-member", command(id, initial, owner))
        .await;
    assert_eq!(
        peer.event("group-operation-result").await["code"],
        "FORBIDDEN"
    );
    assert_eq!(revision(&state, id), initial);

    // Competing tabs submit the same snapshot version. Whichever commits first
    // wins; the second must not silently apply intent against a changed roster.
    let reader = state.membership_gate.read().await;
    owner_a
        .emit("add-group-member", command(id, initial, target))
        .await;
    wait_until(|| state.membership_gate.try_read().is_err()).await;
    owner_b
        .emit("kick-group-member", command(id, initial, member))
        .await;
    drop(reader);
    let added = owner_a.event("group-operation-result").await;
    assert_eq!(added["ok"], true, "{added}");
    assert_eq!(
        owner_b.event("group-operation-result").await["code"],
        "CONFLICT"
    );
    assert!(revision(&state, id) > initial);
    assert_eq!(state.wdb.list_channel_members(id).await.unwrap().len(), 3);
    let snapshot = peer.event("group-membership-updated").await;
    assert_eq!(snapshot["channel"]["ownerId"], format!("user-{owner}"));
    assert_eq!(
        snapshot["channel"]["membershipRevision"],
        added["membershipRevision"]
    );
    outsider.emit("join", json!("refresh")).await;
    assert!(outsider.event("init").await["channels"]
        .as_array()
        .unwrap()
        .iter()
        .all(|c| c["id"] != id));
    assert!(outsider
        .events
        .iter()
        .all(|e| e[0] != "group-membership-updated"));
}

#[tokio::test]
async fn removal_evicts_chat_boards_relay_and_call_consent_on_every_device_only_for_that_group() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (owner, member, _) = users(&state).await;
    let id = "group-all-devices";
    let initial = state
        .wdb
        .create_group(id, "private", owner, &[owner, member])
        .await
        .unwrap();
    let other = channel(&state, member, ChannelKind::Voice).await;
    let app = create_api_router(state.clone())
        .with_state(state.clone())
        .layer(wabi_server::socketio::create_socket_layer(state.clone()));
    let mut caller = SocketClient::connect(&app, &jwt(&state, owner)).await;
    let mut first = SocketClient::connect(&app, &jwt(&state, member)).await;
    let mut second = SocketClient::handshake(&app, &jwt(&state, member)).await;
    caller.emit("call-initiate", json!({"channelId":id})).await;
    first.event("call-incoming").await;
    first
        .emit("call-answer", json!({"channelId":id,"requestId":"answer"}))
        .await;
    first.event("group-call-admitted").await;
    for client in [&mut first, &mut second] {
        // Every device consents independently, including one not yet registered
        // in the optional presence directory. Membership removal evicts both.
        client.emit("call-answer", json!({"channelId":id,"requestId":"device"})).await;
        client.event("group-call-admitted").await;
        client.emit("join-channel", json!(id)).await;
        client.event("channel-messages").await;
        for board in [id.to_string(), format!("channel:{id}")] {
            client
                .emit("whiteboard:join", json!({"boardId":board}))
                .await;
            client.event("whiteboard:joined").await;
            assert!(has_room(&state, &client.socket_id, &format!("wb:{board}")));
        }
        client
            .emit(
                "join-wabidb-call",
                json!({"channelId":id,"sessionId":format!("channel:{id}")}),
            )
            .await;
        client.event("wabidb-call-joined").await;
    }
    first
        .emit(
            "voice-channel-subscribe",
            json!({"channelId":other,"requestId":"other"}),
        )
        .await;
    first.event("voice-channel-admitted").await;
    first
        .emit(
            "join-wabidb-call",
            json!({"channelId":other,"sessionId":format!("channel:{other}")}),
        )
        .await;
    first.event("wabidb-call-joined").await;
    first.emit("wabidb-media", json!({"sessionId":format!("channel:{id}"),"kind":"audio","seq":0,"data":"header-canary"})).await;
    second.event("wabidb-media").await;
    assert!(
        !wabi_server::socketio::wabidb_header_cache_snapshot(&format!("channel:{id}")).is_empty()
    );
    caller
        .emit("kick-group-member", command(id, initial, member))
        .await;
    let ack = caller.event("group-operation-result").await;
    assert_eq!(ack["ok"], true, "{ack}");
    let departed = caller.event("group-call-participant-left").await;
    assert_eq!(
        departed["userId"],
        format!("user-{member}"),
        "departure must match the account-keyed group join"
    );
    for client in [&first, &second] {
        assert!(departed["socketIds"]
            .as_array()
            .unwrap()
            .contains(&json!(client.socket_id)));
    }
    for client in [&mut first, &mut second] {
        assert_eq!(
            client.event("group-removed").await["membershipRevision"],
            ack["membershipRevision"]
        );
        for room in [
            id.to_string(),
            format!("wb:{id}"),
            format!("wb:channel:{id}"),
            format!("wabidb-call-channel:{id}"),
        ] {
            assert!(!has_room(&state, &client.socket_id, &room), "{room}");
        }
        assert!(
            has_room(&state, &client.socket_id, &client.socket_id),
            "unrelated device addressing survives"
        );
        client.emit("join-channel", json!(id)).await;
        client.event("join-error").await;
        client
            .emit("call-answer", json!({"channelId":id,"requestId":"stale"}))
            .await;
        client.event("call-error").await;
        client
            .emit(
                "join-wabidb-call",
                json!({"channelId":id,"sessionId":format!("channel:{id}")}),
            )
            .await;
        client.event("wabidb-call-denied").await;
    }
    assert!(has_room(
        &state,
        &first.socket_id,
        &format!("wabidb-call-channel:{other}")
    ));
    let io = state.sio.read().await.clone().unwrap();
    for room in [
        id.to_string(),
        format!("wb:{id}"),
        format!("wb:channel:{id}"),
        format!("wabidb-call-channel:{id}"),
    ] {
        io.to(room)
            .emit(
                "revoked-receive-canary",
                &json!({"private":"must not arrive"}),
            )
            .await
            .unwrap();
    }
    io.to(format!("wabidb-call-channel:{other}"))
        .emit("unrelated-receive-canary", &json!({"ok":true}))
        .await
        .unwrap();
    assert_eq!(first.event("unrelated-receive-canary").await["ok"], true);
    assert!(first
        .events
        .iter()
        .all(|event| event[0] != "revoked-receive-canary"));
    assert!(
        wabi_server::socketio::wabidb_header_cache_snapshot(&format!("channel:{id}")).is_empty()
    );

    // A deliberate re-add restores membership, not prior consent or room joins.
    caller
        .emit(
            "add-group-member",
            command(id, revision(&state, id), member),
        )
        .await;
    assert_eq!(caller.event("group-operation-result").await["ok"], true);
    first.event("group-channel-added").await;
    first
        .emit(
            "join-wabidb-call",
            json!({"channelId":id,"sessionId":format!("channel:{id}")}),
        )
        .await;
    first.event("wabidb-call-denied").await;
    first
        .emit("call-answer", json!({"channelId":id,"requestId":"fresh"}))
        .await;
    first.event("group-call-admitted").await;
    first
        .emit(
            "join-wabidb-call",
            json!({"channelId":id,"sessionId":format!("channel:{id}")}),
        )
        .await;
    first.event("wabidb-call-joined").await;
}

#[tokio::test]
async fn in_flight_and_queued_admissions_cannot_outlive_revocation() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (owner, member, _) = users(&state).await;
    let id = "group-admission-race";
    let initial = state
        .wdb
        .create_group(id, "private", owner, &[owner, member])
        .await
        .unwrap();
    let call = format!("channel:{id}");
    state
        .wdb
        .create_call_session(
            call.clone(),
            id.into(),
            "audio-call".into(),
            owner,
            8,
            "wabidb".into(),
        )
        .await
        .unwrap();
    let app = create_api_router(state.clone())
        .with_state(state.clone())
        .layer(wabi_server::socketio::create_socket_layer(state.clone()));
    let mut caller = SocketClient::connect(&app, &jwt(&state, owner)).await;
    let mut first = SocketClient::connect(&app, &jwt(&state, member)).await;
    let mut late = SocketClient::connect(&app, &jwt(&state, member)).await;
    // Suspend a real join between room insertion and history publication.
    let history = state.session_messages.write().await;
    first.emit("join-channel", json!(id)).await;
    wait_until(|| has_room(&state, &first.socket_id, id)).await;
    caller
        .emit("kick-group-member", command(id, initial, member))
        .await;
    wait_until(|| state.membership_gate.try_read().is_err()).await;
    assert_eq!(
        revision(&state, id),
        initial,
        "writer waits for prior admission"
    );
    late.emit("join-channel", json!(id)).await;
    late.emit("join", json!("stale reconnect")).await;
    let rest_app = app.clone();
    let token = jwt(&state, member);
    let rest_join = tokio::spawn(async move {
        request(
            &rest_app,
            Method::POST,
            &format!("/calls/sessions/{call}/join"),
            &token,
            json!({"stable_user_id":format!("user-{member}")}),
        )
        .await
    });
    drop(history);
    assert_eq!(caller.event("group-operation-result").await["ok"], true);
    first.event("channel-messages").await;
    first.event("group-removed").await;
    late.event("join-error").await;
    let init = late.event("init").await;
    assert!(init["channels"]
        .as_array()
        .unwrap()
        .iter()
        .all(|c| c["id"] != id));
    assert_eq!(
        rest_join.await.unwrap().0,
        StatusCode::FORBIDDEN,
        "queued durable call admission must reauthorize"
    );
    for client in [&first, &late] {
        assert!(!has_room(&state, &client.socket_id, id));
    }
    let mut reconnect = SocketClient::connect(&app, &jwt(&state, member)).await;
    reconnect.emit("join-channel", json!(id)).await;
    reconnect.event("join-error").await;
}

#[tokio::test]
async fn revoked_devices_cannot_write_via_adjacent_private_socket_surfaces() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (owner, _, admin) = users(&state).await;
    let id = "group-private-surfaces";
    let initial = state
        .wdb
        .create_group(id, "private", owner, &[owner, admin])
        .await
        .unwrap();
    let app = create_api_router(state.clone())
        .with_state(state.clone())
        .layer(wabi_server::socketio::create_socket_layer(state.clone()));
    let mut caller = SocketClient::connect(&app, &jwt(&state, owner)).await;
    let mut removed_admin = SocketClient::connect(&app, &jwt(&state, admin)).await;
    caller
        .emit("kick-group-member", command(id, initial, admin))
        .await;
    assert_eq!(caller.event("group-operation-result").await["ok"], true);
    let applied = state.wdb.engine().projection_state().applied_commit_seq();
    for (event, response, payload) in [
        (
            "create-thread",
            "create-thread-error",
            json!({"parentChannelId":id,"name":"intrusion"}),
        ),
        ("pin-channel", "pin-channel-error", json!({"channelId":id})),
        (
            "unpin-channel",
            "unpin-channel-error",
            json!({"channelId":id}),
        ),
        (
            "update-channel-settings",
            "channel-settings-error",
            json!({"channelId":id,"settings":{"name":"intrusion"}}),
        ),
        (
            "reorder-channels",
            "reorder-channels-error",
            json!({"channels":[{"id":id,"position":7}]}),
        ),
        (
            "whiteboard:cursor",
            "whiteboard:error",
            json!({"boardId":format!("channel:{id}"),"cursor":{"x":1}}),
        ),
    ] {
        removed_admin.emit(event, payload).await;
        let error = removed_admin.event(response).await;
        assert!(error.get("error").is_some(), "{event}: {error}");
    }
    assert_eq!(
        state.wdb.engine().projection_state().applied_commit_seq(),
        applied
    );
    assert_eq!(
        state.wdb.get_channel(id).await.unwrap().unwrap().name,
        "private"
    );
    assert!(state.wdb.list_forum_threads(id).await.unwrap().is_empty());
}

#[tokio::test]
async fn owner_succession_last_leave_and_creation_retry_are_durable_not_duplicate_groups() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (owner, member, _) = users(&state).await;
    let app = create_api_router(state.clone())
        .with_state(state.clone())
        .layer(wabi_server::socketio::create_socket_layer(state.clone()));
    let mut caller = SocketClient::connect(&app, &jwt(&state, owner)).await;
    let mut peer = SocketClient::connect(&app, &jwt(&state, member)).await;
    let creation = json!({"requestId":uuid::Uuid::new_v4().to_string(), "groupName":"private", "userIds":[format!("user-{member}")]});
    caller.emit("create-group", creation.clone()).await;
    let created = caller.event("group-operation-result").await;
    assert_eq!(created["ok"], true, "{created}");
    let id = created["channelId"].as_str().unwrap();
    let initial = revision(&state, id);
    caller.emit("create-group", creation.clone()).await;
    assert_eq!(
        caller.event("group-operation-result").await["channelId"],
        id
    );
    assert_eq!(
        revision(&state, id),
        initial,
        "lost ACK retry makes no second commit"
    );
    caller
        .emit("leave-group", command(id, initial, owner))
        .await;
    assert_eq!(caller.event("group-operation-result").await["ok"], true);
    let group = state.wdb.get_channel(id).await.unwrap().unwrap();
    assert_eq!(group.owner_user_id, member);
    assert_eq!(group.name, "private");
    peer.emit("leave-group", command(id, revision(&state, id), member))
        .await;
    assert_eq!(peer.event("group-operation-result").await["ok"], true);
    assert!(state.wdb.get_channel(id).await.unwrap().is_none());
    assert!(state.wdb.list_channel_members(id).await.unwrap().is_empty());
    caller.emit("create-group", creation).await;
    assert_eq!(
        caller.event("group-operation-result").await["code"],
        "CONFLICT"
    );
    assert!(state.wdb.get_channel(id).await.unwrap().is_none());
}
