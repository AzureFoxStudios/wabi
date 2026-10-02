//! Serialized credential decisions and existing-format atomic auth commits.
use crate::{
    auth_extractor::{ensure_human_principal, AuthUser},
    error::{AppError, Result},
    state::{AppState, RevocationStore},
};
use std::sync::Arc;
use wabidb::{
    engine::wabi_store::WabiStore,
    format::record::RecordKind,
    projections::{
        auth_revocations::Operation,
        users::{encode_record, UserRecord},
    },
    sequencer::types::EventToWrite,
};

/// Proof captured before password verification/hashing. Neither an account
/// cutoff nor a changed stored password may be ignored by a delayed request.
pub(crate) struct PasswordProof {
    pub hash: String,
    pub watermark: (u64, u64),
}

fn denied() -> AppError {
    AppError::Unauthorized("Account credentials changed; authenticate again".into())
}

pub(crate) fn publish_operation(store: &mut RevocationStore, operation: Operation) {
    match operation {
        Operation::Token { jti, expires_at } => {
            store.jtis.insert(jti, expires_at);
        }
        Operation::UserFloor {
            user_id,
            floor,
            exempt_jtis,
            clear_legacy,
        } => {
            store.user_iat_revoked.insert(user_id, floor);
            if exempt_jtis.is_empty() {
                store.user_jti_exemptions.remove(&user_id);
            } else {
                store
                    .user_jti_exemptions
                    .insert(user_id, exempt_jtis.into_iter().collect());
            }
            if clear_legacy {
                store.users.remove(&user_id);
            }
        }
        Operation::GlobalFloor { epoch } => store.epoch = epoch,
        Operation::ClearLegacyUser { user_id } => {
            store.users.remove(&user_id);
        }
        _ => unreachable!("runtime credential operation"),
    }
}

impl AppState {
    /// Retain the current owner's account proof through a complete service
    /// credential mutation. The owned worker keeps these readers if its HTTP
    /// caller disappears, so a transfer/denial cannot overtake a queued write.
    pub(crate) async fn owner_bot_operation<T, F, Fut>(
        self: &Arc<Self>,
        actor: AuthUser,
        operation: F,
    ) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(Arc<AppState>) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = Result<T>> + Send + 'static,
    {
        let state = self.clone();
        let revocations = self.revocations.clone();
        self.instance_operations
            .spawn(async move {
                let guard = revocations.read_owned().await;
                let owner = state.owner_user_id.read().await;
                if actor.user_id <= 0
                    || actor.is_bot
                    || actor.is_guest
                    || actor.iat < 0
                    || actor.exp.saturating_add(60) < chrono::Utc::now().timestamp()
                    || *owner != Some(actor.user_id)
                    || guard.is_revoked(&actor.jti, actor.user_id, actor.iat)
                {
                    return Err(denied());
                }
                ensure_human_principal(&state, actor.user_id).await?;
                let blacklist = state
                    .get_blacklist()
                    .await
                    .ok_or_else(|| AppError::Internal("Ban enforcement unavailable".into()))?;
                if blacklist.is_user_banned(actor.user_id).await.is_some() {
                    return Err(denied());
                }
                let result = operation(state.clone()).await;
                drop(owner);
                drop(guard);
                result
            })
            .await
            .map_err(|_| AppError::Internal("Bot owner operation failed".into()))?
    }

    /// Transfer and old-owner denial are one durable decision. A delayed
    /// request cannot choose a guest, service account, or vanished target.
    pub(crate) async fn transfer_owner(
        self: &Arc<Self>,
        actor: AuthUser,
        target: i64,
        stepup_token: String,
    ) -> Result<()> {
        if target <= 0 || target == actor.user_id {
            return Err(AppError::BadRequest(
                "Choose another registered account".into(),
            ));
        }
        let state = self.clone();
        let revocations = self.revocations.clone();
        let io = self.socket_io();
        let secret = self.config.jwt_secret.clone();
        self.instance_operations
            .spawn(async move {
                let _membership = state.membership_gate.read().await;
                let mut guard = revocations.write_owned().await;
                let mut owner = state.owner_user_id.write().await;
                if actor.is_guest
                    || actor.is_bot
                    || actor.iat < 0
                    || *owner != Some(actor.user_id)
                    || guard.is_revoked(&actor.jti, actor.user_id, actor.iat)
                {
                    return Err(denied());
                }
                ensure_human_principal(&state, actor.user_id).await?;
                let blacklist = state
                    .get_blacklist()
                    .await
                    .ok_or_else(|| AppError::Internal("Ban enforcement unavailable".into()))?;
                if blacklist.is_user_banned(actor.user_id).await.is_some() {
                    return Err(denied());
                }
                let stepup = crate::auth_extractor::decode_token(&stepup_token, &secret).await?;
                crate::auth_extractor::validate_stepup_claims(&stepup, actor.user_id)?;
                if guard.is_revoked(&stepup.jti, actor.user_id, stepup.iat) {
                    return Err(denied());
                }
                let valid_target = state
                    .wdb
                    .get_user(target as u64)
                    .await?
                    .is_some_and(|user| {
                        user.is_active && user.is_registered && !user.password_hash.is_empty()
                    });
                if !valid_target || state.bot_registry.is_bot(target as u64).await {
                    return Err(AppError::BadRequest(
                        "Ownership requires an active registered human account".into(),
                    ));
                }
                let operation = Operation::UserFloor {
                    user_id: actor.user_id,
                    floor: guard.next_user_floor(actor.user_id, chrono::Utc::now().timestamp()),
                    exempt_jtis: vec![],
                    clear_legacy: true,
                };
                let payload = serde_json::to_vec(&wabidb::projections::owner::OwnerRecord {
                    owner_user_id: target as u64,
                })
                .map_err(|_| AppError::Internal("Owner record encoding failed".into()))?;
                let mut events = vec![EventToWrite {
                    stream_id: "server_meta".into(), event_type: "owner_claimed".into(),
                    stream_kind: 6, record_kind: RecordKind::Event, plaintext: payload,
                }];
                if state.wdb.get_user_role("default-workspace", actor.user_id as u64).await?.as_deref() == Some("Owner") {
                    events.push(EventToWrite {
                        stream_id: "rbac:default-workspace".into(), event_type: "role_removed".into(),
                        stream_kind: 6, record_kind: RecordKind::Event,
                        plaintext: serde_json::json!({"user_id":actor.user_id as u64,
                            "workspace_id":"default-workspace", "role":"Owner", "assigned_by":actor.user_id as u64}).to_string().into_bytes(),
                    });
                }
                state.wdb.invalidate_roster();
                let commit = crate::auth_revocations::commit_with_events(
                    state.wdb.engine(),
                    false,
                    vec![operation.clone()],
                    events,
                )
                .await;
                if let Err(error) = commit {
                    state.wdb.invalidate_roster();
                    return Err(error.into());
                }
                publish_operation(&mut guard, operation);
                *owner = Some(target);
                state.wdb.invalidate_roster();
                drop(owner);
                drop(guard);
                drop(_membership);
                if let Some(io) = io {
                    crate::socketio::disconnect_revoked_sockets(&io, &secret, &state.revocations)
                        .await;
                }
                Ok(())
            })
            .await
            .map_err(|_| AppError::Internal("Ownership publication task failed".into()))?
    }

    /// Checking and burning a refresh token are one durable operation, with
    /// reuse response under the same write guard. Cancellation cannot stop its
    /// publication once admitted. Minting later rechecks the returned cutoff.
    pub(crate) async fn consume_refresh(
        self: &Arc<Self>,
        user_id: i64,
        jti: String,
        iat: i64,
        exp: i64,
    ) -> Result<(u64, u64)> {
        if user_id <= 0 || iat < 0 || jti.is_empty() {
            return Err(denied());
        }
        let state = self.clone();
        let revocations = self.revocations.clone();
        let io = self.socket_io();
        let secret = self.config.jwt_secret.clone();
        self.instance_operations
            .spawn(async move {
                let mut guard = revocations.write_owned().await;
                ensure_human_principal(&state, user_id).await?;
                let reused = guard.is_revoked(&jti, user_id, iat);
                let watermark = guard.account_watermark(user_id);
                let operation = if reused {
                    Operation::UserFloor {
                        user_id,
                        floor: guard.next_user_floor(user_id, chrono::Utc::now().timestamp()),
                        exempt_jtis: vec![],
                        clear_legacy: true,
                    }
                } else {
                    Operation::Token {
                        jti,
                        expires_at: exp.max(0) as u64,
                    }
                };
                let cutoff = (chrono::Utc::now().timestamp().max(0) as u64).saturating_sub(3600);
                let expired: Vec<_> = guard
                    .jtis
                    .iter()
                    .filter(|(_, expires)| **expires <= cutoff)
                    .take(256)
                    .map(|(jti, expires)| (jti.clone(), *expires))
                    .collect();
                let mut operations = vec![operation.clone()];
                operations.extend(
                    expired
                        .iter()
                        .map(|(jti, expires_at)| Operation::PruneToken {
                            jti: jti.clone(),
                            expires_at: *expires_at,
                            cutoff,
                        }),
                );
                crate::auth_revocations::commit(state.wdb.engine(), false, operations).await?;
                publish_operation(&mut guard, operation);
                for (jti, expires_at) in expired {
                    if guard.jtis.get(&jti) == Some(&expires_at) {
                        guard.jtis.remove(&jti);
                    }
                }
                drop(guard);
                if let Some(io) = io {
                    crate::socketio::disconnect_revoked_sockets(&io, &secret, &state.revocations)
                        .await;
                }
                if reused {
                    Err(AppError::Unauthorized(
                        "token reuse detected; all sessions revoked".into(),
                    ))
                } else {
                    Ok(watermark)
                }
            })
            .await
            .map_err(|_| AppError::Internal("Credential publication task failed".into()))?
    }

    pub(crate) async fn password_proof(
        &self,
        actor: &AuthUser,
        target: i64,
    ) -> Result<PasswordProof> {
        if actor.is_bot || actor.is_guest || actor.user_id <= 0 || actor.iat < 0 || target <= 0 {
            return Err(denied());
        }
        let guard = self.revocations.read().await;
        ensure_human_principal(self, actor.user_id).await?;
        if guard.is_revoked(&actor.jti, actor.user_id, actor.iat) {
            return Err(denied());
        }
        let user = self
            .wdb
            .get_user(target as u64)
            .await?
            .filter(|user| user.is_active && !user.password_hash.is_empty())
            .ok_or_else(denied)?;
        Ok(PasswordProof {
            hash: user.password_hash,
            watermark: guard.account_watermark(target),
        })
    }

    /// Commit the password and its session denial in ONE command, using the
    /// established UserRecord and revocation delta schemas. Every credential
    /// writer uses this serialization boundary; profile events carry no hash.
    pub(crate) async fn replace_password(
        self: &Arc<Self>,
        actor: AuthUser,
        target: i64,
        proof: PasswordProof,
        password_hash: String,
        admin_reset: bool,
    ) -> Result<()> {
        let state = self.clone();
        let revocations = self.revocations.clone();
        let io = self.socket_io();
        let secret = self.config.jwt_secret.clone();
        self.instance_operations
            .spawn(async move {
                // Role changes use membership -> revocations. Recovery uses
                // revocations -> owner. Holding the owner reader fences transfer.
                let _membership = state.membership_gate.read().await;
                let mut guard = revocations.write_owned().await;
                let owner = state.owner_user_id.read().await;
                if actor.is_bot
                    || actor.is_guest
                    || actor.iat < 0
                    || guard.is_revoked(&actor.jti, actor.user_id, actor.iat)
                    || guard.account_watermark(target) != proof.watermark
                {
                    return Err(denied());
                }
                ensure_human_principal(&state, actor.user_id).await?;
                let blacklist = state
                    .get_blacklist()
                    .await
                    .ok_or_else(|| AppError::Internal("Ban enforcement unavailable".into()))?;
                if blacklist.is_user_banned(actor.user_id).await.is_some() {
                    return Err(denied());
                }
                if admin_reset {
                    if state.bot_registry.is_bot(target as u64).await {
                        return Err(AppError::Forbidden(
                            "Manage bot credentials through the owner bot settings".into(),
                        ));
                    }
                    let actor_role = state
                        .wdb
                        .get_user_role("default-workspace", actor.user_id as u64)
                        .await?;
                    let target_role = state
                        .wdb
                        .get_user_role("default-workspace", target as u64)
                        .await?;
                    let admin = *owner == Some(actor.user_id)
                        || state.config.admin_user_ids.contains(&actor.user_id)
                        || matches!(actor_role.as_deref(), Some("Owner" | "Admin"));
                    if !admin
                        || actor.user_id == target
                        || *owner == Some(target)
                        || target_role.as_deref() == Some("Owner")
                    {
                        return Err(AppError::Forbidden(
                            "Password reset is no longer authorized".into(),
                        ));
                    }
                } else if actor.user_id != target {
                    return Err(denied());
                }
                let current = state
                    .wdb
                    .get_user(target as u64)
                    .await?
                    .filter(|user| user.is_active && user.password_hash == proof.hash)
                    .ok_or_else(denied)?;
                let operation = Operation::UserFloor {
                    user_id: target,
                    floor: guard.next_user_floor(target, chrono::Utc::now().timestamp()),
                    exempt_jtis: if admin_reset || actor.jti.is_empty() {
                        vec![]
                    } else {
                        vec![actor.jti]
                    },
                    clear_legacy: admin_reset,
                };
                let record = UserRecord {
                    user_id: current.user_id,
                    username: String::new(),
                    handle: current.handle,
                    color: String::new(),
                    password_hash,
                    is_registered: current.is_registered,
                    is_active: current.is_active,
                    created_at_micros: current.created_at_micros,
                    last_seen_micros: current.last_seen_micros,
                    profile_picture: None,
                    username_font: None,
                    bio: None,
                    status_message: None,
                };
                crate::auth_revocations::commit_with_events(
                    state.wdb.engine(),
                    false,
                    vec![operation.clone()],
                    vec![EventToWrite {
                        stream_id: format!("user:{target}"),
                        event_type: "user_updated".into(),
                        stream_kind: 6,
                        record_kind: RecordKind::Event,
                        plaintext: encode_record(&record),
                    }],
                )
                .await?;
                publish_operation(&mut guard, operation);
                drop(owner);
                drop(guard);
                drop(_membership);
                if let Some(io) = io {
                    crate::socketio::disconnect_revoked_sockets(&io, &secret, &state.revocations)
                        .await;
                }
                Ok(())
            })
            .await
            .map_err(|_| AppError::Internal("Credential publication task failed".into()))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        auth_extractor::JwtClaims,
        config::{LoreAddonConfig, ServerConfig, ServerRole},
    };

    async fn reopen_server(config: ServerConfig) -> AppState {
        // Disk workers retain the advisory lock while closing admitted writes.
        // Wait only for that teardown; never remove its inode or hide another
        // startup failure from the restart/replay assertions below.
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            match AppState::new(config.clone()).await {
                Ok(state) => return state,
                Err(error)
                    if error
                        .downcast_ref::<wabidb::error::WabiError>()
                        .is_some_and(|error| {
                            matches!(error, wabidb::error::WabiError::AlreadyRunning)
                        })
                        && tokio::time::Instant::now() < deadline =>
                {
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
                Err(error) => {
                    panic!("could not reopen credential fixture after writer teardown: {error:#}")
                }
            }
        }
    }

    async fn fixture() -> (tempfile::TempDir, Arc<AppState>, AuthUser) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path();
        let state = Arc::new(
            AppState::new(ServerConfig {
                host: "127.0.0.1".into(),
                port: 0,
                data_dir: path.to_string_lossy().into_owned(),
                uploads_dir: path.join("uploads").to_string_lossy().into_owned(),
                jwt_secret: "credential-race-fixture-only".into(),
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
            .create_user("credential-owner", None, "old-hash")
            .await
            .unwrap();
        state
            .claim_ownership(uid as i64, "credential-owner")
            .await
            .unwrap();
        let now = chrono::Utc::now().timestamp();
        let actor = AuthUser::from_claims(JwtClaims {
            sub: uid.to_string(),
            username: "credential-owner".into(),
            is_guest: false,
            iat: now,
            exp: now + 3600,
            jti: "current-session".into(),
            stepup: false,
            token_type: "access".into(),
        })
        .unwrap();
        (directory, state, actor)
    }

    #[tokio::test]
    async fn stale_password_or_revoked_session_cannot_publish_a_replacement_or_exemption() {
        for scope in ["token", "user", "password"] {
            let (_directory, state, actor) = fixture().await;
            let target = actor.user_id;
            let proof = state.password_proof(&actor, target).await.unwrap();
            match scope {
                "token" => state
                    .revoke_token_with_exp(actor.jti.clone(), actor.exp)
                    .await
                    .unwrap(),
                "user" => state.revoke_user(target).await.unwrap(),
                "password" => state
                    .wdb
                    .update_user(
                        target as u64,
                        wabidb::domain::UserUpdate {
                            password_hash: Some("admin-reset-hash".into()),
                            ..Default::default()
                        },
                    )
                    .await
                    .unwrap(),
                _ => unreachable!(),
            }
            assert!(matches!(
                state
                    .replace_password(actor, target, proof, "stale-change-hash".into(), false)
                    .await,
                Err(AppError::Unauthorized(_))
            ));
            let expected = if scope == "password" {
                "admin-reset-hash"
            } else {
                "old-hash"
            };
            assert_eq!(
                state
                    .wdb
                    .get_user(target as u64)
                    .await
                    .unwrap()
                    .unwrap()
                    .password_hash,
                expected
            );
            assert!(state
                .revocations
                .read()
                .await
                .user_jti_exemptions
                .get(&target)
                .is_none());
        }
    }

    #[tokio::test]
    async fn racing_password_changes_accept_only_one_verified_proof() {
        let (_directory, state, actor) = fixture().await;
        let target = actor.user_id;
        let first = state.password_proof(&actor, target).await.unwrap();
        let second = state.password_proof(&actor, target).await.unwrap();
        let (first, second) = tokio::join!(
            state.replace_password(actor.clone(), target, first, "first-hash".into(), false),
            state.replace_password(actor.clone(), target, second, "second-hash".into(), false),
        );
        assert_eq!(usize::from(first.is_ok()) + usize::from(second.is_ok()), 1);
        assert!(!state.is_token_revoked(&actor.jti, target, actor.iat).await);
        assert!(
            state
                .is_token_revoked("other-device", target, actor.iat)
                .await
        );
        assert!(matches!(
            state
                .wdb
                .get_user(target as u64)
                .await
                .unwrap()
                .unwrap()
                .password_hash
                .as_str(),
            "first-hash" | "second-hash"
        ));
    }

    #[tokio::test]
    async fn admin_reset_fences_a_previously_verified_self_change_and_replays_both_halves() {
        let (directory, state, owner) = fixture().await;
        let target = state
            .wdb
            .create_user("reset-target", None, "old-target-hash")
            .await
            .unwrap() as i64;
        let mut target_actor = owner.clone();
        target_actor.user_id = target;
        target_actor.username = "reset-target".into();
        target_actor.jti = "target-old-session".into();
        let stale = state.password_proof(&target_actor, target).await.unwrap();
        let admin_proof = state.password_proof(&owner, target).await.unwrap();
        state
            .replace_password(owner, target, admin_proof, "admin-new-hash".into(), true)
            .await
            .unwrap();
        assert!(matches!(
            state
                .replace_password(
                    target_actor.clone(),
                    target,
                    stale,
                    "late-self-hash".into(),
                    false
                )
                .await,
            Err(AppError::Unauthorized(_))
        ));
        assert!(
            state
                .is_token_revoked(&target_actor.jti, target, target_actor.iat)
                .await
        );
        let config = state.config.clone();
        drop(state);
        std::fs::remove_file(directory.path().join("wabidb/projections/snapshot.json")).unwrap();
        let reopened = reopen_server(config).await;
        assert_eq!(
            reopened
                .wdb
                .get_user(target as u64)
                .await
                .unwrap()
                .unwrap()
                .password_hash,
            "admin-new-hash"
        );
        assert!(
            reopened
                .is_token_revoked(&target_actor.jti, target, target_actor.iat)
                .await
        );
    }

    #[tokio::test]
    async fn queued_bot_write_finishes_before_transfer_or_revocation_even_if_caller_is_aborted() {
        for scope in ["transfer", "token", "user"] {
            let (_directory, state, actor) = fixture().await;
            let target = state
                .wdb
                .create_user("bot-race-next-owner", None, "target-hash")
                .await
                .unwrap();
            let (started, started_rx) = tokio::sync::oneshot::channel();
            let (release, release_rx) = tokio::sync::oneshot::channel();
            let (published, published_rx) = tokio::sync::oneshot::channel();
            let worker = state.clone();
            let proof = actor.clone();
            let caller = tokio::spawn(async move {
                worker
                    .owner_bot_operation(proof, move |state| async move {
                        started.send(()).unwrap();
                        release_rx.await.unwrap();
                        let uid = state
                            .wdb
                            .create_user("guarded-service-bot", None, "bot-dummy-hash")
                            .await?;
                        let (token, _) = state.bot_registry.create(uid).await?;
                        published.send((uid, token)).unwrap();
                        Ok(())
                    })
                    .await
            });
            started_rx.await.unwrap();
            let references = Arc::strong_count(&state.revocations);
            let writer = state.clone();
            let proof = actor.clone();
            let mut transition = tokio::spawn(async move {
                match scope {
                    "transfer" => {
                        let stepup = jsonwebtoken::encode(
                            &jsonwebtoken::Header::default(),
                            &JwtClaims {
                                sub: proof.user_id.to_string(),
                                username: proof.username.clone(),
                                is_guest: false,
                                iat: proof.iat,
                                exp: proof.exp,
                                jti: "bot-transfer-stepup".into(),
                                stepup: true,
                                token_type: "access".into(),
                            },
                            &jsonwebtoken::EncodingKey::from_secret(
                                writer.config.jwt_secret.as_bytes(),
                            ),
                        )
                        .unwrap();
                        writer.transfer_owner(proof, target as i64, stepup).await
                    }
                    "token" => writer
                        .revoke_token_with_exp(proof.jti, proof.exp)
                        .await
                        .map_err(AppError::from),
                    "user" => writer
                        .revoke_user(proof.user_id)
                        .await
                        .map_err(AppError::from),
                    _ => unreachable!(),
                }
            });
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                while Arc::strong_count(&state.revocations) < references + 1 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            assert!(
                !transition.is_finished(),
                "authority change overtook the admitted bot write"
            );
            caller.abort();
            assert!(caller.await.unwrap_err().is_cancelled());
            release.send(()).unwrap();
            let (bot, token) = published_rx.await.unwrap();
            tokio::time::timeout(std::time::Duration::from_secs(5), &mut transition)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert_eq!(state.bot_registry.authenticate(&token).await, Some(bot));
            assert!(state.wdb.get_user(bot).await.unwrap().is_some());
            if scope == "transfer" {
                assert!(state.is_owner(target as i64).await);
            } else {
                assert!(
                    state
                        .is_token_revoked(&actor.jti, actor.user_id, actor.iat)
                        .await
                );
            }
            let stale = state
                .owner_bot_operation(actor, move |state| async move {
                    state
                        .wdb
                        .create_user("must-not-create-stale-bot", None, "hash")
                        .await?;
                    Ok(())
                })
                .await;
            assert!(matches!(stale, Err(AppError::Unauthorized(_))));
            assert!(state
                .wdb
                .get_user_by_username("must-not-create-stale-bot")
                .await
                .unwrap()
                .is_none());
        }
    }

    #[tokio::test]
    async fn transferred_owner_role_is_removed_and_legacy_stale_owner_is_not_privileged() {
        let (directory, state, actor) = fixture().await;
        state.wdb.ingest_event("rbac", "assign_role", &serde_json::json!({
            "userId":actor.user_id, "workspaceId":"default-workspace", "role":"Owner", "assignedBy":actor.user_id,
        })).await.unwrap();
        assert_eq!(
            state
                .wdb
                .get_user_role("default-workspace", actor.user_id as u64)
                .await
                .unwrap()
                .as_deref(),
            Some("Owner")
        );
        let target = state
            .wdb
            .create_user("next-owner", None, "new-owner-hash")
            .await
            .unwrap() as i64;
        let stepup = jsonwebtoken::encode(
            &jsonwebtoken::Header::default(),
            &JwtClaims {
                sub: actor.user_id.to_string(),
                username: actor.username.clone(),
                is_guest: false,
                iat: actor.iat,
                exp: actor.exp,
                jti: "transfer-stepup".into(),
                stepup: true,
                token_type: "access".into(),
            },
            &jsonwebtoken::EncodingKey::from_secret(state.config.jwt_secret.as_bytes()),
        )
        .unwrap();
        state
            .transfer_owner(actor.clone(), target, stepup)
            .await
            .unwrap();
        let raw = wabidb::projections::audit::AuditProjection::get_role(
            state.wdb.engine().projection_state(),
            "default-workspace",
            actor.user_id as u64,
        );
        assert_eq!(
            raw.as_deref(),
            Some("Member"),
            "transfer must durably remove the former Owner role"
        );
        assert!(!state.is_admin(actor.user_id).await);
        // Simulate a pre-fix historical stale Owner row. It stays replayable,
        // but all callers of the shared adapter see ordinary Member authority.
        state.wdb.ingest_event("rbac", "assign_role", &serde_json::json!({
            "userId":actor.user_id, "workspaceId":"default-workspace", "role":"Owner", "assignedBy":target,
        })).await.unwrap();
        assert_eq!(
            state
                .wdb
                .get_user_role("default-workspace", actor.user_id as u64)
                .await
                .unwrap()
                .as_deref(),
            Some("Member")
        );
        assert!(!state.is_admin(actor.user_id).await);
        let mut config = state.config.clone();
        drop(state);
        std::fs::remove_file(directory.path().join("wabidb/projections/snapshot.json")).unwrap();
        let reopened = reopen_server(config.clone()).await;
        assert!(reopened.is_owner(target).await);
        assert!(!reopened.is_admin(actor.user_id).await);
        assert_eq!(
            reopened
                .wdb
                .get_user_role("default-workspace", actor.user_id as u64)
                .await
                .unwrap()
                .as_deref(),
            Some("Member")
        );
        drop(reopened);
        config.admin_user_ids.push(actor.user_id);
        let configured = reopen_server(config).await;
        assert!(
            configured.is_admin(actor.user_id).await,
            "an explicit operator Admin grant remains authoritative"
        );
    }

    #[tokio::test]
    async fn ownership_transfer_rejects_guest_inactive_bot_and_missing_targets_without_changes() {
        let (_directory, state, actor) = fixture().await;
        let guest = state
            .wdb
            .create_user("owner-target-guest", None, "")
            .await
            .unwrap();
        let inactive = state
            .wdb
            .create_user("owner-target-inactive", None, "inactive-hash")
            .await
            .unwrap();
        let bot = state
            .wdb
            .create_user("owner-target-bot", None, "bot-hash")
            .await
            .unwrap();
        state.bot_registry.create(bot).await.unwrap();
        let projection = state.wdb.engine().projection_state();
        let mut record = wabidb::projections::users::decode_record(
            &projection.get("users", &inactive.to_be_bytes()).unwrap(),
        )
        .unwrap();
        record.is_active = false;
        projection.insert(
            "users",
            inactive.to_be_bytes().to_vec(),
            encode_record(&record),
            state.wdb.engine().barrier().current(),
        );
        let mut stepup_claims = JwtClaims {
            sub: actor.user_id.to_string(),
            username: actor.username.clone(),
            is_guest: false,
            iat: actor.iat,
            exp: actor.exp,
            jti: "owner-stepup".into(),
            stepup: true,
            token_type: "access".into(),
        };
        let stepup = jsonwebtoken::encode(
            &jsonwebtoken::Header::default(),
            &stepup_claims,
            &jsonwebtoken::EncodingKey::from_secret(state.config.jwt_secret.as_bytes()),
        )
        .unwrap();
        let cutoff = state
            .revocations
            .read()
            .await
            .account_watermark(actor.user_id);
        for target in [guest as i64, inactive as i64, bot as i64, 999_999, -1] {
            assert!(matches!(
                state
                    .transfer_owner(actor.clone(), target, stepup.clone())
                    .await,
                Err(AppError::BadRequest(_))
            ));
            assert!(state.is_owner(actor.user_id).await);
            assert_eq!(
                state
                    .revocations
                    .read()
                    .await
                    .account_watermark(actor.user_id),
                cutoff
            );
            assert!(
                !state
                    .is_token_revoked(&actor.jti, actor.user_id, actor.iat)
                    .await
            );
        }
        let target = state
            .wdb
            .create_user("new-human-owner", None, "registered-hash")
            .await
            .unwrap() as i64;
        state
            .transfer_owner(actor.clone(), target, stepup)
            .await
            .unwrap();
        assert!(state.is_owner(target).await);
        assert!(
            state
                .is_token_revoked(&actor.jti, actor.user_id, actor.iat)
                .await
        );
        assert_eq!(
            wabidb::projections::owner::OwnerProjection::get_owner(projection),
            Some(target as u64)
        );
        // A stale old-owner proof cannot transfer again after publication.
        stepup_claims.jti = "another-owner-stepup".into();
        let stale = jsonwebtoken::encode(
            &jsonwebtoken::Header::default(),
            &stepup_claims,
            &jsonwebtoken::EncodingKey::from_secret(state.config.jwt_secret.as_bytes()),
        )
        .unwrap();
        assert!(state
            .transfer_owner(actor, guest as i64, stale)
            .await
            .is_err());
        assert!(state.is_owner(target).await);
    }

    #[tokio::test]
    async fn admin_reset_cannot_turn_a_bot_into_a_human_account() {
        let (_directory, state, owner) = fixture().await;
        let target = state
            .wdb
            .create_user("service-bot", None, "bot-random-hash")
            .await
            .unwrap();
        let (token, _) = state.bot_registry.create(target).await.unwrap();
        let proof = state.password_proof(&owner, target as i64).await.unwrap();
        let cutoff = state
            .revocations
            .read()
            .await
            .account_watermark(target as i64);
        assert!(matches!(
            state
                .replace_password(
                    owner,
                    target as i64,
                    proof,
                    "known-human-password".into(),
                    true
                )
                .await,
            Err(AppError::Forbidden(_))
        ));
        assert_eq!(
            state
                .wdb
                .get_user(target)
                .await
                .unwrap()
                .unwrap()
                .password_hash,
            "bot-random-hash"
        );
        assert_eq!(
            state
                .revocations
                .read()
                .await
                .account_watermark(target as i64),
            cutoff
        );
        assert_eq!(state.bot_registry.authenticate(&token).await, Some(target));
    }

    #[tokio::test]
    async fn failed_credential_commit_publishes_neither_password_nor_denial() {
        let (_directory, state, actor) = fixture().await;
        let target = actor.user_id;
        let proof = state.password_proof(&actor, target).await.unwrap();
        state.wdb.engine().fence_local_writer().await.unwrap();
        assert!(state
            .replace_password(
                actor.clone(),
                target,
                proof,
                "never-published".into(),
                false
            )
            .await
            .is_err());
        assert_eq!(
            state
                .wdb
                .get_user(target as u64)
                .await
                .unwrap()
                .unwrap()
                .password_hash,
            "old-hash"
        );
        assert!(!state.is_token_revoked(&actor.jti, target, actor.iat).await);
    }
}
