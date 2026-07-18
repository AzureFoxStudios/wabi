//! Reactions projection: append-only per-message reaction list.
//!
//! Per the kanban card body (wabidb-25):
//! - A `Reaction` struct with `message_id`, `user_id`, `reaction_type` (an emoji
//!   string), `created_at_micros`, and `key_id` (the active encryption key id
//!   at the time of the reaction — used for tombstoning on rotation).
//! - A `ReactionsProjection` that implements the `Projection` trait.
//! - The `event_type` is `reaction_added`.
//! - The composite key in the projection index is `(message_id, user_id,
//!   reaction_type)` so a given user can have at most one reaction of a
//!   given type per message.
//!
//! ## Storage
//!
//! Reactions live in the `reactions` index of `ProjectionState`. The
//! primary key is `message_id || ':' || user_id || ':' || reaction_type`
//! (a string-form key — readable in dev, fast enough in `SkipMap`). The
//! value is the encoded `Reaction`.
//!
//! ## Reordering note
//!
//! `wabidb-25` is the SECOND card in the wabidb-24..wabidb-29 sequence. The
//! kanban originally had wabidb-24 first, but the design is independent
//! (each projection is a separate index in `ProjectionState`).

use crate::engine::locks::ProjectionState;
use crate::error::Result;
use crate::projections::codec::RecordCodec;
use crate::projections::handler::{DurableEvent, Projection};
use crate::projections::query::{apply_limit, ReactionsFilter, QueryableProjection};
use serde::{Deserialize, Serialize};

/// A single reaction event.
///
/// A reaction is a user attaching an emoji (or other short string) to a
/// message. Reactions are append-only from the projection's point of view;
/// un-reacting produces a separate `reaction_removed` event (handled by a
/// future card, not wabidb-25).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Reaction {
    /// The message the reaction is attached to.
    pub message_id: String,
    /// The user who reacted.
    pub user_id: u64,
    /// The reaction type (e.g. `"👍"`, `"🎉"`, `"❤️"`).
    /// A short string — emoji, single-char shorthand, or arbitrary token.
    pub reaction_type: String,
    /// Server time of the reaction, in microseconds since Unix epoch.
    pub created_at_micros: i64,
    /// The active encryption key id at the time of the reaction. Used by
    /// the retention engine to tombstone reactions whose key has been
    /// destroyed (Council Review #1 §1.4).
    pub key_id: String,
}

impl RecordCodec for Reaction {
    fn codec_name() -> &'static str {
        "reactions"
    }
}

impl From<Reaction> for crate::domain::Reaction {
    fn from(r: Reaction) -> Self {
        Self {
            message_id: r.message_id,
            user_id: r.user_id,
            emote: r.reaction_type,
            created_at_micros: r.created_at_micros,
        }
    }
}

/// The reactions projection. Implements the `Projection` trait and stores
/// reactions in the `reactions` index of `ProjectionState`.
pub struct ReactionsProjection;

impl ReactionsProjection {
    /// Look up a single reaction by its composite key.
    pub fn get_reaction(state: &ProjectionState, message_id: &str, user_id: u64, reaction_type: &str) -> Result<Option<Reaction>> {
        let key = composite_key(message_id, user_id, reaction_type);
        match state.get("reactions", &key) {
            None => Ok(None),
            Some(bytes) => decode_reaction(&bytes).map(Some),
        }
    }

    /// List all reactions on a given message.
    pub fn list_reactions(state: &ProjectionState, message_id: &str) -> Result<Vec<Reaction>> {
        let mut prefix = Vec::from(message_id.as_bytes());
        prefix.push(0);
        let mut results = Vec::new();
        state.prefix_scan("reactions", &prefix, |_key, value| {
            if let Ok(reaction) = decode_reaction(value) {
                results.push(reaction);
            }
        });
        Ok(results)
    }
}

impl Projection for ReactionsProjection {
    fn event_type(&self) -> &str {
        "reaction_added"
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        // Decode the payload (a postcard-encoded `Reaction`).
        let reaction: Reaction = decode_reaction(&event.payload)?;
        let key = composite_key(&reaction.message_id, reaction.user_id, &reaction.reaction_type);
        let value = event.payload.clone();
        state.insert("reactions", key, value, event.commit_seq);
        Ok(())
    }
}

impl QueryableProjection for ReactionsProjection {
    type Record = Reaction;
    type Filter = ReactionsFilter;

    fn query(&self, state: &ProjectionState, filter: &ReactionsFilter) -> Result<Vec<Reaction>> {
        let mut results = Vec::new();
        match &filter.message_id {
            // message_id is the leading key component, so this is a prefix scan.
            Some(message_id) => {
                let mut prefix = Vec::from(message_id.as_bytes());
                prefix.push(0);
                state.prefix_scan("reactions", &prefix, |_key, value| {
                    if let Ok(reaction) = decode_reaction(value) {
                        if let Some(uid) = filter.user_id {
                            if reaction.user_id != uid {
                                return;
                            }
                        }
                        results.push(reaction);
                    }
                });
            }
            None => {
                state.for_each("reactions", |_key, value| {
                    if let Ok(reaction) = decode_reaction(value) {
                        if let Some(uid) = filter.user_id {
                            if reaction.user_id != uid {
                                return;
                            }
                        }
                        results.push(reaction);
                    }
                });
            }
        }
        apply_limit(&mut results, filter.limit);
        Ok(results)
    }
}

/// Build the composite key for a reaction entry. Format:
/// `"{message_id}\x00{user_id_u64_le}\x00{reaction_type}"` — NUL
/// separators (which are invalid in `message_id` and `reaction_type`
/// for typical inputs) plus a u64 user_id in little-endian (compact,
/// unambiguous). String form for human-readability in dev.
pub fn composite_key(message_id: &str, user_id: u64, reaction_type: &str) -> Vec<u8> {
    let mut buf = Vec::with_capacity(message_id.len() + 8 + reaction_type.len() + 2);
    buf.extend_from_slice(message_id.as_bytes());
    buf.push(0);
    buf.extend_from_slice(&user_id.to_le_bytes());
    buf.push(0);
    buf.extend_from_slice(reaction_type.as_bytes());
    buf
}

/// Parse a composite key back into its parts. Used by readers/tests.
pub fn parse_composite_key(key: &[u8]) -> Option<(String, u64, String)> {
    // The composite key format is:
    //   message_id || NUL || user_id (8 bytes LE) || NUL || reaction_type
    //
    // The user_id is a u64 in little-endian, which for many values
    // (anything below 2^32) contains NUL bytes. So we cannot just search
    // for any NUL — we must find the FIRST NUL (after message_id) and
    // then the NUL that follows 8 bytes after the first.
    let first_nul = key.iter().position(|b| *b == 0)?;
    let mid = std::str::from_utf8(&key[..first_nul]).ok()?;
    let uid_start = first_nul + 1;
    let uid_end = uid_start + 8;
    if uid_end > key.len() {
        return None;
    }
    let uid_bytes = &key[uid_start..uid_end];
    let mut uid_arr = [0u8; 8];
    uid_arr.copy_from_slice(uid_bytes);
    let user_id = u64::from_le_bytes(uid_arr);
    let second_nul = key[uid_end..].iter().position(|b| *b == 0)?;
    let rt_start = uid_end + second_nul + 1;
    let rt = std::str::from_utf8(&key[rt_start..]).ok()?;
    Some((mid.to_string(), user_id, rt.to_string()))
}

/// Encode a `Reaction` as bytes for storage. Uses postcard for compactness.
pub fn encode_reaction(reaction: &Reaction) -> Vec<u8> {
    postcard::to_allocvec(reaction).expect("postcard serialization failed")
}

/// Decode a `Reaction` from bytes. Inverse of `encode_reaction`.
pub fn decode_reaction(bytes: &[u8]) -> Result<Reaction> {
    postcard::from_bytes(bytes).map_err(|e| crate::error::WabiError::Corrupt {
        location: "reaction payload".into(),
        detail: format!("postcard decode failed: {e}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::projections::handler::DispatchTable;
    use std::sync::Arc;

    fn sample_reaction() -> Reaction {
        Reaction {
            message_id: "msg_01H".into(),
            user_id: 42,
            reaction_type: "👍".into(),
            created_at_micros: 1_700_000_000_000_000,
            key_id: "01H_key1".into(),
        }
    }

    #[test]
    fn postcard_round_trip() {
        let r = sample_reaction();
        let bytes = encode_reaction(&r);
        let r2 = decode_reaction(&bytes).unwrap();
        assert_eq!(r, r2);
    }

    #[test]
    fn postcard_decode_tolerates_trailing_bytes() {
        let r = sample_reaction();
        let mut bytes = encode_reaction(&r);
        bytes.push(0xFF);
        let decoded = decode_reaction(&bytes).unwrap();
        assert_eq!(r, decoded);
    }

    #[test]
    fn postcard_decode_truncated_rejected() {
        let r = sample_reaction();
        let bytes = encode_reaction(&r);
        let truncated = &bytes[..bytes.len() - 5];
        let err = decode_reaction(truncated).unwrap_err();
        assert!(matches!(err, crate::error::WabiError::Corrupt { .. }), "got {err:?}");
    }

    #[test]
    fn composite_key_round_trip() {
        let r = sample_reaction();
        let key = composite_key(&r.message_id, r.user_id, &r.reaction_type);
        let (mid, uid, rt) = parse_composite_key(&key).unwrap();
        assert_eq!(mid, r.message_id);
        assert_eq!(uid, r.user_id);
        assert_eq!(rt, r.reaction_type);
    }

    #[test]
    fn composite_key_disambiguates_collision() {
        // msg1/user1/reaction1 and msg1/user11/reaction1 should have
        // different keys (the user_id u64 LE encoding prevents string
        // concatenation ambiguity).
        let k1 = composite_key("msg1", 1, "reaction1");
        let k2 = composite_key("msg1", 11, "reaction1");
        assert_ne!(k1, k2);
    }

    #[test]
    fn reactions_projection_event_type() {
        let p = ReactionsProjection;
        assert_eq!(p.event_type(), "reaction_added");
    }

    #[test]
    fn apply_stores_under_reactions_index() {
        let state = ProjectionState::new();
        let r = sample_reaction();
        let bytes = encode_reaction(&r);
        let event = DurableEvent {
            commit_seq: 1,
            stream_id: "ch_01H".into(),
            event_type: "reaction_added".into(),
            payload: bytes.clone(),
        };
        let p = ReactionsProjection;
        p.apply(&event, &state).unwrap();

        let key = composite_key(&r.message_id, r.user_id, &r.reaction_type);
        let stored = state.get("reactions", &key);
        assert_eq!(stored, Some(bytes));
    }

    #[test]
    fn dispatch_table_routes_reaction() {
        let table = DispatchTable::new(vec![Arc::new(ReactionsProjection)]).unwrap();
        let _ = table; // ensure construction succeeds (single reaction handler)

        // Now apply through the dispatch table
        let table = DispatchTable::new(vec![Arc::new(ReactionsProjection)]).unwrap();
        let state = ProjectionState::new();
        let r = sample_reaction();
        let bytes = encode_reaction(&r);
        let event = DurableEvent {
            commit_seq: 1,
            stream_id: "ch_01H".into(),
            event_type: "reaction_added".into(),
            payload: bytes.clone(),
        };
        let handler = table.get("reaction_added").unwrap();
        handler.apply(&event, &state).unwrap();

        let key = composite_key(&r.message_id, r.user_id, &r.reaction_type);
        let stored = state.get("reactions", &key);
        assert_eq!(stored, Some(bytes));
    }

    #[test]
    fn multiple_reactions_on_same_message_different_users() {
        let state = ProjectionState::new();
        let p = ReactionsProjection;
        for (i, user_id) in [1u64, 2, 3].iter().enumerate() {
            let r = Reaction {
                message_id: "msg_01H".into(),
                user_id: *user_id,
                reaction_type: "👍".into(),
                created_at_micros: 1_700_000_000_000_000 + i as i64,
                key_id: "01H_key1".into(),
            };
            let bytes = encode_reaction(&r);
            let event = DurableEvent {
                commit_seq: (i + 1) as u64,
                stream_id: "ch_01H".into(),
                event_type: "reaction_added".into(),
                payload: bytes,
            };
            p.apply(&event, &state).unwrap();
        }
        // All 3 reactions are stored under different keys.
        for user_id in [1u64, 2, 3] {
            let key = composite_key("msg_01H", user_id, "👍");
            assert!(state.get("reactions", &key).is_some());
        }
    }

    #[test]
    fn typed_get_reaction_after_insert() {
        let state = ProjectionState::new();
        let p = ReactionsProjection;
        let r = sample_reaction();
        let event = DurableEvent {
            commit_seq: 1,
            stream_id: "ch_01H".into(),
            event_type: "reaction_added".into(),
            payload: encode_reaction(&r),
        };
        p.apply(&event, &state).unwrap();
        let loaded = ReactionsProjection::get_reaction(&state, &r.message_id, r.user_id, &r.reaction_type).unwrap().unwrap();
        assert_eq!(loaded.user_id, r.user_id);
        assert_eq!(loaded.reaction_type, r.reaction_type);
    }

    #[test]
    fn typed_list_reactions_for_message() {
        let state = ProjectionState::new();
        let p = ReactionsProjection;
        for uid in [1u64, 2, 3] {
            let r = Reaction {
                message_id: "msg_01".into(),
                user_id: uid,
                reaction_type: "👍".into(),
                created_at_micros: uid as i64,
                key_id: "k1".into(),
            };
            let event = DurableEvent {
                commit_seq: uid,
                stream_id: "ch_01".into(),
                event_type: "reaction_added".into(),
                payload: encode_reaction(&r),
            };
            p.apply(&event, &state).unwrap();
        }
        let reactions = ReactionsProjection::list_reactions(&state, "msg_01").unwrap();
        assert_eq!(reactions.len(), 3);
    }

    #[test]
    fn same_user_same_reaction_is_idempotent() {
        // Per the design (composite key includes user_id + reaction_type),
        // a user adding the same reaction to the same message twice
        // produces the same key — second apply overwrites the first.
        // This is intentional: a reaction is a "thumbs up" flag, not a
        // counter. For counts, use a separate aggregation projection
        // (wabidb-29 or similar).
        let state = ProjectionState::new();
        let p = ReactionsProjection;
        let r = sample_reaction();
        let bytes1 = encode_reaction(&r);
        let event1 = DurableEvent {
            commit_seq: 1,
            stream_id: "ch_01H".into(),
            event_type: "reaction_added".into(),
            payload: bytes1,
        };
        p.apply(&event1, &state).unwrap();
        // Second apply with different commit_seq but same key.
        let bytes2 = encode_reaction(&r);
        let event2 = DurableEvent {
            commit_seq: 2,
            stream_id: "ch_01H".into(),
            event_type: "reaction_added".into(),
            payload: bytes2,
        };
        p.apply(&event2, &state).unwrap();
        // Only one entry exists for the key.
        let key = composite_key("msg_01H", 42, "👍");
        assert!(state.get("reactions", &key).is_some());
        // The for_each loop confirms exactly one.
        let mut count = 0;
        state.for_each("reactions", |_, _| count += 1);
        assert_eq!(count, 1);
    }

    #[test]
    fn query_by_message_id_prefix() {
        let state = ProjectionState::new();
        let p = ReactionsProjection;
        for uid in [1u64, 2, 3] {
            let r = Reaction {
                message_id: "msg_01".into(),
                user_id: uid,
                reaction_type: "👍".into(),
                created_at_micros: uid as i64,
                key_id: "k1".into(),
            };
            p.apply(&DurableEvent { commit_seq: uid, stream_id: "ch_01".into(), event_type: "reaction_added".into(), payload: encode_reaction(&r) }, &state).unwrap();
        }
        // A reaction on a different message must not show up.
        let other = Reaction { message_id: "msg_99".into(), user_id: 7, reaction_type: "👍".into(), created_at_micros: 1, key_id: "k1".into() };
        p.apply(&DurableEvent { commit_seq: 7, stream_id: "ch_01".into(), event_type: "reaction_added".into(), payload: encode_reaction(&other) }, &state).unwrap();

        let results = p.query(&state, &ReactionsFilter { message_id: Some("msg_01".into()), ..Default::default() }).unwrap();
        assert_eq!(results.len(), 3);
        assert!(results.iter().all(|r| r.message_id == "msg_01"));
    }

    #[test]
    fn query_by_user_id_filters() {
        let state = ProjectionState::new();
        let p = ReactionsProjection;
        let mut seq = 1u64;
        for msg in ["m1", "m2"] {
            let r = Reaction { message_id: msg.into(), user_id: 5, reaction_type: "👍".into(), created_at_micros: seq as i64, key_id: "k1".into() };
            p.apply(&DurableEvent { commit_seq: seq, stream_id: "ch".into(), event_type: "reaction_added".into(), payload: encode_reaction(&r) }, &state).unwrap();
            seq += 1;
        }
        let other = Reaction { message_id: "m3".into(), user_id: 9, reaction_type: "👍".into(), created_at_micros: seq as i64, key_id: "k1".into() };
        p.apply(&DurableEvent { commit_seq: seq, stream_id: "ch".into(), event_type: "reaction_added".into(), payload: encode_reaction(&other) }, &state).unwrap();

        let results = p.query(&state, &ReactionsFilter { user_id: Some(5), ..Default::default() }).unwrap();
        assert_eq!(results.len(), 2);
        assert!(results.iter().all(|r| r.user_id == 5));
    }

    #[test]
    fn query_limit_truncates() {
        let state = ProjectionState::new();
        let p = ReactionsProjection;
        for uid in [1u64, 2, 3, 4] {
            let r = Reaction { message_id: "msg_01".into(), user_id: uid, reaction_type: "👍".into(), created_at_micros: uid as i64, key_id: "k1".into() };
            p.apply(&DurableEvent { commit_seq: uid, stream_id: "ch".into(), event_type: "reaction_added".into(), payload: encode_reaction(&r) }, &state).unwrap();
        }
        let results = p.query(&state, &ReactionsFilter { message_id: Some("msg_01".into()), user_id: None, limit: Some(2) }).unwrap();
        assert_eq!(results.len(), 2);
    }
}
