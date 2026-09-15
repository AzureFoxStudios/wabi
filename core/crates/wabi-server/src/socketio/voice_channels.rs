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

    let epoch = advance_voice_intent(&socket, &channel_id, false);
    let Some(identity) = require_call_channel(&socket, &state, &channel_id,
        wabidb::domain::ChannelKind::Voice, "voice-channel-error", data.get("requestId")).await else { return; };
    let user_id_num = identity.user_id;
    let policy = crate::api::voice_policy::get(&state.app.config.data_dir, &channel_id);
    let forced_listen_only = matches!(policy.entry_mode, crate::api::voice_policy::VoiceEntryMode::ListenOnly);
    let muted_on_entry = matches!(policy.entry_mode, crate::api::voice_policy::VoiceEntryMode::Muted);

    // Server mute is a publication restriction, not an eviction. Keep the
    // participant present so they can hear, see moderation state and later be
    // unmuted without rejoining the room.
    let server_muted = if user_id_num > 0 {
        state.app.wdb.is_user_muted(&channel_id, user_id_num as u64).await.unwrap_or(false)
    } else {
        false
    };
    let server_deafened = if user_id_num > 0 {
        state.app.wdb.is_user_deafened(&channel_id, user_id_num as u64).await.unwrap_or(false)
    } else {
        false
    };

    let stable_id = if user_id_num > 0 {
        format!("user-{}", user_id_num)
    } else {
        socket.id.to_string()
    };
    let socket_id = socket.id.to_string();

    let (username, color) = {
        let connected = state.connected_users.read().await;
        match connected.get(&socket_id) {
            Some(u) => (u.username.clone(), u.color.clone()),
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
        socket_id: socket_id.clone(),
        stable_id: stable_id.clone(),
        username: username.clone(),
        color: color.clone(),
        is_muted: server_muted || muted_on_entry,
        is_deafened: server_deafened,
        transmit_mode: if forced_listen_only { "listening" } else { "primary" }.to_string(),
        is_listening_only: forced_listen_only,
        profile_picture,
    };

    let current_members: Vec<Value> = {
        let mut voice = state.voice_channels.write().await;
        if !voice_intent_current(&socket, &channel_id, false, epoch) { return; }
        let members = voice.entry(channel_id.clone()).or_default();

        // Capacity is an Authority decision. Count stable users under the same
        // roster lock used for insertion so concurrent joins cannot over-admit.
        if let Some(limit) = policy.user_limit {
            let already_present = members.iter().any(|p| p.stable_id == stable_id);
            let unique_count = members
                .iter()
                .map(|p| p.stable_id.as_str())
                .collect::<std::collections::HashSet<_>>()
                .len();
            if !already_present && unique_count >= limit as usize {
                drop(voice);
                let _ = socket.emit("voice-channel-error", &json!({
                    "channelId": channel_id,
                    "requestId": data.get("requestId"),
                    "code": "voice_full",
                    "error": format!("Voice channel is full ({limit}/{limit})"),
                }));
                return;
            }
        }

        members.retain(|p| p.socket_id != socket_id);
        members.push(participant.clone());
        members.iter().map(voice_participant_to_view).collect()
    };

    // Exact-device admission is the bridge from Socket.IO control-plane consent
    // to SFU/relay authorization. HTTP media-token requests must match this
    // user+channel+socket tuple; another tab cannot borrow this permission.
    crate::api::voice_policy::record_admission(&channel_id, crate::api::voice_policy::VoiceAdmission {
        user_id: user_id_num,
        channel_id: channel_id.clone(),
        socket_id: socket_id.clone(),
        listening_only: participant.is_listening_only,
        muted_on_entry,
        server_muted,
        server_deafened,
    });
    crate::api::voice_self_state::set(
        &channel_id,
        &socket_id,
        crate::api::voice_self_state::SelfVoiceState {
            muted: muted_on_entry,
            deafened: false,
        },
    );

    let _ = socket.emit("voice-channel-admitted", &json!({
        "channelId": channel_id,
        "requestId": data.get("requestId"),
        "listeningOnly": participant.is_listening_only,
        "mutedOnEntry": muted_on_entry,
        "serverMuted": server_muted,
        "serverDeafened": server_deafened,
    }));
    let _ = socket.emit(
        "voice-channel-state",
        &json!({
            "channelId": channel_id,
            "members": current_members,
        }),
    );

    let participant_view = voice_participant_to_view(&participant);
    let _ = socket
        .broadcast()
        .emit(
            "voice-channel-joined",
            &json!({
                "channelId": channel_id,
                "user": participant_view,
            }),
        )
        .await;

    let _ = socket
        .broadcast()
        .emit(
            "voice-channel-user-joined",
            &json!({
                "channelId": channel_id,
                "userId": stable_id,
                "socketId": socket_id,
                "username": username,
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

    let epoch = advance_voice_intent(&socket, &channel_id, true);
    let Some(identity) = require_call_channel(&socket, &state, &channel_id,
        wabidb::domain::ChannelKind::Voice, "voice-channel-error", data.get("requestId")).await else { return; };
    let user_id_num = identity.user_id;
    let policy = crate::api::voice_policy::get(&state.app.config.data_dir, &channel_id);

    let stable_id = if user_id_num > 0 {
        format!("user-{}", user_id_num)
    } else {
        socket.id.to_string()
    };
    let socket_id = socket.id.to_string();

    let (username, color) = {
        let connected = state.connected_users.read().await;
        match connected.get(&socket_id) {
            Some(u) => (u.username.clone(), u.color.clone()),
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
    let server_muted = if user_id_num > 0 {
        state.app.wdb.is_user_muted(&channel_id, user_id_num as u64).await.unwrap_or(false)
    } else {
        false
    };
    let server_deafened = if user_id_num > 0 {
        state.app.wdb.is_user_deafened(&channel_id, user_id_num as u64).await.unwrap_or(false)
    } else {
        false
    };

    let mut actual_listening_only = true;
    let current_members: Vec<Value> = {
        let mut voice = state.voice_channels.write().await;
        if !voice_intent_current(&socket, &channel_id, true, epoch) { return; }
        let members = voice.entry(channel_id.clone()).or_default();
        // If this socket is already a primary participant in the channel, a
        // redundant subscribe must not demote its media admission.
        let already_primary = members
            .iter()
            .any(|p| p.socket_id == socket_id && !p.is_listening_only);
        if already_primary {
            actual_listening_only = false;
        } else {
            if let Some(limit) = policy.user_limit {
                let already_present = members.iter().any(|p| p.stable_id == stable_id);
                let unique_count = members
                    .iter()
                    .map(|p| p.stable_id.as_str())
                    .collect::<std::collections::HashSet<_>>()
                    .len();
                if !already_present && unique_count >= limit as usize {
                    drop(voice);
                    let _ = socket.emit("voice-channel-error", &json!({
                        "channelId": channel_id,
                        "requestId": data.get("requestId"),
                        "code": "voice_full",
                        "error": format!("Voice channel is full ({limit}/{limit})"),
                    }));
                    return;
                }
            }
            members.retain(|p| p.socket_id != socket_id);
            members.push(VoiceParticipant {
                socket_id: socket_id.clone(),
                stable_id: stable_id.clone(),
                username: username.clone(),
                color: color.clone(),
                is_muted: server_muted,
                is_deafened: server_deafened,
                transmit_mode: "listening".to_string(),
                is_listening_only: true,
                profile_picture: profile_picture.clone(),
            });
        }
        members.iter().map(voice_participant_to_view).collect()
    };

    // Preserve a primary admission when a legacy/redundant subscribe arrives.
    // Otherwise this is an exact receive-only admission for this socket.
    if actual_listening_only || crate::api::voice_policy::admission_for(&channel_id, user_id_num, &socket_id).is_none() {
        crate::api::voice_policy::record_admission(&channel_id, crate::api::voice_policy::VoiceAdmission {
            user_id: user_id_num,
            channel_id: channel_id.clone(),
            socket_id: socket_id.clone(),
            listening_only: actual_listening_only,
            muted_on_entry: false,
            server_muted,
            server_deafened,
        });
    }
    if actual_listening_only {
        crate::api::voice_self_state::set(
            &channel_id,
            &socket_id,
            crate::api::voice_self_state::SelfVoiceState::default(),
        );
    }

    let _ = socket.emit("voice-channel-admitted", &json!({
        "channelId": channel_id,
        "requestId": data.get("requestId"),
        "listeningOnly": actual_listening_only,
        "serverMuted": server_muted,
        "serverDeafened": server_deafened,
    }));
    let _ = io
        .emit(
            "voice-channel-state",
            &json!({
                "channelId": channel_id,
                "members": current_members,
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

    advance_voice_intent(&socket, &channel_id, true);
    let socket_id = socket.id.to_string();
    let removed = {
        let mut voice = state.voice_channels.write().await;
        if let Some(members) = voice.get_mut(&channel_id) {
            let was_listen_only = members
                .iter()
                .any(|p| p.socket_id == socket_id && p.is_listening_only);
            if was_listen_only {
                members.retain(|p| p.socket_id != socket_id);
                true
            } else {
                false
            }
        } else {
            false
        }
    };

    if removed {
        crate::api::voice_policy::remove_admission(&channel_id, &socket_id);
        crate::api::voice_self_state::remove(&channel_id, &socket_id);
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
                    "members": members,
                }),
            )
            .await;
        leave_wabidb_channel_room_if_unrostered(&socket, &state, &channel_id).await;
    }
}

#[allow(dead_code)]
async fn on_voice_channel_leave(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let channel_id = match data.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };

    advance_voice_intent(&socket, &channel_id, false);
    let identity = resolve_sio_identity(&socket);
    let user_id_num = identity.as_ref().map(|i| i.user_id).unwrap_or(0);
    let stable_id = if user_id_num > 0 {
        format!("user-{}", user_id_num)
    } else {
        socket.id.to_string()
    };
    let socket_id = socket.id.to_string();

    let removed = {
        let mut voice = state.voice_channels.write().await;
        if let Some(members) = voice.get_mut(&channel_id) {
            let is_primary = members
                .iter()
                .any(|p| p.socket_id == socket_id && !p.is_listening_only);
            if is_primary {
                members.retain(|p| p.socket_id != socket_id);
            }
            is_primary
        } else { false }
    };
    if !removed { return; }

    crate::api::voice_policy::remove_admission(&channel_id, &socket_id);
    crate::api::voice_self_state::remove(&channel_id, &socket_id);

    let _ = io
        .emit(
            "voice-channel-left",
            &json!({
                "channelId": channel_id,
                "userId": stable_id,
            }),
        )
        .await;

    let _ = io
        .emit(
            "voice-channel-user-left",
            &json!({
                "channelId": channel_id,
                "userId": stable_id,
                "socketId": socket_id,
            }),
        )
        .await;

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
                // A policy-forced listener stays hard receive-only. Ordinary
                // TeamSpeak-style secondary listeners may still select the
                // existing all-listening transmit mode on transports that
                // support multi-room transmission.
                let policy = crate::api::voice_policy::get(&state.app.config.data_dir, channel_id);
                participant.transmit_mode = if participant.is_listening_only
                    && matches!(policy.entry_mode, crate::api::voice_policy::VoiceEntryMode::ListenOnly)
                {
                    "listening".to_string()
                } else {
                    mode.clone()
                };
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

/// Client-authority self voice state. Durable moderation is deliberately kept
/// separate: a client cannot visually or transport-wise clear a server mute by
/// emitting `muted:false`, and an admin unmute does not erase the user's own
/// self-mute choice.
#[allow(dead_code)]
async fn on_voice_self_state(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let muted = data.get("muted").and_then(|v| v.as_bool());
    let deafened = data.get("deafened").and_then(|v| v.as_bool());
    if muted.is_none() && deafened.is_none() {
        return;
    }

    let identity = resolve_sio_identity(&socket);
    let user_id_num = identity.as_ref().map(|i| i.user_id).unwrap_or(0);
    if user_id_num <= 0 { return; }
    let socket_id = socket.id.to_string();

    let channel_ids: Vec<String> = {
        let voice = state.voice_channels.read().await;
        voice
            .iter()
            .filter(|(_, members)| members.iter().any(|p| p.socket_id == socket_id))
            .map(|(channel_id, _)| channel_id.clone())
            .collect()
    };

    let mut effective: HashMap<String, (bool, bool)> = HashMap::new();
    for channel_id in &channel_ids {
        let self_state = crate::api::voice_self_state::update(
            channel_id,
            &socket_id,
            muted,
            deafened,
        );
        let server_muted = state.app.wdb
            .is_user_muted(channel_id, user_id_num as u64)
            .await
            .unwrap_or(false);
        let server_deafened = state.app.wdb
            .is_user_deafened(channel_id, user_id_num as u64)
            .await
            .unwrap_or(false);
        effective.insert(
            channel_id.clone(),
            (self_state.muted || server_muted, self_state.deafened || server_deafened),
        );
        if let Some(mut admission) = crate::api::voice_policy::admission_for(channel_id, user_id_num, &socket_id) {
            admission.server_muted = server_muted;
            admission.server_deafened = server_deafened;
            crate::api::voice_policy::record_admission(channel_id, admission);
        }
    }

    let updated_channels: Vec<(String, Vec<Value>)> = {
        let mut voice = state.voice_channels.write().await;
        let mut updated = Vec::new();
        for (channel_id, members) in voice.iter_mut() {
            let Some((effective_muted, effective_deafened)) = effective.get(channel_id).copied() else { continue; };
            let mut touched = false;
            for participant in members.iter_mut().filter(|p| p.socket_id == socket_id) {
                participant.is_muted = effective_muted;
                participant.is_deafened = effective_deafened;
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

    let Some(identity) = require_call_channel(&socket, &state, &channel_id,
        wabidb::domain::ChannelKind::Voice, "voice-channel-kick-error", None).await else { return; };
    let my_user_id = identity.user_id;
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

    let removed: Vec<VoiceParticipant> = {
        let mut voice = state.voice_channels.write().await;
        if let Some(members) = voice.get_mut(&channel_id) {
            let removed: Vec<VoiceParticipant> = members
                .iter()
                .filter(|p| p.stable_id == target_user_id)
                .cloned()
                .collect();
            members.retain(|p| p.stable_id != target_user_id);
            for target in io.sockets().into_iter().filter(|s| removed.iter().any(|p| p.socket_id == s.id.to_string())) {
                advance_voice_intent(&target, &channel_id, false);
                advance_voice_intent(&target, &channel_id, true);
                target.leave(format!("wabidb-call-channel:{channel_id}"));
                wabidb_header_cache_forget_session_socket(&format!("channel:{channel_id}"), &target.id.to_string());
            }
            removed
        } else {
            Vec::new()
        }
    };

    if removed.is_empty() {
        return;
    }

    for participant in &removed {
        crate::api::voice_policy::remove_admission(&channel_id, &participant.socket_id);
        crate::api::voice_self_state::remove(&channel_id, &participant.socket_id);
    }

    for target in io.sockets().into_iter().filter(|s| removed.iter().any(|p| p.socket_id == s.id.to_string())) {
        let _ = target.emit(
                "voice-self-kicked",
                &json!({
                    "channelId": channel_id,
                    "userId": target_user_id,
                }),
            );
    }

    for p in &removed {
        let _ = io
            .emit(
                "voice-channel-left",
                &json!({
                    "channelId": channel_id,
                    "userId": target_user_id,
                }),
            )
            .await;
        let _ = io
            .emit(
                "voice-channel-user-left",
                &json!({
                    "channelId": channel_id,
                    "userId": target_user_id,
                    "socketId": p.socket_id,
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
                "members": members,
            }),
        )
        .await;
}

// ---------------------------------------------------------------------------
// Call lifecycle handlers
// ---------------------------------------------------------------------------
