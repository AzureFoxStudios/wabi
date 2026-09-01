use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    response::IntoResponse,
    Json, Router,
};
use serde::Deserialize;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tracing::{info, warn};

use crate::auth_extractor::{AuthUser, OptionalAuthUser};
use crate::error::{AppError, Result};
use crate::state::AppState;
use wabidb::engine::wabi_store::WabiStore;

/// HMAC-SHA256 signature helper for signed download URLs (L7).
/// Payload: `{channel_id}|{user_id}|{path}|{expires}` — user is embedded so
/// membership can be re-checked at download time, not just at mint time.
fn lore_signature(secret: &str, channel_id: i64, user_id: i64, path: &str, expires: i64) -> String {
    use hmac::{Hmac, KeyInit, Mac};
    use sha2::Sha256;
    type HmacSha256 = Hmac<Sha256>;
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key size");
    mac.update(format!("{channel_id}|{user_id}|{path}|{expires}").as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

// ---------------------------------------------------------------------------
// Optimistic concurrency (ETag / If-Match)
// ---------------------------------------------------------------------------

/// Normalize an ETag header value for comparison: strips `W/`, surrounding
/// quotes, and whitespace. Empty string means "file must not exist".
fn normalize_etag_header(value: &str) -> String {
    value
        .trim()
        .trim_start_matches("W/")
        .trim_matches('"')
        .to_string()
}

/// Evaluate an `If-Match` precondition against the current head etag.
///
/// - `None` → no precondition, always Ok.
/// - `Some("")` → create-only: the file must NOT exist.
/// - `Some(etag)` / `Some("*")` → the file's current etag must match.
///
/// Returns the current etag on success, or a 409 response on stale/absent.
fn check_if_match(
    if_match: Option<&str>,
    current: Option<String>,
) -> std::result::Result<Option<String>, axum::response::Response> {
    let Some(raw) = if_match else { return Ok(current) };
    let expected = normalize_etag_header(raw);
    if expected.is_empty() {
        // Create-only: an existing file is a conflict.
        if current.is_some() {
            return Err(conflict_response(current));
        }
        return Ok(current);
    }
    if expected == "*" {
        // Any existing version is fine, but the file must exist.
        if current.is_none() {
            return Err(conflict_response(None));
        }
        return Ok(current);
    }
    match &current {
        Some(c) if normalize_etag_header(c) == expected => Ok(current),
        _ => Err(conflict_response(current)),
    }
}

/// 409 Conflict body for optimistic-concurrency failures. Carries the current
/// etag so clients can diff/rebase against it.
fn conflict_response(current_etag: Option<String>) -> axum::response::Response {
    (
        axum::http::StatusCode::CONFLICT,
        Json(serde_json::json!({
            "error": "file changed on the server since your last read; re-fetch and reapply",
            "type": "StaleEtag",
            "currentEtag": current_etag,
        })),
    )
        .into_response()
}

/// Persist a lore commit + per-file change-feed entry. Both are best-effort
/// at the HTTP layer (the lore write itself already succeeded) but failures
/// are logged and surfaced via `wdbRecorded` in the response — never silent.
#[derive(Default)]
struct LoreWdbOutcome {
    commit_recorded: bool,
    change_cursor: u64,
}

#[allow(clippy::too_many_arguments)]
async fn record_lore_commit_and_change(
    state: &AppState,
    channel_id: i64,
    repo_name: &str,
    revision_hash: &str,
    path: &str,
    action: &str,
    etag: Option<&str>,
    message: &str,
    user_id: i64,
) -> LoreWdbOutcome {
    let mut out = LoreWdbOutcome::default();
    if let Err(e) = state
        .wdb
        .lore_commit(channel_id, revision_hash, repo_name, path, message, user_id)
        .await
    {
        warn!(channel_id, path, error = %e, "failed to record LoreCommit event");
    } else {
        out.commit_recorded = true;
    }
    match state
        .wdb
        .lore_file_change(channel_id, path, action, etag, revision_hash, user_id)
        .await
    {
        Ok(seq) => out.change_cursor = seq,
        Err(e) => warn!(channel_id, path, error = %e, "failed to append lore_file_change"),
    }
    out
}

/// Broadcast `lore:file-changed` to the channel's socket room (wire id).
/// Follows the retention-reaper pattern (state.sio handle, fire-and-forget).
async fn emit_lore_file_changed(state: &AppState, channel_id: i64, payload: serde_json::Value) {
    let room = format!("ch_{:x}", channel_id);
    let io = state.sio.read().await.clone();
    if let Some(io) = io {
        if let Err(e) = io.to(room).emit("lore:file-changed", &payload).await {
            warn!(channel_id, error = %e, "failed to emit lore:file-changed");
        }
    }
}

/// Workspace-role gates for Lore (L8).
/// Owner/Admin/Developer = full edit; Artist = asset-write only; Viewer = read-only.
async fn lore_role(state: &AppState, user_id: i64) -> Option<String> {
    state
        .wdb
        .get_user_role("default-workspace", user_id as u64)
        .await
        .ok()
        .flatten()
}

async fn can_edit_lore(state: &AppState, user_id: i64) -> bool {
    // Legacy gate preserved: commit OR manage-binding capability.
    can_lore(state, user_id, "lore.commit").await
        || can_lore(state, user_id, "lore.manage-binding").await
}

async fn can_asset_write_lore(state: &AppState, user_id: i64) -> bool {
    can_lore(state, user_id, "lore.stage").await
}

/// Granular Lore capabilities (spec 2026-08-28 P1.2), derived from workspace
/// roles. Phase 1 mapping (no per-channel override store yet — Phase 2):
///   owner/admin    → everything
///   developer      → view, stage, commit, approve, lock
///   artist         → view, stage, lock
///   viewer/member  → view
/// `may_write_lore` (connect-token scope) remains an orthogonal transport gate.
pub(crate) async fn can_lore(state: &AppState, user_id: i64, capability: &str) -> bool {
    const OWNER_ADMIN_CAPS: [&str; 7] = [
        "lore.view",
        "lore.stage",
        "lore.commit",
        "lore.approve",
        "lore.lock",
        "lore.manage-binding",
        "lore.admin",
    ];
    const DEVELOPER_CAPS: [&str; 5] = [
        "lore.view",
        "lore.stage",
        "lore.commit",
        "lore.approve",
        "lore.lock",
    ];
    const ARTIST_CAPS: [&str; 3] = ["lore.view", "lore.stage", "lore.lock"];

    if state.is_owner(user_id).await || state.is_admin(user_id).await {
        return OWNER_ADMIN_CAPS.contains(&capability);
    }
    match lore_role(state, user_id).await.map(|r| r.to_ascii_lowercase()) {
        Some(r) => match r.as_str() {
            "owner" | "admin" => OWNER_ADMIN_CAPS.contains(&capability),
            "developer" => DEVELOPER_CAPS.contains(&capability),
            "artist" => ARTIST_CAPS.contains(&capability),
            _ => capability == "lore.view",
        },
        None => capability == "lore.view",
    }
}

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        // Repo management
        .route("/repos", axum::routing::post(create_repo))
        .route("/repos/import", axum::routing::post(import_repo))
        .route("/repos/{channel_id}/link", axum::routing::post(link_repo))
        .route("/repos/{channel_id}", axum::routing::get(get_repo).patch(update_repo).delete(delete_repo))
        .route("/repos/{channel_id}/external", axum::routing::post(register_external_mirror))
        .route("/repos/{channel_id}/mirror/refresh", axum::routing::post(refresh_mirror_cache))
        .route("/repos/{channel_id}/snapshot", axum::routing::post(snapshot))
        // File operations
        .route("/repos/{channel_id}/files", axum::routing::get(list_files))
        .route("/repos/{channel_id}/files/{*path}", axum::routing::put(upload_file).get(download_file).delete(delete_file))
        // Sync protocol: one-call manifest + cursor-ordered change feed
        .route("/repos/{channel_id}/manifest", axum::routing::get(repo_manifest))
        .route("/repos/{channel_id}/changes", axum::routing::get(repo_changes))
        // Server-minted external-tool connect tokens (W6b, real this time)
        .route("/repos/{channel_id}/connect-tokens", axum::routing::post(mint_connect_token).get(list_connect_tokens))
        .route("/repos/{channel_id}/connect-tokens/{token_hash}", axum::routing::delete(revoke_connect_token))
        // File sub-operations — action-first paths avoid {*path} wildcard conflicts
        .route("/repos/{channel_id}/lock/{*path}", axum::routing::post(lock_file).delete(unlock_file))
        .route("/repos/{channel_id}/history/{*path}", axum::routing::get(file_level_history))
        .route("/repos/{channel_id}/diff/{*path}", axum::routing::get(file_diff))
        // L7: signed download URL mint (AuthUser + membership at mint time)
        .route("/repos/{channel_id}/signed-url", axum::routing::get(signed_download_url))
        // Repo history
        .route("/repos/{channel_id}/history", axum::routing::get(repo_history))
        // Branch operations
        .route("/repos/{channel_id}/branches", axum::routing::get(list_branches).post(create_branch))
        .route("/repos/{channel_id}/branches/{branch_name}/merge", axum::routing::post(merge_branch))
        // Artist-friendly review flow (auto_branch_on_upload)
        .route("/repos/{channel_id}/review/{branch_name}/approve", axum::routing::post(approve_review_branch))
        .route("/repos/{channel_id}/review/{branch_name}/reject", axum::routing::post(reject_review_branch))
        // Chat-channel → repo bindings
        .route("/binding/{channel_id}", axum::routing::get(get_binding).put(set_binding).delete(delete_binding))
        // Promote from chat
        .route("/promote/from-message", axum::routing::post(promote_from_message))
        .route("/promotes/{message_id}", axum::routing::get(promotes_for_message))
        // Health
        .route("/health", axum::routing::get(health_check))
        // Call recording upload (auto-resolves the configured Recordings channel)
        .route("/recordings", axum::routing::post(upload_recording))
        // P4: Editor bridge — ephemeral code-server sessions
        .route("/repos/{channel_id}/editor", axum::routing::post(start_editor_session).delete(stop_editor_session))
        .route("/repos/{channel_id}/editor/sessions", axum::routing::get(list_editor_sessions))
        // P5: Script collaboration — run scripts from the repo
        .route("/repos/{channel_id}/scripts/run", axum::routing::post(run_script))
        .route("/repos/{channel_id}/scripts/active", axum::routing::get(list_active_scripts))
        .route("/repos/{channel_id}/scripts/{script_id}/cancel", axum::routing::post(cancel_script))
        // P7: Off-box mirroring — publish to GitHub/GitLab/S3
        .route("/repos/{channel_id}/mirror", axum::routing::post(register_mirror).get(get_mirror_config).delete(remove_mirror))
        .route("/repos/{channel_id}/mirror/run", axum::routing::post(run_mirror))
        .route("/repos/{channel_id}/mirror/configs", axum::routing::get(list_mirror_configs))
        // Lore connect tokens carry scopes; mutating requests require "write".
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            lore_scope_guard,
        ))
        .with_state(state)
}

/// Middleware: read-only lore connect tokens (`Bearer wblore_…` minted with
/// scope "read") may perform GET/HEAD/OPTIONS only. Full user JWTs, bots,
/// and unauthenticated requests pass through untouched — handler-level auth
/// and role gates still apply.
async fn lore_scope_guard(
    State(state): State<Arc<AppState>>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let method = req.method().clone();
    if matches!(
        method,
        axum::http::Method::GET | axum::http::Method::HEAD | axum::http::Method::OPTIONS
    ) {
        return next.run(req).await;
    }
    use axum::extract::FromRequestParts;
    let (mut parts, body) = req.into_parts();
    let auth = AuthUser::from_request_parts(&mut parts, &state).await;
    let req = axum::extract::Request::from_parts(parts, body);
    match auth {
        Ok(auth) if auth.may_write_lore() => next.run(req).await,
        Ok(_) => (
            axum::http::StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "error": "this connect token is read-only",
                "type": "ReadOnlyToken",
            })),
        )
            .into_response(),
        Err(_) => next.run(req).await,
    }
}

async fn ensure_channel_member(
    state: &AppState,
    channel_id: i64,
    user_id: i64,
) -> Result<()> {
    let ch_str = format!("ch_{:x}", channel_id);
    let members = state.wdb.list_channel_members(&ch_str).await?;
    if !members.iter().any(|m| m.user_id == user_id as u64) {
        return Err(AppError::Forbidden(format!(
            "User {user_id} is not a member of channel {channel_id}"
        )));
    }
    Ok(())
}

async fn lore_service(state: &AppState) -> Result<Arc<wabi_lore::LoreService>> {
    state
        .lore_service
        .read()
        .await
        .clone()
        .ok_or_else(|| AppError::Internal("Lore addon not initialized".into()))
}

/// True when the channel's repo is a read-only external mirror.
async fn repo_read_only(lore: &Arc<wabi_lore::LoreService>, channel_id: i64) -> bool {
    match lore.get_repo(channel_id).await {
        Some(repo) => repo.read_only(),
        None => false,
    }
}

/// 501 response for write endpoints on read-only mirror repos.
fn mirror_read_only_response() -> axum::response::Response {
    (
        axum::http::StatusCode::NOT_IMPLEMENTED,
        Json(serde_json::json!({
            "error": "mirror repos are read-only via Wabi; browse upstream",
            "type": "MirrorReadOnly",
        })),
    )
        .into_response()
}

// -- Repo management --

async fn create_repo(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Json(payload): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>> {
    let channel_id = payload["channelId"].as_i64().unwrap_or(0);
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    // L8: repo management = Owner/Admin/Developer
    if !can_edit_lore(&state, auth.user_id).await {
        return Err(AppError::Forbidden("Lore repo operations require Owner/Admin/Developer role".into()));
    }
    let repo_name = payload["repoName"].as_str().unwrap_or("default");
    // Accept both casings — the frontend sends snake_case, which used to be
    // silently dropped here so the review-workflow toggle never applied on
    // repo creation (audit P0).
    let auto_branch = payload["autoBranchOnUpload"]
        .as_bool()
        .or_else(|| payload["auto_branch_on_upload"].as_bool())
        .unwrap_or(false);

    let lore = lore_service(&state).await?;
    let repo = lore
        .create_repo(channel_id, auth.user_id, repo_name)
        .await?;

    if auto_branch {
        lore.set_auto_branch_on_upload(channel_id, true).await?;
    }

    state
        .wdb
        .lore_create_repo(channel_id, repo_name, &repo.lore_server_url, auth.user_id)
        .await?;

    info!(?repo.id, channel_id, repo_name, "Lore repo created via API");
    Ok(Json(serde_json::json!(repo)))
}

/// Link an EXISTING Lore repo to a channel (clone, not create).
async fn link_repo(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(payload): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    // L8: repo management = Owner/Admin/Developer
    if !can_edit_lore(&state, auth.user_id).await {
        return Err(AppError::Forbidden(
            "Lore repo operations require Owner/Admin/Developer role".into(),
        ));
    }
    let repo_name = payload["repoName"].as_str().unwrap_or("default");

    let lore = lore_service(&state).await?;
    // Embedded mode runs offline with no server to clone an existing repo from.
    if matches!(lore.mode(), wabi_lore::LoreMode::Embedded) {
        return Err(AppError::BadRequest(
            "linking an existing lore repo requires sidecar or remote mode".into(),
        ));
    }
    let repo = lore
        .link_repo(channel_id, auth.user_id, repo_name)
        .await?;

    state
        .wdb
        .lore_create_repo(channel_id, repo_name, &repo.lore_server_url, auth.user_id)
        .await?;

    info!(?repo.id, channel_id, repo_name, "Existing Lore repo linked via API");
    Ok(Json(serde_json::json!(repo)))
}

async fn get_repo(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    let lore = lore_service(&state).await?;
    match lore.get_repo(channel_id).await {
        Some(repo) => Ok(Json(serde_json::json!(repo))),
        None => Err(AppError::NotFound("No Lore repo for this channel".into())),
    }
}

/// DELETE /repos/{channel_id}?mode=detach|delete
/// - `delete` (default): remove the working tree AND every byte — permanent.
/// - `detach`: unlink the channel binding only; files/history stay on disk
///   under the lore data dir so the space can be re-linked later.
#[derive(Deserialize)]
struct DeleteRepoQuery {
    mode: Option<String>,
}

async fn delete_repo(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Query(query): Query<DeleteRepoQuery>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    // L8: repo management = Owner/Admin/Developer
    if !can_edit_lore(&state, auth.user_id).await {
        return Err(AppError::Forbidden("Lore repo operations require Owner/Admin/Developer role".into()));
    }
    let lore = lore_service(&state).await?;

    if query.mode.as_deref() == Some("detach") {
        // Drop the channel binding only. The orphaned tree remains on disk;
        // create_repo adopts an existing working tree, so re-linking the
        // same channel picks it back up with history intact.
        state.wdb.lore_delete_repo(channel_id, auth.user_id).await?;
        info!(channel_id, "Lore repo detached via API (working tree kept)");
        return Ok(Json(serde_json::json!({ "status": "ok", "mode": "detached" })));
    }

    lore.delete_repo(channel_id).await?;

    state
        .wdb
        .lore_delete_repo(channel_id, auth.user_id)
        .await?;

    info!(channel_id, "Lore repo deleted via API");
    Ok(Json(serde_json::json!({ "status": "ok", "mode": "deleted" })))
}

/// PATCH /repos/{channel_id} — update per-repo settings.
#[derive(Deserialize)]
struct UpdateRepoPayload {
    auto_branch_on_upload: Option<bool>,
}

async fn update_repo(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(payload): Json<UpdateRepoPayload>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    if !can_edit_lore(&state, auth.user_id).await {
        return Err(AppError::Forbidden("Lore repo operations require Owner/Admin/Developer role".into()));
    }
    let lore = lore_service(&state).await?;
    if let Some(enabled) = payload.auto_branch_on_upload {
        lore.set_auto_branch_on_upload(channel_id, enabled).await?;
    }
    let repo = lore
        .get_repo(channel_id)
        .await
        .ok_or_else(|| AppError::NotFound("No Lore repo for this channel".into()))?;
    Ok(Json(serde_json::json!(repo)))
}

// ---------------------------------------------------------------------------
// Channel Lore bindings — chat-channel → repo path "pipe" (spec 2026-08-28 P1.1)
// ---------------------------------------------------------------------------

const LORE_BINDING_MODES: [&str; 4] = ["none", "direct", "stage", "hybrid"];

fn now_micros() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_micros() as i64)
        .unwrap_or(0)
}

/// GET /binding/{channel_id} — the channel's binding, or `{ "binding": null }`.
async fn get_binding(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    let binding = state.wdb.lore_get_binding(channel_id).await?;
    Ok(Json(serde_json::json!({ "binding": binding })))
}

/// PUT /binding/{channel_id} — create or replace the channel's binding.
#[derive(Deserialize)]
struct SetBindingPayload {
    repo_channel_id: i64,
    path: String,
    branch: Option<String>,
    mode: String,
    #[serde(default)]
    allowed_types: Vec<String>,
    #[serde(default)]
    auto_stage: bool,
}

async fn set_binding(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(payload): Json<SetBindingPayload>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    if !can_lore(&state, auth.user_id, "lore.manage-binding").await {
        return Err(AppError::Forbidden(
            "Managing Lore bindings requires the lore.manage-binding capability".into(),
        ));
    }
    let mode = payload.mode.to_lowercase();
    if !LORE_BINDING_MODES.contains(&mode.as_str()) {
        return Err(AppError::BadRequest(format!(
            "Invalid binding mode '{}': expected one of none|direct|stage|hybrid",
            payload.mode
        )));
    }
    let path = payload.path.trim().to_string();
    if !path.starts_with('/') || path.contains("..") {
        return Err(AppError::BadRequest(
            "Binding path must be absolute within the repo (start with '/') and contain no '..'".into(),
        ));
    }
    // The target repo must actually be registered (and the setter must be able to see it).
    ensure_channel_member(&state, payload.repo_channel_id, auth.user_id).await?;
    if state.wdb.lore_get_repo(payload.repo_channel_id).await?.is_none() {
        return Err(AppError::NotFound(format!(
            "Channel {} has no Lore repo to bind to",
            payload.repo_channel_id
        )));
    }

    let record = wabidb::projections::lore::LoreBindingRecord {
        channel_id,
        repo_channel_id: payload.repo_channel_id,
        path,
        branch: payload.branch.unwrap_or_else(|| "main".into()),
        mode,
        allowed_types: payload.allowed_types,
        auto_stage: payload.auto_stage,
        updated_by: auth.user_id,
        updated_at_micros: now_micros(),
    };
    state.wdb.lore_set_binding(&record).await?;
    info!(channel_id, repo_channel_id = record.repo_channel_id, "Lore binding set via API");
    Ok(Json(serde_json::json!(record)))
}

/// DELETE /binding/{channel_id}
async fn delete_binding(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    if !can_lore(&state, auth.user_id, "lore.manage-binding").await {
        return Err(AppError::Forbidden(
            "Managing Lore bindings requires the lore.manage-binding capability".into(),
        ));
    }
    if state.wdb.lore_get_binding(channel_id).await?.is_none() {
        return Err(AppError::NotFound("No Lore binding for this channel".into()));
    }
    state.wdb.lore_remove_binding(channel_id, auth.user_id).await?;
    info!(channel_id, "Lore binding removed via API");
    Ok(Json(serde_json::json!({ "status": "ok" })))
}

// ---------------------------------------------------------------------------
// Promote from chat (spec 2026-08-28 P1.3)
// ---------------------------------------------------------------------------

/// MIME-group → common extensions, for `allowed_types` entries like `image/*`.
fn mime_group_extensions(group: &str) -> &'static [&'static str] {
    match group {
        "image" => &["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "tiff"],
        "video" => &["mp4", "webm", "mov", "mkv", "avi"],
        "audio" => &["mp3", "wav", "ogg", "flac", "aac", "m4a"],
        "text" => &["txt", "md", "json", "csv", "xml", "yml", "yaml"],
        _ => &[],
    }
}

/// True when `file_name`'s extension matches the binding's allowed-types list.
/// Empty list = everything allowed. Entries may be `group/*`, `.ext`, or `ext`.
fn attachment_allowed(file_name: &str, allowed: &[String]) -> bool {
    if allowed.is_empty() {
        return true;
    }
    let ext = file_name
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    allowed.iter().any(|entry| {
        let entry = entry.trim().to_ascii_lowercase();
        if let Some(group) = entry.strip_suffix("/*") {
            return mime_group_extensions(group).contains(&ext.as_str());
        }
        let wanted = entry.strip_prefix('.').unwrap_or(&entry);
        !ext.is_empty() && ext == wanted
    })
}

/// POST /promote/from-message — promote a chat attachment into a Lore repo.
#[derive(Deserialize)]
struct PromoteFromMessagePayload {
    message_id: String,
    /// The attachment's `file_url` as it appears on the message.
    file_url: String,
    /// Overrides when the channel has no binding (or to deviate from it).
    #[serde(default)]
    repo_channel_id: Option<i64>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    branch: Option<String>,
    /// "direct" | "stage" — overrides the binding mode for this promote.
    #[serde(default)]
    mode: Option<String>,
    /// Set to "overwrite" to confirm a collision prompt (new revision).
    #[serde(default)]
    collision: Option<String>,
}

async fn promote_from_message(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Json(payload): Json<PromoteFromMessagePayload>,
) -> Result<Json<serde_json::Value>> {
    let message = state
        .wdb
        .get_message_typed(&payload.message_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Message {} not found", payload.message_id)))?;
    // Channel ids are "ch_{seq:x}" strings; lore addressing is numeric.
    let channel_id: i64 = message
        .channel_id
        .strip_prefix("ch_")
        .and_then(|h| i64::from_str_radix(h, 16).ok())
        .ok_or_else(|| {
            AppError::BadRequest(format!("Message channel {} is not Lore-bindable", message.channel_id))
        })?;
    ensure_channel_member(&state, channel_id, auth.user_id).await?;

    let attachment = message
        .files
        .iter()
        .find(|f| f.file_url == payload.file_url)
        .ok_or_else(|| {
            AppError::NotFound(format!(
                "Message {} has no attachment {}",
                payload.message_id, payload.file_url
            ))
        })?;

    let binding = state.wdb.lore_get_binding(channel_id).await?;
    let repo_channel_id = payload
        .repo_channel_id
        .or_else(|| binding.as_ref().map(|b| b.repo_channel_id))
        .ok_or_else(|| {
            AppError::BadRequest(
                "This channel has no Lore binding; provide repo_channel_id/path/branch explicitly"
                    .into(),
            )
        })?;
    let base_path = payload
        .path
        .clone()
        .or_else(|| binding.as_ref().map(|b| b.path.clone()))
        .unwrap_or_else(|| "/".into());
    let target_path = format!(
        "{}/{}",
        base_path.trim_end_matches('/'),
        attachment.file_name.replace(['/', '\\', '\0'], "_")
    );
    if target_path.contains("..") {
        return Err(AppError::BadRequest("Invalid target path".into()));
    }
    let branch = payload
        .branch
        .clone()
        .or_else(|| binding.as_ref().map(|b| b.branch.clone()))
        .unwrap_or_else(|| "main".into());

    // Capability + binding type gate (mode "none" allows only explicit promotes,
    // which this always is — the context-menu action — so "none" never blocks here).
    let can_commit = can_lore(&state, auth.user_id, "lore.commit").await;
    let can_stage = can_lore(&state, auth.user_id, "lore.stage").await;
    if !can_commit && !can_stage {
        return Err(AppError::Forbidden(
            "Promoting to Lore requires the lore.stage or lore.commit capability".into(),
        ));
    }
    if let Some(b) = &binding {
        if !attachment_allowed(&attachment.file_name, &b.allowed_types) {
            return Err(AppError::BadRequest(format!(
                "This channel's Lore binding only accepts [{}]; '{}' was not promoted",
                b.allowed_types.join(", "),
                attachment.file_name
            )));
        }
    }

    // Resolve mode: explicit override > binding mode; hybrid splits on capability.
    let mode = payload
        .mode
        .as_deref()
        .map(str::to_lowercase)
        .or_else(|| binding.as_ref().map(|b| b.mode.clone()))
        .unwrap_or_else(|| "direct".into());
    let mode = match mode.as_str() {
        "stage" => "stage".to_string(),
        "hybrid" if !can_commit => "stage".to_string(),
        _ => "direct".to_string(),
    };

    let lore = lore_service(&state).await?;
    if repo_read_only(&lore, repo_channel_id).await {
        return Err(AppError::Forbidden("Target repo is a read-only mirror".into()));
    }

    // Collision guard (spec D2): the engine's upload_file overwrites silently,
    // so we check the working tree first and force an explicit choice.
    let rel = target_path.trim_start_matches('/');
    if payload.collision.as_deref() != Some("overwrite") {
        if let Some(tree) = lore.repo_working_tree(repo_channel_id).await {
            if tree.join(rel).exists() {
                return Ok(Json(serde_json::json!({
                    "collision": true,
                    "path": target_path,
                    "message_id": payload.message_id,
                    "file_url": payload.file_url,
                    "options": ["overwrite", "rename", "cancel"]
                })));
            }
        }
    }

    // Local bytes: /uploads/{filename} on disk.
    let filename = attachment
        .file_url
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_string();
    if filename.is_empty() || filename.contains("..") {
        return Err(AppError::BadRequest("Invalid attachment URL".into()));
    }
    let uploads_dir = std::path::PathBuf::from(&state.config.uploads_dir);
    let local_path = uploads_dir.join(&filename);
    if !local_path.exists() {
        return Err(AppError::NotFound(format!(
            "Attachment bytes for {} are no longer on disk",
            attachment.file_url
        )));
    }

    // Provenance goes in the commit message: the lore engine has no KV metadata
    // and drops author_id (spike S1), so this string + the WabiDB promote event
    // are the durable record.
    let commit_message = format!(
        "Promoted from channel {} by user {}: {} (msg:{})",
        channel_id, auth.user_id, attachment.file_name, payload.message_id
    );

    let (result, pending_review, review_branch) = if mode == "stage" {
        // Review-gated: commit on a dedicated branch; a reviewer merges via the
        // existing approve_review_branch flow.
        let branch_name = format!(
            "chat/u{}-{}",
            auth.user_id,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0)
        );
        lore.create_branch(repo_channel_id, &branch_name, None).await?;
        lore.switch_branch(repo_channel_id, &branch_name).await?;
        let result = lore
            .upload_file(
                repo_channel_id,
                local_path.to_str().unwrap_or_default(),
                &target_path,
                &commit_message,
                auth.user_id,
            )
            .await?;
        (result, true, Some(branch_name))
    } else {
        if branch != "main" {
            lore.switch_branch(repo_channel_id, &branch).await?;
        }
        let result = lore
            .upload_file(
                repo_channel_id,
                local_path.to_str().unwrap_or_default(),
                &target_path,
                &commit_message,
                auth.user_id,
            )
            .await?;
        if branch != "main" {
            lore.switch_branch(repo_channel_id, "main").await?;
        }
        (result, false, None)
    };

    let record = wabidb::projections::lore::LorePromoteRecord {
        message_id: payload.message_id.clone(),
        channel_id,
        repo_channel_id,
        file_url: attachment.file_url.clone(),
        file_name: attachment.file_name.clone(),
        path: target_path.clone(),
        branch: review_branch.clone().unwrap_or_else(|| branch.clone()),
        mode: mode.clone(),
        revision_hash: result.revision.hash.clone(),
        pending_review,
        review_branch: review_branch.clone(),
        promoted_by: auth.user_id,
        timestamp_micros: now_micros(),
    };
    state.wdb.lore_record_promote(&record).await?;

    // Audit system message in the origin channel. `^c/` renders as a citation
    // chip with drift detection in the existing frontend.
    let short_rev = &result.revision.hash[..result.revision.hash.len().min(7)];
    let system_content = if pending_review {
        format!(
            "📋 Staged `{}` for review → ^c{} (branch {}, rev {})",
            attachment.file_name, target_path, review_branch.clone().unwrap_or_default(), short_rev
        )
    } else {
        format!(
            "📦 Promoted `{}` → ^c{} (rev {})",
            attachment.file_name, target_path, short_rev
        )
    };
    state
        .wdb
        .send_message(&message.channel_id, auth.user_id as u64, &system_content, false, &[])
        .await?;

    info!(channel_id, repo_channel_id, path = %target_path, pending_review, "Attachment promoted to Lore from chat");
    Ok(Json(serde_json::json!({
        "revision": result.revision,
        "path": target_path,
        "branch": record.branch,
        "mode": mode,
        "pending_review": pending_review,
        "review_branch": review_branch,
        "file": result.file_info,
    })))
}

/// GET /promotes/{message_id} — promote state for a message's attachments
/// (drives the committed/staged badge).
async fn promotes_for_message(
    State(state): State<Arc<AppState>>,
    auth: OptionalAuthUser,
    Path(message_id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    let Some(auth) = auth.0 else {
        return Err(AppError::Unauthorized("Authentication required".into()));
    };
    let promotes = state.wdb.lore_promotes_for_message(&message_id).await?;
    if let Some(first) = promotes.first() {
        ensure_channel_member(&state, first.channel_id, auth.user_id).await?;
    }
    Ok(Json(serde_json::json!({ "promotes": promotes })))
}

/// POST /repos/{channel_id}/external — register a read-only external mirror.
/// Registers a pointer only; no bytes are cloned until the first read.
#[derive(Deserialize)]
struct ExternalMirrorPayload {
    upstream_url: String,
    name: String,
}

async fn register_external_mirror(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(payload): Json<ExternalMirrorPayload>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    if !can_edit_lore(&state, auth.user_id).await {
        return Err(AppError::Forbidden("Lore repo operations require Owner/Admin/Developer role".into()));
    }
    let lore = lore_service(&state).await?;
    let repo = lore
        .register_external_mirror(channel_id, auth.user_id, &payload.name, &payload.upstream_url)
        .await?;

    state
        .wdb
        .lore_create_repo(channel_id, &payload.name, &repo.lore_server_url, auth.user_id)
        .await?;

    info!(channel_id, upstream = %payload.upstream_url, "External mirror repo registered via API");
    Ok(Json(serde_json::json!(repo)))
}

/// POST /repos/{channel_id}/mirror/refresh — invalidate the mirror fetch cache
/// so the next read re-fetches from upstream. Used as the webhook receiver.
async fn refresh_mirror_cache(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    if !can_edit_lore(&state, auth.user_id).await {
        return Err(AppError::Forbidden("Lore repo operations require Owner/Admin/Developer role".into()));
    }
    let lore = lore_service(&state).await?;
    lore.refresh_mirror_cache(channel_id).await?;
    info!(channel_id, "Mirror cache refreshed via API/webhook");
    Ok(Json(serde_json::json!({ "status": "ok", "refreshed": true })))
}

/// POST /repos/import — files-only git import into a new native Lore repo.
#[derive(Deserialize)]
struct ImportRepoPayload {
    channel_id: i64,
    upstream_url: String,
    name: String,
}

#[allow(dead_code)]
async fn _probe_import_sig(
    State(_s): State<Arc<AppState>>,
    _a: AuthUser,
    Json(_p): Json<ImportRepoPayload>,
) -> Result<axum::response::Response> {
    Ok(axum::response::Response::default())
}

async fn import_repo(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Json(payload): Json<ImportRepoPayload>,
) -> Result<axum::response::Response> {
    ensure_channel_member(&state, payload.channel_id, auth.user_id).await?;
    if !can_edit_lore(&state, auth.user_id).await {
        return Err(AppError::Forbidden("Lore repo operations require Owner/Admin/Developer role".into()));
    }
    let lore = lore_service(&state).await?;
    match lore
        .import_from_git(
            payload.channel_id,
            auth.user_id,
            &payload.name,
            &payload.upstream_url,
        )
        .await
    {
        Ok(repo) => {
            state
                .wdb
                .lore_create_repo(
                    payload.channel_id,
                    &payload.name,
                    &repo.lore_server_url,
                    auth.user_id,
                )
                .await?;
            info!(channel_id = payload.channel_id, upstream = %payload.upstream_url, "Git repo imported via API");
            Ok(Json(serde_json::json!(repo)).into_response())
        }
        Err(wabi_lore::LoreImportError::RepoExists) => Ok((
            axum::http::StatusCode::CONFLICT,
            Json(serde_json::json!({ "error": "a Lore repo already exists for this channel" })),
        )
            .into_response()),
        Err(wabi_lore::LoreImportError::CloneFailed(stderr)) => Ok((
            axum::http::StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({ "error": stderr })),
        )
            .into_response()),
        Err(wabi_lore::LoreImportError::Other(e)) => Err(e.into()),
    }
}

#[derive(Deserialize)]
struct SnapshotPayload {
    message: String,
}

async fn snapshot(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(payload): Json<SnapshotPayload>,
) -> Result<axum::response::Response> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    // L8: commits = Owner/Admin/Developer
    if !can_edit_lore(&state, auth.user_id).await {
        return Err(AppError::Forbidden("Lore commits require Owner/Admin/Developer role".into()));
    }
    let lore = lore_service(&state).await?;
    if repo_read_only(&lore, channel_id).await {
        return Ok(mirror_read_only_response());
    }
    let revision = lore.commit_staged(channel_id, &payload.message, auth.user_id).await?;

    let mut wdb_recorded = false;
    let mut cursor = 0u64;
    if let Some(repo) = lore.get_repo(channel_id).await {
        let outcome = record_lore_commit_and_change(
            &state,
            channel_id,
            &repo.repo_name,
            &revision.hash,
            "*snapshot",
            "snapshot",
            None,
            &payload.message,
            auth.user_id,
        )
        .await;
        wdb_recorded = outcome.commit_recorded;
        cursor = outcome.change_cursor;
    }

    emit_lore_file_changed(
        &state,
        channel_id,
        serde_json::json!({
            "action": "snapshot",
            "path": "*snapshot",
            "revision": revision.hash,
            "authorUserId": auth.user_id,
            "cursor": cursor,
        }),
    )
    .await;

    Ok(Json(serde_json::json!({
        "revision": revision,
        "wdbRecorded": wdb_recorded,
        "cursor": cursor,
    })).into_response())
}

// -- File operations --

#[derive(Deserialize)]
struct ListFilesQuery {
    prefix: Option<String>,
}

async fn list_files(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Query(query): Query<ListFilesQuery>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    let lore = lore_service(&state).await?;
    let files = lore.list_files(channel_id, query.prefix.as_deref()).await?;
    Ok(Json(serde_json::json!(files)))
}

// -- Sync protocol: manifest + change feed --

/// GET /repos/{channel_id}/manifest — one call with everything a sync client
/// needs to diff its local state against the repo: file list with etags plus
/// the head lore revision.
async fn repo_manifest(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    let lore = lore_service(&state).await?;
    let files = lore.list_files(channel_id, None).await?;
    let head_revision = state
        .wdb
        .list_lore_commits(channel_id)
        .await
        .unwrap_or_default()
        .last()
        .map(|c| c.commit_hash.clone())
        .unwrap_or_default();
    Ok(Json(serde_json::json!({
        "channelId": channel_id,
        "files": files,
        "headRevision": head_revision,
        "readOnly": repo_read_only(&lore, channel_id).await,
    })))
}

#[derive(Deserialize)]
struct ChangesQuery {
    since: Option<u64>,
    /// Cap on returned entries (sync clients page through the feed).
    limit: Option<usize>,
}

/// GET /repos/{channel_id}/changes?since=<cursor> — cursor-ordered per-file
/// change feed. `since` is the commit_seq of the last change the client saw.
async fn repo_changes(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Query(query): Query<ChangesQuery>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    let since = query.since.unwrap_or(0);
    let changes = state.wdb.list_lore_file_changes(channel_id, since).await?;
    let latest = changes.last().map(|c| c.seq).unwrap_or(since);
    let changes: Vec<serde_json::Value> = changes
        .into_iter()
        .take(query.limit.unwrap_or(1000))
        .map(|c| {
            serde_json::json!({
                "seq": c.seq,
                "path": c.path,
                "action": c.action,
                "etag": c.etag,
                "revision": c.revision,
                "authorUserId": c.author_user_id,
                "timestampMicros": c.timestamp_micros,
            })
        })
        .collect();
    Ok(Json(serde_json::json!({
        "channelId": channel_id,
        "since": since,
        "latestSeq": latest,
        "changes": changes,
    })))
}

// -- Connect tokens (server-minted, hashed at rest) --

#[derive(Deserialize)]
struct MintTokenPayload {
    /// "read" (default) or "write" (= read + write).
    scopes: Option<String>,
}

/// POST /repos/{channel_id}/connect-tokens — mint an opaque token for
/// external tools (wabi-sync, editor scripts). Only the SHA-256 is stored;
/// the plaintext is returned exactly once.
async fn mint_connect_token(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(payload): Json<MintTokenPayload>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    if !can_asset_write_lore(&state, auth.user_id).await {
        return Err(AppError::Forbidden("Connect tokens require at least Artist role".into()));
    }
    // Normalize scopes: anything containing "write" gets read+write; else read.
    let scopes = match payload.scopes.as_deref() {
        Some(s) if s.to_ascii_lowercase().contains("write") => "read,write",
        _ => "read",
    };

    use rand::Rng;
    let secret: [u8; 32] = rand::thread_rng().gen();
    let token = format!("wblore_{}", hex::encode(secret));
    let token_hash = sha256_hex(token.as_bytes());

    state
        .wdb
        .lore_mint_token(&token_hash, channel_id, auth.user_id, scopes)
        .await?;

    info!(channel_id, user_id = auth.user_id, scopes, "Lore connect token minted");
    Ok(Json(serde_json::json!({
        // Plaintext — shown once, never stored.
        "token": token,
        "tokenHashPrefix": &token_hash[..12],
        "scopes": scopes,
        "channelId": channel_id,
    })))
}

/// GET /repos/{channel_id}/connect-tokens — list active tokens (hashes only).
async fn list_connect_tokens(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    if !can_asset_write_lore(&state, auth.user_id).await {
        return Err(AppError::Forbidden("Connect token management requires at least Artist role".into()));
    }
    let tokens = state
        .wdb
        .list_lore_tokens(channel_id)
        .await
        .unwrap_or_default();
    let tokens: Vec<serde_json::Value> = tokens
        .into_iter()
        .map(|t| {
            serde_json::json!({
                "tokenHashPrefix": &t.token_hash[..t.token_hash.len().min(12)],
                "scopes": t.scopes,
                "userId": t.user_id,
                "createdAtMicros": t.created_at_micros,
            })
        })
        .collect();
    Ok(Json(serde_json::json!({ "tokens": tokens })))
}

/// DELETE /repos/{channel_id}/connect-tokens/{token_hash} — revoke by hash.
async fn revoke_connect_token(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((channel_id, token_hash)): Path<(i64, String)>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    if !can_asset_write_lore(&state, auth.user_id).await {
        return Err(AppError::Forbidden("Connect token management requires at least Artist role".into()));
    }
    // Only revoke tokens that belong to this channel.
    match state.wdb.lore_get_token(&token_hash).await? {
        Some(record) if record.channel_id == channel_id => {
            state.wdb.lore_revoke_token(&token_hash, auth.user_id).await?;
            info!(channel_id, user_id = auth.user_id, "Lore connect token revoked");
            Ok(Json(serde_json::json!({ "status": "ok" })))
        }
        _ => Err(AppError::NotFound("No such token for this channel".into())),
    }
}

/// SHA-256 hex of arbitrary bytes (token hashing at mint + auth time).
fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(bytes))
}

#[derive(Deserialize)]
struct UploadQuery {
    message: Option<String>,
    repo_path: Option<String>,
    /// Stage the file WITHOUT committing — batch pushes (folder imports,
    /// wabi-sync initial sync) stage N files, then seal them with a single
    /// POST /snapshot so the repo gains ONE revision instead of N.
    #[serde(default, alias = "stageOnly")]
    stage_only: Option<bool>,
}

async fn upload_file(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((channel_id, path)): Path<(i64, String)>,
    Query(query): Query<UploadQuery>,
    headers: axum::http::HeaderMap,
    body: axum::body::Bytes,
) -> Result<axum::response::Response> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    // L8: asset writes = Owner/Admin/Developer/Artist
    if !can_asset_write_lore(&state, auth.user_id).await {
        return Err(AppError::Forbidden("Lore asset uploads require at least Artist role".into()));
    }
    let message = query.message.unwrap_or_else(|| "Upload via API".into());
    let repo_path = query.repo_path.unwrap_or_else(|| path.clone());

    let lore = lore_service(&state).await?;
    // Mirror repos are read-only pointers — reject uploads with 501.
    if repo_read_only(&lore, channel_id).await {
        return Ok(mirror_read_only_response());
    }

    // Enforce the configured per-file size cap (WABI_LORE_MAX_BLOB_MB).
    let max_bytes = lore.blob_max_size_bytes();
    if body.len() as u64 > max_bytes {
        return Ok((
            axum::http::StatusCode::PAYLOAD_TOO_LARGE,
            Json(serde_json::json!({
                "error": format!("file exceeds lore blob limit of {} MB", max_bytes / 1024 / 1024),
                "type": "BlobTooLarge",
            })),
        )
            .into_response());
    }

    // Optimistic concurrency: only when the client sent an If-Match. Without
    // a precondition the head-etag fetch is skipped entirely — it syncs the
    // repo (a per-file round-trip in sidecar mode) and could fail requests
    // that never opted into conflict checking (folder uploads, recordings,
    // plain sync pushes).
    let if_match = headers
        .get(axum::http::header::IF_MATCH)
        .and_then(|v| v.to_str().ok());
    if if_match.is_some() {
        if let Err(conflict) =
            check_if_match(if_match, lore.head_etag(channel_id, &repo_path).await?)
        {
            return Ok(conflict);
        }
    }

    let tmp_dir = std::env::temp_dir();
    let tmp_path = tmp_dir.join(format!("lore-upload-{}", uuid::Uuid::new_v4()));
    tokio::fs::write(&tmp_path, &body).await?;

    // Batch-push half of the device setup flow: stage the bytes now, seal the
    // whole batch with ONE POST /snapshot afterwards. Per-file WDB commit
    // recording is deferred to that snapshot (which owns the revision hash).
    if query.stage_only.unwrap_or(false) {
        let file = lore
            .stage_file(channel_id, tmp_path.to_str().unwrap_or("/dev/null"), &repo_path)
            .await?;
        let _ = tokio::fs::remove_file(&tmp_path).await;
        let etag = file
            .etag
            .clone()
            .unwrap_or_else(|| wabi_lore::etag_for_bytes(&body));
        emit_lore_file_changed(
            &state,
            channel_id,
            serde_json::json!({
                "action": "staged",
                "path": repo_path,
                "etag": etag,
                "authorUserId": auth.user_id,
                "cursor": 0,
            }),
        )
        .await;
        return Ok(Json(serde_json::json!({
            "staged": true,
            "file": file,
            "etag": etag,
            "wdbRecorded": false,
            "cursor": 0,
        }))
            .into_response());
    }

    let result = lore
        .upload_file(channel_id, tmp_path.to_str().unwrap_or("/dev/null"), &repo_path, &message, auth.user_id)
        .await?;

    let _ = tokio::fs::remove_file(&tmp_path).await;

    let etag = wabi_lore::etag_for_bytes(&body);
    let mut wdb_recorded = false;
    let mut cursor = 0u64;
    if let Some(repo) = lore.get_repo(channel_id).await {
        let outcome = record_lore_commit_and_change(
            &state,
            channel_id,
            &repo.repo_name,
            &result.revision.hash,
            &repo_path,
            "upload",
            Some(&etag),
            &message,
            auth.user_id,
        )
        .await;
        wdb_recorded = outcome.commit_recorded;
        cursor = outcome.change_cursor;
    }

    emit_lore_file_changed(
        &state,
        channel_id,
        serde_json::json!({
            "action": "upload",
            "path": repo_path,
            "etag": etag,
            "revision": result.revision.hash,
            "authorUserId": auth.user_id,
            "pendingReview": result.pending_review,
            "reviewBranch": result.review_branch,
            "cursor": cursor,
        }),
    )
    .await;

    Ok(Json(serde_json::json!({
        "revision": result.revision,
        "file": result.file_info,
        "etag": etag,
        "pendingReview": result.pending_review,
        "reviewBranch": result.review_branch,
        "wdbRecorded": wdb_recorded,
        "cursor": cursor,
    })).into_response())
}

/// Query parameters for [`upload_recording`].
#[derive(Debug, Deserialize)]
struct UploadRecordingQuery {
    /// Commit message recorded in the Lore repo.
    message: Option<String>,
    /// Destination file name within the channel's `recordings/` folder.
    filename: Option<String>,
}

/// Upload a finished call recording to the configured "Recordings" Asset Storage
/// channel.
///
/// The target channel is resolved by name from `LoreConfig.recordings_channel_name`
/// (default "Recordings"). If no such channel exists, the request 404s — the
/// operator is expected to create the channel once. The raw request body is the
/// file bytes (`application/octet-stream`), mirroring [`upload_file`].
async fn upload_recording(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Query(query): Query<UploadRecordingQuery>,
    body: axum::body::Bytes,
) -> Result<axum::response::Response> {
    let lore = lore_service(&state).await?;
    let channel_name = lore.recordings_channel_name().to_string();

    // Resolve the Recordings channel by name.
    let channels = state.wdb.get_channels_raw().await?;
    let channel = channels
        .iter()
        .find(|c| c.get("name").and_then(|v| v.as_str()) == Some(channel_name.as_str()))
        .ok_or_else(|| {
            AppError::NotFound(format!("Recordings channel '{channel_name}' not found"))
        })?;

    let channel_id_str = channel
        .get("channel_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::Internal("Recordings channel missing id".into()))?;
    let lore_channel_id = channel_id_str
        .strip_prefix("ch_")
        .and_then(|hex| i64::from_str_radix(hex, 16).ok())
        .ok_or_else(|| {
            AppError::Internal(format!("Invalid Recordings channel id {channel_id_str}"))
        })?;

    ensure_channel_member(&state, lore_channel_id, auth.user_id).await?;

    // The resolved channel must actually be a Lore-backed Asset Storage
    // channel. If a non-asset-storage channel happens to share the name, or its
    // repo was never created, fail cleanly with 404 rather than an opaque
    // internal error from the upload path.
    if lore.get_repo(lore_channel_id).await.is_none() {
        return Err(AppError::NotFound(format!(
            "Recordings channel '{channel_name}' is not an Asset Storage channel with a Lore repo"
        )));
    }

    // Mirror repos are read-only pointers — reject uploads with 501.
    if repo_read_only(&lore, lore_channel_id).await {
        return Ok(mirror_read_only_response());
    }

    let filename = query
        .filename
        .unwrap_or_else(|| format!("recording-{}.webm", uuid::Uuid::new_v4()));
    let repo_path = format!("recordings/{filename}");
    let message = query
        .message
        .unwrap_or_else(|| format!("Call recording {filename}"));

    let tmp_dir = std::env::temp_dir();
    let tmp_path = tmp_dir.join(format!("lore-recording-{}", uuid::Uuid::new_v4()));
    tokio::fs::write(&tmp_path, &body).await?;

    let result = lore
        .upload_file(
            lore_channel_id,
            tmp_path.to_str().unwrap_or("/dev/null"),
            &repo_path,
            &message,
            auth.user_id,
        )
        .await?;
    let (revision, file_info) = (result.revision, result.file_info);

    let _ = tokio::fs::remove_file(&tmp_path).await;

    let etag = wabi_lore::etag_for_bytes(&body);
    let mut wdb_recorded = false;
    if let Some(repo) = lore.get_repo(lore_channel_id).await {
        let outcome = record_lore_commit_and_change(
            &state,
            lore_channel_id,
            &repo.repo_name,
            &revision.hash,
            &repo_path,
            "upload",
            Some(&etag),
            &message,
            auth.user_id,
        )
        .await;
        wdb_recorded = outcome.commit_recorded;
    }

    emit_lore_file_changed(
        &state,
        lore_channel_id,
        serde_json::json!({
            "action": "upload",
            "path": repo_path,
            "etag": etag,
            "revision": revision.hash,
            "authorUserId": auth.user_id,
        }),
    )
    .await;

    Ok(Json(serde_json::json!({
        "revision": revision,
        "file": file_info,
        "path": repo_path,
        "etag": etag,
        "wdbRecorded": wdb_recorded,
    })).into_response())
}

#[derive(Deserialize)]
struct DownloadQuery {
    revision: Option<String>,
    expires: Option<i64>,
    uid: Option<i64>,
    sig: Option<String>,
    download: Option<u8>,
}

/// Query for the signed-URL mint endpoint (L7).
#[derive(Deserialize)]
struct SignedUrlQuery {
    path: String,
    revision: Option<String>,
    expires: Option<i64>,
}

/// GET /repos/{channel_id}/signed-url?path=...&revision=...&expires=...
/// Requires AuthUser + channel membership. Returns a short-lived HMAC-signed
/// download URL usable from <a href>/window.open without a Bearer header.
async fn signed_download_url(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Query(query): Query<SignedUrlQuery>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;

    let now = chrono::Utc::now().timestamp();
    let ttl = query.expires.unwrap_or(now + 300);
    let expires = ttl.clamp(now + 60, now + 3600);

    let sig = lore_signature(
        &state.config.jwt_secret,
        channel_id,
        auth.user_id,
        &query.path,
        expires,
    );

    let mut url = format!(
        "/api/addons/lore/repos/{}/files/{}?expires={}&uid={}&sig={}",
        channel_id,
        urlencoding::encode(&query.path),
        expires,
        auth.user_id,
        sig
    );
    if let Some(rev) = &query.revision {
        url.push_str(&format!("&revision={}", urlencoding::encode(rev)));
    }

    Ok(Json(serde_json::json!({
        "url": url,
        "expiresAt": expires,
    })))
}

/// Parse a `Range: bytes=START-END` or `bytes=START-` header.
/// Returns `(start, end)` inclusive byte positions, or `None` if unparseable.
fn parse_byte_range(range_str: &str, file_size: u64) -> Option<(u64, u64)> {
    let range_str = range_str.strip_prefix("bytes=")?;
    let (start_str, end_str) = range_str.split_once('-')?;
    let start: u64 = start_str.parse().ok()?;
    if start >= file_size {
        return None;
    }
    let end = if end_str.is_empty() {
        file_size - 1
    } else {
        end_str.parse::<u64>().ok()?.min(file_size - 1)
    };
    if end < start {
        return None;
    }
    Some((start, end))
}

/// Build a stable cache file name from channel_id, path, and optional revision.
fn cache_path(channel_id: i64, path: &str, revision: Option<&str>) -> std::path::PathBuf {
    let mut key = format!("{}_{}", channel_id, path.replace('/', "_"));
    if let Some(rev) = revision {
        key.push('_');
        key.push_str(rev);
    }
    // Sanitize: only alphanumeric, underscore, dash
    let sanitized: String = key
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let tmp_dir = std::env::temp_dir().join("wabi-lore-cache");
    tmp_dir.join(sanitized)
}

async fn download_file(
    State(state): State<Arc<AppState>>,
    auth: OptionalAuthUser,
    Path((channel_id, path)): Path<(i64, String)>,
    Query(query): Query<DownloadQuery>,
    headers: axum::http::HeaderMap,
) -> Result<axum::response::Response> {
    // L7: signed-URL path — no Bearer header required; membership was checked
    // at mint time and is re-checked here via the embedded uid.
    let user_id = if let (Some(expires), Some(uid), Some(sig)) =
        (query.expires, query.uid, query.sig.as_deref())
    {
        let now = chrono::Utc::now().timestamp();
        if now > expires || expires - now > 3600 {
            return Err(AppError::Forbidden("signed URL expired".into()));
        }
        let expected =
            lore_signature(&state.config.jwt_secret, channel_id, uid, &path, expires);
        if sig != expected {
            return Err(AppError::Forbidden("invalid signed URL signature".into()));
        }
        uid
    } else {
        let user = auth
            .0
            .ok_or_else(|| AppError::Unauthorized("Authentication required".into()))?;
        user.user_id
    };
    ensure_channel_member(&state, channel_id, user_id).await?;
    let tmp_path = cache_path(channel_id, &path, query.revision.as_deref());
    tokio::fs::create_dir_all(tmp_path.parent().unwrap_or(std::path::Path::new("."))).await?;

    // Download via Lore CLI if not cached
    if !tokio::fs::try_exists(&tmp_path).await.unwrap_or(false) {
        let lore = lore_service(&state).await?;
        lore.download_file(
            channel_id,
            &path,
            tmp_path.to_str().unwrap_or("/dev/null"),
            query.revision.as_deref(),
        )
        .await?;
    }

    let file_size = tokio::fs::metadata(&tmp_path).await?.len();
    let mime = mime_guess::from_path(&path).first_or_octet_stream();

    // ETag of the served content (same algorithm as list/head etags, so a
    // downloaded file's etag matches the manifest's).
    let etag = wabi_lore::file_etag(&tmp_path)
        .await
        .unwrap_or_default();
    let quoted_etag = format!("\"{etag}\"");

    // If-None-Match → 304 when the client already has this version.
    if let Some(inm) = headers.get(axum::http::header::IF_NONE_MATCH).and_then(|v| v.to_str().ok())
    {
        let inm = normalize_etag_header(inm);
        if !inm.is_empty() && (inm == "*" || inm == etag) {
            return Ok(axum::response::Response::builder()
                .status(axum::http::StatusCode::NOT_MODIFIED)
                .header(axum::http::header::ETAG, &quoted_etag)
                .body(axum::body::Body::empty())
                .unwrap());
        }
    }

    // Schedule cleanup after 5 minutes
    let cleanup_path = tmp_path.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(300)).await;
        let _ = tokio::fs::remove_file(&cleanup_path).await;
    });

    // Try to serve a byte range
    if let Some(range_val) = headers.get(axum::http::header::RANGE) {
        if let Ok(range_str) = range_val.to_str() {
            if let Some((start, end)) = parse_byte_range(range_str, file_size) {
                let length = end - start + 1;
                let mut buf = vec![0u8; length as usize];
                let mut file = tokio::fs::File::open(&tmp_path).await?;
                file.seek(std::io::SeekFrom::Start(start)).await?;
                file.read_exact(&mut buf).await?;

                let resp = axum::response::Response::builder()
                    .status(axum::http::StatusCode::PARTIAL_CONTENT)
                    .header(axum::http::header::CONTENT_TYPE, mime.as_ref())
                    .header(
                        axum::http::header::CONTENT_RANGE,
                        format!("bytes {}-{}/{}", start, end, file_size),
                    )
                    .header(axum::http::header::CONTENT_LENGTH, length.to_string())
                    .header(axum::http::header::ACCEPT_RANGES, "bytes")
                    .header(axum::http::header::ETAG, &quoted_etag)
                    .body(axum::body::Body::from(buf))
                    .unwrap();
                return Ok(resp);
            }
        }
    }

    // Full content
    let data = tokio::fs::read(&tmp_path).await?;
    let mut builder = axum::response::Response::builder()
        .status(axum::http::StatusCode::OK)
        .header(axum::http::header::CONTENT_TYPE, mime.as_ref())
        .header(axum::http::header::CONTENT_LENGTH, data.len().to_string())
        .header(axum::http::header::ACCEPT_RANGES, "bytes")
        .header(axum::http::header::ETAG, &quoted_etag);
    // L7: ?download=1 → attachment disposition (direct web save)
    if query.download == Some(1) {
        let filename = path.rsplit('/').next().unwrap_or("download");
        builder = builder.header(
            axum::http::header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{}\"", filename.replace('"', "_")),
        );
    }
    let resp = builder.body(axum::body::Body::from(data)).unwrap();
    Ok(resp)
}

#[derive(Deserialize)]
struct DeleteFilePayload {
    message: Option<String>,
}

async fn delete_file(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((channel_id, path)): Path<(i64, String)>,
    headers: axum::http::HeaderMap,
    Json(payload): Json<DeleteFilePayload>,
) -> Result<axum::response::Response> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    // L8: asset writes = Owner/Admin/Developer/Artist
    if !can_asset_write_lore(&state, auth.user_id).await {
        return Err(AppError::Forbidden("Lore asset deletion requires at least Artist role".into()));
    }
    let message = payload.message.unwrap_or_else(|| "Deleted via API".into());

    let lore = lore_service(&state).await?;
    // Mirror repos are read-only pointers — reject writes with 501.
    if repo_read_only(&lore, channel_id).await {
        return Ok(mirror_read_only_response());
    }

    // Optimistic concurrency on deletes too — only when If-Match was sent.
    let if_match = headers
        .get(axum::http::header::IF_MATCH)
        .and_then(|v| v.to_str().ok());
    if if_match.is_some() {
        if let Err(conflict) =
            check_if_match(if_match, lore.head_etag(channel_id, &path).await?)
        {
            return Ok(conflict);
        }
    }

    lore.delete_file(channel_id, &path, &message).await?;

    let mut cursor = 0u64;
    if let Some(repo) = lore.get_repo(channel_id).await {
        let outcome = record_lore_commit_and_change(
            &state,
            channel_id,
            &repo.repo_name,
            "",
            &path,
            "delete",
            None,
            &message,
            auth.user_id,
        )
        .await;
        cursor = outcome.change_cursor;
    }

    emit_lore_file_changed(
        &state,
        channel_id,
        serde_json::json!({
            "action": "delete",
            "path": path,
            "authorUserId": auth.user_id,
            "cursor": cursor,
        }),
    )
    .await;

    info!(channel_id, path, "File deleted from Lore repo");
    Ok(Json(serde_json::json!({ "status": "ok", "cursor": cursor })).into_response())
}

// -- File locking --

async fn lock_file(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((channel_id, path)): Path<(i64, String)>,
) -> Result<axum::response::Response> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    // L8: asset writes = Owner/Admin/Developer/Artist
    if !can_asset_write_lore(&state, auth.user_id).await {
        return Err(AppError::Forbidden("Lore locking requires at least Artist role".into()));
    }
    let lore = lore_service(&state).await?;
    if repo_read_only(&lore, channel_id).await {
        return Ok(mirror_read_only_response());
    }
    lore.lock_file(channel_id, &path, auth.user_id).await?;

    Ok(Json(serde_json::json!({ "status": "ok", "locked_by": auth.user_id })).into_response())
}

async fn unlock_file(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((channel_id, path)): Path<(i64, String)>,
) -> Result<axum::response::Response> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    // L8: asset writes = Owner/Admin/Developer/Artist
    if !can_asset_write_lore(&state, auth.user_id).await {
        return Err(AppError::Forbidden("Lore unlocking requires at least Artist role".into()));
    }
    let lore = lore_service(&state).await?;
    if repo_read_only(&lore, channel_id).await {
        return Ok(mirror_read_only_response());
    }
    lore.unlock_file(channel_id, &path).await?;

    Ok(Json(serde_json::json!({ "status": "ok" })).into_response())
}

// -- History & Diff --

async fn repo_history(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    let lore = lore_service(&state).await?;

    // Native repos: serve from the WDB commit log, which carries numeric
    // author ids and epoch timestamps — the wire contract the frontend
    // expects. The lore CLI's prose history format has neither (it used to
    // serialize as authorId: null / timestamp: "" and broke every consumer).
    if !repo_read_only(&lore, channel_id).await {
        let records = state
            .wdb
            .list_lore_commits(channel_id)
            .await
            .unwrap_or_default();
        // Dedupe by commit hash: one lore commit can carry several file-path
        // records; a revision list should show each commit once.
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut entries: Vec<serde_json::Value> = records
            .into_iter()
            .filter(|r| seen.insert(r.commit_hash.clone()))
            .map(|r| {
                serde_json::json!({
                    "hash": r.commit_hash,
                    "message": r.message,
                    "authorUserId": r.author_user_id,
                    "timestamp": r.timestamp_micros / 1000,
                })
            })
            .collect();
        entries.reverse(); // newest first
        return Ok(Json(serde_json::json!(entries)));
    }

    let lore = lore_service(&state).await?;
    let history = lore.file_history(channel_id, "").await?;
    Ok(Json(serde_json::json!(history)))
}

async fn file_level_history(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((channel_id, path)): Path<(i64, String)>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    let lore = lore_service(&state).await?;

    // Native repos: filter the WDB commit log, which carries file paths —
    // `lore history` has no per-path mode, so post-filtering its output would
    // be guesswork. Mirror repos keep the addon path (git filters natively).
    if !repo_read_only(&lore, channel_id).await {
        let records = state
            .wdb
            .list_lore_commits(channel_id)
            .await
            .unwrap_or_default();
        let mut entries: Vec<serde_json::Value> = records
            .into_iter()
            .filter(|r| r.file_path == path)
            .map(|r| {
                serde_json::json!({
                    "hash": r.commit_hash,
                    "message": r.message,
                    "authorUserId": r.author_user_id,
                    "timestampMicros": r.timestamp_micros,
                    "path": r.file_path,
                })
            })
            .collect();
        entries.reverse(); // newest first
        return Ok(Json(serde_json::json!(entries)));
    }

    let history = lore.file_level_history(channel_id, &path).await?;
    Ok(Json(serde_json::json!(history)))
}

#[derive(Deserialize)]
struct DiffQuery {
    from: String,
    to: String,
}

async fn file_diff(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((channel_id, path)): Path<(i64, String)>,
    Query(query): Query<DiffQuery>,
) -> Result<axum::response::Response> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    let lore = lore_service(&state).await?;
    let diff = lore.file_diff(channel_id, &path, &query.from, &query.to).await?;

    Ok(([(axum::http::header::CONTENT_TYPE, "text/plain")], diff).into_response())
}

// -- Branches --

async fn list_branches(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    let lore = lore_service(&state).await?;
    let branches = lore.list_branches(channel_id).await?;
    Ok(Json(serde_json::json!({ "branches": branches })))
}

async fn create_branch(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(payload): Json<serde_json::Value>,
) -> Result<axum::response::Response> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    // L8: branch management = Owner/Admin/Developer
    if !can_edit_lore(&state, auth.user_id).await {
        return Err(AppError::Forbidden("Lore branch operations require Owner/Admin/Developer role".into()));
    }
    let branch_name = payload["name"].as_str().unwrap_or("feature");
    let base_revision = payload["baseRevision"].as_str();

    let lore = lore_service(&state).await?;
    if repo_read_only(&lore, channel_id).await {
        return Ok(mirror_read_only_response());
    }
    lore.create_branch(channel_id, branch_name, base_revision).await?;

    Ok(Json(serde_json::json!({ "status": "ok", "branch": branch_name, "created_by": auth.user_id })).into_response())
}

async fn merge_branch(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((channel_id, branch_name)): Path<(i64, String)>,
) -> Result<axum::response::Response> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    // L8: branch management = Owner/Admin/Developer
    if !can_edit_lore(&state, auth.user_id).await {
        return Err(AppError::Forbidden("Lore branch operations require Owner/Admin/Developer role".into()));
    }
    let lore = lore_service(&state).await?;
    if repo_read_only(&lore, channel_id).await {
        return Ok(mirror_read_only_response());
    }
    lore.merge_branch(channel_id, &branch_name).await?;

    info!(channel_id, branch_name, "Branch merged via API");
    Ok(Json(serde_json::json!({ "status": "ok", "branch": branch_name, "merged_by": auth.user_id })).into_response())
}

/// POST /repos/{channel_id}/review/{branch_name}/approve — merge a review
/// branch into mainline and retire it.
async fn approve_review_branch(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((channel_id, branch_name)): Path<(i64, String)>,
) -> Result<axum::response::Response> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    if !can_edit_lore(&state, auth.user_id).await {
        return Err(AppError::Forbidden("Review approval requires Owner/Admin/Developer role".into()));
    }
    let lore = lore_service(&state).await?;
    if repo_read_only(&lore, channel_id).await {
        return Ok(mirror_read_only_response());
    }
    lore.approve_review_branch(channel_id, &branch_name).await?;
    info!(channel_id, branch_name, "Review branch approved via API");
    Ok(Json(serde_json::json!({ "status": "ok", "branch": branch_name, "approved_by": auth.user_id })).into_response())
}

/// POST /repos/{channel_id}/review/{branch_name}/reject — retire a review
/// branch without merging.
async fn reject_review_branch(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((channel_id, branch_name)): Path<(i64, String)>,
) -> Result<axum::response::Response> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    if !can_edit_lore(&state, auth.user_id).await {
        return Err(AppError::Forbidden("Review rejection requires Owner/Admin/Developer role".into()));
    }
    let lore = lore_service(&state).await?;
    if repo_read_only(&lore, channel_id).await {
        return Ok(mirror_read_only_response());
    }
    lore.reject_review_branch(channel_id, &branch_name).await?;
    info!(channel_id, branch_name, "Review branch rejected via API");
    Ok(Json(serde_json::json!({ "status": "ok", "branch": branch_name, "rejected_by": auth.user_id })).into_response())
}

// -- Health --

async fn health_check(
    State(state): State<Arc<AppState>>,
) -> Json<serde_json::Value> {
    let lore = state.lore_service.read().await;
    match lore.as_ref() {
        Some(service) => {
            match service.health_check().await {
                Ok(_) => Json(serde_json::json!({ "status": "ok", "addon": "lore" })),
                Err(e) => Json(serde_json::json!({ "status": "error", "addon": "lore", "error": e.to_string() })),
            }
        }
        None => Json(serde_json::json!({ "status": "disabled", "addon": "lore" })),
    }
}

// -- P4: Editor Bridge --

#[derive(Deserialize)]
struct EditorSessionRequest {
    repo_path: Option<String>,
}

async fn start_editor_session(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(payload): Json<EditorSessionRequest>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    if !can_edit_lore(&state, auth.user_id).await {
        return Err(AppError::Forbidden("Editor sessions require Owner/Admin/Developer role".into()));
    }
    let lore = lore_service(&state).await?;
    let working_tree = lore
        .repo_working_tree(channel_id)
        .await
        .ok_or_else(|| AppError::NotFound("No Lore repo for this channel".into()))?;
    let session = lore
        .editor_bridge
        .start_session(channel_id, auth.user_id, &working_tree, payload.repo_path)
        .await?;
    Ok(Json(serde_json::json!({ "session": session })))
}

async fn stop_editor_session(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    let lore = lore_service(&state).await?;
    // Stop all sessions for this channel (simplification: stop by listing)
    let sessions = lore.editor_bridge.list_sessions().await;
    for s in sessions {
        if s.channel_id == channel_id {
            let _ = lore.editor_bridge.stop_session(&s.session_id).await;
        }
    }
    Ok(Json(serde_json::json!({ "status": "ok", "stopped": "all" })))
}

async fn list_editor_sessions(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    let lore = lore_service(&state).await?;
    let sessions: Vec<_> = lore
        .editor_bridge
        .list_sessions()
        .await
        .into_iter()
        .filter(|s| s.channel_id == channel_id)
        .collect();
    Ok(Json(serde_json::json!({ "sessions": sessions })))
}

// -- P5: Script Runner --

#[derive(Deserialize)]
struct RunScriptRequest {
    script_path: String,
    arguments: Option<Vec<String>>,
    working_dir: Option<String>,
}

async fn run_script(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(payload): Json<RunScriptRequest>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    if !can_edit_lore(&state, auth.user_id).await {
        return Err(AppError::Forbidden("Script execution requires Owner/Admin/Developer role".into()));
    }
    let lore = lore_service(&state).await?;
    // Default to the channel's actual working tree — not a mangled lore URL.
    let working_dir = match payload.working_dir {
        Some(dir) => dir,
        None => match lore.repo_working_tree(channel_id).await {
            Some(p) => p.to_string_lossy().to_string(),
            None => {
                return Err(AppError::NotFound(
                    "No Lore repo working tree for this channel".into(),
                ))
            }
        },
    };
    let result = lore
        .script_runner
        .run_script(
            channel_id,
            auth.user_id,
            payload.script_path,
            payload.arguments.unwrap_or_default(),
            working_dir,
        )
        .await?;
    Ok(Json(serde_json::json!({ "result": result })))
}

async fn list_active_scripts(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    let lore = lore_service(&state).await?;
    let active: Vec<_> = lore
        .script_runner
        .list_active()
        .await
        .into_iter()
        .filter(|s| s.channel_id == channel_id)
        .collect();
    Ok(Json(serde_json::json!({ "active": active })))
}

async fn cancel_script(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((channel_id, script_id)): Path<(i64, String)>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    let lore = lore_service(&state).await?;
    lore.script_runner.cancel_script(&script_id).await?;
    Ok(Json(serde_json::json!({ "status": "ok", "cancelled": script_id })))
}

// -- P7: Off-box Mirror --

#[derive(Deserialize)]
struct MirrorConfigRequest {
    backend: Option<String>,
    remote_url: String,
    branches: Option<Vec<String>>,
    tags: Option<bool>,
    auto_mirror: Option<bool>,
}

async fn register_mirror(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    Json(payload): Json<MirrorConfigRequest>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    if !can_edit_lore(&state, auth.user_id).await {
        return Err(AppError::Forbidden("Mirror config requires Owner/Admin role".into()));
    }
    let lore = lore_service(&state).await?;
    let backend = match payload.backend.as_deref().unwrap_or("git") {
        "github" => wabi_lore::mirror::MirrorBackend::GitHub,
        "gitlab" => wabi_lore::mirror::MirrorBackend::GitLab,
        "s3" => wabi_lore::mirror::MirrorBackend::S3,
        _ => wabi_lore::mirror::MirrorBackend::GenericGit,
    };
    let config = wabi_lore::mirror::MirrorConfig {
        channel_id,
        backend,
        remote_url: payload.remote_url,
        branches: payload.branches.unwrap_or_default(),
        tags: payload.tags.unwrap_or(true),
        auto_mirror: payload.auto_mirror.unwrap_or(false),
        mirror_on_push: false,
        credentials_secret_id: None,
        last_mirror_at: None,
        last_mirror_status: None,
    };
    lore.mirror.register_mirror(config).await?;
    Ok(Json(serde_json::json!({ "status": "ok", "channel_id": channel_id })))
}

async fn get_mirror_config(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    let lore = lore_service(&state).await?;
    match lore.mirror.get_config(channel_id).await {
        Some(config) => Ok(Json(serde_json::json!(config))),
        None => Err(AppError::NotFound("No mirror configuration for this channel".into())),
    }
}

async fn remove_mirror(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    if !can_edit_lore(&state, auth.user_id).await {
        return Err(AppError::Forbidden("Mirror removal requires Owner/Admin role".into()));
    }
    let lore = lore_service(&state).await?;
    lore.mirror.remove_mirror(channel_id).await?;
    Ok(Json(serde_json::json!({ "status": "ok" })))
}

async fn run_mirror(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    if !can_edit_lore(&state, auth.user_id).await {
        return Err(AppError::Forbidden("Mirror run requires Owner/Admin role".into()));
    }
    let lore = lore_service(&state).await?;
    let result = lore
        .mirror
        .mirror(channel_id, lore.repo_working_tree(channel_id).await.as_deref())
        .await?;
    Ok(Json(serde_json::json!({ "result": result })))
}

async fn list_mirror_configs(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
) -> Result<Json<serde_json::Value>> {
    ensure_channel_member(&state, channel_id, auth.user_id).await?;
    let lore = lore_service(&state).await?;
    let configs: Vec<_> = lore
        .mirror
        .list_configs()
        .await
        .into_iter()
        .filter(|c| c.channel_id == channel_id)
        .collect();
    Ok(Json(serde_json::json!({ "configs": configs })))
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- If-Match / ETag decision logic --

    #[test]
    fn if_match_absent_allows_anything() {
        assert!(check_if_match(None, None).unwrap().is_none());
        assert!(check_if_match(None, Some("abc".into())).unwrap() == Some("abc".into()));
    }

    #[test]
    fn if_match_empty_means_create_only() {
        // File exists → conflict; absent → OK.
        assert!(check_if_match(Some(""), Some("abc".into())).is_err());
        assert!(check_if_match(Some(""), None).unwrap().is_none());
    }

    #[test]
    fn if_match_matching_etag_passes() {
        let current = Some("etag123".to_string());
        assert!(check_if_match(Some("etag123"), current.clone()).unwrap() == current);
        // Header quoting/W-prefix is normalized.
        assert!(check_if_match(Some("\"etag123\""), current.clone()).unwrap() == current);
        assert!(check_if_match(Some("W/\"etag123\""), current).is_ok());
    }

    #[tokio::test]
    async fn if_match_stale_etag_conflicts() {
        let resp = check_if_match(Some("old"), Some("new".into())).unwrap_err();
        // 409 with the current etag in the body.
        let (parts, body) = resp.into_parts();
        assert_eq!(parts.status, axum::http::StatusCode::CONFLICT);
        let body = axum::body::to_bytes(body, 1024).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["type"], "StaleEtag");
        assert_eq!(json["currentEtag"], "new");
    }

    #[test]
    fn if_match_star_requires_existence() {
        assert!(check_if_match(Some("*"), Some("x".into())).is_ok());
        assert!(check_if_match(Some("*"), None).is_err());
    }

    #[tokio::test]
    async fn conflict_response_is_409_with_current_etag() {
        let resp = conflict_response(Some("cur".into()));
        let (parts, body) = resp.into_parts();
        assert_eq!(parts.status, axum::http::StatusCode::CONFLICT);
        let body = axum::body::to_bytes(body, 1024).await.unwrap();
        assert!(String::from_utf8_lossy(&body).contains("cur"));
    }

    #[test]
    fn byte_range_parsing() {
        assert_eq!(parse_byte_range("bytes=0-9", 100), Some((0, 9)));
        assert_eq!(parse_byte_range("bytes=50-", 100), Some((50, 99)));
        assert_eq!(parse_byte_range("bytes=200-", 100), None);
        assert_eq!(parse_byte_range("bytes=9-0", 100), None);
    }

    // -- End-to-end through LoreService with a stub lore CLI --
    //
    // The stub emulates the lore CLI well enough to exercise the real
    // service: status lists real files from the working tree, commit emits
    // parseable metadata with a fresh signature per call.

    /// Bash stub standing in for the `lore` binary. Embedded-mode global
    // flags (`--offline --local`) are stripped first.
    const STUB_LORE: &str = r#"#!/usr/bin/env bash
ARGS=()
for a in "$@"; do
  case "$a" in --offline|--local) ;; *) ARGS+=("$a") ;; esac
done
cmd="${ARGS[0]:-}"
case "$cmd" in
  repository)
    echo "Repository created: ${ARGS[2]}"
    ;;
  status)
    find . -type f \
      ! -path './.lore/*' \
      ! -name '.wabi-repo.json' \
      ! -name '.wabiignore' \
      ! -name '.loreignore' \
      | sed 's|^\./||' | head -200
    ;;
  stage|push|sync|diff|lock)
    exit 0
    ;;
  commit)
    echo "Committing staged changes"
    echo "Committed 1/1 files"
    echo "Repository: 3f2a1b4c5d6e7f8a923b5e2b2f74fbe8"
    echo "Revision  : 1"
    echo "Signature : stub$RANDOM$RANDOM$RANDOM"
    echo "Branch    : main"
    echo "Date      : Wed, 16 Aug 2026 00:00:00 +0000"
    echo "    stub commit message"
    echo "Commit succeeded"
    ;;
  branch)
    if [ "${ARGS[1]}" = "list" ]; then
      echo "* main"
    fi
    ;;
  history)
    echo "Revision  : 1"
    echo "Signature : stubhash0001"
    echo "Branch    : main"
    echo "Date      : Wed, 16 Aug 2026 00:00:00 +0000"
    echo "    Initial revision"
    ;;
  *)
    exit 0
    ;;
esac
exit 0
"#;

    fn stub_service(data_dir: &std::path::Path) -> wabi_lore::LoreService {
        let stub_bin = data_dir.join("lore-stub.sh");
        std::fs::write(&stub_bin, STUB_LORE).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&stub_bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        wabi_lore::LoreService::new(wabi_lore::LoreConfig {
            enabled: true,
            mode: wabi_lore::LoreMode::Embedded,
            lore_server_url: "lore://localhost:10000".into(),
            lore_binary_path: stub_bin,
            lore_data_dir: data_dir.to_path_buf(),
            default_blob_max_size_mb: 1,
            recordings_channel_name: "Recordings".into(),
        })
    }

    #[tokio::test]
    async fn upload_download_revision_and_conflict_flow() {
        let tmp = tempfile::tempdir().unwrap();
        let service = stub_service(tmp.path());
        let channel_id = 225i64;

        service
            .create_repo(channel_id, 1, "test-repo")
            .await
            .unwrap();

        // Upload v1.
        let src = tmp.path().join("src-v1.txt");
        tokio::fs::write(&src, b"version one").await.unwrap();
        let result = service
            .upload_file(channel_id, src.to_str().unwrap(), "docs/file.txt", "v1", 7)
            .await
            .unwrap();
        let rev1 = result.revision.hash.clone();
        assert!(!rev1.is_empty(), "stub commit output must yield a revision hash");
        assert_eq!(result.file_info.etag.as_deref(), Some(wabi_lore::etag_for_bytes(b"version one").as_str()));

        // Head etag reflects the working tree.
        let head = service.head_etag(channel_id, "docs/file.txt").await.unwrap();
        assert_eq!(head.as_deref(), Some(wabi_lore::etag_for_bytes(b"version one").as_str()));

        // Upload v2 (different revision).
        tokio::fs::write(&src, b"version two!").await.unwrap();
        let result2 = service
            .upload_file(channel_id, src.to_str().unwrap(), "docs/file.txt", "v2", 7)
            .await
            .unwrap();
        assert_ne!(result2.revision.hash, rev1);

        // Head serves v2; the revision cache serves v1 at its revision.
        let out = tmp.path().join("head.txt");
        service
            .download_file(channel_id, "docs/file.txt", out.to_str().unwrap(), None)
            .await
            .unwrap();
        assert_eq!(tokio::fs::read_to_string(&out).await.unwrap(), "version two!");

        let out_v1 = tmp.path().join("v1.txt");
        service
            .download_file(channel_id, "docs/file.txt", out_v1.to_str().unwrap(), Some(&rev1))
            .await
            .unwrap();
        assert_eq!(tokio::fs::read_to_string(&out_v1).await.unwrap(), "version one");

        // Unknown revision → honest error, not silent head fallback.
        let missing = service
            .download_file(channel_id, "docs/file.txt", out.to_str().unwrap(), Some("nope"))
            .await;
        assert!(missing.is_err());

        // Listing carries etags and excludes ignore-file sidecars.
        let files = service.list_files(channel_id, None).await.unwrap();
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"docs/file.txt"));
        assert!(!paths.contains(&".wabi-repo.json"));
        let listed = files.iter().find(|f| f.path == "docs/file.txt").unwrap();
        assert!(listed.etag.is_some());
        assert_eq!(listed.size, b"version two!".len() as u64);
    }

    /// Regression: an upload with NO If-Match header must succeed even when
    /// the file already exists (last-write-wins), and must not need the
    /// head-etag path at all — folder uploads, recordings, and plain sync
    /// pushes never send a precondition.
    #[tokio::test]
    async fn upload_without_if_match_overwrites_existing_file() {
        let tmp = tempfile::tempdir().unwrap();
        let service = stub_service(tmp.path());
        let channel_id = 227i64;
        service
            .create_repo(channel_id, 1, "test-repo")
            .await
            .unwrap();

        let src = tmp.path().join("src.txt");
        tokio::fs::write(&src, b"first").await.unwrap();
        service
            .upload_file(channel_id, src.to_str().unwrap(), "notes/a.txt", "v1", 7)
            .await
            .unwrap();

        // Second upload to the SAME path, no precondition semantics involved
        // (the API layer only computes head_etag when If-Match is present).
        tokio::fs::write(&src, b"second").await.unwrap();
        service
            .upload_file(channel_id, src.to_str().unwrap(), "notes/a.txt", "v2", 7)
            .await
            .unwrap();

        let out = tmp.path().join("head.txt");
        service
            .download_file(channel_id, "notes/a.txt", out.to_str().unwrap(), None)
            .await
            .unwrap();
        assert_eq!(tokio::fs::read_to_string(&out).await.unwrap(), "second");
    }

    #[tokio::test]
    async fn ignored_upload_leaves_no_bytes_and_no_branch_rot() {
        let tmp = tempfile::tempdir().unwrap();
        let service = stub_service(tmp.path());
        let channel_id = 226i64;
        service
            .create_repo(channel_id, 1, "test-repo")
            .await
            .unwrap();

        let src = tmp.path().join("node_modules-payload");
        tokio::fs::write(&src, b"junk").await.unwrap();
        let err = service
            .upload_file(channel_id, src.to_str().unwrap(), "node_modules/pkg/index.js", "bad", 7)
            .await;
        assert!(err.is_err(), "node_modules is ignored by the seeded .wabiignore");

        // The working tree must stay clean — the old code copied first.
        let leaked = service
            .list_files(channel_id, Some("node_modules"))
            .await
            .unwrap();
        assert!(leaked.is_empty(), "rejected upload must not leave bytes behind");
    }

    /// The device setup flow: stage N files WITHOUT committing, then seal the
    /// whole batch with one snapshot — so importing a folder produces ONE
    /// revision ("Initial import"), not one revision per file.
    #[tokio::test]
    async fn staged_batch_push_seals_into_single_snapshot_commit() {
        let tmp = tempfile::tempdir().unwrap();
        let service = stub_service(tmp.path());
        let channel_id = 228i64;
        service
            .create_repo(channel_id, 1, "test-repo")
            .await
            .unwrap();

        let a = tmp.path().join("a.txt");
        tokio::fs::write(&a, b"alpha").await.unwrap();
        let b = tmp.path().join("b.txt");
        tokio::fs::write(&b, b"beta").await.unwrap();
        let fa = service
            .stage_file(channel_id, a.to_str().unwrap(), "docs/a.txt")
            .await
            .unwrap();
        service
            .stage_file(channel_id, b.to_str().unwrap(), "src/b.txt")
            .await
            .unwrap();
        assert_eq!(fa.status, "staged");
        assert!(fa.etag.is_some(), "staged files carry etags");

        // Both files are visible in the working tree before any commit.
        let files = service.list_files(channel_id, None).await.unwrap();
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"docs/a.txt") && paths.contains(&"src/b.txt"));

        // Seal the batch — ONE revision for the whole push.
        let rev = service
            .commit_staged(channel_id, "Initial import (2 files)", 7)
            .await
            .unwrap();
        assert!(!rev.hash.is_empty(), "snapshot must yield a revision hash");

        // Head content survived the seal.
        let out = tmp.path().join("out.txt");
        service
            .download_file(channel_id, "docs/a.txt", out.to_str().unwrap(), None)
            .await
            .unwrap();
        assert_eq!(tokio::fs::read_to_string(&out).await.unwrap(), "alpha");
    }

    /// With WABI_LORE_AUTO_CREATE on, every new lore channel gets an empty
    /// repo — importing existing code into it must ADOPT the empty repo, not
    /// 409. A repo with real content stays a hard RepoExists.
    #[tokio::test]
    async fn git_import_adopts_empty_auto_created_repo() {
        let tmp = tempfile::tempdir().unwrap();
        let service = stub_service(tmp.path());
        let channel_id = 229i64;

        // A local git "upstream" with one committed file.
        let src = tmp.path().join("upstream");
        tokio::fs::create_dir_all(&src).await.unwrap();
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .arg("-C")
                .arg(&src)
                .args(["-c", "user.email=test@example.com", "-c", "user.name=test"])
                .args(args)
                .output()
                .expect("git binary");
            assert!(
                out.status.success(),
                "git {:?} failed: {}",
                args,
                String::from_utf8_lossy(&out.stderr)
            );
        };
        git(&["init", "-q"]);
        tokio::fs::write(src.join("README.md"), b"imported hello")
            .await
            .unwrap();
        git(&["add", "."]);
        git(&["commit", "-q", "-m", "init"]);

        // The auto-created empty repo for the channel.
        service
            .create_repo(channel_id, 1, "auto")
            .await
            .unwrap();

        // Import adopts the empty registration instead of RepoExists.
        let repo = service
            .import_from_git(channel_id, 1, "imported", src.to_str().unwrap())
            .await
            .expect("import must adopt the empty auto-created repo");
        assert_eq!(repo.imported_from.as_deref(), Some(src.to_str().unwrap()));

        let files = service.list_files(channel_id, None).await.unwrap();
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"README.md"));

        // Re-importing into a repo that now HAS content is refused.
        let err = service
            .import_from_git(channel_id, 1, "again", src.to_str().unwrap())
            .await;
        assert!(matches!(
            err,
            Err(wabi_lore::LoreImportError::RepoExists)
        ));
    }
}
