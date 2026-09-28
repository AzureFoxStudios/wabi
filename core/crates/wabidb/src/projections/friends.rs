//! Versioned, server-local friendship state. One row per unordered account pair.
//! The event replaces a pair's state; removal is a durable tombstone event.
use crate::{
    engine::locks::ProjectionState,
    error::{Result, WabiError},
    projections::handler::{DurableEvent, Projection},
};
use serde::{Deserialize, Serialize};

pub const INDEX: &str = "friend_relationships";
pub const EVENT: &str = "friend_relationship_changed_v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FriendState {
    Pending,
    Friends,
    Removed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FriendRelationship {
    pub schema: u8,
    pub low_user_id: u64,
    pub high_user_id: u64,
    pub requested_by: u64,
    pub state: FriendState,
    pub created_at_micros: i64,
}

impl FriendRelationship {
    pub fn new(
        a: u64,
        b: u64,
        requested_by: u64,
        state: FriendState,
        created_at_micros: i64,
    ) -> Self {
        Self {
            schema: 1,
            low_user_id: a.min(b),
            high_user_id: a.max(b),
            requested_by,
            state,
            created_at_micros,
        }
    }

    pub fn id(&self) -> String {
        format!("friend-{}-{}", self.low_user_id, self.high_user_id)
    }
    pub fn contains(&self, user_id: u64) -> bool {
        user_id == self.low_user_id || user_id == self.high_user_id
    }
    pub fn other(&self, user_id: u64) -> Option<u64> {
        if user_id == self.low_user_id {
            Some(self.high_user_id)
        } else if user_id == self.high_user_id {
            Some(self.low_user_id)
        } else {
            None
        }
    }
}

fn key(a: u64, b: u64) -> [u8; 16] {
    let (low, high) = (a.min(b), a.max(b));
    let mut bytes = [0; 16];
    bytes[..8].copy_from_slice(&low.to_be_bytes());
    bytes[8..].copy_from_slice(&high.to_be_bytes());
    bytes
}

pub fn decode(bytes: &[u8]) -> Result<FriendRelationship> {
    let invalid = || WabiError::Corrupt {
        location: INDEX.into(),
        detail: "invalid friendship record".into(),
    };
    if bytes.len() > 512 {
        return Err(invalid());
    }
    let row: FriendRelationship = serde_json::from_slice(bytes).map_err(|_| invalid())?;
    if row.schema != 1
        || row.low_user_id == 0
        || row.low_user_id >= row.high_user_id
        || !row.contains(row.requested_by)
        || row.created_at_micros <= 0
    {
        return Err(invalid());
    }
    Ok(row)
}

pub fn get(state: &ProjectionState, a: u64, b: u64) -> Result<Option<FriendRelationship>> {
    state
        .get(INDEX, &key(a, b))
        .map(|bytes| decode(&bytes))
        .transpose()
}

pub fn list_for(state: &ProjectionState, user_id: u64) -> Result<Vec<FriendRelationship>> {
    let mut rows = Vec::new();
    state.for_each(INDEX, |_key, value| {
        let row = decode(value);
        if row.as_ref().is_ok_and(|row| row.contains(user_id)) || row.is_err() {
            rows.push(row);
        }
    });
    rows.into_iter().collect()
}

pub struct FriendsProjection;
impl Projection for FriendsProjection {
    fn event_type(&self) -> &str {
        EVENT
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let row = decode(&event.payload)?;
        if event.stream_id != format!("friends:{}:{}", row.low_user_id, row.high_user_id) {
            return Err(WabiError::Corrupt {
                location: INDEX.into(),
                detail: "friendship stream mismatch".into(),
            });
        }
        let pair = key(row.low_user_id, row.high_user_id);
        if row.state == FriendState::Removed {
            state.remove(INDEX, &pair);
        } else {
            state.insert(
                INDEX,
                pair.to_vec(),
                event.payload.clone(),
                event.commit_seq,
            );
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pair_replays_request_accept_and_removal() {
        let state = ProjectionState::new();
        let mut row = FriendRelationship::new(8, 3, 8, FriendState::Pending, 10);
        for (seq, expected) in [
            (1, Some(FriendState::Pending)),
            (2, Some(FriendState::Friends)),
            (3, None),
        ] {
            let event = DurableEvent {
                commit_seq: seq,
                stream_id: "friends:3:8".into(),
                event_type: EVENT.into(),
                payload: serde_json::to_vec(&row).unwrap(),
            };
            FriendsProjection.apply(&event, &state).unwrap();
            assert_eq!(get(&state, 8, 3).unwrap().map(|r| r.state), expected);
            row.state = match seq {
                1 => FriendState::Friends,
                _ => FriendState::Removed,
            };
        }
    }
}
