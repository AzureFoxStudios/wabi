// WDB-compat shim: this file calls `state.app.wdb.X(...)` for
// methods the WDB doesn't have equivalents for yet
// (is_user_muted, get_channel_retention, mute_user, etc.).
// The compat WdbClient in `db/` returns no-op defaults for all
// of these. When WDB has the corresponding engine methods, this
// file can be migrated to use `state.app.wdb.X(...)` instead.
// The compat shim itself is a temporary layer and will be removed
// once the last socketio file is migrated.

/// Current Unix time in microseconds. Returns 0 if the system clock is
/// before the Unix epoch (effectively never on a sane system).
#[allow(dead_code)]
fn now_micros() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_micros() as i64)
        .unwrap_or(0)
}

#[allow(dead_code)]
async fn on_join(socket: SocketRef, username: String, state: SioState, io: SocketIo) {
    // Handshake-validated identity is already in extensions. If missing,
    // the socket was not authenticated at connect time.
    let Some(identity) = resolve_identity(&socket, &state).await else {
        let _ = socket.emit("auth-required", &json!({ "reason": "authentication required" }));
        return;
    };

    let user_id_num = identity.user_id;

    let stable_id = if user_id_num > 0 {
        format!("user-{}", user_id_num)
    } else {
        socket.id.to_string()
    };

    // Join a room named after stable_id so io.to(stable_id) routes here
    socket.join(stable_id.clone());

    // A bearer may predate a profile rename. Its subject remains the authority;
    // presentation comes from the current durable account, never the old name.
    let (authed_username, color) = match state.app.wdb.get_user(user_id_num as u64).await {
        Ok(Some(user)) => (user.username, user.color),
        _ => (identity.username, "#98D8C8".to_owned()),
    };

    // Inherit presence from another live socket of the same account
    // (multi-tab): a second tab shouldn't flip Invisible back to Active.
    let inherited_presence = {
        let connected = state.connected_users.read().await;
        connected
            .values()
            .find(|u| u.db_user_id == Some(user_id_num))
            .map(|u| u.presence)
            .unwrap_or(UserPresence::Active)
    };

    let connected_user = ConnectedUser {
        stable_id: stable_id.clone(),
        db_user_id: if user_id_num > 0 {
            Some(user_id_num)
        } else {
            None
        },
        username: authed_username.clone(),
        color: color.clone(),
        presence: inherited_presence,
        last_seen_micros: now_micros(),
    };

    // Register in presence map
    {
        let mut connected = state.connected_users.write().await;
        connected.insert(socket.id.to_string(), connected_user.clone());
    }

    let owner_id = *state.app.owner_user_id.read().await;

    // A full roster is still sent for the People/admin surfaces, but concurrent
    // joins share one build instead of repeating the per-user role/media/badge
    // projection reads. WabiDB writes that affect views invalidate the cache.
    let server_members = server_members_snapshot(&state).await;

    let online_users: Vec<Value> = {
        let connected = state.connected_users.read().await;
        let mut views = Vec::new();
        for u in connected.values() {
            views.push(connected_user_to_view(u, owner_id, &state).await);
        }
        views
    };

    let visible = match crate::channel_access::discoverable_channels(&state.app, user_id_num).await {
        Ok(channels) => channels,
        Err(error) => {
            warn!("[sio] channel discovery failed: {error}");
            let _ = socket.emit("join-error", &json!({"error": "Failed to load channels"}));
            return;
        }
    };
    // Existing private conversations must receive live messages on every
    // connection, including a phone PWA restored before the thread is opened.
    // Discovery is already membership-filtered and the admission gate remains
    // held by the caller until this room mutation completes.
    for channel in &visible {
        if crate::channel_access::is_conversation(channel.channel_kind) {
            socket.join(channel.channel_id.clone());
        }
    }
    let mut channels = Vec::with_capacity(visible.len());
    for channel in visible {
        if channel.channel_kind == wabidb::domain::ChannelKind::GroupDm {
            match group_snapshot(&state, &channel.channel_id).await {
                Ok(snapshot) => channels.push(snapshot),
                Err(_) => {
                    let _ = socket.emit("join-error", &json!({"error":"Failed to load group membership"}));
                    return;
                }
            }
            continue;
        }
        if let Ok(Some(mut row)) = state.app.wdb.get_channel_raw(&channel.channel_id).await {
            // Private membership must survive reconnect; the raw channel row
            // intentionally doesn't duplicate the channel_members projection.
            if crate::channel_access::is_conversation(channel.channel_kind) {
                let Ok(members) = state.app.wdb.list_channel_members(&channel.channel_id).await else { continue };
                row.insert("members".into(), json!(members.iter().map(|m| format!("user-{}", m.user_id)).collect::<Vec<_>>()));
            }
            channels.push(row_to_channel_view(&row));
        }
    }
    // Mark breakout rooms so clients can group them under their parent —
    // the flag lives in-memory (state.breakout_rooms), not on the channel row.
    merge_breakout_flags(&state, &mut channels).await;

    // Voice occupancy rosters, so voice chips survive a page refresh. Mirrors
    // the shape the FE reads at socketConnectionCore.ts:651 — a channel_id ->
    // members[] map. Only channels with live participants are included.
    let voice_state: Value = {
        let voice = state.voice_channels.read().await;
        let mut map = serde_json::Map::new();
        for (channel_id, members) in voice.iter() {
            if members.is_empty() {
                continue;
            }
            let views: Vec<Value> =
                members.iter().map(voice_participant_to_view).collect();
            map.insert(channel_id.clone(), Value::Array(views));
        }
        Value::Object(map)
    };

    let init = json!({
        "channels": channels,
        "users": online_users,
        "serverMembers": server_members,
        "emotes": [],
        "emojis": [],
        "roleDefinitions": server_role_catalog()["roles"],
        "voiceState": voice_state,
        "messagePurgeVersion": 0,
        "session": { "sessionId": socket.id.to_string() },
    });

    if let Err(e) = socket.emit("init", &init) {
        warn!("[sio] init emit failed: {}", e);
    }

    // Broadcast arrival to all other connected sockets
    let user_view = connected_user_to_view(&connected_user, owner_id, &state).await;
    let _ = socket.broadcast().emit("user-joined", &user_view).await;
    let _ = io; // keep io alive
}

async fn server_members_snapshot(state: &SioState) -> Vec<Value> {
    let mut cache = state.roster_cache.lock().await;
    let revision = state.app.wdb.roster_revision();
    if let Some(snapshot) = cache.as_ref().filter(|snapshot| snapshot.reusable(revision)) {
        return snapshot.members.clone();
    }
    let members: Vec<Value> = {
        let Ok(users) = state.app.wdb.list_users().await else {
            // A transient read failure must not become a reusable empty roster.
            *cache = None;
            return Vec::new();
        };
        futures::future::join_all(users.into_iter().map(|u| {
            let state = &state;
            async move {
                build_user_view(
                    state,
                    u.user_id as i64,
                    &u.username,
                    &u.color,
                    u.profile_picture.clone(),
                    u.username_font.clone(),
                    u.bio.clone(),
                    u.status_message.clone(),
                    // Guest accounts carry an empty password hash (see auth.rs
                    // guest check) — this is what flags them as guests in the
                    // roster and admin registry.
                    !u.password_hash.is_empty(),
                    None,
                )
                .await
            }
        }))
        .await
    };
    // A write racing this build must not make an old view reusable.
    if state.app.wdb.roster_revision() == revision {
        *cache = Some(RosterSnapshot { revision, built_at: Instant::now(), members: members.clone() });
    } else {
        *cache = None;
    }
    members
}

/// Read the `profile_media` object from a user's layout record. This is where
/// the avatar banner (`banner_url`) and pfp overlay (`overlay_url`) live —
/// written by the REST `/api/user/profile-media` endpoint and by the
/// `update-profile` socket handler.
async fn profile_media_for(
    state: &SioState,
    db_user_id: i64,
) -> Option<serde_json::Map<String, Value>> {
    if db_user_id <= 0 {
        return None;
    }
    let stored = state.app.wdb.get_user_layout(db_user_id as u64).await.ok().flatten()?;
    // t_55544bc2: cache the parsed profile_media keyed by user_id, validated
    // against the raw layout string. The init payload builds a UserView per
    // registered user per connect — without this, every connect re-parses
    // every user's full layout JSON.
    {
        let cache = state.app.profile_media_cache.read().await;
        if let Some((cached_raw, cached_media)) = cache.get(&(db_user_id as u64)) {
            if cached_raw == &stored.layout_json {
                return cached_media.clone();
            }
        }
    }
    let root: Value = serde_json::from_str(&stored.layout_json).ok()?;
    let media = root.get("profile_media").and_then(|v| v.as_object().cloned());
    let mut cache = state.app.profile_media_cache.write().await;
    cache.insert(
        db_user_id as u64,
        (stored.layout_json.clone(), media.clone()),
    );
    media
}

/// Extract `banner_url` / `overlay_url` from a profile_media map.
fn media_banner_overlay(
    media: &serde_json::Map<String, Value>,
) -> (Option<String>, Option<String>) {
    let banner_url = media.get("banner_url").and_then(|v| v.as_str()).map(String::from);
    let overlay_url = media.get("overlay_url").and_then(|v| v.as_str()).map(String::from);
    (banner_url, overlay_url)
}

/// Extract per-user overlay alignment (`overlay_scale`, `overlay_offset_x/y`)
/// from a profile_media map. Defaults 1/0/0 keep old overlays rendering
/// exactly as before.
fn media_overlay_alignment(media: &serde_json::Map<String, Value>) -> (f64, f64, f64) {
    let num = |key: &str, default: f64| -> f64 {
        media.get(key).and_then(|v| v.as_f64()).unwrap_or(default)
    };
    let scale = num("overlay_scale", 1.0).clamp(0.5, 3.0);
    let ox = num("overlay_offset_x", 0.0).clamp(-200.0, 200.0);
    let oy = num("overlay_offset_y", 0.0).clamp(-200.0, 200.0);
    (scale, ox, oy)
}

/// Build the public profile view from the authenticated account's fields.
/// Callers may pass the just-saved media map after its durable write completes.
async fn build_user_view(
    state: &SioState,
    db_user_id: i64,
    username: &str,
    color: &str,
    profile_picture: Option<String>,
    username_font: Option<String>,
    bio: Option<String>,
    status_message: Option<String>,
    is_registered: bool,
    profile_media: Option<serde_json::Map<String, Value>>,
) -> Value {
    let role = effective_user_role(state, Some(db_user_id), is_registered).await;

    let stable_id = if db_user_id > 0 {
        format!("user-{}", db_user_id)
    } else {
        username.to_string()
    };

    let media = match profile_media {
        Some(map) => map,
        None => profile_media_for(state, db_user_id).await.unwrap_or_default(),
    };
    let (banner_url, overlay_url) = media_banner_overlay(&media);
    let (overlay_scale, overlay_ox, overlay_oy) = media_overlay_alignment(&media);
    let badges = badges_json_for(state, db_user_id).await;
    // Bot identity lives in the bot registry, not WabiDB's projected User
    // (whose is_bot field is false for legacy persisted records).
    let is_bot = db_user_id > 0 && state.app.is_bot_user(db_user_id as u64).await;

    json!({
        "id": stable_id,
        "username": username,
        "color": color,
        "status": "active",
        "handle": null,
        "profilePicture": profile_picture,
        "bannerUrl": banner_url,
        "overlayUrl": overlay_url,
        "overlayScale": overlay_scale,
        "overlayOffsetX": overlay_ox,
        "overlayOffsetY": overlay_oy,
        "bio": bio,
        "statusMessage": status_message,
        "dbUserId": if db_user_id > 0 { Some(db_user_id) } else { None },
        "roles": [role],
        "highestRole": role,
        "badges": badges,
        "usernameFont": username_font.and_then(|s| serde_json::from_str::<Value>(&s).ok()),
        "isRegistered": is_registered,
        "isBot": is_bot,
    })
}

/// Save an authenticated profile; publication follows both existing durable writes.
#[allow(dead_code)]
async fn on_update_profile(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let request_id = data.get("requestId").cloned().unwrap_or(Value::Null);
    let fail = |reason: &str| {
        let _ = socket.emit("profile-update-failed", &json!({
            "reason": reason, "profileRequestId": request_id,
        }));
    };
    if !data.is_object() {
        fail("profile update must be an object");
        return;
    }
    if !request_id.is_null() && !request_id.as_str().is_some_and(|id|
        !id.is_empty() && id.len() <= 128 && !id.chars().any(char::is_control))
    {
        fail("requestId must be a nonempty string of at most 128 bytes");
        return;
    }
    let Some(identity) = resolve_identity(&socket, &state).await else {
        fail("authentication required; please sign in again");
        return;
    };
    let db_user_id = identity.user_id;
    if db_user_id <= 0 {
        fail("authentication required");
        return;
    }
    // Presence and custom status text are deliberately independent.
    if data.get("status").is_some() && data.get("statusMessage").is_none() {
        let _ = socket.emit("presence-ignored", &json!({ "reason": "use set-presence for presence changes" }));
    }
    let updates = match crate::api::user::profile_user_patch(&data) {
        Ok(updates) => updates,
        Err(reason) => { fail(&reason); return; }
    };
    let current = match state.app.wdb.get_user(db_user_id as u64).await {
        Ok(Some(current)) => current,
        _ => { fail("could not read the current profile"); return; }
    };
    let mut media_request = serde_json::Map::new();
    for (wire, stored) in [
        ("bannerUrl", "banner_url"), ("overlayUrl", "overlay_url"),
        ("overlayScale", "overlay_scale"), ("overlayOffsetX", "overlay_offset_x"),
        ("overlayOffsetY", "overlay_offset_y"),
    ] {
        if let Some(value) = data.get(wire) { media_request.insert(stored.into(), value.clone()); }
    }
    // Read and validate all inputs before either write; retain the complete container.
    let media_patch = if !media_request.is_empty() {
        let stored = match state.app.wdb.get_user_layout(db_user_id as u64).await {
            Ok(stored) => stored,
            Err(_) => { fail("could not read profile media settings"); return; }
        };
        let root = match stored.map(|stored| serde_json::from_str::<Value>(&stored.layout_json)).transpose() {
            Ok(root) => root.unwrap_or_else(|| json!({})),
            Err(_) => { fail("stored profile settings are invalid; nothing was saved"); return; }
        };
        let existing = root.get("profile_media").and_then(Value::as_object).cloned().unwrap_or_default();
        let media = match crate::api::user::profile_media_patch(&Value::Object(media_request), existing) {
            Ok(media) => media,
            Err(reason) => { fail(&reason); return; }
        };
        let combined = crate::api::user::merge_user_container(root, "profile_media", Value::Object(media.clone()));
        Some((media, combined.to_string()))
    } else { None };

    let username = updates.username.clone().unwrap_or(current.username);
    let color = updates.color.as_deref().map(|color| color.strip_prefix('\0').unwrap_or(color).to_owned()).unwrap_or(current.color);
    let profile_picture = updates.profile_picture.clone().or(current.profile_picture);
    let username_font = updates.username_font.clone().or(current.username_font);
    let bio = updates.bio.clone().or(current.bio);
    let status_message = updates.status_message.clone().or(current.status_message);
    let has_user_patch = updates.username.is_some() || updates.color.is_some() || updates.profile_picture.is_some()
        || updates.username_font.is_some() || updates.bio.is_some() || updates.status_message.is_some();
    if has_user_patch {
        if let Err(error) = state.app.wdb.update_user(db_user_id as u64, updates).await {
            warn!("[sio] update-profile failed: {}", error);
            fail("failed to persist profile");
            return;
        }
    }
    if let Some((_, serialized)) = &media_patch {
        if let Err(error) = state.app.wdb.upsert_user_layout(db_user_id as u64, serialized).await {
            warn!("[sio] profile media save failed: {}", error);
            fail(if has_user_patch {
                "profile fields were saved, but profile media could not be saved; retry the media change"
            } else { "failed to persist profile media" });
            return;
        }
    }
    // Future presence snapshots must retain the published display name/color.
    for user in state.connected_users.write().await.values_mut() {
        if user.db_user_id == Some(db_user_id) { user.username = username.clone(); user.color = color.clone(); }
    }
    let view = build_user_view(
        &state, db_user_id, &username, &color, profile_picture, username_font, bio, status_message,
        !current.password_hash.is_empty(), media_patch.map(|(media, _)| media),
    ).await;
    let mut receipt = view.clone();
    if !request_id.is_null() { receipt["profileRequestId"] = request_id; }
    let _ = socket.emit("profile-updated", &receipt);
    let _ = io.to(format!("user-{}", db_user_id)).emit("user-updated", &view).await;
    let _ = socket.broadcast().emit("user-updated", &view).await;
}

/// Handle `set-presence`: update this socket's self-selected presence
/// (active/away/busy/invisible) and broadcast the masked view. Invisible is
/// emitted as "offline" so no observer can distinguish it from a real leave.
async fn on_set_presence(socket: SocketRef, data: Value, state: SioState, io: SocketIo) {
    let Some(identity) = resolve_identity(&socket, &state).await else {
        let _ = socket.emit("presence-rejected", &json!({ "reason": "authentication required" }));
        return;
    };
    let user_id = identity.user_id;
    if user_id <= 0 {
        let _ = socket.emit("presence-rejected", &json!({ "reason": "authentication required" }));
        return;
    }

    let requested = data.get("presence").and_then(|v| v.as_str());
    let presence = UserPresence::parse(requested.unwrap_or(""));
    if requested.is_none() {
        let _ = socket.emit("presence-rejected", &json!({ "reason": "missing presence value" }));
        return;
    }

    let stable_id = format!("user-{}", user_id);

    // Update every live socket of this account (multi-tab consistency).
    {
        let mut connected = state.connected_users.write().await;
        for u in connected.values_mut() {
            if u.db_user_id == Some(user_id) {
                u.presence = presence;
            }
        }
    }

    // Masked view: invisible → "offline". Broadcast namespace-wide
    // (includes the emitter's own sockets).
    let mut view = json!({
        "id": stable_id,
        "username": identity.username,
        "status": if presence == UserPresence::Invisible { "offline" } else { presence.as_str() },
        "dbUserId": user_id,
    });
    if presence == UserPresence::Invisible {
        view["statusMessage"] = Value::Null;
    }
    let _ = io.emit("presence-changed", &view).await;
}

#[allow(dead_code)]
async fn on_disconnect(socket: SocketRef, state: SioState, io: SocketIo) {
    let socket_id = socket.id.to_string();
    info!("[sio] disconnected: {}", socket_id);

    // Calling security cleanup (2026-08-25 Phase 1): drop the media rate
    // bucket and every DM call-signaling link this user held.
    media_rate_forget(&socket_id);
    crate::api::voice_policy::remove_socket_admissions(&state.app.config.data_dir, &socket_id);
    crate::api::voice_self_state::remove_socket(&socket_id);
    wabidb_header_cache_forget_socket(&socket_id);
    let departed_stable = get_my_stable_id(&socket, &state.app.config.jwt_secret);
    let account_still_connected = io.sockets().iter().any(|other|
        other.id != socket.id && other.connected()
            && get_my_stable_id(other, &state.app.config.jwt_secret) == departed_stable);
    let direct_call_peers = if account_still_connected { Vec::new() } else {
        let peers = dm_link_peers(&departed_stable);
        dm_link_clear_user(&departed_stable);
        peers
    };

    // Recording transparency cleanup (2026-08-27 round 5): a disconnected
    // recorder stops recording — tell the members of every channel they
    // recorded so no stale REC badge survives on other screens.
    if let Some(entry) = recording_presence_remove(&socket_id) {
        let rooms = recording_presence_departure_rooms(&state, &entry).await;
        let _ = io
            .to(rooms)
            .emit(
                "call-recording-presence-changed",
                &recording_presence_payload(&entry, false),
            )
            .await;
    }

    let departed = {
        let mut connected = state.connected_users.write().await;
        connected.remove(&socket_id)
    };

    if let Some(user) = departed.as_ref().filter(|_| !account_still_connected) {
        let _ = io
            .emit(
                "user-left",
                &json!({
                    "id":       user.stable_id,
                    "dbUserId": user.db_user_id,
                    "username": user.username,
                }),
            )
            .await;
    }

    // Guest reaping (hard-temporary guests): when the LAST socket of a
    // guest account disconnects, tombstone-delete the user from WabiDB so
    // no `Guest_*` row lingers in the roster. Registered users are never
    // touched — the password-hash check below is the guard.
    if let Some(db_user_id) = departed.as_ref().and_then(|u| u.db_user_id) {
        let username = departed.as_ref().map(|u| u.username.clone()).unwrap_or_default();
        let still_connected = state
            .connected_users
            .read()
            .await
            .values()
            .any(|u| u.db_user_id == Some(db_user_id));
        if !still_connected {
            match state.app.wdb.get_user(db_user_id as u64).await {
                Ok(Some(row)) if row.password_hash.is_empty() => {
                    match state.app.wdb.delete_user(db_user_id as u64).await {
                        Ok(()) => {
                            info!(
                                "[sio] reaped guest {} ({}) on final disconnect",
                                db_user_id, username
                            );
                            let _ = io
                                .emit(
                                    "user-deleted",
                                    &json!({ "dbUserId": db_user_id }),
                                )
                                .await;
                        }
                        Err(e) => {
                            warn!("[sio] guest reap failed for {}: {}", db_user_id, e)
                        }
                    }
                }
                Ok(Some(_)) => {} // registered account — keep forever
                Ok(None) => {}    // already gone (boot sweep or earlier reap)
                Err(e) => warn!("[sio] guest reap lookup failed for {}: {}", db_user_id, e),
            }
        }
    }

    // Clean up voice channels
    let voice_lefts: Vec<(String, String)> = {
        let voice = state.voice_channels.read().await;
        voice
            .iter()
            .flat_map(|(ch, members)| {
                members
                    .iter()
                    .filter(|p| p.socket_id == socket_id)
                    .map(|p| (ch.clone(), p.stable_id.clone()))
                    .collect::<Vec<_>>()
            })
            .collect()
    };

    if !voice_lefts.is_empty() {
        let mut voice = state.voice_channels.write().await;
        for (channel_id, _) in &voice_lefts {
            if let Some(members) = voice.get_mut(channel_id) {
                members.retain(|p| p.socket_id != socket_id);
            }
        }
        drop(voice);
        for (channel_id, stable_id) in &voice_lefts {
            let _ = io
                .emit(
                    "voice-channel-left",
                    &json!({
                        "channelId": channel_id,
                        "userId":    stable_id,
                    }),
                )
                .await;
            let _ = io
                .emit(
                    "voice-channel-user-left",
                    &json!({
                        "channelId": channel_id,
                        "userId":    stable_id,
                        "socketId":  socket_id,
                    }),
                )
                .await;
        }
    }

    // Clean up group call sessions
    let group_call_lefts: Vec<(String, Vec<String>)> = {
        let mut sessions = state.group_call_sessions.write().await;
        let mut lefts = Vec::new();
        let mut to_remove = Vec::new();

        for (channel_id, session) in sessions.iter_mut() {
            let last_device_left = session.connected_participants.leave_socket(&socket_id)
                .is_some_and(|(_, last)| last);
            let invitation_left = !account_still_connected && session.invited_participants.remove(&departed_stable);
            let was_in = last_device_left || invitation_left;
            if !was_in {
                continue;
            }

            let recipients: Vec<String> = session.connected_participants.iter().cloned().collect();
            lefts.push((channel_id.clone(), recipients));

            if session.connected_participants.is_empty() {
                to_remove.push(channel_id.clone());
            }
        }
        for ch in to_remove {
            sessions.remove(&ch);
        }
        lefts
    };

    for (channel_id, recipients) in group_call_lefts {
        for recipient_id in recipients {
            let _ = io
                .to(recipient_id)
                .emit(
                    "group-call-participant-left",
                    &json!({
                        "channelId": channel_id,
                        "stableUserId": departed_stable,
                        "userId": departed_stable,
                        "socketId": socket_id
                    }),
                )
                .await;
        }
    }

    // A disconnected account ends only its own direct calls. A global event
    // used to end unrelated calls whenever anybody left the server.
    for peer in direct_call_peers {
        let _ = io.to(peer).emit("call-ended", &json!({ "userId": departed_stable })).await;
    }
}

#[allow(dead_code)]
async fn on_join_channel(socket: SocketRef, channel_id: String, state: SioState) {
    // Resolve identity — unauthenticated sockets cannot join any room.
    let Some(identity) = resolve_identity(&socket, &state).await else {
        let _ = socket.emit("join-error", &json!({ "channelId": &channel_id, "error": "authentication required" }));
        return;
    };
    let user_id = identity.user_id;

    // A completed automatic ban must fence even a join already waiting here.
    // Retain ordering through history publication as well as room insertion.
    let _channel = crate::channel_access::publication_gate(&state.app, &channel_id).lock().await;

    // DM channel access → can_access_dm; regular channel → can_access_channel.
    // Point lookups (t_6bbbc52a): no full channel-table scans per join.
    let channel_kind: Option<String> = state.app.wdb.get_channel_kind(&channel_id).await;

    let allowed = match channel_kind.as_deref() {
        Some("dm") => can_access_dm(&state, user_id, &channel_id).await,
        _ => can_access_channel(&state, user_id, &channel_id).await,
    };

    if !allowed {
        warn!("[sio] user {} denied access to channel {}", user_id, channel_id);
        let _ = socket.emit("join-error", &json!({ "channelId": &channel_id, "error": "access denied" }));
        return;
    }

    // Channel min_role gate (case-insensitive). Only enforced if a min_role is set.
    // NOTE (t_6bbbc52a audit): no writer currently persists min_role into the
    // channels projection — the gate is inert today; kept byte-compatible.
    if let Ok(Some(channel)) = state.app.wdb.get_channel_raw(&channel_id).await {
        {
            if let Some(min_role_str) = channel.get("min_role").and_then(|v| v.as_str()) {
                let user_role = state.app.get_user_highest_role(user_id).await;
                let role_priority = |r: &str| match r.to_lowercase().as_str() {
                    "owner" => 3,
                    "admin" => 2,
                    "moderator" | "member" => 1,
                    _ => 0,
                };
                if role_priority(&user_role) < role_priority(min_role_str) {
                    warn!("[sio] user {} blocked from channel {}: requires {}, has {}", user_id, channel_id, min_role_str, user_role);
                    let _ = socket.emit("join-error", &json!({ "channelId": &channel_id, "error": "insufficient role" }));
                    return;
                }
            }
        }
    }

    socket.join(channel_id.clone());

    let session = state.app.session_messages.read().await;
    let session_msgs = session.get(&channel_id).cloned().unwrap_or_default();
    drop(session);
    let is_live = state.app.channel_auto_delete_label.read().await
        .get(&channel_id).is_some_and(|label| label == "live");

    let all: Vec<Value> = if is_live {
        let mut msgs = session_msgs;
        msgs.sort_by_key(|m| m.get("timestamp").and_then(|v| v.as_i64()).unwrap_or(0));
        // Collapse duplicate message ids — duplicate keys crash Svelte keyed each.
        // Keep the LAST occurrence so the most recent merged row wins, and
        // preserve messages without ids instead of silently dropping them.
        let mut seen = std::collections::HashSet::new();
        msgs.into_iter()
            .rev()
            .filter(|m| {
                let id = m
                    .get("id")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_default();
                if id.is_empty() {
                    true
                } else {
                    seen.insert(id)
                }
            })
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect()
    } else {
        // Retained rooms always use the durable tail, even while session
        // memory has recent socket sends. A stale cache must not hide REST
        // sends, older messages, or recovery after reconnect.
        // Resolve author usernames so the client shows a real name (and a
        // `user-<dbId>` id it can look up in its cache) instead of a bare
        // numeric id + empty username that renders as "Unknown user".
        let typed_msgs = match state.app.wdb.list_messages_typed(&channel_id, 50).await {
            Ok(messages) => messages,
            Err(error) => {
                warn!("join history failed for {}: {}", channel_id, error);
                let _ = socket.emit("join-error", &json!({"channelId": &channel_id, "error": "Messages could not be loaded"}));
                return;
            }
        };
        let cache_by_id: std::collections::HashMap<String, Value> = session_msgs.into_iter()
            .filter_map(|message| message.get("id").and_then(Value::as_str)
                .map(|id| (id.to_string(), message.clone())))
            .collect();
        let mut name_by_id: std::collections::HashMap<u64, String> = std::collections::HashMap::new();
        let distinct_ids: Vec<u64> = {
            let mut seen: std::collections::HashSet<u64> =
                typed_msgs.iter().map(|m| m.author_user_id).collect();
            seen.into_iter().collect()
        };
        for id in distinct_ids {
            if let Ok(Some(u)) = state.app.wdb.get_user(id).await {
                name_by_id.insert(id, u.username);
            }
        }
        typed_msgs
            .into_iter()
            .map(|m| {
                if let Some(cached) = cache_by_id.get(&m.message_id) { return cached.clone(); }
                let uname = m
                    .author_username
                    .clone()
                    .filter(|s| !s.is_empty())
                    .or_else(|| name_by_id.get(&m.author_user_id).cloned())
                    .unwrap_or_default();
                json!({
                    "id": m.message_id,
                    "userId": format!("user-{}", m.author_user_id),
                    "user": uname,
                    "timestamp": m.created_at_micros / 1000,
                    "text": m.content,
                    "type": m.message_type,
                    "authorDeviceId": m.author_device_id,
                    "editedAt": m.edited_at_micros.map(|e| e / 1000),
                    "commitSeq": m.commit_seq,
                    "isDeleted": m.is_deleted,
                    "isSpoiler": m.is_spoiler,
                    "encrypted": crate::api::e2ee::is_ciphertext(&m.content),
                    "files": m.files.iter().map(|f| json!({
                        "fileUrl": f.file_url, "fileName": f.file_name, "fileSize": f.file_size,
                    })).collect::<Vec<_>>(),
                })
            })
            .collect()
    };

    let payload = json!({ "channelId": channel_id, "messages": all, "hasMore": false });
    if let Err(e) = socket.emit("channel-messages", &payload) {
        warn!("[sio] channel-messages failed: {}", e);
    }

    // Emit a live-buffer-snapshot for live channels so the joining client
    // gets the current in-memory buffer (which may differ from WDB history).
    if is_live {
        let cap = state
            .app
            .live_channel_cap
            .read()
            .await
            .get(&channel_id)
            .copied()
            .unwrap_or(1000);
        let session = state.app.session_messages.read().await;
        let msgs: Vec<Value> = session
            .get(&channel_id)
            .map(|v| {
                let mut sorted = v.clone();
                sorted.sort_by_key(|m| m.get("timestamp").and_then(|v| v.as_i64()).unwrap_or(0));
                sorted.into_iter().rev().take(cap as usize).rev().collect()
            })
            .unwrap_or_default();
        drop(session);
        let snap = json!({ "channelId": channel_id.clone(), "messages": msgs });
        let _ = socket.emit("live-buffer-snapshot", &snap);
    }
}
