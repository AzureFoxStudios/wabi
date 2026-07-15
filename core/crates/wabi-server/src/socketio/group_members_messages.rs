// WDB-compat shim: this file calls `state.app.wdb.X(...)` for
// methods the WDB doesn't have equivalents for yet
// (is_user_muted, get_channel_retention, mute_user, etc.).
// The compat WdbClient in `db/` returns no-op defaults for all
// of these. When WDB has the corresponding engine methods, this
// file can be migrated to use `state.app.wdb.X(...)` instead.
// The compat shim itself is a temporary layer and will be removed
// once the last socketio file is migrated.

#[allow(dead_code)]
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

#[allow(dead_code)]
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

#[allow(dead_code)]
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

#[allow(dead_code)]
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

    // Persist avatar update to WDB via upsert_group
    if let Err(e) = state
        .app
        .wdb
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

#[allow(dead_code)]
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
    let my_username = username_from_token(&token, &state.app.config.jwt_secret).unwrap_or_default();
    let is_admin = if my_user_id > 0 {
        state.app.is_admin(my_user_id).await
    } else {
        false
    };

    // Authorize: admin, registered owner, or guest editing their own session message
    if !is_admin {
        let mut allowed = false;
        // Session cache identity check (covers guests + live messages)
        {
            let session = state.app.session_messages.read().await;
            if let Some(msgs) = session.get(&channel_id) {
                if let Some(m) = msgs.iter().find(|m| m.get("id").and_then(|v| v.as_str()) == Some(message_id.as_str())) {
                    let author = m.get("user").and_then(|v| v.as_str()).unwrap_or("");
                    let author_uid = m.get("userId").and_then(|v| v.as_str()).unwrap_or("");
                    if (!my_username.is_empty() && author == my_username)
                        || author_uid == socket.id.to_string()
                        || (my_user_id > 0 && author_uid == format!("user-{}", my_user_id))
                    {
                        allowed = true;
                    }
                }
            }
        }
        if !allowed && my_user_id > 0 {
            match state.app.wdb.get_message_typed(&message_id).await {
                Ok(Some(m)) => {
                    if m.author_user_id == my_user_id as u64 {
                        allowed = true;
                    } else {
                        warn!("[sio] edit-message: user {} not authorized to edit message {} (owned by {})", my_user_id, message_id, m.author_user_id);
                        let _ = socket.emit("edit-error", &json!({ "messageId": message_id, "error": "Cannot edit others' messages" }));
                        return;
                    }
                }
                Ok(None) => {}
                Err(e) => {
                    warn!("Failed to check message ownership: {}", e);
                }
            }
        }
        if !allowed {
            let _ = socket.emit(
                "edit-error",
                &json!({ "messageId": message_id, "error": "Not allowed to edit this message" }),
            );
            return;
        }
    }

    // Update live session cache first (source of truth for open clients)
    let mut found_in_session = false;
    {
        let mut session = state.app.session_messages.write().await;
        if let Some(msgs) = session.get_mut(&channel_id) {
            for m in msgs.iter_mut() {
                if m.get("id").and_then(|v| v.as_str()) == Some(message_id.as_str()) {
                    m["text"] = json!(new_text);
                    m["isEdited"] = json!(true);
                    found_in_session = true;
                    break;
                }
            }
        }
    }

    // Persist to WDB when present (may miss legacy session-only ids)
    match state
        .app
        .wdb
        .edit_message(&message_id, my_user_id as u64, &new_text)
        .await
    {
        Ok(()) => {}
        Err(e) => {
            if !found_in_session {
                warn!(
                    "[sio] edit-message: failed to edit message {} (not in session either): {}",
                    message_id, e
                );
                let _ = socket.emit(
                    "edit-error",
                    &json!({ "messageId": message_id, "error": "Message not found" }),
                );
                return;
            }
            warn!(
                "[sio] edit-message: WDB miss for {} (session updated): {}",
                message_id, e
            );
        }
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

/// Toggle the pinned state of a message. Only the server owner or an admin
/// (mods+ per the RBAC TODO) may pin. Mirrors the edit/delete permission gate.
async fn on_toggle_pin(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let channel_id = match data.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };
    let message_id = match data.get("messageId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };

    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();
    let user_id = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);
    let is_owner = state.app.is_owner(user_id).await;
    let is_admin = state.app.is_admin(user_id).await;
    if user_id <= 0 || !(is_owner || is_admin) {
        let _ = socket.emit(
            "pin-error",
            &json!({
                "messageId": message_id,
                "error": "Only the server owner or an admin can pin messages",
            }),
        );
        return;
    }

    // Toggle is_pinned on the live session message (source of truth for clients)
    let mut new_pinned = false;
    {
        let mut session = state.app.session_messages.write().await;
        if let Some(msgs) = session.get_mut(&channel_id) {
            for m in msgs.iter_mut() {
                if m.get("id").and_then(|v| v.as_str()) == Some(message_id.as_str()) {
                    let current = m.get("isPinned").and_then(|v| v.as_bool()).unwrap_or(false);
                    new_pinned = !current;
                    m["isPinned"] = json!(new_pinned);
                    break;
                }
            }
        }
    }

    // Broadcast the new pinned state to every client in the channel
    let _ = io
        .to(channel_id.clone())
        .emit(
            "message-pinned",
            &json!({
                "channelId": channel_id,
                "messageId": message_id,
                "isPinned": new_pinned,
            }),
        )
        .await;
}
