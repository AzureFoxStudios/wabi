//! Server Center APIs: moderation inbox, deterministic safety rules, privacy policy and storage inspection.
//!
//! Reports preserve explicitly submitted evidence, safety rules are literal and
//! local, privacy choices are explicit, and destructive storage deletion is owner-only.

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

use crate::{auth_extractor::AuthUser, state::AppState};
use wabidb::engine::wabi_store::WabiStore;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SafetyMatch { Contains, Equals, StartsWith, EndsWith }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SafetyAction { Flag, Delete, Warn, Timeout, Ban }

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
    fn default() -> Self { Self { enabled: false, rules: Vec::new(), default_flag_channel_id: None } }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivacyPolicy {
    pub default_retention: String,
    pub private_content_automation: bool,
    pub analytics_mode: String,
    pub external_processing: String,
    pub report_evidence_preservation: String,
    #[serde(default)] pub report_evidence_days: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CommunityRules {
    pub text: String,
    pub revision: u64,
    pub require_ack_before_posting: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RaidMode { pub until: Option<String> }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommunityRole {
    pub id: String,
    pub name: String,
    #[serde(default)] pub description: String,
}
impl Default for PrivacyPolicy {
    fn default() -> Self {
        Self {
            default_retention: "24h".into(),
            private_content_automation: false,
            analytics_mode: "off".into(),
            external_processing: "none".into(),
            report_evidence_preservation: "explicit_report".into(),
            report_evidence_days: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportStatus { Open, Reviewing, Resolved, Dismissed }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StaffComment {
    pub id: String,
    pub author_user_id: i64,
    pub author_username: String,
    pub body: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaseActionKind { ServerBan, ChannelBan, ChannelTimeout, LiftServerBan, LiftChannelBan, LiftChannelTimeout }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaseAction {
    pub id: String,
    pub kind: CaseActionKind,
    pub actor_user_id: i64,
    pub actor_username: String,
    pub target_user_id: i64,
    pub reason: String,
    pub created_at: String,
    pub expires_at: Option<String>,
    /// Pending survives a crash between the case journal and restriction file.
    /// Staff must inspect a pending entry rather than assuming the action failed.
    pub outcome: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModerationReport {
    pub id: String,
    pub source: String,
    pub channel_id: String,
    pub message_id: String,
    pub message_snapshot: String,
    #[serde(default)] pub evidence_deleted_at: Option<String>,
    #[serde(default)] pub evidence_expires_at: Option<String>,
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
    #[serde(default)] pub actions: Vec<CaseAction>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ServerCenterData {
    #[serde(default)] safety: SafetyPolicy,
    #[serde(default)] privacy: PrivacyPolicy,
    #[serde(default)] reports: Vec<ModerationReport>,
    #[serde(default)] community_rules: CommunityRules,
    #[serde(default)] rules_acknowledged: HashMap<i64, u64>,
    #[serde(default)] raid_mode: RaidMode,
    #[serde(default)] channel_min_roles: HashMap<String, String>,
    #[serde(default)] community_roles: Vec<CommunityRole>,
    #[serde(default)] community_roles_revision: u64,
    #[serde(default)] channel_community_roles: HashMap<String, String>,
    #[serde(default)] member_community_roles: HashMap<i64, Vec<String>>,
    #[serde(default)] welcome_pending: std::collections::HashSet<i64>,
}

pub(crate) struct ServerCenterStore { path: PathBuf, data: ServerCenterData }
impl ServerCenterStore {
    pub(crate) fn load(path: PathBuf) -> Self {
        let data = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice::<ServerCenterData>(&bytes)
                .expect("Server Center data is damaged; preserve server_center.json and restore a matching backup"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => ServerCenterData::default(),
            Err(error) => panic!("Server Center data is unreadable; preserve server_center.json and restore a matching backup: {error}"),
        };
        Self { path, data }
    }
    fn persist(&self) -> anyhow::Result<()> {
        use std::io::Write;
        if let Some(parent) = self.path.parent() { std::fs::create_dir_all(parent)?; }
        let bytes = serde_json::to_vec_pretty(&self.data)?;
        let parent = self.path.parent().ok_or_else(|| anyhow::anyhow!("server center data path has no parent"))?;
        let temporary = parent.join(format!(".server-center-{}.tmp", uuid::Uuid::new_v4()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        let mut file = options.open(&temporary)?;
        let result = (|| -> anyhow::Result<()> {
            file.write_all(&bytes)?; file.sync_all()?; drop(file);
            std::fs::rename(&temporary, &self.path)?; Ok(())
        })();
        if result.is_err() { let _ = std::fs::remove_file(&temporary); }
        result
    }

    fn expire_evidence(&mut self) -> anyhow::Result<usize> {
        let now = chrono::Utc::now();
        let before = self.data.clone();
        let mut expired = 0;
        for report in &mut self.data.reports {
            if report.evidence_deleted_at.is_some() || report.message_snapshot.is_empty() { continue; }
            let Some(until) = report.evidence_expires_at.as_deref() else { continue; };
            if chrono::DateTime::parse_from_rfc3339(until)? <= now {
                report.message_snapshot.clear();
                report.evidence_deleted_at = Some(now.to_rfc3339());
                expired += 1;
            }
        }
        if expired > 0 {
            if let Err(error) = self.persist() {
                self.data = before;
                return Err(error);
            }
        }
        Ok(expired)
    }
}

pub fn validate_sidecar(data_dir: &str) -> anyhow::Result<()> {
    let path = PathBuf::from(data_dir).join("server_center.json");
    match std::fs::read(path) {
        Ok(bytes) => { let data = serde_json::from_slice::<ServerCenterData>(&bytes)
            .map_err(|error| anyhow::anyhow!("Server Center data is damaged; preserve server_center.json and restore a matching backup: {error}"))?;
            validate_server_center_data(&data)?; Ok(()) }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => anyhow::bail!("Server Center data is unreadable; preserve server_center.json and restore a matching backup: {error}"),
    }
}

fn validate_server_center_data(data: &ServerCenterData) -> anyhow::Result<()> {
    anyhow::ensure!(data.privacy.report_evidence_days.is_none_or(|days| matches!(days, 1 | 7 | 30 | 90)),
        "Server Center report evidence lifetime is invalid; preserve server_center.json and restore a matching backup");
    if let Some(until) = data.raid_mode.until.as_deref() {
        chrono::DateTime::parse_from_rfc3339(until)
            .map_err(|error| anyhow::anyhow!("Server Center raid expiry is invalid; preserve server_center.json and restore a matching backup: {error}"))?;
    }
    for report in &data.reports {
        if let Some(until) = report.evidence_expires_at.as_deref() {
            chrono::DateTime::parse_from_rfc3339(until)
                .map_err(|error| anyhow::anyhow!("Report evidence expiry is invalid; preserve server_center.json and restore a matching backup: {error}"))?;
        }
    }
    anyhow::ensure!(data.channel_min_roles.iter().all(|(channel, role)|
        !channel.is_empty() && matches!(role.as_str(), "member" | "moderator" | "admin")),
        "Server Center channel role policy is invalid; preserve server_center.json and restore a matching backup");
    anyhow::ensure!(data.community_roles.len() <= 16, "Too many community roles in Server Center data");
    let mut role_ids = std::collections::HashSet::new();
    for role in &data.community_roles {
        anyhow::ensure!(role.id.starts_with("community-") && role.id.len() <= 80
            && role.id.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-'),
            "Invalid community role ID in Server Center data");
        anyhow::ensure!(!role.name.trim().is_empty() && role.name.chars().count() <= 40
            && role.description.chars().count() <= 240,
            "Invalid community role label in Server Center data");
        anyhow::ensure!(role_ids.insert(role.id.as_str()), "Duplicate community role in Server Center data");
    }
    anyhow::ensure!(data.channel_community_roles.iter().all(|(channel, role)|
        !channel.is_empty() && role_ids.contains(role.as_str())),
        "Invalid channel community role policy in Server Center data");
    anyhow::ensure!(data.member_community_roles.iter().all(|(user, roles)|
        *user > 0 && roles.len() <= 16 && roles.iter().all(|role| role_ids.contains(role.as_str()))),
        "Invalid member community roles in Server Center data");
    anyhow::ensure!(data.welcome_pending.iter().all(|user| *user > 0),
        "Invalid welcome marker in Server Center data");
    Ok(())
}

pub async fn channel_min_role(state: &AppState, channel_id: &str) -> Option<String> {
    state.server_center.read().await.data.channel_min_roles.get(channel_id).cloned()
}

/// Breakouts are created under the shared membership writer. Save their
/// parent's role gates before any roster is moved or room is published.
pub(crate) async fn inherit_channel_gates(state: &AppState, parent: &str, children: &[String]) -> anyhow::Result<()> {
    let mut guard = state.server_center.write().await;
    let before = guard.data.clone();
    let minimum = guard.data.channel_min_roles.get(parent).cloned();
    let community = guard.data.channel_community_roles.get(parent).cloned();
    for child in children {
        if let Some(role) = &minimum { guard.data.channel_min_roles.insert(child.clone(), role.clone()); }
        else { guard.data.channel_min_roles.remove(child); }
        if let Some(role) = &community { guard.data.channel_community_roles.insert(child.clone(), role.clone()); }
        else { guard.data.channel_community_roles.remove(child); }
    }
    if let Err(error) = guard.persist() {
        guard.data = before;
        return Err(error);
    }
    Ok(())
}

async fn evict_inherited_voice_policy(io: &socketioxide::SocketIo, state: &AppState, user_id: Option<i64>) {
    // Existing breakouts dynamically inherit Voice parent policy. Revoke
    // receive rooms while the shared admission writer still fences new media.
    match state.wdb.list_channels(None).await {
        Ok(channels) => for child in channels.into_iter().filter(|child|
            child.channel_kind == wabidb::domain::ChannelKind::Voice && child.parent_id.is_some()) {
            if let Some(user_id) = user_id {
                if !matches!(crate::channel_access::channel_role_allows(state, user_id, &child.channel_id).await, Ok(true)) {
                    crate::socketio::evict_channel_user(io, state, &child.channel_id, user_id).await;
                }
            } else {
                crate::socketio::evict_channel_disallowed(io, state, &child.channel_id).await;
            }
        },
        Err(_) => for socket in io.sockets() {
            let _ = socket.emit("auth-revoked", &json!({ "reason": "Channel policy enforcement unavailable" }));
            let _ = socket.disconnect();
        },
    }
}

pub async fn channel_community_role_allows(state: &AppState, user_id: i64, channel_id: &str) -> bool {
    let guard = state.server_center.read().await;
    let Some(required) = guard.data.channel_community_roles.get(channel_id) else { return true; };
    guard.data.member_community_roles.get(&user_id).is_some_and(|roles| roles.contains(required))
}

pub async fn community_role_exists(state: &AppState, role_id: &str) -> bool {
    state.server_center.read().await.data.community_roles.iter().any(|role| role.id == role_id)
}

pub async fn gated_channel_ids(state: &AppState) -> Vec<String> {
    let guard = state.server_center.read().await;
    guard.data.channel_min_roles.keys().chain(guard.data.channel_community_roles.keys()).cloned().collect()
}

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    let store = state.server_center.clone();
    Router::new()
        .route("/privacy", get(get_privacy).put(put_privacy))
        .route("/safety", get(get_safety).put(put_safety))
        .route("/reports", get(list_reports).post(create_report))
        .route("/reports/mine", get(list_my_reports))
        .route("/reports/{report_id}/comment", post(add_staff_comment))
        .route("/reports/{report_id}/status", put(update_report_status))
        .route("/reports/{report_id}/action", post(apply_report_action))
        .route("/reports/{report_id}/evidence", delete(delete_report_evidence))
        .route("/rules", get(get_community_rules).put(put_community_rules))
        .route("/rules/ack", post(ack_community_rules))
        .route("/raid-mode", get(get_raid_mode).put(put_raid_mode))
        .route("/bans", get(list_account_bans))
        .route("/channel-gates", get(list_channel_gates))
        .route("/channel-gates/{channel_id}", put(set_channel_gate))
        .route("/community-roles", get(list_community_roles).put(put_community_roles))
        .route("/reception", get(get_reception))
        .route("/reception/complete", post(complete_reception))
        .route("/reception/roles", put(put_my_community_roles))
        .route("/storage", get(list_storage))
        .route("/storage/{filename}", delete(delete_storage_file))
        .layer(Extension(store)).with_state(state)
}

pub(crate) fn spawn_evidence_expiry_loop(
    store: &Arc<RwLock<ServerCenterStore>>,
    operations: crate::instance_operations::InstanceOperations,
) {
    let weak_store = Arc::downgrade(store);
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(3600));
        loop {
            interval.tick().await;
            let Some(store) = weak_store.upgrade() else { break; };
            let result = operations
                .run(async {
                    let mut guard = store.write().await;
                    guard.expire_evidence()
                })
                .await;
            if let Err(error) = result {
                tracing::error!(%error, "report evidence expiry could not be saved");
            }
        }
    });
}

fn json_error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

async fn staff_auth(headers: &HeaderMap, state: &Arc<AppState>) -> Result<(i64, String), Response> {
    let auth = crate::api::payments::authenticate_account(headers, state).await?;
    if auth.is_guest { return Err(json_error(StatusCode::FORBIDDEN, "Staff access required")); }
    let role = state.get_user_highest_role(auth.user_id).await.to_ascii_lowercase();
    if !state.is_admin(auth.user_id).await && !matches!(role.as_str(), "mod" | "moderator") {
        return Err(json_error(StatusCode::FORBIDDEN, "Staff access required"));
    }
    Ok((auth.user_id, auth.username))
}

async fn get_privacy(
    State(state): State<Arc<AppState>>, headers: HeaderMap,
    Extension(store): Extension<Arc<RwLock<ServerCenterStore>>>,
) -> Response {
    if let Err(resp) = crate::api::admin::admin_auth(&headers, &state).await { return resp; }
    Json(json!({ "policy": store.read().await.data.privacy.clone() })).into_response()
}

async fn put_privacy(
    State(state): State<Arc<AppState>>, headers: HeaderMap,
    Extension(store): Extension<Arc<RwLock<ServerCenterStore>>>, Json(policy): Json<PrivacyPolicy>,
) -> Response {
    if let Err(resp) = crate::api::admin::admin_auth(&headers, &state).await { return resp; }
    if !matches!(policy.default_retention.as_str(), "live" | "1h" | "24h" | "7d" | "30d" | "forever") {
        return json_error(StatusCode::BAD_REQUEST, "Unknown default retention value");
    }
    if !matches!(policy.analytics_mode.as_str(), "off" | "local_aggregate") {
        return json_error(StatusCode::BAD_REQUEST, "Unknown analytics mode");
    }
    if !matches!(policy.external_processing.as_str(), "none" | "declared_integrations") {
        return json_error(StatusCode::BAD_REQUEST, "Unknown external processing mode");
    }
    if policy.report_evidence_preservation != "explicit_report" {
        return json_error(StatusCode::BAD_REQUEST, "Reported evidence must remain explicit");
    }
    if policy.report_evidence_days.is_some_and(|days| !matches!(days, 1 | 7 | 30 | 90)) {
        return json_error(StatusCode::BAD_REQUEST, "Choose manual, 1, 7, 30, or 90 days for new report evidence");
    }
    let mut guard = store.write().await;
    let before = guard.data.clone();
    guard.data.privacy = policy.clone();
    if let Err(error) = guard.persist() {
        guard.data = before;
        tracing::error!(%error, "failed to persist Server Center privacy policy");
        return json_error(StatusCode::SERVICE_UNAVAILABLE, "Could not save privacy policy");
    }
    drop(guard);
    if let Some(io) = state.socket_io() {
        let _ = io.broadcast().emit("privacy-policy-updated", &json!({
            "privateContentAutomation": policy.private_content_automation,
            "analyticsMode": policy.analytics_mode,
            "externalProcessing": policy.external_processing,
        })).await;
    }
    Json(json!({ "policy": policy })).into_response()
}

async fn get_safety(
    State(state): State<Arc<AppState>>, headers: HeaderMap,
    Extension(store): Extension<Arc<RwLock<ServerCenterStore>>>,
) -> Response {
    if let Err(resp) = crate::api::admin::admin_auth(&headers, &state).await { return resp; }
    Json(json!({ "policy": store.read().await.data.safety.clone() })).into_response()
}

async fn put_safety(
    State(state): State<Arc<AppState>>, headers: HeaderMap,
    Extension(store): Extension<Arc<RwLock<ServerCenterStore>>>, Json(mut policy): Json<SafetyPolicy>,
) -> Response {
    if let Err(resp) = crate::api::admin::admin_auth(&headers, &state).await { return resp; }
    if policy.rules.len() > 250 { return json_error(StatusCode::BAD_REQUEST, "Safety rules are limited to 250 entries"); }
    for rule in &mut policy.rules {
        rule.name = rule.name.trim().chars().take(80).collect();
        rule.pattern = rule.pattern.trim().chars().take(500).collect();
        rule.reason = rule.reason.as_ref().map(|s| s.trim().chars().take(280).collect()).filter(|s: &String| !s.is_empty());
        if rule.id.trim().is_empty() { rule.id = uuid::Uuid::new_v4().to_string(); }
        if rule.pattern.is_empty() { return json_error(StatusCode::BAD_REQUEST, "Every enabled safety rule needs a match value"); }
        if matches!(rule.action, SafetyAction::Timeout) && rule.timeout_minutes.unwrap_or(0) == 0 { rule.timeout_minutes = Some(10); }
    }
    let mut guard = store.write().await;
    let before = guard.data.clone();
    guard.data.safety = policy.clone();
    if let Err(error) = guard.persist() {
        guard.data = before;
        tracing::error!(%error, "failed to persist Server Center safety policy");
        return json_error(StatusCode::SERVICE_UNAVAILABLE, "Could not save safety rules");
    }
    Json(json!({ "policy": policy })).into_response()
}

fn needs_rules_acknowledgement(data: &ServerCenterData, user_id: i64) -> bool {
    data.community_rules.require_ack_before_posting
        && !data.community_rules.text.trim().is_empty()
        && data.rules_acknowledged.get(&user_id).copied().unwrap_or(0) < data.community_rules.revision
}

pub fn rules_required_for_post(data_dir: &str, user_id: i64) -> anyhow::Result<bool> {
    Ok(needs_rules_acknowledgement(&read_server_center_data(data_dir)?, user_id))
}

async fn get_community_rules(
    auth: AuthUser, Extension(store): Extension<Arc<RwLock<ServerCenterStore>>>,
) -> Response {
    let guard = store.read().await;
    Json(json!({
        "rules": guard.data.community_rules,
        "acknowledgedRevision": guard.data.rules_acknowledged.get(&auth.user_id).copied().unwrap_or(0),
        "needsAcknowledgement": needs_rules_acknowledgement(&guard.data, auth.user_id),
    })).into_response()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PutCommunityRulesInput { text: String, require_ack_before_posting: bool, material_change: bool }

async fn put_community_rules(
    State(state): State<Arc<AppState>>, headers: HeaderMap,
    Extension(store): Extension<Arc<RwLock<ServerCenterStore>>>, Json(input): Json<PutCommunityRulesInput>,
) -> Response {
    if let Err(resp) = crate::api::admin::admin_auth(&headers, &state).await { return resp; }
    let text = input.text.trim().to_string();
    if text.chars().count() > 12_000 { return json_error(StatusCode::BAD_REQUEST, "Rules must be at most 12,000 characters"); }
    if input.require_ack_before_posting && text.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "Add rules before requiring acknowledgement");
    }
    let mut guard = store.write().await;
    let before = guard.data.clone();
    let changed = guard.data.community_rules.text != text;
    let newly_required = input.require_ack_before_posting && !guard.data.community_rules.require_ack_before_posting;
    let revision = if (changed && (input.material_change || guard.data.community_rules.revision == 0)) || newly_required {
        guard.data.community_rules.revision.saturating_add(1)
    } else { guard.data.community_rules.revision };
    guard.data.community_rules = CommunityRules { text, revision, require_ack_before_posting: input.require_ack_before_posting };
    if let Err(error) = guard.persist() {
        guard.data = before;
        tracing::error!(%error, "failed to persist community rules");
        return json_error(StatusCode::SERVICE_UNAVAILABLE, "Rules could not be saved");
    }
    let rules = guard.data.community_rules.clone();
    drop(guard);
    if let Some(io) = state.socket_io() {
        let _ = io.broadcast().emit("community-rules-updated", &json!({ "revision": rules.revision })).await;
    }
    Json(json!({ "rules": rules })).into_response()
}

#[derive(Debug, Deserialize)]
struct RulesAckInput { revision: u64 }

async fn ack_community_rules(
    auth: AuthUser, Extension(store): Extension<Arc<RwLock<ServerCenterStore>>>, Json(input): Json<RulesAckInput>,
) -> Response {
    let mut guard = store.write().await;
    if guard.data.community_rules.text.trim().is_empty() || input.revision != guard.data.community_rules.revision {
        return json_error(StatusCode::CONFLICT, "Rules changed; read the current version before continuing");
    }
    let before = guard.data.clone();
    guard.data.rules_acknowledged.insert(auth.user_id, input.revision);
    if let Err(error) = guard.persist() {
        guard.data = before;
        tracing::error!(%error, "failed to persist rules acknowledgement");
        return json_error(StatusCode::SERVICE_UNAVAILABLE, "Acknowledgement could not be saved");
    }
    Json(json!({ "acknowledgedRevision": input.revision })).into_response()
}

pub fn raid_mode_active(data_dir: &str) -> anyhow::Result<bool> {
    let data = read_server_center_data(data_dir)?;
    match data.raid_mode.until {
        Some(until) => Ok(chrono::DateTime::parse_from_rfc3339(&until)? > chrono::Utc::now()),
        None => Ok(false),
    }
}

async fn get_raid_mode(
    State(state): State<Arc<AppState>>, headers: HeaderMap,
    Extension(store): Extension<Arc<RwLock<ServerCenterStore>>>,
) -> Response {
    if let Err(resp) = staff_auth(&headers, &state).await { return resp; }
    let raid_mode = store.read().await.data.raid_mode.clone();
    Json(json!({ "active": raid_mode.until.as_deref().and_then(|until| chrono::DateTime::parse_from_rfc3339(until).ok()).is_some_and(|until| until > chrono::Utc::now()), "until": raid_mode.until })).into_response()
}

async fn list_account_bans(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Err(resp) = staff_auth(&headers, &state).await { return resp; }
    let Some(blacklist) = state.get_blacklist().await else {
        return json_error(StatusCode::SERVICE_UNAVAILABLE, "Ban enforcement unavailable");
    };
    Json(json!({ "userIds": blacklist.active_user_ban_ids().await })).into_response()
}

async fn list_channel_gates(
    State(state): State<Arc<AppState>>, headers: HeaderMap,
    Extension(store): Extension<Arc<RwLock<ServerCenterStore>>>,
) -> Response {
    if let Err(resp) = crate::api::admin::admin_auth(&headers, &state).await { return resp; }
    Json(json!({ "minRoles": store.read().await.data.channel_min_roles.clone() })).into_response()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChannelGateInput { min_role: Option<String> }

async fn set_channel_gate(
    State(state): State<Arc<AppState>>, headers: HeaderMap,
    Extension(store): Extension<Arc<RwLock<ServerCenterStore>>>, Path(channel_id): Path<String>,
    Json(input): Json<ChannelGateInput>,
) -> Response {
    if let Err(resp) = crate::api::admin::admin_auth(&headers, &state).await { return resp; }
    let role = input.min_role.as_deref().filter(|value| !value.is_empty());
    if role.is_some_and(|value| !matches!(value, "member" | "moderator" | "admin")) {
        return json_error(StatusCode::BAD_REQUEST, "Choose no gate, member, moderator, or admin");
    }
    let channel = match state.wdb.get_channel(&channel_id).await {
        Ok(Some(channel)) if !crate::channel_access::is_conversation(channel.channel_kind)
            && !matches!(channel.channel_kind, wabidb::domain::ChannelKind::Category | wabidb::domain::ChannelKind::Reception) => channel,
        Ok(Some(_)) => return json_error(StatusCode::BAD_REQUEST, "Choose an ordinary room; conversations, Welcome, and category folders use separate access rules"),
        Ok(None) => return json_error(StatusCode::NOT_FOUND, "Channel not found"),
        Err(error) => { tracing::error!(%error, "channel gate lookup failed"); return json_error(StatusCode::SERVICE_UNAVAILABLE, "Channel access could not be checked"); }
    };
    let _membership = state.membership_gate.write().await;
    let _message_commit = state.retention_policy_lock.lock().await;
    {
        let mut guard = store.write().await;
        if matches!(role, Some("moderator" | "admin")) && guard.data.channel_community_roles.contains_key(&channel_id) {
            return json_error(StatusCode::BAD_REQUEST, "Remove the self-selected community role before making this a staff-only room");
        }
        let before = guard.data.clone();
        if let Some(role) = role { guard.data.channel_min_roles.insert(channel_id.clone(), role.into()); }
        else { guard.data.channel_min_roles.remove(&channel_id); }
        if let Err(error) = guard.persist() {
            guard.data = before;
            tracing::error!(%error, "channel access policy could not be saved");
            return json_error(StatusCode::SERVICE_UNAVAILABLE, "Channel access policy could not be saved; reopen the channel");
        }
    }
    if let Some(io) = state.socket_io() {
        crate::socketio::evict_channel_disallowed(&io, &state, &channel.channel_id).await;
        if channel.channel_kind == wabidb::domain::ChannelKind::Voice {
            evict_inherited_voice_policy(&io, &state, None).await;
        }
    }
    drop(_message_commit);
    drop(_membership);
    if let Some(io) = state.socket_io() {
        let _ = io.broadcast().emit("channel-access-policy-updated", &json!({ "channelId": channel_id })).await;
    }
    Json(json!({ "channelId": channel_id, "minRole": role })).into_response()
}

async fn list_community_roles(
    State(state): State<Arc<AppState>>, headers: HeaderMap,
    Extension(store): Extension<Arc<RwLock<ServerCenterStore>>>,
) -> Response {
    if let Err(resp) = crate::api::admin::admin_auth(&headers, &state).await { return resp; }
    let guard = store.read().await;
    Json(json!({ "roles": guard.data.community_roles, "channelRoles": guard.data.channel_community_roles,
        "revision": guard.data.community_roles_revision })).into_response()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PutCommunityRolesInput {
    expected_revision: u64,
    roles: Vec<CommunityRole>,
    channel_roles: HashMap<String, String>,
}

async fn put_community_roles(
    State(state): State<Arc<AppState>>, headers: HeaderMap,
    Extension(store): Extension<Arc<RwLock<ServerCenterStore>>>, Json(input): Json<PutCommunityRolesInput>,
) -> Response {
    if let Err(resp) = crate::api::admin::admin_auth(&headers, &state).await { return resp; }
    if input.channel_roles.len() > 128 { return json_error(StatusCode::BAD_REQUEST, "Too many role-gated rooms"); }
    let _membership = state.membership_gate.write().await;
    let _message_commit = state.retention_policy_lock.lock().await;
    let mut guard = store.write().await;
    if guard.data.community_roles_revision != input.expected_revision {
        return json_error(StatusCode::CONFLICT, "Community roles changed; reload before saving");
    }
    let mut candidate = guard.data.clone();
    candidate.community_roles = input.roles;
    candidate.channel_community_roles = input.channel_roles;
    candidate.community_roles_revision = candidate.community_roles_revision.saturating_add(1);
    let valid_ids: std::collections::HashSet<_> = candidate.community_roles.iter().map(|role| role.id.as_str()).collect();
    for roles in candidate.member_community_roles.values_mut() { roles.retain(|role| valid_ids.contains(role.as_str())); }
    if let Err(error) = validate_server_center_data(&candidate) {
        return json_error(StatusCode::BAD_REQUEST, &error.to_string());
    }
    for channel_id in candidate.channel_community_roles.keys() {
        match state.wdb.get_channel(channel_id).await {
            Ok(Some(channel)) if !crate::channel_access::is_conversation(channel.channel_kind)
                && !matches!(channel.channel_kind, wabidb::domain::ChannelKind::Category | wabidb::domain::ChannelKind::Reception) => {}
            Ok(_) => return json_error(StatusCode::BAD_REQUEST, "A selected room is unavailable for community roles"),
            Err(error) => { tracing::error!(%error, "community role room lookup failed"); return json_error(StatusCode::SERVICE_UNAVAILABLE, "Room access could not be checked"); }
        }
        if matches!(candidate.channel_min_roles.get(channel_id).map(String::as_str), Some("moderator" | "admin")) {
            return json_error(StatusCode::BAD_REQUEST, "Staff-only rooms cannot use self-selected community roles");
        }
    }
    let affected: std::collections::HashSet<String> = guard.data.channel_community_roles.keys()
        .chain(candidate.channel_community_roles.keys()).cloned().collect();
    let before = std::mem::replace(&mut guard.data, candidate);
    if let Err(error) = guard.persist() {
        guard.data = before;
        tracing::error!(%error, "community roles could not be saved");
        return json_error(StatusCode::SERVICE_UNAVAILABLE, "Community roles could not be saved");
    }
    let revision = guard.data.community_roles_revision;
    drop(guard);
    if let Some(io) = state.socket_io() {
        for channel_id in &affected { crate::socketio::evict_channel_disallowed(&io, &state, channel_id).await; }
        evict_inherited_voice_policy(&io, &state, None).await;
    }
    drop(_message_commit);
    drop(_membership);
    if let Some(io) = state.socket_io() { let _ = io.broadcast().emit("channel-access-policy-updated", &json!({ "communityRolesRevision": revision })).await; }
    Json(json!({ "revision": revision })).into_response()
}

async fn get_reception(
    State(state): State<Arc<AppState>>, auth: AuthUser,
    Extension(store): Extension<Arc<RwLock<ServerCenterStore>>>,
) -> Response {
    let guard = store.read().await;
    let roles = guard.data.community_roles.clone();
    let owned = guard.data.member_community_roles.get(&auth.user_id).cloned().unwrap_or_default();
    let welcome_pending = guard.data.welcome_pending.contains(&auth.user_id);
    let room_roles = guard.data.channel_community_roles.clone();
    let staff_gates = guard.data.channel_min_roles.clone();
    drop(guard);
    let blacklist = match state.get_blacklist().await {
        Some(value) => value, None => return json_error(StatusCode::SERVICE_UNAVAILABLE, "Room access unavailable"),
    };
    let mut rooms = Vec::new();
    for (channel_id, role_id) in room_roles {
        if matches!(staff_gates.get(&channel_id).map(String::as_str), Some("moderator" | "admin"))
            || blacklist.is_channel_banned(&channel_id, auth.user_id).await.is_some() { continue; }
        if let Ok(Some(channel)) = state.wdb.get_channel(&channel_id).await {
            rooms.push(json!({ "id": channel_id, "name": channel.name, "description": channel.description,
                "roleId": role_id, "position": channel.position }));
        }
    }
    rooms.sort_by_key(|room| room.get("position").and_then(|value| value.as_i64()).unwrap_or(0));
    Json(json!({ "roles": roles, "myRoleIds": owned, "rooms": rooms, "welcomePending": welcome_pending,
        "canChooseRoles": !auth.is_guest && !auth.is_bot })).into_response()
}

pub async fn mark_welcome_pending(state: &AppState, user_id: i64) -> anyhow::Result<()> {
    let mut guard = state.server_center.write().await;
    let before = guard.data.clone();
    guard.data.welcome_pending.insert(user_id);
    if let Err(error) = guard.persist() { guard.data = before; return Err(error); }
    Ok(())
}

async fn complete_reception(
    auth: AuthUser,
    Extension(store): Extension<Arc<RwLock<ServerCenterStore>>>,
) -> Response {
    if auth.is_guest || auth.user_id <= 0 {
        return json_error(StatusCode::FORBIDDEN, "A member account is required");
    }
    let mut guard = store.write().await;
    if !guard.data.welcome_pending.remove(&auth.user_id) {
        return Json(json!({ "ok": true })).into_response();
    }
    if let Err(error) = guard.persist() {
        guard.data.welcome_pending.insert(auth.user_id);
        tracing::error!(%error, "welcome completion could not be saved");
        return json_error(StatusCode::SERVICE_UNAVAILABLE, "Welcome progress could not be saved");
    }
    Json(json!({ "ok": true })).into_response()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PutMyRolesInput {
    role_ids: Vec<String>,
    expected_role_ids: Vec<String>,
}

async fn put_my_community_roles(
    State(state): State<Arc<AppState>>, auth: AuthUser,
    Extension(store): Extension<Arc<RwLock<ServerCenterStore>>>, Json(input): Json<PutMyRolesInput>,
) -> Response {
    if auth.is_guest || auth.is_bot || auth.user_id <= 0 {
        return json_error(StatusCode::FORBIDDEN, "Sign in with a member account to choose community roles");
    }
    if input.role_ids.len() > 16 { return json_error(StatusCode::BAD_REQUEST, "Choose at most 16 community roles"); }
    match state.wdb.get_user(auth.user_id as u64).await {
        Ok(Some(user)) if user.is_active && !user.password_hash.is_empty() => {}
        _ => return json_error(StatusCode::FORBIDDEN, "Active member account required"),
    }
    let _membership = state.membership_gate.write().await;
    let _message_commit = state.retention_policy_lock.lock().await;
    let mut guard = store.write().await;
    let current: std::collections::HashSet<_> = guard.data.member_community_roles
        .get(&auth.user_id).into_iter().flatten().collect();
    let expected: std::collections::HashSet<_> = input.expected_role_ids.iter().collect();
    if current != expected || expected.len() != input.expected_role_ids.len() {
        return json_error(StatusCode::CONFLICT, "Your role choices changed; reload and try again");
    }
    let valid: std::collections::HashSet<_> = guard.data.community_roles.iter().map(|role| role.id.as_str()).collect();
    let unique: std::collections::HashSet<_> = input.role_ids.iter().map(String::as_str).collect();
    if unique.len() != input.role_ids.len() || !unique.iter().all(|role| valid.contains(role)) {
        return json_error(StatusCode::BAD_REQUEST, "Choose only current community roles");
    }
    let before = guard.data.clone();
    if input.role_ids.is_empty() { guard.data.member_community_roles.remove(&auth.user_id); }
    else { guard.data.member_community_roles.insert(auth.user_id, input.role_ids.clone()); }
    if let Err(error) = guard.persist() {
        guard.data = before;
        tracing::error!(%error, "member community roles could not be saved");
        return json_error(StatusCode::SERVICE_UNAVAILABLE, "Community role choices could not be saved");
    }
    let affected: Vec<String> = guard.data.channel_community_roles.keys().cloned().collect();
    drop(guard);
    if let Some(io) = state.socket_io() {
        for channel_id in &affected {
            if !matches!(crate::channel_access::channel_role_allows(&state, auth.user_id, channel_id).await, Ok(true)) {
                crate::socketio::evict_channel_user(&io, &state, channel_id, auth.user_id).await;
            }
        }
        evict_inherited_voice_policy(&io, &state, Some(auth.user_id)).await;
    }
    drop(_message_commit);
    drop(_membership);
    if let Some(io) = state.socket_io() { let _ = io.broadcast().emit("channel-access-policy-updated", &json!({ "roleChangedUserId": auth.user_id })).await; }
    Json(json!({ "myRoleIds": input.role_ids })).into_response()
}

#[derive(Debug, Deserialize)]
struct PutRaidModeInput { minutes: u32 }

async fn put_raid_mode(
    State(state): State<Arc<AppState>>, headers: HeaderMap,
    Extension(store): Extension<Arc<RwLock<ServerCenterStore>>>, Json(input): Json<PutRaidModeInput>,
) -> Response {
    if let Err(resp) = crate::api::admin::admin_auth(&headers, &state).await { return resp; }
    if input.minutes > 1440 { return json_error(StatusCode::BAD_REQUEST, "Raid posture can last at most 24 hours"); }
    let until = if input.minutes == 0 { None } else {
        Some((chrono::Utc::now() + chrono::Duration::minutes(input.minutes as i64)).to_rfc3339())
    };
    let mut guard = store.write().await;
    let before = guard.data.clone();
    guard.data.raid_mode.until = until.clone();
    if let Err(error) = guard.persist() {
        guard.data = before;
        tracing::error!(%error, "failed to persist raid posture");
        return json_error(StatusCode::SERVICE_UNAVAILABLE, "Raid posture could not be saved");
    }
    Json(json!({ "active": until.is_some(), "until": until })).into_response()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateReportInput {
    channel_id: String,
    message_id: String,
    reason: String,
    comment: Option<String>,
    /// Plaintext intentionally disclosed by a participant reporting an E2EE
    /// message. Ignored for server-readable messages so clients cannot replace
    /// authoritative evidence with fabricated text.
    disclosed_snapshot: Option<String>,
}

struct ReportEvidence {
    snapshot: String,
    deleted: bool,
    author_user_id: u64,
    author_username: String,
}

async fn report_evidence(state: &Arc<AppState>, channel_id: &str, message_id: &str) -> Result<ReportEvidence, Response> {
    match state.wdb.get_message_typed(message_id).await {
        Ok(Some(message)) if message.channel_id == channel_id => {
            let author_username = state.wdb.get_user(message.author_user_id).await.ok().flatten()
                .map(|u| u.username).unwrap_or_else(|| format!("User {}", message.author_user_id));
            return Ok(ReportEvidence {
                snapshot: message.content,
                deleted: message.is_deleted,
                author_user_id: message.author_user_id,
                author_username,
            });
        }
        Ok(Some(_)) => return Err(json_error(StatusCode::BAD_REQUEST, "Message does not belong to that channel")),
        Ok(None) => {}
        Err(error) => {
            tracing::debug!(%error, message_id, "durable report lookup unavailable; checking live session evidence");
        }
    }

    let live = {
        let sessions = state.session_messages.read().await;
        sessions.get(channel_id).and_then(|messages| {
            messages.iter().find(|message| message.get("id").and_then(|v| v.as_str()) == Some(message_id)).cloned()
        })
    };
    let Some(message) = live else { return Err(json_error(StatusCode::NOT_FOUND, "Message is no longer available to report")); };
    let snapshot = message.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let author_username = message.get("user").and_then(|v| v.as_str()).unwrap_or("Unknown user").to_string();
    let author_user_id = message.get("userId").and_then(|v| v.as_str())
        .and_then(|id| id.strip_prefix("user-").unwrap_or(id).parse::<u64>().ok())
        .unwrap_or(0);
    Ok(ReportEvidence { snapshot, deleted: false, author_user_id, author_username })
}

async fn create_report(
    State(state): State<Arc<AppState>>, auth: AuthUser,
    Extension(store): Extension<Arc<RwLock<ServerCenterStore>>>, Json(input): Json<CreateReportInput>,
) -> Response {
    if let Err(error) = crate::channel_access::require_access(&state, auth.user_id, &input.channel_id).await {
        return error.into_response();
    }
    let mut evidence = match report_evidence(&state, &input.channel_id, &input.message_id).await {
        Ok(evidence) => evidence,
        Err(response) => return response,
    };
    let reason: String = input.reason.trim().chars().take(80).collect();
    if reason.is_empty() { return json_error(StatusCode::BAD_REQUEST, "Choose a report reason"); }
    let comment = input.comment.map(|s| s.trim().chars().take(1000).collect::<String>()).filter(|s| !s.is_empty());

    let source = if crate::api::e2ee::is_ciphertext(&evidence.snapshot) {
        // The server can prove which ciphertext/message/user was reported, but
        // by design cannot prove that the participant-disclosed plaintext is a
        // decryption of that ciphertext. Preserve and label it as disclosure,
        // never as server-verified plaintext.
        let disclosed = input.disclosed_snapshot
            .map(|s| s.trim().chars().take(12_000).collect::<String>())
            .filter(|s| !s.is_empty());
        let Some(disclosed) = disclosed else {
            return json_error(StatusCode::BAD_REQUEST, "Reporting an E2EE message requires explicit plaintext disclosure from your client");
        };
        evidence.snapshot = disclosed;
        "user_report_e2ee_disclosure"
    } else {
        "user_report"
    };

    let report = ModerationReport {
        id: uuid::Uuid::new_v4().to_string(), source: source.into(),
        channel_id: input.channel_id, message_id: input.message_id,
        message_snapshot: evidence.snapshot, evidence_deleted_at: None,
        evidence_expires_at: store.read().await.data.privacy.report_evidence_days
            .map(|days| (chrono::Utc::now() + chrono::Duration::days(i64::from(days))).to_rfc3339()),
        message_was_deleted: evidence.deleted,
        author_user_id: evidence.author_user_id, author_username: evidence.author_username,
        reporter_user_id: auth.user_id, reporter_username: auth.username,
        reason, comment, created_at: chrono::Utc::now().to_rfc3339(), status: ReportStatus::Open,
        assigned_to_user_id: None, assigned_to_username: None, resolution: None, staff_comments: Vec::new(),
        actions: Vec::new(),
    };
    let mut guard = store.write().await;
    let before = guard.data.clone();
    guard.data.reports.push(report.clone());
    if let Err(error) = guard.persist() {
        guard.data = before;
        tracing::error!(%error, "failed to persist moderation report");
        return json_error(StatusCode::SERVICE_UNAVAILABLE, "Report could not be saved");
    }
    Json(json!({ "report": report })).into_response()
}

/// A safety flag is a case reference, not a second content-retention path.
/// Staff can inspect a durable room's normal history while it exists; a Live
/// message disappears on its ordinary schedule unless a participant reports it.
pub async fn record_safety_flag(
    state: &AppState, channel_id: &str, message_id: &str,
    author_user_id: i64, author_username: &str, rule: &SafetyRule,
) -> anyhow::Result<()> {
    let mut guard = state.server_center.write().await;
    let before = guard.data.clone();
    let report = ModerationReport {
        id: uuid::Uuid::new_v4().to_string(), source: "safety_flag".into(),
        channel_id: channel_id.into(), message_id: message_id.into(),
        message_snapshot: String::new(), evidence_deleted_at: None, evidence_expires_at: None,
        message_was_deleted: false,
        author_user_id: u64::try_from(author_user_id)?, author_username: author_username.into(),
        reporter_user_id: 0, reporter_username: "Safety rule".into(),
        reason: rule.reason.clone().unwrap_or_else(|| format!("Safety rule: {}", rule.name)),
        comment: Some(format!("Matched safety rule '{}' after the message was accepted. No message snapshot was retained by this flag.", rule.name)),
        created_at: chrono::Utc::now().to_rfc3339(), status: ReportStatus::Open,
        assigned_to_user_id: None, assigned_to_username: None, resolution: None,
        staff_comments: Vec::new(), actions: Vec::new(),
    };
    guard.data.reports.push(report);
    if let Err(error) = guard.persist() {
        guard.data = before;
        return Err(error);
    }
    Ok(())
}

async fn list_reports(
    State(state): State<Arc<AppState>>, headers: HeaderMap,
    Extension(store): Extension<Arc<RwLock<ServerCenterStore>>>,
) -> Response {
    if let Err(resp) = staff_auth(&headers, &state).await { return resp; }
    let mut guard = store.write().await;
    if let Err(error) = guard.expire_evidence() {
        tracing::error!(%error, "expired report evidence could not be removed");
        return json_error(StatusCode::SERVICE_UNAVAILABLE, "Report evidence expiry could not be saved");
    }
    let mut reports = guard.data.reports.clone();
    reports.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Json(json!({ "reports": reports })).into_response()
}

async fn list_my_reports(auth: AuthUser, Extension(store): Extension<Arc<RwLock<ServerCenterStore>>>) -> Response {
    let mut reports: Vec<_> = store.read().await.data.reports.iter()
        .filter(|report| report.reporter_user_id == auth.user_id).cloned().collect();
    reports.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    let public: Vec<_> = reports.into_iter().map(|report| json!({
        "id": report.id, "channelId": report.channel_id, "messageId": report.message_id,
        "authorUsername": report.author_username, "reason": report.reason, "comment": report.comment,
        "createdAt": report.created_at, "status": report.status,
    })).collect();
    Json(json!({ "reports": public })).into_response()
}

#[derive(Debug, Deserialize)]
struct StaffCommentInput { body: String }

async fn add_staff_comment(
    State(state): State<Arc<AppState>>, headers: HeaderMap,
    Extension(store): Extension<Arc<RwLock<ServerCenterStore>>>, Path(report_id): Path<String>,
    Json(input): Json<StaffCommentInput>,
) -> Response {
    let (user_id, username) = match staff_auth(&headers, &state).await { Ok(v) => v, Err(resp) => return resp };
    let body: String = input.body.trim().chars().take(2000).collect();
    if body.is_empty() { return json_error(StatusCode::BAD_REQUEST, "Comment cannot be empty"); }
    let mut guard = store.write().await;
    let before = guard.data.clone();
    let Some(report) = guard.data.reports.iter_mut().find(|report| report.id == report_id) else {
        return json_error(StatusCode::NOT_FOUND, "Report not found");
    };
    let comment = StaffComment { id: uuid::Uuid::new_v4().to_string(), author_user_id: user_id, author_username: username, body, created_at: chrono::Utc::now().to_rfc3339() };
    report.staff_comments.push(comment.clone());
    if matches!(report.status, ReportStatus::Open) { report.status = ReportStatus::Reviewing; }
    if let Err(error) = guard.persist() {
        guard.data = before;
        tracing::error!(%error, "failed to persist moderation comment");
        return json_error(StatusCode::SERVICE_UNAVAILABLE, "Comment could not be saved");
    }
    Json(json!({ "comment": comment })).into_response()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateReportStatusInput { status: ReportStatus, resolution: Option<String>, assign_to_me: Option<bool> }

async fn update_report_status(
    State(state): State<Arc<AppState>>, headers: HeaderMap,
    Extension(store): Extension<Arc<RwLock<ServerCenterStore>>>, Path(report_id): Path<String>,
    Json(input): Json<UpdateReportStatusInput>,
) -> Response {
    let (user_id, username) = match staff_auth(&headers, &state).await { Ok(v) => v, Err(resp) => return resp };
    let mut guard = store.write().await;
    let before = guard.data.clone();
    let Some(report) = guard.data.reports.iter_mut().find(|report| report.id == report_id) else {
        return json_error(StatusCode::NOT_FOUND, "Report not found");
    };
    report.status = input.status;
    report.resolution = input.resolution.map(|s| s.trim().chars().take(1000).collect::<String>()).filter(|s| !s.is_empty());
    if input.assign_to_me.unwrap_or(false) {
        report.assigned_to_user_id = Some(user_id); report.assigned_to_username = Some(username);
    }
    let updated = report.clone();
    if let Err(error) = guard.persist() {
        guard.data = before;
        tracing::error!(%error, "failed to persist moderation status");
        return json_error(StatusCode::SERVICE_UNAVAILABLE, "Report status could not be saved");
    }
    Json(json!({ "report": updated })).into_response()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaseActionInput { kind: CaseActionKind, reason: Option<String>, minutes: Option<u32> }

async fn apply_report_action(
    State(state): State<Arc<AppState>>, headers: HeaderMap,
    Extension(store): Extension<Arc<RwLock<ServerCenterStore>>>, Path(report_id): Path<String>,
    Json(input): Json<CaseActionInput>,
) -> Response {
    let (actor_user_id, actor_username) = match staff_auth(&headers, &state).await { Ok(v) => v, Err(resp) => return resp };
    let report = match store.read().await.data.reports.iter().find(|report| report.id == report_id).cloned() {
        Some(report) => report,
        None => return json_error(StatusCode::NOT_FOUND, "Report not found"),
    };
    let target_user_id = match i64::try_from(report.author_user_id) {
        Ok(id) => id,
        Err(_) => return json_error(StatusCode::BAD_REQUEST, "This report has no eligible target account"),
    };
    if target_user_id <= 0 || target_user_id == actor_user_id {
        return json_error(StatusCode::BAD_REQUEST, "This report has no eligible target account");
    }
    if state.is_owner(target_user_id).await {
        return json_error(StatusCode::FORBIDDEN, "The server owner cannot be restricted");
    }
    if !state.is_owner(actor_user_id).await && state.is_admin(target_user_id).await {
        return json_error(StatusCode::FORBIDDEN, "Only the owner can restrict another administrator");
    }
    let server_action = matches!(input.kind, CaseActionKind::ServerBan | CaseActionKind::LiftServerBan);
    if server_action && !state.is_admin(actor_user_id).await {
        return json_error(StatusCode::FORBIDDEN, "Only administrators can ban an account from the server");
    }
    if !server_action && matches!(state.wdb.get_channel_kind(&report.channel_id).await.as_deref(), Some("dm" | "group")) {
        return json_error(StatusCode::BAD_REQUEST, "Channel restrictions are for community channels");
    }
    let minutes = input.minutes.unwrap_or(10);
    if matches!(input.kind, CaseActionKind::ChannelTimeout) && !(1..=10_080).contains(&minutes) {
        return json_error(StatusCode::BAD_REQUEST, "Choose a timeout from 1 minute to 7 days");
    }
    let reason: String = input.reason.as_deref().unwrap_or(&report.reason).trim().chars().take(280).collect();
    if reason.is_empty() { return json_error(StatusCode::BAD_REQUEST, "Give a reason for this action"); }
    let expires = if matches!(input.kind, CaseActionKind::ChannelTimeout) {
        Some(chrono::Utc::now() + chrono::Duration::minutes(minutes as i64))
    } else { None };
    let mut action = CaseAction {
        id: uuid::Uuid::new_v4().to_string(), kind: input.kind.clone(),
        actor_user_id, actor_username, target_user_id, reason: reason.clone(),
        created_at: chrono::Utc::now().to_rfc3339(), expires_at: expires.as_ref().map(|at| at.to_rfc3339()),
        outcome: "pending".into(),
    };

    // The pending journal is durable before applying the restriction. If a
    // crash lands between the two files, staff see an unresolved action.
    {
        let mut guard = store.write().await;
        let before = guard.data.clone();
        let Some(current) = guard.data.reports.iter_mut().find(|item| item.id == report_id) else {
            return json_error(StatusCode::NOT_FOUND, "Report not found");
        };
        current.actions.push(action.clone());
        current.status = ReportStatus::Reviewing;
        if let Err(error) = guard.persist() {
            guard.data = before;
            tracing::error!(%error, "failed to journal moderation action");
            return json_error(StatusCode::SERVICE_UNAVAILABLE, "Action could not be recorded");
        }
    }

    let mut result = match state.get_blacklist().await {
        None => Err(anyhow::anyhow!("restriction store unavailable")),
        Some(blacklist) => match input.kind {
            CaseActionKind::ServerBan => blacklist.add_user(target_user_id, &reason, None).await,
            CaseActionKind::ChannelBan => blacklist.restrict_channel(&report.channel_id, target_user_id, &reason, None).await,
            CaseActionKind::ChannelTimeout => blacklist.restrict_channel(&report.channel_id, target_user_id, &reason, expires.as_ref().map(|at| at.timestamp() as u64)).await,
            CaseActionKind::LiftServerBan => blacklist.remove_user(target_user_id).await,
            CaseActionKind::LiftChannelBan => blacklist.remove_channel_restriction(&report.channel_id, target_user_id, false).await,
            CaseActionKind::LiftChannelTimeout => blacklist.remove_channel_restriction(&report.channel_id, target_user_id, true).await,
        },
    };
    if result.is_ok() && matches!(action.kind, CaseActionKind::ServerBan) {
        if let Err(error) = state.revoke_user(target_user_id).await {
            result = Err(error.into());
        }
        if let Some(io) = state.socket_io() {
            crate::socketio::evict_server_user(&io, target_user_id);
            let _ = io.broadcast().emit("user-banned", &json!({ "targetUserId": target_user_id, "bannedByUserId": actor_user_id, "reason": reason })).await;
        }
    }
    if result.is_ok() && matches!(action.kind, CaseActionKind::LiftServerBan) {
        if let Some(io) = state.socket_io() {
            let _ = io.broadcast().emit("user-unbanned", &json!({ "targetUserId": target_user_id, "unbannedByUserId": actor_user_id })).await;
        }
    }
    if result.is_ok() && matches!(action.kind, CaseActionKind::ChannelBan) {
        if let Some(io) = state.socket_io() { crate::socketio::evict_channel_user(&io, &state, &report.channel_id, target_user_id).await; }
    }
    action.outcome = if result.is_ok() { "applied".into() } else { "failed".into() };
    {
        let mut guard = store.write().await;
        let before = guard.data.clone();
        if let Some(current) = guard.data.reports.iter_mut().find(|item| item.id == report_id) {
            if let Some(saved) = current.actions.iter_mut().find(|item| item.id == action.id) {
                saved.outcome = action.outcome.clone();
            }
        }
        if let Err(error) = guard.persist() {
            guard.data = before;
            tracing::error!(%error, "moderation action outcome could not be saved");
            return json_error(StatusCode::SERVICE_UNAVAILABLE, "Action may have applied; inspect the restriction and pending case entry");
        }
    }
    if let Err(error) = result {
        tracing::error!(%error, "moderation action failed");
        return json_error(StatusCode::SERVICE_UNAVAILABLE, "Restriction could not be saved; the failed action is recorded in the case");
    }
    Json(json!({ "action": action })).into_response()
}

async fn delete_report_evidence(
    State(state): State<Arc<AppState>>, headers: HeaderMap,
    Extension(store): Extension<Arc<RwLock<ServerCenterStore>>>, Path(report_id): Path<String>,
) -> Response {
    let caller = match crate::api::admin::admin_auth(&headers, &state).await { Ok(id) => id, Err(resp) => return resp };
    if !state.is_owner(caller).await {
        return json_error(StatusCode::FORBIDDEN, "Only the server owner can remove preserved report snapshots");
    }
    let mut guard = store.write().await;
    let before = guard.data.clone();
    let Some(report) = guard.data.reports.iter_mut().find(|report| report.id == report_id) else {
        return json_error(StatusCode::NOT_FOUND, "Report not found");
    };
    report.message_snapshot.clear();
    report.evidence_deleted_at = Some(chrono::Utc::now().to_rfc3339());
    if let Err(error) = guard.persist() {
        guard.data = before;
        tracing::error!(%error, "failed to remove report snapshot");
        return json_error(StatusCode::SERVICE_UNAVAILABLE, "Report snapshot could not be removed");
    }
    Json(json!({ "success": true })).into_response()
}

async fn list_storage(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Err(resp) = crate::api::admin::admin_auth(&headers, &state).await { return resp; }
    let uploads = state.upload_registry.list().await;
    let mut total_bytes = 0u64;
    let mut by_kind: HashMap<String, (u64, u64)> = HashMap::new();
    let mut files = Vec::with_capacity(uploads.len());
    for upload in uploads {
        total_bytes = total_bytes.saturating_add(upload.size);
        let kind = upload.kind.as_str().to_string();
        let entry = by_kind.entry(kind.clone()).or_insert((0, 0)); entry.0 += 1; entry.1 = entry.1.saturating_add(upload.size);
        let revoked = state.upload_registry.is_revoked(&upload.filename).await;
        let on_disk = FsPath::new(&state.config.uploads_dir).join(&upload.filename).is_file();
        files.push(json!({
            "filename": upload.filename, "originalName": upload.original_name, "channelId": upload.channel_id,
            "uploaderId": upload.uploader_id, "kind": kind, "size": upload.size, "createdAt": upload.created_at,
            "revoked": revoked, "onDisk": on_disk,
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
    let caller = match crate::api::admin::admin_auth(&headers, &state).await {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    if !state.is_owner(caller).await {
        return json_error(
            StatusCode::FORBIDDEN,
            "Only the server owner can permanently delete upload bytes",
        );
    }
    if filename.is_empty()
        || FsPath::new(&filename)
            .file_name()
            .and_then(|name| name.to_str())
            != Some(filename.as_str())
    {
        return json_error(StatusCode::BAD_REQUEST, "Invalid upload filename");
    }
    let target = PathBuf::from(&state.config.uploads_dir).join(&filename);
    if state.upload_registry.get(&filename).await.is_none() {
        return json_error(
            StatusCode::NOT_FOUND,
            "Upload is not present in the registry",
        );
    }
    if let Err(error) = state
        .upload_registry
        .revoke_canonical(
            &filename,
            state.wdb.engine(),
            u64::try_from(caller).unwrap_or(0),
        )
        .await
    {
        tracing::error!(%error, file=%filename, "failed to persist upload revocation");
        return json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Upload revocation could not be saved",
        );
    }
    let removed = match tokio::fs::remove_file(&target).await {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => {
            tracing::error!(%error, file=%filename, "failed to remove upload bytes");
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Upload could not be deleted from disk",
            );
        }
    };
    let uploads_root = FsPath::new(&state.config.uploads_dir);
    if removed || tokio::fs::try_exists(uploads_root).await.unwrap_or(true) {
        if let Err(error) = crate::upload_registry::sync_upload_directory(uploads_root).await {
            tracing::error!(%error, file=%filename, "failed to sync upload deletion");
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Upload deletion could not be synced",
            );
        }
    }
    Json(json!({ "success": true, "filename": filename, "removedFromDisk": removed, "revoked": true })).into_response()
}

fn read_server_center_data(data_dir: &str) -> anyhow::Result<ServerCenterData> {
    let path = PathBuf::from(data_dir).join("server_center.json");
    match std::fs::read(path) {
        Ok(bytes) => {
            let data = serde_json::from_slice::<ServerCenterData>(&bytes)?;
            validate_server_center_data(&data)?;
            Ok(data)
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(ServerCenterData::default()),
        Err(error) => Err(error.into()),
    }
}

pub fn privacy_default_retention(data_dir: &str) -> anyhow::Result<String> {
    let label = match std::fs::read(PathBuf::from(data_dir).join("server_center.json")) {
        Ok(bytes) => serde_json::from_slice::<ServerCenterData>(&bytes)
            .map_err(|_| anyhow::anyhow!("Server privacy defaults are unreadable; preserve server_center.json and restore a matching backup"))?.privacy.default_retention,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => PrivacyPolicy::default().default_retention,
        Err(_) => anyhow::bail!("Server privacy defaults are unreadable; preserve server_center.json and restore a matching backup"),
    };
    super::retention_policy::canonical_label(&label)
}

pub fn evaluate_safety_rules(data_dir: &str, content: &str, private_conversation: bool) -> anyhow::Result<Option<SafetyRule>> {
    let data = read_server_center_data(data_dir)?;
    if !data.safety.enabled { return Ok(None); }
    if private_conversation && !data.privacy.private_content_automation { return Ok(None); }
    Ok(data.safety.rules.into_iter().find(|rule| {
        if !rule.enabled || rule.pattern.is_empty() { return false; }
        let (haystack, needle) = if rule.case_sensitive { (content.to_string(), rule.pattern.clone()) }
            else { (content.to_lowercase(), rule.pattern.to_lowercase()) };
        match rule.r#match {
            SafetyMatch::Contains => haystack.contains(&needle), SafetyMatch::Equals => haystack == needle,
            SafetyMatch::StartsWith => haystack.starts_with(&needle), SafetyMatch::EndsWith => haystack.ends_with(&needle),
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rule_data(private_content_automation: bool) -> ServerCenterData {
        ServerCenterData {
            safety: SafetyPolicy { enabled: true, default_flag_channel_id: None, rules: vec![SafetyRule {
                id: "badword".into(), enabled: true, name: "Bad word".into(), pattern: "BANME".into(),
                r#match: SafetyMatch::Equals, case_sensitive: false, action: SafetyAction::Ban,
                timeout_minutes: None, reason: Some("literal test".into()),
            }]},
            privacy: PrivacyPolicy { private_content_automation, ..PrivacyPolicy::default() }, ..ServerCenterData::default()
        }
    }
    #[test]
    fn deterministic_rule_matching_is_literal_and_predictable() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("server_center.json"), serde_json::to_vec(&rule_data(false)).unwrap()).unwrap();
        assert!(evaluate_safety_rules(dir.path().to_str().unwrap(), "banme", false).unwrap().is_some());
        assert!(evaluate_safety_rules(dir.path().to_str().unwrap(), "banme please", false).unwrap().is_none());
    }
    #[test]
    fn private_automation_is_opt_in() {
        let dir = tempfile::tempdir().unwrap(); let path = dir.path().join("server_center.json");
        std::fs::write(&path, serde_json::to_vec(&rule_data(false)).unwrap()).unwrap();
        assert!(evaluate_safety_rules(dir.path().to_str().unwrap(), "banme", true).unwrap().is_none());
        std::fs::write(&path, serde_json::to_vec(&rule_data(true)).unwrap()).unwrap();
        assert!(evaluate_safety_rules(dir.path().to_str().unwrap(), "banme", true).unwrap().is_some());
    }
}
