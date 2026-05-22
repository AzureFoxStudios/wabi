async fn on_voice_mute(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let channel_id = match data.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };
    let target_user_id = match data.get("targetUserId").and_then(|v| v.as_i64()) {
        Some(id) => id,
        None => {
            let _ = socket.emit("voice-mute-error", &json!({ "error": "Invalid targetUserId" }));
            return;
        }
    };

    // Auth check — must be admin
    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();
    let my_user_id = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);
    if !state.app.is_admin(my_user_id).await {
        let _ = socket.emit("voice-mute-error", &json!({ "error": "Only admins can mute users" }));
        return;
    }

    // Mute the user on this channel
    if let Err(e) = state.app.stdb.mute_user(target_user_id, Some(&channel_id), my_user_id).await {
        warn!("[sio] voice-mute: failed to mute user {}: {}", target_user_id, e);
        let _ = socket.emit("voice-mute-error", &json!({ "error": "Failed to mute user" }));
        return;
    }

    // Kick the user from the voice channel if connected
    let target_stable_id = format!("user-{}", target_user_id);
    {
        let mut voice = state.voice_channels.write().await;
        if let Some(members) = voice.get_mut(&channel_id) {
            members.retain(|p| p.stable_id != target_stable_id);
        }
    }

    // Broadcast voice-user-muted event
    let _ = io
        .broadcast()
        .emit(
            "voice-user-muted",
            &json!({
                "channelId": channel_id,
                "userId": target_stable_id,
                "dbUserId": target_user_id,
            }),
        )
        .await;
}

async fn on_voice_unmute(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let channel_id = match data.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };
    let target_user_id = match data.get("targetUserId").and_then(|v| v.as_i64()) {
        Some(id) => id,
        None => {
            let _ = socket.emit("voice-unmute-error", &json!({ "error": "Invalid targetUserId" }));
            return;
        }
    };

    // Auth check — must be admin
    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();
    let my_user_id = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);
    if !state.app.is_admin(my_user_id).await {
        let _ = socket.emit("voice-unmute-error", &json!({ "error": "Only admins can unmute users" }));
        return;
    }

    // Unmute the user on this channel
    if let Err(e) = state.app.stdb.unmute_user(target_user_id, Some(&channel_id)).await {
        warn!("[sio] voice-unmute: failed to unmute user {}: {}", target_user_id, e);
        let _ = socket.emit("voice-unmute-error", &json!({ "error": "Failed to unmute user" }));
        return;
    }

    // Broadcast voice-user-unmuted event
    let target_stable_id = format!("user-{}", target_user_id);
    let _ = io
        .broadcast()
        .emit(
            "voice-user-unmuted",
            &json!({
                "channelId": channel_id,
                "userId": target_stable_id,
                "dbUserId": target_user_id,
            }),
        )
        .await;
}

async fn on_voice_deafen(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let channel_id = match data.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };
    let target_user_id = match data.get("targetUserId").and_then(|v| v.as_i64()) {
        Some(id) => id,
        None => {
            let _ = socket.emit("voice-deafen-error", &json!({ "error": "Invalid targetUserId" }));
            return;
        }
    };

    // Auth check — must be admin
    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();
    let my_user_id = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);
    if !state.app.is_admin(my_user_id).await {
        let _ = socket.emit("voice-deafen-error", &json!({ "error": "Only admins can deafen users" }));
        return;
    }

    // Deafen the user on this channel
    if let Err(e) = state.app.stdb.deafen_user(target_user_id, Some(&channel_id), my_user_id).await {
        warn!("[sio] voice-deafen: failed to deafen user {}: {}", target_user_id, e);
        let _ = socket.emit("voice-deafen-error", &json!({ "error": "Failed to deafen user" }));
        return;
    }

    // Update the participant's is_deafened flag if they're in the voice channel
    let target_stable_id = format!("user-{}", target_user_id);
    {
        let mut voice = state.voice_channels.write().await;
        if let Some(members) = voice.get_mut(&channel_id) {
            if let Some(participant) = members.iter_mut().find(|p| p.stable_id == target_stable_id) {
                participant.is_deafened = true;
            }
        }
    }

    // Broadcast voice-user-deafened event
    let _ = io
        .broadcast()
        .emit(
            "voice-user-deafened",
            &json!({
                "channelId": channel_id,
                "userId": target_stable_id,
                "dbUserId": target_user_id,
            }),
        )
        .await;
}

async fn on_voice_undeafen(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let channel_id = match data.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };
    let target_user_id = match data.get("targetUserId").and_then(|v| v.as_i64()) {
        Some(id) => id,
        None => {
            let _ = socket.emit("voice-undeafen-error", &json!({ "error": "Invalid targetUserId" }));
            return;
        }
    };

    // Auth check — must be admin
    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();
    let my_user_id = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);
    if !state.app.is_admin(my_user_id).await {
        let _ = socket.emit("voice-undeafen-error", &json!({ "error": "Only admins can undeafen users" }));
        return;
    }

    // Undeafen the user on this channel
    if let Err(e) = state.app.stdb.undeafen_user(target_user_id, Some(&channel_id)).await {
        warn!("[sio] voice-undeafen: failed to undeafen user {}: {}", target_user_id, e);
        let _ = socket.emit("voice-undeafen-error", &json!({ "error": "Failed to undeafen user" }));
        return;
    }

    // Update the participant's is_deafened flag if they're in the voice channel
    let target_stable_id = format!("user-{}", target_user_id);
    {
        let mut voice = state.voice_channels.write().await;
        if let Some(members) = voice.get_mut(&channel_id) {
            if let Some(participant) = members.iter_mut().find(|p| p.stable_id == target_stable_id) {
                participant.is_deafened = false;
            }
        }
    }

    // Broadcast voice-user-undeafened event
    let target_stable_id = format!("user-{}", target_user_id);
    let _ = io
        .broadcast()
        .emit(
            "voice-user-undeafened",
            &json!({
                "channelId": channel_id,
                "userId": target_stable_id,
                "dbUserId": target_user_id,
            }),
        )
        .await;
}

