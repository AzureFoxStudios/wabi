//! Server Center APIs: moderation inbox, deterministic safety rules and storage inspection.
//!
//! This module intentionally keeps the first version small and transparent:
//! reports preserve a server-side message snapshot, safety rules are explicit
//! string matches, and destructive storage deletion is owner-only.

use std::{collections::HashMap, path::{Path as FsPath, PathBuf}, sync::Arc};

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
    Extension, Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::RwLock;

use crate::{
    auth_extractor::AuthUser,
    state::AppState,
};
use wabidb::engine::wabi_store::WabiStore;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SafetyMatch {
    Contains,
    Equals,
    StartsWith,
    EndsWith,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SafetyAction {
    Flag,
    Delete,
    Warn,
    Timeout,
    Ban,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SafetyRule {
    pub id: String,
    pub enabled: bool,
    pub name: String,
    pub pattern: String,
    pub r#match: SafetyMatch,
    pub case_sensitive: bool,
    pub action: SafetyAction,
    pub timeout_minutes: Option<u32>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SafetyPolicy {
    pub enabled: bool,
    pub rules: Vec<SafetyRule>,
    pub default_flag_channel_id: Option<String>,
}

impl Default for SafetyPolicy {
    fn default() -> Self {
        Self { enabled: false, rules: Vec::new(), default_flag_channel_id: None }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportStatus {
    Open,
    Reviewing,
    Resolved,
    Dismissed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StaffComment {
    pub id: String,
    pub author_user_id: i64,
    pub author_username: String,
    pub body: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModerationReport {
    pub id: String,
    pub source: String,
    pub channel_id: String,
    pub message_id: String,
    pub message_snapshot: String,
    pub message_was_deleted: bool,
    pub author_user_id: u64,
    pub author_username: String,
    pub reporter_user_id: i64,
    pub reporter_username: String,
    pub reason: String,
    pub comment: Option<String>,
    pub created_at: String,
    pub status: ReportStatus,
    pub assigned_to_user_id: Option<i64>,
    pub assigned_to_username: Option<String>,
    pub resolution: Option<String>,
    pub staff_comments: Vec<StaffComment>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ServerCenterData {
    #[serde(default)]
    safety: SafetyPolicy,
    #[serde(default)]
    reports: Vec<ModerationReport>,
}

struct ServerCenterStore {
    path: PathBuf,
    data: ServerCenterData,
}

impl ServerCenterStore {
    fn load(path: PathBuf) -> Self {
        let data = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<ServerCenterData>(&bytes).ok())
            .unwrap_or_default();
        Self { path, data }
    }

    fn persist(&self) -> anyhow::Result<()> {
        use std::io::Write;
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let bytes = serde_json::to_vec_pretty(&self.data)?;
        let parent = self.path.parent().ok_or_else(|| anyhow::anyhow!("server center data path has no parent"))?;
        let temporary = parent.join(format!(".server-center-{}.tmp", uuid::Uuid::new_v4()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        let result = (|| -> anyhow::Result<()> {
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            std::fs::rename(&temporary, &self.path)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        result
    }
}

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    let store = Arc::new(RwLock::new(ServerCenterStore::load(
        PathBuf::from(&state.config.data_dir).join("server_center.json"),
    )));

    Router::new()
        .route("/safety", get(get_safety).put(put_safety))
        .route("/reports", get(list_reports).post(create_report))
        .route("/reports/mine", get(list_my_reports))
        .route("/reports/{report_id}/comment", post(add_staff_comment))
        .route("/reports/{report_id}/status", put(update_report_status))
        .route("/storage", get(list_storage))
        .route("/storage/{filename}", delete(delete_storage_file))
        .layer(Extension(store))
        .with_state(state)
}

fn json_error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

async fn staff_auth(headers: &HeaderMap, state: &Arc<AppState>) -> Result<(i64, String), Response> {
    let auth = crate::api::payments::authenticate_account(headers, state).await?;
    if auth.is_guest {
        return Err(json_error(StatusCode::FORBIDDEN, "Staff access required"));
    }
    let role = state.get_user_highest_role(auth.user_id).await.to_ascii_lowercase();
    if !state.is_admin(auth.user_id).await && !matches!(role.as_str(), "mod" | "moderator") {
        return Err(json_error(StatusCode::FORBIDDEN, "Staff access required"));
    }
    Ok((auth.user_id, auth.username))
}

async fn get_safety(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Extension(store): Extension<Arc<RwLock<ServerCenterStore>>>,
) -> Response {
    if let Err(resp) = crate::api::admin::admin_auth(&headers, &state).await { return resp; }
    Json(json!({ "policy": store.read().await.data.safety.clone() })).into_response()
}

async fn put_safety(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Extension(store): Extension<Arc<RwLock<ServerCenterStore>>>,
    Json(mut policy): Json<SafetyPolicy>,
) -> Response {
    if let Err(resp) = crate::api::admin::admin_auth(&headers, &state).await { return resp; }
    if policy.rules.len() > 250 {
        return json_error(StatusCode::BAD_REQUEST, "Safety rules are limited to 250 entries");
    }
    for rule in &mut policy.rules {
        rule.name = rule.name.trim().chars().take(80).collect();
        rule.pattern = rule.pattern.trim().chars().take(500).collect();
        rule.reason = rule.reason.as_ref().map(|s| s.trim().chars().take(280).collect()).filter(|s: &String| !s.is_empty());
        if rule.id.trim().is_empty() { rule.id = uuid::Uuid::new_v4().to_string(); }
        if rule.pattern.is_empty() {
            return json_error(StatusCode::BAD_REQUEST, "Every enabled safety rule needs a match value");
        }
        if matches!(rule.action, SafetyAction::Timeout) && rule.timeout_minutes.unwrap_or(0) == 0 {
            rule.timeout_minutes = Some(10);
        }
    }
    let mut guard = store.write().await;
    guard.data.safety = policy.clone();
    if let Err(error) = guard.persist() {
        tracing::error!(%error, "failed to persist Server Center safety policy");
        return json_error(StatusCode::SERVICE_UNAVAILABLE, "Could not save safety rules");
    }
    Json(json!({ "policy": policy })).into_response()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateReportInput {
    channel_id: String,
    message_id: String,
    reason: String,
    comment: Option<String>,
}

async fn create_report(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Extension(store): Extension<Arc<RwLock<ServerCenterStore>>>,
    Json(input): Json<CreateReportInput>,
) -> Response {
    if let Err(error) = crate::channel_access::require_access(&state, auth.user_id, &input.channel_id).await {
        return error.into_response();
    }
    let message = match state.wdb.get_message_typed(&input.message_id).await {
        Ok(Some(message)) if message.channel_id == input.channel_id => message,
        Ok(Some(_)) => return json_error(StatusCode::BAD_REQUEST, "Message does not belong to that channel"),
        Ok(None) => return json_error(StatusCode::NOT_FOUND, "Message not found"),
        Err(error) => {
            tracing::error!(%error, "report message lookup failed");
            return json_error(StatusCode::SERVICE_UNAVAILABLE, "Message could not be verified");
        }
    };
    let reason: String = input.reason.trim().chars().take(80).collect();
    if reason.is_empty() { return json_error(StatusCode::BAD_REQUEST, "Choose a report reason"); }
    let comment = input.comment.map(|s| s.trim().chars().take(1000).collect::<String>()).filter(|s| !s.is_empty());
    let author_username = state.wdb.get_user(message.author_user_id).await.ok().flatten().map(|u| u.username).unwrap_or_else(|| format!("User {}", message.author_user_id));
    let report = ModerationReport {
        id: uuid::Uuid::new_v4().to_string(),
        source: "user_report".into(),
        channel_id: input.channel_id,
        message_id: input.message_id,
        message_snapshot: message.content,
        message_was_deleted: message.is_deleted,
        author_user_id: message.author_user_id,
        author_username,
        reporter_user_id: auth.user_id,
        reporter_username: auth.username,
        reason,
        comment,
        created_at: chrono::Utc::now().to_rfc3339(),
        status: ReportStatus::Open,
        assigned_to_user_id: None,
        assigned_to_username: None,
        resolution: None,
        staff_comments: Vec::new(),
    };
    let mut guard = store.write().await;
    guard.data.reports.push(report.clone());
    if let Err(error) = guard.persist() {
        tracing::error!(%error, "failed to persist moderation report");
        return json_error(StatusCode::SERVICE_UNAVAILABLE, "Report could not be saved");
    }
    Json(json!({ "report": report })).into_response()
}

async fn list_reports(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Extension(store): Extension<Arc<RwLock<ServerCenterStore>>>,
) -> Response {
    if let Err(resp) = staff_auth(&headers, &state).await { return resp; }
    let mut reports = store.read().await.data.reports.clone();
    reports.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Json(json!({ "reports": reports })).into_response()
}

async fn list_my_reports(
    auth: AuthUser,
    Extension(store): Extension<Arc<RwLock<ServerCenterStore>>>,
) -> Response {
    let mut reports: Vec<_> = store.read().await.data.reports.iter()
        .filter(|report| report.reporter_user_id == auth.user_id)
        .cloned()
        .collect();
    reports.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    // Do not expose staff-only discussion or reporter-identifying moderation notes back to reporters.
    let public: Vec<_> = reports.into_iter().map(|report| json!({
        "id": report.id,
        "channelId": report.channel_id,
        "messageId": report.message_id,
        "authorUsername": report.author_username,
        "reason": report.reason,
        "comment": report.comment,
        "createdAt": report.created_at,
        "status": report.status,
    })).collect();
    Json(json!({ "reports": public })).into_response()
}

#[derive(Debug, Deserialize)]
struct StaffCommentInput { body: String }

async fn add_staff_comment(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Extension(store): Extension<Arc<RwLock<ServerCenterStore>>>,
    Path(report_id): Path<String>,
    Json(input): Json<StaffCommentInput>,
) -> Response {
    let (user_id, username) = match staff_auth(&headers, &state).await { Ok(v) => v, Err(resp) => return resp };
    let body: String = input.body.trim().chars().take(2000).collect();
    if body.is_empty() { return json_error(StatusCode::BAD_REQUEST, "Comment cannot be empty"); }
    let mut guard = store.write().await;
    let Some(report) = guard.data.reports.iter_mut().find(|report| report.id == report_id) else {
        return json_error(StatusCode::NOT_FOUND, "Report not found");
    };
    let comment = StaffComment {
        id: uuid::Uuid::new_v4().to_string(),
        author_user_id: user_id,
        author_username: username,
        body,
        created_at: chrono::Utc::now().to_rfc3339(),
    };
    report.staff_comments.push(comment.clone());
    if matches!(report.status, ReportStatus::Open) { report.status = ReportStatus::Reviewing; }
    if let Err(error) = guard.persist() {
        tracing::error!(%error, "failed to persist moderation comment");
        return json_error(StatusCode::SERVICE_UNAVAILABLE, "Comment could not be saved");
    }
    Json(json!({ "comment": comment })).into_response()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateReportStatusInput {
    status: ReportStatus,
    resolution: Option<String>,
    assign_to_me: Option<bool>,
}

async fn update_report_status(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Extension(store): Extension<Arc<RwLock<ServerCenterStore>>>,
    Path(report_id): Path<String>,
    Json(input): Json<UpdateReportStatusInput>,
) -> Response {
    let (user_id, username) = match staff_auth(&headers, &state).await { Ok(v) => v, Err(resp) => return resp };
    let mut guard = store.write().await;
    let Some(report) = guard.data.reports.iter_mut().find(|report| report.id == report_id) else {
        return json_error(StatusCode::NOT_FOUND, "Report not found");
    };
    report.status = input.status;
    report.resolution = input.resolution.map(|s| s.trim().chars().take(1000).collect::<String>()).filter(|s| !s.is_empty());
    if input.assign_to_me.unwrap_or(false) {
        report.assigned_to_user_id = Some(user_id);
        report.assigned_to_username = Some(username);
    }
    let updated = report.clone();
    if let Err(error) = guard.persist() {
        tracing::error!(%error, "failed to persist moderation status");
        return json_error(StatusCode::SERVICE_UNAVAILABLE, "Report status could not be saved");
    }
    Json(json!({ "report": updated })).into_response()
}

async fn list_storage(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Response {
    if let Err(resp) = crate::api::admin::admin_auth(&headers, &state).await { return resp; }
    let uploads = state.upload_registry.list().await;
    let mut total_bytes = 0u64;
    let mut by_kind: HashMap<String, (u64, u64)> = HashMap::new();
    let mut files = Vec::with_capacity(uploads.len());
    for upload in uploads {
        total_bytes = total_bytes.saturating_add(upload.size);
        let kind = upload.kind.as_str().to_string();
        let entry = by_kind.entry(kind.clone()).or_insert((0, 0));
        entry.0 += 1;
        entry.1 = entry.1.saturating_add(upload.size);
        let revoked = state.upload_registry.is_revoked(&upload.filename).await;
        let on_disk = FsPath::new(&state.config.uploads_dir).join(&upload.filename).is_file();
        files.push(json!({
            "filename": upload.filename,
            "originalName": upload.original_name,
            "channelId": upload.channel_id,
            "uploaderId": upload.uploader_id,
            "kind": kind,
            "size": upload.size,
            "createdAt": upload.created_at,
            "revoked": revoked,
            "onDisk": on_disk,
        }));
    }
    let summary: Vec<_> = by_kind.into_iter().map(|(kind, (count, bytes))| json!({ "kind": kind, "count": count, "bytes": bytes })).collect();
    Json(json!({ "totalBytes": total_bytes, "fileCount": files.len(), "summary": summary, "files": files })).into_response()
}

async fn delete_storage_file(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(filename): Path<String>,
) -> Response {
    let caller = match crate::api::admin::admin_auth(&headers, &state).await { Ok(id) => id, Err(resp) => return resp };
    if !state.is_owner(caller).await {
        return json_error(StatusCode::FORBIDDEN, "Only the server owner can permanently delete upload bytes");
    }
    if filename.is_empty() || FsPath::new(&filename).file_name().and_then(|name| name.to_str()) != Some(filename.as_str()) {
        return json_error(StatusCode::BAD_REQUEST, "Invalid upload filename");
    }
    let root = PathBuf::from(&state.config.uploads_dir);
    let target = root.join(&filename);
    let known = state.upload_registry.get(&filename).await.is_some();
    if !known {
        return json_error(StatusCode::NOT_FOUND, "Upload is not present in the registry");
    }
    let removed = match tokio::fs::remove_file(&target).await {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => {
            tracing::error!(%error, file=%filename, "failed to remove upload bytes");
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, "Upload could not be deleted from disk");
        }
    };
    // Keep the registry metadata as a tombstone so operators can still explain
    // a broken historical attachment instead of silently losing provenance.
    state.upload_registry.revoke(&filename).await;
    Json(json!({ "success": true, "filename": filename, "removedFromDisk": removed, "revoked": true })).into_response()
}

/// Evaluate the first enabled deterministic safety rule against plain text.
/// The caller decides how to enforce the returned action.
pub fn evaluate_safety_rules(data_dir: &str, content: &str) -> Option<SafetyRule> {
    let path = PathBuf::from(data_dir).join("server_center.json");
    let data = std::fs::read(path).ok().and_then(|bytes| serde_json::from_slice::<ServerCenterData>(&bytes).ok())?;
    if !data.safety.enabled { return None; }
    data.safety.rules.into_iter().find(|rule| {
        if !rule.enabled || rule.pattern.is_empty() { return false; }
        let (haystack, needle) = if rule.case_sensitive {
            (content.to_string(), rule.pattern.clone())
        } else {
            (content.to_lowercase(), rule.pattern.to_lowercase())
        };
        match rule.r#match {
            SafetyMatch::Contains => haystack.contains(&needle),
            SafetyMatch::Equals => haystack == needle,
            SafetyMatch::StartsWith => haystack.starts_with(&needle),
            SafetyMatch::EndsWith => haystack.ends_with(&needle),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_rule_matching_is_literal_and_predictable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("server_center.json");
        let data = ServerCenterData {
            safety: SafetyPolicy {
                enabled: true,
                default_flag_channel_id: None,
                rules: vec![SafetyRule {
                    id: "badword".into(), enabled: true, name: "Bad word".into(), pattern: "BANME".into(),
                    r#match: SafetyMatch::Equals, case_sensitive: false, action: SafetyAction::Ban,
                    timeout_minutes: None, reason: Some("literal test".into()),
                }],
            },
            reports: vec![],
        };
        std::fs::write(&path, serde_json::to_vec(&data).unwrap()).unwrap();
        assert!(evaluate_safety_rules(dir.path().to_str().unwrap(), "banme").is_some());
        assert!(evaluate_safety_rules(dir.path().to_str().unwrap(), "banme please").is_none());
    }
}
