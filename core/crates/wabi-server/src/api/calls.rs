//! Persisted call-state commands. Authorization and per-session serialization
//! precede every write; only applied projection rows are published to clients.
use crate::{
    auth_extractor::AuthUser,
    call_access::*,
    error::{AppError, Result},
    state::AppState,
    websocket::WsMessage,
};
use axum::{
    extract::{Path, Query, State},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use wabidb::engine::wabi_store::WabiStore;

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/sessions", axum::routing::post(create_session))
        .route("/sessions/{id}", axum::routing::get(get_session))
        .route("/sessions/{id}/join", axum::routing::post(join_session))
        .route("/sessions/{id}/leave", axum::routing::post(leave_session))
        .route("/sessions/{id}/end", axum::routing::post(end_session))
        .route(
            "/sessions/{id}/signals",
            axum::routing::post(emit_signal).get(list_signals),
        )
        .route(
            "/sessions/{id}/participants",
            axum::routing::get(list_participants),
        )
        .route_layer(axum::middleware::from_fn_with_state(state.clone(), membership_read))
        .with_state(state)
}

// Acquired once, before any per-session lock; includes reads and publication.
async fn membership_read(
    State(state): State<Arc<AppState>>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let _membership = state.membership_gate.read().await;
    next.run(request).await
}

#[derive(Deserialize)]
struct CreateSessionRequest {
    session_id: String,
    channel_id: String,
    call_type: String,
    max_participants: u32,
    transport: String,
}
/// A no-op retry has no new commit; never invent a persistence acknowledgement.
#[derive(Serialize)]
struct CommitResponse {
    commit_seq: Option<u64>,
}
#[derive(Deserialize)]
struct JoinSessionRequest {
    stable_user_id: String,
}
#[derive(Deserialize)]
struct CallMembershipQuery {
    membership_revision: Option<String>,
}
/// Optimistic request fence, not authorization. Legacy callers still undergo
/// full scope checks; current clients pin each request across auth retries.
/// Holding membership_read above makes this check and command indivisible
/// with respect to a remove/re-add, without changing any postcard record.
async fn require_membership_revision(state: &AppState, channel: &str, query: &CallMembershipQuery) -> Result<()> {
    let Some(expected) = &query.membership_revision else { return Ok(()); };
    let revision = expected.parse::<u64>().ok().filter(|value| value.to_string() == *expected)
        .ok_or_else(|| AppError::BadRequest("Invalid membership revision".into()))?;
    let actual = wabidb::projections::channel_members::ChannelMembersProjection::revision(
        &state.wdb.engine().projection_state(), channel,
    )?;
    if actual != revision {
        return Err(AppError::Conflict("Group membership changed; refresh call admission".into()));
    }
    Ok(())
}
#[derive(Deserialize)]
struct SignalListQuery {
    #[serde(default)]
    since: Option<u64>,
}
#[derive(Deserialize)]
struct SignalEmitRequest {
    signal_type: String,
    target_user_id: Option<u64>,
    payload: String,
}

fn committed(seq: u64) -> Json<CommitResponse> {
    Json(CommitResponse {
        commit_seq: Some(seq),
    })
}
fn unchanged() -> Json<CommitResponse> {
    Json(CommitResponse { commit_seq: None })
}
async fn push_session(state: &AppState, id: &str) -> Result<()> {
    let session = state
        .wdb
        .get_call_session(id)
        .await?
        .ok_or_else(|| AppError::Internal("Committed call session missing".into()))?;
    let _ = state.call_session_push.send((
        id.into(),
        Arc::new(WsMessage::CallSessionChanged { session }),
    ));
    Ok(())
}
async fn push_participants(state: &AppState, id: &str) -> Result<()> {
    let participants = state.wdb.get_call_participants(id).await?;
    let _ = state.call_session_push.send((
        id.into(),
        Arc::new(WsMessage::CallParticipantChanged {
            session_id: id.into(),
            participants,
        }),
    ));
    Ok(())
}

async fn create_session(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Query(epoch): Query<CallMembershipQuery>,
    Json(req): Json<CreateSessionRequest>,
) -> Result<Json<CommitResponse>> {
    let _guard = state.call_session_locks.lock(&req.session_id).await;
    let scope = require_scope(&state, auth.user_id, &req.session_id, &req.channel_id).await?;
    require_membership_revision(&state, &scope, &epoch).await?;
    if !matches!(req.call_type.as_str(), "audio-call" | "video-call")
        || req.transport != "wabidb"
        || req.max_participants > 1000
    {
        return Err(AppError::BadRequest(
            "Invalid call type, transport or participant limit".into(),
        ));
    }
    let pair = direct_pair(&req.session_id)?;
    if let Some(pair) = pair {
        for uid in pair {
            require_principal(&state, uid as i64).await?;
        }
    }
    if let Some(existing) = state.wdb.get_call_session(&req.session_id).await? {
        // Authorize against persisted ownership before considering the new hint.
        let old_scope =
            require_scope(&state, auth.user_id, &req.session_id, &existing.channel_id).await?;
        if old_scope != scope {
            return Err(AppError::Conflict(
                "Session belongs to another channel".into(),
            ));
        }
        if existing.active {
            return Ok(unchanged());
        }
        // Deterministic keys are reusable, but old participation is not consent
        // to a new call. Retire it using existing events before the new create.
        for p in state.wdb.get_call_participants(&req.session_id).await? {
            if p.left_at_micros.is_none() {
                state
                    .wdb
                    .leave_call_session(req.session_id.clone(), p.user_id)
                    .await?;
            }
        }
    }
    let seq = state
        .wdb
        .create_call_session(
            req.session_id.clone(),
            scope,
            req.call_type,
            auth.user_id as u64,
            if pair.is_some() {
                2
            } else {
                req.max_participants
            },
            req.transport,
        )
        .await?;
    push_session(&state, &req.session_id).await?;
    Ok(committed(seq))
}

async fn get_session(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    Ok(Json(
        serde_json::json!({"session": require_session(&state, auth.user_id, &id).await?}),
    ))
}
async fn join_session(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(id): Path<String>,
    Query(epoch): Query<CallMembershipQuery>,
    Json(req): Json<JoinSessionRequest>,
) -> Result<Json<CommitResponse>> {
    let _guard = state.call_session_locks.lock(&id).await;
    let session = require_session(&state, auth.user_id, &id).await?;
    require_membership_revision(&state, &session.channel_id, &epoch).await?;
    if !session.active {
        return Err(AppError::Conflict("Call has ended".into()));
    }
    let stable = format!("user-{}", auth.user_id);
    if req.stable_user_id != stable {
        return Err(AppError::BadRequest(
            "Participant identity does not match account".into(),
        ));
    }
    let participants = state.wdb.get_call_participants(&id).await?;
    if participants
        .iter()
        .any(|p| p.user_id == auth.user_id as u64 && p.left_at_micros.is_none())
    {
        return Ok(unchanged());
    }
    if session.max_participants > 0
        && participants
            .iter()
            .filter(|p| p.left_at_micros.is_none())
            .count()
            >= session.max_participants as usize
    {
        return Err(AppError::Conflict("Call is full".into()));
    }
    let seq = state
        .wdb
        .join_call_session(
            id.clone(),
            auth.user_id as u64,
            stable,
            session.host_user_id == auth.user_id as u64,
        )
        .await?;
    push_participants(&state, &id).await?;
    Ok(committed(seq))
}
async fn leave_session(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(id): Path<String>,
    Query(epoch): Query<CallMembershipQuery>,
) -> Result<Json<CommitResponse>> {
    let _guard = state.call_session_locks.lock(&id).await;
    let session = require_session(&state, auth.user_id, &id).await?;
    require_membership_revision(&state, &session.channel_id, &epoch).await?;
    if !state
        .wdb
        .get_call_participants(&id)
        .await?
        .iter()
        .any(|p| p.user_id == auth.user_id as u64 && p.left_at_micros.is_none())
    {
        return Ok(unchanged());
    }
    let seq = state
        .wdb
        .leave_call_session(id.clone(), auth.user_id as u64)
        .await?;
    push_participants(&state, &id).await?;
    Ok(committed(seq))
}
async fn end_session(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<CommitResponse>> {
    let _guard = state.call_session_locks.lock(&id).await;
    let session = require_session(&state, auth.user_id, &id).await?;
    if session.host_user_id != auth.user_id as u64 {
        // Group-owner succession must not strand a running persisted call when
        // its original host leaves the conversation. Do not grant this fallback
        // to instance administrators or change ownership of ordinary/DM calls.
        let channel = state.wdb.get_channel(&session.channel_id).await?;
        let owner_fallback = if let Some(channel) = channel.filter(|c|
            c.channel_kind == wabidb::domain::ChannelKind::GroupDm)
        {
            let members = state.wdb.list_channel_members(&session.channel_id).await?;
            !members.iter().any(|m| m.user_id == session.host_user_id)
                && crate::channel_access::group_owner(&channel, &members) == Some(auth.user_id as u64)
        } else { false };
        if !owner_fallback {
            return Err(AppError::Forbidden("Only the call host may end the session".into()));
        }
    }
    if !session.active {
        return Ok(unchanged());
    }
    let seq = state
        .wdb
        .end_call_session(id.clone(), auth.user_id as u64)
        .await?;
    push_session(&state, &id).await?;
    Ok(committed(seq))
}
async fn list_participants(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    require_session(&state, auth.user_id, &id).await?;
    Ok(Json(
        serde_json::json!({"participants": state.wdb.get_call_participants(&id).await?}),
    ))
}
async fn emit_signal(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(id): Path<String>,
    Json(req): Json<SignalEmitRequest>,
) -> Result<Json<CommitResponse>> {
    let _guard = state.call_session_locks.lock(&id).await;
    let session = require_session(&state, auth.user_id, &id).await?;
    require_participant(&state, &session, auth.user_id as u64).await?;
    if !matches!(
        req.signal_type.as_str(),
        "offer" | "answer" | "ice" | "mute" | "unmute" | "video"
    ) || req.payload.len() > 65536
    {
        return Err(AppError::BadRequest(
            "Invalid or oversized call signal".into(),
        ));
    }
    if let Some(target) = req.target_user_id {
        let target = i64::try_from(target)
            .map_err(|_| AppError::BadRequest("Invalid signal target".into()))?;
        require_session(&state, target, &id).await?;
        require_participant(&state, &session, target as u64).await?;
    }
    // Ordered, persisted IDs survive restart and deterministic-key reuse. The
    // session lock covers allocation, command completion and live publication.
    let last = state.wdb.last_call_signal(&id)?.map_or(0, |s| s.signal_id);
    let next = last
        .checked_add(1)
        .ok_or_else(|| AppError::Conflict("Signal sequence exhausted".into()))?;
    let seq = state
        .wdb
        .emit_call_signal(
            id.clone(),
            auth.user_id as u64,
            req.signal_type,
            req.target_user_id,
            req.payload,
            next,
        )
        .await?;
    let signal = state
        .wdb
        .last_call_signal(&id)?
        .filter(|s| s.signal_id == next)
        .ok_or_else(|| AppError::Internal("Committed call signal missing".into()))?;
    let _ = state
        .call_session_push
        .send((id, Arc::new(WsMessage::CallSignalEmitted { signal })));
    Ok(committed(seq))
}
async fn list_signals(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(id): Path<String>,
    Query(q): Query<SignalListQuery>,
) -> Result<Json<serde_json::Value>> {
    let session = require_session(&state, auth.user_id, &id).await?;
    require_participant(&state, &session, auth.user_id as u64).await?;
    let signals: Vec<_> = state
        .wdb
        .get_call_signals(&id, q.since.unwrap_or(0))
        .await?
        .into_iter()
        .filter(|s| {
            s.created_at_micros >= session.started_at_micros
                && signal_visible(s, auth.user_id as u64)
        })
        .collect();
    Ok(Json(serde_json::json!({"signals": signals})))
}
