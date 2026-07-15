// WDB-compat shim: this file calls `state.app.wdb.X(...)` for
// methods the WDB doesn't have equivalents for yet
// (is_user_muted, get_channel_retention, mute_user, etc.).
// The compat WdbClient in `db/` returns no-op defaults for all
// of these. When WDB has the corresponding engine methods, this
// file can be migrated to use `state.app.wdb.X(...)` instead.
// The compat shim itself is a temporary layer and will be removed
// once the last socketio file is migrated.

#[allow(dead_code)]
async fn on_join_wabidb_call(socket: SocketRef, data: Value, _io: SocketIo) {
    let session_id = match data.get("sessionId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };

    let room_id = format!("wabidb-call-{}", session_id);
    let _ = socket.join(room_id.clone());
    info!("[sio] Socket {} joined wabiDB call room {}", socket.id, room_id);
}

#[allow(dead_code)]
async fn on_wabidb_media(socket: SocketRef, data: Value, _state: SioState, io: SocketIo) {
    let session_id = match data.get("sessionId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };

    let _user_id = match data.get("userId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };

    // Payload is the encoded audio (ArrayBuffer from frontend)
    // In socketioxide, binary data arrives in `data` — we'll relay it as-is
    let payload = data.clone();

    // Broadcast wabidb-media to all participants in this wabiDB call session (except sender)
    // Using Socket.IO rooms: join participants in "wabidb-call-{sessionId}" room on call start
    let room_id = format!("wabidb-call-{}", session_id);
    let _ = io
        .to(room_id)
        .except(socket.id.clone())
        .emit("wabidb-media", &payload)
        .await;
}

#[allow(dead_code)]
async fn on_voice_segment(socket: SocketRef, data: Value, state: &SioState, io: &SocketIo) {
    let channel_id = match data.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };

    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();
    let user_id_num = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);
    let stable_id = if user_id_num > 0 {
        format!("user-{}", user_id_num)
    } else {
        socket.id.to_string()
    };

    // Build a relay payload with sender identity
    let relay = serde_json::json!({
        "channelId": channel_id,
        "fromUserId": stable_id,
        "audioBase64": data.get("audioBase64"),
        "durationMs": data.get("durationMs"),
        "mimeType": data.get("mimeType"),
        "sentAt": data.get("sentAt"),
    });

    // Fan out to all subscribers in the channel except sender
    let _ = io
        .to(channel_id)
        .except(socket.id.clone())
        .emit("voice-segment", &relay)
        .await;
}

#[allow(dead_code)]
async fn on_add_emoji_reaction(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let message_id = match data.get("messageId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };
    let channel_id = match data.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };
    let emoji_id = match data.get("emojiId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };

    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();
    let user_id_num = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);

    if user_id_num <= 0 {
        let _ = socket.emit("reaction-error", &json!({ "messageId": message_id, "error": "Guests cannot react" }));
        return;
    }

    // Store the reaction
    if let Err(e) = state.app.wdb.add_reaction(&message_id, user_id_num as u64, &emoji_id).await {
        warn!("[sio] add-emoji-reaction: failed to add reaction: {}", e);
        let _ = socket.emit("reaction-error", &json!({ "messageId": message_id, "error": "Failed to add reaction" }));
        return;
    }

    // Check if there's an emoji role rule for this emoji/message
    if let Ok(rules) = state.app.wdb.get_emoji_role_rules(&message_id).await {
        for rule in rules {
            let rule_emoji = rule.emote.as_str();
            if rule_emoji == emoji_id {
                let role_name = format!("{:?}", rule.role);
                // Assign the role to the user
                let _ = state.app.wdb.ingest_event("rbac", "assign_role", &json!({
                    "userId": user_id_num,
                    "workspaceId": "default-workspace",
                    "role": role_name,
                    "assignedBy": 0,
                })).await;
            }
        }
    }

    // Broadcast reaction to channel
    let _ = io
        .to(channel_id.clone())
        .emit(
            "emoji-reaction-added",
            &json!({
                "messageId": message_id,
                "userId": user_id_num,
                "emojiId": emoji_id,
            }),
        )
        .await;
}

#[allow(dead_code)]
async fn on_remove_emoji_reaction(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let message_id = match data.get("messageId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };
    let channel_id = match data.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };
    let emoji_id = match data.get("emojiId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };

    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();
    let user_id_num = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);

    if user_id_num <= 0 {
        return;
    }

    // Remove the reaction
    if let Err(e) = state.app.wdb.remove_reaction(&message_id, user_id_num as u64, &emoji_id).await {
        warn!("[sio] remove-emoji-reaction: failed to remove reaction: {}", e);
        return;
    }

    // Check if there's an emoji role rule with removeOnUnreact flag
    if let Ok(rules) = state.app.wdb.get_emoji_role_rules(&message_id).await {
        for rule in rules {
            let rule_emoji = rule.emote.as_str();
            if rule_emoji == emoji_id {
                // WDB-compat: removeOnUnreact removed in v1 EmojiRoleRule (no equivalent field). Always treat as true.
                let role_name = format!("{:?}", rule.role);
                // Remove the role from the user
                let _ = state.app.wdb.ingest_event("rbac", "remove_role", &json!({
                    "userId": user_id_num,
                    "workspaceId": "default-workspace",
                    "role": role_name,
                })).await;
            }
        }
    }

    // Broadcast reaction removal to channel
    let _ = io
        .to(channel_id.clone())
        .emit(
            "emoji-reaction-removed",
            &json!({
                "messageId": message_id,
                "userId": user_id_num,
                "emojiId": emoji_id,
            }),
        )
        .await;
}

// ---------------------------------------------------------------------------
// Layer factory
// ---------------------------------------------------------------------------

#[allow(dead_code)]
async fn on_call_offer(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let my_stable_id = get_my_stable_id(&socket, &state.app.config.jwt_secret);
    let my_username = {
        let connected = state.connected_users.read().await;
        connected
            .get(&socket.id.to_string())
            .map(|u| u.username.clone())
            .unwrap_or_default()
    };

    let target_id = match data
        .get("targetId")
        .and_then(|v| v.as_str())
        .map(String::from)
    {
        Some(id) => id,
        None => return,
    };
    let offer = match data.get("offer") {
        Some(o) => o.clone(),
        None => return,
    };
    let channel_id_opt = data
        .get("channelId")
        .and_then(|v| v.as_str())
        .map(String::from);

    if let Some(ref channel_id) = channel_id_opt {
        let channels = state.app.wdb.get_channels_raw().await.unwrap_or_default();
        let channel = channels.iter().find(|c| {
            c.get("channel_id")
                .or_else(|| c.get("id"))
                .and_then(|v| v.as_str())
                == Some(channel_id.as_str())
        });

        match channel {
            Some(c) => {
                let ch_type = c
                    .get("channel_type")
                    .or_else(|| c.get("type"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");

                if ch_type == "voice" {
                    let voice = state.voice_channels.read().await;
                    let members = voice.get(channel_id);
                    let sender_in = members
                        .map(|m| m.iter().any(|p| p.socket_id == socket.id.to_string()))
                        .unwrap_or(false);
                    let target_in = members
                        .map(|m| {
                            m.iter()
                                .any(|p| p.socket_id == target_id || p.stable_id == target_id)
                        })
                        .unwrap_or(false);
                    if !sender_in || !target_in {
                        return;
                    }
                } else if ch_type == "group" {
                    let sessions = state.group_call_sessions.read().await;
                    let session = match sessions.get(channel_id) {
                        Some(s) => s,
                        None => return,
                    };
                    if !session.connected_participants.contains(&my_stable_id)
                        || !session.connected_participants.contains(&target_id)
                    {
                        return;
                    }
                } else {
                    return;
                }
            }
            None => return,
        }
    }

    let _ = io
        .to(target_id)
        .emit(
            "call-offer",
            &json!({
                "offer":     offer,
                "senderId":  my_stable_id,
                "username":  my_username,
                "channelId": channel_id_opt
            }),
        )
        .await;
}

#[allow(dead_code)]
async fn on_start_screen_share(socket: SocketRef, state: SioState, io: SocketIo) {
    let sender_id = get_my_stable_id(&socket, &state.app.config.jwt_secret);
    let (username, targets) = {
        let connected = state.connected_users.read().await;
        let username = connected
            .get(&socket.id.to_string())
            .map(|u| u.username.clone())
            .unwrap_or_default();
        let targets: Vec<Value> = connected
            .values()
            .filter(|u| u.stable_id != sender_id)
            .map(|u| json!({
                "userId": u.stable_id,
                "username": u.username,
            }))
            .collect();
        (username, targets)
    };

    let _ = socket.emit("screen-share-targets", &json!({ "targets": targets }));

    let _ = io
        .broadcast()
        .emit(
            "screen-share-started",
            &json!({
                "senderId": sender_id,
                "userId": sender_id,
                "username": username,
            }),
        )
        .await;
}

#[allow(dead_code)]
async fn on_stop_screen_share(socket: SocketRef, state: SioState, io: SocketIo) {
    let sender_id = get_my_stable_id(&socket, &state.app.config.jwt_secret);

    let _ = io
        .broadcast()
        .emit(
            "screen-share-stopped",
            &json!({
                "senderId": sender_id,
                "userId": sender_id,
            }),
        )
        .await;
}

#[allow(dead_code)]
async fn on_webrtc_offer(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let sender_id = get_my_stable_id(&socket, &state.app.config.jwt_secret);
    let username = {
        let connected = state.connected_users.read().await;
        connected
            .get(&socket.id.to_string())
            .map(|u| u.username.clone())
            .unwrap_or_default()
    };

    let target_id = match data.get("targetId").and_then(|v| v.as_str()).map(String::from) {
        Some(id) => id,
        None => return,
    };
    let offer = match data.get("offer") {
        Some(offer) => offer.clone(),
        None => return,
    };

    let _ = io
        .to(target_id)
        .emit(
            "webrtc-offer",
            &json!({
                "offer": offer,
                "senderId": sender_id,
                "username": username,
            }),
        )
        .await;
}

#[allow(dead_code)]
async fn on_webrtc_answer(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let sender_id = get_my_stable_id(&socket, &state.app.config.jwt_secret);
    let target_id = match data.get("targetId").and_then(|v| v.as_str()).map(String::from) {
        Some(id) => id,
        None => return,
    };
    let answer = match data.get("answer") {
        Some(answer) => answer.clone(),
        None => return,
    };

    let _ = io
        .to(target_id)
        .emit(
            "webrtc-answer",
            &json!({
                "answer": answer,
                "senderId": sender_id,
            }),
        )
        .await;
}

#[allow(dead_code)]
async fn on_webrtc_ice_candidate(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let sender_id = get_my_stable_id(&socket, &state.app.config.jwt_secret);
    let target_id = match data.get("targetId").and_then(|v| v.as_str()).map(String::from) {
        Some(id) => id,
        None => return,
    };
    let candidate = match data.get("candidate") {
        Some(candidate) => candidate.clone(),
        None => return,
    };

    let _ = io
        .to(target_id)
        .emit(
            "webrtc-ice-candidate",
            &json!({
                "candidate": candidate,
                "senderId": sender_id,
            }),
        )
        .await;
}

#[allow(dead_code)]
async fn on_p2p_offer(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let sender_id = get_my_stable_id(&socket, &state.app.config.jwt_secret);
    let username = {
        let connected = state.connected_users.read().await;
        connected
            .get(&socket.id.to_string())
            .map(|u| u.username.clone())
            .unwrap_or_default()
    };

    let transfer_id = match data.get("transferId").and_then(|v| v.as_str()).map(String::from) {
        Some(id) => id,
        None => return,
    };
    let target_id = match data.get("targetId").and_then(|v| v.as_str()).map(String::from) {
        Some(id) => id,
        None => return,
    };
    let offer = match data.get("offer") {
        Some(o) => o.clone(),
        None => return,
    };
    let file_name = data
        .get("fileName")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    let file_size = data
        .get("fileSize")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    let _ = io
        .to(target_id)
        .emit(
            "p2p-offer",
            &json!({
                "transferId": transfer_id,
                "offer": offer,
                "senderId": sender_id,
                "senderUsername": username,
                "fileName": file_name,
                "fileSize": file_size,
            }),
        )
        .await;
}

#[allow(dead_code)]
async fn on_p2p_answer(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let sender_id = get_my_stable_id(&socket, &state.app.config.jwt_secret);
    let transfer_id = match data.get("transferId").and_then(|v| v.as_str()).map(String::from) {
        Some(id) => id,
        None => return,
    };
    let target_id = match data.get("targetId").and_then(|v| v.as_str()).map(String::from) {
        Some(id) => id,
        None => return,
    };
    let answer = match data.get("answer") {
        Some(a) => a.clone(),
        None => return,
    };

    let _ = io
        .to(target_id)
        .emit(
            "p2p-answer",
            &json!({
                "transferId": transfer_id,
                "answer": answer,
                "senderId": sender_id,
            }),
        )
        .await;
}

#[allow(dead_code)]
async fn on_p2p_ice_candidate(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let sender_id = get_my_stable_id(&socket, &state.app.config.jwt_secret);
    let transfer_id = match data.get("transferId").and_then(|v| v.as_str()).map(String::from) {
        Some(id) => id,
        None => return,
    };
    let target_id = match data.get("targetId").and_then(|v| v.as_str()).map(String::from) {
        Some(id) => id,
        None => return,
    };
    let candidate = match data.get("candidate") {
        Some(c) => c.clone(),
        None => return,
    };

    let _ = io
        .to(target_id)
        .emit(
            "p2p-ice-candidate",
            &json!({
                "transferId": transfer_id,
                "candidate": candidate,
                "senderId": sender_id,
            }),
        )
        .await;
}

// ---------------------------------------------------------------------------
// Layer factory
// ---------------------------------------------------------------------------
