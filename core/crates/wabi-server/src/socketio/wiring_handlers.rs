// WDB-compat shim: this file calls `state.app.wdb.X(...)` for
// methods the WDB doesn't have equivalents for yet
// (is_user_muted, get_channel_retention, mute_user, etc.).
// The compat WdbClient in `db/` returns no-op defaults for all
// of these. When WDB has the corresponding engine methods, this
// file can be migrated to use `state.app.wdb.X(...)` instead.
// The compat shim itself is a temporary layer and will be removed
// once the last socketio file is migrated.
//
// Inline socket handlers extracted from wiring.rs

use wabidb::domain::MemberRole;

#[allow(dead_code)]
pub async fn handle_get_emojis(socket: SocketRef, state: &SioState) {
    match state.app.wdb.get_emotes().await {
        Ok(emotes) => {
            let _ = socket.emit("emojis-list", &json!(emotes));
        }
        Err(e) => {
            warn!("[sio] get-emojis failed: {}", e);
            let _ = socket.emit("emojis-list", &json!([]));
        }
    }
}

/// Delete a custom emoji by name. Admin-only: emotes are server-wide assets.
/// Payload may be a plain string name or `{ name: ... }`.
#[allow(dead_code)]
pub async fn handle_delete_emoji(
    socket: SocketRef,
    data: Value,
    state: &SioState,
    io: &SocketIo,
) {
    let name = data
        .as_str()
        .map(|s| s.to_string())
        .or_else(|| data.get("name").and_then(|v| v.as_str()).map(|s| s.to_string()))
        .unwrap_or_default();
    if name.is_empty() {
        let _ = socket.emit("delete-emoji-error", &json!({ "error": "Missing emoji name" }));
        return;
    }

    let token = socket.extensions.get::<AuthToken>().map(|t| t.0.clone()).unwrap_or_default();
    let caller_id = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);
    if !state.app.is_admin(caller_id).await {
        warn!("[sio] delete-emoji: user {} not authorized", caller_id);
        let _ = socket.emit("delete-emoji-error", &json!({ "error": "Only admins can delete emojis" }));
        return;
    }

    if let Err(e) = state.app.wdb.delete_emote(&name).await {
        warn!("[sio] delete-emoji failed: {}", e);
        let _ = socket.emit("delete-emoji-error", &json!({ "error": "Failed to delete emoji" }));
        return;
    }

    let emotes = state.app.wdb.get_emotes().await.unwrap_or_default();
    drop(io.emit("emojis-list", &json!(emotes)).await);
    let _ = socket.emit("delete-emoji-success", &json!({ "name": name }));
}

#[allow(dead_code)]
pub async fn handle_get_role_definitions(socket: SocketRef, io: &SocketIo, state: &SioState) {
    let roles = state.app.wdb.list_role_definitions("default-workspace").await.unwrap_or_default();
    let _ = socket.emit("role-definitions-updated", &json!({ "roles": roles }));
    let _ = io;
}

#[allow(dead_code)]
pub async fn handle_assign_role(socket: SocketRef, data: Value, state: &SioState, io: &SocketIo) {
    let target_user_id = data.get("targetUserId").and_then(|v| v.as_i64()).unwrap_or(0);
    let role_name = data.get("roleName").and_then(|v| v.as_str()).unwrap_or("");

    if target_user_id <= 0 || role_name.is_empty() {
        warn!("[sio] assign-role: invalid params targetUserId={} roleName={}", target_user_id, role_name);
        return;
    }

    let token = socket.extensions.get::<AuthToken>().map(|t| t.0.clone()).unwrap_or_default();
    let caller_id = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);
    if !state.app.is_admin(caller_id).await {
        warn!("[sio] assign-role: user {} not authorized", caller_id);
        let _ = socket.emit("assign-role-error", &json!({ "error": "Only admins can assign roles" }));
        return;
    }

    let role = match role_name {
        "Admin" => MemberRole::Admin,
        "Moderator" => MemberRole::Moderator,
        "Owner" => MemberRole::Owner,
        _ => MemberRole::Member,
    };

    // The server owner is protected: cannot be demoted or reassigned by
    // anyone (including other admins). Only the owner may grant the Owner
    // role, and only to themselves or another user.
    let target_is_owner = state.app.is_owner(target_user_id).await;
    if target_is_owner && role != MemberRole::Owner {
        warn!("[sio] assign-role: refusing to demote server owner {}", target_user_id);
        let _ = socket.emit("assign-role-error", &json!({ "error": "The server owner's role cannot be changed" }));
        return;
    }
    if role == MemberRole::Owner {
        // Ownership transfer is handled by a dedicated endpoint (Phase 2);
        // this path may only reaffirm the current owner, never mint a
        // second owner that the `is_owner` check wouldn't recognize.
        if !state.app.is_owner(caller_id).await || target_user_id != caller_id {
            warn!("[sio] assign-role: illegal Owner assignment by {}", caller_id);
            let _ = socket.emit("assign-role-error", &json!({ "error": "Ownership transfer is not permitted here" }));
            return;
        }
    }

    if let Err(e) = state.app.wdb.upsert_member_role(
        "", target_user_id as u64, role,
    ).await {
        warn!("[sio] assign-role: failed to upsert member role {}: {}", role_name, e);
    }

    if let Err(e) = state.app.wdb.ingest_event("rbac", "assign_role", &json!({
        "userId": target_user_id,
        "workspaceId": "default-workspace",
        "role": role_name,
        "assignedBy": caller_id,
    })).await {
        warn!("[sio] assign-role: failed to assign role: {}", e);
        let _ = socket.emit("assign-role-error", &json!({ "error": "Failed to assign role" }));
        return;
    }

    let roles = state.app.wdb.list_role_definitions("default-workspace").await.unwrap_or_default();
    drop(io.emit("role-definitions-updated", &json!({ "roles": roles })));
    drop(socket.emit("assign-role-success", &json!({ "targetUserId": target_user_id, "role": role_name })));
}

pub async fn handle_toggle_reception(socket: SocketRef, data: Value, state: &SioState, io: &SocketIo) {
    let token = socket.extensions.get::<AuthToken>().map(|t| t.0.clone()).unwrap_or_default();
    let caller_id = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);
    if !state.app.is_owner(caller_id).await {
        warn!("[sio] toggle-reception: user {} not authorized", caller_id);
        let _ = socket.emit("toggle-reception-error", &json!({ "error": "Only the server owner can manage Reception" }));
        return;
    }

    let enabled = data.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
    if enabled {
        let _ = io.emit("toggle-reception-success", &json!({ "enabled": true }));
    } else {
        let _ = io.emit("toggle-reception-success", &json!({ "enabled": false }));
    }
}

#[allow(dead_code)]
pub async fn handle_remove_role(socket: SocketRef, data: Value, state: &SioState, io: &SocketIo) {
    let target_user_id = data.get("targetUserId").and_then(|v| v.as_i64()).unwrap_or(0);
    let role_name = data.get("roleName").and_then(|v| v.as_str()).unwrap_or("");

    if target_user_id <= 0 || role_name.is_empty() {
        return;
    }

    let token = socket.extensions.get::<AuthToken>().map(|t| t.0.clone()).unwrap_or_default();
    let caller_id = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);
    if !state.app.is_admin(caller_id).await {
        warn!("[sio] remove-role: user {} not authorized", caller_id);
        return;
    }

    // The server owner's role can never be removed.
    if state.app.is_owner(target_user_id).await {
        warn!("[sio] remove-role: refusing to remove role from owner {}", target_user_id);
        return;
    }

    if let Err(e) = state.app.wdb.ingest_event("rbac", "remove_role", &json!({
        "userId": target_user_id,
        "workspaceId": "default-workspace",
        "role": role_name,
    })).await {
        warn!("[sio] remove-role: failed: {}", e);
    }

    let roles = state.app.wdb.list_role_definitions("default-workspace").await.unwrap_or_default();
    drop(io.emit("role-definitions-updated", &json!({ "roles": roles })));
}

#[allow(dead_code)]
pub async fn handle_update_channel_settings(socket: SocketRef, data: Value, state: &SioState, io: &SocketIo) {
    let channel_id = match data.get("channelId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return,
    };

    let token = socket.extensions.get::<AuthToken>().map(|t| t.0.clone()).unwrap_or_default();
    let caller_id = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);
    if !state.app.is_admin(caller_id).await {
        warn!("[sio] update-channel-settings: user {} not authorized", caller_id);
        return;
    }

    // Frontend emits { channelId, settings: { name, description, autoDeleteAfter, ... } }
    // Accept flat fields too for older clients.
    let settings = data.get("settings").cloned().unwrap_or_else(|| data.clone());

    let mut row = serde_json::Map::new();
    row.insert("channel_id".to_string(), json!(channel_id.clone()));
    if let Some(min_role) = settings.get("minRole").and_then(|v| v.as_str()) {
        row.insert("min_role".to_string(), json!(min_role));
    }
    if let Some(name) = settings.get("name").and_then(|v| v.as_str()) {
        row.insert("name".to_string(), json!(name));
    }
    if let Some(desc) = settings.get("description").and_then(|v| v.as_str()) {
        row.insert("description".to_string(), json!(desc));
    }
    if let Some(force_spoiler) = settings.get("forceSpoiler").and_then(|v| v.as_bool()) {
        row.insert("force_spoiler".to_string(), json!(force_spoiler));
    }
    if let Some(pos) = settings.get("position").and_then(|v| v.as_i64()) {
        row.insert("position".to_string(), json!(pos as i32));
    }
    if let Some(parent) = settings.get("parentId").and_then(|v| v.as_str()) {
        row.insert("parent_id".to_string(), json!(parent));
    }
    if settings.get("parentId").and_then(|v| v.as_null()).is_some() {
        row.insert("parent_id".to_string(), json!(serde_json::Value::Null));
    }

    // Auto-delete / retention presets (5s..90d or null/off = keep forever opt-in,
    // or "live" = session-only, never persisted to WabiDB).
    let mut auto_delete_after: Option<String> = None;
    if settings.get("autoDeleteAfter").is_some() {
        if settings.get("autoDeleteAfter").and_then(|v| v.as_str()) == Some("live") {
            // Live session room: no durable writes, no timed delete. Mark via the
            // in-memory label sentinel "live" (checked by channel_is_live on send).
            // Clear any ms timer and drop the durable retention policy so a restart
            // does not resurrect timed/forever behavior for this channel.
            state.app.channel_auto_delete_ms.write().await.remove(&channel_id);
            state
                .app
                .channel_auto_delete_label
                .write()
                .await
                .insert(channel_id.clone(), "live".to_string());
            let _ = state
                .app
                .wdb
                .upsert_channel_retention(&channel_id, 0, caller_id as u64)
                .await;
            auto_delete_after = Some("live".to_string());

            // Optional per-channel live TTL and cap.
            if let Some(ttl) = settings.get("liveTtlMs").and_then(|v| v.as_u64()) {
                state.app.live_channel_ttl_ms.write().await.insert(channel_id.clone(), ttl);
            }
            if let Some(cap) = settings.get("liveCap").and_then(|v| v.as_u64()) {
                state.app.live_channel_cap.write().await.insert(channel_id.clone(), cap);
            }
        } else if settings.get("autoDeleteAfter").and_then(|v| v.as_null()).is_some() {
            // explicit null -> keep forever (opt-in persistence)
            state.app.channel_auto_delete_ms.write().await.remove(&channel_id);
            state
                .app
                .channel_auto_delete_label
                .write()
                .await
                .insert(channel_id.clone(), "forever".to_string());
            let _ = state
                .app
                .wdb
                .upsert_channel_retention(&channel_id, 0, caller_id as u64)
                .await;
            auto_delete_after = None;
        } else if let Some(label) = settings.get("autoDeleteAfter").and_then(|v| v.as_str()) {
            if let Some(ms) = parse_retention_label_to_ms(label) {
                state
                    .app
                    .channel_auto_delete_ms
                    .write()
                    .await
                    .insert(channel_id.clone(), ms);
                state
                    .app
                    .channel_auto_delete_label
                    .write()
                    .await
                    .insert(channel_id.clone(), label.to_string());
                // Mirror coarse days into WDB when >= 1 day
                let days = (ms / 86_400_000) as u32;
                let _ = state
                    .app
                    .wdb
                    .upsert_channel_retention(&channel_id, days.max(if ms >= 86_400_000 { 1 } else { 0 }), caller_id as u64)
                    .await;
                auto_delete_after = Some(label.to_string());
            }
        }
    }

    if let Err(e) = state.app.wdb.ingest_event("channel", "update_settings", &json!({ "row": row.clone() })).await {
        warn!("[sio] update-channel-settings failed: {}", e);
        let _ = socket.emit("channel-settings-error", &json!({ "error": "Failed to update settings" }));
        return;
    }

    // Mirror the patch into the `channels` projection so flags like
    // `force_spoiler` persist and survive reload. Only fields that were
    // actually present in the request are included.
    let mut patch = serde_json::Map::new();
    patch.insert("channel_id".to_string(), json!(channel_id.clone()));
    if let Some(name) = settings.get("name").and_then(|v| v.as_str()) {
        patch.insert("name".to_string(), json!(name));
    }
    if let Some(desc) = settings.get("description").and_then(|v| v.as_str()) {
        patch.insert("description".to_string(), json!(desc));
    }
    if let Some(force) = settings.get("forceSpoiler").and_then(|v| v.as_bool()) {
        patch.insert("force_spoiler".to_string(), json!(force));
    }
    if let Some(pos) = settings.get("position").and_then(|v| v.as_i64()) {
        patch.insert("position".to_string(), json!(pos as i32));
    }
    if let Some(parent) = settings.get("parentId").and_then(|v| v.as_str()) {
        patch.insert("parent_id".to_string(), json!(parent));
    }
    if settings.get("parentId").and_then(|v| v.as_null()).is_some() {
        patch.insert("parent_id".to_string(), json!(serde_json::Value::Null));
    }
    if let Err(e) = state.app.wdb.ingest_event("channel", "update", &json!({ "row": patch })).await {
        warn!("[sio] update-channel settings projection merge failed: {}", e);
    }

    let payload = json!({
        "channelId": channel_id,
        "id": channel_id,
        "autoDeleteAfter": auto_delete_after,
        "name": settings.get("name"),
        "description": settings.get("description"),
        "forceSpoiler": settings.get("forceSpoiler"),
    });
    let _ = socket.emit("channel-settings-updated", &payload);
    let _ = io.broadcast().emit("channel-updated", &payload).await;
}

/// Parse frontend retention labels ("5s", "1m", "24h", "7d", ...) to milliseconds.
fn parse_retention_label_to_ms(label: &str) -> Option<u64> {
    let s = label.trim().to_lowercase();
    if s.is_empty() || s == "never" || s == "off" || s == "forever" {
        return None;
    }
    let (num, unit) = s.split_at(s.find(|c: char| c.is_ascii_alphabetic()).unwrap_or(s.len()));
    let n: u64 = num.parse().ok()?;
    let mult = match unit {
        "s" | "sec" | "secs" | "second" | "seconds" => 1_000u64,
        "m" | "min" | "mins" | "minute" | "minutes" => 60_000,
        "h" | "hr" | "hrs" | "hour" | "hours" => 3_600_000,
        "d" | "day" | "days" => 86_400_000,
        _ => return None,
    };
    Some(n.saturating_mul(mult))
}

#[allow(dead_code)]
pub async fn handle_set_role_display_name(socket: SocketRef, data: Value, state: &SioState, io: &SocketIo) {
    let token = socket.extensions.get::<AuthToken>().map(|t| t.0.clone()).unwrap_or_default();
    let caller_id = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);
    if !state.app.is_admin(caller_id).await {
        warn!("[sio] set-role-display-name: user {} not authorized", caller_id);
        return;
    }

    let role_name = data.get("roleName").and_then(|v| v.as_str()).unwrap_or("");
    let _display_name = data.get("displayName").and_then(|v| v.as_str()).unwrap_or("");

    if role_name.is_empty() {
        return;
    }

    let role = match role_name {
        "Admin" => MemberRole::Admin,
        "Moderator" => MemberRole::Moderator,
        "Owner" => MemberRole::Owner,
        _ => MemberRole::Member,
    };
    if let Err(e) = state.app.wdb.upsert_member_role(
        "", caller_id as u64, role,
    ).await {
        warn!("[sio] set-role-display-name: failed to update role {}: {}", role_name, e);
    }

    let roles = state.app.wdb.list_role_definitions("default-workspace").await.unwrap_or_default();
    drop(io.emit("role-definitions-updated", &json!({ "roles": roles })));
}
