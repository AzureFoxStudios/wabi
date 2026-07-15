// WDB-compat shim: this file calls `state.app.wdb.X(...)` for
// methods the WDB doesn't have equivalents for yet
// (is_user_muted, get_channel_retention, mute_user, etc.).
// The compat WdbClient in `db/` returns no-op defaults for all
// of these. When WDB has the corresponding engine methods, this
// file can be migrated to use `state.app.wdb.X(...)` instead.
// The compat shim itself is a temporary layer and will be removed
// once the last socketio file is migrated.

#[allow(dead_code)]
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
        if let Ok(true) = state.app.wdb.is_user_muted(&channel_id, user_id_num as u64).await {
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

    // Provisional client-facing id for guests / WDB failure; prefer WDB id when persisted
    // so edit/delete can find the same record (was: socket id vs msg_{seq} mismatch).
    let mut message_id = new_message_id(&channel_id, &username);
    let timestamp = now_ms();
    let client_message_id = cmd
        .get("clientMessageId")
        .and_then(|v| v.as_str())
        .map(String::from);
    let text = cmd.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string();

    if user_id_num > 0 {
        match state
            .app
            .wdb
            .send_message(&channel_id, user_id_num as u64, &text)
            .await
        {
            Ok(wdb_id) => {
                message_id = wdb_id;
            }
            Err(e) => {
                warn!("Failed to persist message to WDB: {}", e);
            }
        }

        // Schedule message deletion if channel has auto-delete (in-memory map + WDB days)
        let mut delete_after_ms: Option<u64> = {
            state
                .app
                .channel_auto_delete_ms
                .read()
                .await
                .get(&channel_id)
                .copied()
                .filter(|ms| *ms > 0)
        };
        if delete_after_ms.is_none() {
            if let Ok(Some(policy)) = state.app.wdb.get_channel_retention(&channel_id).await {
                if policy.days > 0 {
                    delete_after_ms = Some(policy.days as u64 * 86_400_000);
                }
            }
        }
        if let Some(ms) = delete_after_ms {
            let wdb = state.app.wdb.clone();
            let session = state.app.session_messages.clone();
            let msg_id = message_id.clone();
            let ch_id = channel_id.clone();
            let io_bg = io.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
                // session remove
                {
                    let mut guard = session.write().await;
                    if let Some(msgs) = guard.get_mut(&ch_id) {
                        msgs.retain(|m| m.get("id").and_then(|v| v.as_str()) != Some(msg_id.as_str()));
                    }
                }
                let _ = wdb.delete_message(&msg_id, 0).await;
                let payload = json!({"channelId": ch_id, "messageId": msg_id});
                let _ = io_bg.to(ch_id).emit("message-deleted", &payload).await;
            });
        }
    }

    let message_view = json!({
        "id":             message_id.clone(),
        "user":           username,
        "userId":         stable_id.clone(),
        "senderStableId": stable_id,
        "color":          color,
        "text":           text,
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

#[allow(dead_code)]
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
    // file/emoji/attachment metadata that WDB does not store.
    let session_msgs: Vec<Value> = {
        let session = state.app.session_messages.read().await;
        session
            .get(&channel_id)
            .map(|msgs| msgs.iter().rev().take(limit).rev().cloned().collect())
            .unwrap_or_default()
    };

    let messages: Vec<serde_json::Value> = if !session_msgs.is_empty() {
        session_msgs
    } else {
        // Fall back to WDB for older messages not in the session cache.
        // list_messages_typed returns Vec<Message> (typed). Map to the frontend
        // protocol shape (id, userId, user, timestamp) to match the session cache.
        let typed_msgs = state
            .app
            .wdb
            .list_messages_typed(&channel_id, limit as u64)
            .await
            .unwrap_or_default();
        // Historical messages only persist the numeric author_user_id, not the
        // display name. Resolve usernames once so the client can show a real
        // name (and a `user-<dbId>` id it can actually look up) instead of a
        // bare numeric id like "1".
        let mut name_by_id: std::collections::HashMap<u64, String> = std::collections::HashMap::new();
        let distinct_ids: Vec<u64> = {
            let mut seen: std::collections::HashSet<u64> =
                typed_msgs.iter().map(|m| m.author_user_id).collect();
            seen.into_iter().collect()
        };
        for id in distinct_ids {
            if let Ok(Some(u)) = state.app.wdb.get_user(id).await {
                name_by_id.insert(id, u.username);
            }
        }
        typed_msgs
            .into_iter()
            .map(|m| {
                let uname = m
                    .author_username
                    .clone()
                    .filter(|s| !s.is_empty())
                    .or_else(|| name_by_id.get(&m.author_user_id).cloned())
                    .unwrap_or_default();
                json!({
                    "id": m.message_id,
                    "userId": format!("user-{}", m.author_user_id),
                    "user": uname,
                    "timestamp": m.created_at_micros / 1000,
                    "text": m.content,
                    "type": m.message_type,
                    "authorDeviceId": m.author_device_id,
                    "editedAt": m.edited_at_micros.map(|e| e / 1000),
                    "commitSeq": m.commit_seq,
                    "isDeleted": m.is_deleted,
                })
            })
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

#[allow(dead_code)]
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
    let username = username_from_token(&token, &state.app.config.jwt_secret).unwrap_or_default();
    let is_admin = if user_id > 0 {
        state.app.is_admin(user_id).await
    } else {
        false
    };

    if !is_admin {
        let mut allowed = false;
        {
            let session = state.app.session_messages.read().await;
            if let Some(msgs) = session.get(&channel_id) {
                if let Some(m) = msgs.iter().find(|m| m.get("id").and_then(|v| v.as_str()) == Some(message_id.as_str())) {
                    let author = m.get("user").and_then(|v| v.as_str()).unwrap_or("");
                    let author_uid = m.get("userId").and_then(|v| v.as_str()).unwrap_or("");
                    if (!username.is_empty() && author == username)
                        || author_uid == socket.id.to_string()
                        || (user_id > 0 && author_uid == format!("user-{}", user_id))
                    {
                        allowed = true;
                    }
                }
            }
        }
        if !allowed && user_id > 0 {
            match state.app.wdb.get_message_typed(&message_id).await {
                Ok(Some(m)) => {
                    if m.author_user_id == user_id as u64 {
                        allowed = true;
                    } else {
                        let _ = socket.emit("delete-error", &json!({"messageId": message_id, "error": "Cannot delete others' messages"}));
                        return;
                    }
                }
                Ok(None) => {}
                Err(_) => {}
            }
        }
        if !allowed {
            let _ = socket.emit("delete-error", &json!({"messageId": message_id, "error": "Not allowed to delete this message"}));
            return;
        }
    }

    // Remove from session cache (live clients read history from here)
    let mut found_in_session = false;
    {
        let mut session = state.app.session_messages.write().await;
        if let Some(msgs) = session.get_mut(&channel_id) {
            let before = msgs.len();
            msgs.retain(|m| m.get("id").and_then(|v| v.as_str()) != Some(message_id.as_str()));
            found_in_session = msgs.len() < before;
        }
    }

    // Persist deletion to WDB when present
    match state.app.wdb.delete_message(&message_id, user_id as u64).await {
        Ok(()) => {}
        Err(e) => {
            if !found_in_session {
                warn!("Failed to delete message {} (not in session either): {}", message_id, e);
                let _ = socket.emit(
                    "delete-error",
                    &json!({"messageId": message_id, "error": "Message not found"}),
                );
                return;
            }
            warn!(
                "WDB delete miss for {} (session removed): {}",
                message_id, e
            );
        }
    }

    // Acknowledge to sender + broadcast
    let payload = json!({"channelId": channel_id, "messageId": message_id});
    let _ = socket.emit("message-deleted", &payload);
    let _ = io
        .to(channel_id.clone())
        .emit("message-deleted", &payload)
        .await;
}

#[allow(dead_code)]
async fn on_clear_channel_messages(socket: SocketRef, cmd: Value, state: SioState, io: SocketIo) {
    let channel_id = match cmd.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };

    // Never touch DM conversations. DM message stores are keyed by "dm_<a>_<b>"
    // and live in a separate projection; clearing them is out of scope and would
    // silently wipe private conversations.
    if channel_id.starts_with("dm_") {
        let _ = socket.emit(
            "clear-channel-error",
            &json!({ "channelId": channel_id, "error": "Cannot clear messages in a DM conversation" }),
        );
        return;
    }

    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();
    let user_id = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);

    if user_id <= 0 {
        let _ = socket.emit(
            "clear-channel-error",
            &json!({ "channelId": channel_id, "error": "You must be signed in to clear messages" }),
        );
        return;
    }

    let is_owner = state.app.is_owner(user_id).await;
    let is_admin = state.app.is_admin(user_id).await;
    if !(is_owner || is_admin) {
        let _ = socket.emit(
            "clear-channel-error",
            &json!({ "channelId": channel_id, "error": "Only the server owner or an admin can clear messages" }),
        );
        return;
    }

    // Wipe the in-memory live message store for this channel. This is the
    // authoritative store the client reads from (`load-history` / `message`).
    // Local attachment files/blobs are intentionally NOT deleted — only the
    // message records/metadata are removed.
    {
        let mut session = state.app.session_messages.write().await;
        session.remove(&channel_id);
    }

    // Best-effort durable clear (no-op for the in-memory compat store; real
    // engine adapters can implement this against the messages projection).
    let _ = state.app.wdb.clear_channel_messages(&channel_id, user_id as u64).await;

    // Notify the room so every client clears its local view + cache.
    let payload = json!({ "channelId": channel_id });
    let _ = socket.emit("channel-messages-cleared", &payload);
    let _ = io.to(channel_id.clone()).emit("channel-messages-cleared", &payload).await;
}

#[allow(dead_code)]
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
