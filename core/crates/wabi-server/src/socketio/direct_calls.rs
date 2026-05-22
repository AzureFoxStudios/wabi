async fn on_call_initiate(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
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
        // Group call
        let channels = state.app.stdb.get_channels_raw().await.unwrap_or_default();
        let channel_opt = channels.iter().find(|c| {
            c.get("channel_id")
                .or_else(|| c.get("id"))
                .and_then(|v| v.as_str())
                == Some(channel_id.as_str())
        });

        let (channel_name, channel_members) = match channel_opt {
            Some(c) => {
                let name = c
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let members: Vec<String> = c
                    .get("members")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|m| m.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();
                (name, members)
            }
            None => {
                let _ = socket.emit(
                    "call-error",
                    &json!({
                        "code": "invalid_channel",
                        "message": "Group channel not found",
                        "targetUserId": channel_id
                    }),
                );
                return;
            }
        };

        if !channel_members.is_empty() && !channel_members.contains(&my_stable_id) {
            let _ = socket.emit(
                "call-error",
                &json!({
                    "code": "not_group_member",
                    "message": "You are not a member of this group",
                    "targetUserId": channel_id
                }),
            );
            return;
        }

        let connected_snapshot: HashMap<String, ConnectedUser> = {
            let connected = state.connected_users.read().await;
            connected.clone()
        };

        let (invitees, is_video, ch_name) = {
            let mut sessions = state.group_call_sessions.write().await;
            let session = sessions
                .entry(channel_id.clone())
                .or_insert_with(|| GroupCallSession {
                    channel_id: channel_id.clone(),
                    channel_name: channel_name.clone(),
                    initiator_stable_id: my_stable_id.clone(),
                    is_video_call,
                    has_ever_established: false,
                    last_invite_sender_id: socket.id.to_string(),
                    invited_participants: HashSet::new(),
                    connected_participants: HashSet::new(),
                });

            session.channel_name = channel_name.clone();
            if session.connected_participants.is_empty() {
                session.initiator_stable_id = my_stable_id.clone();
            }
            if !session.has_ever_established {
                session.is_video_call = is_video_call;
            }

            session.invited_participants.remove(&my_stable_id);
            if !session.connected_participants.contains(&my_stable_id) {
                session.connected_participants.insert(my_stable_id.clone());
                if session.connected_participants.len() > 1 {
                    session.has_ever_established = true;
                }
            }

            let invitees: Vec<String> = if channel_members.is_empty() {
                connected_snapshot
                    .values()
                    .filter(|u| {
                        u.stable_id != my_stable_id
                            && !session.connected_participants.contains(&u.stable_id)
                            && !session.invited_participants.contains(&u.stable_id)
                    })
                    .map(|u| u.stable_id.clone())
                    .collect()
            } else {
                channel_members
                    .iter()
                    .filter(|id| {
                        *id != &my_stable_id
                            && !session.connected_participants.contains(*id)
                            && !session.invited_participants.contains(*id)
                            && is_stable_connected(&connected_snapshot, id)
                    })
                    .cloned()
                    .collect()
            };

            if invitees.is_empty()
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
                session.is_video_call,
                session.channel_name.clone(),
            )
        };

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

async fn on_call_answer(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
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
        // Group call answer
        let (existing_connected, ch_name) = {
            let mut sessions = state.group_call_sessions.write().await;
            let session = match sessions.get_mut(&channel_id) {
                Some(s) => s,
                None => {
                    drop(sessions);
                    let _ = socket.emit(
                        "call-error",
                        &json!({
                            "code": "caller_unavailable",
                            "message": "Group call is no longer available",
                            "targetUserId": channel_id
                        }),
                    );
                    return;
                }
            };

            session.invited_participants.remove(&my_stable_id);
            if !session.connected_participants.contains(&my_stable_id) {
                session.connected_participants.insert(my_stable_id.clone());
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

async fn on_call_cancel(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let my_stable_id = get_my_stable_id(&socket, &state.app.config.jwt_secret);

    if let Some(channel_id) = data
        .get("channelId")
        .and_then(|v| v.as_str())
        .map(String::from)
    {
        // Group call cancel (only valid before call is established)
        let invitees_to_cancel = {
            let mut sessions = state.group_call_sessions.write().await;
            let session = match sessions.get_mut(&channel_id) {
                Some(s) => s,
                None => return,
            };

            if !session.connected_participants.contains(&my_stable_id) {
                return;
            }
            if session.connected_participants.len() > 1 {
                return;
            }

            let invitees: Vec<String> = session.invited_participants.iter().cloned().collect();
            sessions.remove(&channel_id);
            invitees
        };

        for invitee_id in invitees_to_cancel {
            let _ = io
                .to(invitee_id)
                .emit(
                    "call-cancelled",
                    &json!({
                        "userId": socket.id.to_string(),
                        "channelId": channel_id
                    }),
                )
                .await;
        }
    } else if let Some(target_id) = data
        .get("targetUserId")
        .and_then(|v| v.as_str())
        .map(String::from)
    {
        // DM call cancel
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

