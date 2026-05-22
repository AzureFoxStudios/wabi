// Inline socket handlers extracted from wiring.rs

pub async fn handle_get_emojis(socket: SocketRef, state: &SioState) {
    match state.app.stdb.get_emotes().await {
        Ok(emotes) => {
            let _ = socket.emit("emojis-list", &json!(emotes));
        }
        Err(e) => {
            warn!("[sio] get-emojis failed: {}", e);
            let _ = socket.emit("emojis-list", &json!([]));
        }
    }
}

pub async fn handle_get_role_definitions(socket: SocketRef, io: &SocketIo, state: &SioState) {
    let roles: Vec<Value> = state.app.stdb.get_role_definitions().await.unwrap_or_default();
    let _ = socket.emit("role-definitions-updated", &json!({ "roles": roles }));
    let _ = io;
}

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

    if let Err(e) = state.app.stdb.upsert_role_definition(
        "default-workspace", role_name, role_name, 0, None, false,
    ).await {
        warn!("[sio] assign-role: failed to upsert role {}: {}", role_name, e);
    }

    if let Err(e) = state.app.stdb.ingest_event("rbac", "assign_role", &json!({
        "userId": target_user_id,
        "workspaceId": "default-workspace",
        "role": role_name,
        "assignedBy": caller_id,
    })).await {
        warn!("[sio] assign-role: failed to assign role: {}", e);
        let _ = socket.emit("assign-role-error", &json!({ "error": "Failed to assign role" }));
        return;
    }

    let roles: Vec<Value> = state.app.stdb.get_role_definitions().await.unwrap_or_default();
    drop(io.emit("role-definitions-updated", &json!({ "roles": roles })));
    drop(socket.emit("assign-role-success", &json!({ "targetUserId": target_user_id, "role": role_name })));
}

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

    if let Err(e) = state.app.stdb.ingest_event("rbac", "remove_role", &json!({
        "userId": target_user_id,
        "workspaceId": "default-workspace",
        "role": role_name,
    })).await {
        warn!("[sio] remove-role: failed: {}", e);
    }

    let roles: Vec<Value> = state.app.stdb.get_role_definitions().await.unwrap_or_default();
    drop(io.emit("role-definitions-updated", &json!({ "roles": roles })));
}

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

    let mut row = serde_json::Map::new();
    row.insert("channel_id".to_string(), json!(channel_id.clone()));
    if let Some(min_role) = data.get("minRole").and_then(|v| v.as_str()) {
        row.insert("min_role".to_string(), json!(min_role));
    }
    if let Some(name) = data.get("name").and_then(|v| v.as_str()) {
        row.insert("name".to_string(), json!(name));
    }
    if let Some(desc) = data.get("description").and_then(|v| v.as_str()) {
        row.insert("description".to_string(), json!(desc));
    }

    if let Err(e) = state.app.stdb.ingest_event("channel", "update_settings", &json!({ "row": row })).await {
        warn!("[sio] update-channel-settings failed: {}", e);
        let _ = socket.emit("channel-settings-error", &json!({ "error": "Failed to update settings" }));
        return;
    }

    let _ = socket.emit("channel-settings-updated", &json!({ "channelId": channel_id }));
    let _ = io.broadcast().emit("channel-updated", &json!({ "channelId": channel_id })).await;
}

pub async fn handle_set_role_display_name(socket: SocketRef, data: Value, state: &SioState, io: &SocketIo) {
    let token = socket.extensions.get::<AuthToken>().map(|t| t.0.clone()).unwrap_or_default();
    let caller_id = user_id_from_token(&token, &state.app.config.jwt_secret).unwrap_or(-1);
    if !state.app.is_admin(caller_id).await {
        warn!("[sio] set-role-display-name: user {} not authorized", caller_id);
        return;
    }

    let role_name = data.get("roleName").and_then(|v| v.as_str()).unwrap_or("");
    let display_name = data.get("displayName").and_then(|v| v.as_str()).unwrap_or("");

    if role_name.is_empty() {
        return;
    }

    if let Err(e) = state.app.stdb.upsert_role_definition(
        "default-workspace",
        role_name,
        if display_name.is_empty() { role_name } else { display_name },
        0, None, false,
    ).await {
        warn!("[sio] set-role-display-name: failed to update role {}: {}", role_name, e);
    }

    let roles: Vec<Value> = state.app.stdb.get_role_definitions().await.unwrap_or_default();
    drop(io.emit("role-definitions-updated", &json!({ "roles": roles })));
}
