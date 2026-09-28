//! Voluntary browser file caches. The Authority keeps ownership, authorization
//! and file identity; peers receive no node/admin credential or durable state.
//! Sessions and delivery tickets are deliberately short-lived and memory-only.
use crate::{
    auth_extractor::AuthUser,
    error::{AppError, Result},
    state::AppState,
    upload_registry::UploadKind,
};
use axum::{
    extract::{Path, State},
    http::HeaderMap,
    routing::{get, post, put},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::Arc,
};
use tokio::sync::Mutex;

const MAX_FILE: u64 = 8 * 1024 * 1024;
const LEASE_MS: i64 = 45_000;
const TICKET_MS: i64 = 30_000;
fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn bad(s: &str) -> AppError {
    AppError::BadRequest(s.into())
}
fn denied() -> AppError {
    AppError::Forbidden("Booster or file access is unavailable".into())
}

pub struct Boosters {
    policy_path: PathBuf,
    inner: Mutex<Data>,
    hash_slots: tokio::sync::Semaphore,
}
#[derive(Default)]
struct Data {
    enabled: bool,
    sessions: HashMap<String, Session>,
    tickets: HashMap<String, Ticket>,
    verified_bytes: u64,
    completed: u64,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    id: String,
    owner: i64,
    name: String,
    #[serde(rename = "uploadKiBPerSecond")]
    upload_kib_per_second: u32,
    #[serde(rename = "cacheMiB")]
    cache_mib: u32,
    #[serde(rename = "sessionMiB")]
    session_mib: u32,
    heartbeat_at: i64,
    sent_bytes: u64,
    verified_bytes: u64,
    files: Vec<FileIdentity>,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileIdentity {
    path: String,
    hash: String,
    size: u64,
}
#[derive(Clone)]
struct Ticket {
    id: String,
    source: String,
    source_owner: i64,
    recipient: i64,
    file: FileIdentity,
    offer: String,
    answer: Option<String>,
    expires: i64,
    completed: bool,
}
impl Data {
    fn prune(&mut self) {
        let at = now();
        self.sessions.retain(|_, s| at - s.heartbeat_at <= LEASE_MS);
        self.tickets
            .retain(|_, t| t.expires > at && self.sessions.contains_key(&t.source));
    }
    fn remove(&mut self, id: &str) {
        self.sessions.remove(id);
        self.tickets.retain(|_, t| t.source != id);
    }
}
impl Boosters {
    pub fn open(data_dir: &str) -> anyhow::Result<Self> {
        let policy_path = PathBuf::from(data_dir).join("volunteer_boosters.json");
        let enabled = match std::fs::read(&policy_path) {
            Ok(bytes) => serde_json::from_slice::<Policy>(&bytes)?.enabled,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Err(e) => return Err(e.into()),
        };
        Ok(Self {
            policy_path,
            hash_slots: tokio::sync::Semaphore::new(4),
            inner: Mutex::new(Data {
                enabled,
                ..Data::default()
            }),
        })
    }
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Policy {
    enabled: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Start {
    consent: bool,
    name: String,
    #[serde(rename = "uploadKiBPerSecond")]
    upload_kib_per_second: u32,
    #[serde(rename = "cacheMiB")]
    cache_mib: u32,
    #[serde(rename = "sessionMiB")]
    session_mib: u32,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Heartbeat {
    files: Vec<FileIdentity>,
    sent_bytes: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FileRequest {
    path: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Offer {
    source: String,
    path: String,
    offer: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Answer {
    answer: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    hash: String,
}

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/status", get(status))
        .route("/admin", get(admin))
        .route("/policy", put(policy))
        .route("/sessions", post(start))
        .route("/sessions/{id}", axum::routing::delete(stop))
        .route("/sessions/{id}/heartbeat", post(heartbeat))
        .route("/sessions/{id}/offers", get(offers))
        .route("/file", post(file))
        .route("/tickets", post(offer))
        .route("/tickets/{id}", get(ticket))
        .route("/tickets/{id}/answer", post(answer))
        .route("/tickets/{id}/receipt", post(receipt))
        .layer(axum::extract::DefaultBodyLimit::max(64 * 1024))
        .with_state(state)
}
fn member(auth: &AuthUser) -> Result<()> {
    if auth.is_guest || auth.is_bot {
        return Err(denied());
    }
    Ok(())
}
async fn enabled(state: &AppState) -> Result<()> {
    if !state.boosters.inner.lock().await.enabled {
        return Err(denied());
    }
    Ok(())
}
async fn admin_gate(state: &Arc<AppState>, headers: &HeaderMap) -> Result<()> {
    super::admin::admin_auth(headers, state)
        .await
        .map_err(|_| denied())?;
    Ok(())
}
async fn status(auth: AuthUser, State(state): State<Arc<AppState>>) -> Result<Json<Value>> {
    member(&auth)?;
    let mut data = state.boosters.inner.lock().await;
    data.prune();
    Ok(Json(
        json!({"enabled":data.enabled,"maxFileBytes":MAX_FILE,"sessions":data.sessions.values().filter(|s| s.owner==auth.user_id).map(public_session).collect::<Vec<_>>() }),
    ))
}
fn public_session(s: &Session) -> Value {
    json!({"id":s.id,"owner":s.owner,"name":s.name,"uploadKiBPerSecond":s.upload_kib_per_second,"cacheMiB":s.cache_mib,"sessionMiB":s.session_mib,"heartbeatAt":s.heartbeat_at,"sentBytes":s.sent_bytes,"verifiedBytes":s.verified_bytes,"cachedFiles":s.files.len(),"cachedBytes":s.files.iter().map(|f|f.size).sum::<u64>()})
}
async fn admin(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Result<Json<Value>> {
    admin_gate(&state, &headers).await?;
    let mut data = state.boosters.inner.lock().await;
    data.prune();
    Ok(Json(
        json!({"enabled":data.enabled,"sessions":data.sessions.values().map(public_session).collect::<Vec<_>>(),"recipientConfirmedBytes":data.verified_bytes,"completedTransfers":data.completed,"measurement":"Receipts from authenticated recipients after hash verification; not independent bandwidth measurement","observedAt":now()}),
    ))
}
async fn policy(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<Policy>,
) -> Result<Json<Value>> {
    admin_gate(&state, &headers).await?;
    let mut data = state.boosters.inner.lock().await;
    let tmp = state.boosters.policy_path.with_extension("json.tmp");
    tokio::fs::write(
        &tmp,
        serde_json::to_vec(&req).map_err(|e| AppError::Internal(e.to_string()))?,
    )
    .await?;
    tokio::fs::rename(tmp, &state.boosters.policy_path).await?;
    data.enabled = req.enabled;
    if !req.enabled {
        data.sessions.clear();
        data.tickets.clear();
    }
    Ok(Json(json!({"enabled":data.enabled})))
}
async fn start(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    Json(req): Json<Start>,
) -> Result<Json<Value>> {
    member(&auth)?;
    if !req.consent
        || req.name.trim().is_empty()
        || req.name.chars().count() > 60
        || !(16..=8192).contains(&req.upload_kib_per_second)
        || !(8..=128).contains(&req.cache_mib)
        || !(8..=4096).contains(&req.session_mib)
    {
        return Err(bad(
            "Explicit consent, a device name, and valid contribution limits are required",
        ));
    }
    let mut data = state.boosters.inner.lock().await;
    data.prune();
    if !data.enabled {
        return Err(denied());
    }
    if data.sessions.len() >= 128
        || data
            .sessions
            .values()
            .filter(|s| s.owner == auth.user_id)
            .count()
            >= 4
    {
        return Err(AppError::TooManyRequests(
            "Booster session limit reached".into(),
        ));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let session = Session {
        id: id.clone(),
        owner: auth.user_id,
        name: req.name.trim().into(),
        upload_kib_per_second: req.upload_kib_per_second,
        cache_mib: req.cache_mib,
        session_mib: req.session_mib,
        heartbeat_at: now(),
        sent_bytes: 0,
        verified_bytes: 0,
        files: vec![],
    };
    data.sessions.insert(id.clone(), session);
    Ok(Json(json!({"id":id})))
}
async fn stop(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    member(&auth)?;
    let is_admin = state.is_admin(auth.user_id).await;
    let mut data = state.boosters.inner.lock().await;
    if let Some(session) = data.sessions.get(&id) {
        if session.owner != auth.user_id && !is_admin {
            return Err(denied());
        }
    }
    data.remove(&id);
    Ok(Json(json!({"stopped":true})))
}
fn filename(path: &str) -> Result<&str> {
    let name = path.strip_prefix("/uploads/").ok_or_else(denied)?;
    if name.is_empty()
        || name.len() > 255
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
        || name == "."
        || name == ".."
    {
        return Err(denied());
    }
    Ok(name)
}
async fn file_access(state: &AppState, user: i64, path: &str) -> Result<PathBuf> {
    let name = filename(path)?;
    if state.upload_registry.is_revoked(name).await {
        return Err(denied());
    }
    let meta = state.upload_registry.get(name).await.ok_or_else(denied)?;
    if meta.kind != UploadKind::Attachment || meta.size > MAX_FILE {
        return Err(denied());
    }
    let channel = meta.channel_id.ok_or_else(denied)?;
    let channel = crate::channel_access::require_access(state, user, &channel).await?;
    // Private rooms and DMs deliberately do not participate in the first release.
    if crate::channel_access::is_conversation(channel.channel_kind) {
        return Err(denied());
    }
    let root = tokio::fs::canonicalize(&state.config.uploads_dir).await?;
    let target = tokio::fs::canonicalize(root.join(name)).await?;
    if target.parent() != Some(root.as_path()) {
        return Err(denied());
    }
    Ok(target)
}
async fn identity(state: &AppState, user: i64, path: &str) -> Result<FileIdentity> {
    use tokio::io::AsyncReadExt;
    let _slot = state
        .boosters
        .hash_slots
        .try_acquire()
        .map_err(|_| AppError::TooManyRequests("File checks are busy".into()))?;
    let target = file_access(state, user, path).await?;
    let mut bytes = vec![];
    tokio::fs::File::open(target)
        .await?
        .take(MAX_FILE + 1)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() as u64 > MAX_FILE {
        return Err(denied());
    }
    Ok(FileIdentity {
        path: path.into(),
        hash: hex::encode(Sha256::digest(&bytes)),
        size: bytes.len() as u64,
    })
}
async fn heartbeat(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<Heartbeat>,
) -> Result<Json<Value>> {
    member(&auth)?;
    enabled(&state).await?;
    {
        let mut data = state.boosters.inner.lock().await;
        data.prune();
        if data
            .sessions
            .get(&id)
            .is_none_or(|s| s.owner != auth.user_id)
        {
            return Err(denied());
        }
    }
    if req.files.len() > 16 {
        return Err(bad("At most 16 cached files are allowed"));
    }
    let mut seen = HashSet::new();
    let mut files = vec![];
    for f in req.files {
        if !seen.insert(f.path.clone())
            || f.size > MAX_FILE
            || f.hash.len() != 64
            || !f.hash.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(bad("Invalid cache inventory"));
        }
        // Access is rechecked on every heartbeat. Hash is verified on ticket creation.
        if file_access(&state, auth.user_id, &f.path).await.is_ok() {
            files.push(f);
        }
    }
    let mut data = state.boosters.inner.lock().await;
    if !data.enabled {
        return Err(denied());
    }
    let s = data
        .sessions
        .get_mut(&id)
        .filter(|s| s.owner == auth.user_id)
        .ok_or_else(denied)?;
    if files.iter().map(|f| f.size).sum::<u64>() > s.cache_mib as u64 * 1048576
        || req.sent_bytes < s.sent_bytes
        || req.sent_bytes > s.session_mib as u64 * 1048576
    {
        return Err(bad("Contribution exceeds configured limits"));
    }
    s.files = files;
    s.sent_bytes = req.sent_bytes;
    s.heartbeat_at = now();
    Ok(Json(
        json!({"acceptedPaths":s.files.iter().map(|f|&f.path).collect::<Vec<_>>()}),
    ))
}
async fn file(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    Json(req): Json<FileRequest>,
) -> Result<Json<Value>> {
    member(&auth)?;
    enabled(&state).await?;
    let file = identity(&state, auth.user_id, &req.path).await?;
    let mut data = state.boosters.inner.lock().await;
    data.prune();
    let candidates: Vec<_> = data
        .sessions
        .values()
        .filter(|s| {
            s.owner != auth.user_id
                && s.sent_bytes + file.size <= s.session_mib as u64 * 1048576
                && file.size <= s.upload_kib_per_second as u64 * 1024 * 15
                && s.files.contains(&file)
        })
        .map(|s| s.id.clone())
        .take(3)
        .collect();
    Ok(Json(json!({"file":file,"candidates":candidates})))
}
async fn offer(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    Json(req): Json<Offer>,
) -> Result<Json<Value>> {
    member(&auth)?;
    enabled(&state).await?;
    if req.offer.len() > 32_768 || req.offer.is_empty() {
        return Err(bad("Invalid connection offer"));
    }
    let file = identity(&state, auth.user_id, &req.path).await?;
    let source = {
        let mut data = state.boosters.inner.lock().await;
        data.prune();
        data.sessions.get(&req.source).cloned().ok_or_else(denied)?
    };
    file_access(&state, source.owner, &req.path).await?;
    let mut data = state.boosters.inner.lock().await;
    data.prune();
    let live = data.sessions.get(&req.source).ok_or_else(denied)?;
    if !data.enabled
        || live.owner == auth.user_id
        || !live.files.contains(&file)
        || live.sent_bytes + file.size > live.session_mib as u64 * 1048576
    {
        return Err(denied());
    }
    if data.tickets.len() >= 128
        || data
            .tickets
            .values()
            .filter(|t| !t.completed && (t.recipient == auth.user_id || t.source == req.source))
            .count()
            >= 2
    {
        return Err(AppError::TooManyRequests(
            "A transfer is already in progress".into(),
        ));
    }
    let id = uuid::Uuid::new_v4().to_string();
    data.tickets.insert(
        id.clone(),
        Ticket {
            id: id.clone(),
            source: req.source,
            source_owner: source.owner,
            recipient: auth.user_id,
            file,
            offer: req.offer,
            answer: None,
            expires: now() + TICKET_MS,
            completed: false,
        },
    );
    Ok(Json(json!({"id":id})))
}
async fn offers(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    member(&auth)?;
    let mut data = state.boosters.inner.lock().await;
    data.prune();
    if !data.enabled
        || data
            .sessions
            .get(&id)
            .is_none_or(|s| s.owner != auth.user_id)
    {
        return Err(denied());
    }
    Ok(Json(
        json!({"offers":data.tickets.values().filter(|t|t.source==id && t.answer.is_none() && !t.completed).map(|t|json!({"id":t.id,"file":t.file,"offer":t.offer})).collect::<Vec<_>>()}),
    ))
}
async fn checked_ticket(state: &AppState, id: &str) -> Result<Ticket> {
    let ticket = {
        let mut data = state.boosters.inner.lock().await;
        data.prune();
        if !data.enabled {
            return Err(denied());
        }
        data.tickets.get(id).cloned().ok_or_else(denied)?
    };
    file_access(state, ticket.recipient, &ticket.file.path).await?;
    file_access(state, ticket.source_owner, &ticket.file.path).await?;
    Ok(ticket)
}
async fn ticket(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    member(&auth)?;
    let ticket = checked_ticket(&state, &id).await?;
    if ticket.recipient != auth.user_id {
        return Err(denied());
    }
    Ok(Json(json!({"answer":ticket.answer})))
}
async fn answer(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<Answer>,
) -> Result<Json<Value>> {
    member(&auth)?;
    if req.answer.len() > 32_768 || req.answer.is_empty() {
        return Err(bad("Invalid answer"));
    }
    let ticket = checked_ticket(&state, &id).await?;
    if ticket.source_owner != auth.user_id {
        return Err(denied());
    }
    let mut data = state.boosters.inner.lock().await;
    let ticket = data.tickets.get_mut(&id).ok_or_else(denied)?;
    if ticket.answer.is_some() {
        return Err(AppError::Conflict("Already answered".into()));
    }
    ticket.answer = Some(req.answer);
    Ok(Json(json!({"ok":true})))
}
async fn receipt(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<Receipt>,
) -> Result<Json<Value>> {
    member(&auth)?;
    let ticket = checked_ticket(&state, &id).await?;
    if ticket.recipient != auth.user_id || ticket.file.hash != req.hash {
        return Err(denied());
    }
    let mut data = state.boosters.inner.lock().await;
    let t = data.tickets.get_mut(&id).ok_or_else(denied)?;
    if !t.completed {
        t.completed = true;
        data.verified_bytes += ticket.file.size;
        data.completed += 1;
        if let Some(s) = data.sessions.get_mut(&ticket.source) {
            s.verified_bytes += ticket.file.size;
        }
    }
    Ok(Json(json!({"ok":true})))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unsafe_paths_and_expired_sessions_are_rejected() {
        for p in [
            "/uploads/../secret",
            "/uploads/%2e%2e",
            "/uploads/a?x=y",
            "https://other/a",
            "/uploads/..",
        ] {
            assert!(filename(p).is_err());
        }
        assert_eq!(filename("/uploads/abc-123.bin").unwrap(), "abc-123.bin");
        let mut d = Data::default();
        d.sessions.insert(
            "x".into(),
            Session {
                id: "x".into(),
                owner: 1,
                name: "x".into(),
                upload_kib_per_second: 16,
                cache_mib: 8,
                session_mib: 8,
                heartbeat_at: now() - LEASE_MS - 1,
                sent_bytes: 0,
                verified_bytes: 0,
                files: vec![],
            },
        );
        d.prune();
        assert!(d.sessions.is_empty());
    }
}
