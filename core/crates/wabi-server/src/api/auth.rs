//! Authentication routes
//!
//! Implements:
//! - POST /api/auth/register
//! - POST /api/auth/login
//! - POST /api/auth/guest

use axum::{extract::State, Json, Router};
use chrono::{Duration, Utc};
use jsonwebtoken::{encode, EncodingKey, Header};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::auth_extractor::AuthUser;
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

/// Auth response — matches frontend AuthResponse contract
#[derive(Debug, Serialize)]
struct AuthResponse {
    token: String,
    #[serde(rename = "mustChangePassword")]
    must_change_password: bool,
    user: AuthUserProfile,
}

/// Register a new user
async fn handle_register(
    State(state): State<Arc<AppState>>,
    Json(req): Json<RegisterRequest>,
) -> Result<Json<AuthResponse>> {
    let auth_policy = load_auth_policy(&state);
    if auth_policy.get("allowRegister").and_then(Value::as_bool) == Some(false) {
        return Err(AppError::Forbidden("Registration is closed on this server".into()));
    }
    if auth_policy.get("mode").and_then(Value::as_str) == Some("invite") {
        return Err(AppError::Forbidden("An invite is required to register on this server".into()));
    }
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

    let token = generate_jwt(&state, user_id, &req.username)?;

    Ok(Json(AuthResponse {
        token,
        must_change_password: false,
        user: AuthUserProfile {
            id: user_id,
            username: req.username,
            handle: Some(handle),
            color: "#98D8C8".to_string(),
            is_registered: true,
        },
    }))
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

    let token = generate_jwt(&state, user_id, &username)?;

    Ok(Json(AuthResponse {
        token,
        must_change_password: false,
        user: AuthUserProfile {
            id: user_id,
            username,
            handle,
            color,
            is_registered: true,
        },
    }))
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
    state.revoke_token(auth.jti).await;
    Ok(Json(json!({ "success": true })))
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
    Json(req): Json<GuestRequest>,
) -> Result<Json<AuthResponse>> {
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

    let token = generate_guest_jwt(&state, user_id, &username)?;

    Ok(Json(AuthResponse {
        token,
        must_change_password: false,
        user: AuthUserProfile {
            id: user_id,
            username: username.clone(),
            handle: Some(username.to_lowercase()),
            color: "#98D8C8".to_string(),
            is_registered: false,
        },
    }))
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
}

/// Generate JWT token for authenticated user
fn generate_jwt(state: &AppState, user_id: i64, username: &str) -> Result<String> {
    let now = Utc::now();
    let expiration = now + Duration::days(30);

    let claims = JwtClaims {
        sub: user_id.to_string(),
        username: username.to_string(),
        is_guest: false,
        exp: expiration.timestamp(),
        iat: now.timestamp(),
        jti: uuid::Uuid::new_v4().to_string(),
        stepup: false,
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

/// Generate short-lived JWT for guest users
fn generate_guest_jwt(state: &AppState, user_id: i64, username: &str) -> Result<String> {
    let now = Utc::now();
    let expiration = now + Duration::hours(24); // Guests expire after 24 hours

    let claims = JwtClaims {
        sub: user_id.to_string(),
        username: username.to_string(),
        is_guest: true,
        exp: expiration.timestamp(),
        iat: now.timestamp(),
        jti: uuid::Uuid::new_v4().to_string(),
        stepup: false,
    };

    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(state.config.jwt_secret.as_bytes()),
    )?;

    Ok(token)
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
    headers: axum::http::HeaderMap,
    axum::extract::Query(query): axum::extract::Query<TurnCredentialsQuery>,
) -> Result<Json<TurnCredentialsResponse>> {
    use jsonwebtoken::{decode, DecodingKey, Validation};
    #[derive(serde::Deserialize)]
    struct C {
        sub: String,
    }

    // Require valid auth token
    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer ").map(str::to_owned))
        .ok_or_else(|| AppError::Unauthorized("missing token".into()))?;
    let key = DecodingKey::from_secret(state.config.jwt_secret.as_bytes());
    let mut v = Validation::default();
    v.validate_exp = true;
    v.leeway = 60;
    let claims = decode::<C>(&auth, &key, &v)
        .map_err(|_| AppError::Unauthorized("invalid token".into()))?
        .claims;
    let user_id: i64 = claims
        .sub
        .parse()
        .map_err(|_| AppError::Unauthorized("bad sub".into()))?;

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
