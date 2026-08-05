//! Admin API routes — policy management, compression observability,
//! runtime tuning, payment user blocks, and dashboard stats.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Extension, Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::RwLock;

use crate::api::payments::{
    extract_user_id, is_admin_user, json_error, PaymentUserBlock,
};
use crate::auth_extractor::{verify_stepup_token, AuthUser, STEPUP_HEADER};
use crate::state::AppState;
use wabidb::engine::wabi_store::WabiStore;

// ─── Policy Types ───────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PaymentAccessPolicy {
    pub enabled: bool,
    #[serde(rename = "allowGuest")]
    pub allow_guest: bool,
    #[serde(rename = "allowedRoleNames")]
    pub allowed_role_names: Vec<String>,
}

impl Default for PaymentAccessPolicy {
    fn default() -> Self {
        Self {
            enabled: false,
            allow_guest: false,
            allowed_role_names: vec![
                "owner".into(),
                "admin".into(),
                "mod".into(),
                "member".into(),
            ],
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RuntimeTuningConfig {
    #[serde(rename = "applyOnRestart")]
    pub apply_on_restart: bool,
    #[serde(rename = "threadPoolSize")]
    pub thread_pool_size: Option<i32>,
    #[serde(rename = "heavyProfilingEnabled")]
    pub heavy_profiling_enabled: bool,
    #[serde(rename = "heavyProfilingSampleRate")]
    pub heavy_profiling_sample_rate: f64,
}

impl Default for RuntimeTuningConfig {
    fn default() -> Self {
        Self {
            apply_on_restart: true,
            thread_pool_size: None,
            heavy_profiling_enabled: false,
            heavy_profiling_sample_rate: 0.1,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FrontendAppMetadataPolicy {
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
    #[serde(rename = "iconUrl")]
    pub icon_url: Option<String>,
    #[serde(rename = "bannerUrl")]
    pub banner_url: Option<String>,
    #[serde(rename = "accentColor")]
    pub accent_color: Option<String>,
    pub description: Option<String>,
    pub tagline: Option<String>,
    #[serde(rename = "launchPageFallbackEnabled")]
    pub launch_page_fallback_enabled: bool,
}

impl Default for FrontendAppMetadataPolicy {
    fn default() -> Self {
        Self {
            display_name: None,
            icon_url: None,
            banner_url: None,
            accent_color: None,
            description: None,
            tagline: None,
            launch_page_fallback_enabled: true,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UploadLimitConfig {
    #[serde(rename = "perRoleBytes")]
    pub per_role_bytes: HashMap<String, Option<i64>>,
    #[serde(rename = "globalUploadCapBytes")]
    pub global_upload_cap_bytes: Option<i64>,
}

impl Default for UploadLimitConfig {
    fn default() -> Self {
        let mut per_role = HashMap::new();
        per_role.insert("new".into(), Some(10_485_760));
        per_role.insert("trusted".into(), Some(104_857_600));
        per_role.insert("moderator".into(), Some(536_870_912));
        per_role.insert("admin".into(), Some(1_073_741_824));
        per_role.insert("owner".into(), None);
        Self {
            per_role_bytes: per_role,
            global_upload_cap_bytes: Some(10_737_418_240i64),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DownloadLimitConfig {
    #[serde(rename = "perRoleBytes")]
    pub per_role_bytes: HashMap<String, Option<i64>>,
    #[serde(rename = "globalDownloadCapBytes")]
    pub global_download_cap_bytes: Option<i64>,
}

impl Default for DownloadLimitConfig {
    fn default() -> Self {
        let mut per_role = HashMap::new();
        per_role.insert("new".into(), Some(52_428_800));
        per_role.insert("trusted".into(), Some(524_288_000));
        per_role.insert("moderator".into(), Some(1_073_741_824));
        per_role.insert("admin".into(), Some(5_368_709_120i64));
        per_role.insert("owner".into(), None);
        Self {
            per_role_bytes: per_role,
            global_download_cap_bytes: Some(53_687_091_200i64),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CommunityNodeAccessPolicy {
    pub mode: String,
    #[serde(rename = "allowedUsers")]
    pub allowed_users: Vec<CommunityNodeAllowedUser>,
}

impl Default for CommunityNodeAccessPolicy {
    fn default() -> Self {
        Self {
            mode: "open".into(),
            allowed_users: Vec::new(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CommunityNodeAllowedUser {
    #[serde(rename = "userId")]
    pub user_id: i64,
    pub username: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CommunityNodeAnnouncementsPolicy {
    pub enabled: bool,
    #[serde(rename = "channelId")]
    pub channel_id: Option<String>,
    #[serde(rename = "onlineTemplate")]
    pub online_template: String,
    #[serde(rename = "offlineTemplate")]
    pub offline_template: String,
}

impl Default for CommunityNodeAnnouncementsPolicy {
    fn default() -> Self {
        Self {
            enabled: false,
            channel_id: None,
            online_template: "{node_id} is now online.".into(),
            offline_template: "{node_id} went offline.".into(),
        }
    }
}

// ─── Compression Types ──────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HttpTextCompressionConfig {
    pub enabled: bool,
    #[serde(rename = "minBytes")]
    pub min_bytes: u64,
    #[serde(rename = "brotliQuality")]
    pub brotli_quality: u32,
    #[serde(rename = "gzipLevel")]
    pub gzip_level: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UploadCompressionConfig {
    pub enabled: bool,
    #[serde(rename = "minBytes")]
    pub min_bytes: u64,
    #[serde(rename = "gzipLevel")]
    pub gzip_level: u32,
    #[serde(rename = "rolloutPercent")]
    pub rollout_percent: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AdminCompressionConfig {
    #[serde(rename = "httpTextCompression")]
    pub http_text_compression: HttpTextCompressionConfig,
    #[serde(rename = "uploadCompression")]
    pub upload_compression: UploadCompressionConfig,
}

impl Default for AdminCompressionConfig {
    fn default() -> Self {
        Self {
            http_text_compression: HttpTextCompressionConfig {
                enabled: true,
                min_bytes: 1024,
                brotli_quality: 4,
                gzip_level: 6,
            },
            upload_compression: UploadCompressionConfig {
                enabled: false,
                min_bytes: 10_485_760,
                gzip_level: 6,
                rollout_percent: 0,
            },
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CompressionCounters {
    #[serde(rename = "uploadCount")]
    pub upload_count: u64,
    #[serde(rename = "downloadCount")]
    pub download_count: u64,
    #[serde(rename = "uploadOriginalBytes")]
    pub upload_original_bytes: u64,
    #[serde(rename = "uploadStoredBytes")]
    pub upload_stored_bytes: u64,
    #[serde(rename = "downloadStoredBytes")]
    pub download_stored_bytes: u64,
    #[serde(rename = "downloadResponseBytes")]
    pub download_response_bytes: u64,
    #[serde(rename = "uploadStoredToOriginalRatio")]
    pub upload_stored_to_original_ratio: Option<f64>,
    #[serde(rename = "downloadResponseToStoredRatio")]
    pub download_response_to_stored_ratio: Option<f64>,
}

impl Default for CompressionCounters {
    fn default() -> Self {
        Self {
            upload_count: 0,
            download_count: 0,
            upload_original_bytes: 0,
            upload_stored_bytes: 0,
            download_stored_bytes: 0,
            download_response_bytes: 0,
            upload_stored_to_original_ratio: None,
            download_response_to_stored_ratio: None,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct CompressionSummary {
    pub uploads: Vec<CompressionExtSummary>,
    pub downloads: Vec<CompressionExtSummary>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CompressionExtSummary {
    #[serde(rename = "fileExt")]
    pub file_ext: String,
    pub count: u64,
    #[serde(rename = "originalBytes")]
    pub original_bytes: u64,
    #[serde(rename = "storedBytes")]
    pub stored_bytes: u64,
    #[serde(rename = "responseBytes")]
    pub response_bytes: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct CompressionRecentSamples {
    pub uploads: Vec<Value>,
    pub downloads: Vec<Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ClientVideoCompression {
    pub counters: ClientVideoCounters,
    #[serde(rename = "summaryByRuntime")]
    pub summary_by_runtime: Vec<ClientVideoRuntimeSummary>,
    #[serde(rename = "topFailureCodes")]
    pub top_failure_codes: Vec<ClientVideoFailureCode>,
    #[serde(rename = "recentSamples")]
    pub recent_samples: Vec<Value>,
}

impl Default for ClientVideoCompression {
    fn default() -> Self {
        Self {
            counters: ClientVideoCounters::default(),
            summary_by_runtime: Vec::new(),
            top_failure_codes: Vec::new(),
            recent_samples: Vec::new(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ClientVideoCounters {
    #[serde(rename = "attemptCount")]
    pub attempt_count: u64,
    #[serde(rename = "successCount")]
    pub success_count: u64,
    #[serde(rename = "failureCount")]
    pub failure_count: u64,
    #[serde(rename = "cancelledCount")]
    pub cancelled_count: u64,
    #[serde(rename = "skippedCount")]
    pub skipped_count: u64,
    #[serde(rename = "timeoutCount")]
    pub timeout_count: u64,
    #[serde(rename = "notSmallerCount")]
    pub not_smaller_count: u64,
    #[serde(rename = "inputBytes")]
    pub input_bytes: u64,
    #[serde(rename = "outputBytes")]
    pub output_bytes: u64,
    #[serde(rename = "successRate")]
    pub success_rate: Option<f64>,
    #[serde(rename = "outputToInputRatio")]
    pub output_to_input_ratio: Option<f64>,
}

impl Default for ClientVideoCounters {
    fn default() -> Self {
        Self {
            attempt_count: 0,
            success_count: 0,
            failure_count: 0,
            cancelled_count: 0,
            skipped_count: 0,
            timeout_count: 0,
            not_smaller_count: 0,
            input_bytes: 0,
            output_bytes: 0,
            success_rate: None,
            output_to_input_ratio: None,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ClientVideoRuntimeSummary {
    pub runtime: String,
    pub count: u64,
    #[serde(rename = "successCount")]
    pub success_count: u64,
    #[serde(rename = "failureCount")]
    pub failure_count: u64,
    #[serde(rename = "cancelledCount")]
    pub cancelled_count: u64,
    #[serde(rename = "skippedCount")]
    pub skipped_count: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ClientVideoFailureCode {
    #[serde(rename = "failureCode")]
    pub failure_code: String,
    pub count: u64,
}

// ─── Runtime Guardrails Types ──────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RuntimeGuardrailsSnapshot {
    #[serde(rename = "uptimeSeconds")]
    pub uptime_seconds: u64,
    pub memory: MemorySnapshot,
    pub cpu: CpuSnapshot,
    #[serde(rename = "heavyProfiling")]
    pub heavy_profiling: HeavyProfilingSnapshot,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MemorySnapshot {
    #[serde(rename = "rssBytes")]
    pub rss_bytes: u64,
    #[serde(rename = "heapUsedBytes")]
    pub heap_used_bytes: u64,
    #[serde(rename = "heapTotalBytes")]
    pub heap_total_bytes: u64,
    #[serde(rename = "externalBytes")]
    pub external_bytes: u64,
    #[serde(rename = "arrayBuffersBytes")]
    pub array_buffers_bytes: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CpuSnapshot {
    #[serde(rename = "userMicros")]
    pub user_micros: u64,
    #[serde(rename = "systemMicros")]
    pub system_micros: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HeavyProfilingSnapshot {
    pub enabled: bool,
    #[serde(rename = "eventLoopDelayP95Ms")]
    pub event_loop_delay_p95_ms: Option<f64>,
    #[serde(rename = "eventLoopDelayMaxMs")]
    pub event_loop_delay_max_ms: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RuntimeTuningSnapshot {
    pub configured: RuntimeTuningConfig,
    #[serde(rename = "startupApplied")]
    pub startup_applied: RuntimeTuningConfig,
    #[serde(rename = "restartRequired")]
    pub restart_required: bool,
    pub effective: EffectiveTuning,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EffectiveTuning {
    #[serde(rename = "uvThreadpoolSize")]
    pub uv_threadpool_size: Option<i32>,
    #[serde(rename = "heavyProfilingEnabled")]
    pub heavy_profiling_enabled: bool,
}

// ─── Stats Types ────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DashboardStatsResponse {
    pub overview: StatsOverview,
    #[serde(rename = "roleDistribution")]
    pub role_distribution: Vec<RoleDistEntry>,
    #[serde(rename = "statusDistribution")]
    pub status_distribution: Vec<StatusDistEntry>,
    #[serde(rename = "recentAudit")]
    pub recent_audit: Vec<Value>,
    #[serde(rename = "topUsers")]
    pub top_users: Vec<Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StatsOverview {
    #[serde(rename = "totalUsers")]
    pub total_users: u64,
    #[serde(rename = "onlineUsers")]
    pub online_users: u64,
    #[serde(rename = "bannedUsers")]
    pub banned_users: u64,
    #[serde(rename = "mutedUsers")]
    pub muted_users: u64,
    #[serde(rename = "totalChannels")]
    pub total_channels: u64,
    #[serde(rename = "totalRoles")]
    pub total_roles: u64,
    #[serde(rename = "totalEmojis")]
    pub total_emojis: u64,
    #[serde(rename = "totalMessages")]
    pub total_messages: u64,
    #[serde(rename = "totalAuditEntries")]
    pub total_audit_entries: u64,
    #[serde(rename = "openReports")]
    pub open_reports: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RoleDistEntry {
    pub role: String,
    pub count: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StatusDistEntry {
    pub status: String,
    pub count: u64,
}

// ─── Policy Storage ─────────────────────────────────────────────────────────

struct PolicyStore {
    inner: HashMap<String, Value>,
    path: PathBuf,
}

impl PolicyStore {
    fn load(path: PathBuf) -> Self {
        let inner = if path.exists() {
            std::fs::read_to_string(&path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default()
        } else {
            HashMap::new()
        };
        Self { inner, path }
    }

    fn save(&self) {
        if let Ok(s) = serde_json::to_string_pretty(&self.inner) {
            let _ = std::fs::write(&self.path, s);
        }
    }

    fn get(&self, key: &str) -> Option<Value> {
        self.inner.get(key).cloned()
    }

    fn set(&mut self, key: String, value: Value) {
        self.inner.insert(key, value);
        self.save();
    }
}

// ─── Query param types ──────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct UserBlockQuery {
    #[serde(rename = "workspaceId")]
    pub workspace_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateBlockInput {
    #[serde(rename = "userId")]
    pub user_id: i64,
    pub reason: Option<String>,
    #[serde(rename = "expiresAt")]
    pub expires_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct SavePolicyInput {
    #[serde(flatten)]
    pub config: Value,
}

// ─── Policy Key → Default Map ───────────────────────────────────────────────

fn policy_default(key: &str) -> Value {
    match key {
        "payments_access" => serde_json::to_value(PaymentAccessPolicy::default()).unwrap(),
        "runtime_tuning" => serde_json::to_value(RuntimeTuningConfig::default()).unwrap(),
        "frontend_app_metadata" => {
            serde_json::to_value(FrontendAppMetadataPolicy::default()).unwrap()
        }
        "upload_limits" => serde_json::to_value(UploadLimitConfig::default()).unwrap(),
        "download_limits" => serde_json::to_value(DownloadLimitConfig::default()).unwrap(),
        "community_node_access" => {
            serde_json::to_value(CommunityNodeAccessPolicy::default()).unwrap()
        }
        "community_node_announcements" => {
            serde_json::to_value(CommunityNodeAnnouncementsPolicy::default()).unwrap()
        }
        _ => json!({}),
    }
}

fn is_valid_policy_key(key: &str) -> bool {
    matches!(
        key,
        "payments_access"
            | "runtime_tuning"
            | "frontend_app_metadata"
            | "upload_limits"
            | "download_limits"
            | "community_node_access"
            | "community_node_announcements"
    )
}

// ─── Routes ─────────────────────────────────────────────────────────────────

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    let data_dir = state.config.data_dir.clone();
    let policy_store = Arc::new(RwLock::new(PolicyStore::load(
        PathBuf::from(&data_dir).join("admin_policies.json"),
    )));

    Router::new()
        .route("/policies/{key}", get(get_policy).post(save_policy))
        .route("/compression-config", get(get_compression_config))
        .route("/compression-metrics", get(get_compression_metrics))
        .route("/compression-metrics/reset", post(reset_compression_metrics))
        .route("/runtime-guardrails", get(get_runtime_guardrails))
        .route("/payments/blocks", get(list_payment_blocks).post(create_payment_block))
        .route("/payments/blocks/{user_id}", delete(clear_payment_block))
        .route("/stats", get(get_dashboard_stats))
        .route("/revoke/user", post(revoke_user))
        .route("/revoke/all", post(revoke_all))
        .route("/revoke/token", post(revoke_token))
        .route("/transfer-ownership", post(transfer_ownership))
        .route("/recovery-codes", post(recovery_codes))
        .layer(axum::Extension(policy_store))
        .with_state(state)
}

// ─── Public user directory (GET /api/users) ────────────────────────────────

/// One row of the user directory consumed by the business kanban board /
/// task panels (`RegisteredUser` in the frontend).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisteredUserRow {
    pub user_id: i64,
    pub username: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_picture: Option<String>,
    pub color: String,
}

/// GET /api/users — list registered users for assignee pickers.
///
/// Any authenticated client (member or guest) may list the user directory;
/// it only exposes the same fields already broadcast over the presence socket
/// (username, avatar, color). Returns a JSON array (never the SPA HTML
/// fallthrough) so the frontend's `response.json()` does not throw.
pub async fn list_users(
    _auth: AuthUser,
    State(state): State<Arc<AppState>>,
) -> crate::error::Result<Json<Vec<RegisteredUserRow>>> {
    let users = state.wdb.list_users().await?;
    Ok(Json(
        users
            .into_iter()
            .map(|u| RegisteredUserRow {
                user_id: u.user_id as i64,
                username: u.username,
                profile_picture: u.profile_picture,
                color: u.color,
            })
            .collect(),
    ))
}

// ─── Auth helpers ───────────────────────────────────────────────────────────

async fn admin_auth(
    headers: &axum::http::HeaderMap,
    state: &Arc<AppState>,
) -> Result<i64, Response> {
    let user_id = match extract_user_id(headers, &state.config.jwt_secret) {
        Ok(id) => id,
        Err(_) => {
            return Err(json_error(
                StatusCode::UNAUTHORIZED,
                "Authentication required",
            ))
        }
    };
    if !is_admin_user(user_id, state).await {
        return Err(json_error(StatusCode::FORBIDDEN, "Admin access required"));
    }
    Ok(user_id)
}

/// Like `admin_auth`, but also requires a valid step-up token in the
/// `X-Stepup-Token` header (obtained from `POST /api/auth/stepup` after
/// re-entering the password). Used to gate destructive admin operations so a
/// stolen long-lived bearer token cannot, by itself, take over the server.
async fn admin_auth_stepup(
    headers: &axum::http::HeaderMap,
    state: &Arc<AppState>,
) -> Result<i64, Response> {
    let user_id = match admin_auth(headers, state).await {
        Ok(id) => id,
        Err(resp) => return Err(resp),
    };
    let Some(token) = headers.get(STEPUP_HEADER).and_then(|v| v.to_str().ok()) else {
        return Err(json_error(
            StatusCode::UNAUTHORIZED,
            "Step-up authentication required: present an X-Stepup-Token from POST /api/auth/stepup",
        ));
    };
    if let Err(e) = verify_stepup_token(&state.config.jwt_secret, token, user_id).await {
        return Err(json_error(StatusCode::UNAUTHORIZED, &e.to_string()));
    }
    Ok(user_id)
}

// ─── Policy Handlers ────────────────────────────────────────────────────────

async fn get_policy(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Path(key): Path<String>,
    Extension(store): Extension<Arc<RwLock<PolicyStore>>>,
) -> Response {
    if let Err(resp) = admin_auth(&headers, &state).await {
        return resp;
    }
    if !is_valid_policy_key(&key) {
        return json_error(StatusCode::NOT_FOUND, &format!("Unknown policy key: {}", key));
    }
    let defaults = policy_default(&key);
    let config: Value = {
        let guard: tokio::sync::RwLockReadGuard<'_, PolicyStore> = store.read().await;
        guard.get(&key).unwrap_or_else(|| defaults.clone())
    };
    Json(json!({
        "key": key,
        "config": config,
        "defaults": defaults,
    }))
    .into_response()
}

async fn save_policy(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Path(key): Path<String>,
    Extension(store): Extension<Arc<RwLock<PolicyStore>>>,
    Json(input): Json<SavePolicyInput>,
) -> Response {
    if let Err(resp) = admin_auth(&headers, &state).await {
        return resp;
    }
    if !is_valid_policy_key(&key) {
        return json_error(StatusCode::NOT_FOUND, &format!("Unknown policy key: {}", key));
    }
    let merged: Value = {
        let defaults = policy_default(&key);
        if let Some(obj) = input.config.as_object() {
            if obj.is_empty() {
                defaults
            } else {
                input.config.clone()
            }
        } else {
            defaults
        }
    };
    {
        let mut guard: tokio::sync::RwLockWriteGuard<'_, PolicyStore> = store.write().await;
        guard.set(key.clone(), merged.clone());
    }
    Json(json!({ "config": merged })).into_response()
}

// ─── Compression Handlers ───────────────────────────────────────────────────

async fn get_compression_config(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = admin_auth(&headers, &state).await {
        return resp;
    }
    let config = AdminCompressionConfig::default();
    Json(json!({ "config": config })).into_response()
}

async fn get_compression_metrics(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = admin_auth(&headers, &state).await {
        return resp;
    }
    #[derive(Serialize)]
    struct EmptyMetrics {
        counters: CompressionCounters,
        summary_by_ext: CompressionSummary,
        recent_samples: CompressionRecentSamples,
        client_video_compression: Option<ClientVideoCompression>,
    }
    let metrics = EmptyMetrics {
        counters: CompressionCounters::default(),
        summary_by_ext: CompressionSummary::default(),
        recent_samples: CompressionRecentSamples::default(),
        client_video_compression: None,
    };
    Json(json!({ "metrics": metrics })).into_response()
}

async fn reset_compression_metrics(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = admin_auth(&headers, &state).await {
        return resp;
    }
    Json(json!({ "success": true })).into_response()
}

// ─── Runtime Guardrails Handler ─────────────────────────────────────────────

fn read_proc_self_status() -> (u64, u64) {
    let rss = std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|content| {
            content
                .lines()
                .find(|line| line.starts_with("VmRSS:"))
                .and_then(|line| {
                    line.split_whitespace()
                        .nth(1)
                        .and_then(|s| s.parse::<u64>().ok())
                })
        })
        .unwrap_or(0);

    let cpu = std::fs::read_to_string("/proc/self/stat")
        .ok()
        .and_then(|content| {
            let fields: Vec<&str> = content.split_whitespace().collect();
            let utime: u64 = fields.get(13).and_then(|s| s.parse().ok()).unwrap_or(0);
            let stime: u64 = fields.get(14).and_then(|s| s.parse().ok()).unwrap_or(0);
            Some((utime + stime) * 10_000) // Approximate µs from clock ticks
        })
        .unwrap_or(0);

    (rss * 1024, cpu) // VmRSS is in kB, convert to bytes
}

static START_TIME: std::sync::LazyLock<std::time::Instant> =
    std::sync::LazyLock::new(std::time::Instant::now);

async fn get_runtime_guardrails(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = admin_auth(&headers, &state).await {
        return resp;
    }
    let uptime = START_TIME.elapsed().as_secs();
    let (rss_bytes, cpu_micros) = read_proc_self_status();

    let guardrails = RuntimeGuardrailsSnapshot {
        uptime_seconds: uptime,
        memory: MemorySnapshot {
            rss_bytes,
            heap_used_bytes: 0,
            heap_total_bytes: 0,
            external_bytes: 0,
            array_buffers_bytes: 0,
        },
        cpu: CpuSnapshot {
            user_micros: cpu_micros,
            system_micros: 0,
        },
        heavy_profiling: HeavyProfilingSnapshot {
            enabled: false,
            event_loop_delay_p95_ms: None,
            event_loop_delay_max_ms: None,
        },
    };

    let default_tuning = RuntimeTuningConfig::default();
    let runtime_tuning = RuntimeTuningSnapshot {
        configured: default_tuning.clone(),
        startup_applied: default_tuning.clone(),
        restart_required: false,
        effective: EffectiveTuning {
            uv_threadpool_size: None,
            heavy_profiling_enabled: false,
        },
    };

    Json(json!({
        "runtimeTuning": runtime_tuning,
        "guardrails": guardrails,
    }))
    .into_response()
}

// ─── Payment Block Handlers ─────────────────────────────────────────────────

async fn list_payment_blocks(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Query(_query): Query<UserBlockQuery>,
) -> Response {
    if let Err(resp) = admin_auth(&headers, &state).await {
        return resp;
    }
    let blocks: Vec<PaymentUserBlock> = Vec::new();
    Json(json!({ "blocks": blocks })).into_response()
}

async fn create_payment_block(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(input): Json<CreateBlockInput>,
) -> Response {
    let admin_id = match extract_user_id(&headers, &state.config.jwt_secret) {
        Ok(id) => id,
        Err(_) => return json_error(StatusCode::UNAUTHORIZED, "Authentication required"),
    };
    if !is_admin_user(admin_id, &state).await {
        return json_error(StatusCode::FORBIDDEN, "Admin access required");
    }
    let now = chrono::Utc::now().timestamp_millis();
    let block = PaymentUserBlock {
        user_id: input.user_id,
        workspace_id: "default-workspace".to_string(),
        reason: input.reason.clone(),
        blocked_by_user_id: Some(admin_id),
        blocked_by_username: None,
        blocked_username: None,
        blocked_at: now,
        expires_at: input.expires_at,
    };
    let _ = state
        .wdb
        .ingest_event(
            "payment",
            "upsert_user_block",
            &json!({
                "userId": block.user_id,
                "workspaceId": block.workspace_id,
                "row": block,
            }),
        )
        .await;
    Json(json!({ "block": block })).into_response()
}

async fn clear_payment_block(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Path(blocked_user_id): Path<i64>,
) -> Response {
    let admin_id = match extract_user_id(&headers, &state.config.jwt_secret) {
        Ok(id) => id,
        Err(_) => return json_error(StatusCode::UNAUTHORIZED, "Authentication required"),
    };
    if !is_admin_user(admin_id, &state).await {
        return json_error(StatusCode::FORBIDDEN, "Admin access required");
    }
    let _ = state
        .wdb
        .ingest_event(
            "payment",
            "delete_user_block",
            &json!({
                "userId": blocked_user_id,
                "workspaceId": "default-workspace",
            }),
        )
        .await;
    Json(json!({ "cleared": true })).into_response()
}

// ─── Dashboard Stats Handler ────────────────────────────────────────────────

async fn get_dashboard_stats(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = admin_auth(&headers, &state).await {
        return resp;
    }
    let stats = DashboardStatsResponse {
        overview: StatsOverview {
            total_users: 0,
            online_users: 0,
            banned_users: 0,
            muted_users: 0,
            total_channels: 0,
            total_roles: 0,
            total_emojis: 0,
            total_messages: 0,
            total_audit_entries: 0,
            open_reports: 0,
        },
        role_distribution: vec![
            RoleDistEntry { role: "owner".into(), count: 0 },
            RoleDistEntry { role: "admin".into(), count: 0 },
            RoleDistEntry { role: "mod".into(), count: 0 },
            RoleDistEntry { role: "member".into(), count: 0 },
            RoleDistEntry { role: "guest".into(), count: 0 },
        ],
        status_distribution: vec![
            StatusDistEntry { status: "online".into(), count: 0 },
            StatusDistEntry { status: "idle".into(), count: 0 },
            StatusDistEntry { status: "dnd".into(), count: 0 },
            StatusDistEntry { status: "offline".into(), count: 0 },
        ],
        recent_audit: Vec::new(),
        top_users: Vec::new(),
    };
    Json(json!(stats)).into_response()
}

// ─── Token revocation handlers ──────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct RevokeUserInput {
    #[serde(rename = "userId")]
    user_id: i64,
}

#[derive(Debug, Deserialize)]
struct RevokeTokenInput {
    jti: String,
}

/// Force-logout every token for a user. Cannot be used on the server owner.
async fn revoke_user(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(input): Json<RevokeUserInput>,
) -> Response {
    if let Err(resp) = admin_auth_stepup(&headers, &state).await {
        return resp;
    }
    if state.is_owner(input.user_id).await {
        return json_error(StatusCode::FORBIDDEN, "Cannot revoke the server owner");
    }
    state.revoke_user(input.user_id).await;
    Json(json!({ "success": true, "userId": input.user_id })).into_response()
}

/// Revoke ALL outstanding tokens at once (e.g. after a suspected breach).
/// Every client is forced to re-authenticate.
async fn revoke_all(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = admin_auth_stepup(&headers, &state).await {
        return resp;
    }
    state.revoke_all_tokens().await;
    Json(json!({ "success": true })).into_response()
}

/// Revoke a single token by its `jti`.
async fn revoke_token(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(input): Json<RevokeTokenInput>,
) -> Response {
    if let Err(resp) = admin_auth(&headers, &state).await {
        return resp;
    }
    state.revoke_token(input.jti.clone()).await;
    Json(json!({ "success": true, "jti": input.jti })).into_response()
}

// ─── Ownership transfer & recovery codes ────────────────────────────────────

#[derive(Debug, Deserialize)]
struct TransferOwnerInput {
    #[serde(rename = "userId")]
    user_id: i64,
}

/// Transfer ownership to another existing user. Owner-only.
async fn transfer_ownership(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(input): Json<TransferOwnerInput>,
) -> Response {
    let caller = match admin_auth_stepup(&headers, &state).await {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    if !state.is_owner(caller).await {
        return json_error(StatusCode::FORBIDDEN, "Only the owner can transfer ownership");
    }
    // Target must be a real user.
    let exists = match state.wdb.get_user(input.user_id as u64).await {
        Ok(Some(_)) => true,
        _ => false,
    };
    if !exists {
        return json_error(StatusCode::BAD_REQUEST, "Target user does not exist");
    }
    if caller == input.user_id {
        return json_error(StatusCode::BAD_REQUEST, "Already the owner");
    }
    // Revoke the old owner's sessions so a compromised owner can't interfere.
    state.revoke_user(caller).await;
    {
        *state.owner_user_id.write().await = Some(input.user_id);
    }
    if let Err(e) = state.wdb.claim_owner(input.user_id as u64).await {
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("failed to persist owner: {e}"),
        );
    }
    Json(json!({ "success": true, "owner_user_id": input.user_id })).into_response()
}

/// Generate a fresh set of one-time recovery codes for the owner. The
/// plaintext codes are returned exactly once.
async fn recovery_codes(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
) -> Response {
    let caller = match admin_auth_stepup(&headers, &state).await {
        Ok(id) => id,
        Err(resp) => return resp,
    };
    if !state.is_owner(caller).await {
        return json_error(StatusCode::FORBIDDEN, "Only the owner can manage recovery codes");
    }
    let codes = state.generate_recovery_codes(caller, 5).await;
    Json(json!({ "success": true, "codes": codes, "warning": "Store these safely; they are shown only once." }))
        .into_response()
}
