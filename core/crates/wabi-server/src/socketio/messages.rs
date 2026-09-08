// WDB-compat shim: this file calls `state.app.wdb.X(...)` for
// methods the WDB doesn't have equivalents for yet
// (is_user_muted, get_channel_retention, mute_user, etc.).
// The compat WdbClient in `db/` returns no-op defaults for all
// of these. When WDB has the corresponding engine methods, this
// file can be migrated to use `state.app.wdb.X(...)` instead.
// The compat shim itself is a temporary layer and will be removed
// once the last socketio file is migrated.

pub async fn channel_is_live(app: &AppState, channel_id: &str) -> bool {
    app.channel_auto_delete_label
        .read()
        .await
        .get(channel_id)
        .map(|s| s == "live")
        .unwrap_or(false)
}

#[allow(dead_code)]
async fn on_message(socket: SocketRef, cmd: Value, state: SioState, io: SocketIo) {
    // Correlate every outcome before validation/authentication can reject it.
    // Legacy clients may omit the nonce; never manufacture a different one.
    let client_message_id = cmd.get("clientMessageId").and_then(Value::as_str).map(String::from);
    let channel_id = cmd.get("channelId").and_then(Value::as_str).map(String::from);
    let fail = |code: &str, outcome: &str, error: &str| {
        let _ = socket.emit("message-error", &json!({
            "channelId": channel_id, "clientMessageId": client_message_id,
            "code": code, "outcome": outcome, "error": error,
        }));
    };
    let channel_id = match channel_id.as_deref() {
        Some(id) if !id.trim().is_empty() => id.to_string(),
        _ => {
            fail("invalid_request", "rejected", "Choose a channel before sending a message.");
            return;
        }
    };
    if cmd.get("text").is_some_and(|value| !value.is_string())
        || cmd.get("type").is_some_and(|value| !value.is_string())
        || cmd.get("clientMessageId").is_some_and(|value| !value.is_string())
    {
        fail("invalid_request", "rejected", "The message request is invalid.");
        return;
    }
    let text = cmd.get("text").and_then(Value::as_str).unwrap_or("").to_string();
    if cmd.get("type").and_then(Value::as_str).unwrap_or("text") == "text" && text.trim().is_empty() {
        fail("invalid_request", "rejected", "Enter a message before sending.");
        return;
    }

    // Resolve identity — replaces scattered token plumbing.
    let Some(identity) = resolve_identity(&socket, &state).await else {
        fail("authentication_required", "rejected", "Sign in before sending a message.");
        return;
    };
    let user_id_num = identity.user_id;
    let username = identity.username;
    if user_id_num <= 0 {
        fail("authentication_required", "rejected", "Sign in before sending a message.");
        return;
    }

    // Channel access check: DM rooms require can_access_dm, others can_access_channel.
    // Point lookup (t_6bbbc52a): no full channel-table scan per message.
    let channel_kind: Option<String> = state
        .app
        .wdb
        .get_channel_kind(&channel_id)
        .await;
    let allowed = match channel_kind.as_deref() {
        Some("dm") => can_access_dm(&state, user_id_num, &channel_id).await,
        _ => can_access_channel(&state, user_id_num, &channel_id).await,
    };
    if !allowed {
        warn!("[sio] user {} denied message to channel {}", user_id_num, channel_id);
        fail("access_denied", "rejected", "You do not have access to this channel.");
        return;
    }

    // Check if user is muted
    match state.app.wdb.is_user_muted(&channel_id, user_id_num as u64).await {
        Ok(true) => {
            warn!("[sio] user {} muted in channel {}", user_id_num, channel_id);
            fail("muted", "rejected", "You are muted in this channel.");
            return;
        }
        Ok(false) => {}
        Err(error) => {
            warn!("[sio] could not check message mute: {error}");
            fail("authorization_unavailable", "rejected", "Channel permissions could not be checked. The message was not sent.");
            return;
        }
    }
    let stable_id = format!("user-{}", user_id_num);

    let color = {
        let connected = state.connected_users.read().await;
        connected
            .get(&socket.id.to_string())
            .map(|u| u.color.clone())
            .unwrap_or_else(|| "#98D8C8".to_string())
    };

    // Durable messages use only the committed record's ID. There is no
    // session-only fallback for a failed durable write.
    let message_id;
    let timestamp = now_ms();
    let is_live = channel_is_live(&state.app, &channel_id).await;

    let requested_spoiler = cmd
        .get("isSpoiler")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let channel_force_spoiler = state
        .app
        .wdb
        .get_channel(&channel_id)
        .await
        .ok()
        .flatten()
        .map(|c| c.force_spoiler)
        .unwrap_or(false);
    let is_spoiler = requested_spoiler || channel_force_spoiler;

    if is_live {
        message_id = format!("live_{}", uuid::Uuid::new_v4());
    } else {
        let files: Vec<wabidb::projections::messages::FileAttachmentRecord> = cmd
            .get("files")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();
        match state
            .app
            .wdb
            .send_message(&channel_id, user_id_num as u64, &text, is_spoiler, &files)
            .await
        {
            Ok(wdb_id) => {
                message_id = wdb_id;
            }
            Err(e) => {
                warn!("Failed to persist message to WDB: {}", e);
                // A failed acknowledgment can follow durable log writes.
                // Do not claim rejection or invite an unsafe resend.
                fail("persistence_unconfirmed", "unknown", "Delivery could not be confirmed. Check history before sending again.");
                return;
            }
        }
    }
    // The durable retention reaper owns expiry; live messages remain session-only.

    // H1b: fire outbound webhook delivery (`message.created`) to every
    // webhook URL registered on this channel. Fire-and-forget so a slow
    // webhook never blocks the socket handler.
    if user_id_num > 0 {
        crate::bot_delivery::spawn_message_created_delivery(
            state.app.wdb.clone(),
            channel_id.clone(),
            crate::bot_delivery::MessageCreatedPayload {
                channel_id: channel_id.clone(),
                message_id: message_id.clone(),
                content: text.clone(),
                author: username.clone(),
                timestamp,
            },
        );
    }

    let message_view = json!({
        "id":             message_id.clone(),
        "user":           username,
        "userId":         stable_id.clone(),
        "senderStableId": stable_id,
        "color":          color,
        "text":           text,
        "timestamp":      timestamp,
        "bornAt":         timestamp,
        "type":           cmd.get("type").and_then(|v| v.as_str()).unwrap_or("text"),
        "clientMessageId": client_message_id.clone(),
        "encrypted":      cmd.get("encrypted"),
        "iv":             cmd.get("iv"),
        "isSpoiler":      is_spoiler,
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
        let cap = if is_live {
            state
                .app
                .live_channel_cap
                .read()
                .await
                .get(&channel_id)
                .copied()
                .unwrap_or(1000)
        } else {
            1000
        };
        if msgs.len() >= cap as usize {
            msgs.drain(0..msgs.len() - (cap as usize).saturating_sub(1));
        }
        msgs.push(message_view.clone());
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

    // Resolve identity + channel access check.
    let Some(identity) = resolve_identity(&socket, &state).await else {
        let _ = socket.emit("history-error", &json!({ "channelId": &channel_id, "error": "authentication required" }));
        return;
    };
    let user_id = identity.user_id;

    // Point lookup (t_6bbbc52a): no full channel-table scan per history load.
    let channel_kind: Option<String> = state.app.wdb.get_channel_kind(&channel_id).await;
    let allowed = match channel_kind.as_deref() {
        Some("dm") => can_access_dm(&state, user_id, &channel_id).await,
        _ => can_access_channel(&state, user_id, &channel_id).await,
    };
    if !allowed {
        warn!("[sio] user {} denied history for channel {}", user_id, channel_id);
        let _ = socket.emit("history-error", &json!({ "channelId": &channel_id, "error": "access denied" }));
        return;
    }

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
                    "files": m.files.iter().map(|f| json!({
                        "fileUrl": f.file_url,
                        "fileName": f.file_name,
                        "fileSize": f.file_size,
                    })).collect::<Vec<_>>(),
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
    let Some(identity) = require_socket_channel(&socket, &state, &channel_id, "delete-error").await else { return; };
    if !message_in_channel(&state, &channel_id, &message_id).await {
        let _ = socket.emit("delete-error", &json!({"messageId": message_id, "error": "Message not found in channel"}));
        return;
    }
    let user_id = identity.user_id;
    let username = identity.username;
    let is_private_conversation = matches!(state.app.wdb.get_channel_kind(&channel_id).await.as_deref(), Some("dm" | "group"));
    let can_moderate_messages = if user_id > 0 && !is_private_conversation {
        state.app.is_admin(user_id).await || state.app.has_role(user_id, "Moderator").await
    } else {
        false
    };

    if !can_moderate_messages {
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

    let Some(identity) = require_socket_channel(&socket, &state, &channel_id, "clear-channel-error").await else { return; };
    // Private conversations are not server-moderated channels, whatever their ID.
    if matches!(state.app.wdb.get_channel_kind(&channel_id).await.as_deref(), Some("dm" | "group")) {
        let _ = socket.emit(
            "clear-channel-error",
            &json!({ "channelId": channel_id, "error": "Cannot clear messages in a DM conversation" }),
        );
        return;
    }

    let user_id = identity.user_id;

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
    let Some(identity) = require_socket_channel(&socket, &state, &channel_id, "typing-error").await else { return; };
    let username = identity.username;
    let _ = socket
        .broadcast()
        .to(channel_id.clone())
        .emit(
            "typing",
            &json!({ "channelId": channel_id, "usernames": [username] }),
        )
        .await;
}
