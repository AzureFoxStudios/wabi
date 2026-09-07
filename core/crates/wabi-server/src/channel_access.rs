//! Shared channel boundary for REST content and Socket.IO rooms.
//! Discovery is not content access; private conversations are membership-only.
use std::{collections::HashSet, sync::Arc};

use axum::{
    extract::{Path, Request, State},
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

/// Require a live channel and its current authorization. Never infer membership
/// from dm-* IDs: doing so resurrects access after removal/deletion/replay.
pub async fn require_access(state: &AppState, user_id: i64, channel_id: &str) -> Result<Channel> {
    let channel = state
        .wdb
        .get_channel(channel_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Channel not found".into()))?;
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
    let member_ids: HashSet<_> = state
        .wdb
        .list_channels(Some(user_id as u64))
        .await?
        .into_iter()
        .map(|c| c.channel_id)
        .collect();
    Ok(state
        .wdb
        .list_channels(None)
        .await?
        .into_iter()
        .filter(|c| !is_conversation(c.channel_kind) || member_ids.contains(&c.channel_id))
        .collect())
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
    require_access(&state, auth.user_id, &path.channel_id).await?;
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
