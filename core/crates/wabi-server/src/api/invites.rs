//! One-use admission grants, deliberately not account/admin bearer tokens.
//! Persist only SHA-256 digests. Corrupt grant state fails closed. Consumption
//! is durable before account creation; a failed creation may burn a grant, but
//! must never make it reusable after a crash.
use std::{fs, io::Write, path::{Path, PathBuf}, sync::Arc};
use axum::{extract::{Path as RoutePath, State}, http::HeaderMap, routing::{get, delete}, Json, Router};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use crate::{error::{AppError, Result}, state::AppState};

pub(crate) static GRANTS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Grant { id: String, digest: String, created_by: i64, expires_at: i64, consumed: bool, revoked: bool }
#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Registry { version: u32, grants: Vec<Grant> }
fn path(data: &str) -> PathBuf { Path::new(data).join("join-invites-v1.json") }
fn load(data: &str) -> Result<Registry> {
    match fs::read(path(data)) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Registry { version: 1, grants: vec![] }),
        Err(e) => Err(AppError::Internal(format!("Cannot read invitation registry: {e}"))),
        Ok(bytes) => {
            let registry: Registry = serde_json::from_slice(&bytes).map_err(|_| AppError::Internal("Invitation registry is damaged; admission refused".into()))?;
            if registry.version != 1 { return Err(AppError::Internal("Unsupported invitation registry version".into())); }
            Ok(registry)
        }
    }
}
fn save(data: &str, registry: &Registry) -> Result<()> {
    let temporary = Path::new(data).join(format!(".join-invites-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> std::io::Result<()> {
        let mut opts = fs::OpenOptions::new(); opts.write(true).create_new(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; opts.mode(0o600); }
        let mut file = opts.open(&temporary)?;
        file.write_all(&serde_json::to_vec(registry)?)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path(data))?;
        #[cfg(unix)] { fs::File::open(data)?.sync_all()?; }
        Ok(())
    })();
    if result.is_err() { let _ = fs::remove_file(temporary); }
    result.map_err(|e| AppError::Internal(format!("Cannot commit invitation state: {e}")))
}
fn digest(token: &str) -> Result<String> {
    if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::Forbidden("Invitation is invalid, expired, revoked or already used".into()));
    }
    Ok(hex::encode(Sha256::digest(token.as_bytes())))
}
fn usable(grant: &Grant, digest: &str, now: i64) -> bool {
    // Constant-time equality of fixed-size digests; no plaintext secrets on disk.
    let equal = grant.digest.len() == digest.len() && grant.digest.bytes().zip(digest.bytes()).fold(0u8, |d,(a,b)| d | (a ^ b)) == 0;
    equal && !grant.consumed && !grant.revoked && now < grant.expires_at
}
/// Caller holds GRANTS through policy evaluation and this commit.
pub(crate) fn consume(data: &str, token: &str) -> Result<()> {
    let hash = digest(token)?;
    let mut registry = load(data)?;
    let now = chrono::Utc::now().timestamp();
    let grant = registry.grants.iter_mut().find(|grant| usable(grant, &hash, now))
        .ok_or_else(|| AppError::Forbidden("Invitation is invalid, expired, revoked or already used".into()))?;
    grant.consumed = true;
    save(data, &registry)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Create { expires_in_hours: u32 }
async fn owner(state: &Arc<AppState>, headers: &HeaderMap) -> Result<i64> {
    let actor = super::admin::admin_auth(headers, state).await
        .map_err(|_| AppError::Forbidden("Owner access required to manage invitations".into()))?;
    if *state.owner_user_id.read().await != Some(actor) { return Err(AppError::Forbidden("Owner access required to manage invitations".into())); }
    Ok(actor)
}
pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new().route("/", get(list).post(create))
        .route("/{id}", delete(revoke)).with_state(state)
}
async fn create(State(state): State<Arc<AppState>>, headers: HeaderMap, Json(request): Json<Create>) -> Result<Json<Value>> {
    let actor = owner(&state, &headers).await?;
    if !(1..=168).contains(&request.expires_in_hours) { return Err(AppError::BadRequest("Invitation lifetime must be 1–168 hours".into())); }
    let _guard = GRANTS.lock().await;
    let now = chrono::Utc::now().timestamp();
    let mut registry = load(&state.config.data_dir)?;
    registry.grants.retain(|g| g.expires_at > now);
    if registry.grants.len() >= 1000 { return Err(AppError::BadRequest("Too many unexpired invitations".into())); }
    let mut secret = [0_u8;32]; rand::rngs::OsRng.fill_bytes(&mut secret);
    let token = hex::encode(secret); let id = uuid::Uuid::new_v4().to_string();
    let expires = now + i64::from(request.expires_in_hours) * 3600;
    registry.grants.push(Grant { id: id.clone(), digest: digest(&token)?, created_by: actor, expires_at: expires, consumed: false, revoked: false });
    save(&state.config.data_dir, &registry)?;
    Ok(Json(json!({"id":id,"token":token,"expiresAt":expires,"uses":1})))
}
async fn list(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Result<Json<Value>> {
    owner(&state, &headers).await?;
    let _guard = GRANTS.lock().await;
    let registry = load(&state.config.data_dir)?;
    Ok(Json(json!({"invites":registry.grants.iter().map(|g| json!({"id":g.id,"expiresAt":g.expires_at,"consumed":g.consumed,"revoked":g.revoked})).collect::<Vec<_>>()})))
}
async fn revoke(State(state): State<Arc<AppState>>, headers: HeaderMap, RoutePath(id): RoutePath<String>) -> Result<Json<Value>> {
    owner(&state, &headers).await?;
    let _guard = GRANTS.lock().await;
    let mut registry = load(&state.config.data_dir)?;
    let grant = registry.grants.iter_mut().find(|g| g.id == id).ok_or_else(|| AppError::BadRequest("Unknown invitation".into()))?;
    grant.revoked = true; save(&state.config.data_dir, &registry)?;
    Ok(Json(json!({"revoked":id})))
}
#[cfg(test)]
mod tests {
    use super::*;
    fn grant() -> Grant { Grant { id: "test".into(), digest: digest(&"ab".repeat(32)).unwrap(), created_by: 1, expires_at: 100, consumed: false, revoked: false } }
    #[test] fn rejects_expiry_boundary_wrong_token_and_revocation() {
        let mut g = grant(); let hash = digest(&"ab".repeat(32)).unwrap();
        assert!(usable(&g,&hash,99)); assert!(!usable(&g,&hash,100));
        assert!(!usable(&g,&digest(&"cd".repeat(32)).unwrap(),0));
        g.revoked=true; assert!(!usable(&g,&hash,0));
        g.revoked=false; g.consumed=true; assert!(!usable(&g,&hash,0));
    }
    #[test] fn corruption_is_not_an_empty_registry() {
        let dir=tempfile::tempdir().unwrap();let root=dir.path().to_str().unwrap();
        fs::write(path(root),"broken").unwrap(); assert!(load(root).is_err());
    }
    #[test] fn consumption_survives_reload_and_never_stores_the_token() {
        let dir=tempfile::tempdir().unwrap();let root=dir.path().to_str().unwrap();
        let token="ab".repeat(32);let mut g=grant();g.expires_at=chrono::Utc::now().timestamp()+60;
        save(root,&Registry{version:1,grants:vec![g]}).unwrap();
        assert!(!fs::read_to_string(path(root)).unwrap().contains(&token));
        consume(root,&token).unwrap();assert!(load(root).unwrap().grants[0].consumed);
        assert!(consume(root,&token).is_err());
    }
}
