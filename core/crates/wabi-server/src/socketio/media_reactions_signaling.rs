async fn on_join_stdb_call(socket: SocketRef, data: Value, io: SocketIo) {
    let session_id = match data.get("sessionId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };

    let room_id = format!("stdb-call-{}", session_id);
    let _ = socket.join(room_id.clone());
    info!("[sio] Socket {} joined STDB call room {}", socket.id, room_id);
}

async fn on_stdb_media(socket: SocketRef, data: Value, _state: SioState, io: SocketIo) {
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

    // Broadcast stdb-media to all participants in this STDB call session (except sender)
    // Using Socket.IO rooms: join participants in "stdb-call-{sessionId}" room on call start
    let room_id = format!("stdb-call-{}", session_id);
    let _ = io
        .to(room_id)
        .except(socket.id.clone())
        .emit("stdb-media", &payload)
        .await;
}

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
    if let Err(e) = state.app.stdb.add_reaction(&message_id, &channel_id, user_id_num, &emoji_id).await {
        warn!("[sio] add-emoji-reaction: failed to add reaction: {}", e);
        let _ = socket.emit("reaction-error", &json!({ "messageId": message_id, "error": "Failed to add reaction" }));
        return;
    }

    // Check if there's an emoji role rule for this emoji/message
    if let Ok(rules) = state.app.stdb.get_emoji_role_rules(&message_id).await {
        for rule in rules {
            if let Some(rule_emoji) = rule.get("emojiId").and_then(|v| v.as_str()) {
                if rule_emoji == emoji_id {
                    if let Some(role_name) = rule.get("roleName").and_then(|v| v.as_str()) {
                        // Assign the role to the user
                        let _ = state.app.stdb.ingest_event("rbac", "assign_role", &json!({
                            "userId": user_id_num,
                            "workspaceId": "default-workspace",
                            "role": role_name,
                            "assignedBy": 0,
                        })).await;
                    }
                }
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
    if let Err(e) = state.app.stdb.remove_reaction(&message_id, user_id_num, &emoji_id).await {
        warn!("[sio] remove-emoji-reaction: failed to remove reaction: {}", e);
        return;
    }

    // Check if there's an emoji role rule with removeOnUnreact flag
    if let Ok(rules) = state.app.stdb.get_emoji_role_rules(&message_id).await {
        for rule in rules {
            if let Some(rule_emoji) = rule.get("emojiId").and_then(|v| v.as_str()) {
                if rule_emoji == emoji_id {
                    if let Some(true) = rule.get("removeOnUnreact").and_then(|v| v.as_bool()) {
                        if let Some(role_name) = rule.get("roleName").and_then(|v| v.as_str()) {
                            // Remove the role from the user
                            let _ = state.app.stdb.ingest_event("rbac", "remove_role", &json!({
                                "userId": user_id_num,
                                "workspaceId": "default-workspace",
                                "role": role_name,
                            })).await;
                        }
                    }
                }
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
        let channels = state.app.stdb.get_channels_raw().await.unwrap_or_default();
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

// ---------------------------------------------------------------------------
// Layer factory
// ---------------------------------------------------------------------------
