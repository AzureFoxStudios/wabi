// The dispatch reader and this lifecycle writer share one admission boundary.
// Do not take membership_gate recursively from any helper in this module.
type GroupResult<T> = Result<T, (&'static str, &'static str)>;

fn group_internal(error: impl std::fmt::Display) -> (&'static str, &'static str) {
    warn!("[sio] group lifecycle failed: {error}");
    (
        "PERSISTENCE_ERROR",
        "Could not complete the group operation; refresh before retrying",
    )
}

fn group_user_id(value: Option<&Value>) -> GroupResult<u64> {
    value
        .and_then(Value::as_str)
        .and_then(|s| s.strip_prefix("user-").unwrap_or(s).parse::<u64>().ok())
        .filter(|id| *id > 0 && *id <= i64::MAX as u64)
        .ok_or(("INVALID_MEMBER", "Select a registered user"))
}

fn group_request_id(data: &Value) -> GroupResult<uuid::Uuid> {
    data.get("requestId")
        .and_then(Value::as_str)
        .and_then(|id| uuid::Uuid::parse_str(id).ok())
        .filter(|id| !id.is_nil())
        .ok_or((
            "INVALID_REQUEST",
            "Refresh the app before changing group membership",
        ))
}

async fn group_actor(socket: &SocketRef, state: &SioState) -> GroupResult<u64> {
    let identity = resolve_identity(socket, state)
        .await
        .ok_or(("UNAUTHORIZED", "Sign in again before changing this group"))?;
    if identity.user_id <= 0 || identity.is_guest {
        return Err(("UNAUTHORIZED", "A registered account is required"));
    }
    let id = identity.user_id as u64;
    require_group_user(state, id).await?;
    Ok(id)
}

async fn require_group_user(state: &SioState, id: u64) -> GroupResult<()> {
    match state.app.wdb.get_user(id).await.map_err(group_internal)? {
        Some(user) if user.is_active && !user.password_hash.is_empty() => Ok(()),
        _ => Err((
            "INVALID_MEMBER",
            "Group members must be active registered users",
        )),
    }
}

fn group_revision(state: &SioState, id: &str) -> GroupResult<u64> {
    wabidb::projections::channel_members::ChannelMembersProjection::revision(
        &state.app.wdb.engine().projection_state(),
        id,
    )
    .map_err(group_internal)
}

async fn group_snapshot(state: &SioState, id: &str) -> GroupResult<Value> {
    let channel = state
        .app
        .wdb
        .get_channel(id)
        .await
        .map_err(group_internal)?
        .filter(|c| c.channel_kind == wabidb::domain::ChannelKind::GroupDm)
        .ok_or(("UNAVAILABLE", "Group is no longer available"))?;
    let mut members = state
        .app
        .wdb
        .list_channel_members(id)
        .await
        .map_err(group_internal)?;
    let owner = crate::channel_access::group_owner(&channel, &members);
    members.sort_by_key(|m| (Some(m.user_id) != owner, m.joined_at_micros, m.user_id));
    let row = state
        .app
        .wdb
        .get_channel_raw(id)
        .await
        .map_err(group_internal)?
        .ok_or(("UNAVAILABLE", "Group is no longer available"))?;
    let mut value = row_to_channel_view(&row);
    value["members"] = json!(members
        .iter()
        .map(|m| format!("user-{}", m.user_id))
        .collect::<Vec<_>>());
    value["ownerId"] = json!(owner.map(|id| format!("user-{id}")));
    // Commit sequences are u64; a decimal string is lossless in browser JS.
    value["membershipRevision"] = json!(group_revision(state, id)?.to_string());
    Ok(value)
}

// Account rooms are populated by `join`, but authentication and admission can
// precede presence. Enumerate authenticated devices so none misses revocation.
fn group_emit_accounts(io: &SocketIo, accounts: &HashSet<u64>, event: &str, payload: &Value) {
    for device in io.sockets() {
        if device
            .extensions
            .get::<SioIdentity>()
            .is_some_and(|id| id.user_id > 0 && accounts.contains(&(id.user_id as u64)))
        {
            let _ = device.emit(event, payload);
        }
    }
}

fn group_ack(socket: &SocketRef, data: &Value, operation: &str, result: GroupResult<Value>) {
    let mut payload = match result {
        Ok(value) => value,
        Err((code, error)) => json!({"ok":false, "code":code, "error":error}),
    };
    payload["operation"] = json!(operation);
    payload["requestId"] = data.get("requestId").cloned().unwrap_or(Value::Null);
    if payload.get("channelId").is_none() {
        payload["channelId"] = data.get("channelId").cloned().unwrap_or(Value::Null);
    }
    let _ = socket.emit("group-operation-result", &payload);
    // Old clients must fail visibly, never appear to have changed membership.
    if payload["ok"] == false {
        let _ = socket.emit("group-error", &payload);
    }
}

async fn on_create_group(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let _membership = state.app.membership_gate.write().await;
    let result = create_group_admitted(&socket, &data, &state, &io).await;
    group_ack(&socket, &data, "create", result);
}

async fn create_group_admitted(
    socket: &SocketRef,
    data: &Value,
    state: &SioState,
    io: &SocketIo,
) -> GroupResult<Value> {
    let request = group_request_id(data)?;
    let actor = group_actor(socket, state).await?;
    let name = data
        .get("groupName")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.len() <= 100 && !s.chars().any(char::is_control))
        .ok_or((
            "INVALID_NAME",
            "Group name must be 1–100 bytes without control characters",
        ))?;
    let requested = data
        .get("userIds")
        .and_then(Value::as_array)
        .filter(|ids| !ids.is_empty() && ids.len() <= 255)
        .ok_or(("INVALID_MEMBERS", "Select 1–255 other members"))?;
    let mut members = vec![actor];
    for value in requested {
        let uid = group_user_id(Some(value))?;
        require_group_user(state, uid).await?;
        if !members.contains(&uid) {
            members.push(uid);
        }
    }
    if members.len() < 2 {
        return Err(("INVALID_MEMBERS", "Select at least one other member"));
    }
    // Retries of one creation request address the same durable identity, never
    // create duplicate groups. A deleted group's revision prevents resurrection.
    let id = format!("group-{request}");
    match state
        .app
        .wdb
        .get_channel(&id)
        .await
        .map_err(group_internal)?
    {
        Some(channel)
            if channel.owner_user_id == actor
                && channel.name == name
                && channel.channel_kind == wabidb::domain::ChannelKind::GroupDm =>
        {
            if !state
                .app
                .wdb
                .list_channel_members(&id)
                .await
                .map_err(group_internal)?
                .iter()
                .any(|m| m.user_id == actor)
            {
                return Err(("UNAVAILABLE", "Group unavailable"));
            }
        }
        Some(_) => return Err(("CONFLICT", "This creation request has already been used")),
        None => {
            if group_revision(state, &id)? != 0 {
                return Err(("CONFLICT", "This group was already retired"));
            }
            state
                .app
                .wdb
                .create_group(&id, name, actor, &members)
                .await
                .map_err(group_internal)?;
        }
    }
    let channel = group_snapshot(state, &id).await?;
    let current: HashSet<_> = state
        .app
        .wdb
        .list_channel_members(&id)
        .await
        .map_err(group_internal)?
        .into_iter()
        .map(|m| m.user_id)
        .collect();
    let payload = json!({"channelId":id, "channel":channel});
    group_emit_accounts(io, &current, "group-channel-added", &payload);
    let _ = socket.emit("group-created", &payload);
    Ok(
        json!({"ok":true, "channelId":id, "membershipRevision":channel["membershipRevision"], "channel":channel}),
    )
}

async fn on_group_membership(
    socket: SocketRef,
    data: Value,
    state: SioState,
    io: SocketIo,
    operation: &str,
) {
    let _membership = state.app.membership_gate.write().await;
    let result = change_group_admitted(&socket, &data, &state, &io, operation).await;
    group_ack(&socket, &data, operation, result);
}

async fn change_group_admitted(
    socket: &SocketRef,
    data: &Value,
    state: &SioState,
    io: &SocketIo,
    operation: &str,
) -> GroupResult<Value> {
    group_request_id(data)?;
    let actor = group_actor(socket, state).await?;
    let id = data
        .get("channelId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 128)
        .ok_or(("INVALID_GROUP", "Select a group"))?;
    let channel = crate::channel_access::require_access(&state.app, actor as i64, id)
        .await
        .map_err(|_| ("UNAVAILABLE", "You no longer have access to this group"))?;
    if channel.channel_kind != wabidb::domain::ChannelKind::GroupDm {
        return Err(("INVALID_GROUP", "This is not a group conversation"));
    }
    let mut members = state
        .app
        .wdb
        .list_channel_members(id)
        .await
        .map_err(group_internal)?;
    let owner = crate::channel_access::group_owner(&channel, &members)
        .ok_or(("UNAVAILABLE", "Group has no members"))?;
    if operation != "leave" && owner != actor {
        return Err((
            "FORBIDDEN",
            "Only the group owner can add or remove other members",
        ));
    }
    let expected = data
        .get("expectedRevision")
        .and_then(Value::as_str)
        .and_then(|s| s.parse::<u64>().ok());
    let revision = group_revision(state, id)?;
    if expected != Some(revision) {
        let channel = group_snapshot(state, id).await?;
        let _ = socket.emit(
            "group-membership-updated",
            &json!({"channelId":id, "channel":channel}),
        );
        return Err((
            "CONFLICT",
            "Group membership changed; review the current members and try again",
        ));
    }
    let target = match operation {
        "leave" => actor,
        "kick" => group_user_id(data.get("targetUserId"))?,
        "add" => group_user_id(data.get("userId"))?,
        _ => return Err(("INVALID_REQUEST", "Unknown group operation")),
    };
    let (add, remove) = if operation == "add" {
        require_group_user(state, target).await?;
        if members.iter().any(|m| m.user_id == target) {
            return Err(("ALREADY_MEMBER", "User is already a member"));
        }
        if members.len() >= 256 {
            return Err(("GROUP_FULL", "Groups support at most 256 members"));
        }
        (Some(target), None)
    } else {
        if operation == "kick" && target == actor {
            return Err(("INVALID_REQUEST", "Use Leave group to leave your own group"));
        }
        if !members.iter().any(|m| m.user_id == target) {
            return Err(("NOT_MEMBER", "User is not a member"));
        }
        (None, Some(target))
    };
    if remove.is_some() {
        members.retain(|m| m.user_id != target);
    }
    let next_owner = if remove == Some(owner) {
        members
            .iter()
            .min_by_key(|m| (m.joined_at_micros, m.user_id))
            .map_or(0, |m| m.user_id)
    } else {
        owner
    };
    let revision = state
        .app
        .wdb
        .change_group_membership(actor, id, add, remove, next_owner)
        .await
        .map_err(group_internal)?;
    if remove.is_some() {
        revoke_group_devices(state, io, id, target, revision, operation).await;
    }
    let channel = if members.is_empty() && add.is_none() {
        Value::Null
    } else {
        group_snapshot(state, id).await?
    };
    let mut recipients: HashSet<_> = members.iter().map(|m| m.user_id).collect();
    if let Some(added) = add {
        recipients.insert(added);
    }
    let payload = json!({"channelId":id, "channel":channel});
    group_emit_accounts(io, &recipients, "group-membership-updated", &payload);
    if let Some(added) = add {
        group_emit_accounts(io, &HashSet::from([added]), "group-channel-added", &payload);
    }
    Ok(
        json!({"ok":true, "channelId":id, "membershipRevision":revision.to_string(), "channel":channel}),
    )
}

async fn revoke_group_devices(
    state: &SioState,
    io: &SocketIo,
    id: &str,
    removed: u64,
    revision: u64,
    reason: &str,
) {
    let stable = format!("user-{removed}");
    let (remaining, cancelled) = {
        // Same lock order as relay admission/media. The outer writer prevents
        // check→await→roster insertion from reinstating a removed account.
        let mut voice = state.voice_channels.write().await;
        let mut groups = state.group_call_sessions.write().await;
        if let Some(roster) = voice.get_mut(id) {
            roster.retain(|p| p.stable_id != stable);
        }
        let mut remaining = HashSet::new();
        let mut cancelled = None;
        if let Some(session) = groups.get_mut(id) {
            session.invited_participants.remove(&stable);
            session.connected_participants.remove(&stable);
            remaining = session.connected_participants.iter().cloned().collect();
            if remaining.is_empty() {
                cancelled = Some((
                    session.invited_participants.clone(),
                    session.last_invite_sender_id.clone(),
                ));
                groups.remove(id);
            }
        }
        (remaining, cancelled)
    };
    let devices: Vec<_> = io
        .sockets()
        .into_iter()
        .filter(|device| {
            device
                .extensions
                .get::<SioIdentity>()
                .is_some_and(|identity| identity.user_id == removed as i64)
        })
        .collect();
    for device in &devices {
        for room in [
            id.to_string(),
            format!("wb:{id}"),
            format!("wb:channel:{id}"),
            format!("wabidb-call-channel:{id}"),
        ] {
            device.leave(room);
        }
        wabidb_header_cache_forget_session_socket(&format!("channel:{id}"), &device.id.to_string());
        let _ = device.emit(
            "group-removed",
            &json!({"channelId":id, "membershipRevision":revision.to_string(), "reason":reason}),
        );
    }
    if !remaining.is_empty() {
        // Group joins announce an account-keyed peer, not a device-keyed peer.
        // Match that identity even if all removed devices already disconnected;
        // otherwise remaining clients retain a stale P2P participant.
        let _ = io.to(remaining.into_iter().collect::<Vec<_>>()).emit(
            "group-call-participant-left",
            &json!({"channelId":id, "stableUserId":stable, "userId":stable,
                "socketIds":devices.iter().map(|device| device.id.to_string()).collect::<Vec<_>>()}),
        ).await;
    }
    if let Some((invitees, caller)) = cancelled {
        if !invitees.is_empty() {
            let _ = io
                .to(invitees.into_iter().collect::<Vec<_>>())
                .emit("call-cancelled", &json!({"channelId":id, "userId":caller}))
                .await;
        }
    }
    // Wake raw-WS subscribers immediately, including those with no active
    // participant row. Delivery rechecks current membership before exposing data.
    match state.app.wdb.list_channel_call_sessions(id).await {
        Ok(sessions) => {
            for session in sessions {
                let _ = state.app.call_session_push.send((
                    session.session_id.clone(),
                    Arc::new(crate::websocket::WsMessage::CallAccessRevoked {
                        user_id: removed,
                        membership_revision: revision,
                    }),
                ));
                if let Ok(participants) = state
                    .app
                    .wdb
                    .get_call_participants(&session.session_id)
                    .await
                {
                    let _ = state.app.call_session_push.send((
                        session.session_id.clone(),
                        Arc::new(crate::websocket::WsMessage::CallParticipantChanged {
                            session_id: session.session_id.clone(),
                            participants,
                        }),
                    ));
                }
                let _ = state.app.call_session_push.send((
                    session.session_id.clone(),
                    Arc::new(crate::websocket::WsMessage::CallSessionChanged { session }),
                ));
            }
        }
        Err(error) => warn!("[sio] failed to notify revoked call subscriptions: {error}"),
    }
}
