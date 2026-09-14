// Audited facade over the pre-policy signaling implementation.
//
// The legacy implementation remains byte-for-byte in the private module below
// so reactions, recording transparency, screen-share announcements and file
// transfer signaling do not get rewritten as collateral damage. Community
// voice media and SDP take hardened paths here because those are Authority
// security boundaries, not merely client UX conventions.

mod media_reactions_legacy {
    use super::*;
    include!("media_reactions_signaling_legacy.rs");

    pub(super) async fn join_wabidb_call(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
        on_join_wabidb_call(socket, data, state, io).await;
    }
    pub(super) async fn wabidb_media(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
        on_wabidb_media(socket, data, state, io).await;
    }
    pub(super) async fn add_emoji_reaction(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
        on_add_emoji_reaction(socket, data, state, io).await;
    }
    pub(super) async fn remove_emoji_reaction(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
        on_remove_emoji_reaction(socket, data, state, io).await;
    }
    pub(super) async fn call_offer(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
        on_call_offer(socket, data, state, io).await;
    }
    pub(super) async fn start_screen_share(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
        on_start_screen_share(socket, data, state, io).await;
    }
    pub(super) async fn stop_screen_share(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
        on_stop_screen_share(socket, data, state, io).await;
    }
    pub(super) async fn recording_set_active(
        socket: SocketRef, data: Value, state: SioState, io: SocketIo, ack: AckSender,
    ) {
        on_call_recording_set_active(socket, data, state, io, ack).await;
    }
    pub(super) async fn webrtc_offer(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
        on_webrtc_offer(socket, data, state, io).await;
    }
    pub(super) async fn webrtc_answer(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
        on_webrtc_answer(socket, data, state, io).await;
    }
    pub(super) async fn webrtc_ice(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
        on_webrtc_ice_candidate(socket, data, state, io).await;
    }
    pub(super) async fn p2p_offer(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
        on_p2p_offer(socket, data, state, io).await;
    }
    pub(super) async fn p2p_answer(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
        on_p2p_answer(socket, data, state, io).await;
    }
    pub(super) async fn p2p_ice(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
        on_p2p_ice_candidate(socket, data, state, io).await;
    }
    pub(super) fn recording_payload(entry: &RecordingPresenceEntry, active: bool) -> Value {
        recording_presence_payload(entry, active)
    }
    pub(super) async fn recording_departure_rooms(state: &SioState, entry: &RecordingPresenceEntry) -> Vec<String> {
        recording_presence_departure_rooms(state, entry).await
    }
}

#[allow(dead_code)]
async fn on_join_wabidb_call(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    media_reactions_legacy::join_wabidb_call(socket, data, state, io).await;
}

/// Hardened channel relay. DM/group relay behavior remains delegated to the
/// existing implementation because their consent model is not the moderated
/// community-voice model.
#[allow(dead_code)]
async fn on_wabidb_media(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let session_id = match data.get("sessionId").and_then(Value::as_str) {
        Some(id) => id.to_string(),
        None => return,
    };
    let Some(channel_id) = session_id.strip_prefix("channel:").map(str::to_string) else {
        media_reactions_legacy::wabidb_media(socket, data, state, io).await;
        return;
    };

    let Some(identity) = resolve_sio_identity(&socket) else {
        warn!("[sio] wabidb-media from unauthenticated socket {}: dropped", socket.id);
        return;
    };
    let socket_id = socket.id.to_string();
    let room_id = format!("wabidb-call-{session_id}");

    // Durable channel access remains a prerequisite even when a stale roster
    // entry survived a transient bug/restart edge.
    if !matches!(
        crate::channel_access::require_access(&state.app, identity.user_id, &channel_id).await,
        Ok(channel) if channel.channel_kind == wabidb::domain::ChannelKind::Voice
    ) {
        return;
    }

    // Hold the roster read through publish authorization and recipient
    // selection. Moderator mutations take the writer, so a packet cannot race
    // a mute/deafen transition and be authorized from stale state.
    let voice = state.voice_channels.read().await;
    let Some(members) = voice.get(&channel_id) else { return; };
    let Some(sender) = members.iter().find(|p| p.socket_id == socket_id) else { return; };
    if !voice_media_publish_allowed(sender, &data) {
        warn!(
            "[sio] channel media publish denied: channel={} socket={} listening={} muted={} source={:?}",
            channel_id,
            socket_id,
            sender.is_listening_only,
            sender.is_muted,
            classify_voice_media_envelope(&data),
        );
        return;
    }

    // Joining the Socket.IO relay room is a second proof that this exact
    // connection completed media admission, not merely roster admission.
    if !socket.rooms().iter().any(|room| room.as_ref() == room_id.as_str()) {
        warn!("[sio] wabidb-media relay denied: socket {} not in room {}", socket.id, room_id);
        return;
    }
    if !media_rate_allow(&socket_id, json_size_hint(&data)) {
        warn!("[sio] wabidb-media rate limit: dropping envelope from {} ({})", socket.id, room_id);
        return;
    }

    let mut payload = data.clone();
    payload["userId"] = json!(identity.user_id.to_string());
    payload["senderSocket"] = json!(socket_id.clone());

    // Only accepted audio packets enter the late-join Ogg header cache. A
    // muted/listener sender can therefore never poison/revive a stream through
    // cached BOS pages.
    if data.get("kind").and_then(Value::as_str) != Some("video") {
        if let Some(seq) = data.get("seq").and_then(Value::as_u64) {
            let stream = if data.get("source").and_then(Value::as_str) == Some("screen") {
                "screen"
            } else {
                "mic"
            };
            let sender_stream = format!("{}:{}:{stream}", identity.user_id, socket.id);
            wabidb_header_cache_remember(&session_id, &sender_stream, seq, &payload);
        }
    }

    // Deafen is enforced on egress from the Authority: audio is never sent to
    // an effectively deafened receiver. Video stays available by policy.
    let recipient_socket_ids: HashSet<String> = members
        .iter()
        .filter(|participant| participant.socket_id != socket_id)
        .filter(|participant| voice_media_receive_allowed(participant, &data))
        .map(|participant| participant.socket_id.clone())
        .collect();

    for target in io.sockets().into_iter().filter(|candidate| {
        recipient_socket_ids.contains(&candidate.id.to_string())
    }) {
        // A roster member may not have completed relay-room admission yet.
        // Do not send mid-stream media before join-time header replay.
        if target.rooms().iter().any(|room| room.as_ref() == room_id.as_str()) {
            let _ = target.emit("wabidb-media", &payload);
        }
    }
}

#[allow(dead_code)]
async fn on_add_emoji_reaction(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    media_reactions_legacy::add_emoji_reaction(socket, data, state, io).await;
}

#[allow(dead_code)]
async fn on_remove_emoji_reaction(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    media_reactions_legacy::remove_emoji_reaction(socket, data, state, io).await;
}

/// Community voice is an Authority-enforced relay/SFU surface. Direct WebRTC
/// SDP for such channels would let a modified client route around server mute,
/// deafen and listen-only policy. Screen-share *announcements* remain allowed;
/// only direct RTP negotiation is refused here.
async fn channel_direct_webrtc_forbidden(state: &SioState, data: &Value) -> bool {
    let Some(channel_id) = data.get("channelId").and_then(Value::as_str).filter(|id| !id.is_empty()) else {
        return false;
    };
    matches!(
        state.app.wdb.get_channel_kind(channel_id).await.as_deref(),
        Some("voice")
    )
}

#[allow(dead_code)]
async fn on_call_offer(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    if channel_direct_webrtc_forbidden(&state, &data).await {
        warn!("[sio] direct call-offer denied for moderated voice channel {}", data["channelId"]);
        return;
    }
    media_reactions_legacy::call_offer(socket, data, state, io).await;
}

#[allow(dead_code)]
async fn on_start_screen_share(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    media_reactions_legacy::start_screen_share(socket, data, state, io).await;
}

#[allow(dead_code)]
async fn on_stop_screen_share(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    media_reactions_legacy::stop_screen_share(socket, data, state, io).await;
}

#[allow(dead_code)]
async fn on_call_recording_set_active(
    socket: SocketRef, data: Value, state: SioState, io: SocketIo, ack: AckSender,
) {
    media_reactions_legacy::recording_set_active(socket, data, state, io, ack).await;
}

fn recording_presence_payload(entry: &RecordingPresenceEntry, active: bool) -> Value {
    media_reactions_legacy::recording_payload(entry, active)
}

async fn recording_presence_departure_rooms(
    state: &SioState,
    entry: &RecordingPresenceEntry,
) -> Vec<String> {
    media_reactions_legacy::recording_departure_rooms(state, entry).await
}

#[allow(dead_code)]
async fn on_webrtc_offer(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    if channel_direct_webrtc_forbidden(&state, &data).await {
        warn!("[sio] webrtc-offer denied for moderated voice channel {}", data["channelId"]);
        return;
    }
    media_reactions_legacy::webrtc_offer(socket, data, state, io).await;
}

#[allow(dead_code)]
async fn on_webrtc_answer(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    if channel_direct_webrtc_forbidden(&state, &data).await {
        warn!("[sio] webrtc-answer denied for moderated voice channel {}", data["channelId"]);
        return;
    }
    media_reactions_legacy::webrtc_answer(socket, data, state, io).await;
}

#[allow(dead_code)]
async fn on_webrtc_ice_candidate(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    if channel_direct_webrtc_forbidden(&state, &data).await {
        warn!("[sio] webrtc-ice-candidate denied for moderated voice channel {}", data["channelId"]);
        return;
    }
    media_reactions_legacy::webrtc_ice(socket, data, state, io).await;
}

// File-transfer P2P is not call media and remains independent of voice policy.
#[allow(dead_code)]
async fn on_p2p_offer(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    media_reactions_legacy::p2p_offer(socket, data, state, io).await;
}
#[allow(dead_code)]
async fn on_p2p_answer(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    media_reactions_legacy::p2p_answer(socket, data, state, io).await;
}
#[allow(dead_code)]
async fn on_p2p_ice_candidate(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    media_reactions_legacy::p2p_ice(socket, data, state, io).await;
}
