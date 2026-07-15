// WDB-compat shim: this file calls `state.app.wdb.X(...)` for
// methods the WDB doesn't have equivalents for yet
// (is_user_muted, get_channel_retention, mute_user, etc.).
// The compat WdbClient in `db/` returns no-op defaults for all
// of these. When WDB has the corresponding engine methods, this
// file can be migrated to use `state.app.wdb.X(...)` instead.
// The compat shim itself is a temporary layer and will be removed
// once the last socketio file is migrated.

#[allow(dead_code)]
async fn on_voice_channel_join(socket: SocketRef, data: Value, state: SioState, _io: SocketIo) {
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

    // Check if user is muted on this voice channel
    if user_id_num > 0 {
        if let Ok(true) = state.app.wdb.is_user_muted(&channel_id, user_id_num as u64).await {
            warn!("[sio] user {} muted in voice channel {}", user_id_num, channel_id);
            let _ = socket.emit("voice-channel-error", &json!({ "channelId": channel_id, "error": "You are muted in this channel" }));
            return;
        }
    }

    let is_deafened = if user_id_num > 0 {
        state.app.wdb.is_user_deafened(&channel_id, user_id_num as u64).await.unwrap_or(false)
    } else {
        false
    };

    let stable_id = if user_id_num > 0 {
        format!("user-{}", user_id_num)
    } else {
        socket.id.to_string()
    };

    let (username, color) = {
        let connected = state.connected_users.read().await;
        connected
            .get(&socket.id.to_string())
            .map(|u| (u.username.clone(), u.color.clone()))
            .unwrap_or_else(|| ("unknown".to_string(), "#98D8C8".to_string()))
    };

    let participant = VoiceParticipant {
        socket_id: socket.id.to_string(),
        stable_id: stable_id.clone(),
        username: username.clone(),
        color: color.clone(),
        is_deafened,
        transmit_mode: "primary".to_string(),
        is_listening_only: false,
    };

    let current_members: Vec<Value> = {
        let mut voice = state.voice_channels.write().await;
        let members = voice.entry(channel_id.clone()).or_default();
        members.retain(|p| p.socket_id != socket.id.to_string());
        members.push(participant.clone());
        members.iter().map(voice_participant_to_view).collect()
    };

    let _ = socket.emit(
        "voice-channel-state",
        &json!({
            "channelId": channel_id,
            "members":   current_members,
        }),
    );

    let participant_view = voice_participant_to_view(&participant);

    let _ = socket
        .broadcast()
        .emit(
            "voice-channel-joined",
            &json!({
                "channelId": channel_id,
                "user":      participant_view,
            }),
        )
        .await;

    let _ = socket
        .broadcast()
        .emit(
            "voice-channel-user-joined",
            &json!({
                "channelId": channel_id,
                "userId":    stable_id,
                "socketId":  socket.id.to_string(),
                "username":  username,
            }),
        )
        .await;
}

#[allow(dead_code)]
async fn on_voice_channel_subscribe(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
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

    let (username, color) = {
        let connected = state.connected_users.read().await;
        connected
            .get(&socket.id.to_string())
            .map(|u| (u.username.clone(), u.color.clone()))
            .unwrap_or_else(|| ("unknown".to_string(), "#98D8C8".to_string()))
    };

    let current_members: Vec<Value> = {
        let mut voice = state.voice_channels.write().await;
        let members = voice.entry(channel_id.clone()).or_default();
        // If this socket is already a primary (transmitting) participant in the
        // channel, do NOT demote it to a listen-only participant.
        let already_primary = members
            .iter()
            .any(|p| p.socket_id == socket.id.to_string() && !p.is_listening_only);
        if !already_primary {
            members.retain(|p| p.socket_id != socket.id.to_string());
            members.push(VoiceParticipant {
                socket_id: socket.id.to_string(),
                stable_id: stable_id.clone(),
                username: username.clone(),
                color: color.clone(),
                is_deafened: false,
                transmit_mode: "listening".to_string(),
                is_listening_only: true,
            });
        }
        members.iter().map(voice_participant_to_view).collect()
    };

    // Broadcast the full roster so every client (including the subscriber)
    // sees the updated member list with the listen-only participant.
    let _ = io
        .emit(
            "voice-channel-state",
            &json!({
                "channelId": channel_id,
                "members":   current_members,
            }),
        )
        .await;
}

#[allow(dead_code)]
async fn on_voice_channel_unsubscribe(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
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
    let _stable_id = if user_id_num > 0 {
        format!("user-{}", user_id_num)
    } else {
        socket.id.to_string()
    };

    let removed = {
        let mut voice = state.voice_channels.write().await;
        if let Some(members) = voice.get_mut(&channel_id) {
            // Only remove this socket if it is a listen-only participant. Never
            // kick a primary (transmitting) joiner via an unsubscribe.
            let was_listen_only = members
                .iter()
                .any(|p| p.socket_id == socket.id.to_string() && p.is_listening_only);
            if was_listen_only {
                members.retain(|p| p.socket_id != socket.id.to_string());
                true
            } else {
                false
            }
        } else {
            false
        }
    };

    if removed {
        let members: Vec<Value> = {
            let voice = state.voice_channels.read().await;
            voice
                .get(&channel_id)
                .map(|m| m.iter().map(voice_participant_to_view).collect())
                .unwrap_or_default()
        };
        let _ = io
            .emit(
                "voice-channel-state",
                &json!({
                    "channelId": channel_id,
                    "members":   members,
                }),
            )
            .await;
    }
}

#[allow(dead_code)]
async fn on_voice_channel_leave(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
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

    {
        let mut voice = state.voice_channels.write().await;
        if let Some(members) = voice.get_mut(&channel_id) {
            members.retain(|p| p.socket_id != socket.id.to_string());
        }
    }

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
                "socketId":  socket.id.to_string(),
            }),
        )
        .await;
}

#[allow(dead_code)]
async fn on_set_voice_transmit_mode(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let raw_mode = match data.get("mode").and_then(|v| v.as_str()) {
        Some(mode) => mode,
        None => {
            let _ = socket.emit("voice-transmit-mode-error", &json!({ "error": "mode is required" }));
            return;
        }
    };

    let mode = match raw_mode {
        "primary" | "auto" | "push-to-talk" => "primary",
        "all-listening" | "always" => "all-listening",
        _ => {
            let _ = socket.emit("voice-transmit-mode-error", &json!({
                "error": "Unsupported voice transmit mode",
                "mode": raw_mode,
            }));
            return;
        }
    }
    .to_string();

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

    let updated_channels: Vec<(String, Vec<Value>)> = {
        let mut voice = state.voice_channels.write().await;
        let mut updated = Vec::new();
        for (channel_id, members) in voice.iter_mut() {
            let mut touched = false;
            for participant in members.iter_mut().filter(|p| p.socket_id == socket.id.to_string()) {
                participant.transmit_mode = mode.clone();
                touched = true;
            }
            if touched {
                updated.push((
                    channel_id.clone(),
                    members.iter().map(voice_participant_to_view).collect(),
                ));
            }
        }
        updated
    };

    let payload = json!({
        "userId": stable_id,
        "socketId": socket.id.to_string(),
        "mode": mode,
    });
    let _ = socket.emit("voice-transmit-mode-updated", &payload);
    let _ = io.broadcast().emit("voice-transmit-mode-updated", &payload).await;

    for (channel_id, members) in updated_channels {
        let _ = io
            .emit(
                "voice-channel-state",
                &json!({
                    "channelId": channel_id,
                    "members": members,
                }),
            )
            .await;
    }
}

// ---------------------------------------------------------------------------
// Call lifecycle handlers
// ---------------------------------------------------------------------------

