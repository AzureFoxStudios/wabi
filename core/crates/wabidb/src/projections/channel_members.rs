//! Channel members projection: who belongs to which channel, and each
//! channel's membership revision.
//!
//! Handles `channel_member_added`, `channel_member_removed` and
//! `channel_members_changed`. The rows live in the SQLite read model's
//! `channel_members` and `channel_membership_versions` tables (ADR-0001), not
//! in `projections/snapshot.json`. The user deletion projection, which stays
//! in memory, removes a deleted user's rows here
//! ([`remove_user_while_applying`]).

use crate::engine::locks::ProjectionState;
use crate::format::versioned::{self, RecordFormat};
use crate::error::Result;
use crate::projections::codec::RecordCodec;
use crate::projections::handler::{DurableEvent, Projection};
use crate::projections::read_model::{self, Table};
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

    fn encode(&self) -> Vec<u8> {
        encode_record(self)
    }

    fn decode(buf: &[u8]) -> Result<Self> {
        decode_record(buf)
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

/// Versioned durable layout of [`ChannelMemberRecord`]; see `format::versioned`.
const FORMAT: RecordFormat = RecordFormat::new(*b"CMEM", "channel_members projection");

pub fn encode_record(r: &ChannelMemberRecord) -> Vec<u8> {
    versioned::encode_v1(&FORMAT, r)
}

pub fn decode_record(buf: &[u8]) -> Result<ChannelMemberRecord> {
    versioned::decode_v1(&FORMAT, buf)
}

pub fn encode_key(channel_id: &str, user_id: u64) -> Vec<u8> {
    let mut buf = Vec::new();
    buf.extend_from_slice(&(channel_id.len() as u64).to_le_bytes());
    buf.extend_from_slice(channel_id.as_bytes());
    buf.extend_from_slice(&user_id.to_le_bytes());
    buf
}

/// Key prefix shared by every member row of one channel.
fn channel_prefix(channel_id: &str) -> Vec<u8> {
    let mut prefix = Vec::new();
    prefix.extend_from_slice(&(channel_id.len() as u64).to_le_bytes());
    prefix.extend_from_slice(channel_id.as_bytes());
    prefix
}

impl ChannelMembersProjection {
    /// Look up a single channel member, as of the last committed commit.
    pub fn get_member(
        state: &ProjectionState,
        channel_id: &str,
        user_id: u64,
    ) -> Result<Option<ChannelMemberRecord>> {
        let key = encode_key(channel_id, user_id);
        state
            .read_model()
            .read(|conn| read_model::get(conn, Table::ChannelMembers, &key))?
            .map(|bytes| decode_record(&bytes))
            .transpose()
    }

    /// List all members of a channel (in key order), as of the last committed
    /// commit.
    pub fn list_members(
        state: &ProjectionState,
        channel_id: &str,
    ) -> Result<Vec<ChannelMemberRecord>> {
        let prefix = channel_prefix(channel_id);
        let upper = crate::projections::messages::prefix_successor(&prefix);
        let mut results = Vec::new();
        state.read_model().read(|conn| {
            read_model::scan(conn, Table::ChannelMembers, &prefix, Some(&upper), false, |_key, value| {
                results.push(decode_record(value)?);
                Ok(true)
            })
        })?;
        Ok(results)
    }

    /// The ids of the channels `user_id` is a member of, in key order, as of
    /// the last committed commit. Rows that do not decode are left out. One
    /// indexed lookup (the `user_id` column), not a scan of every membership.
    pub fn channel_ids_of_user(state: &ProjectionState, user_id: u64) -> Result<Vec<String>> {
        let mut channels = Vec::new();
        state.read_model().read(|conn| {
            read_model::scan_members_of_user(conn, user_id, |_key, value| {
                if let Ok(record) = decode_record(value) {
                    if record.user_id == user_id {
                        channels.push(record.channel_id);
                    }
                }
                Ok(true)
            })
        })?;
        Ok(channels)
    }

    /// Zero is the legacy-checkpoint baseline; the first subsequent membership
    /// event establishes a durable revision. Never use process-local counters.
    pub fn revision(state: &ProjectionState, channel_id: &str) -> Result<u64> {
        state
            .read_model()
            .read(|conn| {
                read_model::get(conn, Table::ChannelMembershipVersions, channel_id.as_bytes())
            })?
            .map_or(Ok(0), |bytes| {
                <[u8; 8]>::try_from(bytes.as_slice()).map(u64::from_le_bytes).map_err(|_| {
                    crate::error::WabiError::Corrupt {
                        location: "channel_membership_versions".into(),
                        detail: "invalid revision".into(),
                    }
                })
            })
    }
}

/// The `user_deleted` cascade: remove every membership of `user_id`, and set
/// the revision of each channel a row was removed from to `commit_seq`, as a
/// membership event does (consumers compare it to notice that membership
/// changed). For the user deletion handler while it applies a commit; it sees
/// the rows that commit has written so far, and during startup replay
/// everything replay has written. Rows that do not decode are left alone.
pub(crate) fn remove_user_while_applying(
    state: &ProjectionState,
    user_id: u64,
    commit_seq: u64,
) -> Result<()> {
    let revision = commit_seq.to_le_bytes();
    state.read_model().write(|conn| {
        let mut rows = Vec::new();
        read_model::scan_members_of_user(conn, user_id, |key, value| {
            if let Ok(record) = decode_record(value) {
                if record.user_id == user_id {
                    rows.push((key.to_vec(), record.channel_id));
                }
            }
            Ok(true)
        })?;
        for (key, channel_id) in rows {
            read_model::delete_channel_member(conn, &key)?;
            read_model::put_membership_version(conn, channel_id.as_bytes(), &revision)?;
        }
        Ok(())
    })
}

/// Test support: store a member row as it is, bypassing the log (legacy and
/// corrupt rows no current event produces). `key` must end with the user id,
/// as [`encode_key`] writes it. The row is committed at once. The engine must
/// not be applying a commit; nothing here checks that.
#[doc(hidden)]
pub fn insert_raw_for_tests(state: &ProjectionState, key: &[u8], record: &[u8]) {
    let user_id = u64::from_le_bytes(key[key.len() - 8..].try_into().unwrap());
    let model = state.read_model();
    model.write(|conn| read_model::put_channel_member(conn, key, user_id, record)).unwrap();
    model.finish_commit(state.applied_commit_seq()).unwrap();
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

    fn stores_in_read_model(&self) -> bool {
        true
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        // Startup replay begins at the snapshot of the in-memory projections.
        // The read model may already hold later commits; its own
        // `applied_commit_seq` says which.
        if event.commit_seq <= state.read_model().replay_floor() {
            return Ok(());
        }
        let revision = event.commit_seq.to_le_bytes();
        if event.event_type == "channel_members_changed" {
            // Validate the entire delta before mutating any row.
            let change = ChannelMembersChanged::decode(&event.payload)?;
            if event.stream_id != format!("channel_members:{}", change.channel_id) {
                return Err(crate::error::WabiError::Validation {
                    command: event.event_type.clone(),
                    reason: "membership stream mismatch".into(),
                });
            }
            return state.read_model().write(|conn| {
                for id in &change.removals {
                    read_model::delete_channel_member(conn, &encode_key(&change.channel_id, *id))?;
                }
                for record in &change.upserts {
                    read_model::put_channel_member(
                        conn,
                        &encode_key(&change.channel_id, record.user_id),
                        record.user_id,
                        &encode_record(record),
                    )?;
                }
                read_model::put_membership_version(conn, change.channel_id.as_bytes(), &revision)
            });
        }
        let record: ChannelMemberRecord = decode_record(&event.payload)?;
        let key = encode_key(&record.channel_id, record.user_id);
        let added = match event.event_type.as_str() {
            "channel_member_added" => true,
            // A repeated leave is an idempotent no-op. Decode first so
            // malformed removals cannot be acknowledged as successful.
            "channel_member_removed" => false,
            other => {
                return Err(crate::error::WabiError::Validation {
                    command: other.into(),
                    reason: "unexpected channel membership event".into(),
                })
            }
        };
        state.read_model().write(|conn| {
            if added {
                read_model::put_channel_member(conn, &key, record.user_id, &encode_record(&record))?;
            } else {
                read_model::delete_channel_member(conn, &key)?;
            }
            read_model::put_membership_version(conn, record.channel_id.as_bytes(), &revision)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Tripwire for `READ_MODEL_GENERATION`, as for the messages and the
    /// channels. The hash covers every row this projection stores, in both
    /// tables, for a fixed set of events that reaches every branch of the
    /// handler, the `user_deleted` cascade included. If it changes, replay
    /// now writes something else, and a read model written by the previous
    /// build would disagree with the log.
    ///
    /// When this fails: bump `READ_MODEL_GENERATION`, then update both values
    /// here together. Never update the hash alone.
    #[test]
    fn stored_rows_are_pinned_to_the_read_model_generation() {
        use crate::projections::user_deletion::{encode_payload, UserDeletionProjection};
        let state = ProjectionState::new();
        let member = |channel: &str, user_id, role, nick: Option<&str>| ChannelMemberRecord {
            channel_id: channel.into(),
            user_id,
            joined_at_micros: 10 + user_id as i64,
            role,
            nick: nick.map(Into::into),
        };
        let apply = |commit_seq, event_type: &str, channel: &str, payload: Vec<u8>| {
            ChannelMembersProjection
                .apply(
                    &DurableEvent {
                        commit_seq,
                        stream_id: format!("channel_members:{channel}"),
                        event_type: event_type.into(),
                        payload,
                    },
                    &state,
                )
                .unwrap()
        };
        let change = |upserts, removals| {
            serde_json::to_vec(&ChannelMembersChanged { channel_id: "group-g".into(), upserts, removals }).unwrap()
        };
        apply(1, "channel_member_added", "ch_a", encode_record(&member("ch_a", 1, 3, Some("owner"))));
        apply(2, "channel_member_added", "ch_a", encode_record(&member("ch_a", 2, 0, None)));
        apply(3, "channel_member_removed", "ch_a", encode_record(&member("ch_a", 9, 0, None)));
        apply(4, "channel_member_added", "ch_a", encode_record(&member("ch_a", 2, 2, None)));
        apply(5, "channel_members_changed", "group-g",
            change(vec![member("group-g", 1, 3, None), member("group-g", 2, 0, None), member("group-g", 3, 0, None)], vec![]));
        apply(6, "channel_members_changed", "group-g", change(vec![member("group-g", 3, 1, None)], vec![2]));
        apply(7, "channel_member_added", "ch_b", encode_record(&member("ch_b", 3, 0, None)));
        UserDeletionProjection
            .apply(
                &DurableEvent {
                    commit_seq: 8,
                    stream_id: "users".into(),
                    event_type: "user_deleted".into(),
                    payload: encode_payload(&crate::domain::UserDeleted { user_id: 3 }),
                },
                &state,
            )
            .unwrap();

        let mut hash = blake3::Hasher::new();
        let mut rows = 0;
        for table in [Table::ChannelMembers, Table::ChannelMembershipVersions] {
            hash.update(table.name().as_bytes());
            state
                .read_model()
                .for_each_row(table, |key, record| {
                    rows += 1;
                    for bytes in [key, record] {
                        hash.update(&(bytes.len() as u64).to_le_bytes());
                        hash.update(bytes);
                    }
                    Ok(())
                })
                .unwrap();
        }
        // Generation 4: the user_deleted cascade at commit 8 sets the
        // revision of group-g and ch_b, the channels it removed user 3 from,
        // to 8 (generation 3 left them at 6 and 7).
        assert_eq!(rows, 6, "ch_a 1 and 2, group-g 1; revisions of ch_a (4), group-g (8) and ch_b (8)");
        let stored = hash.finalize().to_hex().to_string();
        println!("generation {} rows {stored}", read_model::READ_MODEL_GENERATION);
        assert_eq!(
            (read_model::READ_MODEL_GENERATION, stored.as_str()),
            (5, "5ed6f22241e188c9111e0c98d0a4afd0db8139948b80b97e58a5663e6f8f7205"),
            "replay stores different rows: bump READ_MODEL_GENERATION and update this pin with it"
        );
    }

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
        insert_raw_for_tests(&state, &encode_key("group-test", 9), &[255]);
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

        let decoded = ChannelMembersProjection::get_member(&state, "ch_01", 42)
            .unwrap()
            .unwrap();
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

        let decoded = ChannelMembersProjection::get_member(&state, "ch_01", 99)
            .unwrap()
            .unwrap();
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
