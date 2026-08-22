// WDB-compat shim: this file calls `state.app.wdb.X(...)` for
// methods the WDB doesn't have equivalents for yet
// (is_user_muted, get_channel_retention, mute_user, etc.).
// The compat WdbClient in `db/` returns no-op defaults for all
// of these. When WDB has the corresponding engine methods, this
// file can be migrated to use `state.app.wdb.X(...)` instead.
// The compat shim itself is a temporary layer and will be removed
// once the last socketio file is migrated.

#[allow(dead_code)]
async fn on_create_dm(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let target_user_id = match data.get("targetUserId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };

    let identity = resolve_sio_identity(&socket);
    let my_user_id = identity.as_ref().map(|i| i.user_id).unwrap_or(0);

    // Auth check — guests cannot create DMs
    if my_user_id <= 0 {
        let _ = socket.emit("dm-error", &json!({ "error": "Guests cannot create DMs" }));
        return;
    }

    // Build stable DM channel id: dm-user-{a}-user-{b}
    // Ensure targetUserId is a clean numeric ID, stripping "user-" prefix if present
    let clean_target_user_id = target_user_id.strip_prefix("user-").unwrap_or(&target_user_id);
    let parsed_target_user_id = match clean_target_user_id.parse::<i64>() {
        Ok(id) => id,
        Err(_) => return, // Invalid targetUserId format
    };

    let my_stable_id = format!("user-{}", my_user_id);
    let target_stable_id = format!("user-{}", parsed_target_user_id);

    // Sort the two IDs to get a canonical channel id regardless of who initiates
    let member_ids = [my_stable_id.clone(), target_stable_id.clone()];
    let mut sorted = member_ids.to_vec();
    sorted.sort();
    let channel_id = format!("dm-{}", sorted.join("-"));

    // Check if DM already exists in channel list — point lookup (t_6bbbc52a).
    if state
        .app
        .wdb
        .get_channel_kind(&channel_id)
        .await
        .is_some()
    {
        let _ = socket.emit("dm-error", &json!({ "error": "DM already exists", "channelId": channel_id }));
        return;
    }

    // Resolve target user info for the event payload
    let target_username = {
        let connected = state.connected_users.read().await;
        connected
            .values()
            .find(|u| u.stable_id == target_stable_id || u.stable_id == target_user_id)
            .map(|u| u.username.clone())
            .unwrap_or_else(|| target_stable_id.clone())
    };

    // Persist DM channel to WDB
    if let Err(e) = state
        .app
        .wdb
        .create_dm_channel(&channel_id, &format!("DM with {}", target_username), Some(&sorted), my_user_id)
        .await
    {
        warn!("[sio] create-dm: failed to create channel {}: {}", channel_id, e);
        let _ = socket.emit("dm-error", &json!({ "error": "Failed to create DM", "channelId": channel_id }));
        return;
    }

    let dm_channel = json!({
        "id": channel_id,
        "name": format!("DM with {}", target_username),
        "type": "dm",
        "createdAt": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0),
        "members": sorted,
        "otherUser": {
            "id": target_stable_id,
            "username": target_username,
            "color": "#98D8C8",
            "status": "offline",
        },
        "minRole": "member",
    });
    let dm_event = json!({
        "channelId": channel_id,
        "channel": dm_channel,
        "otherUser": {
            "id": target_stable_id,
            "username": target_username,
            "color": "#98D8C8",
            "status": "offline",
        }
    });

    // Emit dm-created to the initiating socket
    let _ = socket.emit("dm-created", &dm_event);
    // Emit dm-channel-added to the two participants only — never broadcast
    // to all clients (that leaks DM existence to non-participants).
    let _ = io
        .to(format!("user-{}", my_user_id))
        .emit("dm-channel-added", &dm_event)
        .await;
    let _ = io
        .to(target_stable_id)
        .emit("dm-channel-added", &dm_event)
        .await;
}

#[allow(dead_code)]
async fn on_create_group(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let group_name = match data.get("groupName").and_then(|v| v.as_str()).map(str::trim) {
        Some(name) if !name.is_empty() => name.to_string(),
        _ => {
            let _ = socket.emit("group-error", &json!({ "error": "Group name is required" }));
            return;
        }
    };

    let requested_members = match data.get("userIds").and_then(|v| v.as_array()) {
        Some(ids) => ids,
        None => {
            let _ = socket.emit("group-error", &json!({ "error": "At least one member is required" }));
            return;
        }
    };

    let identity = resolve_sio_identity(&socket);
    let my_user_id = identity.as_ref().map(|i| i.user_id).unwrap_or(0);

    // Auth check — guests cannot create persistent group DMs.
    if my_user_id <= 0 {
        let _ = socket.emit("group-error", &json!({ "error": "Guests cannot create groups" }));
        return;
    }

    let my_stable_id = format!("user-{}", my_user_id);
    let mut members = vec![my_stable_id];
    for member in requested_members.iter().filter_map(|v| v.as_str()) {
        let member = member.trim();
        if member.is_empty() {
            continue;
        }
        let stable_id = if let Some(numeric) = member.strip_prefix("user-") {
            if numeric.parse::<i64>().is_ok() {
                format!("user-{}", numeric)
            } else {
                continue;
            }
        } else if member.parse::<i64>().is_ok() {
            format!("user-{}", member)
        } else {
            member.to_string()
        };
        if !members.iter().any(|existing| existing == &stable_id) {
            members.push(stable_id);
        }
    }

    if members.len() < 2 {
        let _ = socket.emit("group-error", &json!({ "error": "At least one other member is required" }));
        return;
    }

    let channel_id = format!("group-{}", uuid::Uuid::new_v4());

    if let Err(e) = state
        .app
        .wdb
        .upsert_group(&channel_id, &group_name, "group", Some(&members), None, None)
        .await
    {
        warn!("[sio] create-group: failed to create channel {}: {}", channel_id, e);
        let _ = socket.emit("group-error", &json!({ "error": "Failed to create group", "channelId": channel_id }));
        return;
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let channel = json!({
        "id": channel_id,
        "name": group_name,
        "type": "group",
        "createdAt": now,
        "members": members,
        "minRole": "member",
    });
    let payload = json!({ "channel": channel, "channelId": channel_id });

    let _ = socket.emit("group-created", &payload);
    let _ = io.broadcast().emit("group-channel-added", &payload).await;
}

#[allow(dead_code)]
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
    let identity = resolve_sio_identity(&socket);
    let my_user_id = identity.as_ref().map(|i| i.user_id).unwrap_or(0);
    if my_user_id <= 0 {
        let _ = socket.emit("dm-error", &json!({ "error": "Guests cannot delete DMs", "channelId": channel_id }));
        return;
    }

    // Persist deletion to WDB
    if let Err(e) = state.app.wdb.delete_dm_channel(&channel_id).await {
        warn!("[sio] delete-dm: failed to delete channel {}: {}", channel_id, e);
        let _ = socket.emit("dm-error", &json!({ "error": "Failed to delete DM", "channelId": channel_id }));
        return;
    }

    let _ = socket.emit("dm-deleted", &json!({ "channelId": channel_id }));
    let _ = io.broadcast().emit("dm-deleted", &json!({ "channelId": channel_id })).await;
}

#[allow(dead_code)]
async fn on_ban_user(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let target_user_id = match data.get("targetUserId").and_then(|v| v.as_i64()) {
        Some(id) => id,
        None => {
            let _ = socket.emit("ban-error", &json!({ "error": "Invalid targetUserId" }));
            return;
        }
    };

    // Auth check — must be admin
    let identity = resolve_sio_identity(&socket);
    let my_user_id = identity.as_ref().map(|i| i.user_id).unwrap_or(0);
    if !state.app.is_admin(my_user_id).await {
        let _ = socket.emit("ban-error", &json!({ "error": "Only admins can ban users" }));
        return;
    }

    // The server owner can never be banned.
    if state.app.is_owner(target_user_id).await {
        let _ = socket.emit("ban-error", &json!({ "error": "The server owner cannot be banned" }));
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

