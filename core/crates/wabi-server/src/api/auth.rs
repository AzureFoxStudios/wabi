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

use crate::error::{AppError, Result};
use crate::state::AppState;

/// Create auth router
pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/register", axum::routing::post(handle_register))
        .route("/login", axum::routing::post(handle_login))
        .route("/guest", axum::routing::post(handle_guest))
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

    let existing = state.stdb.get_user(&req.username).await?;
    if !existing.is_empty() {
        return Err(AppError::BadRequest("Username already taken".into()));
    }

    let handle = req.handle.unwrap_or_else(|| req.username.to_lowercase());
    let user_id = state
        .stdb
        .create_user(&req.username, &password_hash)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to create user: {}", e)))?;

    // First registrant on a fresh server automatically becomes the owner.
    state.claim_ownership(user_id, &req.username).await;

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
    let users = state
        .stdb
        .get_user(&req.username)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to fetch user: {}", e)))?;

    tracing::info!(
        "[login] username={} found={}",
        req.username,
        !users.is_empty()
    );

    if users.is_empty() {
        return Err(AppError::Unauthorized(
            "Invalid username or password".into(),
        ));
    }

    let user_row = &users[0];
    let user_id = user_row
        .get("user_id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| AppError::Internal("Invalid user_id format".into()))?;

    let stored_hash = user_row.get("password_hash").and_then(|v| v.as_str());

    // Guest users don't have password_hash - they must use guest login
    if stored_hash.is_none() {
        let is_guest = user_row
            .get("is_guest")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if is_guest {
            tracing::warn!(
                "[login] user={} is guest account, cannot login with password",
                req.username
            );
            return Err(AppError::Unauthorized("This account is guest-only. Use 'Join as Guest' or register a new account with a password.".into()));
        }
        return Err(AppError::Internal("Missing password_hash".into()));
    }
    let stored_hash = stored_hash.unwrap();

    tracing::info!(
        "[login] hash_variant={} hash_cost={}",
        &stored_hash[..4],
        &stored_hash[4..7]
    );

    let verified = bcrypt::verify(&req.password, stored_hash)?;
    tracing::info!(
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
            return Err(AppError::Unauthorized(format!("Account banned: {}. Contact server admin.", entry.reason)));
        }
    }

    let username = user_row
        .get("username")
        .and_then(|v| v.as_str())
        .unwrap_or(&req.username)
        .to_string();
    let handle = user_row
        .get("handle")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let color = user_row
        .get("color")
        .and_then(|v| v.as_str())
        .unwrap_or("#98D8C8")
        .to_string();

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

/// Guest login (no password required)
async fn handle_guest(
    State(state): State<Arc<AppState>>,
    Json(req): Json<GuestRequest>,
) -> Result<Json<AuthResponse>> {
    let username = req
        .username
        .unwrap_or_else(|| format!("Guest_{}", uuid::Uuid::new_v4()));

    let user_id = state
        .stdb
        .create_guest_user(&username)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to create guest user: {}", e)))?;

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

/// JWT claims structure
#[derive(Debug, Serialize, Deserialize)]
struct JwtClaims {
    sub: String, // User ID
    username: String,
    is_guest: bool,
    exp: i64, // Expiration timestamp
    iat: i64, // Issued at timestamp
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
    };

    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(state.config.jwt_secret.as_bytes()),
    )?;

    Ok(token)
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
    struct C { sub: String }

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
    let user_id: i64 = claims.sub.parse().map_err(|_| AppError::Unauthorized("bad sub".into()))?;

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
