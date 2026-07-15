use crate::engine::locks::ProjectionState;
use crate::error::Result;
use crate::projections::codec::RecordCodec;
use crate::projections::handler::{DurableEvent, Projection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChannelMemberRecord {
    pub channel_id: String,
    pub user_id: u64,
    pub joined_at_micros: i64,
    pub role: u8,
    pub nick: Option<String>,
}

impl RecordCodec for ChannelMemberRecord {
    fn codec_name() -> &'static str {
        "channel_members"
    }
}

impl From<ChannelMemberRecord> for crate::domain::ChannelMember {
    fn from(r: ChannelMemberRecord) -> Self {
        use crate::domain::MemberRole;
        Self {
            channel_id: r.channel_id,
            user_id: r.user_id,
            role: match r.role {
                3 => MemberRole::Owner,
                2 => MemberRole::Admin,
                1 => MemberRole::Moderator,
                _ => MemberRole::Member,
            },
            joined_at_micros: r.joined_at_micros,
        }
    }
}

pub fn encode_record(r: &ChannelMemberRecord) -> Vec<u8> {
    postcard::to_allocvec(r).expect("postcard serialization failed")
}

pub fn decode_record(buf: &[u8]) -> Result<ChannelMemberRecord> {
    postcard::from_bytes(buf).map_err(|e| crate::error::WabiError::Corrupt {
        location: "channel_members projection".into(),
        detail: format!("postcard decode failed: {e}"),
    })
}

pub fn encode_key(channel_id: &str, user_id: u64) -> Vec<u8> {
    let mut buf = Vec::new();
    buf.extend_from_slice(&(channel_id.len() as u64).to_le_bytes());
    buf.extend_from_slice(channel_id.as_bytes());
    buf.extend_from_slice(&user_id.to_le_bytes());
    buf
}

impl ChannelMembersProjection {
    /// Look up a single channel member.
    pub fn get_member(state: &ProjectionState, channel_id: &str, user_id: u64) -> Result<Option<ChannelMemberRecord>> {
        let key = encode_key(channel_id, user_id);
        match state.get("channel_members", &key) {
            None => Ok(None),
            Some(bytes) => decode_record(&bytes).map(Some),
        }
    }

    /// List all members of a channel.
    pub fn list_members(state: &ProjectionState, channel_id: &str) -> Result<Vec<ChannelMemberRecord>> {
        let mut prefix = Vec::new();
        prefix.extend_from_slice(&(channel_id.len() as u64).to_le_bytes());
        prefix.extend_from_slice(channel_id.as_bytes());
        let mut results = Vec::new();
        state.prefix_scan("channel_members", &prefix, |_key, value| {
            if let Ok(record) = decode_record(value) {
                results.push(record);
            }
        });
        Ok(results)
    }
}

pub struct ChannelMembersProjection;

impl Projection for ChannelMembersProjection {
    fn event_type(&self) -> &str {
        "channel_member_added"
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let record: ChannelMemberRecord = decode_record(&event.payload)?;
        let key = encode_key(&record.channel_id, record.user_id);
        let value = encode_record(&record);
        state.insert("channel_members", key, value, event.commit_seq);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_decode_roundtrip() {
        let r = ChannelMemberRecord {
            channel_id: "ch_01".into(),
            user_id: 42,
            joined_at_micros: 1_000_000,
            role: 2,
            nick: Some("alice".into()),
        };
        let buf = encode_record(&r);
        let decoded = decode_record(&buf).unwrap();
        assert_eq!(r, decoded);
    }

    #[test]
    fn encode_decode_no_nick() {
        let r = ChannelMemberRecord {
            channel_id: "ch_02".into(),
            user_id: 7,
            joined_at_micros: 2_000_000,
            role: 0,
            nick: None,
        };
        let buf = encode_record(&r);
        let decoded = decode_record(&buf).unwrap();
        assert_eq!(r, decoded);
    }

    #[test]
    fn insert_and_lookup() {
        let state = ProjectionState::new();
        let proj = ChannelMembersProjection;

        let r = ChannelMemberRecord {
            channel_id: "ch_01".into(),
            user_id: 42,
            joined_at_micros: 1_000_000,
            role: 2,
            nick: Some("alice".into()),
        };

        let event = DurableEvent {
            commit_seq: 1,
            stream_id: "ch_01".into(),
            event_type: "channel_member_added".into(),
            payload: encode_record(&r),
        };

        proj.apply(&event, &state).unwrap();

        let key = encode_key("ch_01", 42);
        let stored = state.get("channel_members", &key).unwrap();
        let decoded = decode_record(&stored).unwrap();
        assert_eq!(decoded.user_id, 42);
        assert_eq!(decoded.role, 2);
        assert_eq!(decoded.nick, Some("alice".into()));
    }

    #[test]
    fn lookup_role() {
        let state = ProjectionState::new();
        let proj = ChannelMembersProjection;

        let r = ChannelMemberRecord {
            channel_id: "ch_01".into(),
            user_id: 99,
            joined_at_micros: 3_000_000,
            role: 1,
            nick: None,
        };

        let event = DurableEvent {
            commit_seq: 2,
            stream_id: "ch_01".into(),
            event_type: "channel_member_added".into(),
            payload: encode_record(&r),
        };

        proj.apply(&event, &state).unwrap();

        let key = encode_key("ch_01", 99);
        let stored = state.get("channel_members", &key).unwrap();
        let decoded = decode_record(&stored).unwrap();
        assert_eq!(decoded.role, 1); // mod
    }

    #[test]
    fn event_type_returns_correct() {
        let proj = ChannelMembersProjection;
        assert_eq!(proj.event_type(), "channel_member_added");
    }

    #[test]
    fn typed_get_member_after_insert() {
        let state = ProjectionState::new();
        let proj = ChannelMembersProjection;
        let r = ChannelMemberRecord {
            channel_id: "ch_01".into(),
            user_id: 42,
            joined_at_micros: 1_000_000,
            role: 2,
            nick: Some("alice".into()),
        };
        let event = DurableEvent {
            commit_seq: 1,
            stream_id: "ch_01".into(),
            event_type: "channel_member_added".into(),
            payload: encode_record(&r),
        };
        proj.apply(&event, &state).unwrap();
        let loaded = ChannelMembersProjection::get_member(&state, "ch_01", 42).unwrap().unwrap();
        assert_eq!(loaded.user_id, 42);
        assert_eq!(loaded.role, 2);
    }

    #[test]
    fn typed_list_members_returns_all() {
        let state = ProjectionState::new();
        let proj = ChannelMembersProjection;
        for user_id in [1u64, 2, 3] {
            let r = ChannelMemberRecord {
                channel_id: "ch_01".into(),
                user_id,
                joined_at_micros: user_id as i64 * 1_000_000,
                role: 0,
                nick: None,
            };
            proj.apply(
                &DurableEvent {
                    commit_seq: user_id,
                    stream_id: "ch_01".into(),
                    event_type: "channel_member_added".into(),
                    payload: encode_record(&r),
                },
                &state,
            )
            .unwrap();
        }
        let members = ChannelMembersProjection::list_members(&state, "ch_01").unwrap();
        assert_eq!(members.len(), 3);
    }
}
