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
    let Some(identity) = resolve_sio_identity(&socket) else {
        let _ = socket.emit("auth-required", &json!({ "reason": "authentication required" }));
        return;
    };

    let user_id_num = identity.user_id;
    let authed_username = identity.username;

    let stable_id = if user_id_num > 0 {
        format!("user-{}", user_id_num)
    } else {
        socket.id.to_string()
    };

    // Join a room named after stable_id so io.to(stable_id) routes here
    socket.join(stable_id.clone());

    let color = state
        .app
        .wdb
        .get_user_by_username(&authed_username)
        .await
        .ok()
        .flatten()
        .map(|u| u.color)
        .unwrap_or_else(|| "#98D8C8".to_string());

    let connected_user = ConnectedUser {
        stable_id: stable_id.clone(),
        db_user_id: if user_id_num > 0 {
            Some(user_id_num)
        } else {
            None
        },
        username: authed_username.clone(),
        color: color.clone(),
        last_seen_micros: now_micros(),
    };

    // Register in presence map
    {
        let mut connected = state.connected_users.write().await;
        connected.insert(socket.id.to_string(), connected_user.clone());
    }

    let owner_id = *state.app.owner_user_id.read().await;

    // Full registered-user directory (online + offline). The frontend renders
    // this as the greyed-out "Offline" section (serverMembers minus online
    // users) and the admin user registry. Previously hardcoded empty, which
    // made every registered-but-offline account invisible in the People panel.
    let server_members: Vec<Value> = {
        let users = state.app.wdb.list_users().await.unwrap_or_default();
        let mut views = Vec::with_capacity(users.len());
        for u in users {
            views.push(
                build_user_view(
                    &state,
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
                .await,
            );
        }
        views
    };

    let online_users: Vec<Value> = {
        let connected = state.connected_users.read().await;
        let mut views = Vec::new();
        for u in connected.values() {
            views.push(connected_user_to_view(u, owner_id, &state).await);
        }
        views
    };

    let mut channels: Vec<Value> = state
        .app
        .wdb
        .get_channels_raw()
        .await
        .unwrap_or_default()
        .iter()
        .map(row_to_channel_view)
        .collect();
    // Mark breakout rooms so clients can group them under their parent —
    // the flag lives in-memory (state.breakout_rooms), not on the channel row.
    merge_breakout_flags(&state, &mut channels).await;

    let init = json!({
        "channels": channels,
        "users": online_users,
        "serverMembers": server_members,
        "emotes": [],
        "emojis": [],
        "roleDefinitions": [],
        "voiceState": {},
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

/// Validate and normalize a user-submitted profile string field.
/// Rejects overly long values and control characters.
fn sanitize_profile_text(input: &str, max_len: usize) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.len() > max_len {
        return None;
    }
    if trimmed.chars().any(|c| c.is_control() && c != '\n' && c != '\t') {
        return None;
    }
    Some(trimmed.to_string())
}

/// Validate an avatar URL. Only same-origin relative paths and https URLs
/// are allowed, to prevent javascript:/data: injection.
fn sanitize_avatar_url(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with("/uploads/")
        || trimmed.starts_with("/api/")
        || trimmed.starts_with("https://")
    {
        return Some(trimmed.to_string());
    }
    None
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
    let root: Value = serde_json::from_str(&stored.layout_json).ok()?;
    root.get("profile_media").and_then(|v| v.as_object().cloned())
}

/// Extract `banner_url` / `overlay_url` from a profile_media map.
fn media_banner_overlay(
    media: &serde_json::Map<String, Value>,
) -> (Option<String>, Option<String>) {
    let banner_url = media.get("banner_url").and_then(|v| v.as_str()).map(String::from);
    let overlay_url = media.get("overlay_url").and_then(|v| v.as_str()).map(String::from);
    (banner_url, overlay_url)
}

/// Build a full `UserView` (with profile fields) for broadcast.
///
/// The profile fields are passed in (not re-read from the store) because
/// `update_user` commits through WabiDB's async projection dispatcher: a
/// read issued immediately after a write can race the dispatcher and return
/// the stale pre-update row. Broadcasting that stale row (e.g. a missing
/// `profilePicture`) makes clients merge the old value over the optimistic
/// one — the avatar "doesn't stick". Callers merge the just-applied patch
/// into the previous profile and pass the merged values here.
///
/// The same race applies to `profile_media` (stored in `user_layout`): when
/// `None`, it is read from the store; callers that just wrote it pass the
/// merged map instead.
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
    let owner_id = *state.app.owner_user_id.read().await;
    let role = highest_role(if db_user_id > 0 { Some(db_user_id) } else { None }, owner_id);

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

    json!({
        "id": stable_id,
        "username": username,
        "color": color,
        "status": "active",
        "handle": null,
        "profilePicture": profile_picture,
        "bannerUrl": banner_url,
        "overlayUrl": overlay_url,
        "bio": bio,
        "statusMessage": status_message,
        "dbUserId": if db_user_id > 0 { Some(db_user_id) } else { None },
        "roles": [role],
        "highestRole": role,
        "usernameFont": username_font.and_then(|s| serde_json::from_str::<Value>(&s).ok()),
        "isRegistered": is_registered,
    })
}

/// Handle `update-profile` (and the legacy `n`) socket event: patch the
/// authenticated user's profile fields and broadcast the updated `UserView`.
#[allow(dead_code)]
async fn on_update_profile(
    socket: SocketRef,
    data: Value,
    state: SioState,
    io: SocketIo,
) {
    let identity = match resolve_sio_identity(&socket) {
        Some(id) => id,
        None => {
            let _ = socket.emit(
                "profile-update-failed",
                &json!({ "reason": "authentication required" }),
            );
            return;
        }
    };

    // Revocation check (async, cannot run at handshake)
    let token = socket
        .extensions
        .get::<AuthToken>()
        .map(|t| t.0.clone())
        .unwrap_or_default();
    if socket_token_revoked(&state.app, &token).await {
        let _ = socket.emit(
            "profile-update-failed",
            &json!({ "reason": "session revoked; please sign in again" }),
        );
        return;
    }

    let db_user_id = identity.user_id;
    let username = identity.username;

    if db_user_id <= 0 {
        let _ = socket.emit(
            "profile-update-failed",
            &json!({ "reason": "authentication required" }),
        );
        return;
    }

    let mut updates = wabidb::domain::UserUpdate::default();

    if let Some(v) = data.get("profilePicture").and_then(|v| v.as_str()) {
        match sanitize_avatar_url(v) {
            Some(url) => updates.profile_picture = Some(url),
            None => {
                let _ = socket.emit(
                    "profile-update-failed",
                    &json!({ "reason": "invalid profilePicture url" }),
                );
                return;
            }
        }
    }
    if let Some(v) = data.get("usernameFont") {
        // Accept either a string (legacy) or an object {family,size,weight,style}.
        let encoded = if let Some(s) = v.as_str() {
            if s.is_empty() {
                None
            } else {
                Some(serde_json::json!({ "family": s }).to_string())
            }
        } else if v.is_object() {
            let family = v.get("family").and_then(|x| x.as_str()).map(|s| s.to_string());
            let size = v.get("size").and_then(|x| x.as_str()).map(|s| s.to_string());
            let weight = v.get("weight").and_then(|x| x.as_str()).map(|s| s.to_string());
            let style = v.get("style").and_then(|x| x.as_str()).map(|s| s.to_string());
            if family.is_none() && size.is_none() && weight.is_none() && style.is_none() {
                None
            } else {
                Some(serde_json::json!({
                    "family": family,
                    "size": size,
                    "weight": weight,
                    "style": style,
                }).to_string())
            }
        } else {
            None
        };
        updates.username_font = encoded;
    }
    if let Some(v) = data.get("username").and_then(|v| v.as_str()) {
        match sanitize_profile_text(v, 32) {
            Some(name) => updates.username = Some(name),
            None => {
                let _ = socket.emit(
                    "profile-update-failed",
                    &json!({ "reason": "invalid username" }),
                );
                return;
            }
        }
    }
    if let Some(v) = data.get("bio").and_then(|v| v.as_str()) {
        updates.bio = sanitize_profile_text(v, 280);
    }
    if let Some(v) = data.get("status").and_then(|v| v.as_str()) {
        updates.status_message = sanitize_profile_text(v, 120);
    }
    if let Some(v) = data.get("color").and_then(|v| v.as_str()) {
        // Prefix with NUL so the projection can distinguish "set" from "unchanged".
        updates.color = Some(format!("\0{}", v));
    }

    // Avatar banner + pfp overlay live in `profile_media` inside the user's
    // layout record. Merge the just-applied patch here (same B6 race guard as
    // the profile fields below): the merged map is passed straight into the
    // broadcast view instead of re-reading the store after the write.
    let mut media_patch: Option<serde_json::Map<String, Value>> = None;
    if data.get("bannerUrl").is_some() || data.get("overlayUrl").is_some() {
        let mut media = profile_media_for(&state, db_user_id).await.unwrap_or_default();
        if let Some(v) = data.get("bannerUrl") {
            let value = match v.as_str() {
                Some(s) if !s.trim().is_empty() => match sanitize_avatar_url(s) {
                    Some(url) => Value::String(url),
                    None => {
                        let _ = socket.emit(
                            "profile-update-failed",
                            &json!({ "reason": "invalid bannerUrl" }),
                        );
                        return;
                    }
                },
                _ => Value::Null,
            };
            media.insert("banner_url".into(), value);
        }
        if let Some(v) = data.get("overlayUrl") {
            let value = match v.as_str() {
                Some(s) if !s.trim().is_empty() => match sanitize_avatar_url(s) {
                    Some(url) => Value::String(url),
                    None => {
                        let _ = socket.emit(
                            "profile-update-failed",
                            &json!({ "reason": "invalid overlayUrl" }),
                        );
                        return;
                    }
                },
                _ => Value::Null,
            };
            media.insert("overlay_url".into(), value);
        }
        media_patch = Some(media);
    }

    // Snapshot the pre-update profile BEFORE the write. `update_user` persists
    // through the async projection dispatcher, so a post-write read can race it
    // and broadcast a stale view (e.g. missing a just-uploaded profile picture),
    // which clients merge over the optimistic value (B6 fix).
    let current = state
        .app
        .wdb
        .get_user(db_user_id as u64)
        .await
        .ok()
        .flatten();
    let color = current
        .as_ref()
        .map(|u| u.color.clone())
        .unwrap_or_else(|| "#98D8C8".to_string());

    // Mirror the merge semantics of `WdbAdapter::update_user` /
    // `UsersProjection::apply` so the broadcast view reflects the just-applied
    // patch regardless of projection timing.
    let merged_profile_picture = updates
        .profile_picture
        .clone()
        .or_else(|| current.as_ref().and_then(|u| u.profile_picture.clone()));
    let merged_username_font = updates
        .username_font
        .clone()
        .or_else(|| current.as_ref().and_then(|u| u.username_font.clone()));
    let merged_bio = updates
        .bio
        .clone()
        .or_else(|| current.as_ref().and_then(|u| u.bio.clone()));
    let merged_status_message = updates
        .status_message
        .clone()
        .or_else(|| current.as_ref().and_then(|u| u.status_message.clone()));
    let merged_color = updates
        .color
        .as_deref()
        .map(|c| c.strip_prefix('\0').unwrap_or(c).to_string())
        .unwrap_or_else(|| color.clone());
    let merged_username = updates
        .username
        .clone()
        .unwrap_or_else(|| username.clone());

    match state.app.wdb.update_user(db_user_id as u64, updates).await {
        Ok(()) => {
            // Persist the banner/overlay patch into the user's layout record
            // (keeps the `profile_media` JSON blob next to layout + theme).
            if let Some(media) = &media_patch {
                let existing = state
                    .app
                    .wdb
                    .get_user_layout(db_user_id as u64)
                    .await
                    .ok()
                    .flatten()
                    .and_then(|l| serde_json::from_str::<Value>(&l.layout_json).ok())
                    .unwrap_or_else(|| json!({}));
                let combined = json!({
                    "layout": existing.get("layout").cloned().unwrap_or_else(|| existing.clone()),
                    "theme": existing.get("theme").cloned().unwrap_or_else(|| json!({})),
                    "profile_media": media,
                });
                if let Ok(serialized) = serde_json::to_string(&combined) {
                    let _ = state
                        .app
                        .wdb
                        .upsert_user_layout(db_user_id as u64, &serialized)
                        .await;
                }
            }

            let view = build_user_view(
                &state,
                db_user_id,
                &merged_username,
                &merged_color,
                merged_profile_picture,
                merged_username_font,
                merged_bio,
                merged_status_message,
                current
                    .as_ref()
                    .map(|u| !u.password_hash.is_empty())
                    .unwrap_or(false),
                media_patch,
            )
            .await;
            let _ = socket.emit("profile-updated", &view);
            let _ = io.to(format!("user-{}", db_user_id)).emit("user-updated", &view);
            let _ = socket.broadcast().emit("user-updated", &view);
        }
        Err(e) => {
            warn!("[sio] update-profile failed: {}", e);
            let _ = socket.emit(
                "profile-update-failed",
                &json!({ "reason": "failed to persist profile" }),
            );
        }
    }
}

#[allow(dead_code)]
async fn on_disconnect(socket: SocketRef, state: SioState, io: SocketIo) {
    let socket_id = socket.id.to_string();
    info!("[sio] disconnected: {}", socket_id);

    let departed = {
        let mut connected = state.connected_users.write().await;
        connected.remove(&socket_id)
    };

    if let Some(user) = &departed {
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
    let departed_stable = departed
        .as_ref()
        .map(|u| u.stable_id.clone())
        .unwrap_or_else(|| socket_id.clone());
    let group_call_lefts: Vec<(String, Vec<String>)> = {
        let mut sessions = state.group_call_sessions.write().await;
        let mut lefts = Vec::new();
        let mut to_remove = Vec::new();

        for (channel_id, session) in sessions.iter_mut() {
            let was_in = session.connected_participants.remove(&departed_stable)
                || session.invited_participants.remove(&departed_stable);
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
                        "userId": socket_id
                    }),
                )
                .await;
        }
    }

    // Broadcast call-ended so DM call partners can clean up
    let _ = io
        .emit("call-ended", &json!({ "userId": departed_stable }))
        .await;
}

#[allow(dead_code)]
async fn on_join_channel(socket: SocketRef, channel_id: String, state: SioState) {
    // Resolve identity — unauthenticated sockets cannot join any room.
    let Some(identity) = resolve_identity(&socket, &state).await else {
        let _ = socket.emit("join-error", &json!({ "channelId": &channel_id, "error": "authentication required" }));
        return;
    };
    let user_id = identity.user_id;

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

    let all: Vec<Value> = if !session_msgs.is_empty() {
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
        // Fall back to WDB for persisted messages when the in-memory
        // session cache is empty (e.g. after page reload). Map the domain
        // Message to the frontend protocol shape (id, userId, user, timestamp).
        // Resolve author usernames so the client shows a real name (and a
        // `user-<dbId>` id it can look up in its cache) instead of a bare
        // numeric id + empty username that renders as "Unknown user".
        let typed_msgs = state
            .app
            .wdb
            .list_messages_typed(&channel_id, 50)
            .await
            .unwrap_or_default();
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
    let is_live = state
        .app
        .channel_auto_delete_label
        .read()
        .await
        .get(&channel_id)
        .map(|s| s == "live")
        .unwrap_or(false);
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

