// WDB-compat shim: this file calls `state.app.wdb.X(...)` for
// methods the WDB doesn't have equivalents for yet
// (is_user_muted, get_channel_retention, mute_user, etc.).
// The compat WdbClient in `db/` returns no-op defaults for all
// of these. When WDB has the corresponding engine methods, this
// file can be migrated to use `state.app.wdb.X(...)` instead.
// The compat shim itself is a temporary layer and will be removed
// once the last socketio file is migrated.

#[allow(dead_code)]
async fn on_join_wabidb_call(socket: SocketRef, data: Value, state: SioState, _io: SocketIo) {
    let session_id = match data.get("sessionId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };
    let channel_id = data
        .get("channelId")
        .and_then(|v| v.as_str())
        .map(String::from);

    // SEC-1: the room join is authorized against server-side truth — the
    // deterministic session key must match the channel roster (or group call
    // session), or the joining identity must be named in the dm key itself.
    // Guests are rejected: they have no attested id to stamp on envelopes.
    let my_stable = get_my_stable_id(&socket, &state.app.config.jwt_secret);
    let my_socket = socket.id.to_string();
    let verdict = {
        let voice = state.voice_channels.read().await;
        let groups = state.group_call_sessions.read().await;
        authorize_wabidb_session_join(
            &my_stable,
            &my_socket,
            &session_id,
            channel_id.as_deref(),
            &voice,
            &groups,
        )
    };

    match verdict {
        Ok(()) => {
            let room_id = format!("wabidb-call-{}", session_id);
            let _ = socket.join(room_id.clone());
            info!(
                "[sio] Socket {} ({}) joined wabiDB call room {}",
                socket.id, my_stable, room_id
            );
            // Round 6 (2026-09-03): replay the session's cached Ogg header
            // envelopes to this socket. A late joiner (or a reconnector —
            // socket.io rooms do not survive reconnects) never saw the
            // senders' BOS pages and opus-recorder's decoder cannot init from
            // mid-stream pages, so without this every decode throws
            // `decoderBuffer is undefined` and the call is silently deaf.
            for envelope in wabidb_header_cache_snapshot(&session_id) {
                let _ = socket.emit("wabidb-media", &envelope);
            }
        }
        Err(reason) => {
            warn!(
                "[sio] join-wabidb-call DENIED: socket {} ({}): {}",
                socket.id, my_stable, reason
            );
            let _ = socket.emit(
                "wabidb-call-denied",
                &json!({ "sessionId": session_id, "reason": reason }),
            );
        }
    }
}

// ---------------------------------------------------------------------------
// WabiDB media room eviction (2026-08-27 round 5 — hot-mic fix)
// ---------------------------------------------------------------------------

/// Evict the socket from the channel's wabidb media room when it no longer
/// holds ANY roster slot (primary or listen-only) in that channel. Room
/// membership is the relay's ONLY authorization — before this, a departed
/// socket kept both relay rights (a still-emitting client kept streaming its
/// mic to everyone remaining) and every media envelope until it fully
/// disconnected.
async fn leave_wabidb_channel_room_if_unrostered(
    socket: &SocketRef,
    state: &SioState,
    channel_id: &str,
) {
    let still_member = {
        let voice = state.voice_channels.read().await;
        voice
            .get(channel_id)
            .map(|members| members.iter().any(|p| p.socket_id == socket.id.to_string()))
            .unwrap_or(false)
    };
    if !still_member {
        let room = format!("wabidb-call-channel:{}", channel_id);
        let _ = socket.leave(room.clone());
        info!(
            "[sio] Socket {} left wabiDB media room {} (unrostered)",
            socket.id, room
        );
    }
}

/// Mirror of the client's `wabidbDmSessionKey`: ids normalize digits to
/// `user-{n}`, the pair sorts lexicographically, room = `dm:{a}:{b}`.
fn dm_media_room_key(my_id: &str, peer_id: &str) -> String {
    let normalize = |id: &str| -> String {
        let trimmed = id.trim();
        if !trimmed.is_empty() && trimmed.bytes().all(|b| b.is_ascii_digit()) {
            format!("user-{}", trimmed)
        } else {
            trimmed.to_string()
        }
    };
    let a = normalize(my_id);
    let b = normalize(peer_id);
    let (first, second) = if a <= b { (a, b) } else { (b, a) };
    format!("dm:{}:{}", first, second)
}

#[allow(dead_code)]
async fn on_wabidb_media(socket: SocketRef, data: Value, _state: SioState, io: SocketIo) {
    // SEC-1: unauthenticated sockets may not relay media at all.
    let Some(identity) = resolve_sio_identity(&socket) else {
        warn!(
            "[sio] wabidb-media from unauthenticated socket {}: dropped",
            socket.id
        );
        return;
    };
    let session_id = match data.get("sessionId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };

    let room_id = format!("wabidb-call-{}", session_id);
    // Room membership is the authorization proof: only sockets that passed
    // join-wabidb-call's checks for THIS session are in the room.
    if !socket.rooms().iter().any(|r| r.as_ref() == room_id.as_str()) {
        warn!(
            "[sio] wabidb-media relay denied: socket {} not in room {}",
            socket.id, room_id
        );
        return;
    }

    // SEC-1: per-socket token bucket — floods drop instead of fanning out.
    if !media_rate_allow(&socket.id.to_string(), json_size_hint(&data)) {
        warn!(
            "[sio] wabidb-media rate limit: dropping envelope from {} (room {})",
            socket.id, room_id
        );
        return;
    }

    // SEC-1: the envelope's userId is server-attested; the client-supplied
    // value is never trusted for stream attribution.
    let mut payload = data.clone();
    payload["userId"] = json!(identity.user_id.to_string());
    // WO-1c: stamp the sender's socket id so receivers can self-filter by
    // CONNECTION instead of account — same-account multi-device sessions
    // would otherwise drop each other's audio/video as "self-echo".
    payload["senderSocket"] = json!(socket.id.to_string());

    // Round 6: cache header envelopes (audio, seq <= 1) for late-joiner
    // replay — see wabidb_header_cache_remember for the convention.
    if data.get("kind").and_then(|v| v.as_str()) != Some("video") {
        if let Some(seq) = data.get("seq").and_then(|v| v.as_u64()) {
            wabidb_header_cache_remember(&session_id, &identity.user_id.to_string(), seq, &payload);
        }
    }

    // Relay to every authorized participant of this call session (except sender).
    let _ = io
        .to(room_id)
        .except(socket.id.clone())
        .emit("wabidb-media", &payload)
        .await;
}

#[allow(dead_code)]
async fn on_add_emoji_reaction(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let message_id = match data.get("messageId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };
    let channel_id = match data.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };
    let emoji_id = match data.get("emojiId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };

    let identity = resolve_sio_identity(&socket);
    let user_id_num = identity.as_ref().map(|i| i.user_id).unwrap_or(0);

    if user_id_num <= 0 {
        let _ = socket.emit("reaction-error", &json!({ "messageId": message_id, "error": "Guests cannot react" }));
        return;
    }

    // Store the reaction
    if let Err(e) = state.app.wdb.add_reaction(&message_id, user_id_num as u64, &emoji_id).await {
        warn!("[sio] add-emoji-reaction: failed to add reaction: {}", e);
        let _ = socket.emit("reaction-error", &json!({ "messageId": message_id, "error": "Failed to add reaction" }));
        return;
    }

    // Check if there's an emoji role rule for this emoji/message
    if let Ok(rules) = state.app.wdb.get_emoji_role_rules(&message_id).await {
        for rule in rules {
            let rule_emoji = rule.emote.as_str();
            if rule_emoji == emoji_id {
                let role_name = format!("{:?}", rule.role);
                // Assign the role to the user
                let _ = state.app.wdb.ingest_event("rbac", "assign_role", &json!({
                    "userId": user_id_num,
                    "workspaceId": "default-workspace",
                    "role": role_name,
                    "assignedBy": 0,
                })).await;
            }
        }
    }

    // Broadcast reaction to channel
    let _ = io
        .to(channel_id.clone())
        .emit(
            "emoji-reaction-added",
            &json!({
                "channelId": channel_id,
                "messageId": message_id,
                "userId": user_id_num,
                "emojiId": emoji_id,
            }),
        )
        .await;
}

#[allow(dead_code)]
async fn on_remove_emoji_reaction(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let message_id = match data.get("messageId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };
    let channel_id = match data.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };
    let emoji_id = match data.get("emojiId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };

    let identity = resolve_sio_identity(&socket);
    let user_id_num = identity.as_ref().map(|i| i.user_id).unwrap_or(0);

    if user_id_num <= 0 {
        return;
    }

    // Remove the reaction
    if let Err(e) = state.app.wdb.remove_reaction(&message_id, user_id_num as u64, &emoji_id).await {
        warn!("[sio] remove-emoji-reaction: failed to remove reaction: {}", e);
        return;
    }

    // Check if there's an emoji role rule with removeOnUnreact flag
    if let Ok(rules) = state.app.wdb.get_emoji_role_rules(&message_id).await {
        for rule in rules {
            let rule_emoji = rule.emote.as_str();
            if rule_emoji == emoji_id {
                // WDB-compat: removeOnUnreact removed in v1 EmojiRoleRule (no equivalent field). Always treat as true.
                let role_name = format!("{:?}", rule.role);
                // Remove the role from the user
                let _ = state.app.wdb.ingest_event("rbac", "remove_role", &json!({
                    "userId": user_id_num,
                    "workspaceId": "default-workspace",
                    "role": role_name,
                })).await;
            }
        }
    }

    // Broadcast reaction removal to channel
    let _ = io
        .to(channel_id.clone())
        .emit(
            "emoji-reaction-removed",
            &json!({
                "channelId": channel_id,
                "messageId": message_id,
                "userId": user_id_num,
                "emojiId": emoji_id,
            }),
        )
        .await;
}

// ---------------------------------------------------------------------------
// Layer factory
// ---------------------------------------------------------------------------

/// SEC-3: resolve whether `socket` may send peer signaling to `target_id`
/// (a socket id or stable id). Requires a call relationship: shared voice
/// channel, shared group call session, or an active DM call link.
async fn signaling_consent(state: &SioState, socket: &SocketRef, target_id: &str) -> bool {
    let my_stable = get_my_stable_id(socket, &state.app.config.jwt_secret);
    let my_socket = socket.id.to_string();
    let target_stable = {
        let connected = state.connected_users.read().await;
        connected.get(target_id).map(|u| u.stable_id.clone())
    };
    let voice = state.voice_channels.read().await;
    let groups = state.group_call_sessions.read().await;
    signaling_consent_allowed(
        &my_stable,
        &my_socket,
        target_id,
        &voice,
        &groups,
        target_stable.as_deref(),
    )
}

#[allow(dead_code)]
async fn on_call_offer(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let my_stable_id = get_my_stable_id(&socket, &state.app.config.jwt_secret);
    let my_username = {
        let connected = state.connected_users.read().await;
        connected
            .get(&socket.id.to_string())
            .map(|u| u.username.clone())
            .unwrap_or_default()
    };

    let target_id = match data
        .get("targetId")
        .and_then(|v| v.as_str())
        .map(String::from)
    {
        Some(id) => id,
        None => return,
    };
    let offer = match data.get("offer") {
        Some(o) => o.clone(),
        None => return,
    };
    let channel_id_opt = data
        .get("channelId")
        .and_then(|v| v.as_str())
        .map(String::from);

    if let Some(ref channel_id) = channel_id_opt {
        // Point lookup (t_6bbbc52a): no full channel-table scan per signal.
        let ch_type = state
            .app
            .wdb
            .get_channel_kind(channel_id)
            .await
            .unwrap_or_default();

        {
                if ch_type == "voice" {
                    let voice = state.voice_channels.read().await;
                    let members = voice.get(channel_id);
                    let sender_in = members
                        .map(|m| m.iter().any(|p| p.socket_id == socket.id.to_string()))
                        .unwrap_or(false);
                    let target_in = members
                        .map(|m| {
                            m.iter()
                                .any(|p| p.socket_id == target_id || p.stable_id == target_id)
                        })
                        .unwrap_or(false);
                    if !sender_in || !target_in {
                        return;
                    }
                } else if ch_type == "group" {
                    let sessions = state.group_call_sessions.read().await;
                    let session = match sessions.get(channel_id) {
                        Some(s) => s,
                        None => return,
                    };
                    if !session.connected_participants.contains(&my_stable_id)
                        || !session.connected_participants.contains(&target_id)
                    {
                        return;
                    }
                } else {
                    return;
                }
        }
    } else {
        // SEC-3: channel-less offers are direct-call SDP — require an active
        // call relationship instead of blindly routing to any socket.
        if !signaling_consent(&state, &socket, &target_id).await {
            warn!(
                "[sio] call-offer consent denied: socket {} ({}) -> {}",
                socket.id, my_stable_id, target_id
            );
            return;
        }
    }

    let _ = io
        .to(target_id)
        .emit(
            "call-offer",
            &json!({
                "offer":     offer,
                "senderId":  my_stable_id,
                "username":  my_username,
                "channelId": channel_id_opt
            }),
        )
        .await;
}

#[allow(dead_code)]
async fn on_start_screen_share(socket: SocketRef, state: SioState, io: SocketIo) {
    let sender_id = get_my_stable_id(&socket, &state.app.config.jwt_secret);
    // SEC-4: scope to users with a call relationship with the sender — the
    // old global broadcast leaked who is sharing to every connected user.
    let (username, audience) = screen_share_audience(&socket, &state).await;

    let targets: Vec<Value> = audience
        .iter()
        .map(|(stable_id, name)| {
            json!({
                "userId": stable_id,
                "username": name,
            })
        })
        .collect();

    let _ = socket.emit("screen-share-targets", &json!({ "targets": targets }));

    let mut rooms: Vec<String> = audience.iter().map(|(id, _)| id.clone()).collect();
    rooms.push(sender_id.clone());
    let _ = io
        .to(rooms)
        .emit(
            "screen-share-started",
            &json!({
                "senderId": sender_id,
                "userId": sender_id,
                "username": username,
            }),
        )
        .await;
}

#[allow(dead_code)]
async fn on_stop_screen_share(socket: SocketRef, state: SioState, io: SocketIo) {
    let sender_id = get_my_stable_id(&socket, &state.app.config.jwt_secret);
    let (_, audience) = screen_share_audience(&socket, &state).await;

    let mut rooms: Vec<String> = audience.iter().map(|(id, _)| id.clone()).collect();
    rooms.push(sender_id.clone());
    let _ = io
        .to(rooms)
        .emit(
            "screen-share-stopped",
            &json!({
                "senderId": sender_id,
                "userId": sender_id,
            }),
        )
        .await;
}

/// Users the sender may notify about a screen share: everyone sharing a
/// voice channel, group call session, or DM call link with them.
async fn screen_share_audience(
    socket: &SocketRef,
    state: &SioState,
) -> (String, Vec<(String, String)>) {
    let sender_stable = get_my_stable_id(socket, &state.app.config.jwt_secret);
    let my_socket = socket.id.to_string();
    // Snapshot + drop the connected lock BEFORE taking the roster locks —
    // never hold all three read guards across the consent scan (tokio's
    // RwLock is write-preferring; a pending writer on any of them would
    // otherwise park this task while it holds the others).
    let (username, candidates): (String, Vec<(String, String)>) = {
        let connected = state.connected_users.read().await;
        let username = connected
            .get(&my_socket)
            .map(|u| u.username.clone())
            .unwrap_or_default();
        let candidates = connected
            .values()
            .filter(|u| u.stable_id != sender_stable)
            .map(|u| (u.stable_id.clone(), u.username.clone()))
            .collect();
        (username, candidates)
    };
    let voice = state.voice_channels.read().await;
    let groups = state.group_call_sessions.read().await;
    let audience: Vec<(String, String)> = candidates
        .into_iter()
        .filter(|(stable_id, _)| {
            signaling_consent_allowed(
                &sender_stable,
                &my_socket,
                stable_id,
                &voice,
                &groups,
                None,
            )
        })
        .collect();
    (username, audience)
}

// ---------------------------------------------------------------------------
// Call recording presence (2026-08-27 round 5)
// ---------------------------------------------------------------------------

/// `call-recording-set-active` — the transparency half of call recording.
/// The local MediaRecorder runs client-side; this handler records WHO is
/// recording and tells their call audience (`call-recording-presence-changed`)
/// so REC badges are honest on every participant's screen. Guests are
/// rejected: no attested identity to attribute the recording to.
#[allow(dead_code)]
async fn on_call_recording_set_active(
    socket: SocketRef,
    data: Value,
    state: SioState,
    io: SocketIo,
    ack: AckSender,
) {
    let Some(identity) = resolve_sio_identity(&socket) else {
        let _ = ack.send(&json!({"ok": false, "error": "authentication required"}));
        return;
    };
    if identity.user_id <= 0 {
        let _ = ack.send(&json!({"ok": false, "error": "guests cannot record"}));
        return;
    }
    let active = data.get("active").and_then(|v| v.as_bool()).unwrap_or(false);
    let stable_id = format!("user-{}", identity.user_id);

    if !active {
        if let Some(entry) = recording_presence_remove(&socket.id.to_string()) {
            broadcast_recording_presence(&io, &entry, false, Vec::new()).await;
        }
        let _ = ack.send(&json!({"ok": true}));
        return;
    }

    let scope = data
        .get("scope")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let username = {
        let connected = state.connected_users.read().await;
        connected
            .get(&socket.id.to_string())
            .map(|u| u.username.clone())
            .unwrap_or_default()
    };

    // Derive the addressed channels from SERVER truth — a client's channel
    // claims are never trusted for addressing (a forged scope would fake REC
    // badges in arbitrary channels).
    let channel_ids: Vec<String> = match scope.as_str() {
        "direct" => Vec::new(),
        "group" => {
            let group_id = data.get("channelId").and_then(|v| v.as_str()).unwrap_or("");
            let groups = state.group_call_sessions.read().await;
            let is_member = groups
                .get(group_id)
                .map(|s| s.connected_participants.contains(&stable_id))
                .unwrap_or(false);
            drop(groups);
            if !is_member {
                let _ = ack.send(&json!({"ok": false, "error": "not a member of this group call"}));
                return;
            }
            vec![group_id.to_string()]
        }
        "channel" => {
            let voice = state.voice_channels.read().await;
            voice
                .iter()
                .filter(|(_, members)| {
                    members.iter().any(|p| p.socket_id == socket.id.to_string())
                })
                .map(|(channel_id, _)| channel_id.clone())
                .collect()
        }
        _ => {
            let _ = ack.send(&json!({"ok": false, "error": "unknown recording scope"}));
            return;
        }
    };

    let entry = RecordingPresenceEntry {
        stable_id: stable_id.clone(),
        username,
        scope: scope.clone(),
        channel_ids,
    };
    // Scope changes mid-recording first deactivate the previous scope so no
    // stale REC badge survives (e.g. group → channel).
    if let Some(previous) = recording_presence_upsert(&socket.id.to_string(), entry.clone()) {
        if previous.scope != entry.scope || previous.channel_ids != entry.channel_ids {
            broadcast_recording_presence(&io, &previous, false, Vec::new()).await;
        }
    }
    // Audience = everyone sharing a call relationship with the recorder
    // (same consent scan as screen-share notifications) + the recorder's own
    // stable-id room (their other devices stay in sync).
    let (_, audience) = screen_share_audience(&socket, &state).await;
    let extra_rooms = audience.into_iter().map(|(id, _)| id).collect();
    broadcast_recording_presence(&io, &entry, true, extra_rooms).await;
    let _ = ack.send(&json!({"ok": true}));
}

fn recording_presence_payload(entry: &RecordingPresenceEntry, active: bool) -> Value {
    json!({
        "active": active,
        "scope": entry.scope,
        "channelIds": entry.channel_ids,
        "recorder": {
            "userId": entry.stable_id,
            "username": entry.username,
        },
    })
}

/// Fan out one recording-state change. `extra_rooms` carries the
/// consent-scoped audience (live handlers have a socket to scan with);
/// disconnect cleanup passes the departed channels' members instead.
async fn broadcast_recording_presence(
    io: &SocketIo,
    entry: &RecordingPresenceEntry,
    active: bool,
    extra_rooms: Vec<String>,
) {
    let mut rooms = extra_rooms;
    rooms.push(entry.stable_id.clone());
    rooms.sort();
    rooms.dedup();
    let _ = io
        .to(rooms)
        .emit(
            "call-recording-presence-changed",
            &recording_presence_payload(entry, active),
        )
        .await;
}

/// Stable-id rooms to notify about `entry` when the recorder's own socket is
/// already gone (disconnect cleanup): every remaining member of the recorded
/// channels. Live activation/deactivation uses the consent scan instead.
async fn recording_presence_departure_rooms(
    state: &SioState,
    entry: &RecordingPresenceEntry,
) -> Vec<String> {
    let mut rooms: Vec<String> = Vec::new();
    if entry.scope == "channel" || entry.scope == "group" {
        let voice = state.voice_channels.read().await;
        let groups = state.group_call_sessions.read().await;
        for channel_id in &entry.channel_ids {
            if let Some(members) = voice.get(channel_id) {
                for member in members {
                    rooms.push(member.stable_id.clone());
                }
            }
            if let Some(session) = groups.get(channel_id) {
                for stable_id in &session.connected_participants {
                    rooms.push(stable_id.clone());
                }
            }
        }
    }
    rooms.sort();
    rooms.dedup();
    rooms
}

#[allow(dead_code)]
async fn on_webrtc_offer(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let sender_id = get_my_stable_id(&socket, &state.app.config.jwt_secret);
    let username = {
        let connected = state.connected_users.read().await;
        connected
            .get(&socket.id.to_string())
            .map(|u| u.username.clone())
            .unwrap_or_default()
    };

    let target_id = match data.get("targetId").and_then(|v| v.as_str()).map(String::from) {
        Some(id) => id,
        None => return,
    };
    let offer = match data.get("offer") {
        Some(offer) => offer.clone(),
        None => return,
    };

    // SEC-3: unsolicited SDP at arbitrary sockets is refused — the peers
    // must share a call relationship.
    if !signaling_consent(&state, &socket, &target_id).await {
        warn!(
            "[sio] webrtc-offer consent denied: socket {} ({}) -> {}",
            socket.id, sender_id, target_id
        );
        return;
    }

    let _ = io
        .to(target_id)
        .emit(
            "webrtc-offer",
            &json!({
                "offer": offer,
                "senderId": sender_id,
                "username": username,
            }),
        )
        .await;
}

#[allow(dead_code)]
async fn on_webrtc_answer(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let sender_id = get_my_stable_id(&socket, &state.app.config.jwt_secret);
    let target_id = match data.get("targetId").and_then(|v| v.as_str()).map(String::from) {
        Some(id) => id,
        None => return,
    };
    let answer = match data.get("answer") {
        Some(answer) => answer.clone(),
        None => return,
    };

    // SEC-3: answers are only valid within an established call relationship.
    if !signaling_consent(&state, &socket, &target_id).await {
        warn!(
            "[sio] webrtc-answer consent denied: socket {} ({}) -> {}",
            socket.id, sender_id, target_id
        );
        return;
    }

    let _ = io
        .to(target_id)
        .emit(
            "webrtc-answer",
            &json!({
                "answer": answer,
                "senderId": sender_id,
            }),
        )
        .await;
}

#[allow(dead_code)]
async fn on_webrtc_ice_candidate(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let sender_id = get_my_stable_id(&socket, &state.app.config.jwt_secret);
    let target_id = match data.get("targetId").and_then(|v| v.as_str()).map(String::from) {
        Some(id) => id,
        None => return,
    };
    let candidate = match data.get("candidate") {
        Some(candidate) => candidate.clone(),
        None => return,
    };

    // SEC-3: ICE candidates only flow within an established call relationship.
    if !signaling_consent(&state, &socket, &target_id).await {
        warn!(
            "[sio] webrtc-ice-candidate consent denied: socket {} ({}) -> {}",
            socket.id, sender_id, target_id
        );
        return;
    }

    let _ = io
        .to(target_id)
        .emit(
            "webrtc-ice-candidate",
            &json!({
                "candidate": candidate,
                "senderId": sender_id,
            }),
        )
        .await;
}

#[allow(dead_code)]
async fn on_p2p_offer(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let sender_id = get_my_stable_id(&socket, &state.app.config.jwt_secret);
    let username = {
        let connected = state.connected_users.read().await;
        connected
            .get(&socket.id.to_string())
            .map(|u| u.username.clone())
            .unwrap_or_default()
    };

    let transfer_id = match data.get("transferId").and_then(|v| v.as_str()).map(String::from) {
        Some(id) => id,
        None => return,
    };
    let target_id = match data.get("targetId").and_then(|v| v.as_str()).map(String::from) {
        Some(id) => id,
        None => return,
    };
    let offer = match data.get("offer") {
        Some(o) => o.clone(),
        None => return,
    };
    let file_name = data
        .get("fileName")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    let file_size = data
        .get("fileSize")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    let _ = io
        .to(target_id)
        .emit(
            "p2p-offer",
            &json!({
                "transferId": transfer_id,
                "offer": offer,
                "senderId": sender_id,
                "senderUsername": username,
                "fileName": file_name,
                "fileSize": file_size,
            }),
        )
        .await;
}

#[allow(dead_code)]
async fn on_p2p_answer(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let sender_id = get_my_stable_id(&socket, &state.app.config.jwt_secret);
    let transfer_id = match data.get("transferId").and_then(|v| v.as_str()).map(String::from) {
        Some(id) => id,
        None => return,
    };
    let target_id = match data.get("targetId").and_then(|v| v.as_str()).map(String::from) {
        Some(id) => id,
        None => return,
    };
    let answer = match data.get("answer") {
        Some(a) => a.clone(),
        None => return,
    };

    let _ = io
        .to(target_id)
        .emit(
            "p2p-answer",
            &json!({
                "transferId": transfer_id,
                "answer": answer,
                "senderId": sender_id,
            }),
        )
        .await;
}

#[allow(dead_code)]
async fn on_p2p_ice_candidate(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let sender_id = get_my_stable_id(&socket, &state.app.config.jwt_secret);
    let transfer_id = match data.get("transferId").and_then(|v| v.as_str()).map(String::from) {
        Some(id) => id,
        None => return,
    };
    let target_id = match data.get("targetId").and_then(|v| v.as_str()).map(String::from) {
        Some(id) => id,
        None => return,
    };
    let candidate = match data.get("candidate") {
        Some(c) => c.clone(),
        None => return,
    };

    let _ = io
        .to(target_id)
        .emit(
            "p2p-ice-candidate",
            &json!({
                "transferId": transfer_id,
                "candidate": candidate,
                "senderId": sender_id,
            }),
        )
        .await;
}

// ---------------------------------------------------------------------------
// Layer factory
// ---------------------------------------------------------------------------
