//! Media room HTTP API (Phase 4 routing registry).
//!
//! Routes:
//! - POST /api/media/rooms — create room for a channel
//! - GET  /api/media/rooms/{room_id} — get room info
//! - GET  /api/media/rooms/by-channel/{channel_id} — find room
//! - POST /api/media/rooms/{room_id}/assign — (admin) assign node
//! - POST /api/media/rooms/{room_id}/active — (node) confirm active
//! - POST /api/media/rooms/{room_id}/close — close room
//! - GET  /api/media/rooms/{room_id}/endpoint — get active connection endpoint
//!
//! DOES NOT contain actual SFU/WebRTC logic. That's the calling layer.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::media::MediaRoomError;
use crate::nodes::NodeCapability;
use crate::state::AppState;
use crate::api::auth::handle_turn_credentials;

// ---------------------------------------------------------------------------
// Request / response types
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRoomRequest {
    pub channel_id: String,
    #[serde(default = "default_max_participants")]
    pub max_participants: u32,
}

fn default_max_participants() -> u32 {
    50
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomResponse {
    pub room: crate::media::MediaRoom,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointResponse {
    pub room_id: String,
    pub endpoint: Option<String>,
    pub fallback_to_primary: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssignRoomRequest {
    pub node_id: String,
    pub sfu_endpoint: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkActiveRequest {
    pub node_id: String,
    pub sfu_endpoint: String,
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        // Client wants to create / join a room for a channel
        .route("/rooms", post(create_room))
        // List non-closed rooms
        .route("/rooms", get(list_rooms))
        // Lookup by room id
        .route("/rooms/{room_id}", get(get_room))
        // Lookup by channel
        .route("/rooms/by-channel/{channel_id}", get(find_by_channel))
        // Admin assigns a media node to a room
        .route("/rooms/{room_id}/assign", post(assign_room))
        // Media node confirms it is active
        .route("/rooms/{room_id}/active", post(mark_active))
        // Close a room
        .route("/rooms/{room_id}/close", post(close_room))
        // Client asks: where do I connect?
        .route("/rooms/{room_id}/endpoint", get(get_endpoint))
        // TURN ephemeral credentials
        .route("/turn-credentials", get(handle_turn_credentials))
        .with_state(state)
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async fn create_room(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateRoomRequest>,
) -> Result<Json<RoomResponse>, MediaApiError> {
    // 1. Create the room (or return existing)
    let mut room = state
        .media_registry
        .create_room(req.channel_id, req.max_participants)
        .await
        .map_err(MediaApiError::from)?;

    // 2. If room is Pending and an online MediaRelay node exists, auto-assign it
    //    Phase 4 skeleton: no actual SFU wiring, but the registry assignment is real.
    if room.status == crate::media::MediaRoomStatus::Pending {
        if let Some(node) = state
            .node_registry
            .find_online_node_with_capability(NodeCapability::MediaRelay)
            .await
        {
            let endpoint = node
                .lan_reachable_at
                .as_ref()
                .or(node.endpoint.as_ref())
                .cloned();
            match state
                .media_registry
                .assign_room(&room.room_id, &node.node_id, endpoint)
                .await
            {
                Ok(assigned) => {
                    tracing::info!(
                        "[media] Auto-assigned room {} to node {} (phase-4 skeleton)",
                        room.room_id,
                        node.node_id
                    );
                    room = assigned;
                }
                Err(e) => {
                    tracing::warn!("[media] Auto-assignment failed: {}", e);
                }
            }
        }
    }

    // 3. If the room is now Assigned, drop a MediaRelay job into the queue
    //    so the helper can claim it (Phase 4C skeleton — no actual SFU).
    if room.status == crate::media::MediaRoomStatus::Assigned && room.assigned_node_id.is_some() {
        state
            .job_queue
            .submit(crate::jobs::SubmitJobRequest {
                kind: crate::jobs::JobKind::MediaRelay,
                payload: serde_json::json!({
                    "roomId": room.room_id,
                    "channelId": room.channel_id,
                }),
                max_retries: 3,
            })
            .await;
        tracing::info!("[media] Submitted MediaRelay job for room={}", room.room_id,);
    }

    Ok(Json(RoomResponse { room }))
}

async fn get_room(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
) -> Result<Json<RoomResponse>, MediaApiError> {
    let room = state
        .media_registry
        .get_room(&room_id)
        .await
        .ok_or(MediaApiError::NotFound)?;
    Ok(Json(RoomResponse { room }))
}

async fn find_by_channel(
    State(state): State<Arc<AppState>>,
    Path(channel_id): Path<String>,
) -> Result<Json<RoomResponse>, MediaApiError> {
    let room = state
        .media_registry
        .find_by_channel(&channel_id)
        .await
        .ok_or(MediaApiError::NotFound)?;
    Ok(Json(RoomResponse { room }))
}

async fn assign_room(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    Json(req): Json<AssignRoomRequest>,
) -> Result<Json<RoomResponse>, MediaApiError> {
    let room = state
        .media_registry
        .assign_room(&room_id, &req.node_id, req.sfu_endpoint)
        .await
        .map_err(MediaApiError::from)?;
    Ok(Json(RoomResponse { room }))
}

async fn mark_active(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    Json(req): Json<MarkActiveRequest>,
) -> Result<Json<RoomResponse>, MediaApiError> {
    let room = state
        .media_registry
        .mark_active(&room_id, &req.node_id, req.sfu_endpoint)
        .await
        .map_err(MediaApiError::from)?;
    Ok(Json(RoomResponse { room }))
}

async fn close_room(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
) -> Result<Json<RoomResponse>, MediaApiError> {
    let room = state
        .media_registry
        .close_room(&room_id)
        .await
        .map_err(MediaApiError::from)?;
    Ok(Json(RoomResponse { room }))
}

async fn list_rooms(State(state): State<Arc<AppState>>) -> Json<Vec<crate::media::MediaRoom>> {
    let rooms = state.media_registry.list_rooms().await;
    Json(rooms)
}

async fn get_endpoint(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
) -> Result<Json<EndpointResponse>, MediaApiError> {
    let endpoint = state.media_registry.active_endpoint(&room_id).await;
    let fallback_to_primary = endpoint.is_none();
    Ok(Json(EndpointResponse {
        room_id,
        endpoint,
        fallback_to_primary,
    }))
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub enum MediaApiError {
    Registry(MediaRoomError),
    NotFound,
}

impl From<MediaRoomError> for MediaApiError {
    fn from(e: MediaRoomError) -> Self {
        MediaApiError::Registry(e)
    }
}

impl IntoResponse for MediaApiError {
    fn into_response(self) -> axum::response::Response {
        let (status, body) = match &self {
            MediaApiError::Registry(MediaRoomError::NotFound) | MediaApiError::NotFound => {
                (StatusCode::NOT_FOUND, "room not found")
            }
            MediaApiError::Registry(MediaRoomError::AlreadyExists) => {
                (StatusCode::CONFLICT, "room already exists")
            }
            MediaApiError::Registry(MediaRoomError::InvalidState) => {
                (StatusCode::CONFLICT, "invalid room state for this action")
            }
            MediaApiError::Registry(MediaRoomError::InvalidNode) => {
                (StatusCode::BAD_REQUEST, "invalid node for room")
            }
            MediaApiError::Registry(MediaRoomError::Io(msg)) => {
                tracing::error!("media room io error: {}", msg);
                (StatusCode::INTERNAL_SERVER_ERROR, "registry io error")
            }
        };
        (status, body).into_response()
    }
}
