//! Authenticated community identity and owner-approved entry points.

use axum::{extract::State, http::HeaderMap, routing::get, Json, Router};
use std::sync::Arc;

use crate::{
    auth_extractor::{decode_token, AuthUser, STEPUP_HEADER},
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
    let _membership = state.membership_gate.clone().read_owned().await;
    require_member(&state, &auth).await?;
    let _authorization = auth.admit_current(&state).await?;
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
    // Admit after the complete body, in the same order as ownership transfer.
    // The owned worker below keeps all three proofs while a roster write waits
    // for its store gate or its durable command, even if the caller disconnects.
    let membership = state.membership_gate.clone().read_owned().await;
    require_member(&state, &auth).await?;
    let authorization = auth.admit_current(&state).await?;
    let owner = state.owner_user_id.clone().read_owned().await;
    if *owner != Some(auth.user_id) {
        return Err(AppError::Forbidden("community owner required".into()));
    }
    let token = headers
        .get(STEPUP_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| AppError::Unauthorized("step-up authentication required".into()))?;
    let stepup = decode_token(token, &state.config.jwt_secret).await?;
    authorization.validate_stepup(&stepup, auth.user_id)?;
    let operation_state = state.clone();
    authorization
        .run(&operation_state, async move {
            let _membership = membership;
            let _owner = owner;
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
                    RosterError::Conflict => {
                        AppError::Conflict("community roster version changed".into())
                    }
                    RosterError::Io(message) => {
                        AppError::Internal(format!("community roster write: {message}"))
                    }
                })
        })
        .await
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
