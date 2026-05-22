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
        if let Ok(true) = state.app.stdb.is_user_muted(user_id_num, Some(&channel_id)).await {
            warn!("[sio] user {} muted in voice channel {}", user_id_num, channel_id);
            let _ = socket.emit("voice-channel-error", &json!({ "channelId": channel_id, "error": "You are muted in this channel" }));
            return;
        }
    }

    let is_deafened = if user_id_num > 0 {
        state.app.stdb.is_user_deafened(user_id_num, Some(&channel_id)).await.unwrap_or(false)
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

// ---------------------------------------------------------------------------
// Call lifecycle handlers
// ---------------------------------------------------------------------------

