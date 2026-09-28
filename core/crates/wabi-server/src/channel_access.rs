//! Shared channel boundary for REST content and Socket.IO rooms.
//! Discovery is not content access; private conversations are membership-only.
use std::{collections::HashSet, sync::Arc};

use axum::{
    extract::{Path, Request, State},
    http::Method,
    middleware::Next,
    response::Response,
};
use serde::Deserialize;
use wabidb::{
    domain::{Channel, ChannelKind},
    engine::wabi_store::WabiStore,
};

use crate::{
    auth_extractor::AuthUser,
    error::{AppError, Result},
    state::AppState,
};

pub fn is_conversation(kind: ChannelKind) -> bool {
    matches!(kind, ChannelKind::Dm | ChannelKind::GroupDm)
}

/// Explicit ownership wins. Pre-upgrade groups used owner 0: choose the oldest
/// surviving membership with a deterministic tie-breaker, never online order.
pub fn group_owner(channel: &Channel, members: &[wabidb::domain::ChannelMember]) -> Option<u64> {
    members.iter().find(|m| m.user_id == channel.owner_user_id)
        .or_else(|| members.iter().min_by_key(|m| (m.joined_at_micros, m.user_id)))
        .map(|m| m.user_id)
}

pub async fn is_member(state: &AppState, user_id: i64, channel_id: &str) -> Result<bool> {
    if user_id <= 0 {
        return Ok(false);
    }
    // Authorization is on the hot path: use the existing exact secondary key,
    // not a full membership/channel scan. Decode errors propagate, never allow.
    Ok(
        wabidb::projections::channel_members::ChannelMembersProjection::get_member(
            &state.wdb.engine().projection_state(),
            channel_id,
            user_id as u64,
        )?
        .is_some(),
    )
}

/// Persisted Server Center role gate for ordinary channels. Existing channel
/// membership never overrides a stricter current role requirement.
pub async fn channel_role_allows(state: &AppState, user_id: i64, channel_id: &str) -> Result<bool> {
    let required = crate::api::server_center::channel_min_role(state, channel_id).await;
    let community_allowed = crate::api::server_center::channel_community_role_allows(state, user_id, channel_id).await;
    if required.is_none() && community_allowed { return Ok(true); }
    if user_id <= 0 { return Ok(false); }
    let rank = if state.is_owner(user_id).await { 4 }
        else if state.is_admin(user_id).await { 3 }
        else if state.has_role(user_id, "Moderator").await { 2 }
        else {
            match state.wdb.get_user(user_id as u64).await? {
                Some(user) if user.is_active && !user.password_hash.is_empty() => 1,
                _ => 0,
            }
        };
    let minimum = match required.as_deref() {
        None => 0, Some("member") => 1, Some("moderator") => 2, Some("admin") => 3,
        _ => return Err(AppError::Internal("Invalid channel role policy".into())),
    };
    Ok(rank >= minimum && (community_allowed || rank >= 3))
}

/// Require a live channel and its current authorization. Never infer membership
/// from dm-* IDs: doing so resurrects access after removal/deletion/replay.
pub async fn require_access(state: &AppState, user_id: i64, channel_id: &str) -> Result<Channel> {
    let channel = state
        .wdb
        .get_channel(channel_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Channel not found".into()))?;
    let blacklist = state.get_blacklist().await.ok_or_else(|| AppError::Internal("Channel restriction enforcement unavailable".into()))?;
    if blacklist.is_channel_banned(channel_id, user_id).await.is_some() {
        return Err(AppError::Forbidden("Banned from this channel".into()));
    }
    if !is_conversation(channel.channel_kind) && !channel_role_allows(state, user_id, channel_id).await? {
        return Err(AppError::Forbidden("Channel requires a role you have not chosen or been assigned".into()));
    }
    if is_member(state, user_id, channel_id).await?
        || (!is_conversation(channel.channel_kind) && user_id > 0 && state.is_admin(user_id).await)
    {
        return Ok(channel);
    }
    Err(AppError::Forbidden("Channel access denied".into()))
}

/// Joinable ordinary channels plus the caller's private conversations. There is
/// no persisted private/min_role flag on ordinary Channel records today.
pub async fn discoverable_channels(state: &AppState, user_id: i64) -> Result<Vec<Channel>> {
    let blacklist = state.get_blacklist().await.ok_or_else(|| AppError::Internal("Channel restriction enforcement unavailable".into()))?;
    let member_ids: HashSet<_> = state
        .wdb
        .list_channels(Some(user_id as u64))
        .await?
        .into_iter()
        .map(|c| c.channel_id)
        .collect();
    let candidates: Vec<_> = state
        .wdb
        .list_channels(None)
        .await?
        .into_iter()
        .filter(|c| !is_conversation(c.channel_kind) || member_ids.contains(&c.channel_id))
        .collect();
    let mut visible = Vec::with_capacity(candidates.len());
    for channel in candidates {
        if blacklist.is_channel_banned(&channel.channel_id, user_id).await.is_none()
            && (is_conversation(channel.channel_kind) || channel_role_allows(state, user_id, &channel.channel_id).await?) {
            visible.push(channel);
        }
    }
    Ok(visible)
}

async fn require_rules_for_mutation(state: &AppState, user_id: i64, kind: ChannelKind) -> Result<()> {
    if is_conversation(kind) || state.is_owner(user_id).await { return Ok(()); }
    let needs_ack = crate::api::server_center::rules_required_for_post(&state.config.data_dir, user_id)
        .map_err(|error| AppError::Internal(format!("Server rules could not be checked; action refused: {error}")))?;
    if needs_ack {
        return Err(AppError::Forbidden("Read and acknowledge this server's current rules before posting".into()));
    }
    Ok(())
}

/// Content-bearing mutations use this as well as the ordinary access check.
pub async fn require_participation(state: &AppState, user_id: i64, channel_id: &str) -> Result<()> {
    let channel = require_access(state, user_id, channel_id).await?;
    require_rules_for_mutation(state, user_id, channel.channel_kind).await
}

#[derive(Deserialize)]
pub struct ChannelPath {
    channel_id: String,
}

/// Install as a route_layer on a content router whose routes all have a
/// {channel_id}. This protects reads AND future methods, before handler work.
pub async fn require_channel(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Path(path): Path<ChannelPath>,
    request: Request,
    next: Next,
) -> Result<Response> {
    let channel = require_access(&state, auth.user_id, &path.channel_id).await?;
    if request.method() == Method::POST || request.method() == Method::PUT || request.method() == Method::PATCH || request.method() == Method::DELETE
    {
        require_rules_for_mutation(&state, auth.user_id, channel.channel_kind).await?;
    }
    Ok(next.run(request).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn group_ownership_prefers_explicit_owner_then_persisted_join_order() {
        use wabidb::domain::{ChannelMember, MemberRole};
        let mut channel = Channel::new("legacy-group", "crew", 0);
        channel.channel_kind = ChannelKind::GroupDm;
        let member = |user_id, joined_at_micros| ChannelMember {
            channel_id: channel.channel_id.clone(), user_id, joined_at_micros,
            role: MemberRole::Member,
        };
        let mut members = vec![member(2, 30), member(9, 10), member(4, 30)];
        assert_eq!(group_owner(&channel, &members), Some(9), "not the first/lowest user ID");
        members.reverse();
        assert_eq!(group_owner(&channel, &members), Some(9), "index order is not ownership");
        channel.owner_user_id = 4;
        assert_eq!(group_owner(&channel, &members), Some(4));
        channel.owner_user_id = 99;
        assert_eq!(group_owner(&channel, &members), Some(9), "deleted owner recovers deterministically");
        members.retain(|m| m.user_id != 9);
        assert_eq!(group_owner(&channel, &members), Some(2), "equal join times use a stable tie-breaker");
        assert_eq!(group_owner(&channel, &[]), None);
    }
}
