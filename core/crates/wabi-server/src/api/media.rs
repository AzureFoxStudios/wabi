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
    extract::{Path, Query, State},
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
use crate::auth_extractor::AuthUser;

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
        // Media runtime snapshot
        .route("/runtime", get(media_runtime_snapshot))
        .with_state(state)
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async fn create_room(
    State(state): State<Arc<AppState>>,
    _auth: AuthUser,
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
    _auth: AuthUser,
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
    _auth: AuthUser,
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
    auth: AuthUser,
    Path(room_id): Path<String>,
    Json(req): Json<AssignRoomRequest>,
) -> Result<Json<RoomResponse>, MediaApiError> {
    // Admin-only: node assignment shapes where client media is routed.
    if !state.is_admin(auth.user_id).await {
        return Err(MediaApiError::Forbidden);
    }
    let room = state
        .media_registry
        .assign_room(&room_id, &req.node_id, req.sfu_endpoint)
        .await
        .map_err(MediaApiError::from)?;
    Ok(Json(RoomResponse { room }))
}

async fn mark_active(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(room_id): Path<String>,
    Json(req): Json<MarkActiveRequest>,
) -> Result<Json<RoomResponse>, MediaApiError> {
    if !state.is_admin(auth.user_id).await {
        return Err(MediaApiError::Forbidden);
    }
    let room = state
        .media_registry
        .mark_active(&room_id, &req.node_id, req.sfu_endpoint)
        .await
        .map_err(MediaApiError::from)?;
    Ok(Json(RoomResponse { room }))
}

async fn close_room(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(room_id): Path<String>,
) -> Result<Json<RoomResponse>, MediaApiError> {
    // Admin-only: closing a room tears down routing for a live call.
    if !state.is_admin(auth.user_id).await {
        return Err(MediaApiError::Forbidden);
    }
    let room = state
        .media_registry
        .close_room(&room_id)
        .await
        .map_err(MediaApiError::from)?;
    Ok(Json(RoomResponse { room }))
}

async fn list_rooms(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
) -> Result<Json<Vec<crate::media::MediaRoom>>, MediaApiError> {
    // Admin-only: the registry enumerates every live call's routing.
    if !state.is_admin(auth.user_id).await {
        return Err(MediaApiError::Forbidden);
    }
    let rooms = state.media_registry.list_rooms().await;
    Ok(Json(rooms))
}

async fn get_endpoint(
    State(state): State<Arc<AppState>>,
    _auth: AuthUser,
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
// Media runtime snapshot
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerMediaRuntimePayload {
    media: Option<ServerMediaRuntimeMediaPayload>,
    notes: Option<ServerMediaRuntimeNotesPayload>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerMediaRuntimeMediaPayload {
    local_enhanced_enabled: bool,
    srt_gateway_enabled: bool,
    srt_gateway_url: Option<String>,
    opus: Option<ServerMediaRuntimeOpusPayload>,
    turn: Option<ServerMediaRuntimeTurnPayload>,
    gateway: Option<ServerMediaRuntimeGatewayPayload>,
    livekit: Option<ServerMediaRuntimeLivekitPayload>,
    sfu: Option<ServerMediaRuntimeSfuPayload>,
    booster_relay: Option<ServerMediaRuntimeBoosterRelayPayload>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerMediaRuntimeOpusPayload {
    audio_bitrate_web: u32,
    audio_bitrate_local: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerMediaRuntimeTurnPayload {
    configured: bool,
    server: Option<String>,
    port: Option<u16>,
    use_turns: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerMediaRuntimeGatewayPayload {
    configured: bool,
    healthy: bool,
    media_plane_ready: bool,
    last_seen_at: Option<i64>,
    active_streams: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerMediaRuntimeLivekitPayload {
    configured: bool,
    url: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerMediaRuntimeSfuPayload {
    provider: Option<&'static str>,
    enabled: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerMediaRuntimeBoosterRelayPayload {
    requested_mode: &'static str,
    effective_mode: &'static str,
    self_hosted: bool,
    self_advertisement: Option<ServerMediaRuntimeBoosterRelaySelfAdvertisementPayload>,
    components: Option<ServerMediaRuntimeBoosterRelayComponentsPayload>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerMediaRuntimeBoosterRelaySelfAdvertisementPayload {
    status: Option<&'static str>,
    reason: Option<String>,
    updated_at: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerMediaRuntimeBoosterRelayComponentsPayload {
    turn_configured: bool,
    sfu_configured: bool,
    gateway_configured: bool,
    gateway_healthy: bool,
    gateway_media_plane_ready: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerMediaRuntimeNotesPayload {
    srt_direct_browser_supported: bool,
    message: Option<String>,
}

async fn media_runtime_snapshot(
    State(state): State<Arc<AppState>>,
) -> Json<ServerMediaRuntimePayload> {
    let config = &state.config;
    let turn_configured = config.turn_enabled && config.turn_uri.is_some();
    let turn_uri = config.turn_uri.clone();
    let (turn_server, turn_port) = turn_uri
        .as_deref()
        .and_then(parse_turn_uri)
        .unzip();

    let livekit_configured = tokio::process::Command::new("livekit-server")
        .arg("--version")
        .output()
        .await
        .ok()
        .map(|o| o.status.success())
        .unwrap_or_default();

    let payload = ServerMediaRuntimePayload {
        media: Some(ServerMediaRuntimeMediaPayload {
            local_enhanced_enabled: true,
            srt_gateway_enabled: false,
            srt_gateway_url: None,
            opus: Some(ServerMediaRuntimeOpusPayload {
                audio_bitrate_web: 96000,
                audio_bitrate_local: 96000,
            }),
            turn: Some(ServerMediaRuntimeTurnPayload {
                configured: turn_configured,
                server: turn_server.flatten(),
                port: turn_port.flatten(),
                use_turns: turn_configured,
            }),
            gateway: Some(ServerMediaRuntimeGatewayPayload {
                configured: false,
                healthy: false,
                media_plane_ready: false,
                last_seen_at: None,
                active_streams: 0,
            }),
            livekit: Some(ServerMediaRuntimeLivekitPayload {
                configured: livekit_configured,
                url: None,
            }),
            sfu: Some(ServerMediaRuntimeSfuPayload {
                provider: livekit_configured.then(|| "livekit"),
                enabled: livekit_configured,
            }),
            booster_relay: Some(ServerMediaRuntimeBoosterRelayPayload {
                requested_mode: "off",
                effective_mode: "off",
                self_hosted: true,
                self_advertisement: None,
                components: Some(
                    ServerMediaRuntimeBoosterRelayComponentsPayload {
                        turn_configured: turn_configured,
                        sfu_configured: livekit_configured,
                        gateway_configured: false,
                        gateway_healthy: false,
                        gateway_media_plane_ready: false,
                    },
                ),
            }),
        }),
        notes: Some(ServerMediaRuntimeNotesPayload {
            srt_direct_browser_supported: false,
            message: None,
        }),
    };

    Json(payload)
}

fn parse_turn_uri(uri: &str) -> Option<(Option<String>, Option<u16>)> {
    let stripped = uri.strip_prefix("turn:")?.strip_prefix("//")?;
    let host = stripped.split('/').next()?.to_string();
    let port = host.split(':').nth(1)?.parse::<u16>().ok();
    Some((Some(host), port))
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub enum MediaApiError {
    Registry(MediaRoomError),
    NotFound,
    /// Admin-gate rejection (SEC-2, 2026-08-25).
    Forbidden,
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
            MediaApiError::Forbidden => (StatusCode::FORBIDDEN, "admin role required"),
        };
        (status, body).into_response()
    }
}
