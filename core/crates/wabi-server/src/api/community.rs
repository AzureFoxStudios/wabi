//! Authenticated community identity and owner-approved entry points.

use axum::{extract::State, http::HeaderMap, routing::get, Json, Router};
use std::sync::Arc;

use crate::{
    auth_extractor::{verify_stepup_token, AuthUser, STEPUP_HEADER},
    community_roster::{RosterError, RosterUpdate, SignedRoster},
    error::{AppError, Result},
    state::AppState,
};
use wabidb::engine::wabi_store::WabiStore;

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/roster", get(get_roster).put(put_roster))
        .with_state(state)
}

async fn get_roster(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
) -> Result<Json<SignedRoster>> {
    require_member(&state, &auth).await?;
    state.community_roster.signed().map(Json).ok_or_else(|| {
        AppError::NotFound("the owner has not published community entry points".into())
    })
}

async fn put_roster(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    headers: HeaderMap,
    Json(update): Json<RosterUpdate>,
) -> Result<Json<SignedRoster>> {
    require_member(&state, &auth).await?;
    if !state.is_owner(auth.user_id).await {
        return Err(AppError::Forbidden("community owner required".into()));
    }
    let token = headers
        .get(STEPUP_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| AppError::Unauthorized("step-up authentication required".into()))?;
    verify_stepup_token(&state.config.jwt_secret, token, auth.user_id).await?;
    if state.wdb.engine().local_writer_fenced().await {
        return Err(AppError::Conflict("local writer is fenced".into()));
    }
    state
        .community_roster
        .update_db(update, state.wdb.engine(), auth.user_id as u64)
        .await
        .map(Json)
        .map_err(|error| match error {
            RosterError::Invalid(message) => AppError::BadRequest(message),
            RosterError::Conflict => AppError::Conflict("community roster version changed".into()),
            RosterError::Io(message) => {
                AppError::Internal(format!("community roster write: {message}"))
            }
        })
}

async fn require_member(state: &AppState, auth: &AuthUser) -> Result<()> {
    if auth.is_guest || auth.is_bot {
        return Err(AppError::Forbidden(
            "registered community member required".into(),
        ));
    }
    let member = state
        .wdb
        .get_user(auth.user_id as u64)
        .await
        .map_err(|error| AppError::Internal(format!("community member lookup: {error}")))?;
    if !member.is_some_and(|member| member.is_registered && member.is_active) {
        return Err(AppError::Forbidden(
            "active registered community member required".into(),
        ));
    }
    Ok(())
}
