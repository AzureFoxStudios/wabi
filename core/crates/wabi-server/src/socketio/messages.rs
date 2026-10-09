// WDB-compat shim: this file calls `state.app.wdb.X(...)` for
// methods the WDB doesn't have equivalents for yet.

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
        _ => { fail("invalid_request", "rejected", "Choose a channel before sending a message."); return; }
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

    let channel_kind: Option<String> = state.app.wdb.get_channel_kind(&channel_id).await;
    if !matches!(channel_kind.as_deref(), Some("dm" | "group")) && !state.app.is_owner(user_id_num).await {
        match crate::api::server_center::rules_required_for_post(&state.app.config.data_dir, user_id_num) {
            Ok(true) => { fail("rules_ack_required", "rejected", "Read and acknowledge this server's current rules before posting."); return; }
            Ok(false) => {}
            Err(error) => {
                warn!("[rules] could not read rules policy: {error}");
                fail("rules_unavailable", "rejected", "Server rules could not be checked.");
                return;
            }
        }
    }
    let allowed = match channel_kind.as_deref() {
        Some("dm") => can_access_dm(&state, user_id_num, &channel_id).await,
        _ => can_access_channel(&state, user_id_num, &channel_id).await,
    };
    if !allowed {
        warn!("[sio] user {} denied message to channel {}", user_id_num, channel_id);
        fail("access_denied", "rejected", "You do not have access to this channel.");
        return;
    }

    let Some(blacklist) = state.app.get_blacklist().await else {
        fail("authorization_unavailable", "rejected", "Channel restrictions could not be checked.");
        return;
    };
    if blacklist.is_channel_timed_out(&channel_id, user_id_num).await.is_some() {
        fail("timed_out", "rejected", "You are timed out in this channel.");
        return;
    }
    match state.app.wdb.is_user_muted(&channel_id, user_id_num as u64).await {
        Ok(true) => { fail("muted", "rejected", "You are muted in this channel."); return; }
        Ok(false) => {}
        Err(error) => {
            warn!("[sio] could not check message mute: {error}");
            fail("authorization_unavailable", "rejected", "Channel permissions could not be checked. The message was not sent.");
            return;
        }
    }

    // Encryption transitions and durable message writes share one ordering
    // boundary, including the new-room pending state and explicit fallback.
    let retention_guard = state.app.retention_policy_lock.lock().await;
    if let Err(error) = state.app.wdb.require_local_room_owner(&channel_id, "send_message") {
        warn!("[sio] local room write refused: {error}");
        fail("room_not_local", "rejected", "This room is assigned to another node and cannot accept a write here.");
        return;
    }
    // Privacy boundary first. Once a private room is E2EE, plaintext is never
    // accepted as that room's message body. Membership/device changes fail
    // closed until a participant rotates the room key.
    let e2ee = match crate::api::e2ee::validate_outbound_message(
        &state.app, &channel_id, user_id_num, &text,
    ).await {
        Ok(value) => value,
        Err(error) => {
            warn!("[e2ee] rejected message from user {} in {}: {}", user_id_num, channel_id, error);
            fail("e2ee_required", "rejected", &error);
            return;
        }
    };

    let mut safety_flag = None;
    if !e2ee && !state.app.is_owner(user_id_num).await {
        let is_private_conversation = matches!(channel_kind.as_deref(), Some("dm" | "group"));
        let safety_rule = match crate::api::server_center::evaluate_safety_rules(
            &state.app.config.data_dir, &text, is_private_conversation,
        ) {
            Ok(rule) => rule,
            Err(error) => {
                warn!("[safety] policy unreadable; refused message: {error}");
                fail("safety_unavailable", "rejected", "Server safety policy could not be checked.");
                return;
            }
        };
        if let Some(rule) = safety_rule {
            let reason = rule.reason.clone().unwrap_or_else(|| format!("Safety rule: {}", rule.name));
            match &rule.action {
                crate::api::server_center::SafetyAction::Flag => {
                    safety_flag = Some(rule.clone());
                }
                crate::api::server_center::SafetyAction::Delete => {
                    fail("safety_rule", "rejected", &format!("Message blocked by server safety rule: {}", rule.name));
                    return;
                }
                crate::api::server_center::SafetyAction::Warn => { fail("safety_warning", "rejected", &reason); return; }
                crate::api::server_center::SafetyAction::Timeout => {
                    let minutes = rule.timeout_minutes.unwrap_or(10).max(1) as i64;
                    let expires_at = (chrono::Utc::now().timestamp() as u64).saturating_add((minutes as u64).saturating_mul(60));
                    match blacklist.restrict_channel(&channel_id, user_id_num, &reason, Some(expires_at)).await {
                        Ok(()) => fail("safety_timeout", "rejected", &format!("Timed out for {minutes} minute(s): {reason}")),
                        Err(error) => {
                            warn!("[safety] timeout rule '{}' failed to mute user {}: {}", rule.name, user_id_num, error);
                            fail("safety_rule_failed", "rejected", "A server safety rule matched, but its action could not be completed.");
                        }
                    }
                    return;
                }
                crate::api::server_center::SafetyAction::Ban => {
                    match blacklist.restrict_channel(&channel_id, user_id_num, &reason, None).await {
                        Ok(()) => { evict_channel_user(&io, &state.app, &channel_id, user_id_num).await; fail("safety_ban", "rejected", &format!("Banned from this channel: {reason}")); },
                        Err(error) => {
                            warn!("[safety] ban rule '{}' failed to ban user {}: {}", rule.name, user_id_num, error);
                            fail("safety_rule_failed", "rejected", "A server safety rule matched, but its action could not be completed.");
                        }
                    }
                    return;
                }
            }
        }
    }

    let stable_id = format!("user-{}", user_id_num);
    let color = {
        let connected = state.connected_users.read().await;
        connected.get(&socket.id.to_string()).map(|u| u.color.clone()).unwrap_or_else(|| "#98D8C8".to_string())
    };
    // Do not acquire before the safety-ban path, which evicts under this gate.
    // Recheck current access after waiting and retain it through publication.
    let _channel = crate::channel_access::publication_gate(&state.app, &channel_id).lock().await;
    if require_socket_channel(&socket, &state, &channel_id, "message-error").await.is_none() { return; }
    let message_id;
    // Policy transitions and message commits share one ordering boundary.
    // Otherwise a message can select an old mode but land in a new epoch.
    let timestamp = now_ms();
    let is_live = channel_is_live(&state.app, &channel_id).await;
    let requested_spoiler = cmd.get("isSpoiler").and_then(|v| v.as_bool()).unwrap_or(false);
    let channel_force_spoiler = state.app.wdb.get_channel(&channel_id).await.ok().flatten().map(|c| c.force_spoiler).unwrap_or(false);
    let is_spoiler = if e2ee { false } else { requested_spoiler || channel_force_spoiler };

    let mut files: Vec<wabidb::projections::messages::FileAttachmentRecord> = cmd
        .get("files").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default();
    if files.is_empty() {
        if let (Some(url), Some(name)) = (
            cmd.get("fileUrl").and_then(|v| v.as_str()), cmd.get("fileName").and_then(|v| v.as_str()),
        ) {
            files.push(wabidb::projections::messages::FileAttachmentRecord {
                file_url: url.to_string(), file_name: name.to_string(),
                file_size: cmd.get("fileSize").and_then(|v| v.as_u64()).unwrap_or(0),
            });
        }
    }
    if e2ee {
        for file in &mut files {
            file.file_name = "encrypted.bin".into();
            file.file_size = 0;
        }
    }

    if is_live {
        message_id = format!("live_{}", uuid::Uuid::new_v4());
    } else {
        match state.app.wdb.send_message(&channel_id, user_id_num as u64, &text, is_spoiler, &files).await {
            Ok(wdb_id) => message_id = wdb_id,
            Err(wabidb::error::WabiError::Validation { command, .. })
                if command == "room_owner_precondition" => {
                    fail("room_not_local", "rejected", "This room changed owners before the message could be saved. Reconnect and try again.");
                    return;
                }
            Err(e) => {
                warn!("Failed to persist message to WDB: {}", e);
                fail("persistence_unconfirmed", "unknown", "Delivery could not be confirmed. Check history before sending again.");
                return;
            }
        }
    }

    if !e2ee && user_id_num > 0 {
        crate::bot_delivery::spawn_message_created_delivery(
            state.app.wdb.clone(), channel_id.clone(), crate::bot_delivery::MessageCreatedPayload {
                channel_id: channel_id.clone(), message_id: message_id.clone(), content: text.clone(),
                author: username.clone(), timestamp,
            },
        );
    }

    let persisted_files = files.iter().map(|f| json!({
        "fileUrl": f.file_url, "fileName": f.file_name, "fileSize": f.file_size,
    })).collect::<Vec<_>>();
    let message_view = if e2ee {
        json!({
            "id": message_id.clone(), "user": username, "userId": stable_id.clone(), "senderStableId": stable_id,
            "color": color, "text": text, "timestamp": timestamp, "bornAt": timestamp, "type": "text",
            "clientMessageId": client_message_id.clone(), "encrypted": true, "isSpoiler": false,
            "files": persisted_files,
        })
    } else {
        json!({
            "id": message_id.clone(), "user": username, "userId": stable_id.clone(), "senderStableId": stable_id,
            "color": color, "text": text, "timestamp": timestamp, "bornAt": timestamp,
            "type": cmd.get("type").and_then(|v| v.as_str()).unwrap_or("text"),
            "clientMessageId": client_message_id.clone(), "encrypted": cmd.get("encrypted"), "iv": cmd.get("iv"),
            "isSpoiler": is_spoiler, "replyTo": cmd.get("replyTo"), "gifUrl": cmd.get("gifUrl"),
            "emojiUrl": cmd.get("emojiUrl"), "emojiName": cmd.get("emojiName"), "fileUrl": cmd.get("fileUrl"),
            "fileName": cmd.get("fileName"), "fileSize": cmd.get("fileSize"), "files": cmd.get("files"),
            "attachmentEncryption": cmd.get("attachmentEncryption"), "attachmentStorage": cmd.get("attachmentStorage"),
            "entities": cmd.get("entities"),
        })
    };

    {
        let mut session = state.app.session_messages.write().await;
        let msgs = session.entry(channel_id.clone()).or_default();
        let cap = if is_live { state.app.live_channel_cap.read().await.get(&channel_id).copied().unwrap_or(1000) } else { 1000 };
        if msgs.len() >= cap as usize { msgs.drain(0..msgs.len() - (cap as usize).saturating_sub(1)); }
        msgs.push(message_view.clone());
    }
    drop(retention_guard);

    if let Some(rule) = safety_flag {
        if let Err(error) = crate::api::server_center::record_safety_flag(&state.app, &channel_id, &message_id, user_id_num, &username, &rule).await {
            warn!("[safety] message {} saved but flag case could not be recorded: {}", message_id, error);
            fail("safety_flag_unconfirmed", "unknown", &format!("Message {message_id} may be saved, but its safety flag could not be recorded. Check history before retrying."));
            return;
        }
    }

    let _ = socket.emit("message-accepted", &json!({
        "channelId": channel_id, "messageId": message_id, "clientMessageId": client_message_id, "timestamp": timestamp,
    }));
    let payload = json!({ "channelId": &channel_id, "message": message_view });
    if channel_kind.as_deref() == Some("dm") {
        // Route by current account membership so the recipient's other tabs
        // and newly connected devices receive a DM even before opening it.
        // Do not also emit to the channel room: that duplicates each message.
        match state.app.wdb.list_channel_members(&channel_id).await {
            Ok(members) => {
                // Wake the other members' devices (browser push / UnifiedPush).
                // Payload carries only the sender and conversation, never the
                // text, and honours each account's push preferences.
                if !e2ee || user_id_num > 0 {
                    for member in &members {
                        let recipient = member.user_id as i64;
                        if recipient != user_id_num {
                            crate::api::push::spawn_notify(
                                state.app.clone(), recipient,
                                crate::api::push::PushKind::DirectMessage,
                                username.clone(), channel_id.clone(),
                            );
                        }
                    }
                }
                let rooms: Vec<_> = members.into_iter().map(|member| format!("user-{}", member.user_id)).collect();
                if let Err(error) = io.to(rooms).emit("message", &payload).await {
                    warn!("Failed to broadcast DM {}: {}", channel_id, error);
                }
            }
            Err(error) => warn!("Failed to load DM recipients for {}: {}", channel_id, error),
        }
    } else {
        // Everything that is not a DM wakes devices: the per-channel list in
        // settings is the switch, read per recipient inside notify_user, so
        // members who did not switch this channel on never dispatch and the
        // payload still carries no message text. Mentions / followed-channel
        // push remain separate, unwired work.
        if !e2ee || user_id_num > 0 {
            match state.app.wdb.list_channel_members(&channel_id).await {
                Ok(members) => {
                    for member in &members {
                        let recipient = member.user_id as i64;
                        if recipient != user_id_num {
                            crate::api::push::spawn_notify(
                                state.app.clone(), recipient,
                                crate::api::push::PushKind::ChannelMessage,
                                username.clone(), channel_id.clone(),
                            );
                        }
                    }
                }
                Err(error) => warn!("Failed to load channel push recipients for {}: {}", channel_id, error),
            }
        }
        if let Err(error) = io.to(channel_id).emit("message", &payload).await {
            warn!("Failed to broadcast message: {}", error);
        }
    }
}

#[allow(dead_code)]
async fn on_load_history(socket: SocketRef, req: Value, state: SioState) {
    let channel_id = match req.get("channelId").and_then(|v| v.as_str()) { Some(id) => id.to_string(), None => return };
    let Some(identity) = resolve_identity(&socket, &state).await else {
        let _ = socket.emit("history-error", &json!({ "channelId": &channel_id, "error": "authentication required" }));
        return;
    };
    let user_id = identity.user_id;
    let channel_kind: Option<String> = state.app.wdb.get_channel_kind(&channel_id).await;
    let allowed = match channel_kind.as_deref() {
        Some("dm") => can_access_dm(&state, user_id, &channel_id).await,
        _ => can_access_channel(&state, user_id, &channel_id).await,
    };
    if !allowed {
        let _ = socket.emit("history-error", &json!({ "channelId": &channel_id, "error": "access denied" }));
        return;
    }
    let limit = req.get("limit").and_then(|v| v.as_u64()).unwrap_or(50).min(100) as usize;
    let conversation_cursor = if matches!(channel_kind.as_deref(), Some("dm" | "group")) {
        let before = req.get("beforeMessageId").and_then(Value::as_str).filter(|id| !id.is_empty());
        let after = req.get("afterMessageId").and_then(Value::as_str).filter(|id| !id.is_empty());
        if before.is_some() && after.is_some() {
            let _ = socket.emit("history-error", &json!({
                "channelId": &channel_id, "requestId": req.get("requestId"),
                "error": "Choose one history cursor",
            }));
            return;
        }
        Some(match (before, after) {
            (Some(id), _) => wabidb::projections::messages::MessagePageCursor::Before(id),
            (_, Some(id)) => wabidb::projections::messages::MessagePageCursor::After(id),
            _ => wabidb::projections::messages::MessagePageCursor::Latest,
        })
    } else { None };
    let session_msgs: Vec<Value> = {
        let session = state.app.session_messages.read().await;
        session.get(&channel_id).map(|msgs| msgs.iter().rev().take(limit).rev().cloned().collect()).unwrap_or_default()
    };
    let (messages, has_more): (Vec<serde_json::Value>, bool) = if channel_is_live(&state.app, &channel_id).await {
        (session_msgs, false)
    } else {
        // For persisted rooms the durable tail is authoritative. A nonempty
        // session cache can be missing REST sends or older messages, so it
        // must never replace that tail (especially limit:1 DM previews).
        let history = if let Some(cursor) = conversation_cursor {
            state.app.wdb.list_messages_page(&channel_id, cursor, limit).await
        } else {
            state.app.wdb.list_messages_typed(&channel_id, limit as u64).await
                .map(|messages| (messages, false))
        };
        let (typed_msgs, has_more) = match history {
            Ok(page) => page,
            Err(error) => {
                warn!("history read failed for {}: {}", channel_id, error);
                let _ = socket.emit("history-error", &json!({
                    "channelId": &channel_id, "requestId": req.get("requestId"), "error": "History could not be loaded",
                }));
                return;
            }
        };
        let cache_by_id: std::collections::HashMap<String, Value> = session_msgs.into_iter()
            .filter_map(|message| message.get("id").and_then(Value::as_str)
                .map(|id| (id.to_string(), message.clone())))
            .collect();
        let mut name_by_id: std::collections::HashMap<u64, String> = std::collections::HashMap::new();
        let distinct_ids: Vec<u64> = {
            let seen: std::collections::HashSet<u64> = typed_msgs.iter().map(|m| m.author_user_id).collect();
            seen.into_iter().collect()
        };
        for id in distinct_ids {
            if let Ok(Some(u)) = state.app.wdb.get_user(id).await { name_by_id.insert(id, u.username); }
        }
        let messages = typed_msgs.into_iter().map(|m| {
            if let Some(cached) = cache_by_id.get(&m.message_id) { return cached.clone(); }
            let uname = m.author_username.clone().filter(|s| !s.is_empty())
                .or_else(|| name_by_id.get(&m.author_user_id).cloned()).unwrap_or_default();
            let encrypted = crate::api::e2ee::is_ciphertext(&m.content);
            json!({
                "id": m.message_id, "userId": format!("user-{}", m.author_user_id), "user": uname,
                "timestamp": m.created_at_micros / 1000, "text": m.content, "type": m.message_type,
                "authorDeviceId": m.author_device_id, "editedAt": m.edited_at_micros.map(|e| e / 1000),
                "commitSeq": m.commit_seq, "isDeleted": m.is_deleted, "encrypted": encrypted,
                "files": m.files.iter().map(|f| json!({
                    "fileUrl": f.file_url, "fileName": f.file_name, "fileSize": f.file_size,
                })).collect::<Vec<_>>(),
            })
        }).collect();
        (messages, has_more)
    };
    let _ = socket.emit("history-loaded", &json!({
        "channelId": channel_id, "messages": messages, "hasMore": has_more,
        "direction": req.get("direction").unwrap_or(&json!("before")), "requestId": req.get("requestId"),
    }));
}

#[allow(dead_code)]
async fn on_delete_message(socket: SocketRef, cmd: Value, state: SioState, io: SocketIo) {
    let channel_id = match cmd.get("channelId").and_then(|v| v.as_str()) { Some(id) => id.to_string(), None => return };
    let message_id = match cmd.get("messageId").and_then(|v| v.as_str()) { Some(id) => id.to_string(), None => return };
    let Some(identity) = require_socket_channel(&socket, &state, &channel_id, "delete-error").await else { return; };
    if let Err(error) = state.app.wdb.require_local_room_owner(&channel_id, "delete_message") {
        warn!("[sio] local room delete refused: {error}");
        let _ = socket.emit("delete-error", &json!({"messageId": message_id, "code": "room_not_local", "error": "This room cannot be changed through this node."}));
        return;
    }
    if !message_in_channel(&state, &channel_id, &message_id).await {
        let _ = socket.emit("delete-error", &json!({"messageId": message_id, "error": "Message not found in channel"}));
        return;
    }
    let user_id = identity.user_id;
    let username = identity.username;
    let is_private_conversation = matches!(state.app.wdb.get_channel_kind(&channel_id).await.as_deref(), Some("dm" | "group"));
    let can_moderate_messages = if user_id > 0 && !is_private_conversation {
        state.app.is_admin(user_id).await || state.app.has_role(user_id, "Moderator").await
    } else { false };
    if !can_moderate_messages {
        let mut allowed = false;
        {
            let session = state.app.session_messages.read().await;
            if let Some(msgs) = session.get(&channel_id) {
                if let Some(m) = msgs.iter().find(|m| m.get("id").and_then(|v| v.as_str()) == Some(message_id.as_str())) {
                    let author = m.get("user").and_then(|v| v.as_str()).unwrap_or("");
                    let author_uid = m.get("userId").and_then(|v| v.as_str()).unwrap_or("");
                    if (!username.is_empty() && author == username) || author_uid == socket.id.to_string()
                        || (user_id > 0 && author_uid == format!("user-{}", user_id)) { allowed = true; }
                }
            }
        }
        if !allowed && user_id > 0 {
            match state.app.wdb.get_message_typed(&message_id).await {
                Ok(Some(m)) if m.author_user_id == user_id as u64 => allowed = true,
                Ok(Some(_)) => { let _ = socket.emit("delete-error", &json!({"messageId": message_id, "error": "Cannot delete others' messages"})); return; }
                _ => {}
            }
        }
        if !allowed { let _ = socket.emit("delete-error", &json!({"messageId": message_id, "error": "Not allowed to delete this message"})); return; }
    }
    // Live messages are session-only and use the reserved live_ ID prefix.
    // Durable messages must commit their tombstone before any visible removal
    // or success event, even when an in-memory copy is also present.
    if !message_id.starts_with("live_") {
        if let Err(error) = state.app.wdb.delete_message(&message_id, user_id as u64).await {
            warn!("Failed to confirm deletion of message {}: {}", message_id, error);
            let _ = socket.emit("delete-error", &json!({
                "messageId": message_id,
                "code": "persistence_unconfirmed",
                "error": "Deletion could not be confirmed. Check history before retrying."
            }));
            return;
        }
    }
    {
        let mut session = state.app.session_messages.write().await;
        if let Some(msgs) = session.get_mut(&channel_id) {
            msgs.retain(|m| m.get("id").and_then(|v| v.as_str()) != Some(message_id.as_str()));
        }
    }
    let payload = json!({"channelId": channel_id, "messageId": message_id});
    let _ = socket.emit("message-deleted", &payload);
    let _ = io.to(channel_id.clone()).emit("message-deleted", &payload).await;
}

#[allow(dead_code)]
async fn on_clear_channel_messages(socket: SocketRef, cmd: Value, state: SioState, io: SocketIo) {
    let channel_id = match cmd.get("channelId").and_then(|v| v.as_str()) { Some(id) => id.to_string(), None => return };
    let Some(identity) = require_socket_channel(&socket, &state, &channel_id, "clear-channel-error").await else { return; };
    if matches!(state.app.wdb.get_channel_kind(&channel_id).await.as_deref(), Some("dm" | "group")) {
        let _ = socket.emit("clear-channel-error", &json!({ "channelId": channel_id, "error": "Cannot clear messages in a DM conversation" }));
        return;
    }
    let user_id = identity.user_id;
    if user_id <= 0 { let _ = socket.emit("clear-channel-error", &json!({ "channelId": channel_id, "error": "You must be signed in to clear messages" })); return; }
    if !(state.app.is_owner(user_id).await || state.app.is_admin(user_id).await) {
        let _ = socket.emit("clear-channel-error", &json!({ "channelId": channel_id, "error": "Only the server owner or an admin can clear messages" }));
        return;
    }
    // Sends use this same boundary. Only clear the live cache and notify
    // clients after the durable channel tombstone has committed.
    let _retention_guard = state.app.retention_policy_lock.lock().await;
    if let Err(error) = state.app.wdb.clear_channel_messages(&channel_id, user_id as u64).await {
        warn!("Failed to confirm channel message clear for {}: {}", channel_id, error);
        let _ = socket.emit("clear-channel-error", &json!({
            "channelId": channel_id,
            "code": "persistence_unconfirmed",
            "error": "Channel history could not be cleared. Check history before retrying."
        }));
        return;
    }
    state.app.session_messages.write().await.remove(&channel_id);
    let payload = json!({ "channelId": channel_id });
    let _ = socket.emit("channel-messages-cleared", &payload);
    let _ = io.to(channel_id.clone()).emit("channel-messages-cleared", &payload).await;
}

#[allow(dead_code)]
async fn on_typing(socket: SocketRef, data: Value, state: SioState) {
    let channel_id = match data.get("channelId").and_then(|v| v.as_str()) { Some(id) => id.to_string(), None => return };
    let Some(identity) = require_socket_channel(&socket, &state, &channel_id, "typing-error").await else { return; };
    let username = identity.username;
    let _ = socket.broadcast().to(channel_id.clone()).emit("typing", &json!({ "channelId": channel_id, "usernames": [username] })).await;
}
