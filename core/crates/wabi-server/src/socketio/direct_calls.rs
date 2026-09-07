// WDB-compat shim: this file calls `state.app.wdb.X(...)` for
// methods the WDB doesn't have equivalents for yet
// (is_user_muted, get_channel_retention, mute_user, etc.).
// The compat WdbClient in `db/` returns no-op defaults for all
// of these. When WDB has the corresponding engine methods, this
// file can be migrated to use `state.app.wdb.X(...)` instead.
// The compat shim itself is a temporary layer and will be removed
// once the last socketio file is migrated.

#[allow(dead_code)]
async fn on_call_initiate(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let rejoining = data.get("rejoin").and_then(Value::as_bool) == Some(true);
    let group_intent = data.get("channelId").and_then(Value::as_str)
        .map(|id| advance_voice_intent(&socket, id, false));
    let my_stable_id = get_my_stable_id(&socket, &state.app.config.jwt_secret);
    let my_username = {
        let connected = state.connected_users.read().await;
        connected
            .get(&socket.id.to_string())
            .map(|u| u.username.clone())
            .unwrap_or_default()
    };
    let is_video_call = data
        .get("isVideoCall")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if let Some(channel_id) = data
        .get("channelId")
        .and_then(|v| v.as_str())
        .map(String::from)
    {
        let intent = group_intent.expect("group channel intent");
        if require_call_channel(&socket, &state, &channel_id,
            wabidb::domain::ChannelKind::GroupDm, "call-error", data.get("requestId")).await.is_none() { return; }
        // A reconnect resumes an existing local intent, never a fresh invite.
        // Pin its original membership epoch: offline remove/re-add must require
        // a new user action even if the current init includes the account again.
        if rejoining {
            let revision = group_revision(&state, &channel_id).ok().map(|r| r.to_string());
            if revision.is_none() || data.get("membershipRevision").and_then(Value::as_str) != revision.as_deref() {
                let _ = socket.emit("call-error", &json!({
                    "channelId": channel_id, "requestId": data.get("requestId"),
                    "code": "membership_changed", "message": "Group membership changed while disconnected. Join the call again.",
                }));
                return;
            }
        }
        // Group call — point lookups (t_6bbbc52a): row + members index.
        let channel_opt = state
            .app
            .wdb
            .get_channel_raw(&channel_id)
            .await
            .unwrap_or_default();

        let (channel_name, channel_members) = match channel_opt {
            Some(c) => {
                let name = c
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let members: Vec<String> = state
                    .app
                    .wdb
                    .list_channel_members(&channel_id)
                    .await
                    .unwrap_or_default()
                    .iter()
                    .map(|m| format!("user-{}", m.user_id))
                    .collect();
                (name, members)
            }
            None => {
                let _ = socket.emit(
                    "call-error",
                    &json!({
                        "code": "invalid_channel",
                        "message": "Group channel not found",
                        "channelId": channel_id, "requestId": data.get("requestId"),
                        "targetUserId": channel_id
                    }),
                );
                return;
            }
        };

        if !channel_members.contains(&my_stable_id) {
            let _ = socket.emit(
                "call-error",
                &json!({
                    "code": "not_group_member",
                    "message": "You are not a member of this group",
                    "channelId": channel_id, "requestId": data.get("requestId"),
                    "targetUserId": channel_id
                }),
            );
            return;
        }

        let connected_snapshot: HashMap<String, ConnectedUser> = {
            let connected = state.connected_users.read().await;
            connected.clone()
        };

        let (invitees, existing_connected, is_video, ch_name) = {
            let mut sessions = state.group_call_sessions.write().await;
            if !voice_intent_current(&socket, &channel_id, false, intent) { return; }
            let session = sessions
                .entry(channel_id.clone())
                .or_insert_with(|| GroupCallSession {
                    channel_id: channel_id.clone(),
                    channel_name: channel_name.clone(),
                    initiator_stable_id: my_stable_id.clone(),
                    is_video_call,
                    has_ever_established: rejoining,
                    last_invite_sender_id: socket.id.to_string(),
                    invited_participants: HashSet::new(),
                    connected_participants: GroupCallParticipants::default(),
                });

            session.channel_name = channel_name.clone();
            if session.connected_participants.is_empty() {
                session.initiator_stable_id = my_stable_id.clone();
            }
            if !session.has_ever_established {
                session.is_video_call = is_video_call;
            }

            // Starting an already established group is also an admission.
            // Existing peers must negotiate with this newly consenting member.
            let existing_connected: Vec<String> = session.connected_participants.iter()
                .filter(|id| *id != &my_stable_id).cloned().collect();
            session.invited_participants.remove(&my_stable_id);
            {
                session.connected_participants.join(&my_stable_id, &socket.id.to_string());
                if session.connected_participants.len() > 1 {
                    session.has_ever_established = true;
                }
            }

            let invitees: Vec<String> = if rejoining { Vec::new() } else { channel_members
                    .iter()
                    .filter(|id| {
                        *id != &my_stable_id
                            && !session.connected_participants.contains(*id)
                            && !session.invited_participants.contains(*id)
                            && is_stable_connected(&connected_snapshot, id)
                    })
                    .cloned()
                    .collect() };

            if !rejoining && invitees.is_empty()
                && session.connected_participants.len() == 1
                && session.invited_participants.is_empty()
            {
                sessions.remove(&channel_id);
                drop(sessions);
                let _ = socket.emit(
                    "call-error",
                    &json!({
                        "code": "target_unavailable",
                        "message": "No group members are currently connected",
                        "channelId": channel_id, "requestId": data.get("requestId"),
                        "targetUserId": channel_id
                    }),
                );
                return;
            }

            for id in &invitees {
                session.invited_participants.insert(id.clone());
            }
            if !invitees.is_empty() {
                session.last_invite_sender_id = socket.id.to_string();
            }

            (
                invitees,
                existing_connected,
                session.is_video_call,
                session.channel_name.clone(),
            )
        };

        // Consent exists before capture or relay admission. A local emit (or
        // somebody else's roster notification) is not an acknowledgement.
        let _ = socket.emit("group-call-started", &json!({
            "channelId": channel_id, "requestId": data.get("requestId"),
            "established": !existing_connected.is_empty(),
        }));
        for participant in existing_connected {
            let _ = io.to(participant).emit("group-call-participant-joined", &json!({
                "channelId": channel_id, "channelName": ch_name,
                "userId": my_stable_id, "stableUserId": my_stable_id, "username": my_username,
            })).await;
        }

        for invitee_id in invitees {
            let _ = io
                .to(invitee_id)
                .emit(
                    "call-incoming",
                    &json!({
                        "userId": my_stable_id,
                        "username": my_username,
                        "isVideoCall": is_video,
                        "channelId": channel_id,
                        "channelName": ch_name
                    }),
                )
                .await;
        }
    } else if let Some(target_id) = data
        .get("targetUserId")
        .and_then(|v| v.as_str())
        .map(String::from)
    {
        // DM call
        let is_connected = {
            let connected = state.connected_users.read().await;
            is_stable_connected(&connected, &target_id)
        };

        if !is_connected {
            let _ = socket.emit(
                "call-error",
                &json!({
                    "code": "target_unavailable",
                    "message": "Target user is not currently connected",
                    "targetUserId": target_id
                }),
            );
            return;
        }

        if target_id == my_stable_id {
            let _ = socket.emit(
                "call-error",
                &json!({
                    "code": "self_call",
                    "message": "You cannot call yourself",
                    "targetUserId": target_id
                }),
            );
            return;
        }

        // SEC-3: remember the active DM pair so webrtc/SDP signaling consent
        // checks can validate this relationship until the call ends.
        dm_link_remember(&my_stable_id, &target_id);

        let _ = io
            .to(target_id)
            .emit(
                "call-incoming",
                &json!({
                    "userId": my_stable_id,
                    "username": my_username,
                    "isVideoCall": is_video_call
                }),
            )
            .await;
    }
}

#[allow(dead_code)]
async fn on_call_answer(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let group_intent = data.get("channelId").and_then(Value::as_str)
        .map(|id| advance_voice_intent(&socket, id, false));
    let my_stable_id = get_my_stable_id(&socket, &state.app.config.jwt_secret);
    let my_username = {
        let connected = state.connected_users.read().await;
        connected
            .get(&socket.id.to_string())
            .map(|u| u.username.clone())
            .unwrap_or_default()
    };
    let is_video_call = data
        .get("isVideoCall")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if let Some(channel_id) = data
        .get("channelId")
        .and_then(|v| v.as_str())
        .map(String::from)
    {
        let intent = group_intent.expect("group channel intent");
        if require_call_channel(&socket, &state, &channel_id,
            wabidb::domain::ChannelKind::GroupDm, "call-error", data.get("requestId")).await.is_none() { return; }
        // Group call answer. Current membership authorizes joining an existing
        // group call even without a ringing invite (the UI offers Join call).
        let (existing_connected, ch_name) = {
            let mut sessions = state.group_call_sessions.write().await;
            if !voice_intent_current(&socket, &channel_id, false, intent) { return; }
            let session = match sessions.get_mut(&channel_id) {
                Some(s) => s,
                None => {
                    drop(sessions);
                    let _ = socket.emit(
                        "call-error",
                        &json!({
                            "code": "caller_unavailable",
                            "message": "Group call is no longer available",
                            "channelId": channel_id, "requestId": data.get("requestId"),
                            "targetUserId": channel_id
                        }),
                    );
                    return;
                }
            };

            session.invited_participants.remove(&my_stable_id);
            {
                session.connected_participants.join(&my_stable_id, &socket.id.to_string());
                if session.connected_participants.len() > 1 {
                    session.has_ever_established = true;
                }
            }

            let existing: Vec<String> = session
                .connected_participants
                .iter()
                .filter(|id| *id != &my_stable_id)
                .cloned()
                .collect();
            (existing, session.channel_name.clone())
        };

        let _ = socket.emit("group-call-admitted", &json!({
            "channelId": channel_id, "requestId": data.get("requestId"),
        }));
        for existing_id in existing_connected {
            let _ = io
                .to(existing_id)
                .emit(
                    "group-call-participant-joined",
                    &json!({
                        "channelId": channel_id,
                        "channelName": ch_name,
                        "stableUserId": my_stable_id,
                        "userId": my_stable_id,
                        "username": my_username
                    }),
                )
                .await;
        }
    } else if let Some(caller_id) = data
        .get("callerId")
        .and_then(|v| v.as_str())
        .map(String::from)
    {
        // DM call answer
        let is_connected = {
            let connected = state.connected_users.read().await;
            is_stable_connected(&connected, &caller_id)
        };

        if !is_connected {
            let _ = socket.emit(
                "call-error",
                &json!({
                    "code": "caller_unavailable",
                    "message": "Caller disconnected before the call was answered",
                    "targetUserId": caller_id
                }),
            );
            return;
        }

        // SEC-3: the answer confirms the DM pair — keep the signaling link.
        dm_link_remember(&my_stable_id, &caller_id);

        let _ = io
            .to(caller_id)
            .emit(
                "call-accepted",
                &json!({
                    "userId": my_stable_id,
                    "username": my_username,
                    "isVideoCall": is_video_call
                }),
            )
            .await;
    }
}

#[allow(dead_code)]
async fn on_call_reject(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let my_stable_id = get_my_stable_id(&socket, &state.app.config.jwt_secret);

    if let Some(channel_id) = data
        .get("channelId")
        .and_then(|v| v.as_str())
        .map(String::from)
    {
        // Group call reject
        let (recipients, username) = {
            let mut sessions = state.group_call_sessions.write().await;
            let session = match sessions.get_mut(&channel_id) {
                Some(s) => s,
                None => return,
            };

            if !session.invited_participants.remove(&my_stable_id) {
                return;
            }

            let recipients: Vec<String> = session.connected_participants.iter().cloned().collect();

            let should_cleanup = session.connected_participants.is_empty()
                || (session.connected_participants.len() == 1
                    && session.invited_participants.is_empty()
                    && !session.has_ever_established);
            if should_cleanup {
                sessions.remove(&channel_id);
            }

            (recipients, my_stable_id.clone())
        };

        let display_name = {
            let connected = state.connected_users.read().await;
            connected
                .values()
                .find(|u| u.stable_id == my_stable_id)
                .map(|u| u.username.clone())
                .unwrap_or_else(|| username.clone())
        };

        for recipient_id in recipients {
            let _ = io
                .to(recipient_id)
                .emit(
                    "group-call-invite-cleared",
                    &json!({
                        "channelId": channel_id,
                        "stableUserId": my_stable_id,
                        "username": display_name,
                        "reason": "rejected"
                    }),
                )
                .await;
        }
    } else if let Some(caller_id) = data
        .get("callerId")
        .and_then(|v| v.as_str())
        .map(String::from)
    {
        // DM call reject
        // SEC-3: the call is over — drop the signaling consent link.
        dm_link_forget(&my_stable_id, &caller_id);
        let _ = io
            .to(caller_id)
            .emit(
                "call-rejected",
                &json!({
                    "userId": my_stable_id
                }),
            )
            .await;
    }
}

#[allow(dead_code)]
async fn on_call_cancel(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let my_stable_id = get_my_stable_id(&socket, &state.app.config.jwt_secret);

    if let Some(channel_id) = data
        .get("channelId")
        .and_then(|v| v.as_str())
        .map(String::from)
    {
        advance_voice_intent(&socket, &channel_id, false);
        // Group call cancel (only valid before call is established)
        let invitees_to_cancel = {
            let mut sessions = state.group_call_sessions.write().await;
            let session = match sessions.get_mut(&channel_id) {
                Some(s) => s,
                None => return,
            };

            if !session.connected_participants.contains_socket(&my_stable_id, &socket.id.to_string())
                || session.has_ever_established || session.connected_participants.len() > 1 {
                return;
            }

            let last_device = session.connected_participants.leave_socket(&socket.id.to_string())
                .is_some_and(|(_, last)| last);
            if last_device {
                let invitees: Vec<String> = session.invited_participants.iter().cloned().collect();
                sessions.remove(&channel_id);
                invitees
            } else { Vec::new() }
        };

        for invitee_id in invitees_to_cancel {
            let _ = io
                .to(invitee_id)
                .emit(
                    "call-cancelled",
                    &json!({
                        "userId": my_stable_id,
                        "channelId": channel_id
                    }),
                )
                .await;
        }
        leave_wabidb_channel_room_if_unrostered(&socket, &state, &channel_id).await;
    } else if let Some(target_id) = data
        .get("targetUserId")
        .and_then(|v| v.as_str())
        .map(String::from)
    {
        // DM call cancel
        // SEC-3: the call is over — drop the signaling consent link.
        dm_link_forget(&my_stable_id, &target_id);
        let _ = io
            .to(target_id)
            .emit(
                "call-cancelled",
                &json!({
                    "userId": my_stable_id
                }),
            )
            .await;
    }
}

#[allow(dead_code)]
async fn on_call_end(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let my_stable_id = get_my_stable_id(&socket, &state.app.config.jwt_secret);
    let participant_ids: Vec<String> = data
        .get("participants")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    if !participant_ids.is_empty() {
        // SEC-3: the call is over — drop DM signaling consent with each
        // participant so no further offers/answers/ICE flow between them.
        for participant_id in &participant_ids {
            dm_link_forget(&my_stable_id, participant_id);
        }
        // Round 5 hot-mic fix: the DM's wabidb media room membership dies
        // with the call — room membership is the relay's only authorization,
        // so a lingering room means a still-emitting client keeps streaming
        // its mic to the "ended" call.
        for participant_id in &participant_ids {
            let room = format!("wabidb-call-{}", dm_media_room_key(&my_stable_id, participant_id));
            let _ = socket.leave(room.clone());
            info!(
                "[sio] Socket {} left wabiDB media room {} (call ended)",
                socket.id, room
            );
        }
        for participant_id in participant_ids {
            let _ = io
                .to(participant_id)
                .emit("call-ended", &json!({ "userId": my_stable_id }))
                .await;
        }
    } else {
        let _ = socket
            .broadcast()
            .emit("call-ended", &json!({ "userId": my_stable_id }))
            .await;
    }
}
