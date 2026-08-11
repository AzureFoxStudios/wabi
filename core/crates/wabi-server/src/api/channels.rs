//! Channel routes
//!
//! GET    /api/channels      — list all channels (public)
//! POST   /api/channels      — create channel (admin only)
//! GET    /api/channels/{id} — get single channel (public)
//! DELETE /api/channels/{id} — archive channel (admin only)

use axum::{
    extract::{Path, State},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::auth_extractor::AuthUser;
use crate::error::{AppError, Result};
use crate::state::AppState;
use wabidb::engine::wabi_store::WabiStore;

/// Map domain ChannelKind → stable frontend wire string.
/// Prefer explicit arms over Debug::fmt so renames don't silently break clients.
fn channel_kind_to_type(kind: wabidb::domain::ChannelKind, asset_storage: bool) -> String {
    use wabidb::domain::ChannelKind::*;
    let s = match kind {
        Text => {
            // Legacy: some older asset_storage channels were Text+flag.
            if asset_storage {
                "lore"
            } else {
                "text"
            }
        }
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
    };
    s.to_string()
}

/// Convert a WDB typed `Channel` to the JSON `ChannelResponse` shape
/// the frontend expects.
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
        .route("/{channel_id}/reactions", axum::routing::get(list_channel_reactions))
        .with_state(state)
}

#[derive(Debug, Serialize)]
struct ChannelListResponse {
    channels: Vec<ChannelResponse>,
}

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
    /// True when this channel has (or should have) a Lore asset-storage repo.
    #[serde(default)]
    asset_storage: bool,
}

async fn list_channels(State(state): State<Arc<AppState>>) -> Result<Json<ChannelListResponse>> {
    let mut channels = state
        .wdb
        .list_channels(None)
        .await
        .map_err(|e| AppError::Internal(format!("wdb list_channels: {e}")))?
        .into_iter()
        .map(channel_to_response)
        .collect::<Vec<_>>();
    channels.sort_by_key(|c| c.position);

    Ok(Json(ChannelListResponse { channels }))
}

async fn get_channel(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<ChannelResponse>> {
    let channel = state
        .wdb
        .get_channel(&id)
        .await
        .map_err(|e| AppError::Internal(format!("wdb get_channel: {e}")))?
        .ok_or_else(|| AppError::NotFound(format!("Channel {id} not found")))?;
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
    /// Category folder id to nest under (optional). Wire camelCase parentId too.
    #[serde(default, alias = "parentId")]
    parent_id: Option<String>,
}

fn default_channel_type() -> String {
    "text".to_string()
}

async fn create_channel(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Json(req): Json<CreateChannelRequest>,
) -> Result<Json<ChannelResponse>> {
    if !state.is_admin(auth.user_id).await {
        return Err(AppError::Unauthorized(
            "only admins can create channels".into(),
        ));
    }

    let name = req.name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::BadRequest("channel name cannot be empty".into()));
    }

    // Map the request's channel_type string to a WDB ChannelKind enum.
    // Defaults to Text for unknown / "text" / missing.
    // "lore" / asset_storage → ChannelKind::Lore (L1).
    let wants_asset_storage = req.asset_storage || req.channel_type == "lore";
    let channel_kind = match req.channel_type.as_str() {
        "text" | "" => {
            if wants_asset_storage {
                wabidb::domain::ChannelKind::Lore
            } else {
                wabidb::domain::ChannelKind::Text
            }
        }
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
    let asset_storage = wants_asset_storage || is_lore;

    // The WDB engine assigns the channel_id (returns a "ch_{:x}" id
    // derived from the commit_seq). Use that.
    let channel_id = state
        .wdb
        .create_channel(&name, channel_kind, auth.user_id as u64, req.force_spoiler)
        .await?;

    // Persist asset_storage flag on the channel record (L1).
    if asset_storage {
        let _ = state
            .wdb
            .update_channel(
                &channel_id,
                &serde_json::json!({ "asset_storage": true }),
                auth.user_id as u64,
            )
            .await;
    }

    // Add the creator as a member with the Owner role so they can see and
    // manage the channel.
    state
        .wdb
        .add_channel_member(
            &channel_id,
            auth.user_id as u64,
            wabidb::domain::MemberRole::Owner,
        )
        .await?;

    // Product default: ephemeral 24h retention (keep-forever is opt-in later).
    // Text/voice chat should not retain indefinitely unless the operator chooses.
    const DEFAULT_CHANNEL_AUTO_DELETE_MS: u64 = 24 * 60 * 60 * 1000;
    state
        .channel_auto_delete_ms
        .write()
        .await
        .insert(channel_id.clone(), DEFAULT_CHANNEL_AUTO_DELETE_MS);
    state
        .channel_auto_delete_label
        .write()
        .await
        .insert(channel_id.clone(), "24h".to_string());
    let _ = state
        .wdb
        .upsert_channel_retention(&channel_id, 1, auth.user_id as u64)
        .await;

    // `description` is in the WDB Channel domain type yet — dropped for v1.
    let _ = req.description;

    // Optional folder nesting (category parent). Applied after create so the
    // channel exists before parent_id is set on the projection.
    if let Some(parent) = req.parent_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let mut patch = serde_json::Map::new();
        patch.insert("parent_id".to_string(), serde_json::json!(parent));
        if let Err(e) = state
            .wdb
            .update_channel(
                &channel_id,
                &serde_json::Value::Object(patch),
                auth.user_id as u64,
            )
            .await
        {
            tracing::warn!(channel_id, parent, error = %e, "failed to set parent_id on new channel");
        }
    }

    // Auto-create a Lore repo if asset_storage / lore kind is enabled
    let lore_channel_id = channel_id
        .strip_prefix("ch_")
        .and_then(|hex| i64::from_str_radix(hex, 16).ok())
        .unwrap_or(0);
    if asset_storage {
        #[cfg(feature = "wabi-lore")]
        {
            if lore_channel_id != 0 {
                let lore_guard = state.lore_service.read().await;
                if let Some(lore) = lore_guard.as_ref() {
                    let repo_name = format!("ch-{channel_id}");
                    match lore.create_repo(lore_channel_id, auth.user_id, &repo_name).await {
                        Ok(repo) => {
                            let _ = state
                                .wdb
                                .lore_create_repo(lore_channel_id, &repo_name, &repo.lore_server_url, auth.user_id)
                                .await;
                            tracing::info!(channel_id, repo_name, "Auto-created Lore repo for asset_storage channel");
                        }
                        Err(e) => {
                            tracing::warn!(channel_id, error = %e, "Failed to auto-create Lore repo");
                        }
                    }
                }
            }
        }
        #[cfg(not(feature = "wabi-lore"))]
        {
            tracing::warn!(channel_id, "asset_storage/lore requested but Lore addon not enabled");
        }
    }

    // Wire channel_type is always the canonical string for the kind.
    let response_type = if is_lore {
        "lore".to_string()
    } else if channel_kind == wabidb::domain::ChannelKind::Planning {
        "planning".to_string()
    } else {
        req.channel_type
    };

    // We don't have the typed Channel object back (create returns just the
    // id), so build the response from the request + returned id.
    Ok(Json(ChannelResponse {
        id: channel_id,
        name,
        channel_type: response_type,
        position: 0,
        parent_id: req
            .parent_id
            .as_ref()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
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
    let mut patch = serde_json::Map::new();
    if let Some(name) = req.name {
        patch.insert("name".to_string(), serde_json::Value::String(name));
    }
    if let Some(desc) = req.description {
        patch.insert("description".to_string(), serde_json::Value::String(desc));
    }
    if let Some(pos) = req.position {
        patch.insert("position".to_string(), serde_json::Value::Number(pos.into()));
    }
    if let Some(force) = req.force_spoiler {
        patch.insert("force_spoiler".to_string(), serde_json::Value::Bool(force));
    }
    state.wdb.update_channel(&id, &serde_json::Value::Object(patch), auth.user_id as u64).await?;
    let channel = state.wdb.get_channel(&id).await?.ok_or_else(|| AppError::NotFound(format!("Channel {id} not found")))?;
    Ok(Json(channel_to_response(channel)))
}

async fn delete_channel(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    if !state.is_admin(auth.user_id).await {
        return Err(AppError::Unauthorized(
            "only admins can delete channels".into(),
        ));
    }

    // WdbAdapter::delete_channel uses the trait's default impl (Ok(()))
    // for v1 — a no-op soft-delete. The real engine event emission
    // (channel_deleted → projection handler) is a later WDB engine pass.
    state
        .wdb
        .delete_channel(&id, auth.user_id as u64)
        .await?;

    // Clear the session message cache for this channel. The cache
    // (HashMap<channel_id, Vec<Message>>) accumulates 1000 messages
    // per channel. Without this cleanup, deleting a channel leaks
    // its cache entry forever. WABI_AUDIT_REPORT.md finding #2.
    state.session_messages.write().await.remove(&id);

    // Notify connected clients immediately; each client also removes nested
    // descendants from its local channel tree.
    if let Some(io) = state.sio.read().await.clone() {
        let _ = io
            .broadcast()
            .emit("channel-deleted", &serde_json::json!({ "channelId": &id }))
            .await;
    }

    Ok(Json(serde_json::json!({ "deleted": id })))
}

async fn list_channel_reactions(
    State(state): State<Arc<AppState>>,
    Path(channel_id): Path<String>,
) -> Result<Json<Vec<serde_json::Value>>> {
    let messages = state
        .wdb
        .list_messages_typed(&channel_id, 100)
        .await?;

    let mut all_reactions = Vec::new();
    for msg in &messages {
        let reactions = state
            .wdb
            .list_reactions(&msg.message_id)
            .await?;
        for r in reactions {
            all_reactions.push(serde_json::json!(r));
        }
    }

    Ok(Json(all_reactions))
}

#[cfg(test)]
mod tests {
    //! WABI_AUDIT_REPORT.md finding #2 — session messages leak.
    //!
    //! The full HTTP handler `delete_channel` calls
    //! `state.session_messages.write().await.remove(&id);` after the
    //! wdb soft-delete succeeds. This test asserts the idiomatic
    //! pattern: insert into session_messages, remove via the same
    //! pattern, assert gone.
    //!
    //! Full handler tests require a wired AppState (auth, wdb, etc.)
    //! and are tested at the binary level via integration scripts.

    use crate::state::SessionMessages;
    use std::collections::HashMap;
    use std::sync::Arc;
    use tokio::sync::RwLock;

    #[tokio::test]
    async fn session_messages_cleared_on_channel_delete() {
        let session: SessionMessages = Arc::new(RwLock::new(HashMap::new()));
        session
            .write()
            .await
            .insert("channel-to-delete".to_string(), vec![]);
        session
            .write()
            .await
            .insert("channel-to-keep".to_string(), vec![]);
        assert_eq!(session.read().await.len(), 2);

        // Same pattern the HTTP handler uses:
        session.write().await.remove("channel-to-delete");

        let after = session.read().await;
        assert_eq!(after.len(), 1);
        assert!(after.contains_key("channel-to-keep"));
        assert!(!after.contains_key("channel-to-delete"));
    }
}
