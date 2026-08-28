// WDB-compat shim: this file calls `state.app.wdb.X(...)` for
// methods the WDB doesn't have equivalents for yet
// (is_user_muted, get_channel_retention, mute_user, etc.).
// The compat WdbClient in `db/` returns no-op defaults for all
// of these. When WDB has the corresponding engine methods, this
// file can be migrated to use `state.app.wdb.X(...)` instead.
// The compat shim itself is a temporary layer and will be removed
// once the last socketio file is migrated.

#[allow(dead_code)]
async fn on_voice_channel_join(socket: SocketRef, data: Value, state: SioState, _io: SocketIo) {
    let channel_id = match data.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };

    let identity = resolve_sio_identity(&socket);
    let user_id_num = identity.as_ref().map(|i| i.user_id).unwrap_or(0);

    // Check if user is muted on this voice channel
    if user_id_num > 0 {
        if let Ok(true) = state.app.wdb.is_user_muted(&channel_id, user_id_num as u64).await {
            warn!("[sio] user {} muted in voice channel {}", user_id_num, channel_id);
            warn!("[sio] on_voice_channel_join called: channel_id={}, user_id_num={}", channel_id, user_id_num);
            let _ = socket.emit("voice-channel-error", &json!({ "channelId": channel_id, "error": "You are muted in this channel" }));
            warn!("[sio] on_voice_channel_join: user {} muted, returning", user_id_num);
            return;
        }
    }

	warn!("[sio] on_voice_channel_join called: channel_id={}, user_id_num={}", channel_id, user_id_num);

    let is_deafened = if user_id_num > 0 {
        state.app.wdb.is_user_deafened(&channel_id, user_id_num as u64).await.unwrap_or(false)
    } else {
        false
    };

    let stable_id = if user_id_num > 0 {
        format!("user-{}", user_id_num)
    } else {
        socket.id.to_string()
    };

    let (username, color) = {
    let connected = state.connected_users.read().await;
    match connected.get(&socket.id.to_string()) {
    Some(u) => (u.username.clone(), u.color.clone()),
    // Presence map miss (join race): fall back to the handshake JWT
    // identity rather than broadcasting "unknown".
    None => match resolve_sio_identity(&socket) {
    Some(identity) => (identity.username.clone(), "#98D8C8".to_string()),
    None => ("unknown".to_string(), "#98D8C8".to_string()),
    },
    }
    };

    let profile_picture = if user_id_num > 0 {
        match state.app.wdb.get_user(user_id_num as u64).await {
            Ok(Some(db_user)) => db_user.profile_picture,
            _ => None,
        }
    } else {
        None
    };

    let participant = VoiceParticipant {
        socket_id: socket.id.to_string(),
        stable_id: stable_id.clone(),
        username: username.clone(),
        color: color.clone(),
        is_muted: false,
        is_deafened,
        transmit_mode: "primary".to_string(),
        is_listening_only: false,
        profile_picture,
    };

    let current_members: Vec<Value> = {
        let mut voice = state.voice_channels.write().await;
        let members = voice.entry(channel_id.clone()).or_default();
        members.retain(|p| p.socket_id != socket.id.to_string());
        members.push(participant.clone());
        members.iter().map(voice_participant_to_view).collect()
    };

    let _ = socket.emit(
        "voice-channel-state",
        &json!({
            "channelId": channel_id,
            "members":   current_members,
        }),
    );
    warn!("[sio] emitted voice-channel-state: channel_id={}, member_count={}", channel_id, current_members.len());

    let participant_view = voice_participant_to_view(&participant);

    let _ = socket
        .broadcast()
        .emit(
            "voice-channel-joined",
            &json!({
                "channelId": channel_id,
                "user":      participant_view,
            }),
        )
        .await;

    let _ = socket
        .broadcast()
        .emit(
            "voice-channel-user-joined",
            &json!({
                "channelId": channel_id,
                "userId":    stable_id,
                "socketId":  socket.id.to_string(),
                "username":  username,
            }),
        )
        .await;
}

#[allow(dead_code)]
async fn on_voice_channel_subscribe(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let channel_id = match data.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };

    let identity = resolve_sio_identity(&socket);
    let user_id_num = identity.as_ref().map(|i| i.user_id).unwrap_or(0);

    let stable_id = if user_id_num > 0 {
        format!("user-{}", user_id_num)
    } else {
        socket.id.to_string()
    };

    let (username, color) = {
    let connected = state.connected_users.read().await;
    match connected.get(&socket.id.to_string()) {
    Some(u) => (u.username.clone(), u.color.clone()),
    // Presence map miss (join race): fall back to the handshake JWT
    // identity rather than broadcasting "unknown".
    None => match resolve_sio_identity(&socket) {
    Some(identity) => (identity.username.clone(), "#98D8C8".to_string()),
    None => ("unknown".to_string(), "#98D8C8".to_string()),
    },
    }
    };

    let profile_picture = if user_id_num > 0 {
        match state.app.wdb.get_user(user_id_num as u64).await {
            Ok(Some(db_user)) => db_user.profile_picture,
            _ => None,
        }
    } else {
        None
    };

    let current_members: Vec<Value> = {
        let mut voice = state.voice_channels.write().await;
        let members = voice.entry(channel_id.clone()).or_default();
        // If this socket is already a primary (transmitting) participant in the
        // channel, do NOT demote it to a listen-only participant.
        let already_primary = members
            .iter()
            .any(|p| p.socket_id == socket.id.to_string() && !p.is_listening_only);
        if !already_primary {
            members.retain(|p| p.socket_id != socket.id.to_string());
            members.push(VoiceParticipant {
                socket_id: socket.id.to_string(),
                stable_id: stable_id.clone(),
                username: username.clone(),
                color: color.clone(),
                is_muted: false,
                is_deafened: false,
                transmit_mode: "listening".to_string(),
                is_listening_only: true,
                profile_picture: profile_picture.clone(),
            });
        }
        members.iter().map(voice_participant_to_view).collect()
    };

    // Broadcast the full roster so every client (including the subscriber)
    // sees the updated member list with the listen-only participant.
    let _ = io
        .emit(
            "voice-channel-state",
            &json!({
                "channelId": channel_id,
                "members":   current_members,
            }),
        )
        .await;
}

#[allow(dead_code)]
async fn on_voice_channel_unsubscribe(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let channel_id = match data.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };

    let identity = resolve_sio_identity(&socket);
    let user_id_num = identity.as_ref().map(|i| i.user_id).unwrap_or(0);
    let _stable_id = if user_id_num > 0 {
        format!("user-{}", user_id_num)
    } else {
        socket.id.to_string()
    };

    let removed = {
        let mut voice = state.voice_channels.write().await;
        if let Some(members) = voice.get_mut(&channel_id) {
            // Only remove this socket if it is a listen-only participant. Never
            // kick a primary (transmitting) joiner via an unsubscribe.
            let was_listen_only = members
                .iter()
                .any(|p| p.socket_id == socket.id.to_string() && p.is_listening_only);
            if was_listen_only {
                members.retain(|p| p.socket_id != socket.id.to_string());
                true
            } else {
                false
            }
        } else {
            false
        }
    };

    if removed {
        let members: Vec<Value> = {
            let voice = state.voice_channels.read().await;
            voice
                .get(&channel_id)
                .map(|m| m.iter().map(voice_participant_to_view).collect())
                .unwrap_or_default()
        };
        let _ = io
            .emit(
                "voice-channel-state",
                &json!({
                    "channelId": channel_id,
                    "members":   members,
                }),
            )
            .await;
        // Round 5 hot-mic fix: a listen-only departure must also drop the
        // wabidb media room membership (guarded — a primary member sending a
        // stray unsubscribe keeps its room).
        leave_wabidb_channel_room_if_unrostered(&socket, &state, &channel_id).await;
    }
}

#[allow(dead_code)]
async fn on_voice_channel_leave(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let channel_id = match data.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };

    let identity = resolve_sio_identity(&socket);
    let user_id_num = identity.as_ref().map(|i| i.user_id).unwrap_or(0);
    let stable_id = if user_id_num > 0 {
        format!("user-{}", user_id_num)
    } else {
        socket.id.to_string()
    };

    {
        let mut voice = state.voice_channels.write().await;
        if let Some(members) = voice.get_mut(&channel_id) {
            // Only remove a primary (transmitting) participant on `leave`.
            // A listen-only subscriber must be removed via `unsubscribe`,
            // otherwise an unsubscribe-turned-leave could eject the user
            // from whichever channel it is transmitting on.
            let is_primary = members
                .iter()
                .any(|p| p.socket_id == socket.id.to_string() && !p.is_listening_only);
            if is_primary {
                members.retain(|p| p.socket_id != socket.id.to_string());
            }
        }
    }

    let _ = io
        .emit(
            "voice-channel-left",
            &json!({
                "channelId": channel_id,
                "userId":    stable_id,
            }),
        )
        .await;

    let _ = io
        .emit(
            "voice-channel-user-left",
            &json!({
                "channelId": channel_id,
                "userId":    stable_id,
                "socketId":  socket.id.to_string(),
            }),
        )
        .await;

    // Round 5 hot-mic fix: drop the wabidb media room membership once no
    // roster slot remains — room membership is the relay's only authorization.
    leave_wabidb_channel_room_if_unrostered(&socket, &state, &channel_id).await;
}

#[allow(dead_code)]
async fn on_set_voice_transmit_mode(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let raw_mode = match data.get("mode").and_then(|v| v.as_str()) {
        Some(mode) => mode,
        None => {
            let _ = socket.emit("voice-transmit-mode-error", &json!({ "error": "mode is required" }));
            return;
        }
    };

    let mode = match raw_mode {
        "primary" | "auto" | "push-to-talk" => "primary",
        "all-listening" | "always" => "all-listening",
        _ => {
            let _ = socket.emit("voice-transmit-mode-error", &json!({
                "error": "Unsupported voice transmit mode",
                "mode": raw_mode,
            }));
            return;
        }
    }
    .to_string();

    let identity = resolve_sio_identity(&socket);
    let user_id_num = identity.as_ref().map(|i| i.user_id).unwrap_or(0);
    let stable_id = if user_id_num > 0 {
        format!("user-{}", user_id_num)
    } else {
        socket.id.to_string()
    };

    let updated_channels: Vec<(String, Vec<Value>)> = {
        let mut voice = state.voice_channels.write().await;
        let mut updated = Vec::new();
        for (channel_id, members) in voice.iter_mut() {
            let mut touched = false;
            for participant in members.iter_mut().filter(|p| p.socket_id == socket.id.to_string()) {
                participant.transmit_mode = mode.clone();
                touched = true;
            }
            if touched {
                updated.push((
                    channel_id.clone(),
                    members.iter().map(voice_participant_to_view).collect(),
                ));
            }
        }
        updated
    };

    let payload = json!({
        "userId": stable_id,
        "socketId": socket.id.to_string(),
        "mode": mode,
    });
    let _ = socket.emit("voice-transmit-mode-updated", &payload);
    let _ = io.broadcast().emit("voice-transmit-mode-updated", &payload).await;

    for (channel_id, members) in updated_channels {
        let _ = io
            .emit(
                "voice-channel-state",
                &json!({
                    "channelId": channel_id,
                    "members": members,
                }),
            )
            .await;
    }
}

/// Client-authority self voice state (self-mute/self-deafen chips). The client
/// owns its own mic state; this handler mirrors it into every shared roster so
/// other members' tiles update without a server-side mute model. Mirrors the
/// transmit-mode handler's shape exactly.
#[allow(dead_code)]
async fn on_voice_self_state(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let muted = data.get("muted").and_then(|v| v.as_bool());
    let deafened = data.get("deafened").and_then(|v| v.as_bool());
    if muted.is_none() && deafened.is_none() {
        return;
    }

    let identity = resolve_sio_identity(&socket);
    let user_id_num = identity.as_ref().map(|i| i.user_id).unwrap_or(0);
    let stable_id = if user_id_num > 0 {
        format!("user-{}", user_id_num)
    } else {
        socket.id.to_string()
    };

    let updated_channels: Vec<(String, Vec<Value>)> = {
        let mut voice = state.voice_channels.write().await;
        let mut updated = Vec::new();
        for (channel_id, members) in voice.iter_mut() {
            let mut touched = false;
            for participant in members.iter_mut().filter(|p| p.socket_id == socket.id.to_string()) {
                if let Some(m) = muted {
                    participant.is_muted = m;
                }
                if let Some(d) = deafened {
                    participant.is_deafened = d;
                }
                touched = true;
            }
            if touched {
                updated.push((
                    channel_id.clone(),
                    members.iter().map(voice_participant_to_view).collect(),
                ));
            }
        }
        updated
    };

    for (channel_id, members) in updated_channels {
        let _ = io
            .emit(
                "voice-channel-state",
                &json!({
                    "channelId": channel_id,
                    "members": members,
                }),
            )
            .await;
    }
}

/// Moderator/owner force-removes a member from a voice channel. The kicked
/// client is told to tear down its media session (`voice-self-kicked`), and
/// the roster removal is broadcast like a voluntary leave.
#[allow(dead_code)]
async fn on_voice_channel_kick(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let channel_id = match data.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };
    let target_user_id = match data.get("targetUserId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };

    let identity = resolve_sio_identity(&socket);
    let my_user_id = identity.as_ref().map(|i| i.user_id).unwrap_or(0);
    if my_user_id <= 0 {
        let _ = socket.emit(
            "voice-channel-kick-error",
            &json!({ "error": "Guests cannot kick voice members" }),
        );
        return;
    }

    let can_moderate = state.app.is_admin(my_user_id).await
        || state.app.has_role(my_user_id, "Moderator").await;
    if !can_moderate {
        let _ = socket.emit(
            "voice-channel-kick-error",
            &json!({ "error": "You need at least the Moderator role to kick voice members" }),
        );
        return;
    }

    // Remove every socket of the target user from the channel roster — primary
    // and listen-only members alike.
    let removed: Vec<VoiceParticipant> = {
        let mut voice = state.voice_channels.write().await;
        if let Some(members) = voice.get_mut(&channel_id) {
            let removed: Vec<VoiceParticipant> = members
                .iter()
                .filter(|p| p.stable_id == target_user_id)
                .cloned()
                .collect();
            members.retain(|p| p.stable_id != target_user_id);
            removed
        } else {
            Vec::new()
        }
    };

    if removed.is_empty() {
        return;
    }

    // Tell the kicked client(s) to tear down their media session.
    for p in &removed {
        let _ = io
            .to(p.socket_id.clone())
            .emit(
                "voice-self-kicked",
                &json!({
                    "channelId": channel_id,
                    "userId":    target_user_id,
                }),
            )
            .await;
    }

    // Broadcast the removal like the disconnect cleanup does, then a fresh
    // roster so every client converges.
    for p in &removed {
        let _ = io
            .emit(
                "voice-channel-left",
                &json!({
                    "channelId": channel_id,
                    "userId":    target_user_id,
                }),
            )
            .await;
        let _ = io
            .emit(
                "voice-channel-user-left",
                &json!({
                    "channelId": channel_id,
                    "userId":    target_user_id,
                    "socketId":  p.socket_id,
                }),
            )
            .await;
    }

    let members: Vec<Value> = {
        let voice = state.voice_channels.read().await;
        voice
            .get(&channel_id)
            .map(|m| m.iter().map(voice_participant_to_view).collect())
            .unwrap_or_default()
    };
    let _ = io
        .emit(
            "voice-channel-state",
            &json!({
                "channelId": channel_id,
                "members":   members,
            }),
        )
        .await;
}

// ---------------------------------------------------------------------------
// Call lifecycle handlers
// ---------------------------------------------------------------------------

