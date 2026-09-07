//! Opt-in external-tool capabilities. General AuthUser deliberately rejects
//! Lore tokens; only handlers using these extractors can accept them.
use std::sync::Arc;

use axum::{
    extract::{FromRef, FromRequestParts, Path, State},
    http::{header::AUTHORIZATION, request::Parts},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use wabidb::engine::wabi_store::WabiStore;

use crate::{auth_extractor::AuthUser, error::AppError, state::AppState};

pub(super) struct LoreReadUser(pub AuthUser);
pub(super) struct LoreWriteUser(pub AuthUser);
pub(super) struct OptionalLoreReadUser(pub Option<AuthUser>);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum TokenScope {
    Read,
    ReadWrite,
}

impl TokenScope {
    /// Exact documented scopes, not substring matching ("overwrite" is not write).
    pub(super) fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "read" => Some(Self::Read),
            "write" | "read,write" => Some(Self::ReadWrite),
            _ => None,
        }
    }

    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::ReadWrite => "read,write",
        }
    }
}

#[derive(Deserialize)]
struct RepoPath {
    channel_id: i64,
}

async fn resolve<S>(parts: &mut Parts, state: &S, write: bool) -> Result<AuthUser, Response>
where
    S: Send + Sync,
    Arc<AppState>: FromRef<S>,
{
    let token = parts
        .headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .filter(|v| v.starts_with("wblore_"))
        .map(str::to_owned);
    let Some(token) = token else {
        return AuthUser::from_request_parts(parts, state).await;
    };

    let State(app): State<Arc<AppState>> = State::from_request_parts(parts, state)
        .await
        .map_err(|_| AppError::Internal("missing app state".into()).into_response())?;
    let Path(path) = Path::<RepoPath>::from_request_parts(parts, state)
        .await
        .map_err(IntoResponse::into_response)?;
    authenticate(&app, &token, path.channel_id, write)
        .await
        .map_err(IntoResponse::into_response)
}

async fn authenticate(
    app: &AppState,
    token: &str,
    channel_id: i64,
    write: bool,
) -> Result<AuthUser, AppError> {
    let invalid = || AppError::Unauthorized("invalid or revoked lore connect token".into());
    let secret = token.strip_prefix("wblore_").ok_or_else(invalid)?;
    if secret.len() != 64 || !secret.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(invalid());
    }
    let hash = hex::encode(Sha256::digest(token.as_bytes()));
    let record = app.wdb.lore_get_token(&hash).await?.ok_or_else(invalid)?;
    if record.revoked
        || record.user_id <= 0
        || record.channel_id <= 0
        || record.created_at_micros <= 0
    {
        return Err(invalid());
    }
    let scope = TokenScope::parse(&record.scopes).ok_or_else(invalid)?;
    let jti = format!("lore-token:{hash}");
    // Older AuthUser resolution exposed the short hash as the session ID.
    // Preserve revocations already stored under that identifier on upgrade.
    let legacy_jti = format!("lore-token:{}", &hash[..12]);
    for id in [&jti, &legacy_jti] {
        if app
            .is_token_revoked(id, record.user_id, record.created_at_micros / 1_000_000)
            .await
        {
            return Err(invalid());
        }
    }
    let user = app
        .wdb
        .get_user(record.user_id as u64)
        .await?
        .ok_or_else(invalid)?;
    if !user.is_active
        || user.password_hash.is_empty()
        || app.wdb.is_user_banned(record.user_id as u64).await?
    {
        return Err(invalid());
    }
    if channel_id != record.channel_id {
        return Err(AppError::Forbidden(
            "connect token belongs to a different repository".into(),
        ));
    }
    if write && scope != TokenScope::ReadWrite {
        return Err(AppError::Forbidden(
            "this connect token is read-only".into(),
        ));
    }
    // Token possession never grants membership or resurrects a deleted channel.
    // No owner/admin exemption: a token is explicitly bound to this membership.
    let channel = format!("ch_{channel_id:x}");
    if app.wdb.get_channel(&channel).await?.is_none()
        || !app
            .wdb
            .list_channel_members(&channel)
            .await?
            .iter()
            .any(|m| m.user_id == record.user_id as u64)
    {
        return Err(AppError::Forbidden(
            "connect token no longer has repository access".into(),
        ));
    }
    Ok(AuthUser {
        user_id: record.user_id,
        username: user.username,
        is_guest: false,
        jti,
        exp: i64::MAX,
        is_bot: false,
    })
}

impl<S> FromRequestParts<S> for LoreReadUser
where
    S: Send + Sync,
    Arc<AppState>: FromRef<S>,
{
    type Rejection = Response;
    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Response> {
        resolve(parts, state, false).await.map(Self)
    }
}

impl<S> FromRequestParts<S> for LoreWriteUser
where
    S: Send + Sync,
    Arc<AppState>: FromRef<S>,
{
    type Rejection = Response;
    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Response> {
        resolve(parts, state, true).await.map(Self)
    }
}

impl<S> FromRequestParts<S> for OptionalLoreReadUser
where
    S: Send + Sync,
    Arc<AppState>: FromRef<S>,
{
    type Rejection = Response;
    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Response> {
        // Signed URLs may omit credentials. An explicitly supplied bad or
        // wrong-repository credential must not downgrade to anonymous access.
        if !parts.headers.contains_key(AUTHORIZATION) {
            return Ok(Self(None));
        }
        resolve(parts, state, false)
            .await
            .map(|auth| Self(Some(auth)))
    }
}
