//! Project-scoped assistant inbox and one bounded, fenced worker attempt.
use super::project_tasks::{
    estimate_guard, require_project, task_json, validate, validate_assignee, write_error,
};
use crate::{
    auth_extractor::AuthUser,
    error::{AppError, Result},
    state::AppState,
};
use axum::{
    extract::{Path, State},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use wabidb::{
    engine::wabi_store::WabiStore,
    projections::project_runs::{ProjectRun, ProjectWorker, RecoveryPolicy, RunStep},
};

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/{channel_id}/workers",
            axum::routing::get(workers).post(register_worker),
        )
        .route(
            "/{channel_id}/workers/{worker_id}/heartbeat",
            axum::routing::post(worker_heartbeat),
        )
        .route(
            "/{channel_id}/workers/{worker_id}",
            axum::routing::delete(disable_worker),
        )
        .route("/{channel_id}/runs", axum::routing::get(list).post(create))
        .route(
            "/{channel_id}/runs/{run_id}/control",
            axum::routing::post(control),
        )
        .route(
            "/{channel_id}/runs/{run_id}/claim",
            axum::routing::post(claim),
        )
        .route(
            "/{channel_id}/runs/{run_id}/step",
            axum::routing::post(step),
        )
}
const WORKER_CONTACT_WINDOW: i64 = 180_000_000;
async fn worker_addon(state: &AppState) -> Result<()> {
    if state
        .addon_enabled(
            "project-workers",
            Some("WABI_PROJECT_WORKERS_ENABLED"),
            false,
        )
        .await
    {
        Ok(())
    } else {
        Err(AppError::NotFound(
            "The AI Worker Connections addon is disabled".into(),
        ))
    }
}
async fn available_worker(state: &AppState, channel: &str, id: &str) -> Result<ProjectWorker> {
    let worker = state
        .wdb
        .project_worker(channel, id)?
        .filter(|w| w.enabled && w.last_seen_micros > now() - WORKER_CONTACT_WINDOW)
        .ok_or_else(|| {
            AppError::BadRequest(
                "Computer has not reported recently. Start its worker and refresh".into(),
            )
        })?;
    crate::channel_access::require_participation(state, worker.bot_user_id as i64, channel).await?;
    Ok(worker)
}
async fn workers(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel): Path<String>,
) -> Result<Json<Value>> {
    admission(&state, &auth, &channel).await?;
    if worker_addon(&state).await.is_err() {
        return Ok(Json(
            json!({"enabled":false,"workers":[],"serverNowMicros":now(),"contactWindowMicros":WORKER_CONTACT_WINDOW}),
        ));
    }
    let mut workers = vec![];
    let owner = state.is_owner(auth.user_id).await;
    for worker in state
        .wdb
        .project_workers(&channel)?
        .into_iter()
        .filter(|w| w.enabled)
    {
        if crate::channel_access::require_participation(&state, worker.bot_user_id as i64, &channel)
            .await
            .is_ok()
        {
            let mut row = json!(worker);
            row["canRemove"] =
                json!(owner || auth.is_bot && worker.bot_user_id == auth.user_id as u64);
            workers.push(row);
        }
    }
    Ok(Json(
        json!({"enabled":true,"workers":workers,"serverNowMicros":now(),"contactWindowMicros":WORKER_CONTACT_WINDOW}),
    ))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegisterWorker {
    worker_id: String,
    name: String,
    harness: String,
    provider: String,
    model: String,
}
async fn register_worker(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel): Path<String>,
    Json(p): Json<RegisterWorker>,
) -> Result<Json<Value>> {
    let _membership = state.membership_gate.read().await;
    admission(&state, &auth, &channel).await?;
    if !auth.is_bot {
        return Err(AppError::Forbidden(
            "Only a scoped bot can enroll its computer".into(),
        ));
    }
    worker_addon(&state).await?;
    uuid::Uuid::parse_str(&p.worker_id).map_err(|_| {
        AppError::BadRequest("workerId must be a persistent UUID generated on this computer".into())
    })?;
    for (value, max) in [
        (&p.name, 80),
        (&p.harness, 80),
        (&p.provider, 100),
        (&p.model, 200),
    ] {
        if value.trim().is_empty() || value.len() > max || value.chars().any(char::is_control) {
            return Err(AppError::BadRequest(
                "Provide bounded computer, harness, provider and model labels".into(),
            ));
        }
    }
    let _write = state.wdb.project_run_write.lock().await;
    if let Some(old) = state.wdb.project_worker(&channel, &p.worker_id)? {
        if old.bot_user_id != auth.user_id as u64 {
            return Err(AppError::Forbidden(
                "This worker belongs to another bot".into(),
            ));
        }
        if !old.enabled {
            return Err(AppError::Forbidden(
                "This registration was removed. Enroll with a new worker ID".into(),
            ));
        }
    } else if state
        .wdb
        .project_workers(&channel)?
        .iter()
        .filter(|w| w.enabled)
        .count()
        >= 64
    {
        return Err(AppError::BadRequest(
            "Remove an unused registration before adding another computer".into(),
        ));
    }
    let worker = ProjectWorker {
        schema_version: 1,
        worker_id: p.worker_id,
        channel_id: channel,
        bot_user_id: auth.user_id as u64,
        name: p.name.trim().into(),
        harness: p.harness,
        provider: p.provider,
        model: p.model,
        last_seen_micros: now(),
        enabled: true,
    };
    state
        .wdb
        .save_project_worker(&worker, auth.user_id as u64)
        .await?;
    Ok(Json(json!(worker)))
}
async fn worker_heartbeat(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((channel, id)): Path<(String, String)>,
) -> Result<Json<Value>> {
    let _membership = state.membership_gate.read().await;
    admission(&state, &auth, &channel).await?;
    let _write = state.wdb.project_run_write.lock().await;
    let mut worker = state
        .wdb
        .project_worker(&channel, &id)?
        .filter(|w| w.enabled)
        .ok_or_else(|| AppError::NotFound("Worker is not enrolled".into()))?;
    worker_addon(&state).await?;
    if !auth.is_bot || worker.bot_user_id != auth.user_id as u64 {
        return Err(AppError::Forbidden(
            "Only this bot may report worker contact".into(),
        ));
    }
    if worker.last_seen_micros < now() - 20_000_000 {
        worker.last_seen_micros = now();
        state
            .wdb
            .save_project_worker(&worker, auth.user_id as u64)
            .await?;
    }
    Ok(Json(json!(worker)))
}
async fn disable_worker(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((channel, id)): Path<(String, String)>,
) -> Result<Json<Value>> {
    let _membership = state.membership_gate.read().await;
    admission(&state, &auth, &channel).await?;
    let _write = state.wdb.project_run_write.lock().await;
    let mut worker = state
        .wdb
        .project_worker(&channel, &id)?
        .ok_or_else(|| AppError::NotFound("Worker not found".into()))?;
    if auth.is_bot && worker.bot_user_id != auth.user_id as u64 {
        return Err(AppError::Forbidden(
            "Cannot remove another bot's worker".into(),
        ));
    }
    if !auth.is_bot && !state.is_owner(auth.user_id).await {
        return Err(AppError::Forbidden(
            "Only the server owner can remove a computer registration".into(),
        ));
    }
    worker.enabled = false;
    state
        .wdb
        .save_project_worker(&worker, auth.user_id as u64)
        .await?;
    Ok(Json(json!({"removed":true})))
}
fn now() -> i64 {
    chrono::Utc::now().timestamp_micros()
}
fn conflict() -> AppError {
    AppError::Conflict("Run changed or this worker attempt is no longer active".into())
}
async fn admission(state: &AppState, auth: &AuthUser, channel: &str) -> Result<()> {
    require_project(state, channel).await?;
    crate::channel_access::require_participation(state, auth.user_id, channel).await?;
    let blacklist = state
        .get_blacklist()
        .await
        .ok_or_else(|| AppError::Internal("Restriction enforcement unavailable".into()))?;
    if blacklist
        .is_channel_timed_out(channel, auth.user_id)
        .await
        .is_some()
    {
        return Err(AppError::Forbidden(
            "You are timed out in this project".into(),
        ));
    }
    Ok(())
}
fn get(state: &AppState, channel: &str, id: &str) -> Result<ProjectRun> {
    state
        .wdb
        .project_run(channel, id)?
        .ok_or_else(|| AppError::NotFound("Run not found in this project".into()))
}
async fn save(state: &AppState, run: &mut ProjectRun, actor: u64) -> Result<()> {
    run.revision += 1;
    run.updated_at_micros = now();
    state.wdb.save_project_run(run, actor).await?;
    Ok(())
}
async fn list(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel): Path<String>,
) -> Result<Json<Value>> {
    admission(&state, &auth, &channel).await?;
    let worker_ids: Vec<String> = state
        .wdb
        .project_workers(&channel)?
        .into_iter()
        .filter(|w| w.enabled && w.bot_user_id == auth.user_id as u64)
        .map(|w| w.worker_id)
        .collect();
    let runs = state
        .wdb
        .project_runs(&channel)?
        .into_iter()
        .filter(|r| {
            !auth.is_bot
                || r.bot_user_id == auth.user_id as u64
                || r.recovery_policy
                    .as_ref()
                    .is_some_and(|p| p.backup_worker_ids.iter().any(|id| worker_ids.contains(id)))
        })
        .collect::<Vec<_>>();
    let workers_enabled = state
        .addon_enabled(
            "project-workers",
            Some("WABI_PROJECT_WORKERS_ENABLED"),
            false,
        )
        .await;
    Ok(Json(
        json!({"runs": runs,"serverNowMicros":now(),"workersEnabled":workers_enabled}),
    ))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Create {
    operation_id: String,
    bot_user_id: u64,
    mode: String,
    prompt: String,
    provider_consent: bool,
    #[serde(default)]
    worker_id: Option<String>,
    #[serde(default)]
    recovery_policy: Option<RecoveryPolicy>,
}
async fn create(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel): Path<String>,
    Json(p): Json<Create>,
) -> Result<Json<Value>> {
    let _membership = state.membership_gate.read().await;
    admission(&state, &auth, &channel).await?;
    if auth.is_bot {
        return Err(AppError::Forbidden(
            "Only a human can request assistant work".into(),
        ));
    }
    if !p.provider_consent {
        return Err(AppError::BadRequest("Confirm that this request and selected Project content may be sent to the worker's model provider".into()));
    }
    if !matches!(p.mode.as_str(), "chat" | "work")
        || p.prompt.trim().is_empty()
        || p.prompt.chars().count() > 16000
    {
        return Err(AppError::BadRequest(
            "Choose chat or work and provide a prompt of 1–16,000 characters".into(),
        ));
    }
    if !state.bot_registry.is_bot(p.bot_user_id).await {
        return Err(AppError::BadRequest(
            "Select an authorized project bot".into(),
        ));
    }
    crate::channel_access::require_participation(&state, p.bot_user_id as i64, &channel).await?;
    if let Some(id) = &p.worker_id {
        worker_addon(&state).await?;
        let worker = available_worker(&state, &channel, id).await?;
        if worker.bot_user_id != p.bot_user_id {
            return Err(AppError::BadRequest(
                "Computer does not belong to the selected service".into(),
            ));
        }
        if let Some(policy) = &p.recovery_policy {
            if policy.backup_worker_ids.is_empty()
                || policy.backup_worker_ids.len() > 8
                || !(1..=3).contains(&policy.max_recoveries)
            {
                return Err(AppError::BadRequest(
                    "Choose 1–8 backups and at most 3 recoveries".into(),
                ));
            }
            for backup in &policy.backup_worker_ids {
                let candidate = available_worker(&state, &channel, backup).await?;
                if backup == id
                    || candidate.provider != worker.provider
                    || candidate.model != worker.model
                    || candidate.harness != worker.harness
                {
                    return Err(AppError::BadRequest("Backups must be different computers with the same harness, provider and model".into()));
                }
            }
        }
    } else if p.recovery_policy.is_some() {
        return Err(AppError::BadRequest(
            "Choose a registered computer before enabling recovery".into(),
        ));
    }
    let id = format!(
        "run_{}",
        uuid::Uuid::parse_str(&p.operation_id)
            .map_err(|_| AppError::BadRequest("operationId must be a UUID".into()))?
            .simple()
    );
    let _write = state.wdb.project_run_write.lock().await;
    if let Some(run) = state.wdb.project_run(&channel, &id)? {
        if run.created_by_user_id == auth.user_id as u64
            && run.bot_user_id == p.bot_user_id
            && run.prompt == p.prompt.trim()
            && run.mode == p.mode
            && run.target_worker_id == p.worker_id
            && run.recovery_policy == p.recovery_policy
        {
            return Ok(Json(json!(run)));
        }
        return Err(conflict());
    }
    let mut run = ProjectRun {
        schema_version: 1,
        run_id: id,
        channel_id: channel,
        created_by_user_id: auth.user_id as u64,
        bot_user_id: p.bot_user_id,
        mode: p.mode,
        prompt: p.prompt.trim().into(),
        reply: String::new(),
        status: "queued".into(),
        revision: 0,
        attempt: 0,
        lease_until_micros: 0,
        created_at_micros: now(),
        updated_at_micros: now(),
        provider: String::new(),
        model: String::new(),
        checkpoint: "Waiting for the assigned worker".into(),
        pending: None,
        steps: vec![],
        worker_id: None,
        target_worker_id: p.worker_id,
        recovery_policy: p.recovery_policy,
        recovery_count: 0,
    };
    save(&state, &mut run, auth.user_id as u64).await?;
    Ok(Json(json!(run)))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Claim {
    expected_revision: u64,
    provider: String,
    model: String,
    #[serde(default)]
    worker_id: Option<String>,
}
async fn claim(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((channel, id)): Path<(String, String)>,
    Json(p): Json<Claim>,
) -> Result<Json<Value>> {
    let _membership = state.membership_gate.read().await;
    admission(&state, &auth, &channel).await?;
    let _write = state.wdb.project_run_write.lock().await;
    let mut run = get(&state, &channel, &id)?;
    if !auth.is_bot {
        return Err(AppError::Forbidden(
            "Only the assigned bot may claim this run".into(),
        ));
    }
    crate::channel_access::require_participation(&state, run.created_by_user_id as i64, &channel)
        .await?;
    let recovery = run.status == "running" && run.lease_until_micros <= now();
    if run.revision != p.expected_revision
        || !(run.status == "queued" || recovery)
        || run.pending.is_some()
    {
        return Err(conflict());
    }
    if let Some(id) = &p.worker_id {
        worker_addon(&state).await?;
        let worker = available_worker(&state, &channel, id).await?;
        if worker.bot_user_id != auth.user_id as u64
            || worker.provider != p.provider
            || worker.model != p.model
        {
            return Err(AppError::Forbidden(
                "Worker identity or model does not match enrollment".into(),
            ));
        }
        if recovery {
            let policy = run.recovery_policy.as_ref().ok_or_else(conflict)?;
            if !policy.automatic
                || !policy.backup_worker_ids.contains(id)
                || run.worker_id.as_ref() == Some(id)
                || run.recovery_count >= policy.max_recoveries
                || p.provider != run.provider
                || p.model != run.model
            {
                return Err(conflict());
            }
            if let Some(old) = &run.worker_id {
                let old = state
                    .wdb
                    .project_worker(&channel, old)?
                    .ok_or_else(conflict)?;
                if old.last_seen_micros > now() - WORKER_CONTACT_WINDOW {
                    return Err(conflict());
                }
                if old.harness != worker.harness {
                    return Err(conflict());
                }
            }
            run.recovery_count += 1;
        } else if run.bot_user_id != auth.user_id as u64
            || run
                .target_worker_id
                .as_ref()
                .is_some_and(|target| target != id)
        {
            return Err(conflict());
        }
    } else if recovery || run.target_worker_id.is_some() || run.bot_user_id != auth.user_id as u64 {
        return Err(conflict());
    }
    if state
        .wdb
        .project_runs(&channel)?
        .iter()
        .any(|r| r.status == "running" && r.run_id != run.run_id)
    {
        return Err(AppError::Conflict(
            "A worker is already active in this Project. Finish, pause or take over that run first"
                .into(),
        ));
    }
    if p.provider.trim().is_empty()
        || p.provider.len() > 100
        || p.model.trim().is_empty()
        || p.model.len() > 200
    {
        return Err(AppError::BadRequest(
            "Worker must report provider and model".into(),
        ));
    }
    run.status = "running".into();
    run.bot_user_id = auth.user_id as u64;
    run.worker_id = p.worker_id;
    run.attempt += 1;
    run.lease_until_micros = now() + 120_000_000;
    run.provider = p.provider;
    run.model = p.model;
    run.checkpoint = "Worker connected; preparing a response".into();
    save(&state, &mut run, auth.user_id as u64).await?;
    Ok(Json(json!(run)))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Control {
    expected_revision: u64,
    action: String,
    #[serde(default)]
    worker_id: Option<String>,
}
async fn control(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((channel, id)): Path<(String, String)>,
    Json(p): Json<Control>,
) -> Result<Json<Value>> {
    let _membership = state.membership_gate.read().await;
    admission(&state, &auth, &channel).await?;
    if auth.is_bot {
        return Err(AppError::Forbidden(
            "Worker controls belong to humans".into(),
        ));
    }
    let _write = state.wdb.project_run_write.lock().await;
    let mut run = get(&state, &channel, &id)?;
    if run.revision != p.expected_revision {
        return Err(conflict());
    }
    if p.worker_id.is_some() && p.action != "resume" {
        return Err(AppError::BadRequest(
            "Choose a computer only when resuming".into(),
        ));
    }
    let target = if let Some(id) = &p.worker_id {
        worker_addon(&state).await?;
        Some(available_worker(&state, &channel, id).await?)
    } else {
        None
    };
    let active = matches!(run.status.as_str(), "queued" | "running" | "paused");
    match p.action.as_str() {
        "pause" if matches!(run.status.as_str(), "queued" | "running") => { run.status = "paused".into(); run.checkpoint = "Paused by a project member".into(); }
        "cancel" if active => { run.status = "cancelled".into(); run.checkpoint = "Cancelled by a project member".into(); }
        "takeover" if active => { run.status = "taken_over".into(); run.checkpoint = "A human has taken over; this worker may make no further edits".into(); }
        "resume" if (run.status == "paused" || run.status == "running" && run.lease_until_micros <= now()) && run.pending.is_none() && run.steps.len() < 12 => { run.status = "queued".into(); run.checkpoint = "Resumed by a project member; waiting for a new attempt".into(); }
        _ => return Err(AppError::BadRequest("This run cannot perform that action. An uncertain pending edit requires takeover or cancellation and review".into())),
    }
    run.attempt += 1;
    if p.action == "resume" {
        if let Some(target) = target {
            if !run.provider.is_empty()
                && (target.provider != run.provider || target.model != run.model)
            {
                return Err(AppError::BadRequest(
                    "Resume requires the same provider and model; request a new run to change them"
                        .into(),
                ));
            }
            run.bot_user_id = target.bot_user_id;
            run.target_worker_id = Some(target.worker_id);
        }
    }
    run.worker_id = None;
    run.lease_until_micros = 0;
    save(&state, &mut run, auth.user_id as u64).await?;
    Ok(Json(json!(run)))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Step {
    expected_revision: u64,
    attempt: u64,
    operation_id: String,
    tool: String,
    arguments: Value,
    #[serde(default)]
    worker_id: Option<String>,
}
async fn step(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((channel, id)): Path<(String, String)>,
    Json(p): Json<Step>,
) -> Result<Json<Value>> {
    let _membership = state.membership_gate.read().await;
    admission(&state, &auth, &channel).await?;
    let _write = state.wdb.project_run_write.lock().await;
    let mut run = get(&state, &channel, &id)?;
    if !auth.is_bot || run.bot_user_id != auth.user_id as u64 {
        return Err(AppError::Forbidden(
            "Only the assigned bot may advance this run".into(),
        ));
    }
    crate::channel_access::require_participation(&state, run.created_by_user_id as i64, &channel)
        .await?;
    uuid::Uuid::parse_str(&p.operation_id)
        .map_err(|_| AppError::BadRequest("operationId must be a UUID".into()))?;
    if let Some(old) = run.steps.iter().find(|s| s.operation_id == p.operation_id) {
        if old.tool == p.tool && old.arguments == p.arguments {
            return Ok(Json(json!(run)));
        }
        return Err(conflict());
    }
    if run.revision != p.expected_revision
        || run.attempt != p.attempt
        || run.status != "running"
        || run.lease_until_micros <= now()
        || run.pending.is_some()
        || run.worker_id != p.worker_id
    {
        return Err(conflict());
    }
    if let Some(id) = &p.worker_id {
        worker_addon(&state).await?;
        let worker = available_worker(&state, &channel, id).await?;
        if worker.bot_user_id != auth.user_id as u64 {
            return Err(conflict());
        }
    }
    if p.arguments.get("humanEstimateMinutes").is_some() {
        return Err(AppError::Forbidden(
            "Human estimates are entirely outside worker tools".into(),
        ));
    }
    if p.arguments.to_string().len() > 64000 {
        return Err(AppError::BadRequest("Tool arguments are too large".into()));
    }
    if matches!(p.tool.as_str(), "complete" | "fail") {
        let reply = p
            .arguments
            .get("reply")
            .and_then(Value::as_str)
            .unwrap_or("");
        if reply.trim().is_empty() || reply.len() > 32000 {
            return Err(AppError::BadRequest(
                "Provide a reply of 1–32,000 bytes".into(),
            ));
        }
        run.reply = reply.into();
        run.status = if p.tool == "complete" {
            "completed"
        } else {
            "failed"
        }
        .into();
        run.checkpoint = if p.tool == "complete" {
            "Finished"
        } else {
            "Worker reported a failure; review before requesting a new run"
        }
        .into();
        run.steps.push(RunStep {
            operation_id: p.operation_id,
            tool: p.tool,
            arguments: p.arguments,
            result: json!({"accepted": true}),
        });
        run.lease_until_micros = 0;
        save(&state, &mut run, auth.user_id as u64).await?;
        return Ok(Json(json!(run)));
    }
    if run.mode != "work" || run.steps.len() >= 12 {
        return Err(AppError::Forbidden(
            "Chat cannot execute tools; work is limited to 12 tool steps".into(),
        ));
    }
    if !matches!(
        p.tool.as_str(),
        "list_cards"
            | "read_card"
            | "claim_card"
            | "create_card"
            | "update_card"
            | "list_pages"
            | "read_page"
            | "create_page"
            | "update_page"
    ) {
        return Err(AppError::BadRequest("This tool is not allowed".into()));
    }
    // Persist intent before any tool side effect. A crash here leaves an uncertain
    // pending checkpoint: no automatic retry, even on the same host.
    run.pending = Some(RunStep {
        operation_id: p.operation_id.clone(),
        tool: p.tool.clone(),
        arguments: p.arguments.clone(),
        result: Value::Null,
    });
    run.checkpoint = format!("Executing {}", p.tool);
    save(&state, &mut run, auth.user_id as u64).await?;
    let outcome = tool(&state, &auth, &channel, &p).await;
    let result = match outcome {
        Ok(v) => v,
        Err(AppError::Wdb(e)) => return Err(AppError::Wdb(e)),
        Err(e) => {
            run.status = "failed".into();
            run.reply =
                "A Project tool was rejected. Review the checkpoint before retrying.".into();
            json!({"error": e.to_string()})
        }
    };
    let mut finished = run.pending.take().unwrap();
    finished.result = result;
    run.steps.push(finished);
    run.checkpoint = format!("{} tool steps recorded", run.steps.len());
    run.lease_until_micros = now() + 120_000_000;
    save(&state, &mut run, auth.user_id as u64).await?;
    Ok(Json(json!(run)))
}
fn string<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::BadRequest(format!("Missing {key}")))
}
async fn tool(state: &AppState, auth: &AuthUser, channel: &str, p: &Step) -> Result<Value> {
    let a = &p.arguments;
    match p.tool.as_str() {
        "list_cards" => Ok(
            json!({"tasks": state.wdb.list_project_tasks(channel)?.into_iter().filter(|t| !t.is_archived).take(100).map(|t| json!({"taskId": t.task_id, "title": t.title, "status": t.status, "revision": t.revision})).collect::<Vec<_>>() }),
        ),
        "read_card" => Ok(task_json(
            state
                .wdb
                .get_project_task(channel, string(a, "taskId")?)?
                .ok_or_else(|| AppError::NotFound("Card not found".into()))?,
            true,
        )),
        "claim_card" => {
            let expected = a
                .get("expectedRevision")
                .and_then(Value::as_u64)
                .ok_or_else(|| AppError::BadRequest("Missing expectedRevision".into()))?;
            Ok(task_json(
                super::project_tasks::claim_task_internal(
                    state,
                    auth,
                    channel,
                    string(a, "taskId")?,
                    expected,
                )
                .await?,
                true,
            ))
        }
        "create_card" | "update_card" => {
            let mut fields: crate::adapter::project_tasks::ProjectTaskFields =
                serde_json::from_value(a.clone())
                    .map_err(|_| AppError::BadRequest("Invalid card fields".into()))?;
            estimate_guard(auth, &fields)?;
            validate(&mut fields)?;
            validate_assignee(state, channel, &fields).await?;
            let task = if p.tool == "create_card" {
                let id = format!(
                    "task_{}",
                    uuid::Uuid::parse_str(&p.operation_id).unwrap().simple()
                );
                state
                    .wdb
                    .create_project_task(channel, &id, fields, auth.user_id as u64)
                    .await
                    .map_err(write_error)?
            } else {
                let revision = a
                    .get("expectedRevision")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| AppError::BadRequest("Missing expectedRevision".into()))?;
                state
                    .wdb
                    .update_project_task(
                        channel,
                        string(a, "taskId")?,
                        revision,
                        fields,
                        auth.user_id as u64,
                    )
                    .await
                    .map_err(write_error)?
            };
            Ok(task_json(task, true))
        }
        "list_pages" => Ok(
            json!({"pages": state.wdb.list_wiki_pages(channel).await?.into_iter().filter(|p| !p.is_deleted).take(100).map(|p| json!({"pageId": p.page_id, "title": p.title, "updatedAtMicros": p.updated_at_micros})).collect::<Vec<_>>() }),
        ),
        "read_page" => {
            let mut page = state
                .wdb
                .get_wiki_page(channel, string(a, "pageId")?)
                .await?
                .filter(|p| !p.is_deleted)
                .ok_or_else(|| AppError::NotFound("Page not found".into()))?;
            let truncated = page.body.len() > 24000;
            if truncated {
                let mut end = 24000;
                while !page.body.is_char_boundary(end) {
                    end -= 1;
                }
                page.body.truncate(end);
            }
            let mut value = json!(page);
            value["truncated"] = json!(truncated);
            Ok(value)
        }
        "create_page" | "update_page" => {
            let title = string(a, "title")?.trim();
            let body = string(a, "body")?;
            if title.is_empty() || title.chars().count() > 200 || body.len() > 32000 {
                return Err(AppError::BadRequest("Invalid wiki title or body".into()));
            }
            let id = if p.tool == "create_page" {
                state
                    .wdb
                    .create_wiki_page(channel, title, body, auth.user_id as u64, "", "", 0)
                    .await?
            } else {
                let id = string(a, "pageId")?;
                let expected = a
                    .get("expectedUpdatedAtMicros")
                    .and_then(Value::as_i64)
                    .ok_or_else(|| {
                        AppError::BadRequest("Missing expectedUpdatedAtMicros".into())
                    })?;
                state
                    .wdb
                    .update_wiki_page_checked(
                        channel,
                        id,
                        expected,
                        title,
                        body,
                        auth.user_id as u64,
                        None,
                        None,
                        None,
                    )
                    .await
                    .map_err(|e| match e {
                        crate::adapter::wiki_checks::WikiWriteError::Storage(e) => AppError::Wdb(e),
                        crate::adapter::wiki_checks::WikiWriteError::Conflict => conflict(),
                        _ => AppError::NotFound("Page not found".into()),
                    })?;
                id.into()
            };
            Ok(json!({"pageId": id}))
        }
        _ => Err(AppError::BadRequest("Unknown tool".into())),
    }
}
