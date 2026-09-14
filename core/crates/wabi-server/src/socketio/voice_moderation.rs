// Voice moderation is Authority policy. Self mute/deafen remains per-device
// ephemeral state; server mute/deafen is durable WabiDB state. Effective roster
// state is the OR of those two layers, while media backends receive an explicit
// permission refresh for every admitted device.

async fn require_voice_moderator(
    socket: &SocketRef,
    state: &SioState,
    error_event: &str,
) -> Option<i64> {
    let identity = resolve_sio_identity(socket)?;
    let user_id = identity.user_id;
    if user_id <= 0
        || !(state.app.is_admin(user_id).await || state.app.has_role(user_id, "Moderator").await)
    {
        let _ = socket.emit(
            error_event,
            &json!({ "error": "You need at least the Moderator role for voice moderation" }),
        );
        return None;
    }
    Some(user_id)
}

async fn target_voice_participants(
    state: &SioState,
    channel_id: &str,
    stable_id: &str,
) -> Vec<VoiceParticipant> {
    state
        .voice_channels
        .read()
        .await
        .get(channel_id)
        .map(|members| {
            members
                .iter()
                .filter(|participant| participant.stable_id == stable_id)
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

async fn refresh_target_media_permissions(
    state: &SioState,
    channel_id: &str,
    target_user_id: i64,
    participants: &[VoiceParticipant],
    server_muted: bool,
    server_deafened: bool,
) {
    for participant in participants {
        let Some(mut admission) = crate::api::voice_policy::admission_for(
            channel_id,
            target_user_id,
            &participant.socket_id,
        ) else {
            continue;
        };
        admission.server_muted = server_muted;
        admission.server_deafened = server_deafened;
        crate::api::voice_policy::record_admission(admission.clone());
        if let Err(error) = crate::api::media_permissions::refresh_participant_permissions(
            &state.app,
            &admission,
        )
        .await
        {
            warn!(
                "[sio] voice moderation media refresh failed for {} in {}: {}",
                participant.stable_id,
                channel_id,
                error
            );
        }
    }
}

async fn publish_voice_roster(state: &SioState, io: &SocketIo, channel_id: &str) {
    let members: Vec<Value> = state
        .voice_channels
        .read()
        .await
        .get(channel_id)
        .map(|members| members.iter().map(voice_participant_to_view).collect())
        .unwrap_or_default();
    let _ = io
        .emit(
            "voice-channel-state",
            &json!({ "channelId": channel_id, "members": members }),
        )
        .await;
}

#[allow(dead_code)]
async fn on_voice_mute(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let channel_id = match data.get("channelId").and_then(Value::as_str) {
        Some(id) => id.to_string(),
        None => return,
    };
    let target_user_id = match data.get("targetUserId").and_then(Value::as_i64) {
        Some(id) if id > 0 => id,
        _ => {
            let _ = socket.emit("voice-mute-error", &json!({ "error": "Invalid targetUserId" }));
            return;
        }
    };
    let Some(actor_id) = require_voice_moderator(&socket, &state, "voice-mute-error").await else {
        return;
    };

    if let Err(error) = state
        .app
        .wdb
        .mute_user(&channel_id, actor_id as u64, target_user_id as u64, i64::MAX)
        .await
    {
        warn!("[sio] voice-mute failed for {}: {}", target_user_id, error);
        let _ = socket.emit("voice-mute-error", &json!({ "error": "Failed to mute user" }));
        return;
    }

    let stable_id = format!("user-{}", target_user_id);
    let participants = target_voice_participants(&state, &channel_id, &stable_id).await;
    {
        let mut voice = state.voice_channels.write().await;
        if let Some(members) = voice.get_mut(&channel_id) {
            for participant in members.iter_mut().filter(|p| p.stable_id == stable_id) {
                participant.is_muted = true;
            }
        }
    }
    let server_deafened = state
        .app
        .wdb
        .is_user_deafened(&channel_id, target_user_id as u64)
        .await
        .unwrap_or(false);
    refresh_target_media_permissions(
        &state,
        &channel_id,
        target_user_id,
        &participants,
        true,
        server_deafened,
    )
    .await;

    let payload = json!({
        "channelId": channel_id,
        "userId": stable_id,
        "dbUserId": target_user_id,
    });
    let _ = io.emit("voice-user-muted", &payload).await;
    publish_voice_roster(&state, &io, &channel_id).await;
}

#[allow(dead_code)]
async fn on_voice_unmute(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let channel_id = match data.get("channelId").and_then(Value::as_str) {
        Some(id) => id.to_string(),
        None => return,
    };
    let target_user_id = match data.get("targetUserId").and_then(Value::as_i64) {
        Some(id) if id > 0 => id,
        _ => {
            let _ = socket.emit("voice-unmute-error", &json!({ "error": "Invalid targetUserId" }));
            return;
        }
    };
    let Some(actor_id) = require_voice_moderator(&socket, &state, "voice-unmute-error").await else {
        return;
    };

    if let Err(error) = state
        .app
        .wdb
        .unmute_user(&channel_id, actor_id as u64, target_user_id as u64)
        .await
    {
        warn!("[sio] voice-unmute failed for {}: {}", target_user_id, error);
        let _ = socket.emit("voice-unmute-error", &json!({ "error": "Failed to unmute user" }));
        return;
    }

    let stable_id = format!("user-{}", target_user_id);
    let participants = target_voice_participants(&state, &channel_id, &stable_id).await;
    {
        let mut voice = state.voice_channels.write().await;
        if let Some(members) = voice.get_mut(&channel_id) {
            for participant in members.iter_mut().filter(|p| p.stable_id == stable_id) {
                participant.is_muted = crate::api::voice_self_state::get(
                    &channel_id,
                    &participant.socket_id,
                )
                .muted;
            }
        }
    }
    let server_deafened = state
        .app
        .wdb
        .is_user_deafened(&channel_id, target_user_id as u64)
        .await
        .unwrap_or(false);
    refresh_target_media_permissions(
        &state,
        &channel_id,
        target_user_id,
        &participants,
        false,
        server_deafened,
    )
    .await;

    let payload = json!({
        "channelId": channel_id,
        "userId": stable_id,
        "dbUserId": target_user_id,
    });
    let _ = io.emit("voice-user-unmuted", &payload).await;
    publish_voice_roster(&state, &io, &channel_id).await;
}

#[allow(dead_code)]
async fn on_voice_deafen(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let channel_id = match data.get("channelId").and_then(Value::as_str) {
        Some(id) => id.to_string(),
        None => return,
    };
    let target_user_id = match data.get("targetUserId").and_then(Value::as_i64) {
        Some(id) if id > 0 => id,
        _ => {
            let _ = socket.emit("voice-deafen-error", &json!({ "error": "Invalid targetUserId" }));
            return;
        }
    };
    let Some(actor_id) = require_voice_moderator(&socket, &state, "voice-deafen-error").await else {
        return;
    };

    if let Err(error) = state
        .app
        .wdb
        .deafen_user(&channel_id, actor_id as u64, target_user_id as u64)
        .await
    {
        warn!("[sio] voice-deafen failed for {}: {}", target_user_id, error);
        let _ = socket.emit("voice-deafen-error", &json!({ "error": "Failed to deafen user" }));
        return;
    }

    let stable_id = format!("user-{}", target_user_id);
    let participants = target_voice_participants(&state, &channel_id, &stable_id).await;
    {
        let mut voice = state.voice_channels.write().await;
        if let Some(members) = voice.get_mut(&channel_id) {
            for participant in members.iter_mut().filter(|p| p.stable_id == stable_id) {
                participant.is_deafened = true;
            }
        }
    }
    let server_muted = state
        .app
        .wdb
        .is_user_muted(&channel_id, target_user_id as u64)
        .await
        .unwrap_or(false);
    refresh_target_media_permissions(
        &state,
        &channel_id,
        target_user_id,
        &participants,
        server_muted,
        true,
    )
    .await;

    let payload = json!({
        "channelId": channel_id,
        "userId": stable_id,
        "dbUserId": target_user_id,
    });
    let _ = io.emit("voice-user-deafened", &payload).await;
    publish_voice_roster(&state, &io, &channel_id).await;
}

#[allow(dead_code)]
async fn on_voice_undeafen(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let channel_id = match data.get("channelId").and_then(Value::as_str) {
        Some(id) => id.to_string(),
        None => return,
    };
    let target_user_id = match data.get("targetUserId").and_then(Value::as_i64) {
        Some(id) if id > 0 => id,
        _ => {
            let _ = socket.emit("voice-undeafen-error", &json!({ "error": "Invalid targetUserId" }));
            return;
        }
    };
    let Some(actor_id) = require_voice_moderator(&socket, &state, "voice-undeafen-error").await else {
        return;
    };

    if let Err(error) = state
        .app
        .wdb
        .undeafen_user(&channel_id, actor_id as u64, target_user_id as u64)
        .await
    {
        warn!("[sio] voice-undeafen failed for {}: {}", target_user_id, error);
        let _ = socket.emit("voice-undeafen-error", &json!({ "error": "Failed to undeafen user" }));
        return;
    }

    let stable_id = format!("user-{}", target_user_id);
    let participants = target_voice_participants(&state, &channel_id, &stable_id).await;
    {
        let mut voice = state.voice_channels.write().await;
        if let Some(members) = voice.get_mut(&channel_id) {
            for participant in members.iter_mut().filter(|p| p.stable_id == stable_id) {
                participant.is_deafened = crate::api::voice_self_state::get(
                    &channel_id,
                    &participant.socket_id,
                )
                .deafened;
            }
        }
    }
    let server_muted = state
        .app
        .wdb
        .is_user_muted(&channel_id, target_user_id as u64)
        .await
        .unwrap_or(false);
    refresh_target_media_permissions(
        &state,
        &channel_id,
        target_user_id,
        &participants,
        server_muted,
        false,
    )
    .await;

    let payload = json!({
        "channelId": channel_id,
        "userId": stable_id,
        "dbUserId": target_user_id,
    });
    let _ = io.emit("voice-user-undeafened", &payload).await;
    publish_voice_roster(&state, &io, &channel_id).await;
}
