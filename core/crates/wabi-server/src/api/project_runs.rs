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
    projections::project_runs::{ProjectRun, RunStep},
};

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
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
    let runs = state
        .wdb
        .project_runs(&channel)?
        .into_iter()
        .filter(|r| !auth.is_bot || r.bot_user_id == auth.user_id as u64)
        .collect::<Vec<_>>();
    Ok(Json(json!({"runs": runs})))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Create {
    operation_id: String,
    bot_user_id: u64,
    mode: String,
    prompt: String,
    provider_consent: bool,
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
    if !auth.is_bot || run.bot_user_id != auth.user_id as u64 {
        return Err(AppError::Forbidden(
            "Only the assigned bot may claim this run".into(),
        ));
    }
    crate::channel_access::require_participation(&state, run.created_by_user_id as i64, &channel)
        .await?;
    if run.revision != p.expected_revision || run.status != "queued" || run.pending.is_some() {
        return Err(conflict());
    }
    if state
        .wdb
        .project_runs(&channel)?
        .iter()
        .any(|r| r.status == "running")
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
    let active = matches!(run.status.as_str(), "queued" | "running" | "paused");
    match p.action.as_str() {
        "pause" if matches!(run.status.as_str(), "queued" | "running") => { run.status = "paused".into(); run.checkpoint = "Paused by a project member".into(); }
        "cancel" if active => { run.status = "cancelled".into(); run.checkpoint = "Cancelled by a project member".into(); }
        "takeover" if active => { run.status = "taken_over".into(); run.checkpoint = "A human has taken over; this worker may make no further edits".into(); }
        "resume" if (run.status == "paused" || run.status == "running" && run.lease_until_micros <= now()) && run.pending.is_none() && run.steps.len() < 12 => { run.status = "queued".into(); run.checkpoint = "Resumed by a project member; waiting for a new attempt".into(); }
        _ => return Err(AppError::BadRequest("This run cannot perform that action. An uncertain pending edit requires takeover or cancellation and review".into())),
    }
    run.attempt += 1;
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
    {
        return Err(conflict());
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
