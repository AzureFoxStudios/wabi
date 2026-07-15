//! Call-session HTTP endpoints.
//!
//! Replaces the WDB call-session reducers. Exposes the wabidb-backed
//! call state as REST endpoints. Each commit handler also pushes a
//! WebSocket event to `state.call_session_push` so subscribed clients
//! get real-time updates without polling.

use axum::{
    extract::{Path, Query, State},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::sync::atomic::Ordering;

use crate::auth_extractor::AuthUser;
use crate::error::{AppError, Result};
use crate::state::AppState;
use wabidb::engine::wabi_store::WabiStore;
use crate::websocket::WsMessage;

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/sessions", axum::routing::post(create_session))
        .route("/sessions/{id}", axum::routing::get(get_session))
        .route("/sessions/{id}/join", axum::routing::post(join_session))
        .route("/sessions/{id}/leave", axum::routing::post(leave_session))
        .route("/sessions/{id}/end", axum::routing::post(end_session))
        .route(
            "/sessions/{id}/signals",
            axum::routing::post(emit_signal),
        )
        .route(
            "/sessions/{id}/participants",
            axum::routing::get(list_participants),
        )
        .route(
            "/sessions/{id}/signals",
            axum::routing::get(list_signals),
        )
        .with_state(state)
}

// --- request/response types ---

#[derive(Debug, Deserialize)]
struct CreateSessionRequest {
    session_id: String,
    channel_id: String,
    call_type: String,
    max_participants: u32,
    transport: String,
}

#[derive(Debug, Serialize)]
struct CommitResponse {
    commit_seq: u64,
}

#[derive(Debug, Deserialize)]
struct JoinSessionRequest {
    stable_user_id: String,
}

#[derive(Debug, Serialize)]
struct SignalListResponse {
    signals: Vec<wabidb::domain::CallSignal>,
}

#[derive(Debug, Serialize)]
struct ParticipantListResponse {
    participants: Vec<wabidb::domain::CallParticipant>,
}

#[derive(Debug, Serialize)]
struct SessionResponse {
    session: wabidb::domain::CallSession,
}

#[derive(Debug, Deserialize)]
struct SignalListQuery {
    #[serde(default)]
    since: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct SignalEmitRequest {
    signal_type: String,
    target_user_id: Option<u64>,
    payload: String,
}

// --- handlers ---

async fn create_session(
    State(state): State<Arc<AppState>>,
    AuthUser { user_id, .. }: AuthUser,
    Json(req): Json<CreateSessionRequest>,
) -> Result<Json<CommitResponse>> {
    let user_id = user_id as u64;
    let commit_seq = state
        .wdb
        .create_call_session(
            req.session_id.clone(),
            req.channel_id,
            req.call_type,
            user_id,
            req.max_participants,
            req.transport,
        )
        .await?;
    if let Ok(Some(session)) = state.wdb.get_call_session(&req.session_id).await {
        let _ = state.call_session_push.send((
            req.session_id.clone(),
            std::sync::Arc::new(WsMessage::CallSessionChanged { session }),
        ));
    }
    Ok(Json(CommitResponse { commit_seq }))
}

async fn get_session(
    State(state): State<Arc<AppState>>,
    _auth: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<SessionResponse>> {
    let session = state
        .wdb
        .get_call_session(&id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("call_session:{id}")))?;
    Ok(Json(SessionResponse { session }))
}

async fn join_session(
    State(state): State<Arc<AppState>>,
    AuthUser { user_id, .. }: AuthUser,
    Path(id): Path<String>,
    Json(req): Json<JoinSessionRequest>,
) -> Result<Json<CommitResponse>> {
    let user_id = user_id as u64;
    // v1: the host is the first user to create the session; joins are non-host.
    let is_host = false;
    let commit_seq = state
        .wdb
        .join_call_session(id.clone(), user_id, req.stable_user_id, is_host)
        .await?;
    if let Ok(participants) = state.wdb.get_call_participants(&id).await {
        let _ = state.call_session_push.send((
            id.clone(),
            std::sync::Arc::new(WsMessage::CallParticipantChanged {
                session_id: id.clone(),
                participants,
            }),
        ));
    }
    Ok(Json(CommitResponse { commit_seq }))
}

async fn leave_session(
    State(state): State<Arc<AppState>>,
    AuthUser { user_id, .. }: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<CommitResponse>> {
    let user_id = user_id as u64;
    let commit_seq = state.wdb.leave_call_session(id.clone(), user_id).await?;
    if let Ok(participants) = state.wdb.get_call_participants(&id).await {
        let _ = state.call_session_push.send((
            id.clone(),
            std::sync::Arc::new(WsMessage::CallParticipantChanged {
                session_id: id.clone(),
                participants,
            }),
        ));
    }
    Ok(Json(CommitResponse { commit_seq }))
}

async fn end_session(
    State(state): State<Arc<AppState>>,
    AuthUser { user_id, .. }: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<CommitResponse>> {
    let user_id = user_id as u64;
    let commit_seq = state.wdb.end_call_session(id.clone(), user_id).await?;
    if let Ok(Some(session)) = state.wdb.get_call_session(&id).await {
        let _ = state.call_session_push.send((
            id.clone(),
            std::sync::Arc::new(WsMessage::CallSessionChanged { session }),
        ));
    }
    Ok(Json(CommitResponse { commit_seq }))
}

async fn list_participants(
    State(state): State<Arc<AppState>>,
    _auth: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<ParticipantListResponse>> {
    let participants = state.wdb.get_call_participants(&id).await?;
    Ok(Json(ParticipantListResponse { participants }))
}

async fn emit_signal(
    State(state): State<Arc<AppState>>,
    AuthUser { user_id, .. }: AuthUser,
    Path(id): Path<String>,
    Json(req): Json<SignalEmitRequest>,
) -> Result<Json<CommitResponse>> {
    let user_id = user_id as u64;
    // v1: signal_id assigned per-request via an atomic counter held in
    // process state. Not durable across restarts (acceptable per design
    // doc section 9.3 — clients replay since-signal_id after reconnect).
    let counter = state
        .call_signal_counter
        .fetch_add(1, Ordering::Relaxed)
        + 1;
    let commit_seq = state
        .wdb
        .emit_call_signal(
            id.clone(),
            user_id,
            req.signal_type.clone(),
            req.target_user_id,
            req.payload.clone(),
            counter,
        )
        .await?;
    let now_micros = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_micros() as i64)
        .unwrap_or(0);
    let signal = wabidb::domain::CallSignal {
        signal_id: counter,
        session_id: id.clone(),
        from_user_id: user_id,
        signal_type: req.signal_type,
        target_user_id: req.target_user_id,
        payload: req.payload,
        created_at_micros: now_micros,
    };
    let _ = state.call_session_push.send((
        id.clone(),
        std::sync::Arc::new(WsMessage::CallSignalEmitted { signal }),
    ));
    Ok(Json(CommitResponse { commit_seq }))
}
async fn list_signals(
    State(state): State<Arc<AppState>>,
    _auth: AuthUser,
    Path(id): Path<String>,
    Query(q): Query<SignalListQuery>,
) -> Result<Json<SignalListResponse>> {
    let since = q.since.unwrap_or(0);
    let signals = state.wdb.get_call_signals(&id, since).await?;
    Ok(Json(SignalListResponse { signals }))
}
