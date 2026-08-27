// WDB-compat shim: this file calls `state.app.wdb.X(...)` for
// methods the WDB doesn't have equivalents for yet.

#[allow(dead_code)]
async fn on_create_thread(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let channel_id = match data.get("parentChannelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => {
            let _ = socket.emit("create-thread-error", &json!({"error": "Missing parentChannelId"}));
            return;
        }
    };
    let name = match data.get("name").and_then(|v| v.as_str()) {
        Some(n) => n.to_string(),
        None => {
            let _ = socket.emit("create-thread-error", &json!({"error": "Missing name"}));
            return;
        }
    };

    let identity = resolve_sio_identity(&socket);
    let user_id = identity.as_ref().map(|i| i.user_id).unwrap_or(0);
    if user_id <= 0 {
        let _ = socket.emit("create-thread-error", &json!({"error": "Authentication required"}));
        return;
    }

    match state.app.wdb.create_forum_thread(&channel_id, &name, user_id as u64, None, None, None).await {
        Ok(thread_id) => {
            let _ = socket.emit("thread-created", &json!({
                "channelId": channel_id,
                "threadId": thread_id,
                "name": name,
            }));
            let _ = io.to(channel_id.clone()).emit("thread-created", &json!({
                "channelId": channel_id,
                "threadId": thread_id,
                "name": name,
            })).await;
        }
        Err(e) => {
            warn!("[sio] create-thread failed: {}", e);
            let _ = socket.emit("create-thread-error", &json!({"error": format!("Failed to create thread: {}", e)}));
        }
    }
}

#[allow(dead_code)]
async fn on_pin_channel(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let channel_id = match data.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };

    let identity = resolve_sio_identity(&socket);
    let user_id = identity.as_ref().map(|i| i.user_id).unwrap_or(0);
    if user_id <= 0 {
        let _ = socket.emit("pin-channel-error", &json!({"error": "Authentication required"}));
        return;
    }

    if let Err(e) = state.app.wdb.ingest_event("channel", "pin", &json!({
        "channelId": channel_id,
        "userId": user_id,
    })).await {
        warn!("[sio] pin-channel failed: {}", e);
        let _ = socket.emit("pin-channel-error", &json!({"error": "Failed to pin channel"}));
        return;
    }

    let _ = socket.emit("channel-pinned", &json!({"channelId": channel_id}));
    let _ = io.broadcast().emit("channel-pinned", &json!({"channelId": channel_id})).await;
}

#[allow(dead_code)]
async fn on_unpin_channel(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let channel_id = match data.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };

    let identity = resolve_sio_identity(&socket);
    let user_id = identity.as_ref().map(|i| i.user_id).unwrap_or(0);
    if user_id <= 0 {
        let _ = socket.emit("unpin-channel-error", &json!({"error": "Authentication required"}));
        return;
    }

    if let Err(e) = state.app.wdb.ingest_event("channel", "unpin", &json!({
        "channelId": channel_id,
        "userId": user_id,
    })).await {
        warn!("[sio] unpin-channel failed: {}", e);
        let _ = socket.emit("unpin-channel-error", &json!({"error": "Failed to unpin channel"}));
        return;
    }

    let _ = socket.emit("channel-unpinned", &json!({"channelId": channel_id}));
    let _ = io.broadcast().emit("channel-unpinned", &json!({"channelId": channel_id})).await;
}

#[allow(dead_code)]
async fn on_reorder_channels(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let channels = match data.get("channels").and_then(|v| v.as_array()) {
        Some(list) => list,
        None => return,
    };

    let identity = resolve_sio_identity(&socket);
    let caller_id = identity.as_ref().map(|i| i.user_id).unwrap_or(0);
    if caller_id <= 0 {
        let _ = socket.emit("reorder-channels-error", &json!({"error": "Authentication required"}));
        return;
    }

    // Role gate: only Owner / Admin / Moderator may rearrange channels for
    // everyone. Communities decide who their moderators are via role
    // assignment, so the Moderator role IS the community opt-in. Mirrors the
    // client-side canReorderChannels gate in ChannelSidebar.svelte.
    let role = state.app.get_user_highest_role(caller_id).await;
    if !matches!(role.to_ascii_lowercase().as_str(), "owner" | "admin" | "moderator") {
        warn!("[sio] reorder-channels denied for user {} (role {})", caller_id, role);
        let _ = socket.emit(
            "reorder-channels-error",
            &json!({"error": "You do not have permission to rearrange channels"}),
        );
        return;
    }

    for entry in channels {
        let id = match entry.get("id").and_then(|v| v.as_str()) {
            Some(id) => id.to_string(),
            None => continue,
        };
        let position = entry.get("position").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
        let parent_id = entry.get("parentId").and_then(|v| v.as_str());

        // Single durable event per channel, routed through `update_channel`
        // so it lands as `channel_updated` — the event type the channels
        // projection actually merges (projections/channels.rs). The old
        // `ingest_event("channel", "update_settings")` call was translated
        // into `channel_settings_updated`, which only the AUDIT projection
        // consumes: positions/folder moves silently reverted on every page
        // load. `update_channel` sends exactly the fields present
        // (channel_id + position + parent_id), so it is still one event.
        let mut patch = serde_json::Map::new();
        patch.insert("position".to_string(), json!(position));
        patch.insert(
            "parent_id".to_string(),
            match parent_id {
                Some(pid) => json!(pid),
                None => json!(serde_json::Value::Null),
            },
        );

        if let Err(e) = state
            .app
            .wdb
            .update_channel(&id, &serde_json::Value::Object(patch), caller_id as u64)
            .await
        {
            warn!("[sio] reorder-channels: failed to update {}: {}", id, e);
        }
    }

    let reordered: Vec<Value> = channels.iter().map(|entry| {
        // Always include parentId (null clears folder membership). Omitting it
        // left clients with stale optimistic parentId after refresh-less peers.
        let parent = entry.get("parentId").cloned().unwrap_or(Value::Null);
        json!({
            "id": entry.get("id").and_then(|v| v.as_str()).unwrap_or(""),
            "position": entry.get("position").and_then(|v| v.as_i64()).unwrap_or(0),
            "parentId": parent,
        })
    }).collect();

    let _ = socket.emit("channels-reordered", &json!({"channels": reordered}));
    let _ = io.broadcast().emit("channels-reordered", &json!({"channels": reordered})).await;
}
