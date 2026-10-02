//! Owner-approved entry points for one community. This is discovery metadata,
//! not a leader lease or permission to promote a standby.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hmac::{Hmac, KeyInit, Mac};
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, fs, net::IpAddr, path::PathBuf, sync::Mutex};
use wabidb::{
    engine::WabiDbEngine,
    format::record::RecordKind,
    projections::community_roster as projection,
    sequencer::types::{CommandCommit, EventToWrite},
};

const KEY_CONTEXT: &[u8] = b"wabi/community-roster/p256/v1";
const ROSTER_LIFETIME_SECONDS: i64 = 7 * 24 * 60 * 60;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RosterEntry {
    pub node_id: String,
    pub role: RosterRole,
    pub url: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RosterRole {
    Authority,
    Anchor,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RosterUpdate {
    pub expected_version: u64,
    pub entries: Vec<RosterEntry>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RosterBody {
    pub schema_version: u8,
    pub community_id: String,
    pub version: u64,
    pub issued_at: i64,
    pub expires_at: i64,
    pub entries: Vec<RosterEntry>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedRoster {
    pub body: RosterBody,
    pub public_key: String,
    pub signature: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SavedRoster {
    schema_version: u8,
    version: u64,
    entries: Vec<RosterEntry>,
}

pub struct CommunityRosterStore {
    key: SigningKey,
    community_id: String,
    saved: Mutex<Option<SavedRoster>>,
    update_gate: tokio::sync::Mutex<()>,
    #[cfg(test)]
    update_started: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum RosterError {
    Invalid(String),
    Conflict,
    Io(String),
}

impl CommunityRosterStore {
    pub fn open(data_dir: &str, root_key: &[u8; 32]) -> anyhow::Result<Self> {
        Self::open_legacy(data_dir, root_key, true)
    }

    pub async fn open_canonical(
        data_dir: &str,
        root_key: &[u8; 32],
        engine: &WabiDbEngine,
    ) -> anyhow::Result<Self> {
        let has_canonical = engine
            .projection_state()
            .get(projection::INDEX, projection::KEY)
            .is_some();
        let store = Self::open_legacy(data_dir, root_key, !has_canonical)?;
        store.attach_db(engine).await?;
        Ok(store)
    }

    fn open_legacy(data_dir: &str, root_key: &[u8; 32], read_legacy: bool) -> anyhow::Result<Self> {
        let path = PathBuf::from(data_dir).join("community_roster.json");
        let key = derive_signing_key(root_key)?;
        let public_key = key.verifying_key().to_encoded_point(false);
        let community_id = hex::encode(Sha256::digest(public_key.as_bytes()));
        let saved: Option<SavedRoster> = if read_legacy {
            let bytes = match fs::symlink_metadata(&path) {
                Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
                    Some(fs::read(&path)?)
                }
                Ok(_) => anyhow::bail!("legacy community roster must be a regular file"),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(error.into()),
            };
            bytes
                .map(|bytes| -> anyhow::Result<SavedRoster> {
                    let parsed: SavedRoster = serde_json::from_slice(&bytes)?;
                    anyhow::ensure!(
                        parsed.schema_version == 1 && parsed.version > 0,
                        "invalid community roster version"
                    );
                    let normalized = validate_entries(parsed.entries.clone())
                        .map_err(|e| anyhow::anyhow!("invalid saved community roster: {e:?}"))?;
                    anyhow::ensure!(
                        normalized == parsed.entries,
                        "saved community roster is not canonical"
                    );
                    Ok(parsed)
                })
                .transpose()?
        } else {
            None
        };
        Ok(Self {
            key,
            community_id,
            saved: Mutex::new(saved),
            update_gate: tokio::sync::Mutex::new(()),
            #[cfg(test)]
            update_started: Mutex::new(None),
        })
    }

    pub fn community_id(&self) -> &str {
        &self.community_id
    }

    /// Typed checkpoint claims only, from a paused source plus its completed
    /// export. Not a generic signing endpoint or permission to run a writer.
    pub(crate) fn sign_checkpoint_source(
        &self,
        source: &crate::instance_archive::source_context::FrozenSourceIdentity,
        receipt: &crate::instance_archive::LiveArchiveReceipt,
    ) -> anyhow::Result<wabi_consensus::source_context::SignedSourceContext> {
        let claims = source.claims(self.community_id(), receipt)?;
        let input = wabi_consensus::source_context::signing_input(&claims)?;
        let signature: Signature = self.key.sign(&input);
        let signature = signature.normalize_s().unwrap_or(signature);
        let signed = wabi_consensus::source_context::SignedSourceContext {
            claims,
            public_key: hex::encode(self.key.verifying_key().to_encoded_point(false).as_bytes()),
            signature: hex::encode(signature.to_bytes()),
        };
        signed.verify(self.community_id(), &signed.claims.source_node_id)?;
        Ok(signed)
    }

    pub fn signed(&self) -> Option<SignedRoster> {
        let saved = self
            .saved
            .lock()
            .expect("community roster mutex poisoned")
            .clone()?;
        Some(self.sign_saved(&saved))
    }

    /// Recover canonical roster state from WabiDB. A legacy sidecar is imported
    /// once when the projection has no row; later updates live in the event log.
    pub async fn attach_db(&self, engine: &WabiDbEngine) -> anyhow::Result<()> {
        if self.load_db(engine)? {
            return Ok(());
        }
        let legacy = self
            .saved
            .lock()
            .expect("community roster mutex poisoned")
            .clone();
        if let Some(legacy) = legacy {
            commit_roster(engine, &legacy, 0).await?;
            anyhow::ensure!(
                self.load_db(engine)?,
                "community roster import did not apply"
            );
        }
        Ok(())
    }

    fn load_db(&self, engine: &WabiDbEngine) -> anyhow::Result<bool> {
        let Some(bytes) = engine
            .projection_state()
            .get(projection::INDEX, projection::KEY)
        else {
            return Ok(false);
        };
        projection::decode(&bytes)?;
        let saved: SavedRoster = serde_json::from_slice(&bytes)?;
        anyhow::ensure!(
            validate_entries(saved.entries.clone())
                .map_err(|error| anyhow::anyhow!("invalid canonical roster: {error:?}"))?
                == saved.entries,
            "canonical roster entries are not normalized"
        );
        *self.saved.lock().expect("community roster mutex poisoned") = Some(saved);
        Ok(true)
    }

    pub async fn update_db(
        &self,
        request: RosterUpdate,
        engine: &WabiDbEngine,
        actor_user_id: u64,
    ) -> Result<SignedRoster, RosterError> {
        #[cfg(test)]
        if let Some(started) = self.update_started.lock().unwrap().take() {
            let _ = started.send(());
        }
        let _gate = self.update_gate.lock().await;
        self.load_db(engine)
            .map_err(|error| RosterError::Io(error.to_string()))?;
        let entries = validate_entries(request.entries)?;
        let version = self
            .saved
            .lock()
            .expect("community roster mutex poisoned")
            .as_ref()
            .map_or(0, |current| current.version);
        if request.expected_version != version {
            return Err(RosterError::Conflict);
        }
        let next = SavedRoster {
            schema_version: 1,
            version: version.checked_add(1).ok_or(RosterError::Conflict)?,
            entries,
        };
        commit_roster(engine, &next, actor_user_id)
            .await
            .map_err(|error| RosterError::Io(error.to_string()))?;
        self.load_db(engine)
            .map_err(|error| RosterError::Io(error.to_string()))?;
        let applied = self
            .saved
            .lock()
            .expect("community roster mutex poisoned")
            .clone();
        if !applied.is_some_and(|applied| {
            applied.version == next.version && applied.entries == next.entries
        }) {
            return Err(RosterError::Io(
                "community roster write did not apply".into(),
            ));
        }
        let signed = self.sign_saved(&next);
        Ok(signed)
    }

    fn sign_saved(&self, saved: &SavedRoster) -> SignedRoster {
        let issued_at = chrono::Utc::now().timestamp();
        let body = RosterBody {
            schema_version: 1,
            community_id: self.community_id.clone(),
            version: saved.version,
            issued_at,
            expires_at: issued_at + ROSTER_LIFETIME_SECONDS,
            entries: saved.entries.clone(),
        };
        let payload = serde_json::to_vec(&body).expect("roster body serialization");
        let signature: Signature = self.key.sign(&payload);
        SignedRoster {
            body,
            public_key: URL_SAFE_NO_PAD
                .encode(self.key.verifying_key().to_encoded_point(false).as_bytes()),
            signature: URL_SAFE_NO_PAD.encode(signature.to_bytes()),
        }
    }
}

async fn commit_roster(
    engine: &WabiDbEngine,
    roster: &SavedRoster,
    actor_user_id: u64,
) -> anyhow::Result<()> {
    let plaintext = serde_json::to_vec(roster)?;
    projection::decode(&plaintext)?;
    engine
        .get_or_create_stream_key("community-roster:v1")
        .await?;
    engine
        .run_command(CommandCommit {
            room_owner_precondition: None,
            caller_user_id: actor_user_id,
            caller_device_id: "primary".into(),
            command_name: projection::EVENT.into(),
            idempotency_key: None,
            essential: true,
            response_tx: tokio::sync::oneshot::channel().0,
            events: vec![EventToWrite {
                stream_id: "community-roster:v1".into(),
                stream_kind: 6,
                event_type: projection::EVENT.into(),
                record_kind: RecordKind::Event,
                plaintext,
            }],
        })
        .await?;
    Ok(())
}

fn derive_signing_key(root_key: &[u8; 32]) -> anyhow::Result<SigningKey> {
    for counter in 0u8..=u8::MAX {
        let mut mac = Hmac::<Sha256>::new_from_slice(root_key)?;
        mac.update(KEY_CONTEXT);
        mac.update(&[counter]);
        let bytes = mac.finalize().into_bytes();
        if let Ok(key) = SigningKey::from_slice(&bytes) {
            return Ok(key);
        }
    }
    anyhow::bail!("unable to derive community signing key")
}

fn validate_entries(mut entries: Vec<RosterEntry>) -> Result<Vec<RosterEntry>, RosterError> {
    if entries.is_empty() || entries.len() > 64 {
        return Err(RosterError::Invalid(
            "roster needs 1 to 64 entry points".into(),
        ));
    }
    let mut ids = HashSet::new();
    let mut urls = HashSet::new();
    let mut authorities = 0;
    for entry in &mut entries {
        if entry.node_id.is_empty()
            || entry.node_id.len() > 64
            || !entry
                .node_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        {
            return Err(RosterError::Invalid(
                "nodeId must be 1 to 64 ASCII letters, digits, hyphens or underscores".into(),
            ));
        }
        if !ids.insert(entry.node_id.clone()) {
            return Err(RosterError::Invalid("duplicate nodeId".into()));
        }
        entry.url = validate_url(&entry.url)?;
        if !urls.insert(entry.url.clone()) {
            return Err(RosterError::Invalid("duplicate entry point URL".into()));
        }
        if entry.role == RosterRole::Authority {
            authorities += 1;
        }
    }
    if authorities != 1 {
        return Err(RosterError::Invalid(
            "roster needs exactly one Authority entry point".into(),
        ));
    }
    entries.sort_by(|left, right| left.node_id.cmp(&right.node_id));
    Ok(entries)
}

fn validate_url(raw: &str) -> Result<String, RosterError> {
    let url = reqwest::Url::parse(raw)
        .map_err(|_| RosterError::Invalid("invalid entry point URL".into()))?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err(RosterError::Invalid(
            "entry point must be an HTTP(S) origin without credentials, path, query or fragment"
                .into(),
        ));
    }
    let host = url
        .host_str()
        .ok_or_else(|| RosterError::Invalid("entry point needs a host".into()))?;
    if url.scheme() == "http" && !private_http_host(host) {
        return Err(RosterError::Invalid(
            "public entry points require HTTPS".into(),
        ));
    }
    Ok(url.origin().ascii_serialization())
}

fn private_http_host(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    let Ok(ip) = host.trim_matches(&['[', ']'][..]).parse::<IpAddr>() else {
        return false;
    };
    match ip {
        IpAddr::V4(ip) => {
            let bytes = ip.octets();
            ip.is_private()
                || ip.is_loopback()
                || (bytes[0] == 100 && (64..=127).contains(&bytes[1]))
        }
        IpAddr::V6(ip) => ip.is_loopback() || ip.is_unique_local(),
    }
}

#[cfg(test)]
fn persist_roster(path: &PathBuf, roster: &SavedRoster) -> std::io::Result<()> {
    use std::io::Write;
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;
    let parent = path.parent().expect("community roster has parent");
    fs::create_dir_all(parent)?;
    let temp = parent.join(format!(".community_roster.{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options.open(&temp)?;
        file.write_all(&serde_json::to_vec(roster).map_err(std::io::Error::other)?)?;
        file.sync_all()?;
        fs::rename(&temp, path)?;
        fs::File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        api::routes::create_api_router,
        auth_extractor::{AuthUser, JwtClaims},
        config::{LoreAddonConfig, ServerConfig, ServerRole},
        error::AppError,
        state::AppState,
    };
    use axum::{
        body::{to_bytes, Body, Bytes},
        http::{Request, StatusCode},
        Router,
    };
    use p256::ecdsa::{signature::Verifier, VerifyingKey};
    use serde_json::{json, Value};
    use std::{sync::Arc, time::Duration};
    use tower::ServiceExt;
    use wabidb::engine::wabi_store::WabiStore;

    async fn owner_fixture() -> (tempfile::TempDir, Arc<AppState>, u64, u64) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path();
        let state = Arc::new(
            AppState::new(ServerConfig {
                host: "127.0.0.1".into(),
                port: 0,
                data_dir: path.to_string_lossy().into_owned(),
                uploads_dir: path.join("uploads").to_string_lossy().into_owned(),
                jwt_secret: "roster-admission-test-secret".into(),
                turn_enabled: false,
                turn_uri: None,
                turn_secret: None,
                node_id: "roster-admission-test".into(),
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
            .unwrap(),
        );
        let owner = state
            .wdb
            .create_user("roster-owner", None, "registered-hash")
            .await
            .unwrap();
        let target = state
            .wdb
            .create_user("roster-next-owner", None, "registered-hash")
            .await
            .unwrap();
        state.wdb.claim_owner(owner).await.unwrap();
        *state.owner_user_id.write().await = Some(owner as i64);
        (directory, state, owner, target)
    }

    fn proof(state: &AppState, uid: u64, stepup: bool) -> (String, JwtClaims) {
        let now = chrono::Utc::now().timestamp();
        let claims = JwtClaims {
            sub: uid.to_string(),
            username: format!("roster-user-{uid}"),
            is_guest: false,
            exp: now + if stepup { 600 } else { 3600 },
            iat: now,
            jti: uuid::Uuid::new_v4().to_string(),
            stepup,
            token_type: "access".into(),
        };
        let token = jsonwebtoken::encode(
            &jsonwebtoken::Header::default(),
            &claims,
            &jsonwebtoken::EncodingKey::from_secret(state.config.jwt_secret.as_bytes()),
        )
        .unwrap();
        (token, claims)
    }

    fn roster_update(version: u64) -> Value {
        json!({"expectedVersion": version, "entries": [
            {"nodeId":"authority", "role":"authority", "url":"https://roster.example"}
        ]})
    }

    fn update_request(access: &str, stepup: &str, body: Body) -> Request<Body> {
        Request::put("/community/roster")
            .header("authorization", format!("Bearer {access}"))
            .header("x-stepup-token", stepup)
            .header("content-type", "application/json")
            .body(body)
            .unwrap()
    }

    async fn authority_change(
        state: Arc<AppState>,
        scope: &str,
        access: JwtClaims,
        stepup: JwtClaims,
        stepup_token: String,
        target: u64,
    ) -> Result<(), AppError> {
        match scope {
            "transfer" => {
                state
                    .transfer_owner(
                        AuthUser::from_claims(access).unwrap(),
                        target as i64,
                        stepup_token,
                    )
                    .await
            }
            "access-revoke" => state
                .revoke_token_with_exp(access.jti, access.exp)
                .await
                .map_err(AppError::from),
            "stepup-revoke" => state
                .revoke_token_with_exp(stepup.jti, stepup.exp)
                .await
                .map_err(AppError::from),
            _ => unreachable!(),
        }
    }

    async fn positive_update(app: &Router, state: &AppState, uid: u64, version: u64) {
        let (access, _) = proof(state, uid, false);
        let (stepup, _) = proof(state, uid, true);
        let response = app
            .clone()
            .oneshot(update_request(
                &access,
                &stepup,
                Body::from(roster_update(version).to_string()),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap()["body"]["version"],
            version + 1
        );
    }

    #[tokio::test]
    async fn queued_roster_keeps_owner_and_both_credentials_until_commit_after_caller_abort() {
        for scope in ["transfer", "access-revoke", "stepup-revoke"] {
            let (_directory, state, owner, target) = owner_fixture().await;
            let app = create_api_router(state.clone()).with_state(state.clone());
            let (access, access_claims) = proof(&state, owner, false);
            let (stepup, stepup_claims) = proof(&state, owner, true);
            let gate = state.community_roster.update_gate.lock().await;
            let (started, started_rx) = tokio::sync::oneshot::channel();
            *state.community_roster.update_started.lock().unwrap() = Some(started);
            let request_app = app.clone();
            let request =
                update_request(&access, &stepup, Body::from(roster_update(0).to_string()));
            let caller = tokio::spawn(async move { request_app.oneshot(request).await.unwrap() });
            tokio::time::timeout(Duration::from_secs(5), started_rx)
                .await
                .unwrap()
                .unwrap();
            assert!(state.membership_gate.try_write().is_err());
            assert!(state.revocations.try_write().is_err());
            assert!(state.owner_user_id.try_write().is_err());
            caller.abort();
            assert!(caller.await.unwrap_err().is_cancelled());
            let writer = state.clone();
            let mut transition = tokio::spawn(async move {
                authority_change(writer, scope, access_claims, stepup_claims, stepup, target).await
            });
            // A queued denial writer also closes admission to new readers. Its
            // presence proves this is a race with an actual waiting transition.
            tokio::time::timeout(Duration::from_secs(5), async {
                while state.revocations.try_read().is_ok() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            assert!(
                !transition.is_finished(),
                "{scope} overtook the queued roster"
            );
            assert!(state.community_roster.signed().is_none());
            drop(gate);
            tokio::time::timeout(Duration::from_secs(5), &mut transition)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            let signed = state
                .community_roster
                .signed()
                .expect("roster committed before transition");
            assert_eq!(signed.body.version, 1);
            assert_eq!(signed.body.entries[0].url, "https://roster.example");
            assert_eq!(
                *state.owner_user_id.read().await,
                Some(if scope == "transfer" { target } else { owner } as i64),
            );
            positive_update(
                &app,
                &state,
                if scope == "transfer" { target } else { owner },
                1,
            )
            .await;
            let checkpoint =
                tokio::time::timeout(Duration::from_secs(5), state.instance_operations.quiesce())
                    .await
                    .unwrap()
                    .unwrap();
            drop(checkpoint);
        }
    }

    #[tokio::test]
    async fn roster_rechecks_owner_and_stepup_after_body_wait_without_publishing_stale_request() {
        for scope in ["transfer", "access-revoke", "stepup-revoke"] {
            let (_directory, state, owner, target) = owner_fixture().await;
            let app = create_api_router(state.clone()).with_state(state.clone());
            let (access, access_claims) = proof(&state, owner, false);
            let (stepup, stepup_claims) = proof(&state, owner, true);
            let (started, started_rx) = tokio::sync::oneshot::channel();
            let (body_tx, body_rx) = tokio::sync::oneshot::channel::<Value>();
            let stream = futures::stream::once(async move {
                let _ = started.send(());
                Ok::<Bytes, std::io::Error>(Bytes::from(body_rx.await.unwrap().to_string()))
            });
            let request = update_request(&access, &stepup, Body::from_stream(stream));
            let request_app = app.clone();
            let caller = tokio::spawn(async move { request_app.oneshot(request).await.unwrap() });
            tokio::time::timeout(Duration::from_secs(5), started_rx)
                .await
                .unwrap()
                .unwrap();
            // Extraction accepted the original access proof, but no mutation
            // has been admitted while the request body remains unfinished.
            tokio::time::timeout(
                Duration::from_secs(5),
                authority_change(
                    state.clone(),
                    scope,
                    access_claims,
                    stepup_claims,
                    stepup,
                    target,
                ),
            )
            .await
            .unwrap()
            .unwrap();
            let sequence = state.wdb.engine().projection_state().applied_commit_seq();
            body_tx.send(roster_update(0)).unwrap();
            let response = tokio::time::timeout(Duration::from_secs(5), caller)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{scope}");
            assert!(
                state.community_roster.signed().is_none(),
                "{scope} published a stale roster"
            );
            assert_eq!(
                state.wdb.engine().projection_state().applied_commit_seq(),
                sequence
            );
            positive_update(
                &app,
                &state,
                if scope == "transfer" { target } else { owner },
                0,
            )
            .await;
        }
    }

    #[tokio::test]
    async fn pending_roster_reader_rechecks_current_credential_after_membership_wait() {
        let (_directory, state, owner, _) = owner_fixture().await;
        let app = create_api_router(state.clone()).with_state(state.clone());
        positive_update(&app, &state, owner, 0).await;
        let (access, claims) = proof(&state, owner, false);
        let request = || {
            Request::get("/community/roster")
                .header("authorization", format!("Bearer {access}"))
                .body(Body::empty())
                .unwrap()
        };
        assert_eq!(
            app.clone().oneshot(request()).await.unwrap().status(),
            StatusCode::OK
        );
        let membership = state.membership_gate.write().await;
        let mut response = Box::pin(app.clone().oneshot(request()));
        assert!(
            futures::poll!(response.as_mut()).is_pending(),
            "roster read skipped membership admission"
        );
        state
            .revoke_token_with_exp(claims.jti, claims.exp)
            .await
            .unwrap();
        drop(membership);
        let response = tokio::time::timeout(Duration::from_secs(5), response)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(state.community_roster.signed().unwrap().body.version, 1);
        let (fresh, _) = proof(&state, owner, false);
        let response = app
            .clone()
            .oneshot(
                Request::get("/community/roster")
                    .header("authorization", format!("Bearer {fresh}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[test]
    fn signed_roster_is_stable_and_verifiable() {
        let dir = tempfile::tempdir().unwrap();
        let key = [7u8; 32];
        let entries = validate_entries(vec![
            RosterEntry {
                node_id: "a".into(),
                role: RosterRole::Authority,
                url: "http://127.0.0.1:3001".into(),
            },
            RosterEntry {
                node_id: "b".into(),
                role: RosterRole::Anchor,
                url: "http://100.64.1.2:3001".into(),
            },
        ])
        .unwrap();
        persist_roster(
            &dir.path().join("community_roster.json"),
            &SavedRoster {
                schema_version: 1,
                version: 1,
                entries,
            },
        )
        .unwrap();
        let store = CommunityRosterStore::open(dir.path().to_str().unwrap(), &key).unwrap();
        let signed = store.signed().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(dir.path().join("community_roster.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o077,
                0
            );
        }
        let public = URL_SAFE_NO_PAD.decode(&signed.public_key).unwrap();
        let verifying = VerifyingKey::from_sec1_bytes(&public).unwrap();
        let signature =
            Signature::from_slice(&URL_SAFE_NO_PAD.decode(&signed.signature).unwrap()).unwrap();
        verifying
            .verify(&serde_json::to_vec(&signed.body).unwrap(), &signature)
            .unwrap();
        assert_eq!(
            signed.body.community_id,
            hex::encode(Sha256::digest(&public))
        );
        assert_eq!(
            CommunityRosterStore::open(dir.path().to_str().unwrap(), &key)
                .unwrap()
                .community_id(),
            store.community_id()
        );
        assert_eq!(signed.body.version, 1);
    }

    #[test]
    fn rejects_public_plaintext_and_duplicate_or_untrusted_entries() {
        assert!(validate_url("http://8.8.8.8:3001").is_err());
        assert!(validate_url("http://example.com").is_err());
        assert!(validate_url("https://name:password@example.com").is_err());
        assert!(validate_url("https://example.com/path").is_err());
        assert!(validate_entries(vec![RosterEntry {
            node_id: "a".into(),
            role: RosterRole::Anchor,
            url: "https://example.com".into()
        }])
        .is_err());
    }
}
