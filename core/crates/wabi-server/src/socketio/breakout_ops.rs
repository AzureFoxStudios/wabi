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

async fn breakout_moderator(socket: &SocketRef, state: &SioState, parent: &str) -> Option<SocketIdentity> {
    let identity = require_call_channel(socket, state, parent,
        wabidb::domain::ChannelKind::Voice, "breakout-rooms-error", None).await?;
    if identity.is_guest || !(state.app.is_admin(identity.user_id).await
        || state.app.has_role(identity.user_id, "Moderator").await) {
        let _ = socket.emit("breakout-rooms-error", &json!({ "error": "You need at least the Moderator role to manage breakout rooms" }));
        return None;
    }
    Some(identity)
}

async fn voice_relocation_allowed(socket: &SocketRef, state: &SioState, actor: &SocketIdentity, target: &str, destination: &str, error_event: &str) -> bool {
    let Some(target_uid) = target.strip_prefix("user-").and_then(|id| id.parse::<i64>().ok())
        .filter(|uid| *uid > 0 && target == format!("user-{uid}")) else { return false; };
    let self_move = target_uid == actor.user_id;
    let can_moderate = !actor.is_guest && (state.app.is_admin(actor.user_id).await
        || state.app.has_role(actor.user_id, "Moderator").await);
    let source_channels: Vec<_> = state.voice_channels.read().await.iter()
        .filter(|(_, members)| members.iter().any(|member| member.stable_id == target && !member.is_listening_only))
        .map(|(id, _)| id.clone()).collect();
    let mut allowed = (self_move || can_moderate)
        && crate::auth_extractor::ensure_active_principal(&state.app, target_uid).await.is_ok()
        && can_access_channel(state, target_uid, destination).await;
    if allowed && !self_move {
        for source in source_channels {
            if !can_access_channel(state, actor.user_id, &source).await { allowed = false; break; }
        }
    }
    if !allowed {
        let _ = socket.emit(error_event, &json!({ "error": "Voice relocation requires current channel access and permission to move this member" }));
    }
    allowed
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

/// A participant relocated by `move_voice_participant`, with the channel they
/// came from. Used to notify the moved user's client so it can re-tune its
/// media session (the server only moves roster state, not media).
struct MovedParticipant {
    participant: VoiceParticipant,
    from_channel_id: String,
}

/// Move a user's primary voice presence into `to_channel_id`, removing them
/// from whatever voice channel they were in. Returns the affected channels
/// with their post-move rosters, plus the moved participant when one was found.
async fn move_voice_participant(
    state: &SioState,
    target_user_id: &str,
    to_channel_id: &str,
) -> (Vec<(String, Vec<Value>)>, Option<MovedParticipant>) {
    let mut changed: Vec<(String, Vec<Value>)> = Vec::new();
    let mut moved_info: Option<MovedParticipant> = None;
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
                moved_info = moved.clone().map(|p| MovedParticipant {
                    participant: p,
                    from_channel_id: channel_id.clone(),
                });
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
    (changed, moved_info)
}

/// Tell the moved user's client to re-tune its media session. The roster move
/// alone leaves the client's wabidb relay on the old channel's session, so
/// without this the audio never follows the user.
async fn emit_voice_self_moved(io: &SocketIo, moved: &MovedParticipant, to_channel_id: &str) {
    if let Some(target) = io.sockets().into_iter().find(|s| s.id.to_string() == moved.participant.socket_id) {
        // The roster was already moved. Revoke the old relay before asking
        // the client to retune, even when the client ignores the notification.
        target.leave(format!("wabidb-call-channel:{}", moved.from_channel_id));
        wabidb_header_cache_forget_session_socket(&format!("channel:{}", moved.from_channel_id), &moved.participant.socket_id);
    }
    let _ = io
        .to(moved.participant.socket_id.clone())
        .emit(
            "voice-self-moved",
            &json!({
                "fromChannelId": moved.from_channel_id,
                "toChannelId": to_channel_id,
            }),
        )
        .await;
}

/// Round-robin `member_count` members across `room_count` rooms; returns the
/// 0-based room index for each member.
fn assign_breakout_round_robin(member_count: usize, room_count: usize) -> Vec<usize> {
    if room_count == 0 {
        return Vec::new();
    }
    (0..member_count).map(|i| i % room_count).collect()
}

/// Merge in-memory breakout metadata onto serialized channel views so clients
/// can group breakout rooms under their parent (the flag is not persisted on
/// the channel record). Covers the init snapshot / reconnects; live marking
/// flows through the `breakout-rooms-created` event.
async fn merge_breakout_flags(state: &SioState, channels: &mut [Value]) {
    let by_id: HashMap<String, (String, u32)> = {
        let breakouts = state.breakout_rooms.read().await;
        let mut by_id = HashMap::new();
        for rooms in breakouts.values() {
            for room in rooms {
                by_id.insert(
                    room.id.clone(),
                    (room.parent_channel_id.clone(), room.breakout_index),
                );
            }
        }
        by_id
    };
    if by_id.is_empty() {
        return;
    }
    for ch in channels.iter_mut() {
        let Some(id) = ch.get("id").and_then(|v| v.as_str()) else {
            continue;
        };
        let Some((parent, index)) = by_id.get(id) else {
            continue;
        };
        ch["isBreakout"] = json!(true);
        ch["parentChannelId"] = json!(parent);
        ch["breakoutIndex"] = json!(index);
    }
}

/// Create N temporary breakout voice channels under a main voice channel.
/// Payload: { parentChannelId, roomCount?, autoAssign? }
#[allow(dead_code)]
async fn on_create_breakout_rooms(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
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
    let Some(identity) = breakout_moderator(&socket, &state, &parent_channel_id).await else { return; };

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

    let actor = identity.user_id as u64;
    let parent_members = match state.app.wdb.list_channel_members(&parent_channel_id).await {
        Ok(members) => members,
        Err(_) => { let _ = socket.emit("breakout-rooms-error", &json!({ "error": "Could not read parent room membership" })); return; }
    };

    let mut created: Vec<BreakoutRoomState> = Vec::new();
    for i in 1..=room_count {
        let name = format!("{} {}", parent.name, i);
        let channel_id =
            match state
                .app
                .wdb
                .create_voice_breakout(&name, &parent_channel_id, actor)
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

    let children: Vec<_> = created.iter().map(|room| room.id.clone()).collect();
    let mut prepared = crate::api::server_center::inherit_channel_gates(&state.app, &parent_channel_id, &children).await.is_ok();
    if prepared {
        for room in &created {
            for member in &parent_members {
                if state.app.wdb.add_channel_member(&room.id, member.user_id, member.role).await.is_err() { prepared = false; break; }
            }
            if !prepared { break; }
        }
    }
    if !prepared {
        for room in &created { let _ = state.app.wdb.delete_channel(&room.id, actor).await; }
        let _ = socket.emit("breakout-rooms-error", &json!({ "error": "Could not initialize breakout access; no rooms were published" }));
        return;
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

    let auto_assign = payload.auto_assign;
    let rooms: Vec<Value> = created.iter().map(breakout_room_view).collect();
    let payload = json!({
        "parentChannelId": parent_channel_id,
        "rooms": rooms,
    });
    let _ = socket.emit("breakout-rooms-created", &payload);
    let _ = socket.broadcast().emit("breakout-rooms-created", &payload).await;

    if auto_assign {
        let primary_members: Vec<String> = state
            .voice_channels
            .read()
            .await
            .get(&parent_channel_id)
            .map(|members| {
                members
                    .iter()
                    .filter(|p| !p.is_listening_only)
                    .map(|p| p.stable_id.clone())
                    .collect()
            })
            .unwrap_or_default();
        let assignments = assign_breakout_round_robin(primary_members.len(), created.len());
        for (member, room_idx) in primary_members.iter().zip(assignments) {
            let Some(room) = created.get(room_idx) else { continue };
            if !voice_relocation_allowed(&socket, &state, &identity, member, &room.id, "breakout-rooms-error").await { continue; }
            let (changed, moved) = move_voice_participant(&state, member, &room.id).await;
            if let Some(m) = &moved {
                emit_voice_self_moved(&io, m, &room.id).await;
            }
            for (channel_id, members) in changed {
                let _ = io
                    .emit("voice-channel-state", &json!({ "channelId": channel_id, "members": members }))
                    .await;
            }
        }
    }
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
    let Some(identity) = breakout_moderator(&socket, &state, &parent_channel_id).await else { return; };

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
        let target_ids: HashSet<_> = state.voice_channels.read().await.iter()
            .filter(|(id, _)| rooms.iter().any(|room| room.id == **id))
            .flat_map(|(_, members)| members.iter().map(|member| member.stable_id.clone())).collect();
        let mut allowed = HashSet::new();
        for target in target_ids {
            let uid = target.strip_prefix("user-").and_then(|id| id.parse::<i64>().ok()).unwrap_or(0);
            if crate::auth_extractor::ensure_active_principal(&state.app, uid).await.is_ok()
                && can_access_channel(&state, uid, &parent_channel_id).await { allowed.insert(target); }
        }
        let mut returned: Vec<(String, VoiceParticipant)> = Vec::new();
        let mut denied: Vec<(String, VoiceParticipant)> = Vec::new();
        {
            let mut voice = state.voice_channels.write().await;
            for room in &rooms {
                if let Some(members) = voice.remove(&room.id) {
                    let parent_members = voice.entry(parent_channel_id.clone()).or_default();
                    for p in members {
                        if !allowed.contains(&p.stable_id) { denied.push((room.id.clone(), p)); continue; }
                        parent_members.retain(|m| m.socket_id != p.socket_id);
                        parent_members.push(p.clone());
                        returned.push((room.id.clone(), p));
                    }
                }
            }
        }
        for (from_channel_id, p) in &returned {
            emit_voice_self_moved(&io, &MovedParticipant { participant: p.clone(), from_channel_id: from_channel_id.clone() }, &parent_channel_id).await;
        }
        for (from_channel_id, participant) in denied {
            if let Some(target) = io.sockets().into_iter().find(|socket| socket.id.to_string() == participant.socket_id) {
                target.leave(format!("wabidb-call-channel:{from_channel_id}"));
                wabidb_header_cache_forget_session_socket(&format!("channel:{from_channel_id}"), &participant.socket_id);
                let _ = target.emit("voice-self-kicked", &json!({ "channelId": from_channel_id }));
            }
        }
    }

    let actor = identity.user_id as u64;
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

    let Some(identity) = require_call_channel(&socket, &state, &payload.parent_channel_id,
        wabidb::domain::ChannelKind::Voice, "breakout-rooms-error", None).await else { return; };

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

    if require_call_channel(&socket, &state, &payload.to_channel_id,
        wabidb::domain::ChannelKind::Voice, "breakout-rooms-error", None).await.is_none() { return; }
    if !voice_relocation_allowed(&socket, &state, &identity, &payload.target_user_id, &payload.to_channel_id, "breakout-rooms-error").await { return; }

    let (changed, moved) =
        move_voice_participant(&state, &payload.target_user_id, &payload.to_channel_id).await;

    if let Some(m) = &moved {
        emit_voice_self_moved(&io, m, &payload.to_channel_id).await;
    }

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

    let Some(identity) = require_call_channel(&socket, &state, &payload.to_channel_id,
        wabidb::domain::ChannelKind::Voice, "move-user-to-voice-channel-error", None).await else { return; };
    if !voice_relocation_allowed(&socket, &state, &identity, &payload.target_user_id, &payload.to_channel_id, "move-user-to-voice-channel-error").await { return; }

    let (changed, moved) =
        move_voice_participant(&state, &payload.target_user_id, &payload.to_channel_id).await;

    if let Some(m) = &moved {
        emit_voice_self_moved(&io, m, &payload.to_channel_id).await;
    }

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

#[cfg(test)]
mod breakout_ops_tests {
    use super::*;

    #[test]
    fn round_robin_distributes_evenly() {
        assert_eq!(assign_breakout_round_robin(6, 3), vec![0, 1, 2, 0, 1, 2]);
    }

    #[test]
    fn round_robin_with_more_rooms_than_members() {
        assert_eq!(assign_breakout_round_robin(2, 4), vec![0, 1]);
    }

    #[test]
    fn round_robin_zero_rooms_yields_empty() {
        assert!(assign_breakout_round_robin(5, 0).is_empty());
    }

    #[test]
    fn round_robin_zero_members_yields_empty() {
        assert!(assign_breakout_round_robin(0, 3).is_empty());
    }
}
