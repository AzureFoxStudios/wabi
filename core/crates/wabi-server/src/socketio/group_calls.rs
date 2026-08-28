#[allow(dead_code)]
async fn on_group_call_leave(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let my_stable_id = get_my_stable_id(&socket, &state.app.config.jwt_secret);
    let channel_id = match data
        .get("channelId")
        .and_then(|v| v.as_str())
        .map(String::from)
    {
        Some(id) => id,
        None => return,
    };

    let (was_connected, recipients, pending_cancel) = {
        let mut sessions = state.group_call_sessions.write().await;
        let session = match sessions.get_mut(&channel_id) {
            Some(s) => s,
            None => return,
        };

        let was_invited = session.invited_participants.remove(&my_stable_id);
        let was_connected = session.connected_participants.remove(&my_stable_id);

        if !was_invited && !was_connected {
            return;
        }

        let recipients: Vec<String> = session.connected_participants.iter().cloned().collect();

        let should_cleanup = session.connected_participants.is_empty()
            || (session.connected_participants.len() == 1
                && session.invited_participants.is_empty()
                && !session.has_ever_established);

        let pending = if should_cleanup && !session.invited_participants.is_empty() {
            let inv: Vec<String> = session.invited_participants.iter().cloned().collect();
            let sender = session.last_invite_sender_id.clone();
            Some((inv, sender))
        } else {
            None
        };

        if should_cleanup {
            sessions.remove(&channel_id);
        }

        (was_connected, recipients, pending)
    };

    if was_connected {
        for recipient_id in &recipients {
            let _ = io
                .to(recipient_id.clone())
                .emit(
                    "group-call-participant-left",
                    &json!({
                        "channelId": channel_id,
                        "stableUserId": my_stable_id,
                        "userId": socket.id.to_string()
                    }),
                )
                .await;
        }
    }

    if let Some((invitees, canceller_id)) = pending_cancel {
        for invitee_id in invitees {
            let _ = io
                .to(invitee_id)
                .emit(
                    "call-cancelled",
                    &json!({
                        "userId": canceller_id,
                        "channelId": channel_id
                    }),
                )
                .await;
        }
    }

    // Round 5 hot-mic fix: leaving the group call drops the channel's wabidb
    // media room membership too — but only if no voice-roster slot remains
    // (a departing group member may legitimately keep listening to the
    // channel).
    leave_wabidb_channel_room_if_unrostered(&socket, &state, &channel_id).await;
}

#[allow(dead_code)]
async fn on_group_call_stop_ringing(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let my_stable_id = get_my_stable_id(&socket, &state.app.config.jwt_secret);
    let channel_id = match data
        .get("channelId")
        .and_then(|v| v.as_str())
        .map(String::from)
    {
        Some(id) => id,
        None => return,
    };
    let target_user_id = match data
        .get("targetUserId")
        .and_then(|v| v.as_str())
        .map(String::from)
    {
        Some(id) => id,
        None => return,
    };

    let (recipients, socket_id) = {
        let mut sessions = state.group_call_sessions.write().await;
        let session = match sessions.get_mut(&channel_id) {
            Some(s) => s,
            None => return,
        };

        if !session.connected_participants.contains(&my_stable_id) {
            return;
        }
        if !session.invited_participants.remove(&target_user_id) {
            return;
        }

        let recipients: Vec<String> = session.connected_participants.iter().cloned().collect();
        (recipients, socket.id.to_string())
    };

    let _ = io
        .to(target_user_id.clone())
        .emit(
            "call-cancelled",
            &json!({
                "userId": socket_id,
                "channelId": channel_id
            }),
        )
        .await;

    let display_name = {
        let connected = state.connected_users.read().await;
        connected
            .values()
            .find(|u| u.stable_id == target_user_id)
            .map(|u| u.username.clone())
            .unwrap_or_else(|| target_user_id.clone())
    };

    for recipient_id in recipients {
        let _ = io
            .to(recipient_id)
            .emit(
                "group-call-invite-cleared",
                &json!({
                    "channelId": channel_id,
                    "stableUserId": target_user_id,
                    "username": display_name,
                    "reason": "stopped"
                }),
            )
            .await;
    }
}

