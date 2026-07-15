use axum::{
    extract::{FromRequestParts, State},
    http::{header::AUTHORIZATION, request::Parts},
    response::{IntoResponse, Response},
};
use jsonwebtoken::{decode, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::error::AppError;
use crate::state::AppState;

/// Header carrying a short-lived step-up token (issued by POST /api/auth/stepup)
/// that must accompany destructive admin operations.
pub const STEPUP_HEADER: &str = "x-stepup-token";

/// Lifetime of a step-up token, in seconds.
pub const STEPUP_TTL_SECONDS: i64 = 600;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JwtClaims {
    pub sub: String,
    pub username: String,
    pub is_guest: bool,
    pub exp: i64,
    pub iat: i64,
    #[serde(default)]
    pub jti: String,
    /// True only for tokens minted by the step-up endpoint (re-verified password).
    /// Decodes to `false` for ordinary tokens, which never carry this claim.
    #[serde(default)]
    pub stepup: bool,
}

#[derive(Debug, Clone)]
pub struct AuthUser {
    pub user_id: i64,
    pub username: String,
    pub is_guest: bool,
    pub jti: String,
}

impl AuthUser {
    pub fn from_claims(claims: JwtClaims) -> Result<Self, AppError> {
        let user_id = claims
            .sub
            .parse::<i64>()
            .map_err(|_| AppError::Unauthorized("invalid user_id in token".into()))?;
        Ok(Self {
            user_id,
            username: claims.username,
            is_guest: claims.is_guest,
            jti: claims.jti,
        })
    }
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct OptionalAuthUser(pub Option<AuthUser>);

async fn decode_token(token: &str, jwt_secret: &str) -> Result<JwtClaims, AppError> {
    let key = DecodingKey::from_secret(jwt_secret.as_bytes());
    let mut validation = Validation::default();
    validation.validate_exp = true;
    validation.leeway = 60;

    decode::<JwtClaims>(token, &key, &validation)
        .map(|data| data.claims)
        .map_err(|e| AppError::Unauthorized(format!("invalid token: {}", e)))
}

impl<S> FromRequestParts<S> for AuthUser
where
    S: Send + Sync,
    Arc<AppState>: axum::extract::FromRef<S>,
{
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let State(app_state): State<Arc<AppState>> =
            State::from_request_parts(parts, state).await.map_err(|_| {
                AppError::Internal("failed to extract app state".into()).into_response()
            })?;

        let auth_header = parts
            .headers
            .get(AUTHORIZATION)
            .ok_or_else(|| {
                AppError::Unauthorized("missing authorization header".into()).into_response()
            })?
            .to_str()
            .map_err(|_| {
                AppError::Unauthorized("invalid authorization header".into()).into_response()
            })?;

        let token = auth_header.strip_prefix("Bearer ").ok_or_else(|| {
            AppError::Unauthorized("missing Bearer prefix".into()).into_response()
        })?;

        let claims = decode_token(token, &app_state.config.jwt_secret)
            .await
            .map_err(|e| e.into_response())?;

        // Reject revoked tokens (single jti, whole user, or pre-epoch).
        let sub = claims.sub.parse::<i64>().unwrap_or(-1);
        if app_state.is_token_revoked(&claims.jti, sub, claims.iat).await {
            return Err(AppError::Unauthorized("token revoked".into()).into_response());
        }

        AuthUser::from_claims(claims).map_err(|e| e.into_response())
    }
}

impl<S> FromRequestParts<S> for OptionalAuthUser
where
    S: Send + Sync,
    Arc<AppState>: axum::extract::FromRef<S>,
{
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let State(app_state): State<Arc<AppState>> =
            State::from_request_parts(parts, state).await.map_err(|_| {
                AppError::Internal("failed to extract app state".into()).into_response()
            })?;

        let Some(auth_header) = parts.headers.get(AUTHORIZATION) else {
            return Ok(OptionalAuthUser(None));
        };

        let auth_str = match auth_header.to_str() {
            Ok(s) => s,
            Err(_) => return Ok(OptionalAuthUser(None)),
        };

        let Some(token) = auth_str.strip_prefix("Bearer ") else {
            return Ok(OptionalAuthUser(None));
        };

        match decode_token(token, &app_state.config.jwt_secret).await {
            Ok(claims) => match AuthUser::from_claims(claims) {
                Ok(user) => Ok(OptionalAuthUser(Some(user))),
                Err(_) => Ok(OptionalAuthUser(None)),
            },
            Err(_) => Ok(OptionalAuthUser(None)),
        }
    }
}

/// Verify a step-up token: a valid, non-expired JWT whose `stepup` claim is true
/// and whose subject matches `expected_user_id`. Used to gate destructive admin
/// operations so that a stolen long-lived bearer token alone is not enough.
pub async fn verify_stepup_token(
    secret: &str,
    token: &str,
    expected_user_id: i64,
) -> Result<(), AppError> {
    let claims = decode_token(token, secret).await?;
    if !claims.stepup {
        return Err(AppError::Unauthorized(
            "not a step-up token (re-authenticate via /api/auth/stepup)".into(),
        ));
    }
    let sub = claims
        .sub
        .parse::<i64>()
        .map_err(|_| AppError::Unauthorized("invalid user_id in token".into()))?;
    if sub != expected_user_id {
        return Err(AppError::Unauthorized(
            "step-up token subject does not match authenticated user".into(),
        ));
    }
    Ok(())
}

#[allow(dead_code)]
pub async fn extract_user_id(
    headers: &axum::http::HeaderMap,
    jwt_secret: &str,
) -> Result<i64, AppError> {
    let auth = headers
        .get(AUTHORIZATION)
        .ok_or_else(|| AppError::Unauthorized("missing authorization header".into()))?
        .to_str()
        .map_err(|_| AppError::Unauthorized("invalid authorization header".into()))?;
    let token = auth
        .strip_prefix("Bearer ")
        .ok_or_else(|| AppError::Unauthorized("missing Bearer prefix".into()))?;
    let claims = decode_token(token, jwt_secret).await?;
    claims
        .sub
        .parse::<i64>()
        .map_err(|_| AppError::Unauthorized("invalid user_id in token".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{encode, EncodingKey, Header};

    fn make_token(secret: &str, sub: &str, stepup: bool) -> String {
        let claims = JwtClaims {
            sub: sub.to_string(),
            username: "tester".into(),
            is_guest: false,
            exp: 9_999_999_999, // far-future; keeps test independent of clocks
            iat: 1,
            jti: "test-jti".into(),
            stepup,
        };
        encode(
            &Header::default(),
            &claims,
            &EncodingKey::from_secret(secret.as_bytes()),
        )
        .unwrap()
    }

    #[tokio::test]
    async fn stepup_valid_token_passes() {
        let secret = "unit-test-secret";
        let tok = make_token(secret, "42", true);
        assert!(verify_stepup_token(secret, &tok, 42).await.is_ok());
    }

    #[tokio::test]
    async fn stepup_missing_claim_fails() {
        let secret = "unit-test-secret";
        // A normal bearer token must NOT satisfy step-up.
        let tok = make_token(secret, "42", false);
        assert!(verify_stepup_token(secret, &tok, 42).await.is_err());
    }

    #[tokio::test]
    async fn stepup_wrong_subject_fails() {
        let secret = "unit-test-secret";
        let tok = make_token(secret, "42", true);
        // Token minted for user 42 cannot authorize actions for user 7.
        assert!(verify_stepup_token(secret, &tok, 7).await.is_err());
    }

    #[tokio::test]
    async fn stepup_wrong_secret_fails() {
        let secret = "unit-test-secret";
        let tok = make_token(secret, "42", true);
        assert!(verify_stepup_token("other-secret", &tok, 42).await.is_err());
    }
}
