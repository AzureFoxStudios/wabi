//! HTTP API for the job queue.
//!
//! Routes:
//! - POST /api/jobs              (admin)  submit a new job
//! - GET  /api/jobs              (admin)  list jobs
//! - POST /api/jobs/claim        (helper) claim next available job
//! - POST /api/jobs/:id/result   (helper) report result / failure
//! - POST /api/jobs/:id/cancel   (admin)  cancel a job

use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use std::sync::Arc;

use crate::auth_extractor::AuthUser;
use crate::jobs::{ClaimJobRequest, JobQueueError, JobResultRequest, SubmitJobRequest};
use crate::state::AppState;

async fn require_admin(
    state: &AppState,
    auth: &AuthUser,
) -> Result<
    (
        tokio::sync::OwnedRwLockReadGuard<()>,
        crate::auth_extractor::CurrentAuthorizationGuard,
    ),
    StatusCode,
> {
    let membership = state.membership_gate.clone().read_owned().await;
    let credential = auth
        .admit_current(state)
        .await
        .map_err(|_| StatusCode::UNAUTHORIZED)?;
    if auth.is_guest || auth.is_bot || !state.is_admin(auth.user_id).await {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok((membership, credential))
}

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/", get(list_jobs).post(submit_job))
        .route("/claim", post(claim_job))
        .route("/{job_id}/result", post(report_result))
        .route("/{job_id}/cancel", post(cancel_job))
        .with_state(state)
}

async fn submit_job(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Json(req): Json<SubmitJobRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let _authorization = require_admin(&state, &auth).await?;
    // Media grants must come from the broker/moderation path, which derives
    // the current room, participant and policy. Raw jobs could bypass that
    // admission and the experimental broker fence.
    if req.kind == crate::jobs::JobKind::MediaRelay {
        return Err(StatusCode::FORBIDDEN);
    }
    let job = state.job_queue.submit(req).await;
    Ok(Json(serde_json::json!({
        "jobId": job.job_id,
        "status": job.status,
        "kind": job.kind,
        "createdAt": job.created_at,
    })))
}

async fn list_jobs(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
) -> Result<Json<Vec<serde_json::Value>>, StatusCode> {
    let _authorization = require_admin(&state, &auth).await?;
    let jobs = state.job_queue.list_jobs(None).await;
    let out: Vec<_> = jobs
        .into_iter()
        .map(|j| {
            serde_json::json!({
                "jobId": j.job_id,
                "kind": j.kind,
                "status": j.status,
                "assignedNodeId": j.assigned_node_id,
                "createdAt": j.created_at,
                "completedAt": j.completed_at,
            })
        })
        .collect();
    Ok(Json(out))
}

async fn claim_job(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ClaimJobRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    match state.job_queue.claim_next(&state.node_registry, req).await {
        Ok(job) => Ok(Json(serde_json::json!({
            "jobId": job.job_id,
            "kind": job.kind,
            "payload": job.payload,
            "status": job.status,
        }))),
        Err(JobQueueError::NoMatchingJob) => Err((StatusCode::NO_CONTENT, "no jobs".into())),
        Err(e) => Err((StatusCode::FORBIDDEN, e.to_string())),
    }
}

async fn report_result(
    State(state): State<Arc<AppState>>,
    Path(job_id): Path<String>,
    Json(req): Json<JobResultRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    match state
        .job_queue
        .report_result(&state.node_registry, &job_id, req)
        .await
    {
        Ok(job) => Ok(Json(serde_json::json!({
            "jobId": job.job_id,
            "status": job.status,
            "retryCount": job.retry_count,
        }))),
        Err(JobQueueError::JobNotFound) => Err((StatusCode::NOT_FOUND, "job not found".into())),
        Err(e) => Err((StatusCode::FORBIDDEN, e.to_string())),
    }
}

async fn cancel_job(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(job_id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let _authorization = require_admin(&state, &auth)
        .await
        .map_err(|status| (status, "Admin access required".into()))?;
    match state.job_queue.cancel_job(&job_id).await {
        Ok(job) => Ok(Json(serde_json::json!({
            "jobId": job.job_id,
            "status": job.status,
        }))),
        Err(JobQueueError::JobNotFound) => Err((StatusCode::NOT_FOUND, "job not found".into())),
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
    }
}
