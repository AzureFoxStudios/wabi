//! Media room HTTP API and Authority-side media broker.
//!
//! The Authority owns membership/policy and room placement. Shared Media Nodes
//! own backend root credentials and packet infrastructure. LiveKit join tokens
//! are therefore minted on the assigned Media Node through the authenticated
//! outbound job channel, never from a root SFU secret copied into the Authority.

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use wabidb::{domain::ChannelKind, engine::wabi_store::WabiStore};

use crate::api::auth::handle_turn_credentials;
use crate::api::media_node_catalog;
use crate::auth_extractor::AuthUser;
use crate::jobs::JobStatus;
use crate::media::{MediaRoom, MediaRoomError, MediaRoomStatus};
use crate::nodes::{NodeCapability, NodeStatus};
use crate::state::AppState;

const NODE_SECRET_HEADER: &str = "x-wabi-node-secret";
const MEDIA_TOKEN_WAIT: Duration = Duration::from_secs(15);
const MEDIA_TOKEN_POLL: Duration = Duration::from_millis(75);

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
    pub room: MediaRoom,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LivekitTokenRequest {
    pub channel_id: String,
    #[serde(default)]
    pub display_name: Option<String>,
}

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/rooms", post(create_room))
        .route("/rooms", get(list_rooms))
        .route("/rooms/{room_id}", get(get_room))
        .route("/rooms/by-channel/{channel_id}", get(find_by_channel))
        .route("/rooms/{room_id}/assign", post(assign_room))
        .route("/rooms/{room_id}/active", post(mark_active))
        .route("/rooms/{room_id}/close", post(close_room))
        .route("/rooms/{room_id}/endpoint", get(get_endpoint))
        .route("/livekit/token", post(create_livekit_token))
        .route("/turn-credentials", get(handle_turn_credentials))
        .route("/runtime", get(media_runtime_snapshot))
        .with_state(state)
}

async fn create_room(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Json(req): Json<CreateRoomRequest>,
) -> Result<Json<RoomResponse>, MediaApiError> {
    // Media room creation is not a discovery endpoint. Prove current channel
    // access before allocating shared-node resources.
    crate::channel_access::require_access(&state, auth.user_id, &req.channel_id)
        .await
        .map_err(|_| MediaApiError::Forbidden)?;
    let room = ensure_media_room(&state, req.channel_id, req.max_participants).await?;
    Ok(Json(RoomResponse { room }))
}

async fn ensure_media_room(
    state: &Arc<AppState>,
    channel_id: String,
    max_participants: u32,
) -> Result<MediaRoom, MediaApiError> {
    // create_room is idempotent for an open channel room and also performs the
    // lazy migration that gives pre-shared-node rows their tenant namespace.
    let mut room = state
        .media_registry
        .create_room(channel_id, max_participants.max(1))
        .await
        .map_err(MediaApiError::from)?;

    let mut assigned_now = false;
    if room.status == MediaRoomStatus::Pending {
        let nodes = state.node_registry.list_nodes().await;
        let catalog = media_node_catalog::global(&state.config.data_dir);
        let preferred_region = preferred_media_region();
        let advertisements = catalog.list().await;
        let selected = catalog
            .select(&nodes, room.max_participants, preferred_region.as_deref())
            .await;

        let assignment = if let Some(selected) = selected {
            tracing::info!(
                "[media] selected advertised node={} provider={} region={:?} shared={:?}",
                selected.node_id,
                selected.provider,
                selected.region,
                selected.sharing
            );
            Some((selected.node_id, Some(selected.endpoint)))
        } else {
            // Legacy helpers that never advertised media metadata remain usable.
            // Once a node advertises drain/capacity state, do not bypass that
            // declaration through this compatibility path.
            nodes
                .iter()
                .find(|node| {
                    node.status == NodeStatus::Online
                        && node.capabilities.contains(&NodeCapability::MediaRelay)
                        && !advertisements
                            .iter()
                            .any(|record| record.node_id == node.node_id)
                })
                .map(|node| {
                    let endpoint = node
                        .lan_reachable_at
                        .as_ref()
                        .or(node.endpoint.as_ref())
                        .cloned();
                    (node.node_id.clone(), endpoint)
                })
        };

        if let Some((node_id, endpoint)) = assignment {
            room = state
                .media_registry
                .assign_room(&room.room_id, &node_id, endpoint)
                .await
                .map_err(MediaApiError::from)?;
            assigned_now = true;
            tracing::info!(
                "[media] auto-assigned tenant={} room={} to node {}",
                room.tenant_namespace,
                room.room_id,
                node_id
            );
        }
    }

    if assigned_now {
        submit_media_operation(state, &room, "activate_room", serde_json::json!({})).await?;
    }
    Ok(room)
}

async fn submit_media_operation(
    state: &Arc<AppState>,
    room: &MediaRoom,
    operation: &str,
    extra: serde_json::Value,
) -> Result<crate::jobs::Job, MediaApiError> {
    let assigned_node_id = room
        .assigned_node_id
        .clone()
        .ok_or(MediaApiError::Unavailable)?;
    let mut payload = serde_json::json!({
        "operation": operation,
        "tenantNamespace": room.tenant_namespace.clone(),
        "roomId": room.room_id.clone(),
        "externalRoomName": room.external_room_name.clone(),
        "channelId": room.channel_id.clone(),
        "assignedNodeId": assigned_node_id,
        "maxParticipants": room.max_participants,
    });
    if let (Some(target), Some(source)) = (payload.as_object_mut(), extra.as_object()) {
        for (key, value) in source {
            target.insert(key.clone(), value.clone());
        }
    }
    Ok(state
        .job_queue
        .submit(crate::jobs::SubmitJobRequest {
            kind: crate::jobs::JobKind::MediaRelay,
            payload,
            max_retries: 2,
        })
        .await)
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
    auth: AuthUser,
    Path(channel_id): Path<String>,
) -> Result<Json<RoomResponse>, MediaApiError> {
    crate::channel_access::require_access(&state, auth.user_id, &channel_id)
        .await
        .map_err(|_| MediaApiError::Forbidden)?;
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
    if !state.is_admin(auth.user_id).await {
        return Err(MediaApiError::Forbidden);
    }
    let room = state
        .media_registry
        .assign_room(&room_id, &req.node_id, req.sfu_endpoint)
        .await
        .map_err(MediaApiError::from)?;
    submit_media_operation(&state, &room, "activate_room", serde_json::json!({})).await?;
    Ok(Json(RoomResponse { room }))
}

async fn mark_active(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(room_id): Path<String>,
    Json(req): Json<MarkActiveRequest>,
) -> Result<Json<RoomResponse>, MediaApiError> {
    let node_secret = headers
        .get(NODE_SECRET_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or(MediaApiError::Forbidden)?;
    let node = state
        .node_registry
        .authenticate_node(&req.node_id, node_secret)
        .await
        .map_err(|_| MediaApiError::Forbidden)?;
    if !node.capabilities.contains(&NodeCapability::MediaRelay) {
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
) -> Result<Json<Vec<MediaRoom>>, MediaApiError> {
    if !state.is_admin(auth.user_id).await {
        return Err(MediaApiError::Forbidden);
    }
    Ok(Json(state.media_registry.list_rooms().await))
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

async fn create_livekit_token(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Json(req): Json<LivekitTokenRequest>,
) -> Result<Json<serde_json::Value>, MediaApiError> {
    if auth.user_id <= 0 || auth.is_bot {
        return Err(MediaApiError::Forbidden);
    }
    let channel = crate::channel_access::require_access(&state, auth.user_id, &req.channel_id)
        .await
        .map_err(|_| MediaApiError::Forbidden)?;
    if channel.channel_kind != ChannelKind::Voice {
        return Err(MediaApiError::Forbidden);
    }

    let room = ensure_media_room(&state, req.channel_id.clone(), default_max_participants()).await?;
    let node_id = room
        .assigned_node_id
        .clone()
        .ok_or(MediaApiError::Unavailable)?;

    // Shared-node token brokering requires an authenticated advertisement so an
    // old generic helper can never receive a root-secret operation by accident.
    let advertisement = media_node_catalog::global(&state.config.data_dir)
        .get(&node_id)
        .await
        .ok_or(MediaApiError::Unavailable)?;
    if advertisement.advertisement.provider != "livekit"
        || !advertisement.advertisement.accepting_new_rooms
    {
        return Err(MediaApiError::Unavailable);
    }

    let server_muted = state
        .wdb
        .is_user_muted(&req.channel_id, auth.user_id as u64)
        .await
        .unwrap_or(false);
    let server_deafened = state
        .wdb
        .is_user_deafened(&req.channel_id, auth.user_id as u64)
        .await
        .unwrap_or(false);
    let can_publish = !server_muted;
    let can_subscribe = !server_deafened;
    let publish_sources = if can_publish {
        serde_json::json!(["microphone", "camera", "screen_share", "screen_share_audio"])
    } else {
        serde_json::json!([])
    };
    let display_name = req
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(auth.username.as_str())
        .chars()
        .take(128)
        .collect::<String>();
    let identity = format!("user:{}", auth.user_id);

    let job = submit_media_operation(
        &state,
        &room,
        "mint_token",
        serde_json::json!({
            "identity": identity.clone(),
            "displayName": display_name,
            "ttlSeconds": 600,
            "grants": {
                "canPublish": can_publish,
                "canSubscribe": can_subscribe,
                "canPublishData": true,
                "canPublishSources": publish_sources,
            }
        }),
    )
    .await?;

    let deadline = Instant::now() + MEDIA_TOKEN_WAIT;
    loop {
        let current = state
            .job_queue
            .list_jobs(None)
            .await
            .into_iter()
            .find(|candidate| candidate.job_id == job.job_id)
            .ok_or(MediaApiError::Internal)?;
        match current.status {
            JobStatus::Completed => {
                let result = current.result_payload.ok_or(MediaApiError::Internal)?;
                validate_livekit_token_result(&result, &room, &identity)?;
                return Ok(Json(result));
            }
            JobStatus::DeadLettered | JobStatus::Failed | JobStatus::Cancelled => {
                tracing::warn!(
                    job_id = current.job_id,
                    error = ?current.error_message,
                    "media token job failed"
                );
                return Err(MediaApiError::Unavailable);
            }
            JobStatus::Pending | JobStatus::Running => {}
        }
        if Instant::now() >= deadline {
            return Err(MediaApiError::Unavailable);
        }
        tokio::time::sleep(MEDIA_TOKEN_POLL).await;
    }
}

fn validate_livekit_token_result(
    result: &serde_json::Value,
    room: &MediaRoom,
    identity: &str,
) -> Result<(), MediaApiError> {
    let object = result.as_object().ok_or(MediaApiError::Internal)?;
    let has_token = object
        .get("token")
        .and_then(|value| value.as_str())
        .is_some_and(|value| !value.is_empty());
    let url_ok = object
        .get("url")
        .and_then(|value| value.as_str())
        .is_some_and(|value| {
            value.starts_with("wss://")
                || value.starts_with("ws://")
                || value.starts_with("https://")
                || value.starts_with("http://")
        });
    let room_ok = object.get("roomName").and_then(|value| value.as_str())
        == Some(room.external_room_name.as_str());
    let identity_ok = object.get("identity").and_then(|value| value.as_str()) == Some(identity);
    if has_token && url_ok && room_ok && identity_ok {
        Ok(())
    } else {
        Err(MediaApiError::Internal)
    }
}

fn preferred_media_region() -> Option<String> {
    std::env::var("WABI_MEDIA_PREFERRED_REGION")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

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
    let turn_endpoint = config.turn_endpoint().ok().flatten();
    let turn_configured = turn_endpoint.is_some();

    // Prefer a healthy advertised shared Media Node. An explicit LIVEKIT_URL
    // remains a compatibility path for a directly configured self-hosted SFU.
    let nodes = state.node_registry.list_nodes().await;
    let preferred_region = preferred_media_region();
    let selected = media_node_catalog::global(&state.config.data_dir)
        .select(&nodes, 1, preferred_region.as_deref())
        .await
        .filter(|selection| selection.provider == "livekit");
    let configured_url = selected
        .as_ref()
        .map(|selection| selection.endpoint.clone())
        .or_else(|| {
            std::env::var("LIVEKIT_URL")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        });
    let local_binary = tokio::process::Command::new("livekit-server")
        .arg("--version")
        .output()
        .await
        .ok()
        .is_some_and(|output| output.status.success());
    let livekit_configured = configured_url.is_some() || local_binary;
    let livekit_ready = configured_url.is_some();

    Json(ServerMediaRuntimePayload {
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
                server: turn_endpoint.as_ref().map(|endpoint| endpoint.server.clone()),
                port: turn_endpoint.as_ref().map(|endpoint| endpoint.port),
                use_turns: turn_endpoint.as_ref().is_some_and(|endpoint| endpoint.use_turns),
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
                url: configured_url,
            }),
            sfu: Some(ServerMediaRuntimeSfuPayload {
                provider: livekit_ready.then_some("livekit"),
                enabled: livekit_ready,
            }),
            booster_relay: Some(ServerMediaRuntimeBoosterRelayPayload {
                requested_mode: "off",
                effective_mode: "off",
                self_hosted: true,
                self_advertisement: None,
                components: Some(ServerMediaRuntimeBoosterRelayComponentsPayload {
                    turn_configured,
                    sfu_configured: livekit_configured,
                    gateway_configured: false,
                    gateway_healthy: false,
                    gateway_media_plane_ready: false,
                }),
            }),
        }),
        notes: Some(ServerMediaRuntimeNotesPayload {
            srt_direct_browser_supported: false,
            message: None,
        }),
    })
}

#[derive(Debug)]
pub enum MediaApiError {
    Registry(MediaRoomError),
    NotFound,
    Forbidden,
    Unavailable,
    Internal,
}

impl From<MediaRoomError> for MediaApiError {
    fn from(e: MediaRoomError) -> Self {
        MediaApiError::Registry(e)
    }
}

impl IntoResponse for MediaApiError {
    fn into_response(self) -> axum::response::Response {
        let (status, body) = match self {
            MediaApiError::Registry(MediaRoomError::NotFound) | MediaApiError::NotFound => {
                (StatusCode::NOT_FOUND, "room not found")
            }
            MediaApiError::Registry(MediaRoomError::AlreadyExists) => {
                (StatusCode::CONFLICT, "room already exists")
            }
            MediaApiError::Registry(MediaRoomError::InvalidState) => {
                (StatusCode::CONFLICT, "room is not in a state that allows this action")
            }
            MediaApiError::Registry(MediaRoomError::InvalidNode) => {
                (StatusCode::BAD_REQUEST, "invalid node for room")
            }
            MediaApiError::Registry(MediaRoomError::Io(msg)) => {
                tracing::error!("media room io error: {}", msg);
                (StatusCode::INTERNAL_SERVER_ERROR, "registry io error")
            }
            MediaApiError::Forbidden => {
                (StatusCode::FORBIDDEN, "not authorized for media action")
            }
            MediaApiError::Unavailable => {
                (StatusCode::SERVICE_UNAVAILABLE, "media node unavailable")
            }
            MediaApiError::Internal => {
                (StatusCode::INTERNAL_SERVER_ERROR, "invalid media-node response")
            }
        };
        (status, body).into_response()
    }
}
