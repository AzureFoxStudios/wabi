//! Small, Authority-owned field pilot for consenting registered accounts.
//! Only latest reports are retained. The sidecar is server-readable and is not
//! a rescue, background location, or end-to-end encrypted transport.

use axum::{
    extract::{DefaultBodyLimit, Path, State},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    io::Write,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use uuid::Uuid;
use wabidb::engine::wabi_store::WabiStore;

use crate::{
    auth_extractor::AuthUser,
    error::{AppError, Result},
    state::AppState,
};

const STORE_FILE: &str = "field_sessions_v1.json";
const UNAVAILABLE: &str =
    "Field sessions could not be read. Changes are paused until the field store is restored.";
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_SESSIONS: usize = 4;
const MAX_PARTICIPANTS: usize = 32;
const MAX_RECEIPTS_PER_PARTICIPANT: usize = 128;
const MIN_DURATION_MINUTES: u32 = 5;
const MAX_DURATION_MINUTES: u32 = 120;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum CheckinStatus {
    Okay,
    Help,
}

impl CheckinStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Okay => "okay",
            Self::Help => "help",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LastPosition {
    x: f64,
    y: f64,
    source: String,
    observed_at: i64,
    received_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CheckinRecord {
    id: String,
    status: CheckinStatus,
    x: Option<f64>,
    y: Option<f64>,
    source: String,
    observed_at: i64,
    received_at: i64,
    acknowledged_at: Option<i64>,
    acknowledged_by_user_id: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HelpAcknowledgement {
    id: String,
    acknowledged_at: i64,
    acknowledged_by_user_id: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReceiptRecord {
    nonce: String,
    fingerprint: String,
    checkin_id: String,
    received_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ParticipantRecord {
    user_id: u64,
    consented: bool,
    last_checkin: Option<CheckinRecord>,
    #[serde(default)]
    last_help: Option<CheckinRecord>,
    #[serde(default)]
    last_help_acknowledgement: Option<HelpAcknowledgement>,
    last_position: Option<LastPosition>,
    recent_receipts: Vec<ReceiptRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionRecord {
    id: String,
    title: String,
    leader_user_id: u64,
    created_at: i64,
    expires_at: i64,
    map_image_url: Option<String>,
    participants: Vec<ParticipantRecord>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct FieldStore {
    schema: u8,
    sessions: Vec<SessionRecord>,
}

impl Default for FieldStore {
    fn default() -> Self {
        Self {
            schema: 1,
            sessions: Vec::new(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ParticipantView {
    user_id: u64,
    consented: bool,
    last_checkin: Option<CheckinRecord>,
    pending_help: Option<CheckinRecord>,
    last_help_acknowledgement: Option<HelpAcknowledgement>,
    last_position: Option<LastPosition>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionView {
    id: String,
    title: String,
    leader_user_id: u64,
    created_at: i64,
    expires_at: i64,
    map_image_url: Option<String>,
    is_leader: bool,
    participants: Vec<ParticipantView>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InvitationView {
    id: String,
    title: String,
    leader_user_id: u64,
    expires_at: i64,
}

#[derive(Serialize)]
struct SessionResponse {
    session: SessionView,
}

#[derive(Serialize)]
struct SessionsResponse {
    sessions: Vec<SessionView>,
    invitations: Vec<InvitationView>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CheckinReceipt {
    checkin_id: String,
    received_at: i64,
    duplicate: bool,
}

#[derive(Serialize)]
struct CheckinResponse {
    session: SessionView,
    receipt: CheckinReceipt,
}

#[derive(Serialize)]
struct OkResponse {
    ok: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateSessionInput {
    title: String,
    participant_ids: Vec<u64>,
    duration_minutes: u32,
    map_image_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CheckinInput {
    nonce: String,
    status: CheckinStatus,
    x: Option<f64>,
    y: Option<f64>,
}

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    // A field session stores precise voluntary positions in plaintext. Operators
    // must explicitly opt in on the Authority before any session route exists.
    let router = Router::new();
    if !pilot_enabled() {
        return router
            .route("/capability", get(pilot_disabled))
            .layer(axum::middleware::from_fn(super::games::no_store))
            .with_state(state);
    }
    start_expiry_reaper(&state);
    router
        .route("/capability", get(pilot_capability))
        .route("/sessions", get(list_sessions).post(create_session))
        .route("/sessions/{session_id}", get(get_session))
        .route("/sessions/{session_id}/consent", post(consent))
        .route("/sessions/{session_id}/checkins", post(checkin))
        .route(
            "/sessions/{session_id}/checkins/{checkin_id}/ack",
            post(acknowledge),
        )
        .route("/sessions/{session_id}/leave", post(leave))
        .route(
            "/sessions/{session_id}/participants/{user_id}/revoke",
            post(revoke),
        )
        .route("/sessions/{session_id}/end", post(end_session))
        .layer(DefaultBodyLimit::max(8 * 1024))
        .layer(axum::middleware::from_fn(super::games::no_store))
        .with_state(state)
}

fn pilot_enabled() -> bool {
    std::env::var("WABI_FIELD_PILOT")
        .ok()
        .is_some_and(|value| value.trim() == "1")
}

async fn pilot_disabled() -> Result<Json<serde_json::Value>> {
    Err(not_found())
}
async fn pilot_capability() -> Json<serde_json::Value> {
    Json(serde_json::json!({"enabled": true}))
}

fn start_expiry_reaper(state: &Arc<AppState>) {
    let weak = Arc::downgrade(state);
    let data_dir = state.config.data_dir.clone();
    let operations = state.instance_operations.clone();
    // The first pass runs at startup; subsequent passes bound idle-time
    // retention. A weak state handle ends the task after the Authority stops.
    tokio::spawn(async move {
        loop {
            if weak.upgrade().is_none() {
                break;
            }
            if let Err(error) = operations
                .run(async { read_store(&data_dir, now_ms()) })
                .await
            {
                tracing::warn!(
                    ?error,
                    "Field pilot expiry sweep failed; field API remains fail-closed"
                );
            }
            tokio::time::sleep(Duration::from_secs(30)).await;
        }
    });
}

fn unavailable() -> AppError {
    AppError::Internal(UNAVAILABLE.into())
}
fn not_found() -> AppError {
    AppError::NotFound("Field session unavailable".into())
}
fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn store_path(data_dir: &str) -> PathBuf {
    PathBuf::from(data_dir).join(STORE_FILE)
}

fn disk_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn valid_map_image_url(url: &str) -> bool {
    let Some(filename) = url.strip_prefix("/uploads/") else {
        return false;
    };
    if filename.is_empty()
        || filename.len() > 160
        || filename.starts_with('.')
        || filename.contains("..")
    {
        return false;
    }
    if !filename
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        return false;
    }
    let lower = filename.to_ascii_lowercase();
    [".png", ".jpg", ".jpeg", ".webp", ".gif"]
        .iter()
        .any(|extension| lower.ends_with(extension))
}

fn valid_point(x: f64, y: f64) -> bool {
    x.is_finite() && y.is_finite() && (0.0..=1.0).contains(&x) && (0.0..=1.0).contains(&y)
}

fn valid_nonce(nonce: &str) -> bool {
    !nonce.is_empty()
        && nonce.len() <= 80
        && nonce
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn validate_store(store: &FieldStore) -> Result<()> {
    if store.schema != 1 || store.sessions.len() > MAX_SESSIONS {
        return Err(unavailable());
    }
    let mut session_ids = HashSet::new();
    for session in &store.sessions {
        if session.id.len() > 80
            || !session.id.starts_with("field-")
            || !session_ids.insert(&session.id)
            || session.title.trim().is_empty()
            || session.title.chars().count() > 80
            || session.leader_user_id == 0
            || session.created_at <= 0
            || session.expires_at <= session.created_at
            || session.expires_at - session.created_at > i64::from(MAX_DURATION_MINUTES) * 60_000
            || session.participants.is_empty()
            || session.participants.len() > MAX_PARTICIPANTS
            || session
                .map_image_url
                .as_deref()
                .is_some_and(|url| !valid_map_image_url(url))
        {
            return Err(unavailable());
        }
        let mut participant_ids = HashSet::new();
        let mut has_leader = false;
        for participant in &session.participants {
            if participant.user_id == 0
                || !participant_ids.insert(participant.user_id)
                || participant.recent_receipts.len() > MAX_RECEIPTS_PER_PARTICIPANT
                || (!participant.consented
                    && (participant.last_checkin.is_some()
                        || participant.last_help.is_some()
                        || participant.last_position.is_some()))
            {
                return Err(unavailable());
            }
            if participant.user_id == session.leader_user_id {
                has_leader = participant.consented;
            }
            if participant.last_position.as_ref().is_some_and(|position| {
                !valid_point(position.x, position.y)
                    || position.source != "manual"
                    || position.received_at <= 0
                    || position.observed_at <= 0
            }) || participant.last_checkin.as_ref().is_some_and(|item| {
                item.id.is_empty()
                    || item.source != "manual"
                    || item.received_at <= 0
                    || item.observed_at <= 0
                    || match (item.x, item.y) {
                        (Some(x), Some(y)) => !valid_point(x, y),
                        (None, None) => false,
                        _ => true,
                    }
            }) || participant.last_help.as_ref().is_some_and(|item| {
                item.id.is_empty()
                    || item.status != CheckinStatus::Help
                    || item.source != "manual"
                    || item.acknowledged_at.is_some()
                    || item.received_at <= 0
                    || item.observed_at <= 0
                    || match (item.x, item.y) {
                        (Some(x), Some(y)) => !valid_point(x, y),
                        (None, None) => false,
                        _ => true,
                    }
            }) || participant
                .last_help_acknowledgement
                .as_ref()
                .is_some_and(|ack| {
                    ack.id.is_empty()
                        || ack.acknowledged_at <= 0
                        || ack.acknowledged_by_user_id != session.leader_user_id
                })
            {
                return Err(unavailable());
            }
            let mut nonces = HashSet::new();
            if participant.recent_receipts.iter().any(|item| {
                !valid_nonce(&item.nonce)
                    || !nonces.insert(&item.nonce)
                    || item.fingerprint.len() != 64
                    || item.checkin_id.is_empty()
                    || item.received_at <= 0
            }) {
                return Err(unavailable());
            }
        }
        if !has_leader {
            return Err(unavailable());
        }
    }
    Ok(())
}

fn read_unlocked(data_dir: &str) -> Result<FieldStore> {
    let path = store_path(data_dir);
    match std::fs::symlink_metadata(&path) {
        Ok(metadata)
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || metadata.len() > MAX_FILE_BYTES =>
        {
            return Err(unavailable())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(FieldStore::default())
        }
        Err(_) => return Err(unavailable()),
        _ => {}
    }
    let bytes = std::fs::read(path).map_err(|_| unavailable())?;
    let store: FieldStore = serde_json::from_slice(&bytes).map_err(|_| unavailable())?;
    validate_store(&store)?;
    Ok(store)
}

fn write_unlocked(data_dir: &str, store: &FieldStore) -> Result<()> {
    validate_store(store)?;
    let path = store_path(data_dir);
    let parent = path.parent().ok_or_else(unavailable)?;
    std::fs::create_dir_all(parent).map_err(|_| unavailable())?;
    let bytes = serde_json::to_vec(store).map_err(|_| unavailable())?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(unavailable());
    }
    let temporary = parent.join(format!(".field-sessions-{}.tmp", Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary).map_err(|_| unavailable())?;
    let result = (|| -> std::io::Result<()> {
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, &path)?;
        #[cfg(unix)]
        std::fs::File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result.map_err(|_| unavailable())
}

fn prune_expired(store: &mut FieldStore, now: i64) -> bool {
    let before = store.sessions.len();
    store.sessions.retain(|session| session.expires_at > now);
    store.sessions.len() != before
}

fn read_store(data_dir: &str, now: i64) -> Result<FieldStore> {
    let _guard = disk_lock().lock().map_err(|_| unavailable())?;
    let mut store = read_unlocked(data_dir)?;
    if prune_expired(&mut store, now) {
        write_unlocked(data_dir, &store)?;
    }
    Ok(store)
}

fn mutate_store<T>(
    data_dir: &str,
    now: i64,
    action: impl FnOnce(&mut FieldStore) -> Result<T>,
) -> Result<T> {
    let _guard = disk_lock().lock().map_err(|_| unavailable())?;
    let mut store = read_unlocked(data_dir)?;
    let pruned = prune_expired(&mut store, now);
    match action(&mut store) {
        Ok(value) => {
            write_unlocked(data_dir, &store)?;
            Ok(value)
        }
        Err(error) => {
            if pruned {
                write_unlocked(data_dir, &store)?;
            }
            Err(error)
        }
    }
}

fn session_view(session: &SessionRecord, viewer: u64) -> SessionView {
    SessionView {
        id: session.id.clone(),
        title: session.title.clone(),
        leader_user_id: session.leader_user_id,
        created_at: session.created_at,
        expires_at: session.expires_at,
        map_image_url: session.map_image_url.clone(),
        is_leader: viewer == session.leader_user_id,
        participants: session
            .participants
            .iter()
            .filter(|participant| {
                viewer == session.leader_user_id
                    || participant.consented
                    || participant.user_id == viewer
            })
            .map(|participant| ParticipantView {
                user_id: participant.user_id,
                consented: participant.consented,
                last_checkin: participant.last_checkin.clone(),
                pending_help: participant
                    .last_help
                    .as_ref()
                    .filter(|help| help.acknowledged_at.is_none())
                    .cloned(),
                last_help_acknowledgement: participant.last_help_acknowledgement.clone(),
                last_position: participant.last_position.clone(),
            })
            .collect(),
    }
}

fn can_view(session: &SessionRecord, user_id: u64) -> bool {
    session.leader_user_id == user_id
        || session
            .participants
            .iter()
            .any(|participant| participant.user_id == user_id && participant.consented)
}

fn active_session<'a>(store: &'a FieldStore, session_id: &str) -> Result<&'a SessionRecord> {
    store
        .sessions
        .iter()
        .find(|session| session.id == session_id)
        .ok_or_else(not_found)
}

fn active_session_mut<'a>(
    store: &'a mut FieldStore,
    session_id: &str,
) -> Result<&'a mut SessionRecord> {
    store
        .sessions
        .iter_mut()
        .find(|session| session.id == session_id)
        .ok_or_else(not_found)
}

async fn account(state: &AppState, auth: &AuthUser) -> Result<u64> {
    if auth.user_id <= 0 || auth.is_guest || auth.is_bot {
        return Err(AppError::Forbidden(
            "A registered personal account is required".into(),
        ));
    }
    let user_id = auth.user_id as u64;
    let member = state
        .wdb
        .get_user(user_id)
        .await?
        .ok_or_else(|| AppError::Unauthorized("Account unavailable".into()))?;
    if !member.is_active || member.password_hash.is_empty() || state.is_bot_user(user_id).await {
        return Err(AppError::Unauthorized("Account unavailable".into()));
    }
    Ok(user_id)
}

async fn require_invitees(state: &AppState, leader: u64, ids: &[u64]) -> Result<Vec<u64>> {
    if ids.len() >= MAX_PARTICIPANTS {
        return Err(AppError::BadRequest("Too many participants".into()));
    }
    let mut unique = HashSet::new();
    for id in ids {
        if *id == 0 {
            return Err(AppError::BadRequest("Choose registered members".into()));
        }
        if *id == leader {
            continue;
        }
        if !unique.insert(*id) {
            continue;
        }
        let user = state
            .wdb
            .get_user(*id)
            .await?
            .ok_or_else(|| AppError::BadRequest("Unknown participant".into()))?;
        if !user.is_active || user.password_hash.is_empty() || state.is_bot_user(*id).await {
            return Err(AppError::BadRequest(
                "Choose active registered members".into(),
            ));
        }
    }
    let mut invited: Vec<u64> = unique.into_iter().collect();
    invited.sort_unstable();
    Ok(invited)
}

async fn list_sessions(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
) -> Result<Json<SessionsResponse>> {
    let viewer = account(&state, &auth).await?;
    let store = read_store(&state.config.data_dir, now_ms())?;
    let mut sessions = Vec::new();
    let mut invitations = Vec::new();
    for session in &store.sessions {
        if can_view(session, viewer) {
            sessions.push(session_view(session, viewer));
        } else if session
            .participants
            .iter()
            .any(|participant| participant.user_id == viewer && !participant.consented)
        {
            invitations.push(InvitationView {
                id: session.id.clone(),
                title: session.title.clone(),
                leader_user_id: session.leader_user_id,
                expires_at: session.expires_at,
            });
        }
    }
    Ok(Json(SessionsResponse {
        sessions,
        invitations,
    }))
}

async fn create_session(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Json(input): Json<CreateSessionInput>,
) -> Result<Json<SessionResponse>> {
    let leader = account(&state, &auth).await?;
    if !state.is_admin(leader as i64).await {
        return Err(AppError::Forbidden(
            "Only a server admin can start a field pilot session".into(),
        ));
    }
    let title = input.title.trim();
    if title.is_empty() || title.chars().count() > 80 || title.chars().any(char::is_control) {
        return Err(AppError::BadRequest("Enter a short session title".into()));
    }
    if !(MIN_DURATION_MINUTES..=MAX_DURATION_MINUTES).contains(&input.duration_minutes) {
        return Err(AppError::BadRequest(
            "Session duration must be 5 to 120 minutes".into(),
        ));
    }
    if input
        .map_image_url
        .as_deref()
        .is_some_and(|url| !valid_map_image_url(url))
    {
        return Err(AppError::BadRequest(
            "Use a same-server public image path under /uploads".into(),
        ));
    }
    let invitees = require_invitees(&state, leader, &input.participant_ids).await?;
    let now = now_ms();
    let mut participants = Vec::with_capacity(invitees.len() + 1);
    participants.push(ParticipantRecord {
        user_id: leader,
        consented: true,
        last_checkin: None,
        last_help: None,
        last_help_acknowledgement: None,
        last_position: None,
        recent_receipts: Vec::new(),
    });
    participants.extend(invitees.into_iter().map(|user_id| ParticipantRecord {
        user_id,
        consented: false,
        last_checkin: None,
        last_help: None,
        last_help_acknowledgement: None,
        last_position: None,
        recent_receipts: Vec::new(),
    }));
    let session = SessionRecord {
        id: format!("field-{}", Uuid::new_v4()),
        title: title.to_string(),
        leader_user_id: leader,
        created_at: now,
        expires_at: now + i64::from(input.duration_minutes) * 60_000,
        map_image_url: input.map_image_url,
        participants,
    };
    let view = mutate_store(&state.config.data_dir, now, |store| {
        if store
            .sessions
            .iter()
            .any(|existing| existing.leader_user_id == leader)
        {
            return Err(AppError::Conflict(
                "End the existing field session before starting another".into(),
            ));
        }
        if store.sessions.len() >= MAX_SESSIONS {
            return Err(AppError::Conflict("Too many active field sessions".into()));
        }
        store.sessions.push(session.clone());
        Ok(session_view(&session, leader))
    })?;
    Ok(Json(SessionResponse { session: view }))
}

async fn get_session(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(session_id): Path<String>,
) -> Result<Json<SessionResponse>> {
    let viewer = account(&state, &auth).await?;
    let store = read_store(&state.config.data_dir, now_ms())?;
    let session = active_session(&store, &session_id)?;
    if !can_view(session, viewer) {
        return Err(not_found());
    }
    Ok(Json(SessionResponse {
        session: session_view(session, viewer),
    }))
}

async fn consent(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(session_id): Path<String>,
) -> Result<Json<SessionResponse>> {
    let viewer = account(&state, &auth).await?;
    let now = now_ms();
    let view = mutate_store(&state.config.data_dir, now, |store| {
        let session = active_session_mut(store, &session_id)?;
        let participant = session
            .participants
            .iter_mut()
            .find(|participant| participant.user_id == viewer)
            .ok_or_else(not_found)?;
        participant.consented = true;
        Ok(session_view(session, viewer))
    })?;
    Ok(Json(SessionResponse { session: view }))
}

fn checkin_fingerprint(input: &CheckinInput) -> String {
    let canonical = format!(
        "{}|{:?}|{:?}",
        input.status.as_str(),
        input.x.map(f64::to_bits),
        input.y.map(f64::to_bits)
    );
    hex::encode(Sha256::digest(canonical.as_bytes()))
}

fn checkin_in_session(
    session: &mut SessionRecord,
    user_id: u64,
    input: &CheckinInput,
    now: i64,
) -> Result<CheckinReceipt> {
    let participant = session
        .participants
        .iter_mut()
        .find(|participant| participant.user_id == user_id && participant.consented)
        .ok_or_else(not_found)?;
    let fingerprint = checkin_fingerprint(input);
    if let Some(existing) = participant
        .recent_receipts
        .iter()
        .find(|receipt| receipt.nonce == input.nonce)
    {
        if existing.fingerprint != fingerprint {
            return Err(AppError::Conflict(
                "Check-in nonce was already used for different content".into(),
            ));
        }
        return Ok(CheckinReceipt {
            checkin_id: existing.checkin_id.clone(),
            received_at: existing.received_at,
            duplicate: true,
        });
    }
    if participant.recent_receipts.len() >= MAX_RECEIPTS_PER_PARTICIPANT {
        return Err(AppError::Conflict(
            "Check-in limit reached for this field session".into(),
        ));
    }
    if input.status == CheckinStatus::Help
        && participant
            .last_help
            .as_ref()
            .is_some_and(|help| help.acknowledged_at.is_none())
    {
        return Err(AppError::Conflict(
            "A help request is already waiting for acknowledgement".into(),
        ));
    }
    let id = format!("checkin-{}", Uuid::new_v4());
    let report = CheckinRecord {
        id: id.clone(),
        status: input.status,
        x: input.x,
        y: input.y,
        source: "manual".into(),
        observed_at: now,
        received_at: now,
        acknowledged_at: None,
        acknowledged_by_user_id: None,
    };
    if input.status == CheckinStatus::Help {
        participant.last_help = Some(report.clone());
    }
    participant.last_checkin = Some(report);
    if let (Some(x), Some(y)) = (input.x, input.y) {
        participant.last_position = Some(LastPosition {
            x,
            y,
            source: "manual".into(),
            observed_at: now,
            received_at: now,
        });
    }
    participant.recent_receipts.push(ReceiptRecord {
        nonce: input.nonce.clone(),
        fingerprint,
        checkin_id: id.clone(),
        received_at: now,
    });
    Ok(CheckinReceipt {
        checkin_id: id,
        received_at: now,
        duplicate: false,
    })
}

async fn checkin(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(session_id): Path<String>,
    Json(input): Json<CheckinInput>,
) -> Result<Json<CheckinResponse>> {
    let viewer = account(&state, &auth).await?;
    if !valid_nonce(&input.nonce) {
        return Err(AppError::BadRequest("Use a short check-in nonce".into()));
    }
    match (input.x, input.y) {
        (Some(x), Some(y)) if valid_point(x, y) => {}
        (None, None) => {}
        _ => {
            return Err(AppError::BadRequest(
                "Manual map position requires X and Y between 0 and 1".into(),
            ))
        }
    }
    let now = now_ms();
    let (view, receipt) = mutate_store(&state.config.data_dir, now, |store| {
        let session = active_session_mut(store, &session_id)?;
        let receipt = checkin_in_session(session, viewer, &input, now)?;
        Ok((session_view(session, viewer), receipt))
    })?;
    Ok(Json(CheckinResponse {
        session: view,
        receipt,
    }))
}

async fn acknowledge(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((session_id, checkin_id)): Path<(String, String)>,
) -> Result<Json<SessionResponse>> {
    let viewer = account(&state, &auth).await?;
    let now = now_ms();
    let view = mutate_store(&state.config.data_dir, now, |store| {
        let session = active_session_mut(store, &session_id)?;
        if session.leader_user_id != viewer {
            return Err(not_found());
        }
        let participant = session
            .participants
            .iter_mut()
            .find(|participant| {
                participant
                    .last_help
                    .as_ref()
                    .is_some_and(|help| help.id == checkin_id)
                    || participant
                        .last_help_acknowledgement
                        .as_ref()
                        .is_some_and(|ack| ack.id == checkin_id)
            })
            .ok_or_else(not_found)?;
        if participant
            .last_help
            .as_ref()
            .is_some_and(|help| help.id == checkin_id)
        {
            if let Some(latest) = participant
                .last_checkin
                .as_mut()
                .filter(|item| item.id == checkin_id)
            {
                latest.acknowledged_at = Some(now);
                latest.acknowledged_by_user_id = Some(viewer);
            }
            participant.last_help = None;
            participant.last_help_acknowledgement = Some(HelpAcknowledgement {
                id: checkin_id.clone(),
                acknowledged_at: now,
                acknowledged_by_user_id: viewer,
            });
        }
        Ok(session_view(session, viewer))
    })?;
    Ok(Json(SessionResponse { session: view }))
}

async fn leave(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(session_id): Path<String>,
) -> Result<Json<OkResponse>> {
    let viewer = account(&state, &auth).await?;
    let now = now_ms();
    mutate_store(&state.config.data_dir, now, |store| {
        let session = active_session_mut(store, &session_id)?;
        if session.leader_user_id == viewer {
            return Err(AppError::BadRequest(
                "End the session to leave as leader".into(),
            ));
        }
        let index = session
            .participants
            .iter()
            .position(|participant| participant.user_id == viewer)
            .ok_or_else(not_found)?;
        session.participants.remove(index);
        Ok(())
    })?;
    Ok(Json(OkResponse { ok: true }))
}

async fn revoke(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path((session_id, user_id)): Path<(String, u64)>,
) -> Result<Json<SessionResponse>> {
    let viewer = account(&state, &auth).await?;
    let now = now_ms();
    let view = mutate_store(&state.config.data_dir, now, |store| {
        let session = active_session_mut(store, &session_id)?;
        if session.leader_user_id != viewer || user_id == viewer {
            return Err(not_found());
        }
        let index = session
            .participants
            .iter()
            .position(|participant| participant.user_id == user_id)
            .ok_or_else(not_found)?;
        session.participants.remove(index);
        Ok(session_view(session, viewer))
    })?;
    Ok(Json(SessionResponse { session: view }))
}

async fn end_session(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(session_id): Path<String>,
) -> Result<Json<OkResponse>> {
    let viewer = account(&state, &auth).await?;
    let now = now_ms();
    mutate_store(&state.config.data_dir, now, |store| {
        let index = store
            .sessions
            .iter()
            .position(|session| session.id == session_id && session.leader_user_id == viewer)
            .ok_or_else(not_found)?;
        store.sessions.remove(index);
        Ok(())
    })?;
    Ok(Json(OkResponse { ok: true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(now: i64) -> SessionRecord {
        SessionRecord {
            id: format!("field-{}", Uuid::new_v4()),
            title: "Trail practice".into(),
            leader_user_id: 1,
            created_at: now,
            expires_at: now + 60_000,
            map_image_url: None,
            participants: vec![
                ParticipantRecord {
                    user_id: 1,
                    consented: true,
                    last_checkin: None,
                    last_help: None,
                    last_help_acknowledgement: None,
                    last_position: None,
                    recent_receipts: vec![],
                },
                ParticipantRecord {
                    user_id: 2,
                    consented: false,
                    last_checkin: None,
                    last_help: None,
                    last_help_acknowledgement: None,
                    last_position: None,
                    recent_receipts: vec![],
                },
            ],
        }
    }

    fn input(nonce: &str, status: CheckinStatus, x: Option<f64>, y: Option<f64>) -> CheckinInput {
        CheckinInput {
            nonce: nonce.into(),
            status,
            x,
            y,
        }
    }

    #[test]
    fn sidecar_round_trip_and_corruption_fail_closed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_str().unwrap();
        let now = 1_700_000_000_000;
        let session = sample(now);
        mutate_store(path, now, |store| {
            store.sessions.push(session.clone());
            Ok(())
        })
        .unwrap();
        assert_eq!(read_store(path, now).unwrap().sessions[0].id, session.id);
        std::fs::write(store_path(path), b"{broken").unwrap();
        assert!(read_store(path, now).is_err());
        assert!(mutate_store(path, now, |_store| Ok(())).is_err());
    }

    #[test]
    fn old_retry_cannot_replace_newer_checkin_or_position() {
        let mut session = sample(1_700_000_000_000);
        session.participants[1].consented = true;
        let first = input("first", CheckinStatus::Okay, Some(0.2), Some(0.3));
        let second = input("second", CheckinStatus::Help, None, None);
        let one = checkin_in_session(&mut session, 2, &first, 1_700_000_000_001).unwrap();
        let two = checkin_in_session(&mut session, 2, &second, 1_700_000_000_002).unwrap();
        let retry = checkin_in_session(&mut session, 2, &first, 1_700_000_000_003).unwrap();
        assert!(retry.duplicate);
        assert_eq!(retry.checkin_id, one.checkin_id);
        assert_eq!(
            session.participants[1].last_checkin.as_ref().unwrap().id,
            two.checkin_id
        );
        assert_eq!(
            session.participants[1]
                .last_position
                .as_ref()
                .unwrap()
                .received_at,
            1_700_000_000_001
        );
        assert!(checkin_in_session(
            &mut session,
            2,
            &input("first", CheckinStatus::Help, None, None),
            1_700_000_000_004
        )
        .is_err());
    }

    #[test]
    fn all_receipts_remain_deduplicated_at_the_explicit_cap() {
        let mut session = sample(1_700_000_000_000);
        session.participants[1].consented = true;
        for i in 0..MAX_RECEIPTS_PER_PARTICIPANT {
            checkin_in_session(
                &mut session,
                2,
                &input(&format!("nonce-{i}"), CheckinStatus::Okay, None, None),
                1_700_000_000_001 + i as i64,
            )
            .unwrap();
        }
        let latest = session.participants[1]
            .last_checkin
            .as_ref()
            .unwrap()
            .id
            .clone();
        assert!(checkin_in_session(
            &mut session,
            2,
            &input("nonce-new", CheckinStatus::Help, Some(0.5), Some(0.5)),
            1_700_000_000_200
        )
        .is_err());
        assert!(
            checkin_in_session(
                &mut session,
                2,
                &input("nonce-0", CheckinStatus::Okay, None, None),
                1_700_000_000_201
            )
            .unwrap()
            .duplicate
        );
        assert_eq!(
            session.participants[1].last_checkin.as_ref().unwrap().id,
            latest
        );
    }

    #[test]
    fn declared_record_bounds_fit_the_sidecar_limit() {
        let now = 1_700_000_000_000;
        let mut store = FieldStore::default();
        for s in 0..MAX_SESSIONS {
            let mut session = sample(now);
            session.id = format!("field-{:036}", s);
            session.title = "🗺".repeat(80);
            session.map_image_url = Some(format!("/uploads/{}.png", "x".repeat(148)));
            session.participants.clear();
            for p in 0..MAX_PARTICIPANTS {
                let mut participant = ParticipantRecord {
                    user_id: p as u64 + 1,
                    consented: true,
                    last_checkin: None,
                    last_help: None,
                    last_help_acknowledgement: Some(HelpAcknowledgement {
                        id: format!("checkin-{}", "a".repeat(36)),
                        acknowledged_at: now,
                        acknowledged_by_user_id: 1,
                    }),
                    last_position: Some(LastPosition {
                        x: 1.0,
                        y: 1.0,
                        source: "manual".into(),
                        observed_at: now,
                        received_at: now,
                    }),
                    recent_receipts: Vec::new(),
                };
                let checkin = CheckinRecord {
                    id: format!("checkin-{}", "a".repeat(36)),
                    status: CheckinStatus::Help,
                    x: Some(1.0),
                    y: Some(1.0),
                    source: "manual".into(),
                    observed_at: now,
                    received_at: now,
                    acknowledged_at: None,
                    acknowledged_by_user_id: None,
                };
                participant.last_checkin = Some(checkin.clone());
                participant.last_help = Some(checkin);
                for r in 0..MAX_RECEIPTS_PER_PARTICIPANT {
                    let prefix = format!("{r}-");
                    participant.recent_receipts.push(ReceiptRecord {
                        nonce: format!("{}{}", prefix, "n".repeat(80 - prefix.len())),
                        fingerprint: "f".repeat(64),
                        checkin_id: format!("checkin-{}", "a".repeat(36)),
                        received_at: now,
                    });
                }
                session.participants.push(participant);
            }
            store.sessions.push(session);
        }
        validate_store(&store).unwrap();
        assert!(serde_json::to_vec(&store).unwrap().len() as u64 <= MAX_FILE_BYTES);
    }

    #[test]
    fn invitation_hides_roster_until_consent_and_expiry_purges() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_str().unwrap();
        let now = 1_700_000_000_000;
        let session = sample(now);
        assert!(can_view(&session, 1));
        assert!(!can_view(&session, 2));
        assert!(!can_view(&session, 3));
        mutate_store(path, now, |store| {
            store.sessions.push(session);
            Ok(())
        })
        .unwrap();
        assert_eq!(read_store(path, now).unwrap().sessions.len(), 1);
        assert!(read_store(path, now + 60_000).unwrap().sessions.is_empty());
        assert!(read_unlocked(path).unwrap().sessions.is_empty());
    }

    #[test]
    fn only_local_public_image_paths_are_accepted() {
        assert!(valid_map_image_url("/uploads/map-1.png"));
        for bad in [
            "https://example.com/map.png",
            "//example.com/map.png",
            "/uploads/../secret.png",
            "/uploads/map.svg",
            "/uploads/map.png?token=abc",
        ] {
            assert!(!valid_map_image_url(bad));
        }
    }
}
