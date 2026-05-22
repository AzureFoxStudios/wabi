async fn on_kick_group_member(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let channel_id = match data.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };
    let target_user_id = match data.get("targetUserId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };

    // Auth check — must be channel admin or server admin
    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();
    let my_user_id = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);
    if my_user_id <= 0 {
        let _ = socket.emit("kick-error", &json!({ "error": "Guests cannot kick members" }));
        return;
    }

    // Check if server admin or has channel admin role
    let is_server_admin = state.app.is_admin(my_user_id).await;
    if !is_server_admin {
        // TODO: check channel-specific admin role
    }

    // Broadcast group-member-removed
    let _ = io
        .broadcast()
        .emit(
            "group-member-removed",
            &json!({
                "channelId": channel_id,
                "userId": target_user_id,
            }),
        )
        .await;
}

async fn on_leave_group(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let channel_id = match data.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };

    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();
    let my_user_id = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);
    let stable_id = if my_user_id > 0 {
        format!("user-{}", my_user_id)
    } else {
        socket.id.to_string()
    };

    // Broadcast group-removed to all members (the leaving user is leaving the group)
    let _ = io
        .to(channel_id.clone())
        .emit(
            "group-removed",
            &json!({ "channelId": channel_id }),
        )
        .await;

    let _ = io
        .broadcast()
        .emit(
            "group-member-removed",
            &json!({
                "channelId": channel_id,
                "userId": stable_id,
            }),
        )
        .await;
}

async fn on_add_group_member(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let channel_id = match data.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };
    let user_id = match data.get("userId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };

    // Auth check — must be admin
    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();
    let my_user_id = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);
    if !state.app.is_admin(my_user_id).await {
        let _ = socket.emit("add-member-error", &json!({ "error": "Only admins can add members" }));
        return;
    }

    // Resolve user info for the event
    let (username, color) = {
        let connected = state.connected_users.read().await;
        connected
            .values()
            .find(|u| u.stable_id == user_id || u.stable_id == format!("user-{}", user_id))
            .map(|u| (u.username.clone(), u.color.clone()))
            .unwrap_or_else(|| (user_id.clone(), "#98D8C8".to_string()))
    };

    let _ = io
        .broadcast()
        .emit(
            "group-member-added",
            &json!({
                "channelId": channel_id,
                "userId": user_id,
                "user": {
                    "id": user_id,
                    "username": username,
                    "color": color,
                }
            }),
        )
        .await;
}

async fn on_update_group_avatar(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let channel_id = match data.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };
    let avatar_url = data.get("avatarUrl").and_then(|v| v.as_str()).map(String::from);

    // Auth check — must be admin
    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();
    let my_user_id = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);
    if !state.app.is_admin(my_user_id).await {
        let _ = socket.emit("avatar-error", &json!({ "error": "Only admins can update avatars" }));
        return;
    }

    // Persist avatar update to STDB via upsert_group
    if let Err(e) = state
        .app
        .stdb
        .upsert_group(&channel_id, "", "group", None, avatar_url.as_deref(), None)
        .await
    {
        warn!("[sio] update-group-avatar: failed to update avatar for {}: {}", channel_id, e);
        let _ = socket.emit("avatar-error", &json!({ "error": "Failed to update avatar" }));
        return;
    }

    // Broadcast group-avatar-updated
    let _ = io
        .broadcast()
        .emit(
            "group-avatar-updated",
            &json!({
                "channelId": channel_id,
                "avatar": avatar_url,
            }),
        )
        .await;
}

async fn on_edit_message(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let channel_id = match data.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };
    let message_id = match data.get("messageId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };
    let new_text = match data.get("newText").and_then(|v| v.as_str()) {
        Some(t) => t.to_string(),
        None => return,
    };

    // Auth check — must have a real user account
    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();
    let my_user_id = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);
    if my_user_id <= 0 {
        let _ = socket.emit("edit-error", &json!({ "messageId": message_id, "error": "Guests cannot edit messages" }));
        return;
    }

    // Check if user owns the message (or is admin)
    let is_admin = state.app.is_admin(my_user_id).await;
    if !is_admin {
        match state.app.stdb.get_message_sender(&message_id).await {
            Ok(Some(sender_id)) => {
                let user_stable_id = format!("user-{}", my_user_id);
                if sender_id != user_stable_id {
                    warn!("[sio] edit-message: user {} not authorized to edit message {} (owned by {})", my_user_id, message_id, sender_id);
                    let _ = socket.emit("edit-error", &json!({ "messageId": message_id, "error": "Cannot edit others' messages" }));
                    return;
                }
            }
            Err(e) => {
                warn!("Failed to check message ownership: {}", e);
                let _ = socket.emit("edit-error", &json!({ "messageId": message_id, "error": "Database error" }));
                return;
            }
            Ok(None) => {
                warn!("[sio] edit-message: message {} not found", message_id);
                let _ = socket.emit("edit-error", &json!({ "messageId": message_id, "error": "Message not found" }));
                return;
            }
        }
    }

    // Persist edit to STDB
    if let Err(e) = state.app.stdb.edit_message(&message_id, &new_text).await {
        warn!("[sio] edit-message: failed to edit message {}: {}", message_id, e);
        let _ = socket.emit("edit-error", &json!({ "messageId": message_id, "error": "Database error" }));
        return;
    }

    // Broadcast message-edited to all clients in the channel
    let _ = io
        .to(channel_id.clone())
        .emit(
            "message-edited",
            &json!({
                "channelId": channel_id,
                "messageId": message_id,
                "newText": new_text,
            }),
        )
        .await;
}
