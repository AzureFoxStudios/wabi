async fn on_join(socket: SocketRef, username: String, state: SioState, io: SocketIo) {
    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();

    let authed_username = if !token.is_empty() {
        username_from_token(&token, &state.app.config.jwt_secret)
            .unwrap_or_else(|| username.clone())
    } else {
        username.clone()
    };

    let user_id_num = if !token.is_empty() {
        user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1)
    } else {
        -1
    };

    // Check if banned
    if user_id_num > 0 {
        if let Ok(true) = state.app.stdb.is_user_banned(user_id_num).await {
            let _ = socket.emit("ban", &json!({ "reason": "You are banned from this server" }));
            return;
        }
    }

    let stable_id = if user_id_num > 0 {
        format!("user-{}", user_id_num)
    } else {
        socket.id.to_string()
    };

    // Join a room named after stable_id so io.to(stable_id) routes here
    socket.join(stable_id.clone());

    let color = state
        .app
        .stdb
        .get_user(&authed_username)
        .await
        .ok()
        .and_then(|u| u.into_iter().next())
        .and_then(|r| r.get("color").and_then(|v| v.as_str()).map(String::from))
        .unwrap_or_else(|| "#98D8C8".to_string());

    let connected_user = ConnectedUser {
        stable_id: stable_id.clone(),
        db_user_id: if user_id_num > 0 {
            Some(user_id_num)
        } else {
            None
        },
        username: authed_username.clone(),
        color: color.clone(),
    };

    // Register in presence map
    {
        let mut connected = state.connected_users.write().await;
        connected.insert(socket.id.to_string(), connected_user.clone());
    }

    let owner_id = *state.app.owner_user_id.read().await;

    let server_members: Vec<Value> = state
        .app
        .stdb
        .get_all_users()
        .await
        .unwrap_or_default()
        .iter()
        .map(|row| row_to_user_view(row, owner_id))
        .collect();

    let online_users: Vec<Value> = {
        let connected = state.connected_users.read().await;
        connected.values().map(|u| connected_user_to_view(u, owner_id)).collect()
    };

    let channels: Vec<Value> = state
        .app
        .stdb
        .get_channels_raw()
        .await
        .unwrap_or_default()
        .iter()
        .map(row_to_channel_view)
        .collect();

    let init = json!({
        "channels": channels,
        "users": online_users,
        "serverMembers": server_members,
        "emotes": [],
        "emojis": [],
        "roleDefinitions": [],
        "voiceState": {},
        "messagePurgeVersion": 0,
        "session": { "sessionId": socket.id.to_string() },
    });

    if let Err(e) = socket.emit("init", &init) {
        warn!("[sio] init emit failed: {}", e);
    }

    // Broadcast arrival to all other connected sockets
    let user_view = connected_user_to_view(&connected_user, owner_id);
    let _ = socket.broadcast().emit("user-joined", &user_view).await;
    let _ = io; // keep io alive
}

async fn on_disconnect(socket: SocketRef, state: SioState, io: SocketIo) {
    let socket_id = socket.id.to_string();
    info!("[sio] disconnected: {}", socket_id);

    let departed = {
        let mut connected = state.connected_users.write().await;
        connected.remove(&socket_id)
    };

    if let Some(user) = &departed {
        let _ = io
            .emit(
                "user-left",
                &json!({
                    "id":       user.stable_id,
                    "dbUserId": user.db_user_id,
                    "username": user.username,
                }),
            )
            .await;
    }

    // Clean up voice channels
    let voice_lefts: Vec<(String, String)> = {
        let voice = state.voice_channels.read().await;
        voice
            .iter()
            .flat_map(|(ch, members)| {
                members
                    .iter()
                    .filter(|p| p.socket_id == socket_id)
                    .map(|p| (ch.clone(), p.stable_id.clone()))
                    .collect::<Vec<_>>()
            })
            .collect()
    };

    if !voice_lefts.is_empty() {
        let mut voice = state.voice_channels.write().await;
        for (channel_id, _) in &voice_lefts {
            if let Some(members) = voice.get_mut(channel_id) {
                members.retain(|p| p.socket_id != socket_id);
            }
        }
        drop(voice);
        for (channel_id, stable_id) in &voice_lefts {
            let _ = io
                .emit(
                    "voice-channel-left",
                    &json!({
                        "channelId": channel_id,
                        "userId":    stable_id,
                    }),
                )
                .await;
            let _ = io
                .emit(
                    "voice-channel-user-left",
                    &json!({
                        "channelId": channel_id,
                        "userId":    stable_id,
                        "socketId":  socket_id,
                    }),
                )
                .await;
        }
    }

    // Clean up group call sessions
    let departed_stable = departed
        .as_ref()
        .map(|u| u.stable_id.clone())
        .unwrap_or_else(|| socket_id.clone());
    let group_call_lefts: Vec<(String, Vec<String>)> = {
        let mut sessions = state.group_call_sessions.write().await;
        let mut lefts = Vec::new();
        let mut to_remove = Vec::new();

        for (channel_id, session) in sessions.iter_mut() {
            let was_in = session.connected_participants.remove(&departed_stable)
                || session.invited_participants.remove(&departed_stable);
            if !was_in {
                continue;
            }

            let recipients: Vec<String> = session.connected_participants.iter().cloned().collect();
            lefts.push((channel_id.clone(), recipients));

            if session.connected_participants.is_empty() {
                to_remove.push(channel_id.clone());
            }
        }
        for ch in to_remove {
            sessions.remove(&ch);
        }
        lefts
    };

    for (channel_id, recipients) in group_call_lefts {
        for recipient_id in recipients {
            let _ = io
                .to(recipient_id)
                .emit(
                    "group-call-participant-left",
                    &json!({
                        "channelId": channel_id,
                        "stableUserId": departed_stable,
                        "userId": socket_id
                    }),
                )
                .await;
        }
    }

    // Broadcast call-ended so DM call partners can clean up
    let _ = io
        .emit("call-ended", &json!({ "userId": departed_stable }))
        .await;
}

async fn on_join_channel(socket: SocketRef, channel_id: String, state: SioState) {
    // Get user ID from socket token
    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();
    let user_id = if !token.is_empty() {
        user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1)
    } else {
        -1
    };

    // Check channel minRole requirement
    if let Ok(channels) = state.app.stdb.get_channels_raw().await {
        if let Some(channel) = channels.iter().find(|ch| ch.get("channel_id").and_then(|v| v.as_str()) == Some(&channel_id)) {
            if let Some(min_role_str) = channel.get("min_role").and_then(|v| v.as_str()) {
                let user_role = state.app.get_user_highest_role(user_id).await;
                // Simple role check: "guest" < "member" < "admin" < "owner"
                let role_priority = |r: &str| match r {
                    "owner" => 3,
                    "admin" => 2,
                    "member" => 1,
                    _ => 0,
                };
                if role_priority(&user_role) < role_priority(min_role_str) {
                    warn!("[sio] user {} blocked from channel {}: requires {}, has {}", user_id, channel_id, min_role_str, user_role);
                    return;
                }
            }
        }
    }

    socket.join(channel_id.clone());

    let stdb_msgs: Vec<Value> = state
        .app
        .stdb
        .get_messages_raw(&channel_id, 50)
        .await
        .unwrap_or_default()
        .iter()
        .map(row_to_message_view)
        .collect();

    let session = state.app.session_messages.read().await;
    let session_msgs = session.get(&channel_id).cloned().unwrap_or_default();
    drop(session);

    let stdb_ids: HashSet<String> = stdb_msgs
        .iter()
        .filter_map(|m| m.get("id").and_then(|v| v.as_str()).map(String::from))
        .collect();

    let mut all: Vec<Value> = stdb_msgs;
    for msg in session_msgs {
        let id = msg
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if !stdb_ids.contains(&id) {
            all.push(msg);
        }
    }
    all.sort_by_key(|m| m.get("timestamp").and_then(|v| v.as_i64()).unwrap_or(0));

    let payload = json!({ "channelId": channel_id, "messages": all, "hasMore": false });
    if let Err(e) = socket.emit("channel-messages", &payload) {
        warn!("[sio] channel-messages failed: {}", e);
    }
}

