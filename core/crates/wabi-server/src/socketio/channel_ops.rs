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

    match state.app.wdb.create_forum_thread(&channel_id, &name, user_id as u64).await {
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
