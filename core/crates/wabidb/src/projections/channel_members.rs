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

/// New event payload, not an extension of the historical postcard record.
/// A command may encrypt only one event per stream, so group creation and
/// ownership transfer use one validated membership delta on that stream.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChannelMembersChanged {
    pub channel_id: String,
    pub upserts: Vec<ChannelMemberRecord>,
    pub removals: Vec<u64>,
}

impl ChannelMembersChanged {
    pub fn validate(&self) -> Result<()> {
        let mut ids = std::collections::HashSet::new();
        let valid = !self.channel_id.is_empty()
            && self.upserts.iter().all(|m| {
                m.channel_id == self.channel_id
                    && m.user_id > 0
                    && m.role <= 3
                    && ids.insert(m.user_id)
            })
            && self.removals.iter().all(|id| *id > 0 && ids.insert(*id));
        if !valid {
            return Err(crate::error::WabiError::Validation {
                command: "channel_members_changed".into(),
                reason: "invalid channel, member, role, duplicate or overlapping membership delta"
                    .into(),
            });
        }
        Ok(())
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        let change: Self =
            serde_json::from_slice(bytes).map_err(|e| crate::error::WabiError::Corrupt {
                location: "channel_members_changed event".into(),
                detail: e.to_string(),
            })?;
        change.validate()?;
        Ok(change)
    }
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
    pub fn get_member(
        state: &ProjectionState,
        channel_id: &str,
        user_id: u64,
    ) -> Result<Option<ChannelMemberRecord>> {
        let key = encode_key(channel_id, user_id);
        match state.get("channel_members", &key) {
            None => Ok(None),
            Some(bytes) => decode_record(&bytes).map(Some),
        }
    }

    /// List all members of a channel.
    pub fn list_members(
        state: &ProjectionState,
        channel_id: &str,
    ) -> Result<Vec<ChannelMemberRecord>> {
        let mut prefix = Vec::new();
        prefix.extend_from_slice(&(channel_id.len() as u64).to_le_bytes());
        prefix.extend_from_slice(channel_id.as_bytes());
        let mut results = Vec::new();
        state.prefix_scan("channel_members", &prefix, |_key, value| {
            results.push(decode_record(value));
        });
        results.into_iter().collect()
    }

    /// Zero is the legacy-checkpoint baseline; the first subsequent membership
    /// event establishes a durable revision. Never use process-local counters.
    pub fn revision(state: &ProjectionState, channel_id: &str) -> Result<u64> {
        state
            .get("channel_membership_versions", channel_id.as_bytes())
            .map_or(Ok(0), |bytes| {
                bytes.try_into().map(u64::from_le_bytes).map_err(|_| {
                    crate::error::WabiError::Corrupt {
                        location: "channel_membership_versions".into(),
                        detail: "invalid revision".into(),
                    }
                })
            })
    }
}

pub struct ChannelMembersProjection;

impl Projection for ChannelMembersProjection {
    fn event_type(&self) -> &str {
        "channel_member_added"
    }

    fn event_types(&self) -> Vec<&str> {
        vec![
            "channel_member_added",
            "channel_member_removed",
            "channel_members_changed",
        ]
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        if event.event_type == "channel_members_changed" {
            // Validate the entire delta before mutating any row.
            let change = ChannelMembersChanged::decode(&event.payload)?;
            if event.stream_id != format!("channel_members:{}", change.channel_id) {
                return Err(crate::error::WabiError::Validation {
                    command: event.event_type.clone(),
                    reason: "membership stream mismatch".into(),
                });
            }
            for id in change.removals {
                state.remove("channel_members", &encode_key(&change.channel_id, id));
            }
            for record in change.upserts {
                state.insert(
                    "channel_members",
                    encode_key(&change.channel_id, record.user_id),
                    encode_record(&record),
                    event.commit_seq,
                );
            }
            state.insert(
                "channel_membership_versions",
                change.channel_id.into_bytes(),
                event.commit_seq.to_le_bytes().to_vec(),
                event.commit_seq,
            );
            return Ok(());
        }
        let record: ChannelMemberRecord = decode_record(&event.payload)?;
        let key = encode_key(&record.channel_id, record.user_id);
        match event.event_type.as_str() {
            "channel_member_added" => {
                state.insert(
                    "channel_members",
                    key,
                    encode_record(&record),
                    event.commit_seq,
                );
            }
            "channel_member_removed" => {
                // A repeated leave is an idempotent no-op. Decode first so
                // malformed removals cannot be acknowledged as successful.
                state.remove("channel_members", &key);
            }
            other => {
                return Err(crate::error::WabiError::Validation {
                    command: other.into(),
                    reason: "unexpected channel membership event".into(),
                })
            }
        }
        state.insert(
            "channel_membership_versions",
            record.channel_id.into_bytes(),
            event.commit_seq.to_le_bytes().to_vec(),
            event.commit_seq,
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batch_validates_before_mutation_and_legacy_events_advance_revision() {
        let state = ProjectionState::new();
        let record = ChannelMemberRecord {
            channel_id: "group-test".into(),
            user_id: 9,
            joined_at_micros: 10,
            role: 0,
            nick: Some("kept".into()),
        };
        ChannelMembersProjection
            .apply(
                &DurableEvent {
                    commit_seq: 1,
                    stream_id: "channel_members:group-test".into(),
                    event_type: "channel_member_added".into(),
                    payload: encode_record(&record),
                },
                &state,
            )
            .unwrap();
        for (stream, upserts, removals) in [
            ("channel_members:group-test", vec![record.clone()], vec![9]),
            ("channel_members:other", vec![], vec![9]),
            ("channel_members:group-test", vec![], vec![9, 9]),
            ("channel_members:group-test", vec![], vec![9, 0]),
        ] {
            let change = ChannelMembersChanged {
                channel_id: "group-test".into(),
                upserts,
                removals,
            };
            assert!(ChannelMembersProjection
                .apply(
                    &DurableEvent {
                        commit_seq: 2,
                        stream_id: stream.into(),
                        event_type: "channel_members_changed".into(),
                        payload: serde_json::to_vec(&change).unwrap()
                    },
                    &state
                )
                .is_err());
            assert_eq!(
                ChannelMembersProjection::get_member(&state, "group-test", 9).unwrap(),
                Some(record.clone())
            );
            assert_eq!(
                ChannelMembersProjection::revision(&state, "group-test").unwrap(),
                1
            );
        }
        ChannelMembersProjection
            .apply(
                &DurableEvent {
                    commit_seq: 3,
                    stream_id: "channel_members:group-test".into(),
                    event_type: "channel_member_removed".into(),
                    payload: encode_record(&record),
                },
                &state,
            )
            .unwrap();
        assert_eq!(
            ChannelMembersProjection::revision(&state, "group-test").unwrap(),
            3
        );
        assert_eq!(
            ChannelMembersProjection::revision(&state, "legacy-snapshot-group").unwrap(),
            0
        );
    }

    #[test]
    fn corrupt_membership_list_fails_instead_of_choosing_a_different_owner() {
        let state = ProjectionState::new();
        state.insert("channel_members", encode_key("group-test", 9), vec![255], 1);
        assert!(ChannelMembersProjection::list_members(&state, "group-test").is_err());
        assert!(ChannelMembersProjection::list_members(&state, "other")
            .unwrap()
            .is_empty());
    }

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
        assert!(proj.event_types().contains(&"channel_member_removed"));
    }

    #[test]
    fn remove_is_scoped_idempotent_and_allows_rejoin() {
        let state = ProjectionState::new();
        let apply = |kind: &str, channel: &str, user_id| {
            ChannelMembersProjection
                .apply(
                    &DurableEvent {
                        commit_seq: 1,
                        stream_id: format!("channel_members:{channel}"),
                        event_type: kind.into(),
                        payload: encode_record(&ChannelMemberRecord {
                            channel_id: channel.into(),
                            user_id,
                            joined_at_micros: 1,
                            role: 0,
                            nick: None,
                        }),
                    },
                    &state,
                )
                .unwrap();
        };
        for (channel, uid) in [("ch_a", 1), ("ch_b", 1), ("ch_a", 2)] {
            apply("channel_member_added", channel, uid);
        }
        for _ in 0..2 {
            apply("channel_member_removed", "ch_a", 1);
        }
        assert!(ChannelMembersProjection::get_member(&state, "ch_a", 1)
            .unwrap()
            .is_none());
        assert!(ChannelMembersProjection::get_member(&state, "ch_b", 1)
            .unwrap()
            .is_some());
        assert!(ChannelMembersProjection::get_member(&state, "ch_a", 2)
            .unwrap()
            .is_some());
        apply("channel_member_added", "ch_a", 1);
        assert!(ChannelMembersProjection::get_member(&state, "ch_a", 1)
            .unwrap()
            .is_some());
        assert!(ChannelMembersProjection
            .apply(
                &DurableEvent {
                    commit_seq: 2,
                    stream_id: "channel_members:ch_a".into(),
                    event_type: "channel_member_removed".into(),
                    payload: vec![0xff],
                },
                &state
            )
            .is_err());
        assert!(ChannelMembersProjection::get_member(&state, "ch_a", 1)
            .unwrap()
            .is_some());
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
        let loaded = ChannelMembersProjection::get_member(&state, "ch_01", 42)
            .unwrap()
            .unwrap();
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
