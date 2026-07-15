// WDB-compat shim: this file calls `state.app.wdb.X(...)` for
// methods the WDB doesn't have equivalents for yet
// (is_user_muted, get_channel_retention, mute_user, etc.).
// The compat WdbClient in `db/` returns no-op defaults for all
// of these. When WDB has the corresponding engine methods, this
// file can be migrated to use `state.app.wdb.X(...)` instead.
// The compat shim itself is a temporary layer and will be removed
// once the last socketio file is migrated.

/// Current Unix time in microseconds. Returns 0 if the system clock is
/// before the Unix epoch (effectively never on a sane system).
#[allow(dead_code)]
fn now_micros() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_micros() as i64)
        .unwrap_or(0)
}

#[allow(dead_code)]
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
        if let Ok(true) = state.app.wdb.is_user_banned(user_id_num as u64).await {
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
        .wdb
        .get_user_by_username(&authed_username)
        .await
        .ok()
        .flatten()
        .map(|u| u.color)
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
        last_seen_micros: now_micros(),
    };

    // Register in presence map
    {
        let mut connected = state.connected_users.write().await;
        connected.insert(socket.id.to_string(), connected_user.clone());
    }

    let owner_id = *state.app.owner_user_id.read().await;

    // WDB-compat: row_to_user_view expects &HashMap<String, Value>. User is typed.
    // Empty for v1 — needs row_to_user_view signature update.
    let server_members: Vec<Value> = Vec::new();

    let online_users: Vec<Value> = {
        let connected = state.connected_users.read().await;
        connected.values().map(|u| connected_user_to_view(u, owner_id)).collect()
    };

    let channels: Vec<Value> = state
        .app
        .wdb
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

#[allow(dead_code)]
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

#[allow(dead_code)]
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
    if let Ok(channels) = state.app.wdb.get_channels_raw().await {
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

    let session = state.app.session_messages.read().await;
    let session_msgs = session.get(&channel_id).cloned().unwrap_or_default();
    drop(session);

    let all: Vec<Value> = if !session_msgs.is_empty() {
        let mut msgs = session_msgs;
        msgs.sort_by_key(|m| m.get("timestamp").and_then(|v| v.as_i64()).unwrap_or(0));
        msgs
    } else {
        // Fall back to WDB for persisted messages when the in-memory
        // session cache is empty (e.g. after page reload). Map the domain
        // Message to the frontend protocol shape (id, userId, user, timestamp).
        // Resolve author usernames so the client shows a real name (and a
        // `user-<dbId>` id it can look up in its cache) instead of a bare
        // numeric id + empty username that renders as "Unknown user".
        let typed_msgs = state
            .app
            .wdb
            .list_messages_typed(&channel_id, 50)
            .await
            .unwrap_or_default();
        let mut name_by_id: std::collections::HashMap<u64, String> = std::collections::HashMap::new();
        let distinct_ids: Vec<u64> = {
            let mut seen: std::collections::HashSet<u64> =
                typed_msgs.iter().map(|m| m.author_user_id).collect();
            seen.into_iter().collect()
        };
        for id in distinct_ids {
            if let Ok(Some(u)) = state.app.wdb.get_user(id).await {
                name_by_id.insert(id, u.username);
            }
        }
        typed_msgs
            .into_iter()
            .map(|m| {
                let uname = m
                    .author_username
                    .clone()
                    .filter(|s| !s.is_empty())
                    .or_else(|| name_by_id.get(&m.author_user_id).cloned())
                    .unwrap_or_default();
                json!({
                    "id": m.message_id,
                    "userId": format!("user-{}", m.author_user_id),
                    "user": uname,
                    "timestamp": m.created_at_micros / 1000,
                    "text": m.content,
                    "type": m.message_type,
                    "authorDeviceId": m.author_device_id,
                    "editedAt": m.edited_at_micros.map(|e| e / 1000),
                    "commitSeq": m.commit_seq,
                    "isDeleted": m.is_deleted,
                })
            })
            .collect()
    };

    let payload = json!({ "channelId": channel_id, "messages": all, "hasMore": false });
    if let Err(e) = socket.emit("channel-messages", &payload) {
        warn!("[sio] channel-messages failed: {}", e);
    }
}

