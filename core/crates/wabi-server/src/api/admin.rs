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
    is_admin_user, json_error, PaymentAccessPolicy, PaymentUserBlock,
};
use crate::auth_extractor::{verify_stepup_token, AuthUser, STEPUP_HEADER};
use crate::jobs::JobStatus;
use crate::state::AppState;
use wabidb::engine::wabi_store::WabiStore;

// ─── Policy Types ───────────────────────────────────────────────────────────

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
    #[serde(rename = "brandProfile")]
    pub brand_profile: Option<String>,
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
            brand_profile: None,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AuthPolicy {
    pub mode: String,
    #[serde(rename = "allowGuest")]
    pub allow_guest: bool,
    #[serde(rename = "allowRegister")]
    pub allow_register: bool,
    #[serde(rename = "emailVerifyRequired")]
    pub email_verify_required: bool,
}

impl Default for AuthPolicy {
    fn default() -> Self {
        Self { mode: "open".into(), allow_guest: true, allow_register: true, email_verify_required: false }
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
    /// Extended counters (registered/bot/active users, 24h-seen,
    /// channels-by-kind). Additive; older clients ignore it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra: Option<Value>,
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
    path: PathBuf,
}

impl PolicyStore {
    fn load(path: PathBuf) -> Self {
        Self { path }
    }

    fn read(&self) -> anyhow::Result<HashMap<String, Value>> {
        match std::fs::read(&self.path) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(HashMap::new()),
            Err(error) => Err(error.into()),
        }
    }

    fn get(&self, key: &str) -> anyhow::Result<Option<Value>> {
        Ok(self.read()?.remove(key))
    }

    fn set(&mut self, key: String, value: Value) -> anyhow::Result<()> {
        use std::io::Write;
        // The same file is read by the public branding endpoints. No cache may
        // claim a publication that never reached disk, or hide a failed read.
        let mut next = self.read()?;
        next.insert(key, value);
        let bytes = serde_json::to_vec_pretty(&next)?;
        let parent = self.path.parent().ok_or_else(|| anyhow::anyhow!("Policy path has no parent"))?;
        #[cfg(unix)]
        let directory = std::fs::File::open(parent)?;
        let temporary = parent.join(format!(".admin-policies-{}.tmp", uuid::Uuid::new_v4()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        let outcome = (|| -> anyhow::Result<()> {
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            std::fs::rename(&temporary, &self.path)?;
            #[cfg(unix)]
            directory.sync_all()?;
            Ok(())
        })();
        if outcome.is_err() {
            // Only our unique, successfully created temporary file is removed.
            // A post-rename directory sync failure is an uncertain publication;
            // never truncate the target or attempt to roll it back.
            let _ = std::fs::remove_file(&temporary);
        }
        outcome
    }
}

fn policy_unavailable(error: &anyhow::Error) -> Response {
    tracing::error!(%error, "admin policy storage unavailable");
    json_error(StatusCode::SERVICE_UNAVAILABLE, "Server settings could not be read or published. Check the server logs before retrying.")
}

#[cfg(test)]
mod policy_storage_tests {
    use super::*;

    #[test]
    fn publication_is_visible_to_independent_readers_and_preserves_other_keys() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("admin_policies.json");
        let mut first = PolicyStore::load(path.clone());
        let mut other = PolicyStore::load(path.clone());
        first.set("payments_access".into(), json!({"enabled":false})).unwrap();
        other.set("frontend_app_metadata".into(), json!({"displayName":"New identity"})).unwrap();
        assert_eq!(first.get("frontend_app_metadata").unwrap(), Some(json!({"displayName":"New identity"})));
        assert_eq!(other.get("payments_access").unwrap(), Some(json!({"enabled":false})));
        assert_eq!(crate::api::public::load_frontend_metadata_policy(directory.path().to_str().unwrap())["displayName"], "New identity");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1, "no temporary-file leftovers");
    }

    #[test]
    fn corrupt_policy_is_not_empty_and_publication_never_overwrites_it() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("admin_policies.json");
        for bytes in [b"{broken".as_slice(), b"[]".as_slice(), b"null".as_slice()] {
            std::fs::write(&path, bytes).unwrap();
            let mut store = PolicyStore::load(path.clone());
            assert!(store.get("frontend_app_metadata").is_err());
            assert!(store.set("frontend_app_metadata".into(), json!({"displayName":"Lost"})).is_err());
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
        }
    }

    #[test]
    fn a_failed_write_has_no_cached_success_and_can_be_retried() {
        let directory = tempfile::tempdir().unwrap();
        let parent = directory.path().join("not-created-yet");
        let mut store = PolicyStore::load(parent.join("admin_policies.json"));
        assert!(store.set("frontend_app_metadata".into(), json!({"displayName":"Unpublished"})).is_err());
        assert_eq!(store.get("frontend_app_metadata").unwrap(), None);
        std::fs::create_dir(&parent).unwrap();
        store.set("frontend_app_metadata".into(), json!({"displayName":"Published"})).unwrap();
        assert_eq!(store.get("frontend_app_metadata").unwrap(), Some(json!({"displayName":"Published"})));
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
        "auth_policy" => serde_json::to_value(AuthPolicy::default()).unwrap(),
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
            | "auth_policy"
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
        .route("/users/reset-password", post(reset_user_password))
        .route("/users/clear-login-lockout", post(clear_login_lockout))
        .route("/uploads/revoke", post(revoke_upload))
        .route("/uploads", get(list_uploads))
        .route("/jobs/dead-lettered", get(list_dead_lettered))
        .route("/jobs/{job_id}/requeue", post(requeue_job))
        .layer(axum::Extension(policy_store))
        .with_state(state)
}

// ─── Job-queue dead-letter admin (P1/W2) ────────────────────────────────────

/// List quarantined (dead-lettered) jobs for admin inspection.
async fn list_dead_lettered(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, Response> {
    if let Err(resp) = admin_auth(&headers, &state).await {
        return Err(resp);
    }
    let jobs = state.job_queue.list_jobs(Some(JobStatus::DeadLettered)).await;
    let out: Vec<serde_json::Value> = jobs
        .iter()
        .map(|j| {
            serde_json::json!({
                "jobId": j.job_id,
                "kind": j.kind,
                "status": j.status,
                "retryCount": j.retry_count,
                "maxRetries": j.max_retries,
                "assignedNodeId": j.assigned_node_id,
                "createdAt": j.created_at,
                "completedAt": j.completed_at,
                "errorMessage": j.error_message,
                // Payload included: inspection is the point of the DLQ.
                "payload": j.payload,
            })
        })
        .collect();
    Ok(Json(serde_json::json!({ "jobs": out })))
}

/// Requeue a dead-lettered job: resets retry_count and returns it to Pending.
async fn requeue_job(
    headers: axum::http::HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(job_id): Path<String>,
) -> Result<Response, Response> {
    if let Err(resp) = admin_auth(&headers, &state).await {
        return Err(resp);
    }
    match state.job_queue.requeue_job(&job_id).await {
        Ok(job) => Ok(Json(serde_json::json!({
            "jobId": job.job_id,
            "status": job.status,
            "retryCount": job.retry_count,
        }))
        .into_response()),
        Err(crate::jobs::JobQueueError::JobNotFound) => {
            Err(json_error(StatusCode::NOT_FOUND, "job not found"))
        }
        Err(crate::jobs::JobQueueError::NotClaimable) => Err(json_error(
            StatusCode::CONFLICT,
            "job is not dead-lettered; requeue only applies to quarantined jobs",
        )),
        Err(e) => Err(json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &e.to_string(),
        )),
    }
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

// ─── Admin user password reset / lockout ───────────────────────────────────

#[derive(Debug, Deserialize)]
struct ResetUserPasswordRequest {
    #[serde(rename = "targetUserId")]
    target_user_id: i64,
    #[serde(rename = "newPassword")]
    new_password: String,
    // Older clients may send false; true cannot be honored without a real
    // must-change-password workflow and must not report a temporary reset.
    temporary: Option<bool>,
}

/// POST /api/admin/users/reset-password — admin forcibly sets a new password
/// for a registered user. Revokes all existing tokens for the target so stale
/// sessions cannot linger. Gated on admin role only (the frontend admin UI
/// sends no X-Stepup-Token; stepup can be layered on when the UI grows it).
async fn reset_user_password(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(req): Json<ResetUserPasswordRequest>,
) -> Response {
    let actor_id = match admin_auth(&headers, &state).await {
        Ok(id) => id,
        Err(response) => return response,
    };
    if req.target_user_id <= 0 {
        return json_error(StatusCode::BAD_REQUEST, "A valid target user is required");
    }
    if req.target_user_id == actor_id {
        return json_error(StatusCode::FORBIDDEN, "Use your account password settings to change your own password");
    }
    if state.is_owner(req.target_user_id).await {
        return json_error(StatusCode::FORBIDDEN, "The server owner's password cannot be reset here");
    }
    match state.wdb.get_user_role("default-workspace", req.target_user_id as u64).await {
        Ok(Some(role)) if role == "Owner" => return json_error(StatusCode::FORBIDDEN, "The server owner's password cannot be reset here"),
        Err(error) => {
            tracing::error!("Cannot authorize password reset target: {error}");
            return json_error(StatusCode::SERVICE_UNAVAILABLE, "Account permissions are unavailable; password was not changed");
        }
        _ => {}
    }
    if req.temporary == Some(true) {
        return json_error(StatusCode::BAD_REQUEST, "Temporary passwords are not supported; use a permanent password reset");
    }
    if req.new_password.len() < 6 {
        return json_error(
            StatusCode::BAD_REQUEST,
            "Password must be at least 6 characters",
        );
    }
    let user_row = match state.wdb.get_user(req.target_user_id as u64).await {
        Ok(Some(u)) => u,
        Ok(None) => return json_error(StatusCode::NOT_FOUND, "User not found"),
        Err(e) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("get_user failed: {e}"),
            )
        }
    };
    if user_row.password_hash.is_empty() {
        return json_error(
            StatusCode::BAD_REQUEST,
            "Target account is guest-only; it has no password to reset",
        );
    }
    let password_hash = match bcrypt::hash(&req.new_password, bcrypt::DEFAULT_COST) {
        Ok(h) => h,
        Err(e) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("password hashing failed: {e}"),
            )
        }
    };
    if let Err(e) = state
        .wdb
        .update_user(
            req.target_user_id as u64,
            wabidb::domain::UserUpdate {
                password_hash: Some(password_hash),
                ..Default::default()
            },
        )
        .await
    {
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("update_user failed: {e}"),
        );
    }
    state.revoke_user(req.target_user_id).await;
    Json(json!({ "success": true })).into_response()
}

#[derive(Debug, Deserialize)]
struct ClearLoginLockoutRequest {
    #[serde(rename = "targetUserId")]
    target_user_id: i64,
}

#[derive(Debug, Deserialize)]
struct RevokeUploadRequest {
    filename: String,
}

#[derive(Debug, Deserialize)]
struct ListUploadsQuery {
    #[serde(default)]
    channel_id: Option<String>,
}

/// POST /api/admin/users/clear-login-lockout — the frontend admin UI calls
/// this after a password reset. No login-lockout store exists server-side, so
/// this is an honest no-op that returns success instead of 404.
async fn clear_login_lockout(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(_req): Json<ClearLoginLockoutRequest>,
) -> Response {
    if let Err(resp) = admin_auth(&headers, &state).await {
        return resp;
    }
    Json(json!({ "success": true, "cleared": true })).into_response()
}

// ─── Auth helpers ───────────────────────────────────────────────────────────

pub(crate) async fn admin_auth(
    headers: &axum::http::HeaderMap,
    state: &Arc<AppState>,
) -> Result<i64, Response> {
    let auth = crate::api::payments::authenticate_account(headers, state).await?;
    if auth.is_guest || !is_admin_user(auth.user_id, state).await {
        return Err(json_error(StatusCode::FORBIDDEN, "Admin access required"));
    }
    Ok(auth.user_id)
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
    if key == "payments_access" {
        return match crate::api::payments::load_access_policy(&state, true).await {
            Ok(policy) => Json(json!({ "key": key, "config": policy, "defaults": defaults })).into_response(),
            Err(error) => crate::api::payments::access_unavailable(&error),
        };
    }
    let config: Value = {
        let guard: tokio::sync::RwLockReadGuard<'_, PolicyStore> = store.read().await;
        match guard.get(&key) {
            Ok(config) => config.unwrap_or_else(|| defaults.clone()),
            Err(error) => return policy_unavailable(&error),
        }
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
    if key == "payments_access" {
        let policy = match crate::api::payments::parse_access_policy(&input.config) {
            Ok(policy) => policy,
            Err(message) => return json_error(StatusCode::BAD_REQUEST, message),
        };
        return match crate::api::payments::save_access_policy(&state, &policy).await {
            Ok(()) => Json(json!({ "config": policy })).into_response(),
            Err(error) => crate::api::payments::access_unavailable(&error),
        };
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
        if let Err(error) = guard.set(key.clone(), merged.clone()) {
            return policy_unavailable(&error);
        }
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

async fn get_runtime_guardrails(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = admin_auth(&headers, &state).await {
        return resp;
    }
    let uptime = state.started_at.elapsed().as_secs();
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
    let blocks = match state.wdb.list_payment_user_blocks("default-workspace").await {
        Ok(blocks) => blocks,
        Err(e) => {
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("failed to load payment blocks: {}", e),
            )
        }
    };
    Json(json!({ "blocks": blocks })).into_response()
}

async fn create_payment_block(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(input): Json<CreateBlockInput>,
) -> Response {
    let admin_id = match admin_auth(&headers, &state).await {
        Ok(id) => id,
        Err(response) => return response,
    };
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
    if let Err(e) = state.wdb.upsert_payment_user_block(&block).await {
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("failed to save payment block: {}", e),
        );
    }
    Json(json!({ "block": block })).into_response()
}

async fn clear_payment_block(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Path(blocked_user_id): Path<i64>,
) -> Response {
    if let Err(response) = admin_auth(&headers, &state).await {
        return response;
    }
    if let Err(e) = state
        .wdb
        .delete_payment_user_block("default-workspace", blocked_user_id)
        .await
    {
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("failed to clear payment block: {}", e),
        );
    }
    Json(json!({ "cleared": true })).into_response()
}

// ─── Dashboard Stats Handler ────────────────────────────────────────────────

/// VmRSS is a Linux measurement in KiB. Missing/unsupported measurements are
/// unknown, not zero memory use. Keep this separate from legacy Node metrics.
#[cfg(any(target_os = "linux", test))]
fn parse_process_memory_bytes(status: &str) -> Option<u64> {
    let line = status.lines().find(|line| line.starts_with("VmRSS:"))?;
    let mut fields = line.split_whitespace();
    fields.next()?;
    let kib = fields.next()?.parse::<u64>().ok()?;
    if fields.next()? != "kB" || fields.next().is_some() {
        return None;
    }
    kib.checked_mul(1024)
}

fn process_memory_bytes() -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        std::fs::read_to_string("/proc/self/status")
            .ok()
            .and_then(|status| parse_process_memory_bytes(&status))
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

#[cfg(test)]
mod dashboard_tests {
    use super::{dashboard_audit_entry, parse_process_memory_bytes};

    #[test]
    fn process_memory_is_a_measurement_or_unknown_never_an_invented_zero() {
        assert_eq!(parse_process_memory_bytes("Name:\twabi-server\nVmRSS:\t 12345 kB\n"), Some(12_641_280));
        assert_eq!(parse_process_memory_bytes("VmRSS: 0 kB"), Some(0));
        for content in ["", "Name: wabi-server", "VmRSS: unknown kB", "VmRSS: 123 bytes", "VmRSS: 123",
            "VmRSS: -1 kB", "VmRSS: 18446744073709551615 kB"] {
            assert_eq!(parse_process_memory_bytes(content), None, "{content}");
        }
    }

    #[test]
    fn legacy_zero_actor_and_unrecognized_role_do_not_invent_identity_or_expose_payloads() {
        let entry = wabidb::projections::audit::AuditEntry {
            commit_seq: u64::MAX, event_type: "role_assigned".into(), stream_id: "PRIVATE-STREAM".into(),
            payload: serde_json::json!({"assigned_by":0,"user_id":7,"role":"SECRET-CANARY"}),
        };
        let users = std::collections::HashMap::from([(0, "do not guess this actor"), (7, "target")]);
        let row = dashboard_audit_entry(entry, &users, &Default::default());
        assert_eq!(row["id"], u64::MAX.to_string());
        assert!(row["performedBy"].is_null());
        assert!(row["createdAt"].is_null());
        assert_eq!(row["targetUser"], "target");
        assert_eq!(row["details"], "Assigned server role");
        assert!(!row.to_string().contains("SECRET-CANARY"));
        assert!(!row.to_string().contains("PRIVATE-STREAM"));
    }
}

fn dashboard_health(state: &AppState) -> Value {
    let engine = state.wdb.engine();
    let projection = engine.projection_state();
    let writer_running = engine.is_writer_running();
    let projection_healthy = projection.is_healthy();
    json!({
        "status": if writer_running && projection_healthy { "ready" } else { "degraded" },
        "writerRunning": writer_running,
        "projectionHealthy": projection_healthy,
        // Strings preserve the full u64 range across the JS boundary. There is
        // no public durable committed watermark; do not substitute applied seq.
        "appliedCommitSeq": projection.applied_commit_seq().to_string(),
        "committedSeq": null,
        "uptimeSeconds": state.started_at.elapsed().as_secs_f64(),
        "processMemoryBytes": process_memory_bytes(),
        "sampledAt": chrono::Utc::now().to_rfc3339(),
    })
}

/// The audit index is deliberately not a comprehensive moderation log. Return
/// only summaries of its known event types, never arbitrary stored payloads,
/// private conversation names, policy secrets or guessed actors/timestamps.
fn dashboard_audit_entry(
    entry: wabidb::projections::audit::AuditEntry,
    users: &HashMap<u64, &str>,
    public_channels: &HashMap<&str, &str>,
) -> Value {
    let user_name = |key: &str| {
        entry.payload.get(key).and_then(Value::as_u64)
            // Legacy ingest used zero when no actor/target ID was recorded.
            .filter(|id| *id > 0)
            .and_then(|id| users.get(&id).copied())
    };
    let role = match entry.payload.get("role").and_then(Value::as_str)
        .unwrap_or("").to_ascii_lowercase().as_str()
    {
        "owner" => "Owner", "admin" => "Admin", "mod" | "moderator" => "Moderator",
        "member" => "Member", "guest" => "Guest", _ => "server",
    };
    let details = match entry.event_type.as_str() {
        "role_assigned" => format!("Assigned {role} role"),
        "role_removed" => "Removed a server role".into(),
        "channel_settings_updated" => "Updated channel settings".into(),
        _ => "Recorded an administration change".into(),
    };
    let channel = entry.payload.get("channel_id").and_then(Value::as_str)
        .and_then(|id| public_channels.get(id).copied());
    json!({
        "id": entry.commit_seq.to_string(),
        "action": entry.event_type,
        "performedBy": user_name("assigned_by"),
        "targetUser": user_name("user_id"),
        "targetChannel": channel,
        "details": details,
        // Existing AuditEntry has no event timestamp. No persistent codec or
        // replay changes are needed to display the history already recorded.
        "createdAt": null,
    })
}

async fn get_dashboard_stats(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
) -> Response {
    if let Err(resp) = admin_auth(&headers, &state).await {
        return resp;
    }

    // ── Users: real counts from the user projection ──
    let users = match state.wdb.list_users().await {
        Ok(users) => users,
        Err(error) => {
            tracing::error!(%error, "admin dashboard user query failed");
            return json_error(StatusCode::SERVICE_UNAVAILABLE, "Server overview is temporarily unavailable");
        }
    };
    let total_users = users.len() as u64;
    let registered_users = users.iter().filter(|u| u.is_registered).count() as u64;
    let bot_users = users.iter().filter(|u| u.is_bot).count() as u64;
    let active_users = users.iter().filter(|u| u.is_active).count() as u64;
    // "Online now" = sockets currently in the socket.io presence map.
    let online_users = crate::socketio::connected_user_count().await;
    // Recently seen (24h) from last_seen_micros.
    let now_micros = chrono::Utc::now().timestamp_micros();
    let day_us: i64 = 86_400_000_000;
    let seen_24h = users
        .iter()
        .filter(|u| u.last_seen_micros > 0 && now_micros - u.last_seen_micros < day_us)
        .count() as u64;

    // Role distribution via the existing role resolver.
    let mut role_counts: std::collections::HashMap<String, u64> =
        std::collections::HashMap::new();
    for u in &users {
        // Match the effective role shown in the Socket.IO roster. A configured
        // admin is still an admin without an RBAC event; guests are not Members.
        let user_id = u.user_id as i64;
        let role = if u.password_hash.is_empty() {
            "Guest".to_string()
        } else if state.is_owner(user_id).await {
            "Owner".to_string()
        } else if state.is_admin(user_id).await {
            "Admin".to_string()
        } else {
            state.get_user_highest_role(user_id).await
        };
        *role_counts.entry(role).or_insert(0) += 1;
    }
    let mut role_distribution: Vec<RoleDistEntry> = role_counts
        .into_iter()
        .map(|(role, count)| RoleDistEntry { role, count })
        .collect();
    role_distribution.sort_by(|a, b| b.count.cmp(&a.count));

    // ── Channels: counts by kind from the channel projection ──
    let channels = match state.wdb.list_channels(None).await {
        Ok(channels) => channels,
        Err(error) => {
            tracing::error!(%error, "admin dashboard channel query failed");
            return json_error(StatusCode::SERVICE_UNAVAILABLE, "Server overview is temporarily unavailable");
        }
    };
    let total_channels = channels.len() as u64;
    let mut kind_counts: serde_json::Map<String, Value> = serde_json::Map::new();
    for c in &channels {
        let kind = format!("{:?}", c.channel_kind).to_lowercase();
        *kind_counts
            .entry(kind)
            .or_insert(Value::from(0u64)) = Value::from(
            kind_counts.get(&format!("{:?}", c.channel_kind).to_lowercase())
                .and_then(|v| v.as_u64())
                .unwrap_or(0)
                + 1,
        );
    }

    // There is no cheap live-message counter excluding deleted/timed-out data;
    // raw index length is not that count. Do not scan every message on each
    // dashboard poll. Keep the legacy numeric slot, explicitly unavailable.
    let total_messages: u64 = 0;

    use wabidb::projections::audit::AuditProjection;
    let projection = state.wdb.engine().projection_state();
    let audit = match AuditProjection::recent(projection, 10) {
        Ok(entries) => entries,
        Err(error) => {
            tracing::error!(%error, "admin dashboard activity query failed");
            return json_error(StatusCode::SERVICE_UNAVAILABLE, "Server overview is temporarily unavailable");
        }
    };
    let user_names = users.iter().map(|user| (user.user_id, user.username.as_str())).collect();
    let public_channels = channels.iter()
        .filter(|channel| !matches!(channel.channel_kind,
            wabidb::domain::ChannelKind::Dm | wabidb::domain::ChannelKind::GroupDm))
        .map(|channel| (channel.channel_id.as_str(), channel.name.as_str())).collect();
    let recent_audit = audit.into_iter()
        .map(|entry| dashboard_audit_entry(entry, &user_names, &public_channels)).collect();

    let stats = DashboardStatsResponse {
        overview: StatsOverview {
            total_users,
            online_users,
            banned_users: total_users.saturating_sub(active_users),
            muted_users: 0, // unavailable legacy slot, not a measured zero
            total_channels,
            total_roles: role_distribution.len() as u64,
            total_emojis: 0, // emoji projection not wired to a count yet
            total_messages,
            total_audit_entries: AuditProjection::count(projection) as u64,
            open_reports: 0, // no moderation report intake/read model exists
        },
        extra: Some(json!({
            "registeredUsers": registered_users,
            "botUsers": bot_users,
            "activeUsers": active_users,
            "usersSeenLast24h": seen_24h,
            "channelsByKind": kind_counts,
            "health": dashboard_health(&state),
            "auditCoverage": ["server_roles", "channel_settings"],
            // Additive read-model metadata: zero/empty placeholders below do
            // not claim real counts or an absence of activity. Old clients
            // keep their response shape; new clients can label these honestly.
            "unavailableMetrics": ["totalMessages", "totalEmojis", "mutedUsers",
                "openReports", "topUsers"],
        })),
        role_distribution,
        status_distribution: vec![StatusDistEntry { status: "online".into(), count: online_users }],
        recent_audit,
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
    /// Optional token expiration (unix seconds). Supplied entries become
    /// prunable once past; omitted entries are kept indefinitely (same
    /// semantics as legacy revoked jtis).
    #[serde(default)]
    exp: Option<i64>,
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
    state
        .revoke_token_with_exp(input.jti.clone(), input.exp.unwrap_or(i64::MAX))
        .await;
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

/// Revoke an uploaded file (WS-6b). Returns 410 on subsequent access.
async fn revoke_upload(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(req): Json<RevokeUploadRequest>,
) -> Response {
    if let Err(resp) = admin_auth(&headers, &state).await {
        return resp;
    }
    let newly_revoked = state.upload_registry.revoke(&req.filename).await;
    Json(json!({ "success": true, "revoked": newly_revoked, "filename": req.filename })).into_response()
}

/// List uploaded files (WS-6b). Optionally filter by channel.
async fn list_uploads(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Query(query): Query<ListUploadsQuery>,
) -> Response {
    if let Err(resp) = admin_auth(&headers, &state).await {
        return resp;
    }
    let files = match query.channel_id {
        Some(ch) => state.upload_registry.by_channel(&ch).await,
        None => state.upload_registry.list().await,
    };
    Json(json!({ "success": true, "files": files })).into_response()
}
