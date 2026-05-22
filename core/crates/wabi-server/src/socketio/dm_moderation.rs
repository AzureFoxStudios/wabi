async fn on_create_dm(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let target_user_id = match data.get("targetUserId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };

    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();
    let my_user_id = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);

    // Auth check — guests cannot create DMs
    if my_user_id <= 0 {
        let _ = socket.emit("dm-error", &json!({ "error": "Guests cannot create DMs" }));
        return;
    }

    // Build stable DM channel id: dm-sorted-member1-sorted-member2
    let my_stable_id = format!("user-{}", my_user_id);

    // Sort the two IDs to get a canonical channel id regardless of who initiates
    let member_ids = [my_stable_id.clone(), target_user_id.clone()];
    let mut sorted = member_ids.to_vec();
    sorted.sort();
    let channel_id = format!("dm-{}", sorted.join("-"));

    // Check if DM already exists in channel list
    let existing = state.app.stdb.get_channels_raw().await.unwrap_or_default();
    if existing.iter().any(|c| {
        c.get("channel_id")
            .or_else(|| c.get("id"))
            .and_then(|v| v.as_str()) == Some(&channel_id)
    }) {
        let _ = socket.emit("dm-error", &json!({ "error": "DM already exists", "channelId": channel_id }));
        return;
    }

    // Resolve target user info for the event payload
    let target_username = {
        let connected = state.connected_users.read().await;
        connected
            .values()
            .find(|u| u.stable_id == target_user_id || u.stable_id == format!("user-{}", target_user_id))
            .map(|u| u.username.clone())
            .unwrap_or_else(|| target_user_id.clone())
    };

    // Persist DM channel to STDB
    if let Err(e) = state
        .app
        .stdb
        .create_dm_channel(&channel_id, &format!("DM with {}", target_username), &sorted, my_user_id)
        .await
    {
        warn!("[sio] create-dm: failed to create channel {}: {}", channel_id, e);
        let _ = socket.emit("dm-error", &json!({ "error": "Failed to create DM", "channelId": channel_id }));
        return;
    }

    let dm_event = json!({
        "channelId": channel_id,
        "otherUser": {
            "id": target_user_id,
            "username": target_username,
            "color": "#98D8C8",
        }
    });

    // Emit dm-created to the initiating socket
    let _ = socket.emit("dm-created", &dm_event);
    // Broadcast dm-channel-added to all other clients
    let _ = io.broadcast().emit("dm-channel-added", &dm_event).await;
}

async fn on_delete_dm(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let channel_id = match data.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };

    if !channel_id.starts_with("dm-") {
        let _ = socket.emit("dm-error", &json!({ "error": "Not a DM channel", "channelId": channel_id }));
        return;
    }

    // Auth check
    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();
    let my_user_id = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);
    if my_user_id <= 0 {
        let _ = socket.emit("dm-error", &json!({ "error": "Guests cannot delete DMs", "channelId": channel_id }));
        return;
    }

    // Persist deletion to STDB
    if let Err(e) = state.app.stdb.delete_dm_channel(&channel_id).await {
        warn!("[sio] delete-dm: failed to delete channel {}: {}", channel_id, e);
        let _ = socket.emit("dm-error", &json!({ "error": "Failed to delete DM", "channelId": channel_id }));
        return;
    }

    let _ = socket.emit("dm-deleted", &json!({ "channelId": channel_id }));
    let _ = io.broadcast().emit("dm-deleted", &json!({ "channelId": channel_id })).await;
}

async fn on_ban_user(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let target_user_id = match data.get("targetUserId").and_then(|v| v.as_i64()) {
        Some(id) => id,
        None => {
            let _ = socket.emit("ban-error", &json!({ "error": "Invalid targetUserId" }));
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
        let _ = socket.emit("ban-error", &json!({ "error": "Only admins can ban users" }));
        return;
    }

    let reason = data.get("reason").and_then(|v| v.as_str());

    // Disconnect the target if connected, then broadcast
    let target_stable_id = format!("user-{}", target_user_id);
    let mut disconnected_socket_id = None;

    {
        let mut connected = state.connected_users.write().await;
        for (sid, user) in connected.iter_mut() {
            if user.stable_id == target_stable_id {
                disconnected_socket_id = Some(sid.clone());
                break;
            }
        }
    }

    if let Some(sid) = disconnected_socket_id {
        // Emit ban to the target socket forcing disconnect
        let _ = io
            .to(sid.clone())
            .emit("ban", &json!({ "reason": reason }))
            .await;
    }

    // Broadcast user-banned event
    let _ = io
        .broadcast()
        .emit(
            "user-banned",
            &json!({
                "userId": target_stable_id,
                "dbUserId": target_user_id,
                "reason": reason
            }),
        )
        .await;
}

