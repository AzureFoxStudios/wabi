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
use wabidb::engine::wabi_store::WabiStore;

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
    /// Token type: "access" or "refresh". Missing = legacy access token (backward compat).
    #[serde(default)]
    pub token_type: String,
}

#[derive(Debug, Clone)]
pub struct AuthUser {
    pub user_id: i64,
    pub username: String,
    pub is_guest: bool,
    /// Account token ID, or the SHA-256 fingerprint of an opaque bot token.
    /// Bot credentials never use account JWT revocation floors.
    pub jti: String,
    /// The token's own `exp` (unix seconds) — carried so logout can store a
    /// prunable expiry with the revoked jti instead of an immortal entry.
    pub exp: i64,
    /// Issuance time retained for rechecking a credential at a mutation boundary.
    pub iat: i64,
    /// True when authenticated with an opaque `Bot <token>` credential.
    pub is_bot: bool,
}

enum CurrentCredentialGuard {
    Account {
        _guard: tokio::sync::OwnedRwLockReadGuard<crate::state::RevocationStore>,
    },
    Bot {
        _guard: crate::bot_registry::BotCredentialGuard,
    },
}

/// Retained proof for a mutation admitted after its body/membership wait.
pub(crate) struct CurrentAuthorizationGuard {
    _credential: CurrentCredentialGuard,
}

impl CurrentAuthorizationGuard {
    /// Use the retained registry snapshot for bot callers. Reacquiring a
    /// reader would wait behind rotation while still holding its first reader.
    pub(crate) async fn is_bot_user(&self, state: &AppState, user_id: u64) -> bool {
        match &self._credential {
            CurrentCredentialGuard::Account { .. } => state.bot_registry.is_bot(user_id).await,
            CurrentCredentialGuard::Bot { _guard: guard } => guard.is_bot_user(user_id),
        }
    }

    /// Validate an already signature-checked step-up proof at the mutation
    /// boundary without reacquiring a reader behind a pending denial writer.
    pub(crate) fn validate_stepup(
        &self,
        claims: &JwtClaims,
        expected_user_id: i64,
    ) -> Result<(), AppError> {
        validate_stepup_claims(claims, expected_user_id)?;
        let CurrentCredentialGuard::Account { _guard: guard } = &self._credential else {
            return Err(AppError::Unauthorized(
                "Account step-up authentication required".into(),
            ));
        };
        if claims.exp.saturating_add(60) < chrono::Utc::now().timestamp() {
            return Err(AppError::Unauthorized("Step-up proof expired".into()));
        }
        if guard.is_revoked(&claims.jti, expected_user_id, claims.iat) {
            return Err(AppError::Unauthorized(
                "step-up token has been revoked; re-authenticate".into(),
            ));
        }
        Ok(())
    }

    /// The owned worker holds authorization through admitted durable work,
    /// even when its request disappears. Move any membership guard into the
    /// supplied future too, preserving membership -> credentials lock order.
    pub(crate) async fn run<T, Fut>(self, state: &AppState, operation: Fut) -> Result<T, AppError>
    where
        T: Send + 'static,
        Fut: std::future::Future<Output = Result<T, AppError>> + Send + 'static,
    {
        state
            .instance_operations
            .spawn(async move {
                let _authorization = self;
                operation.await
            })
            .await
            .map_err(|_| AppError::Internal("Authorized mutation task failed".into()))?
    }
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
            exp: claims.exp,
            iat: claims.iat,
            is_bot: false,
        })
    }

    /// Recheck the original credential after a body or membership wait. Hold
    /// the returned proof through the complete mutation, using `run` when its
    /// durable command can continue after caller cancellation.
    pub(crate) async fn admit_current(
        &self,
        state: &AppState,
    ) -> Result<CurrentAuthorizationGuard, AppError> {
        let denied = || AppError::Unauthorized("Credential is no longer valid".into());
        if self.user_id <= 0 {
            return Err(denied());
        }
        let credential = if self.is_bot {
            let guard = state
                .bot_registry
                .admit_fingerprint(self.user_id as u64, &self.jti)
                .await
                .ok_or_else(denied)?;
            ensure_active_principal(state, self.user_id).await?;
            CurrentCredentialGuard::Bot { _guard: guard }
        } else {
            let guard = state.revocations.clone().read_owned().await;
            if self.iat < 0
                || self.exp.saturating_add(60) < chrono::Utc::now().timestamp()
                || guard.is_revoked(&self.jti, self.user_id, self.iat)
            {
                return Err(denied());
            }
            // Scoped Lore extraction historically used a shortened identifier.
            // Check that denial under this already-held reader, never by
            // reacquiring a reader behind a queued credential writer.
            if let Some(hash) = self.jti.strip_prefix("lore-token:") {
                if hash.len() != 64
                    || !hash.bytes().all(|byte| byte.is_ascii_hexdigit())
                    || guard.is_revoked(
                        &format!("lore-token:{}", &hash[..12]),
                        self.user_id,
                        self.iat,
                    )
                {
                    return Err(denied());
                }
            }
            ensure_human_principal(state, self.user_id).await?;
            CurrentCredentialGuard::Account { _guard: guard }
        };
        let blacklist = state
            .get_blacklist()
            .await
            .ok_or_else(|| AppError::Internal("Ban enforcement unavailable".into()))?;
        if blacklist.is_user_banned(self.user_id).await.is_some() {
            return Err(denied());
        }
        Ok(CurrentAuthorizationGuard {
            _credential: credential,
        })
    }
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct OptionalAuthUser(pub Option<AuthUser>);

pub async fn decode_token(token: &str, jwt_secret: &str) -> Result<JwtClaims, AppError> {
    let key = DecodingKey::from_secret(jwt_secret.as_bytes());
    let mut validation = Validation::default();
    validation.validate_exp = true;
    validation.leeway = 60;

    decode::<JwtClaims>(token, &key, &validation)
        .map(|data| data.claims)
        .map_err(|e| AppError::Unauthorized(format!("invalid token: {}", e)))
}

/// Account bearer authentication shared by HTTP and the call-state socket.
/// Scoped tool, refresh and step-up credentials are not access credentials.
pub async fn authenticate_access_token(
    state: &AppState,
    token: &str,
) -> Result<AuthUser, AppError> {
    let claims = decode_token(token, &state.config.jwt_secret).await?;
    if !matches!(claims.token_type.as_str(), "" | "access") || claims.stepup {
        return Err(AppError::Unauthorized(
            "Account access token required".into(),
        ));
    }
    let uid = claims.sub.parse::<i64>().unwrap_or(0);
    if uid <= 0 || claims.iat < 0 || state.is_token_revoked(&claims.jti, uid, claims.iat).await {
        return Err(AppError::Unauthorized(
            "Invalid or revoked account token".into(),
        ));
    }
    ensure_human_principal(state, uid).await?;
    let blacklist = state
        .get_blacklist()
        .await
        .ok_or_else(|| AppError::Internal("Ban enforcement unavailable".into()))?;
    if blacklist.is_user_banned(uid).await.is_some() {
        return Err(AppError::Unauthorized(
            "Account banned from this server".into(),
        ));
    }
    AuthUser::from_claims(claims)
}

/// A valid signature cannot authenticate a deleted or inactive account.
/// Password-less guest and bot rows are legitimate principals.
pub(crate) async fn ensure_active_principal(
    state: &AppState,
    user_id: i64,
) -> Result<(), AppError> {
    if user_id <= 0 {
        return Err(AppError::Unauthorized("Invalid account".into()));
    }
    match state.wdb.get_user(user_id as u64).await? {
        Some(user) if user.is_active => Ok(()),
        _ => Err(AppError::Unauthorized("Account is unavailable".into())),
    }
}

/// Bot registration is sticky across rotation/disable. It must not be
/// bypassed by supplying a signed human JWT for the same database user ID.
pub(crate) async fn ensure_human_principal(state: &AppState, user_id: i64) -> Result<(), AppError> {
    ensure_active_principal(state, user_id).await?;
    if state.bot_registry.is_bot(user_id as u64).await {
        return Err(AppError::Unauthorized(
            "Human account authentication required".into(),
        ));
    }
    Ok(())
}

/// Resolve a `Bot <opaque-token>` credential against the bot registry and
/// build the corresponding `AuthUser`. Returns Ok(None) for unknown/disabled
/// tokens, Err when the bot account row cannot be loaded.
async fn bot_auth_user(app_state: &AppState, token: &str) -> Result<Option<AuthUser>, AppError> {
    let Some(bot_user_id) = app_state.bot_registry.authenticate(token).await else {
        return Ok(None);
    };
    let blacklist = app_state
        .get_blacklist()
        .await
        .ok_or_else(|| AppError::Internal("Ban enforcement unavailable".into()))?;
    if blacklist.is_user_banned(bot_user_id as i64).await.is_some() {
        return Ok(None);
    }
    let username = match app_state.wdb.get_user(bot_user_id).await {
        Ok(Some(user)) if user.is_active => user.username,
        Ok(Some(_)) => return Ok(None),
        Ok(None) => return Ok(None),
        Err(e) => {
            return Err(AppError::Internal(format!(
                "failed to load bot user {bot_user_id}: {e}"
            )));
        }
    };
    Ok(Some(AuthUser {
        user_id: bot_user_id as i64,
        username,
        is_guest: false,
        jti: crate::bot_registry::BotRegistry::hash_token(token),
        exp: i64::MAX,
        iat: 0,
        is_bot: true,
    }))
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

        // Bot credentials: `Bot <opaque-token>` — resolved against the bot
        // registry, never a JWT. The token only ever authenticates the bot
        // account it was minted for.
        if let Some(bot_token) = auth_header.strip_prefix("Bot ") {
            return match bot_auth_user(&app_state, bot_token).await {
                Ok(Some(auth)) => Ok(auth),
                Ok(None) => Err(AppError::Unauthorized("invalid bot token".into()).into_response()),
                Err(e) => Err(e.into_response()),
            };
        }

        let token = auth_header.strip_prefix("Bearer ").ok_or_else(|| {
            AppError::Unauthorized("missing Bearer prefix".into()).into_response()
        })?;

        // Account authentication accepts JWTs only here. Scoped external-tool
        // credentials must opt in through api::lore_auth, never this extractor.
        authenticate_access_token(&app_state, token)
            .await
            .map_err(IntoResponse::into_response)
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
            // Also accept `Bot <opaque-token>` credentials.
            if let Some(bot_token) = auth_str.strip_prefix("Bot ") {
                return Ok(OptionalAuthUser(
                    bot_auth_user(&app_state, bot_token).await.unwrap_or(None),
                ));
            }
            return Ok(OptionalAuthUser(None));
        };

        Ok(OptionalAuthUser(
            authenticate_access_token(&app_state, token).await.ok(),
        ))
    }
}

/// Verify a step-up token: a valid, non-expired, non-revoked JWT whose `stepup` claim is true
/// and whose subject matches `expected_user_id`. Used to gate destructive admin
/// operations so that a stolen long-lived bearer token alone is not enough.
pub async fn verify_stepup_token(
    state: &AppState,
    token: &str,
    expected_user_id: i64,
) -> Result<(), AppError> {
    let claims = decode_token(token, &state.config.jwt_secret).await?;
    validate_stepup_claims(&claims, expected_user_id)?;
    let sub = expected_user_id;
    if state.is_token_revoked(&claims.jti, sub, claims.iat).await {
        return Err(AppError::Unauthorized(
            "step-up token has been revoked; re-authenticate".into(),
        ));
    }
    Ok(())
}

pub(crate) fn validate_stepup_claims(
    claims: &JwtClaims,
    expected_user_id: i64,
) -> Result<(), AppError> {
    if !claims.stepup || !matches!(claims.token_type.as_str(), "" | "access") || claims.is_guest {
        return Err(AppError::Unauthorized(
            "not a step-up token (re-authenticate via /api/auth/stepup)".into(),
        ));
    }
    let sub = claims
        .sub
        .parse::<i64>()
        .map_err(|_| AppError::Unauthorized("invalid user_id in token".into()))?;
    if sub <= 0 || sub != expected_user_id || claims.iat < 0 {
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

    async fn state(secret: &str) -> (tempfile::TempDir, AppState) {
        use crate::config::{LoreAddonConfig, ServerConfig, ServerRole};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        let state = AppState::new(ServerConfig {
            host: "127.0.0.1".into(),
            port: 0,
            data_dir: path.to_string_lossy().into_owned(),
            uploads_dir: path.join("uploads").to_string_lossy().into_owned(),
            jwt_secret: secret.into(),
            turn_enabled: false,
            turn_uri: None,
            turn_secret: None,
            node_id: "stepup-test".into(),
            is_primary: true,
            server_role: ServerRole::Authority,
            authority_url: None,
            admin_user_ids: vec![],
            blacklist_file: path.join("blacklist").to_string_lossy().into_owned(),
            max_body_size: None,
            mesh_enabled: false,
            mesh_peers: vec![],
            lore: LoreAddonConfig::default(),
        })
        .await
        .unwrap();
        (dir, state)
    }

    fn make_token(secret: &str, sub: &str, stepup: bool) -> String {
        let claims = JwtClaims {
            sub: sub.to_string(),
            username: "tester".into(),
            is_guest: false,
            exp: 9_999_999_999, // far-future; keeps test independent of clocks
            iat: 1,
            jti: "test-jti".into(),
            stepup,
            token_type: "access".into(),
        };
        encode(
            &Header::default(),
            &claims,
            &EncodingKey::from_secret(secret.as_bytes()),
        )
        .unwrap()
    }

    #[tokio::test]
    async fn queued_admission_rechecks_account_expiry_denials_bans_and_current_principal() {
        for scope in ["token", "user", "global", "expired", "ban", "deleted"] {
            let secret = "current-admission-fixture";
            let (_directory, state) = state(secret).await;
            let uid = state
                .wdb
                .create_user("current-account", None, "hash")
                .await
                .unwrap();
            let token = make_token(secret, &uid.to_string(), false);
            let mut auth = authenticate_access_token(&state, &token).await.unwrap();
            drop(auth.admit_current(&state).await.unwrap());
            match scope {
                "token" => state
                    .revoke_token_with_exp(auth.jti.clone(), auth.exp)
                    .await
                    .unwrap(),
                "user" => state.revoke_user(uid as i64).await.unwrap(),
                "global" => state.revoke_all_tokens().await.unwrap(),
                "expired" => auth.exp = chrono::Utc::now().timestamp() - 61,
                "ban" => state
                    .get_blacklist()
                    .await
                    .unwrap()
                    .add_user(uid as i64, "fixture", None)
                    .await
                    .unwrap(),
                "deleted" => state.wdb.delete_user(uid).await.unwrap(),
                _ => unreachable!(),
            }
            assert!(
                matches!(
                    auth.admit_current(&state).await,
                    Err(AppError::Unauthorized(_))
                ),
                "accepted stale {scope} proof"
            );
        }
    }

    #[tokio::test]
    async fn held_account_guard_checks_current_stepup_purpose_expiry_subject_and_denial() {
        let secret = "held-stepup-fixture";
        let (_directory, state) = state(secret).await;
        let uid = state
            .wdb
            .create_user("stepup-account", None, "hash")
            .await
            .unwrap();
        let auth = authenticate_access_token(&state, &make_token(secret, &uid.to_string(), false))
            .await
            .unwrap();
        let mut stepup = decode_token(&make_token(secret, &uid.to_string(), true), secret)
            .await
            .unwrap();
        stepup.jti = "separate-stepup-proof".into();
        let admission = auth.admit_current(&state).await.unwrap();
        admission.validate_stepup(&stepup, uid as i64).unwrap();
        for invalid in ["purpose", "expired", "subject", "guest"] {
            let mut claims = stepup.clone();
            match invalid {
                "purpose" => claims.token_type = "refresh".into(),
                "expired" => claims.exp = chrono::Utc::now().timestamp() - 61,
                "subject" => claims.sub = (uid + 1).to_string(),
                "guest" => claims.is_guest = true,
                _ => unreachable!(),
            }
            assert!(
                admission.validate_stepup(&claims, uid as i64).is_err(),
                "accepted {invalid} proof"
            );
        }
        drop(admission);
        state
            .revoke_token_with_exp(stepup.jti.clone(), stepup.exp)
            .await
            .unwrap();
        let admission = auth.admit_current(&state).await.unwrap();
        assert!(admission.validate_stepup(&stepup, uid as i64).is_err());
        drop(admission);
        let bot = state
            .wdb
            .create_user("stepup-service-only", None, "")
            .await
            .unwrap();
        let (opaque, _) = state.bot_registry.create(bot).await.unwrap();
        let auth = bot_auth_user(&state, &opaque).await.unwrap().unwrap();
        let admission = auth.admit_current(&state).await.unwrap();
        let mut service_proof = stepup;
        service_proof.sub = bot.to_string();
        assert!(admission
            .validate_stepup(&service_proof, bot as i64)
            .is_err());
    }

    #[tokio::test]
    async fn held_bot_guard_classifies_members_without_reentering_a_queued_registry_writer() {
        let secret = "held-bot-classification-fixture";
        let (_directory, state) = state(secret).await;
        let state = Arc::new(state);
        let human = state
            .wdb
            .create_user("member-human", None, "hash")
            .await
            .unwrap();
        let bot = state.wdb.create_user("member-bot", None, "").await.unwrap();
        let disabled = state
            .wdb
            .create_user("member-disabled-bot", None, "")
            .await
            .unwrap();
        let (opaque, _) = state.bot_registry.create(bot).await.unwrap();
        state.bot_registry.create(disabled).await.unwrap();
        state.bot_registry.disable(disabled).await.unwrap();
        let auth = bot_auth_user(&state, &opaque).await.unwrap().unwrap();
        let admission = auth.admit_current(&state).await.unwrap();
        let writer_state = state.clone();
        let rotation = tokio::spawn(async move { writer_state.bot_registry.rotate(bot).await });
        // A newly requested reader can queue only once the writer is actually
        // waiting behind the admitted reader, not merely spawned.
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let reader = state.bot_registry.is_bot(bot);
                tokio::pin!(reader);
                if futures::poll!(reader.as_mut()).is_pending() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            assert!(admission.is_bot_user(&state, bot).await);
            assert!(admission.is_bot_user(&state, disabled).await);
            assert!(!admission.is_bot_user(&state, human).await);
            assert!(!admission.is_bot_user(&state, u64::MAX).await);
        })
        .await
        .unwrap();
        assert!(!rotation.is_finished());
        drop(admission);
        tokio::time::timeout(std::time::Duration::from_secs(5), rotation)
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .unwrap();
        let human_auth =
            authenticate_access_token(&state, &make_token(secret, &human.to_string(), false))
                .await
                .unwrap();
        let human_guard = human_auth.admit_current(&state).await.unwrap();
        assert!(human_guard.is_bot_user(&state, bot).await);
        assert!(human_guard.is_bot_user(&state, disabled).await);
        assert!(!human_guard.is_bot_user(&state, human).await);
    }

    #[tokio::test]
    async fn bot_admission_rechecks_original_fingerprint_without_applying_account_floors() {
        for action in ["rotate", "disable"] {
            let (_directory, state) = state("current-bot-fixture").await;
            let uid = state
                .wdb
                .create_user("current-bot", None, "")
                .await
                .unwrap();
            let (opaque, _) = state.bot_registry.create(uid).await.unwrap();
            let auth = bot_auth_user(&state, &opaque).await.unwrap().unwrap();
            assert_eq!(auth.jti.len(), 64);
            assert_ne!(auth.jti, opaque);
            state.revoke_user(uid as i64).await.unwrap();
            state.revoke_all_tokens().await.unwrap();
            drop(auth.admit_current(&state).await.unwrap());
            match action {
                "rotate" => {
                    let next = state.bot_registry.rotate(uid).await.unwrap().unwrap();
                    let current = bot_auth_user(&state, &next).await.unwrap().unwrap();
                    drop(current.admit_current(&state).await.unwrap());
                }
                "disable" => {
                    state.bot_registry.disable(uid).await.unwrap();
                }
                _ => unreachable!(),
            }
            assert!(matches!(
                auth.admit_current(&state).await,
                Err(AppError::Unauthorized(_))
            ));
        }
    }

    #[tokio::test]
    async fn cancellation_retains_account_and_bot_admission_through_actual_durable_completion() {
        for bot in [false, true] {
            let secret = "owned-current-admission-fixture";
            let (_directory, state) = state(secret).await;
            let state = Arc::new(state);
            let uid = state
                .wdb
                .create_user("admitted-principal", None, if bot { "" } else { "hash" })
                .await
                .unwrap();
            let auth = if bot {
                let (opaque, _) = state.bot_registry.create(uid).await.unwrap();
                bot_auth_user(&state, &opaque).await.unwrap().unwrap()
            } else {
                authenticate_access_token(&state, &make_token(secret, &uid.to_string(), false))
                    .await
                    .unwrap()
            };
            let membership = state.membership_gate.clone().read_owned().await;
            let admission = auth.admit_current(&state).await.unwrap();
            let (started, ready) = tokio::sync::oneshot::channel();
            let (release, released) = tokio::sync::oneshot::channel();
            let request_state = state.clone();
            let mutation_state = state.clone();
            let request = tokio::spawn(async move {
                admission
                    .run(&request_state, async move {
                        let _membership = membership;
                        let _ = started.send(());
                        released.await.unwrap();
                        Ok(mutation_state
                            .wdb
                            .create_user("published-after-caller-cancel", None, "hash")
                            .await?)
                    })
                    .await
            });
            ready.await.unwrap();
            let baseline = if bot {
                state.bot_registry.ownership_count()
            } else {
                Arc::strong_count(&state.revocations)
            };
            let transition_state = state.clone();
            let transition = tokio::spawn(async move {
                if bot {
                    transition_state.bot_registry.rotate(uid).await.unwrap();
                } else {
                    transition_state
                        .revoke_token_with_exp(auth.jti, auth.exp)
                        .await
                        .unwrap();
                }
            });
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                loop {
                    let owners = if bot {
                        state.bot_registry.ownership_count()
                    } else {
                        Arc::strong_count(&state.revocations)
                    };
                    if owners > baseline {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            assert!(
                !transition.is_finished(),
                "credential mutation overtook admitted write"
            );
            request.abort();
            let _ = request.await;
            assert!(
                !transition.is_finished(),
                "caller cancellation released authorization"
            );
            assert!(
                if bot {
                    state.bot_registry.credential_write_blocked()
                } else {
                    state.revocations.try_write().is_err()
                },
                "owned worker lost its credential reader"
            );
            assert!(
                state.membership_gate.try_write().is_err(),
                "caller cancellation released membership before completion"
            );
            release.send(()).unwrap();
            tokio::time::timeout(std::time::Duration::from_secs(5), transition)
                .await
                .unwrap()
                .unwrap();
            assert!(state
                .wdb
                .get_user_by_username("published-after-caller-cancel")
                .await
                .unwrap()
                .is_some());
            assert!(
                state.membership_gate.try_write().is_ok(),
                "cancelled request leaked membership guard"
            );
        }
    }

    #[tokio::test]
    async fn bot_registration_rejects_human_jwts_even_after_bot_disable() {
        let secret = "bot-principal-fixture";
        let (_directory, state) = state(secret).await;
        let bot = state
            .wdb
            .create_user("service-only", None, "historically-reset-hash")
            .await
            .unwrap();
        let (opaque, _) = state.bot_registry.create(bot).await.unwrap();
        let human = make_token(secret, &bot.to_string(), false);
        assert!(authenticate_access_token(&state, &human).await.is_err());
        assert!(bot_auth_user(&state, &opaque).await.unwrap().is_some());
        state.bot_registry.disable(bot).await.unwrap();
        assert!(authenticate_access_token(&state, &human).await.is_err());
        assert!(bot_auth_user(&state, &opaque).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn deleted_guest_and_bot_principals_cannot_keep_authenticating() {
        let secret = "deleted-principal-fixture";
        let (_directory, state) = state(secret).await;
        let guest = state
            .wdb
            .create_user("temporary-guest", None, "")
            .await
            .unwrap();
        let mut claims = decode_token(&make_token(secret, &guest.to_string(), false), secret)
            .await
            .unwrap();
        claims.is_guest = true;
        let access = encode(
            &Header::default(),
            &claims,
            &EncodingKey::from_secret(secret.as_bytes()),
        )
        .unwrap();
        assert!(authenticate_access_token(&state, &access).await.is_ok());
        state.wdb.delete_user(guest).await.unwrap();
        assert!(authenticate_access_token(&state, &access).await.is_err());
        let bot = state
            .wdb
            .create_user("temporary-bot", None, "")
            .await
            .unwrap();
        let (token, _) = state.bot_registry.create(bot).await.unwrap();
        assert!(bot_auth_user(&state, &token).await.unwrap().is_some());
        state.wdb.delete_user(bot).await.unwrap();
        assert!(bot_auth_user(&state, &token).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn stepup_valid_token_passes() {
        let secret = "unit-test-secret";
        let tok = make_token(secret, "42", true);
        let (_dir, state) = state(secret).await;
        assert!(verify_stepup_token(&state, &tok, 42).await.is_ok());
    }

    #[tokio::test]
    async fn stepup_missing_claim_fails() {
        let secret = "unit-test-secret";
        // A normal bearer token must NOT satisfy step-up.
        let tok = make_token(secret, "42", false);
        let (_dir, state) = state(secret).await;
        assert!(verify_stepup_token(&state, &tok, 42).await.is_err());
    }

    #[tokio::test]
    async fn stepup_wrong_subject_fails() {
        let secret = "unit-test-secret";
        let tok = make_token(secret, "42", true);
        // Token minted for user 42 cannot authorize actions for user 7.
        let (_dir, state) = state(secret).await;
        assert!(verify_stepup_token(&state, &tok, 7).await.is_err());
    }

    #[tokio::test]
    async fn stepup_wrong_secret_fails() {
        let secret = "unit-test-secret";
        let tok = make_token(secret, "42", true);
        let (_dir, state) = state("other-secret").await;
        assert!(verify_stepup_token(&state, &tok, 42).await.is_err());
    }

    #[tokio::test]
    async fn stepup_rechecks_token_user_and_global_revocations() {
        let secret = "stepup-revocation-fixture";
        for scope in ["token", "user", "global"] {
            let (_dir, state) = state(secret).await;
            let token = make_token(secret, "42", true);
            assert!(verify_stepup_token(&state, &token, 42).await.is_ok());
            match scope {
                "token" => state
                    .revoke_token_with_exp("test-jti".into(), 9_999_999_999)
                    .await
                    .unwrap(),
                "user" => state.revoke_user(42).await.unwrap(),
                "global" => state.revoke_all_tokens().await.unwrap(),
                _ => unreachable!(),
            }
            assert!(
                verify_stepup_token(&state, &token, 42).await.is_err(),
                "accepted {scope}-revoked step-up"
            );
        }
    }

    #[tokio::test]
    async fn stepup_rejects_refresh_and_guest_credentials() {
        let secret = "stepup-kind-fixture";
        let (_dir, state) = state(secret).await;
        for (kind, guest) in [("refresh", false), ("access", true)] {
            let mut claims = decode_token(&make_token(secret, "42", true), secret)
                .await
                .unwrap();
            claims.token_type = kind.into();
            claims.is_guest = guest;
            let token = encode(
                &Header::default(),
                &claims,
                &EncodingKey::from_secret(secret.as_bytes()),
            )
            .unwrap();
            assert!(verify_stepup_token(&state, &token, 42).await.is_err());
        }
    }

    #[tokio::test]
    async fn stepup_rejects_negative_issue_time_before_revocation_unsigned_conversion() {
        let secret = "stepup-time-fixture";
        let (_dir, state) = state(secret).await;
        state.revoke_all_tokens().await.unwrap();
        let mut claims = decode_token(&make_token(secret, "42", true), secret)
            .await
            .unwrap();
        claims.iat = -1;
        let token = encode(
            &Header::default(),
            &claims,
            &EncodingKey::from_secret(secret.as_bytes()),
        )
        .unwrap();
        assert!(verify_stepup_token(&state, &token, 42).await.is_err());
    }
}
