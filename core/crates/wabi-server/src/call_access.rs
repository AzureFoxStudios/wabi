//! Shared authorization for persisted call state (not media-room consent).
use crate::{
    error::{AppError, Result},
    state::AppState,
};
use std::hash::{Hash, Hasher};
use tokio::sync::{Mutex, MutexGuard};
use wabidb::{
    domain::{CallSession, ChannelKind},
    engine::wabi_store::WabiStore,
};

/// Bounded lock striping serializes read/check/write/push for a session on this
/// single authority. No attacker-controlled map, and no new persistence layer.
pub struct SessionLocks([Mutex<()>; 64]);
impl Default for SessionLocks {
    fn default() -> Self {
        Self(std::array::from_fn(|_| Mutex::new(())))
    }
}
impl SessionLocks {
    pub async fn lock(&self, id: &str) -> MutexGuard<'_, ()> {
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        id.hash(&mut hash);
        self.0[hash.finish() as usize % self.0.len()].lock().await
    }
}

pub async fn require_principal(state: &AppState, uid: i64) -> Result<()> {
    if uid <= 0
        || !state
            .wdb
            .get_user(uid as u64)
            .await?
            .is_some_and(|u| u.is_active)
    {
        return Err(AppError::Unauthorized("Active account required".into()));
    }
    Ok(())
}

pub fn direct_pair(id: &str) -> Result<Option<[u64; 2]>> {
    let Some(pair) = id.strip_prefix("dm:") else {
        return Ok(None);
    };
    let parts: Vec<_> = pair.split(':').collect();
    let parse = |s: &str| {
        s.strip_prefix("user-")
            .and_then(|s| s.parse::<i64>().ok())
            .filter(|u| *u > 0)
    };
    if parts.len() == 2 {
        if let (Some(a), Some(b)) = (parse(parts[0]), parse(parts[1])) {
            if a != b && parts[0] < parts[1] && id == format!("dm:user-{a}:user-{b}") {
                return Ok(Some([a as u64, b as u64]));
            }
        }
    }
    Err(AppError::BadRequest(
        "Invalid direct-call session key".into(),
    ))
}

/// Return the canonical scope. Direct UI channel hints are deliberately ignored:
/// a call from People need not already have a persisted DM conversation.
pub async fn require_scope(state: &AppState, uid: i64, id: &str, channel: &str) -> Result<String> {
    require_principal(state, uid).await?;
    if id.is_empty() || id.len() > 256 || id.chars().any(char::is_control) {
        return Err(AppError::BadRequest("Invalid call session ID".into()));
    }
    if let Some(pair) = direct_pair(id)? {
        if !pair.contains(&(uid as u64)) {
            return Err(AppError::Forbidden(
                "Not a participant of this direct call".into(),
            ));
        }
        return Ok(id.to_string());
    }
    if id
        .strip_prefix("channel:")
        .is_some_and(|key| key != channel)
    {
        return Err(AppError::Forbidden(
            "Session key does not match channel".into(),
        ));
    }
    let row = crate::channel_access::require_access(state, uid, channel).await?;
    if !matches!(row.channel_kind, ChannelKind::Voice | ChannelKind::GroupDm) {
        return Err(AppError::BadRequest("Not a call channel".into()));
    }
    Ok(channel.to_string())
}

pub async fn require_session(state: &AppState, uid: i64, id: &str) -> Result<CallSession> {
    let session = state
        .wdb
        .get_call_session(id)
        .await?
        .ok_or_else(|| AppError::NotFound("Call session not found".into()))?;
    require_scope(state, uid, id, &session.channel_id).await?;
    Ok(session)
}

pub async fn require_participant(state: &AppState, session: &CallSession, uid: u64) -> Result<()> {
    if !session.active
        || !state
            .wdb
            .get_call_participants(&session.session_id)
            .await?
            .iter()
            .any(|p| p.user_id == uid && p.left_at_micros.is_none())
    {
        return Err(AppError::Forbidden(
            "Active call participation required".into(),
        ));
    }
    Ok(())
}

pub fn signal_visible(signal: &wabidb::domain::CallSignal, uid: u64) -> bool {
    signal.target_user_id.is_none()
        || signal.target_user_id == Some(uid)
        || signal.from_user_id == uid
}
