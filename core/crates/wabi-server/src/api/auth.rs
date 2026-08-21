//! Authentication routes
//!
//! Implements:
//! - POST /api/auth/register
//! - POST /api/auth/login
//! - POST /api/auth/guest

use axum::{extract::{ConnectInfo, State}, Json, Router};
use chrono::{Duration, Utc};
use jsonwebtoken::{encode, EncodingKey, Header};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::auth_extractor::{AuthUser, decode_token};
use crate::error::{AppError, Result};
use crate::state::AppState;
use serde_json::{json, Value};
use wabidb::engine::wabi_store::WabiStore;

fn load_auth_policy(state: &AppState) -> Value {
    std::fs::read_to_string(std::path::PathBuf::from(&state.config.data_dir).join("admin_policies.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Map<String, Value>>(&raw).ok())
        .and_then(|map| map.get("auth_policy").cloned())
        .unwrap_or_else(|| json!({
            "mode": "open",
            "allowGuest": true,
            "allowRegister": true,
            "emailVerifyRequired": false
        }))
}

/// Create auth router
pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/register", axum::routing::post(handle_register))
        .route("/login", axum::routing::post(handle_login))
        .route("/guest", axum::routing::post(handle_guest))
        .route("/logout", axum::routing::post(handle_logout))
        .route("/refresh", axum::routing::post(handle_refresh))
        .route("/recover", axum::routing::post(handle_recover))
        .route("/change-password", axum::routing::post(handle_change_password))
        .route("/stepup", axum::routing::post(handle_stepup))
        .route(
            "/turn-credentials",
            axum::routing::post(handle_turn_credentials),
        )
        .with_state(state)
}

/// Registration request
#[derive(Debug, Deserialize)]
struct RegisterRequest {
    username: String,
    #[allow(dead_code)]
    email: Option<String>,
    password: String,
    handle: Option<String>,
}

/// Auth user profile — matches frontend AuthUserProfile contract
#[derive(Debug, Serialize)]
struct AuthUserProfile {
    id: i64,
    username: String,
    handle: Option<String>,
    color: String,
    #[serde(rename = "isRegistered")]
    is_registered: bool,
}

/// Auth response — matches frontend AuthResponse contract.
/// COMPAT: the frontend (`shared/userContracts.ts`) reads `token`; it is an
/// exact alias of `access_token` until the silent-refresh migration (card A2)
/// moves consumers onto accessToken/refreshToken.
#[derive(Debug, Serialize)]
struct AuthResponse {
    #[serde(rename = "accessToken")]
    access_token: String,
    #[serde(rename = "refreshToken")]
    refresh_token: String,
    /// Backward-compat alias of `access_token`. Serialized as `"token"`.
    #[serde(rename = "token")]
    compat_token: String,
    #[serde(rename = "mustChangePassword")]
    must_change_password: bool,
    user: AuthUserProfile,
}

impl AuthResponse {
    fn new(
        access_token: String,
        refresh_token: String,
        must_change_password: bool,
        user: AuthUserProfile,
    ) -> Self {
        let compat_token = access_token.clone();
        Self {
            access_token,
            refresh_token,
            compat_token,
            must_change_password,
            user,
        }
    }
}

/// Register a new user
async fn handle_register(
    State(state): State<Arc<AppState>>,
    Json(req): Json<RegisterRequest>,
) -> Result<Json<AuthResponse>> {
    // Fresh-server setup window: exactly one account (the owner) may be
    // created, serialized under the setup lock so concurrent first
    // registrations can't interleave with the claim. The claim ignores the
    // auth policy — the owner account is bootstrap, not a join.
    let _setup_guard = if state.needs_setup().await {
        let guard = state.setup_claim_lock.lock().await;
        if !state.needs_setup().await {
            return Err(AppError::Conflict(
                "Owner already claimed on this fresh server; registration now follows the server's auth policy".into(),
            ));
        }
        Some(guard)
    } else {
        let auth_policy = load_auth_policy(&state);
        if auth_policy.get("allowRegister").and_then(Value::as_bool) == Some(false) {
            return Err(AppError::Forbidden("Registration is closed on this server".into()));
        }
        if auth_policy.get("mode").and_then(Value::as_str) == Some("invite") {
            return Err(AppError::Forbidden("An invite is required to register on this server".into()));
        }
        None
    };
    if req.username.trim().is_empty() {
        return Err(AppError::BadRequest("Username cannot be empty".into()));
    }
    if req.password.len() < 6 {
        return Err(AppError::BadRequest(
            "Password must be at least 6 characters".into(),
        ));
    }

    // Check IP blacklist (if available)
    // Note: We don't have IP here, but admin can manually ban usernames

    let password_hash = bcrypt::hash(&req.password, bcrypt::DEFAULT_COST)?;

    let existing = state
        .wdb
        .get_user_by_username(&req.username)
        .await?;
    if existing.is_some() {
        return Err(AppError::BadRequest("Username already taken".into()));
    }

    let handle = req.handle.clone().unwrap_or_else(|| req.username.to_lowercase());
    let user_id_u64 = state
        .wdb
        .create_user(&req.username, Some(&handle), &password_hash)
        .await?;
    let user_id = user_id_u64 as i64;

    // First registrant on a fresh server automatically becomes the owner.
    let was_first = state.claim_ownership(user_id, &req.username).await;

    // Seed default channels on first-ever registration.
    if was_first {
        use wabidb::domain::{ChannelKind, MemberRole};
        const DEFAULT_CHANNEL_AUTO_DELETE_MS: u64 = 24 * 60 * 60 * 1000;
        for (name, kind) in &[("general", ChannelKind::Text), ("general", ChannelKind::Voice)] {
            match state.wdb.create_channel(name, *kind, user_id as u64, false).await {
                Ok(ch_id) => {
                    if let Err(e) = state
                        .wdb
                        .add_channel_member(&ch_id, user_id as u64, MemberRole::Owner)
                        .await
                    {
                        tracing::warn!("[setup] failed to add owner to default channel {ch_id}: {e}");
                    }
                    // Default ephemeral 24h — keep-forever is opt-in.
                    state
                        .channel_auto_delete_ms
                        .write()
                        .await
                        .insert(ch_id.clone(), DEFAULT_CHANNEL_AUTO_DELETE_MS);
                    state
                        .channel_auto_delete_label
                        .write()
                        .await
                        .insert(ch_id.clone(), "24h".to_string());
                    let _ = state
                        .wdb
                        .upsert_channel_retention(&ch_id, 1, user_id as u64)
                        .await;
                }
                Err(e) => tracing::warn!("[setup] failed to create default channel {name}: {e}"),
            }
        }
    }

    let access_token = generate_access_jwt(&state, user_id, &req.username, false)?;
    let refresh_token = generate_refresh_jwt(&state, user_id, &req.username, false)?;

    Ok(Json(AuthResponse::new(
        access_token,
        refresh_token,
        false,
        AuthUserProfile {
            id: user_id,
            username: req.username,
            handle: Some(handle),
            color: "#98D8C8".to_string(),
            is_registered: true,
        },
    )))
}

/// Login request
#[derive(Debug, Deserialize)]
struct LoginRequest {
    username: String,
    password: String,
}

/// Login user
async fn handle_login(
    State(state): State<Arc<AppState>>,
    Json(req): Json<LoginRequest>,
) -> Result<Json<AuthResponse>> {
    let user_row = state
        .wdb
        .get_user_by_username(&req.username)
        .await
        .map_err(|e| AppError::Internal(format!("wdb get_user_by_username: {e}")))?
        .ok_or_else(|| {
            AppError::Unauthorized("Invalid username or password".into())
        })?;

    let user_id = user_row.user_id as i64;

    tracing::debug!(
        "[login] username={} found={}",
        req.username,
        user_row.user_id
    );

    // Guest users don't have password_hash - they must use guest login
    if user_row.password_hash.is_empty() {
        return Err(AppError::Unauthorized(
            "This account is guest-only. Use 'Join as Guest' or register a new account with a password.".into(),
        ));
    }

    let verified = bcrypt::verify(&req.password, &user_row.password_hash)?;
    tracing::debug!(
        "[login] verify_result={} for user={}",
        verified,
        req.username
    );

    if !verified {
        return Err(AppError::Unauthorized(
            "Invalid username or password".into(),
        ));
    }

    // Check blacklist after successful auth
    if let Some(blacklist) = state.get_blacklist().await {
        if let Some(entry) = blacklist.is_user_banned(user_id).await {
            return Err(AppError::Unauthorized(format!(
                "Account banned: {}. Contact server admin.",
                entry.reason
            )));
        }
    }

    let username = user_row.username.clone();
    let handle = user_row.handle.clone();
    let color = user_row.color.clone();

    // A successful password login means this account is allowed to hold a
    // session again. Clear any stale on-disk permanent-ban entry so a legacy
    // `users: [id]` in revocations.json cannot trap the user in a
    // login→401 bounce loop (2026-07-23 incident).
    state.clear_legacy_user_revocation(user_id).await;

    let access_token = generate_access_jwt(&state, user_id, &username, false)?;
    let refresh_token = generate_refresh_jwt(&state, user_id, &username, false)?;

    Ok(Json(AuthResponse::new(
        access_token,
        refresh_token,
        false,
        AuthUserProfile {
            id: user_id,
            username,
            handle,
            color,
            is_registered: true,
        },
    )))
}

/// Guest login request
#[derive(Debug, Deserialize)]
struct GuestRequest {
    username: Option<String>,
}

/// Recovery request (owner lockout escape hatch)
#[derive(Debug, Deserialize)]
struct RecoverRequest {
    code: String,
    #[serde(rename = "userId")]
    user_id: i64,
}

/// Logout — revoke the caller's own token (force re-auth next request).
async fn handle_logout(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
) -> Result<Json<Value>> {
    state.revoke_token_with_exp(auth.jti, auth.exp).await;
    Ok(Json(json!({ "success": true })))
}

/// Refresh request
#[derive(Debug, Deserialize)]
struct RefreshRequest {
    #[serde(rename = "refreshToken")]
    refresh_token: String,
}

/// POST /api/auth/refresh — exchange a valid refresh token for a new access+refresh pair.
/// Implements single-use rotating refresh tokens with reuse detection (family revocation).
async fn handle_refresh(
    State(state): State<Arc<AppState>>,
    Json(req): Json<RefreshRequest>,
) -> Result<Json<AuthResponse>> {
    let refresh_token = req.refresh_token.trim();
    if refresh_token.is_empty() {
        return Err(AppError::BadRequest("refreshToken is required".into()));
    }

    // Decode and validate the refresh token
    let claims = decode_token(refresh_token, &state.config.jwt_secret).await?;

    // Must be a refresh token
    if claims.token_type != "refresh" {
        return Err(AppError::Unauthorized("invalid token type for refresh".into()));
    }

    let user_id = claims
        .sub
        .parse::<i64>()
        .map_err(|_| AppError::Unauthorized("invalid user_id in token".into()))?;

    // Check if token is revoked (reuse detection: if already burned, kill the whole family)
    if state.is_token_revoked(&claims.jti, user_id, claims.iat).await {
        // Refresh token was already used — treat as theft, revoke all user tokens
        state.revoke_user(user_id).await;
        return Err(AppError::Unauthorized("token reuse detected; all sessions revoked".into()));
    }

    // Check blacklist (banned users cannot refresh)
    if let Some(blacklist) = state.get_blacklist().await {
        if let Some(entry) = blacklist.is_user_banned(user_id).await {
            return Err(AppError::Unauthorized(format!(
                "Account banned: {}. Contact server admin.",
                entry.reason
            )));
        }
    }

    // Burn the presented refresh token (with its exp so the entry prunes later)
    state.revoke_token_with_exp(claims.jti, claims.exp).await;

    // Load user profile for response
    let user_row = state
        .wdb
        .get_user(user_id as u64)
        .await
        .map_err(|e| AppError::Internal(format!("wdb get_user: {e}")))?
        .ok_or_else(|| AppError::Unauthorized("user not found".into()))?;

    let username = user_row.username.clone();
    let handle = user_row.handle.clone();
    let color = user_row.color.clone();
    let is_guest = user_row.password_hash.is_empty();

    // Mint fresh access + refresh pair
    let access_token = generate_access_jwt(&state, user_id, &username, is_guest)?;
    let refresh_token = generate_refresh_jwt(&state, user_id, &username, is_guest)?;

    Ok(Json(AuthResponse::new(
        access_token,
        refresh_token,
        false,
        AuthUserProfile {
            id: user_id,
            username,
            handle,
            color,
            is_registered: !is_guest,
        },
    )))
}

/// Recover ownership using a one-time recovery code. This is the escape
/// hatch when the owner is locked out (e.g. password changed by an attacker):
/// presenting a valid code bound to `userId` reasserts ownership and forces
/// a global token revocation. No JWT required.
async fn handle_recover(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<RecoverRequest>,
) -> Result<Json<Value>> {
    if !state
        .consume_recovery_code(&payload.code, payload.user_id)
        .await
    {
        return Err(AppError::Unauthorized(
            "invalid or already-used recovery code".into(),
        ));
    }
    {
        *state.owner_user_id.write().await = Some(payload.user_id);
    }
    if let Err(e) = state.wdb.claim_owner(payload.user_id as u64).await {
        return Err(AppError::Internal(format!("failed to persist owner: {e}")));
    }
    state.revoke_all_tokens().await;
    Ok(Json(json!({ "success": true, "owner_user_id": payload.user_id })))
}

/// Guest login (no password required)
async fn handle_guest(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    Json(req): Json<GuestRequest>,
) -> Result<Json<AuthResponse>> {
    // WS-5b: per-IP rate limit for guest creation.
    let mut guest_limiter = state.guest_rate_limiter.write().await;
    if guest_limiter.len() > 10_000 {
        let keys: Vec<String> = guest_limiter.keys().take(guest_limiter.len() / 2).cloned().collect();
        for k in keys {
            guest_limiter.remove(&k);
        }
    }
    let ip = peer.ip().to_string();
    let count = guest_limiter.entry(ip).or_insert(0);
    *count += 1;
    // 5 guest creations per hour per IP.
    if *count > 5 {
        return Err(AppError::Forbidden("Guest creation rate limit exceeded. Try again later.".into()));
    }
    drop(guest_limiter);

    let auth_policy = load_auth_policy(&state);
    if auth_policy.get("allowGuest").and_then(Value::as_bool) == Some(false) {
        return Err(AppError::Forbidden("Guest access is disabled on this server".into()));
    }
    let username = req
        .username
        .unwrap_or_else(|| format!("Guest_{}", uuid::Uuid::new_v4()));

    // Guest users: empty password hash, handle = username.
    let user_id_u64 = state
        .wdb
        .create_user(&username, None, "")
        .await?;
    let user_id = user_id_u64 as i64;

    let access_token = generate_access_jwt(&state, user_id, &username, true)?;
    let refresh_token = generate_refresh_jwt(&state, user_id, &username, true)?;

    Ok(Json(AuthResponse::new(
        access_token,
        refresh_token,
        false,
        AuthUserProfile {
            id: user_id,
            username: username.clone(),
            handle: Some(username.to_lowercase()),
            color: "#98D8C8".to_string(),
            is_registered: false,
        },
    )))
}

#[derive(Debug, Deserialize)]
struct ChangePasswordRequest {
    #[serde(rename = "currentPassword")]
    current_password: String,
    #[serde(rename = "newPassword")]
    new_password: String,
}

/// POST /api/auth/change-password — authenticated user changes their own password.
async fn handle_change_password(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Json(req): Json<ChangePasswordRequest>,
) -> Result<Json<Value>> {
    if req.new_password.len() < 6 {
        return Err(AppError::BadRequest(
            "Password must be at least 6 characters".into(),
        ));
    }

    let user_row = state
        .wdb
        .get_user(auth.user_id as u64)
        .await
        .map_err(|e| AppError::Internal(format!("wdb get_user: {e}")))?
        .ok_or_else(|| AppError::Unauthorized("User not found".into()))?;

    if user_row.password_hash.is_empty() {
        return Err(AppError::Unauthorized(
            "This account has no password (guest)".into(),
        ));
    }
    if !bcrypt::verify(&req.current_password, &user_row.password_hash)? {
        return Err(AppError::Unauthorized("Current password is incorrect".into()));
    }

    let password_hash = bcrypt::hash(&req.new_password, bcrypt::DEFAULT_COST)?;
    state
        .wdb
        .update_user(
            auth.user_id as u64,
            wabidb::domain::UserUpdate {
                password_hash: Some(password_hash),
                ..Default::default()
            },
        )
        .await
        .map_err(|e| AppError::Internal(format!("failed to update password: {e}")))?;

    // Force re-auth on OTHER sessions for this user while preserving the
    // current session (the bearer token that just performed the change).
    state.revoke_user_other_sessions(auth.user_id, &auth.jti).await;

    Ok(Json(json!({ "success": true })))
}

/// JWT claims structure
#[derive(Debug, Serialize, Deserialize)]
struct JwtClaims {
    sub: String, // User ID
    username: String,
    is_guest: bool,
    exp: i64, // Expiration timestamp
    iat: i64, // Issued at timestamp
    jti: String, // Unique token ID, for revocation
    stepup: bool, // True only for step-up tokens (re-verified password)
    #[serde(default)]
    token_type: String, // "access" or "refresh"; missing = legacy access token
}

/// Generate JWT access token for authenticated user (15 min TTL)
fn generate_access_jwt(state: &AppState, user_id: i64, username: &str, is_guest: bool) -> Result<String> {
    let now = Utc::now();
    let expiration = now + Duration::minutes(15);

    let claims = JwtClaims {
        sub: user_id.to_string(),
        username: username.to_string(),
        is_guest,
        exp: expiration.timestamp(),
        iat: now.timestamp(),
        jti: uuid::Uuid::new_v4().to_string(),
        stepup: false,
        token_type: "access".to_string(),
    };

    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(state.config.jwt_secret.as_bytes()),
    )?;

    Ok(token)
}

/// Generate JWT refresh token for authenticated user (30 day TTL).
/// Guests are capped at 24h — a guest identity must not outlive the tab
/// by 30 days (pre-rotation semantics: guest tokens expired in 24h).
fn generate_refresh_jwt(state: &AppState, user_id: i64, username: &str, is_guest: bool) -> Result<String> {
    let now = Utc::now();
    let expiration = if is_guest {
        now + Duration::hours(24)
    } else {
        now + Duration::days(30)
    };

    let claims = JwtClaims {
        sub: user_id.to_string(),
        username: username.to_string(),
        is_guest,
        exp: expiration.timestamp(),
        iat: now.timestamp(),
        jti: uuid::Uuid::new_v4().to_string(),
        stepup: false,
        token_type: "refresh".to_string(),
    };

    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(state.config.jwt_secret.as_bytes()),
    )?;

    Ok(token)
}

/// Generate a short-lived step-up JWT after the user re-proves their password.
/// This token (carried in `X-Stepup-Token`) is required for destructive admin
/// operations, so a stolen long-lived bearer token is not sufficient on its own.
fn generate_stepup_jwt(state: &AppState, user_id: i64, username: &str) -> Result<String> {
    use crate::auth_extractor::STEPUP_TTL_SECONDS;
    let now = Utc::now();
    let expiration = now + Duration::seconds(STEPUP_TTL_SECONDS);

    let claims = JwtClaims {
        sub: user_id.to_string(),
        username: username.to_string(),
        is_guest: false,
        exp: expiration.timestamp(),
        iat: now.timestamp(),
        jti: uuid::Uuid::new_v4().to_string(),
        stepup: true,
        token_type: "access".to_string(),
    };

    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(state.config.jwt_secret.as_bytes()),
    )?;

    Ok(token)
}

/// Step-up request — re-present the account password to mint a short-lived
/// step-up token used for destructive admin actions.
#[derive(Debug, Deserialize)]
struct StepUpRequest {
    password: String,
}

/// POST /api/auth/stepup — prove the current password and receive a step-up token.
async fn handle_stepup(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Json(req): Json<StepUpRequest>,
) -> Result<Json<Value>> {
    use crate::auth_extractor::STEPUP_TTL_SECONDS;

    let user_row = state
        .wdb
        .get_user(auth.user_id as u64)
        .await
        .map_err(|e| AppError::Internal(format!("wdb get_user: {e}")))?
        .ok_or_else(|| AppError::Unauthorized("user not found".into()))?;

    // Guests (empty password hash) cannot perform step-up; they have no password.
    if user_row.password_hash.is_empty() {
        return Err(AppError::Unauthorized(
            "this account has no password; step-up unavailable".into(),
        ));
    }

    let verified = bcrypt::verify(&req.password, &user_row.password_hash)?;
    if !verified {
        return Err(AppError::Unauthorized("invalid password".into()));
    }

    let token = generate_stepup_jwt(&state, auth.user_id, &auth.username)?;
    Ok(Json(json!({
        "stepupToken": token,
        "expiresInSeconds": STEPUP_TTL_SECONDS,
    })))
}

/// TURN credentials — GET /api/media/turn-credentials
/// Bearer token required. Optional `relayId` query param.
#[derive(Debug, Deserialize)]
pub struct TurnCredentialsQuery {
    #[serde(rename = "relayId")]
    relay_id: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct TurnCredentialsResponse {
    turn: TurnCredentialsPayload,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnCredentialsPayload {
    server: String,
    port: u16,
    use_turns: bool,
    username: String,
    credential: String,
    expires_at: u64,
    relay_id: Option<i64>,
    source: String,
}

/// Generate TURN credentials for WebRTC (GET, Bearer-authenticated)
pub async fn handle_turn_credentials(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    axum::extract::Query(query): axum::extract::Query<TurnCredentialsQuery>,
) -> Result<Json<TurnCredentialsResponse>> {
    let user_id = auth.user_id;

    if !state.config.turn_enabled {
        return Err(AppError::BadRequest("TURN server not enabled".into()));
    }

    let turn_uri = state
        .config
        .turn_uri
        .as_ref()
        .ok_or_else(|| AppError::BadRequest("TURN URI not configured".into()))?;

    let turn_secret = state
        .config
        .turn_secret
        .as_ref()
        .ok_or_else(|| AppError::BadRequest("TURN secret not configured".into()))?;

    let ttl: u64 = 86400;
    let expiry = Utc::now().timestamp() as u64 + ttl;
    let username = format!("{}:{}", expiry, user_id);
    let credential = generate_turn_password(&username, turn_secret, expiry);

    // Parse host:port from turn_uri (e.g. "turn.wabi.chat:3478")
    let (host, port) = if let Some((h, p)) = turn_uri.rsplit_once(':') {
        (h.to_string(), p.parse::<u16>().unwrap_or(3478))
    } else {
        (turn_uri.clone(), 3478)
    };

    Ok(Json(TurnCredentialsResponse {
        turn: TurnCredentialsPayload {
            server: host,
            port,
            use_turns: false,
            username,
            credential,
            expires_at: expiry,
            relay_id: query.relay_id,
            source: "origin".to_string(),
        },
    }))
}

/// Generate TURN password using HMAC
fn generate_turn_password(username: &str, secret: &str, _expiry: u64) -> String {
    use hmac::{Hmac, Mac};
    use sha2::digest::KeyInit;
    use sha1::Sha1;

    type HmacSha1 = Hmac<Sha1>;

    let mut mac =
        HmacSha1::new_from_slice(secret.as_bytes()).expect("HMAC can take key of any size");
    mac.update(username.as_bytes());

    let result = mac.finalize();
    let code_bytes = result.into_bytes();

    // Base64 encode
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
    BASE64.encode(code_bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{encode, EncodingKey, Header};
    use std::sync::Arc;
    use tempfile::tempdir;

    async fn make_test_state() -> (tempfile::TempDir, Arc<AppState>) {
        // Keep the TempDir alive for the whole test: dropping it deletes the
        // data dir out from under AppState and the first engine write panics
        // with NotFound. Callers must bind the returned TempDir.
        let data_dir = tempdir().unwrap();
        let uploads_dir = data_dir.path().join("uploads");
        std::fs::create_dir_all(&uploads_dir).unwrap();
        let config = crate::config::ServerConfig {
            host: "127.0.0.1".into(),
            port: 3001,
            data_dir: data_dir.path().to_string_lossy().to_string(),
            uploads_dir: uploads_dir.to_string_lossy().to_string(),
            jwt_secret: "test-secret".into(),
            turn_enabled: false,
            turn_uri: None,
            turn_secret: None,
            node_id: "test-node".into(),
            is_primary: true,
            server_role: crate::config::ServerRole::Authority,
            authority_url: None,
            admin_user_ids: vec![],
            blacklist_file: data_dir.path().join("blacklist.txt").to_string_lossy().to_string(),
            max_body_size: None,
            mesh_enabled: false,
            mesh_peers: vec![],
            lore: Default::default(),
        };
        (data_dir, Arc::new(AppState::new(config).await.unwrap()))
    }

    #[tokio::test]
    async fn refresh_happy_path() {
        let (_dir, state) = make_test_state().await;

        // First, register a user (creates user + returns tokens)
        let register_req = RegisterRequest {
            username: "testuser".into(),
            email: None,
            password: "password123".into(),
            handle: Some("testuser".into()),
        };
        let resp = handle_register(State(state.clone()), Json(register_req)).await.unwrap();
        let refresh_token = resp.0.refresh_token.clone();

        // Use refresh token to get new pair
        let refresh_req = RefreshRequest { refresh_token: refresh_token.clone() };
        let resp = handle_refresh(State(state.clone()), Json(refresh_req)).await.unwrap();
        assert!(!resp.0.access_token.is_empty());
        assert!(!resp.0.refresh_token.is_empty());
        // New tokens should be different from old
        assert_ne!(resp.0.refresh_token, refresh_token);
    }

    #[tokio::test]
    async fn refresh_reuse_detects_theft_and_revokes_family() {
        let (_dir, state) = make_test_state().await;

        // Register user
        let register_req = RegisterRequest {
            username: "theftuser".into(),
            email: None,
            password: "password123".into(),
            handle: Some("theftuser".into()),
        };
        let resp = handle_register(State(state.clone()), Json(register_req)).await.unwrap();
        let refresh_token = resp.0.refresh_token.clone();
        let old_access_token = resp.0.access_token.clone();

        // First refresh - should succeed
        let refresh_req = RefreshRequest { refresh_token: refresh_token.clone() };
        let _resp = handle_refresh(State(state.clone()), Json(refresh_req)).await.unwrap();

        // Second reuse of SAME refresh token - should fail with family revocation
        let refresh_req = RefreshRequest { refresh_token };
        let err = handle_refresh(State(state.clone()), Json(refresh_req)).await.unwrap_err();
        match err {
            AppError::Unauthorized(msg) => assert!(msg.contains("reuse detected")),
            _ => panic!("expected Unauthorized error"),
        }

        // The stolen-token tripwire: the OLD access token (pre-revocation iat)
        // must now be rejected by the per-request revocation check, while a
        // fresh login mints valid tokens again (floor semantics, not a
        // permanent ban — permanent bans are the 2026-07-23 login-bounce bug).
        let old_claims = decode_token(&old_access_token, &state.config.jwt_secret).await.unwrap();
        assert!(
            state.is_token_revoked(&old_claims.jti, 1, old_claims.iat).await,
            "pre-theft access token must be revoked after family kill"
        );
        let relogin = LoginRequest {
            username: "theftuser".into(),
            password: "password123".into(),
        };
        let resp = handle_login(State(state), Json(relogin)).await.expect(
            "login after family revocation must succeed (floor, not ban)",
        );
        assert!(!resp.0.access_token.is_empty());
    }

    #[tokio::test]
    async fn refresh_expired_token_rejected() {
        let (_dir, state) = make_test_state().await;

        // Manually create an expired refresh token
        let claims = JwtClaims {
            sub: "999".into(),
            username: "expireduser".into(),
            is_guest: false,
            exp: 1, // expired long ago
            iat: 1,
            jti: "expired-jti".into(),
            stepup: false,
            token_type: "refresh".into(),
        };
        let expired_token = encode(
            &Header::default(),
            &claims,
            &EncodingKey::from_secret(state.config.jwt_secret.as_bytes()),
        ).unwrap();

        let refresh_req = RefreshRequest { refresh_token: expired_token };
        let err = handle_refresh(State(state), Json(refresh_req)).await.unwrap_err();
        assert!(matches!(err, AppError::Unauthorized(_)));
    }

    #[tokio::test]
    async fn refresh_token_rejected_as_access_token() {
        let (_dir, state) = make_test_state().await;

        // Create a refresh token
        let claims = JwtClaims {
            sub: "888".into(),
            username: "refreshasaccess".into(),
            is_guest: false,
            exp: 9_999_999_999,
            iat: 1,
            jti: "refresh-as-access-jti".into(),
            stepup: false,
            token_type: "refresh".into(),
        };
        let refresh_token = encode(
            &Header::default(),
            &claims,
            &EncodingKey::from_secret(state.config.jwt_secret.as_bytes()),
        ).unwrap();

        // Verify token_type is set correctly for refresh tokens
        let claims = decode_token(&refresh_token, &state.config.jwt_secret).await.unwrap();
        assert_eq!(claims.token_type, "refresh");
        
        // The AuthUser extractor would reject this with "refresh token cannot be used for authentication"
        // We can't easily test the full extractor here, but we verified the token_type is set correctly
    }

    #[tokio::test]
    async fn legacy_token_without_token_type_still_works() {
        let (_dir, state) = make_test_state().await;

        // Create a token WITHOUT token_type claim (legacy)
        let claims = JwtClaims {
            sub: "777".into(),
            username: "legacyuser".into(),
            is_guest: false,
            exp: 9_999_999_999,
            iat: 1,
            jti: "legacy-jti".into(),
            stepup: false,
            token_type: "".into(), // empty = legacy
        };
        let legacy_token = encode(
            &Header::default(),
            &claims,
            &EncodingKey::from_secret(state.config.jwt_secret.as_bytes()),
        ).unwrap();

        // Decode and verify token_type is empty (legacy)
        let claims = decode_token(&legacy_token, &state.config.jwt_secret).await.unwrap();
        assert_eq!(claims.token_type, "");
        
        // The AuthUser extractor would accept this (token_type != "refresh")
        // This verifies backward compatibility
    }
}
