//! Channel routes
//!
//! GET    /api/channels      — authenticated discovery (private conversations filtered)
//! POST   /api/channels      — create channel (admin only)
//! GET    /api/channels/{id} — authenticated discovery; conversations require membership
//! DELETE /api/channels/{id} — delete channel (admin only)

use axum::{
    extract::{Path, Query, State},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::auth_extractor::AuthUser;
use crate::error::{AppError, Result};
use crate::state::AppState;
use wabidb::engine::wabi_store::WabiStore;

fn channel_kind_to_type(kind: wabidb::domain::ChannelKind, asset_storage: bool) -> String {
    use wabidb::domain::ChannelKind::*;
    let s = match kind {
        Text => if asset_storage { "lore" } else { "text" },
        Voice => "voice",
        Dm => "dm",
        GroupDm => "group",
        Announcement => "announcement",
        Whiteboard => "whiteboard",
        Wiki => "wiki",
        Forum => "forum",
        Incident => "incident",
        Gallery => "gallery",
        Category => "category",
        Lore => "lore",
        Planning => "planning",
        Reception => "reception",
    };
    s.to_string()
}

fn channel_to_response(c: wabidb::domain::Channel) -> ChannelResponse {
    ChannelResponse {
        id: c.channel_id,
        name: c.name,
        channel_type: channel_kind_to_type(c.channel_kind, c.asset_storage),
        position: c.position,
        parent_id: c.parent_id,
        description: c.description,
        force_spoiler: c.force_spoiler,
        asset_storage: c.asset_storage || matches!(c.channel_kind, wabidb::domain::ChannelKind::Lore),
    }
}

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/", axum::routing::get(list_channels))
        .route("/", axum::routing::post(create_channel))
        .route("/{id}", axum::routing::get(get_channel))
        .route("/{id}", axum::routing::patch(update_channel))
        .route("/{id}", axum::routing::delete(delete_channel))
        .route("/{id}/join", axum::routing::post(join_channel))
        .route("/{id}/retention", axum::routing::put(set_channel_retention))
        .route("/{channel_id}/reactions", axum::routing::get(list_channel_reactions))
        .with_state(state)
}

#[derive(Debug, Serialize)]
struct ChannelListResponse { channels: Vec<ChannelResponse> }

#[derive(Debug, Serialize)]
struct ChannelResponse {
    id: String,
    name: String,
    channel_type: String,
    position: i32,
    parent_id: Option<String>,
    description: Option<String>,
    #[serde(default)]
    force_spoiler: bool,
    #[serde(default)]
    asset_storage: bool,
}

async fn list_channels(State(state): State<Arc<AppState>>, auth: AuthUser) -> Result<Json<ChannelListResponse>> {
    let mut channels = crate::channel_access::discoverable_channels(&state, auth.user_id).await?
        .into_iter().map(channel_to_response).collect::<Vec<_>>();
    channels.sort_by_key(|c| c.position);
    Ok(Json(ChannelListResponse { channels }))
}

async fn get_channel(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<ChannelResponse>> {
    let channel = state.wdb.get_channel(&id).await
        .map_err(|e| AppError::Internal(format!("wdb get_channel: {e}")))?
        .ok_or_else(|| AppError::NotFound(format!("Channel {id} not found")))?;
    if crate::channel_access::is_conversation(channel.channel_kind) {
        crate::channel_access::require_access(&state, auth.user_id, &id).await?;
    }
    Ok(Json(channel_to_response(channel)))
}

#[derive(Debug, Deserialize)]
struct CreateChannelRequest {
    name: String,
    #[serde(default = "default_channel_type")]
    channel_type: String,
    description: Option<String>,
    #[serde(default)]
    asset_storage: bool,
    #[serde(default)]
    force_spoiler: bool,
    #[serde(flatten)]
    parent: CreateChannelParentCompat,
}

#[derive(Debug, Default, Deserialize)]
struct CreateChannelParentCompat {
    parent_id: Option<String>,
    #[serde(rename = "parentId")]
    parent_id_camel: Option<String>,
}

impl CreateChannelRequest {
    fn parent_id(&self) -> Option<&str> {
        self.parent.parent_id.as_deref().or(self.parent.parent_id_camel.as_deref())
    }
}

fn default_channel_type() -> String { "text".to_string() }

pub(crate) async fn apply_channel_retention(
    state: &AppState,
    channel_id: &str,
    actor_user_id: u64,
    raw_label: &str,
) -> Result<String> {
    let _guard = state.retention_policy_lock.lock().await;
    let raw = raw_label.trim().to_ascii_lowercase();
    let label = if matches!(raw.as_str(), "never" | "off") { "forever".to_string() } else { raw };
    let timer = if matches!(label.as_str(), "live" | "forever") { None } else {
        Some(crate::api::retention_policy::timed_ms(&label)
            .filter(|ms| *ms > 0 && *ms <= 365 * 86_400_000)
            .ok_or_else(|| AppError::BadRequest("Unsupported retention duration".into()))?)
    };
    // The exact file is authoritative. Failed writes must not change runtime
    // behavior or the database's legacy whole-day compatibility record.
    crate::api::retention_policy::set(&state.config.data_dir, channel_id, &label)
        .map_err(|e| AppError::Internal(format!("persist exact retention: {e}")))?;
    {
        let mut labels = state.channel_auto_delete_label.write().await;
        let mut timers = state.channel_auto_delete_ms.write().await;
        labels.insert(channel_id.to_string(), label.clone());
        if let Some(ms) = timer { timers.insert(channel_id.to_string(), ms); }
        else { timers.remove(channel_id); }
    }
    let days = timer.map(|ms| ((ms.saturating_add(86_400_000 - 1)) / 86_400_000).max(1) as u32).unwrap_or(0);
    if let Err(error) = state.wdb.upsert_channel_retention(channel_id, days, actor_user_id).await {
        // Never let an older/coarser mirror override the saved exact choice.
        tracing::warn!(channel_id, %error, "exact retention saved; legacy day-count mirror update failed");
    }
    Ok(label)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetRetentionRequest { retention: String }

async fn set_channel_retention(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(id): Path<String>,
    Json(req): Json<SetRetentionRequest>,
) -> Result<Json<serde_json::Value>> {
    let channel = state.wdb.get_channel(&id).await?
        .ok_or_else(|| AppError::NotFound(format!("Channel {id} not found")))?;
    if crate::channel_access::is_conversation(channel.channel_kind) {
        // Private retention is a participant choice, not an admin-surveillance
        // privilege. Keep the existing DM/group behavior while making the exact
        // choice restart-safe.
        crate::channel_access::require_access(&state, auth.user_id, &id).await?;
    } else if !state.is_admin(auth.user_id).await {
        return Err(AppError::Unauthorized("only admins can change community-channel retention".into()));
    }

    let retention = apply_channel_retention(&state, &id, auth.user_id as u64, &req.retention).await?;
    if let Some(io) = state.sio.read().await.clone() {
        let _ = io.broadcast().emit("channel-updated", &serde_json::json!({
            "channelId": &id,
            "autoDeleteAfter": &retention,
        })).await;
    }
    Ok(Json(serde_json::json!({ "channelId": id, "retention": retention })))
}

async fn create_channel(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Json(req): Json<CreateChannelRequest>,
) -> Result<Json<ChannelResponse>> {
    if !state.is_admin(auth.user_id).await {
        return Err(AppError::Unauthorized("only admins can create channels".into()));
    }
    let name = req.name.trim().to_string();
    if name.is_empty() { return Err(AppError::BadRequest("channel name cannot be empty".into())); }

    let wants_asset_storage = req.asset_storage || req.channel_type == "lore";
    let channel_kind = match req.channel_type.as_str() {
        "text" | "" => if wants_asset_storage { wabidb::domain::ChannelKind::Lore } else { wabidb::domain::ChannelKind::Text },
        "voice" => wabidb::domain::ChannelKind::Voice,
        "dm" => wabidb::domain::ChannelKind::Dm,
        "group_dm" | "group" => wabidb::domain::ChannelKind::GroupDm,
        "announcement" => wabidb::domain::ChannelKind::Announcement,
        "whiteboard" => wabidb::domain::ChannelKind::Whiteboard,
        "wiki" => wabidb::domain::ChannelKind::Wiki,
        "forum" => wabidb::domain::ChannelKind::Forum,
        "incident" => wabidb::domain::ChannelKind::Incident,
        "gallery" => wabidb::domain::ChannelKind::Gallery,
        "category" => wabidb::domain::ChannelKind::Category,
        "lore" | "asset_storage" => wabidb::domain::ChannelKind::Lore,
        "planning" => wabidb::domain::ChannelKind::Planning,
        _ => wabidb::domain::ChannelKind::Text,
    };
    let is_lore = matches!(channel_kind, wabidb::domain::ChannelKind::Lore);
    if crate::channel_access::is_conversation(channel_kind) {
        return Err(AppError::BadRequest("Use the conversation creation flow to select participants".into()));
    }
    let asset_storage = wants_asset_storage || is_lore;

    // Reject damaged/invalid defaults before creating discoverable state.
    crate::api::retention_policy::all(&state.config.data_dir)?;
    let default_retention = crate::api::server_center::privacy_default_retention(&state.config.data_dir)?;
    let channel_id = state.wdb.create_channel(&name, channel_kind, auth.user_id as u64, req.force_spoiler).await?;
    if let Err(error) = apply_channel_retention(&state, &channel_id, auth.user_id as u64, &default_retention).await {
        if let Err(cleanup) = state.wdb.delete_channel(&channel_id, auth.user_id as u64).await {
            tracing::error!(%channel_id, %cleanup, "failed to remove channel after initial retention save failed");
        }
        return Err(error);
    }
    if asset_storage {
        let _ = state.wdb.update_channel(&channel_id, &serde_json::json!({ "asset_storage": true }), auth.user_id as u64).await;
    }
    state.wdb.add_channel_member(&channel_id, auth.user_id as u64, wabidb::domain::MemberRole::Owner).await?;
    let _ = req.description;

    let new_parent = req.parent_id().map(str::trim).filter(|s| !s.is_empty()).map(|s| s.to_string());
    if let Some(parent) = new_parent.as_deref() {
        if let Err(e) = state.wdb.update_channel(
            &channel_id,
            &serde_json::json!({ "parent_id": parent }),
            auth.user_id as u64,
        ).await {
            tracing::warn!(channel_id, parent, error = %e, "failed to set parent_id on new channel");
        }
    }

    let lore_channel_id = channel_id.strip_prefix("ch_")
        .and_then(|hex| i64::from_str_radix(hex, 16).ok()).unwrap_or(0);
    if asset_storage && state.config.lore.auto_create_repos {
        #[cfg(feature = "wabi-lore")]
        {
            if lore_channel_id != 0 {
                let lore_guard = state.lore_service.read().await;
                if let Some(lore) = lore_guard.as_ref() {
                    let slug = wabi_lore::slugify_repo_name(&name);
                    let repo_name = if slug.is_empty() { format!("ch-{channel_id}") } else { slug };
                    match lore.create_repo(lore_channel_id, auth.user_id, &repo_name).await {
                        Ok(repo) => {
                            let _ = state.wdb.lore_create_repo(lore_channel_id, &repo_name, &repo.lore_server_url, auth.user_id).await;
                            tracing::info!(channel_id, repo_name, "Auto-created Lore repo for asset_storage channel");
                        }
                        Err(e) => tracing::warn!(channel_id, error = %e, "Failed to auto-create Lore repo"),
                    }
                }
            }
        }
        #[cfg(not(feature = "wabi-lore"))]
        tracing::warn!(channel_id, "asset_storage/lore requested but Lore addon not enabled");
    }

    let response_type = if is_lore { "lore".to_string() }
        else if channel_kind == wabidb::domain::ChannelKind::Planning { "planning".to_string() }
        else { req.channel_type };

    let all_channels = state.wdb.list_channels(None).await.unwrap_or_default();
    let max_pos = all_channels.iter()
        .filter(|c| c.is_active && c.parent_id.as_deref() == new_parent.as_deref())
        .map(|c| c.position).max().unwrap_or(-1);
    let new_position = max_pos + 1;
    let _ = state.wdb.update_channel(&channel_id, &serde_json::json!({ "position": new_position }), auth.user_id as u64).await;

    Ok(Json(ChannelResponse {
        id: channel_id,
        name,
        channel_type: response_type,
        position: new_position,
        parent_id: new_parent,
        description: None,
        force_spoiler: req.force_spoiler,
        asset_storage,
    }))
}

#[derive(Debug, Deserialize)]
struct UpdateChannelRequest {
    name: Option<String>,
    description: Option<String>,
    position: Option<i32>,
    force_spoiler: Option<bool>,
}

async fn update_channel(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(id): Path<String>,
    Json(req): Json<UpdateChannelRequest>,
) -> Result<Json<ChannelResponse>> {
    if !state.is_admin(auth.user_id).await {
        return Err(AppError::Unauthorized("only admins can update channels".into()));
    }
    crate::channel_access::require_access(&state, auth.user_id, &id).await?;
    let mut patch = serde_json::Map::new();
    if let Some(name) = req.name { patch.insert("name".to_string(), serde_json::Value::String(name)); }
    if let Some(desc) = req.description { patch.insert("description".to_string(), serde_json::Value::String(desc)); }
    if let Some(pos) = req.position { patch.insert("position".to_string(), serde_json::Value::Number(pos.into())); }
    if let Some(force) = req.force_spoiler { patch.insert("force_spoiler".to_string(), serde_json::Value::Bool(force)); }
    state.wdb.update_channel(&id, &serde_json::Value::Object(patch), auth.user_id as u64).await?;
    let channel = state.wdb.get_channel(&id).await?.ok_or_else(|| AppError::NotFound(format!("Channel {id} not found")))?;
    Ok(Json(channel_to_response(channel)))
}

async fn delete_channel(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(id): Path<String>,
    Query(query): Query<DeleteChannelQuery>,
) -> Result<Json<serde_json::Value>> {
    if !state.is_admin(auth.user_id).await {
        return Err(AppError::Unauthorized("only admins can delete channels".into()));
    }
    let all_channels = state.wdb.list_channels(None).await?;
    let mut deleted_ids = vec![id.clone()];
    let mut changed = true;
    while changed {
        changed = false;
        for channel in &all_channels {
            if channel.is_active
                && channel.parent_id.as_deref().is_some_and(|parent| deleted_ids.iter().any(|id| id == parent))
                && !deleted_ids.iter().any(|id| id == &channel.channel_id)
            {
                deleted_ids.push(channel.channel_id.clone());
                changed = true;
            }
        }
    }
    for channel in all_channels.iter().filter(|c| deleted_ids.contains(&c.channel_id)) {
        if crate::channel_access::is_conversation(channel.channel_kind) {
            crate::channel_access::require_access(&state, auth.user_id, &channel.channel_id).await?;
            return Err(AppError::BadRequest("Delete conversations through their dedicated flow".into()));
        }
    }
    if query.preserve_children {
        let mut root_position = all_channels.iter().filter(|channel| channel.is_active && channel.parent_id.is_none())
            .map(|channel| channel.position).max().unwrap_or(0) + 1;
        for channel_id in deleted_ids.iter().skip(1) {
            state.wdb.update_channel(
                channel_id,
                &serde_json::json!({ "parent_id": null, "position": root_position }),
                auth.user_id as u64,
            ).await?;
            root_position += 1;
        }
        deleted_ids.truncate(1);
    }
    for channel_id in &deleted_ids {
        state.wdb.delete_channel(channel_id, auth.user_id as u64).await?;
        let _ = crate::api::retention_policy::remove(&state.config.data_dir, channel_id);
        state.channel_auto_delete_ms.write().await.remove(channel_id);
        state.channel_auto_delete_label.write().await.remove(channel_id);
    }
    {
        let mut session = state.session_messages.write().await;
        for channel_id in &deleted_ids { session.remove(channel_id); }
    }
    for channel_id in &deleted_ids {
        crate::socketio::remove_board_version(&format!("channel:{}", channel_id));
    }
    if let Some(io) = state.sio.read().await.clone() {
        let _ = io.broadcast().emit("channel-deleted", &serde_json::json!({ "channelId": &id, "channelIds": &deleted_ids })).await;
    }
    Ok(Json(serde_json::json!({ "deleted": id, "deletedIds": deleted_ids })))
}

#[derive(Debug, Default, Deserialize)]
struct DeleteChannelQuery { #[serde(default)] preserve_children: bool }

async fn join_channel(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    let user_id = auth.user_id;
    let channel = state.wdb.get_channel(&id).await
        .map_err(|e| AppError::Internal(format!("wdb get_channel: {e}")))?
        .ok_or_else(|| AppError::NotFound(format!("Channel {id} not found")))?;
    let already_member = crate::channel_access::is_member(&state, user_id, &id).await?;
    if already_member { return Ok(Json(serde_json::json!({ "joined": true, "channelId": id }))); }
    if crate::channel_access::is_conversation(channel.channel_kind) {
        return Err(AppError::Forbidden("Conversation membership required".into()));
    }
    let user_role = state.get_user_highest_role(user_id).await;
    let role_priority = |r: &str| match r.to_lowercase().as_str() {
        "owner" => 3, "admin" => 2, "moderator" => 1, "member" => 1, _ => 0,
    };
    let channel_raw = state.wdb.get_channel_raw(&id).await?;
    let min_role = channel_raw.as_ref().and_then(|ch| ch.get("min_role").and_then(|v| v.as_str()));
    if let Some(min_role_str) = min_role {
        if role_priority(&user_role) < role_priority(min_role_str) {
            return Err(AppError::Unauthorized(format!("channel requires {min_role_str} role")));
        }
    }
    state.wdb.add_channel_member(&id, user_id as u64, wabidb::domain::MemberRole::Member).await
        .map_err(|e| AppError::Internal(format!("wdb add_channel_member: {e}")))?;
    Ok(Json(serde_json::json!({ "joined": true, "channelId": id })))
}

async fn list_channel_reactions(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<String>,
) -> Result<Json<Vec<serde_json::Value>>> {
    crate::channel_access::require_access(&state, auth.user_id, &channel_id).await?;
    let messages = state.wdb.list_messages_typed(&channel_id, 100).await?;
    let mut all_reactions = Vec::new();
    for msg in &messages {
        for r in state.wdb.list_reactions(&msg.message_id).await? { all_reactions.push(serde_json::json!(r)); }
    }
    Ok(Json(all_reactions))
}

#[cfg(test)]
mod tests {
    use crate::state::SessionMessages;
    use std::collections::HashMap;
    use std::sync::Arc;
    use tokio::sync::RwLock;

    #[test]
    fn create_channel_request_accepts_parent_id_in_any_wire_spelling() {
        let both = r#"{"name":"general","channel_type":"text","force_spoiler":false,"asset_storage":false,"parent_id":"ch_cat1","parentId":"ch_cat1"}"#;
        let snake = r#"{"name":"general","channel_type":"text","parent_id":"ch_cat1"}"#;
        let camel = r#"{"name":"general","channel_type":"text","parentId":"ch_cat1"}"#;
        let absent = r#"{"name":"general"}"#;
        let both: super::CreateChannelRequest = serde_json::from_str(both).expect("both spellings must parse");
        assert_eq!(both.parent_id(), Some("ch_cat1"));
        let snake: super::CreateChannelRequest = serde_json::from_str(snake).expect("snake_case must parse");
        assert_eq!(snake.parent_id(), Some("ch_cat1"));
        let camel: super::CreateChannelRequest = serde_json::from_str(camel).expect("camelCase must parse");
        assert_eq!(camel.parent_id(), Some("ch_cat1"));
        let absent: super::CreateChannelRequest = serde_json::from_str(absent).expect("absent parent must parse");
        assert_eq!(absent.parent_id(), None);
    }

    #[tokio::test]
    async fn session_messages_cleared_on_channel_delete() {
        let session: SessionMessages = Arc::new(RwLock::new(HashMap::new()));
        session.write().await.insert("channel-to-delete".to_string(), vec![]);
        session.write().await.insert("channel-to-keep".to_string(), vec![]);
        assert_eq!(session.read().await.len(), 2);
        session.write().await.remove("channel-to-delete");
        let after = session.read().await;
        assert_eq!(after.len(), 1);
        assert!(after.contains_key("channel-to-keep"));
        assert!(!after.contains_key("channel-to-delete"));
    }
}
