async fn on_message(socket: SocketRef, cmd: Value, state: SioState, io: SocketIo) {
    let channel_id = match cmd.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => {
            warn!("[sio] message missing channelId");
            return;
        }
    };

    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();
    let username = username_from_token(&token, &state.app.config.jwt_secret)
        .unwrap_or_else(|| "unknown".to_string());
    let user_id_num = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);

    // Check if user is muted
    if user_id_num > 0 {
        if let Ok(true) = state.app.stdb.is_user_muted(user_id_num, Some(&channel_id)).await {
            warn!("[sio] user {} muted in channel {}", user_id_num, channel_id);
            return;
        }
    }
    let stable_id = if user_id_num > 0 {
        format!("user-{}", user_id_num)
    } else {
        socket.id.to_string()
    };

    let color = {
        let connected = state.connected_users.read().await;
        connected
            .get(&socket.id.to_string())
            .map(|u| u.color.clone())
            .unwrap_or_else(|| "#98D8C8".to_string())
    };

    let message_id = new_message_id(&channel_id, &username);
    let timestamp = now_ms();
    let client_message_id = cmd
        .get("clientMessageId")
        .and_then(|v| v.as_str())
        .map(String::from);

    let message_view = json!({
        "id":             message_id.clone(),
        "user":           username,
        "userId":         stable_id.clone(),
        "senderStableId": stable_id,
        "color":          color,
        "text":           cmd.get("text").and_then(|v| v.as_str()).unwrap_or(""),
        "timestamp":      timestamp,
        "type":           cmd.get("type").and_then(|v| v.as_str()).unwrap_or("text"),
        "clientMessageId": client_message_id.clone(),
        "encrypted":      cmd.get("encrypted"),
        "iv":             cmd.get("iv"),
        "isSpoiler":      cmd.get("isSpoiler"),
        "replyTo":        cmd.get("replyTo"),
        "gifUrl":         cmd.get("gifUrl"),
        "emojiUrl":       cmd.get("emojiUrl"),
        "emojiName":      cmd.get("emojiName"),
        "fileUrl":        cmd.get("fileUrl"),
        "fileName":       cmd.get("fileName"),
        "fileSize":       cmd.get("fileSize"),
        "files":          cmd.get("files"),
        "attachmentEncryption": cmd.get("attachmentEncryption"),
        "attachmentStorage": cmd.get("attachmentStorage"),
        "entities":       cmd.get("entities"),
    });

    {
        let mut session = state.app.session_messages.write().await;
        let msgs = session.entry(channel_id.clone()).or_default();
        msgs.push(message_view.clone());
        if msgs.len() > 1000 {
            msgs.drain(0..msgs.len() - 1000);
        }
    }

    if user_id_num > 0 {
        if let Err(e) = state
            .app
            .stdb
            .upsert_message(
                &message_id,
                &channel_id,
                user_id_num,
                &username,
                cmd.get("text").and_then(|v| v.as_str()).unwrap_or(""),
                timestamp,
            )
            .await
        {
            warn!("Failed to persist message to STDB: {}", e);
        }

        // Schedule message deletion if channel has retention set
        if let Ok(Some(duration)) = state.app.stdb.get_channel_retention(&channel_id).await {
            if let Some(ms) = retention_to_ms(&duration) {
                let stdb = state.app.stdb.clone();
                let msg_id = message_id.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
                    let _ = stdb.delete_message(&msg_id).await;
                });
            }
        }
    }

    let _ = socket.emit(
        "message-accepted",
        &json!({
            "channelId":      channel_id,
            "messageId":      message_id,
            "clientMessageId": client_message_id,
            "timestamp":      timestamp,
        }),
    );

    let _ = io
        .to(channel_id)
        .emit(
            "message",
            &json!({
                "channelId": cmd.get("channelId"),
                "message":   message_view,
            }),
        )
        .await;
}

async fn on_load_history(socket: SocketRef, req: Value, state: SioState) {
    let channel_id = match req.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };
    let limit = req
        .get("limit")
        .and_then(|v| v.as_u64())
        .unwrap_or(50)
        .min(100) as usize;

    // Prefer the in-memory session cache — it has the full message view including
    // file/emoji/attachment metadata that STDB does not store.
    let session_msgs: Vec<Value> = {
        let session = state.app.session_messages.read().await;
        session
            .get(&channel_id)
            .map(|msgs| msgs.iter().rev().take(limit).rev().cloned().collect())
            .unwrap_or_default()
    };

    let messages = if !session_msgs.is_empty() {
        session_msgs
    } else {
        // Fall back to STDB for older messages not in the session cache.
        state
            .app
            .stdb
            .get_messages_raw(&channel_id, limit as u32)
            .await
            .unwrap_or_default()
            .iter()
            .map(row_to_message_view)
            .collect()
    };

    let _ = socket.emit(
        "history-loaded",
        &json!({
            "channelId": channel_id,
            "messages":  messages,
            "hasMore":   false,
            "direction": req.get("direction").unwrap_or(&json!("before")),
            "requestId": req.get("requestId"),
        }),
    );
}

async fn on_delete_message(socket: SocketRef, cmd: Value, state: SioState, io: SocketIo) {
    let channel_id = match cmd.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };
    let message_id = match cmd.get("messageId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };

    // Auth check — must have a real user account (not guest)
    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();
    let user_id = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);

    if user_id <= 0 {
        let _ = socket.emit("delete-error", &json!({"messageId": message_id, "error": "Guests cannot delete messages"}));
        return;
    }

    // Check if user owns the message (or is admin)
    let is_admin = state.app.is_admin(user_id).await;
    if !is_admin {
        match state.app.stdb.get_message_sender(&message_id).await {
            Ok(Some(sender_id)) => {
                let user_stable_id = format!("user-{}", user_id);
                if sender_id != user_stable_id {
                    warn!("[sio] delete-message: user {} not authorized to delete message {} (owned by {})", user_id, message_id, sender_id);
                    let _ = socket.emit("delete-error", &json!({"messageId": message_id, "error": "Cannot delete others' messages"}));
                    return;
                }
            }
            Err(e) => {
                warn!("Failed to check message ownership: {}", e);
                let _ = socket.emit("delete-error", &json!({"messageId": message_id, "error": "Database error"}));
                return;
            }
            Ok(None) => {
                warn!("[sio] delete-message: message {} not found", message_id);
                let _ = socket.emit("delete-error", &json!({"messageId": message_id, "error": "Message not found"}));
                return;
            }
        }
    }

    // Remove from session cache
    {
        let mut session = state.app.session_messages.write().await;
        if let Some(msgs) = session.get_mut(&channel_id) {
            msgs.retain(|m| m.get("id").and_then(|v| v.as_str()) != Some(&message_id));
        }
    }

    // Persist deletion to SpacetimeDB
    if let Err(e) = state.app.stdb.delete_message(&message_id).await {
        warn!("Failed to delete message {}: {}", message_id, e);
        let _ = socket.emit("delete-error", &json!({"messageId": message_id, "error": "Database error"}));
        return;
    }

    // Acknowledge to sender
    let _ = socket.emit("message-deleted", &json!({"channelId": channel_id, "messageId": message_id}));

    // Broadcast deletion to channel
    let _ = io.to(channel_id.clone()).emit(
        "message-deleted",
        &json!({"channelId": channel_id, "messageId": message_id}),
    ).await;
}

async fn on_typing(socket: SocketRef, data: Value, state: SioState) {
    let channel_id = match data.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };
    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();
    let username = username_from_token(&token, &state.app.config.jwt_secret).unwrap_or_default();
    let _ = socket
        .broadcast()
        .to(channel_id.clone())
        .emit(
            "typing",
            &json!({ "channelId": channel_id, "usernames": [username] }),
        )
        .await;
}
