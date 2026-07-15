use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use std::sync::Arc;
use serde_json::{json, Value};

use crate::auth_extractor::AuthUser;
use crate::error::AppError;
use crate::state::AppState;
use wabidb::engine::wabi_store::WabiStore;

pub fn routes(state: Arc<AppState>) -> axum::Router<Arc<AppState>> {
    axum::Router::new()
        .route("/{channel_id}", axum::routing::get(list_incidents).post(create_incident))
        .route(
            "/{channel_id}/{incident_id}",
            axum::routing::get(get_incident).put(update_incident),
        )
        .route(
            "/{channel_id}/{incident_id}/resolve",
            axum::routing::post(resolve_incident),
        )
        .with_state(state)
}

async fn list_incidents(
    State(state): State<Arc<AppState>>,
    Path(channel_id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let incidents = state.wdb.list_incidents(&channel_id).await?;
    Ok(Json(json!({ "incidents": incidents })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateIncidentPayload {
    title: String,
    description: String,
    severity: String,
}

async fn create_incident(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<String>,
    Json(payload): Json<CreateIncidentPayload>,
) -> Result<Json<Value>, AppError> {
    let incident_id = state
        .wdb
        .create_incident(
            &channel_id,
            &payload.title,
            &payload.description,
            &payload.severity,
            auth.user_id as u64,
        )
        .await?;
    let incident = state
        .wdb
        .get_incident(&channel_id, &incident_id)
        .await?
        .ok_or_else(|| AppError::Internal("incident created but not found in projection".into()))?;
    Ok(Json(json!(incident)))
}

async fn get_incident(
    State(state): State<Arc<AppState>>,
    Path((channel_id, incident_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    let incident = state
        .wdb
        .get_incident(&channel_id, &incident_id)
        .await?
        .ok_or_else(|| AppError::NotFound("incident not found".into()))?;
    Ok(Json(json!(incident)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateIncidentPayload {
    title: Option<String>,
    description: Option<String>,
    severity: Option<String>,
    status: Option<String>,
    assigned_user_id: Option<u64>,
}

async fn update_incident(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((channel_id, incident_id)): Path<(String, String)>,
    Json(payload): Json<UpdateIncidentPayload>,
) -> Result<Json<Value>, AppError> {
    let existing = state
        .wdb
        .get_incident(&channel_id, &incident_id)
        .await?
        .ok_or_else(|| AppError::NotFound("incident not found".into()))?;
    state
        .wdb
        .update_incident(
            &channel_id,
            &incident_id,
            payload.title.as_deref().unwrap_or(&existing.title),
            payload.description.as_deref().unwrap_or(&existing.description),
            payload.severity.as_deref().unwrap_or(&existing.severity),
            payload.status.as_deref().unwrap_or(&existing.status),
            payload.assigned_user_id.or(existing.assigned_user_id),
            auth.user_id as u64,
        )
        .await?;
    let incident = state
        .wdb
        .get_incident(&channel_id, &incident_id)
        .await?
        .ok_or_else(|| AppError::NotFound("incident not found".into()))?;
    Ok(Json(json!(incident)))
}

async fn resolve_incident(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((channel_id, incident_id)): Path<(String, String)>,
) -> Result<Json<Value>, AppError> {
    state
        .wdb
        .resolve_incident(&channel_id, &incident_id, auth.user_id as u64)
        .await?;
    let incident = state
        .wdb
        .get_incident(&channel_id, &incident_id)
        .await?
        .ok_or_else(|| AppError::NotFound("incident not found".into()))?;
    Ok(Json(json!(incident)))
}
