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
        || app
            .get_blacklist()
            .await
            .ok_or_else(invalid)?
            .is_user_banned(record.user_id)
            .await
            .is_some()
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
        iat: record.created_at_micros / 1_000_000,
        is_bot: false,
    })
}

/// Recheck a scoped tool capability after body/membership admission. Call
/// while channel_access's mutation guard retains membership and current
/// credentials; token deletion takes its membership writer. Account and bot
/// credentials already have their lifecycle proof and need no Lore lookup.
pub(super) async fn validate_current_capability(
    state: &AppState,
    auth: &AuthUser,
    channel_id: i64,
    write: bool,
) -> Result<(), AppError> {
    let Some(hash) = auth.jti.strip_prefix("lore-token:") else {
        return Ok(());
    };
    let invalid = || AppError::Unauthorized("invalid or revoked lore connect token".into());
    if hash.len() != 64
        || !hash.bytes().all(|byte| byte.is_ascii_hexdigit())
        || auth.is_bot
        || auth.is_guest
        || auth.user_id <= 0
        || auth.iat < 0
    {
        return Err(invalid());
    }
    let record = state.wdb.lore_get_token(hash).await?.ok_or_else(invalid)?;
    if record.token_hash != hash
        || record.revoked
        || record.user_id != auth.user_id
        || record.channel_id <= 0
        || record.created_at_micros <= 0
        || record.created_at_micros / 1_000_000 != auth.iat
    {
        return Err(invalid());
    }
    let scope = TokenScope::parse(&record.scopes).ok_or_else(invalid)?;
    if record.channel_id != channel_id {
        return Err(AppError::Forbidden(
            "connect token belongs to a different repository".into(),
        ));
    }
    if write && scope != TokenScope::ReadWrite {
        return Err(AppError::Forbidden(
            "this connect token is read-only".into(),
        ));
    }
    crate::auth_extractor::ensure_human_principal(state, auth.user_id).await?;
    let user = state
        .wdb
        .get_user(auth.user_id as u64)
        .await?
        .ok_or_else(invalid)?;
    if user.password_hash.is_empty() || !user.is_registered {
        return Err(invalid());
    }
    let channel = format!("ch_{channel_id:x}");
    if state.wdb.get_channel(&channel).await?.is_none()
        || !crate::channel_access::is_member(state, auth.user_id, &channel).await?
    {
        return Err(AppError::Forbidden(
            "connect token no longer has repository access".into(),
        ));
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{LoreAddonConfig, ServerConfig, ServerRole};
    use wabidb::{
        domain::{ChannelKind, MemberRole},
        projections::lore::{encode_token_record, LoreTokenRecord},
    };

    async fn fixture() -> (tempfile::TempDir, Arc<AppState>, AuthUser, LoreTokenRecord) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path();
        let state = Arc::new(
            AppState::new(ServerConfig {
                host: "127.0.0.1".into(),
                port: 0,
                data_dir: path.to_string_lossy().into_owned(),
                uploads_dir: path.join("uploads").to_string_lossy().into_owned(),
                jwt_secret: "lore-current-capability-fixture".into(),
                turn_enabled: false,
                turn_uri: None,
                turn_secret: None,
                node_id: "fixture".into(),
                is_primary: true,
                server_role: ServerRole::Authority,
                authority_url: None,
                admin_user_ids: vec![],
                blacklist_file: path.join("blacklist.txt").to_string_lossy().into_owned(),
                max_body_size: None,
                mesh_enabled: false,
                mesh_peers: vec![],
                lore: LoreAddonConfig::default(),
            })
            .await
            .unwrap(),
        );
        let uid = state
            .wdb
            .create_user("scoped-human", None, "fixture-hash")
            .await
            .unwrap();
        let channel = state
            .wdb
            .create_channel("scoped-repo", ChannelKind::Lore, uid, false)
            .await
            .unwrap();
        state
            .wdb
            .add_channel_member(&channel, uid, MemberRole::Member)
            .await
            .unwrap();
        let channel_id = i64::from_str_radix(channel.strip_prefix("ch_").unwrap(), 16).unwrap();
        let token = format!("wblore_{}", "d2".repeat(32));
        let hash = hex::encode(Sha256::digest(token.as_bytes()));
        state
            .wdb
            .lore_mint_token(&hash, channel_id, uid as i64, "read,write")
            .await
            .unwrap();
        let auth = authenticate(&state, &token, channel_id, true)
            .await
            .unwrap();
        let record = state.wdb.lore_get_token(&hash).await.unwrap().unwrap();
        (directory, state, auth, record)
    }

    #[tokio::test]
    async fn current_capability_reloads_deleted_revoked_rebound_and_downgraded_records() {
        let (_directory, state, auth, original) = fixture().await;
        let membership = state.membership_gate.clone().read_owned().await;
        let admission = auth.admit_current(&state).await.unwrap();
        validate_current_capability(&state, &auth, original.channel_id, true)
            .await
            .unwrap();
        let projections = state.wdb.engine().projection_state();
        for mutation in [
            "revoked", "user", "channel", "issued", "scope", "hash", "missing",
        ] {
            let mut record = original.clone();
            match mutation {
                "revoked" => record.revoked = true,
                "user" => record.user_id += 1,
                "channel" => record.channel_id += 1,
                "issued" => record.created_at_micros += 1_000_000,
                "scope" => record.scopes = "read".into(),
                "hash" => record.token_hash = "00".repeat(32),
                "missing" => {
                    projections.remove("lore_tokens", original.token_hash.as_bytes());
                }
                _ => unreachable!(),
            }
            if mutation != "missing" {
                projections.insert(
                    "lore_tokens",
                    original.token_hash.as_bytes().to_vec(),
                    encode_token_record(&record),
                    0,
                );
            }
            assert!(
                validate_current_capability(&state, &auth, original.channel_id, true)
                    .await
                    .is_err(),
                "accepted {mutation} capability"
            );
            if mutation == "scope" {
                validate_current_capability(&state, &auth, original.channel_id, false)
                    .await
                    .unwrap();
            }
            projections.insert(
                "lore_tokens",
                original.token_hash.as_bytes().to_vec(),
                encode_token_record(&original),
                0,
            );
        }
        drop(admission);
        drop(membership);
    }

    #[tokio::test]
    async fn scoped_admission_rechecks_legacy_short_token_denial_under_the_current_reader() {
        let (_directory, state, auth, original) = fixture().await;
        drop(auth.admit_current(&state).await.unwrap());
        state
            .revoke_token_with_exp(
                format!("lore-token:{}", &original.token_hash[..12]),
                i64::MAX,
            )
            .await
            .unwrap();
        assert!(matches!(
            auth.admit_current(&state).await,
            Err(AppError::Unauthorized(_))
        ));
    }

    #[tokio::test]
    async fn current_capability_does_not_reacquire_a_reader_behind_a_queued_denial_writer() {
        let (_directory, state, auth, record) = fixture().await;
        let membership = state.membership_gate.clone().read_owned().await;
        let admission = auth.admit_current(&state).await.unwrap();
        let baseline = Arc::strong_count(&state.revocations);
        let writer_state = state.clone();
        let uid = auth.user_id;
        let writer = tokio::spawn(async move {
            writer_state.revoke_user(uid).await.unwrap();
        });
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while Arc::strong_count(&state.revocations) <= baseline {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(!writer.is_finished());
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            validate_current_capability(&state, &auth, record.channel_id, true),
        )
        .await
        .unwrap()
        .unwrap();
        drop(admission);
        drop(membership);
        tokio::time::timeout(std::time::Duration::from_secs(5), writer)
            .await
            .unwrap()
            .unwrap();
    }
}
