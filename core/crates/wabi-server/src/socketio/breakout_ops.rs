// Breakout room backend mutations.
//
// WabiDB has no breakout table yet, so breakout session metadata is kept in a
// simple in-memory HashMap (state.breakout_rooms). The rooms themselves are
// persisted to WabiDB as ordinary voice channels so they survive reconnects;
// their isBreakout / parentChannelId / breakoutIndex metadata is ephemeral and
// rebuilt on each create. The TURN/WebRTC breakout path is intentionally out of
// scope — these handlers only mutate voice-channel + channel state.

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateBreakoutRoomsPayload {
    parent_channel_id: String,
    #[serde(default)]
    room_count: Option<u32>,
    #[serde(default)]
    #[allow(dead_code)]
    auto_assign: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloseBreakoutRoomsPayload {
    parent_channel_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MoveUserToBreakoutPayload {
    parent_channel_id: String,
    target_user_id: String,
    to_channel_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MoveUserToVoiceChannelPayload {
    target_user_id: String,
    to_channel_id: String,
}

fn breakout_room_view(room: &BreakoutRoomState) -> Value {
    json!({
        "id": room.id,
        "name": room.name,
        "parentChannelId": room.parent_channel_id,
        "breakoutIndex": room.breakout_index,
        "type": "voice",
        "isBreakout": true,
    })
}

/// Resolve the acting user's DB id from the socket's JWT (0 for guests).
fn breakout_actor_user_id(socket: &SocketRef, state: &SioState) -> u64 {
    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();
    user_id_from_token(&token, &state.app.config.jwt_secret)
        .unwrap_or(0)
        .max(0) as u64
}

/// Emit a fresh `voice-channel-state` roster for a channel to all clients.
async fn emit_voice_channel_state(state: &SioState, io: &SocketIo, channel_id: &str) {
    let members: Vec<Value> = state
        .voice_channels
        .read()
        .await
        .get(channel_id)
        .map(|m| m.iter().map(voice_participant_to_view).collect())
        .unwrap_or_default();
    let _ = io
        .emit(
            "voice-channel-state",
            &json!({ "channelId": channel_id, "members": members }),
        )
        .await;
}

/// Move a user's primary voice presence into `to_channel_id`, removing them
/// from whatever voice channel they were in. Returns the affected channels
/// with their post-move rosters.
async fn move_voice_participant(
    state: &SioState,
    target_user_id: &str,
    to_channel_id: &str,
) -> Vec<(String, Vec<Value>)> {
    let mut changed: Vec<(String, Vec<Value>)> = Vec::new();
    {
        let mut voice = state.voice_channels.write().await;
        let mut moved: Option<VoiceParticipant> = None;
        let mut source_channels: Vec<String> = Vec::new();
        for (channel_id, members) in voice.iter_mut() {
            if channel_id == to_channel_id {
                continue;
            }
            let before = members.len();
            let mut removed: Option<VoiceParticipant> = None;
            members.retain(|p| {
                if p.stable_id == target_user_id && !p.is_listening_only && removed.is_none() {
                    removed = Some(p.clone());
                    false
                } else {
                    true
                }
            });
            if members.len() != before {
                source_channels.push(channel_id.clone());
            }
            if removed.is_some() && moved.is_none() {
                moved = removed;
            }
        }
        if let Some(p) = moved {
            let entry = voice.entry(to_channel_id.to_string()).or_default();
            entry.retain(|m| m.socket_id != p.socket_id);
            entry.push(p);
        }
        for channel_id in source_channels {
            changed.push((
                channel_id.clone(),
                voice
                    .get(&channel_id)
                    .map(|m| m.iter().map(voice_participant_to_view).collect())
                    .unwrap_or_default(),
            ));
        }
        changed.push((
            to_channel_id.to_string(),
            voice
                .get(to_channel_id)
                .map(|m| m.iter().map(voice_participant_to_view).collect())
                .unwrap_or_default(),
        ));
    }
    changed
}

/// Create N temporary breakout voice channels under a main voice channel.
/// Payload: { parentChannelId, roomCount?, autoAssign? }
#[allow(dead_code)]
async fn on_create_breakout_rooms(socket: SocketRef, data: Value, state: SioState, _io: SocketIo) {
    let payload = match serde_json::from_value::<CreateBreakoutRoomsPayload>(data) {
        Ok(p) => p,
        Err(e) => {
            let _ = socket.emit(
                "breakout-rooms-error",
                &json!({ "error": format!("invalid payload: {e}") }),
            );
            return;
        }
    };

    let parent_channel_id = payload.parent_channel_id;
    let room_count = payload.room_count.unwrap_or(2).clamp(2, 20);

    let parent = match state.app.wdb.get_channel(&parent_channel_id).await {
        Ok(Some(ch)) => ch,
        Ok(None) => {
            let _ = socket.emit(
                "breakout-rooms-error",
                &json!({ "parentChannelId": parent_channel_id, "error": "parent voice channel not found" }),
            );
            return;
        }
        Err(e) => {
            let _ = socket.emit(
                "breakout-rooms-error",
                &json!({ "parentChannelId": parent_channel_id, "error": format!("failed to read parent channel: {e}") }),
            );
            return;
        }
    };
    if !matches!(parent.channel_kind, wabidb::domain::ChannelKind::Voice) {
        let _ = socket.emit(
            "breakout-rooms-error",
            &json!({ "parentChannelId": parent_channel_id, "error": "parent channel is not a voice channel" }),
        );
        return;
    }

    if state.breakout_rooms.read().await.contains_key(&parent_channel_id) {
        let _ = socket.emit(
            "breakout-rooms-error",
            &json!({ "parentChannelId": parent_channel_id, "error": "breakout rooms already exist for this channel" }),
        );
        return;
    }

    let actor = breakout_actor_user_id(&socket, &state);

    let mut created: Vec<BreakoutRoomState> = Vec::new();
    for i in 1..=room_count {
        let name = format!("{} {}", parent.name, i);
        let channel_id =
            match state
                .app
                .wdb
                .create_channel(&name, wabidb::domain::ChannelKind::Voice, actor, false)
                .await
            {
                Ok(id) => id,
                Err(e) => {
                    warn!("[sio] create-breakout-rooms failed to create room {i}: {e}");
                    continue;
                }
            };
        created.push(BreakoutRoomState {
            id: channel_id,
            name,
            parent_channel_id: parent_channel_id.clone(),
            breakout_index: i,
            created_at_micros: now_micros(),
        });
    }

    if created.is_empty() {
        let _ = socket.emit(
            "breakout-rooms-error",
            &json!({ "parentChannelId": parent_channel_id, "error": "failed to create any breakout rooms" }),
        );
        return;
    }

    {
        let mut sessions = state.breakout_rooms.write().await;
        sessions.insert(parent_channel_id.clone(), created.clone());
    }

    let rooms: Vec<Value> = created.iter().map(breakout_room_view).collect();
    let payload = json!({
        "parentChannelId": parent_channel_id,
        "rooms": rooms,
    });
    let _ = socket.emit("breakout-rooms-created", &payload);
    let _ = socket.broadcast().emit("breakout-rooms-created", &payload).await;
}

/// Close all breakouts under a voice channel and return users to main.
/// Payload: { parentChannelId }
#[allow(dead_code)]
async fn on_close_breakout_rooms(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let payload = match serde_json::from_value::<CloseBreakoutRoomsPayload>(data) {
        Ok(p) => p,
        Err(e) => {
            let _ = socket.emit(
                "breakout-rooms-error",
                &json!({ "error": format!("invalid payload: {e}") }),
            );
            return;
        }
    };

    let parent_channel_id = payload.parent_channel_id;

    let rooms = {
        let mut sessions = state.breakout_rooms.write().await;
        sessions.remove(&parent_channel_id).unwrap_or_default()
    };
    if rooms.is_empty() {
        let _ = socket.emit(
            "breakout-rooms-error",
            &json!({ "parentChannelId": parent_channel_id, "error": "no breakout rooms exist for this channel" }),
        );
        return;
    }

    {
        let mut voice = state.voice_channels.write().await;
        for room in &rooms {
            if let Some(members) = voice.remove(&room.id) {
                let parent_members = voice.entry(parent_channel_id.clone()).or_default();
                for p in members {
                    parent_members.retain(|m| m.socket_id != p.socket_id);
                    parent_members.push(p);
                }
            }
        }
    }

    let actor = breakout_actor_user_id(&socket, &state);
    for room in &rooms {
        if let Err(e) = state.app.wdb.delete_channel(&room.id, actor).await {
            warn!("[sio] close-breakout-rooms failed to delete {}: {e}", room.id);
        }
    }

    let closed: Vec<Value> = rooms.iter().map(breakout_room_view).collect();
    let payload = json!({
        "parentChannelId": parent_channel_id,
        "rooms": closed,
    });
    let _ = socket.emit("breakout-rooms-closed", &payload);
    let _ = socket.broadcast().emit("breakout-rooms-closed", &payload).await;

    emit_voice_channel_state(&state, &io, &parent_channel_id).await;
    for room in &rooms {
        emit_voice_channel_state(&state, &io, &room.id).await;
    }
}

/// Move a user from main voice to a breakout room.
/// Payload: { parentChannelId, targetUserId, toChannelId }
#[allow(dead_code)]
async fn on_move_user_to_breakout(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let payload = match serde_json::from_value::<MoveUserToBreakoutPayload>(data) {
        Ok(p) => p,
        Err(e) => {
            let _ = socket.emit(
                "breakout-rooms-error",
                &json!({ "error": format!("invalid payload: {e}") }),
            );
            return;
        }
    };

    let is_breakout = state
        .breakout_rooms
        .read()
        .await
        .get(&payload.parent_channel_id)
        .map(|rooms| rooms.iter().any(|r| r.id == payload.to_channel_id))
        .unwrap_or(false);
    if !is_breakout {
        let _ = socket.emit(
            "breakout-rooms-error",
            &json!({
                "parentChannelId": payload.parent_channel_id,
                "toChannelId": payload.to_channel_id,
                "error": "target is not a breakout room of this channel",
            }),
        );
        return;
    }

    let changed = move_voice_participant(&state, &payload.target_user_id, &payload.to_channel_id).await;

    let _ = socket.emit(
        "breakout-user-moved",
        &json!({
            "parentChannelId": payload.parent_channel_id,
            "targetUserId": payload.target_user_id,
            "toChannelId": payload.to_channel_id,
        }),
    );

    for (channel_id, members) in changed {
        let _ = io
            .emit("voice-channel-state", &json!({ "channelId": channel_id, "members": members }))
            .await;
    }
}

/// Move a user to an arbitrary voice channel (e.g. back to main or another
/// channel). Payload: { targetUserId, toChannelId }
#[allow(dead_code)]
async fn on_move_user_to_voice_channel(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let payload = match serde_json::from_value::<MoveUserToVoiceChannelPayload>(data) {
        Ok(p) => p,
        Err(e) => {
            let _ = socket.emit(
                "move-user-to-voice-channel-error",
                &json!({ "error": format!("invalid payload: {e}") }),
            );
            return;
        }
    };

    let changed = move_voice_participant(&state, &payload.target_user_id, &payload.to_channel_id).await;

    let _ = socket.emit(
        "breakout-user-moved",
        &json!({
            "targetUserId": payload.target_user_id,
            "toChannelId": payload.to_channel_id,
        }),
    );

    for (channel_id, members) in changed {
        let _ = io
            .emit("voice-channel-state", &json!({ "channelId": channel_id, "members": members }))
            .await;
    }
}
