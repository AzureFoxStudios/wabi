//! Shared Project Kanban API. Human and bot credentials use the same channel guard.
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use wabidb::domain::ChannelKind;
use wabidb::engine::wabi_store::WabiStore;

use crate::adapter::project_tasks::{EstimateChange, ProjectTaskFields, ProjectTaskWriteError};
use crate::auth_extractor::AuthUser;
use crate::error::{AppError, Result};
use crate::state::AppState;

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .merge(super::project_runs::routes())
        .route(
            "/{channel_id}/tasks",
            axum::routing::get(list_tasks).post(create_task),
        )
        .route(
            "/{channel_id}/tasks/{task_id}/claim",
            axum::routing::post(claim_task),
        )
        .route(
            "/{channel_id}/tasks/{task_id}",
            axum::routing::get(get_task).put(update_task),
        )
        .route("/{channel_id}/history", axum::routing::get(history))
        .route("/{channel_id}/members", axum::routing::get(list_members))
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            crate::channel_access::require_channel,
        ))
        .with_state(state)
}

pub(crate) async fn require_project(state: &AppState, channel_id: &str) -> Result<()> {
    let channel = state
        .wdb
        .get_channel(channel_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Project channel not found".into()))?;
    if !matches!(
        channel.channel_kind,
        ChannelKind::Planning | ChannelKind::Lore
    ) {
        return Err(AppError::BadRequest(
            "Tasks require a Planning or Project channel".into(),
        ));
    }
    Ok(())
}

pub(crate) fn validate(fields: &mut ProjectTaskFields) -> Result<()> {
    fields.title = fields.title.trim().to_owned();
    if fields.title.is_empty() || fields.title.chars().count() > 200 {
        return Err(AppError::BadRequest(
            "Task title must be 1–200 characters".into(),
        ));
    }
    if fields.description.chars().count() > 16_000 {
        return Err(AppError::BadRequest("Task description is too long".into()));
    }
    if !matches!(
        fields.status.as_str(),
        "ideas" | "todo" | "in_progress" | "done" | "scrapped" | "archived"
    ) {
        return Err(AppError::BadRequest("Invalid task status".into()));
    }
    if !matches!(
        fields.priority.as_str(),
        "low" | "medium" | "high" | "urgent"
    ) {
        return Err(AppError::BadRequest("Invalid task priority".into()));
    }
    if fields
        .due_date_millis
        .is_some_and(|due| !(0..=253_402_300_799_000).contains(&due))
    {
        return Err(AppError::BadRequest("Invalid task due date".into()));
    }
    if fields
        .notes
        .as_ref()
        .is_some_and(|v| v.chars().count() > 16000)
    {
        return Err(AppError::BadRequest("Notes are too long".into()));
    }
    if let Some(items) = &fields.checklist {
        let mut ids = std::collections::HashSet::new();
        if items.len() > 100
            || items.iter().any(|v| {
                v.id.is_empty()
                    || v.id.len() > 128
                    || !ids.insert(&v.id)
                    || v.title.trim().is_empty()
                    || v.title.chars().count() > 500
            })
        {
            return Err(AppError::BadRequest(
                "Invalid checklist (up to 100 unique items)".into(),
            ));
        }
    }
    if matches!(fields.human_estimate_minutes, EstimateChange::Set(Some(v)) if v > 600_000) {
        return Err(AppError::BadRequest(
            "Estimate must be at most 10,000 hours".into(),
        ));
    }
    if fields
        .related_task_ids
        .as_ref()
        .is_some_and(|v| v.len() > 100)
    {
        return Err(AppError::BadRequest("Too many linked cards".into()));
    }
    Ok(())
}

pub(crate) fn task_json(
    task: wabidb::projections::project_tasks::ProjectTaskRecord,
    bot: bool,
) -> Value {
    let mut value = json!(task);
    if bot {
        value
            .as_object_mut()
            .unwrap()
            .remove("humanEstimateMinutes");
    }
    value
}
pub(crate) fn estimate_guard(auth: &AuthUser, fields: &ProjectTaskFields) -> Result<()> {
    if auth.is_bot && fields.human_estimate_minutes != EstimateChange::Keep {
        return Err(AppError::Forbidden(
            "Human estimates cannot be read or written by bots".into(),
        ));
    }
    Ok(())
}
async fn history(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<String>,
) -> Result<Json<Value>> {
    let _membership = state.membership_gate.read().await;
    let _authorization = auth.admit_current(&state).await?;
    crate::channel_access::require_access(&state, auth.user_id, &channel_id).await?;
    require_project(&state, &channel_id).await?;
    if auth.is_bot {
        return Err(AppError::Forbidden("Estimate history is for humans".into()));
    }
    let items = state.wdb.project_task_history(&channel_id)?;
    Ok(Json(json!({"history": items})))
}

pub(crate) async fn validate_assignee(
    state: &AppState,
    channel_id: &str,
    fields: &ProjectTaskFields,
) -> Result<()> {
    if let Some(ids) = &fields.related_task_ids {
        for id in ids {
            if state.wdb.get_project_task(channel_id, id)?.is_none() {
                return Err(AppError::BadRequest(
                    "Linked card must belong to this project".into(),
                ));
            }
        }
    }
    if let Some(user_id) = fields.assignee_user_id {
        if !crate::channel_access::is_member(state, user_id as i64, channel_id).await? {
            return Err(AppError::BadRequest(
                "Assignee must be a project member".into(),
            ));
        }
    }
    Ok(())
}

pub(crate) fn write_error(error: ProjectTaskWriteError) -> AppError {
    match error {
        ProjectTaskWriteError::Storage(error) => AppError::Wdb(error),
        ProjectTaskWriteError::NotFound => {
            AppError::NotFound("Task not found in this project".into())
        }
        ProjectTaskWriteError::Conflict => {
            AppError::Conflict("Task changed; reload before editing".into())
        }
    }
}

async fn list_tasks(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<String>,
) -> Result<Json<Value>> {
    let _membership = state.membership_gate.read().await;
    let _authorization = auth.admit_current(&state).await?;
    crate::channel_access::require_access(&state, auth.user_id, &channel_id).await?;
    require_project(&state, &channel_id).await?;
    Ok(Json(
        json!({ "tasks": state.wdb.list_project_tasks(&channel_id)?.into_iter().map(|v| task_json(v, auth.is_bot)).collect::<Vec<_>>() }),
    ))
}

async fn list_members(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<String>,
) -> Result<Json<Value>> {
    let _membership = state.membership_gate.read().await;
    let authorization = auth.admit_current(&state).await?;
    crate::channel_access::require_access(&state, auth.user_id, &channel_id).await?;
    require_project(&state, &channel_id).await?;
    let mut members = Vec::new();
    for member in state.wdb.list_channel_members(&channel_id).await? {
        if let Some(user) = state.wdb.get_user(member.user_id).await? {
            if user.is_active {
                members.push(json!({
                    "id": user.user_id,
                    "name": user.username,
                    "isBot": authorization.is_bot_user(&state, user.user_id).await,
                }));
            }
        }
    }
    members.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    Ok(Json(json!({ "members": members })))
}

async fn get_task(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((channel_id, task_id)): Path<(String, String)>,
) -> Result<Json<Value>> {
    let _membership = state.membership_gate.read().await;
    let _authorization = auth.admit_current(&state).await?;
    crate::channel_access::require_access(&state, auth.user_id, &channel_id).await?;
    require_project(&state, &channel_id).await?;
    let task = state
        .wdb
        .get_project_task(&channel_id, &task_id)?
        .ok_or_else(|| AppError::NotFound("Task not found in this project".into()))?;
    Ok(Json(task_json(task, auth.is_bot)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateTaskPayload {
    operation_id: String,
    #[serde(flatten)]
    fields: ProjectTaskFields,
}

async fn create_task(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<String>,
    Json(mut payload): Json<CreateTaskPayload>,
) -> Result<Json<Value>> {
    let authorization = crate::channel_access::admit_mutation(&state, &auth).await?;
    let operation_state = state.clone();
    authorization
        .run(&operation_state, async move {
            crate::channel_access::require_participation(&state, auth.user_id, &channel_id).await?;
            require_project(&state, &channel_id).await?;
            estimate_guard(&auth, &payload.fields)?;
            validate(&mut payload.fields)?;
            validate_assignee(&state, &channel_id, &payload.fields).await?;
            let operation_id = uuid::Uuid::parse_str(&payload.operation_id)
                .map_err(|_| AppError::BadRequest("operationId must be a UUID".into()))?;
            let task_id = format!("task_{}", operation_id.simple());
            let task = state
                .wdb
                .create_project_task(&channel_id, &task_id, payload.fields, auth.user_id as u64)
                .await
                .map_err(write_error)?;
            Ok(Json(task_json(task, auth.is_bot)))
        })
        .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateTaskPayload {
    expected_revision: u64,
    #[serde(flatten)]
    fields: ProjectTaskFields,
}

async fn update_task(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((channel_id, task_id)): Path<(String, String)>,
    Json(mut payload): Json<UpdateTaskPayload>,
) -> Result<Json<Value>> {
    let authorization = crate::channel_access::admit_mutation(&state, &auth).await?;
    let operation_state = state.clone();
    authorization
        .run(&operation_state, async move {
            crate::channel_access::require_participation(&state, auth.user_id, &channel_id).await?;
            require_project(&state, &channel_id).await?;
            estimate_guard(&auth, &payload.fields)?;
            validate(&mut payload.fields)?;
            validate_assignee(&state, &channel_id, &payload.fields).await?;
            let task = state
                .wdb
                .update_project_task(
                    &channel_id,
                    &task_id,
                    payload.expected_revision,
                    payload.fields,
                    auth.user_id as u64,
                )
                .await
                .map_err(write_error)?;
            Ok(Json(task_json(task, auth.is_bot)))
        })
        .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClaimTask {
    expected_revision: u64,
}
async fn claim_task(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((channel, id)): Path<(String, String)>,
    Json(p): Json<ClaimTask>,
) -> Result<Json<Value>> {
    let authorization = crate::channel_access::admit_mutation(&state, &auth).await?;
    let operation_state = state.clone();
    authorization
        .run(&operation_state, async move {
            crate::channel_access::require_participation(&state, auth.user_id, &channel).await?;
            require_project(&state, &channel).await?;
            Ok(Json(task_json(
                claim_task_internal(&state, &auth, &channel, &id, p.expected_revision).await?,
                auth.is_bot,
            )))
        })
        .await
}
pub(crate) async fn claim_task_internal(
    state: &AppState,
    auth: &AuthUser,
    channel: &str,
    id: &str,
    expected: u64,
) -> Result<wabidb::projections::project_tasks::ProjectTaskRecord> {
    let task = state
        .wdb
        .get_project_task(channel, id)?
        .ok_or_else(|| AppError::NotFound("Card not found".into()))?;
    if task.revision != expected {
        return Err(AppError::Conflict(
            "Card changed; reload before claiming".into(),
        ));
    }
    if task
        .assignee_user_id
        .is_some_and(|id| id != auth.user_id as u64)
    {
        return Err(AppError::Conflict(
            "This task is already assigned. Use the assignee selector to explicitly reassign it"
                .into(),
        ));
    }
    if !matches!(task.status.as_str(), "todo" | "ideas" | "in_progress") {
        return Err(AppError::BadRequest(
            "Only unfinished cards can be claimed".into(),
        ));
    }
    if task.assignee_user_id == Some(auth.user_id as u64) && task.status == "in_progress" {
        return Ok(task);
    }
    let fields = ProjectTaskFields {
        title: task.title,
        description: task.description,
        status: "in_progress".into(),
        priority: task.priority,
        due_date_millis: task.due_date_millis,
        assignee_user_id: Some(auth.user_id as u64),
        notes: None,
        checklist: None,
        related_task_ids: None,
        human_estimate_minutes: EstimateChange::Keep,
    };
    state
        .wdb
        .update_project_task(channel, id, expected, fields, auth.user_id as u64)
        .await
        .map_err(write_error)
}
