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

    let token = socket.extensions.get::<AuthToken>().map(|t| t.0.clone()).unwrap_or_default();
    let user_id = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);
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

    let token = socket.extensions.get::<AuthToken>().map(|t| t.0.clone()).unwrap_or_default();
    let user_id = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);
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

    let token = socket.extensions.get::<AuthToken>().map(|t| t.0.clone()).unwrap_or_default();
    let user_id = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);
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

    let token = socket.extensions.get::<AuthToken>().map(|t| t.0.clone()).unwrap_or_default();
    let caller_id = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);
    if caller_id <= 0 {
        let _ = socket.emit("reorder-channels-error", &json!({"error": "Authentication required"}));
        return;
    }

    for entry in channels {
        let id = match entry.get("id").and_then(|v| v.as_str()) {
            Some(id) => id.to_string(),
            None => continue,
        };
        let position = entry.get("position").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
        let parent_id = entry.get("parentId").and_then(|v| v.as_str());

        let mut row = serde_json::Map::new();
        row.insert("channel_id".to_string(), json!(id));
        row.insert("position".to_string(), json!(position));
        if let Some(pid) = parent_id {
            row.insert("parent_id".to_string(), json!(pid));
        } else {
            row.insert("parent_id".to_string(), json!(serde_json::Value::Null));
        }

        if let Err(e) = state.app.wdb.ingest_event("channel", "update_settings", &json!({ "row": row.clone() })).await {
            warn!("[sio] reorder-channels: failed to update {}: {}", id, e);
        }

        let mut patch = serde_json::Map::new();
        patch.insert("channel_id".to_string(), json!(id));
        patch.insert("position".to_string(), json!(position));
        if let Some(pid) = parent_id {
            patch.insert("parent_id".to_string(), json!(pid));
        } else {
            patch.insert("parent_id".to_string(), json!(serde_json::Value::Null));
        }
        if let Err(e) = state.app.wdb.ingest_event("channel", "update", &json!({ "row": patch })).await {
            warn!("[sio] reorder-channels: projection merge failed for {}: {}", id, e);
        }
    }

    let reordered: Vec<Value> = channels.iter().map(|entry| {
        json!({
            "id": entry.get("id").and_then(|v| v.as_str()).unwrap_or(""),
            "position": entry.get("position").and_then(|v| v.as_i64()).unwrap_or(0),
            "parentId": entry.get("parentId").and_then(|v| v.as_str()),
        })
    }).collect();

    let _ = socket.emit("channels-reordered", &json!({"channels": reordered}));
    let _ = io.broadcast().emit("channels-reordered", &json!({"channels": reordered})).await;
}
