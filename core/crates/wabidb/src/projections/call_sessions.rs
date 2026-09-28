//! Projection for `CallSession` events.
//!
//! Stores one row per `session_id`. Updated on `call_session_created` and
//! `call_session_ended` events.

use crate::domain::CallSession;
use crate::engine::locks::ProjectionState;
use crate::error::{Result, WabiError};
use crate::projections::handler::{DurableEvent, Projection};
use crate::sequencer::types::{EventToWrite, RoomOwnerPrecondition};

pub const INDEX_NAME: &str = "call_sessions";
pub const DIRECT_PLACEMENT_PREFIX: &str = "call-dm-";

/// The existing direct-call key uses lexicographically ordered account names,
/// not numeric account order. Keep this shared with HTTP/Socket.IO admission.
pub fn direct_pair(id: &str) -> Result<Option<[u64; 2]>> {
    let Some(pair) = id.strip_prefix("dm:") else {
        return Ok(None);
    };
    let mut parts = pair.split(':');
    let parse = |s: &str| {
        s.strip_prefix("user-")
            .and_then(|s| s.parse::<i64>().ok())
            .filter(|u| *u > 0)
    };
    if let (Some(first), Some(second), None) = (parts.next(), parts.next(), parts.next()) {
        if let (Some(a), Some(b)) = (parse(first), parse(second)) {
            if a != b && first < second && id == format!("dm:user-{a}:user-{b}") {
                return Ok(Some([a as u64, b as u64]));
            }
        }
    }
    Err(WabiError::Validation {
        command: "call_scope".into(),
        reason: "invalid direct-call session key".into(),
    })
}

/// Direct calls do not require a DM chat Channel. Their placement occupies a
/// reserved namespace while the public session ID and stored scope stay intact.
pub fn placement_room_id<'a>(
    session_id: &str,
    channel_id: &'a str,
) -> Result<std::borrow::Cow<'a, str>> {
    if let Some([a, b]) = direct_pair(session_id)? {
        if session_id == channel_id {
            return Ok(format!("{DIRECT_PLACEMENT_PREFIX}user-{a}-user-{b}").into());
        }
    } else if !channel_id.starts_with(DIRECT_PLACEMENT_PREFIX) && direct_pair(channel_id)?.is_none()
    {
        return Ok(channel_id.into());
    }
    Err(WabiError::Validation {
        command: "call_scope".into(),
        reason: "call session and parent scope do not match".into(),
    })
}

pub fn encode_key(session_id: &str) -> Vec<u8> {
    session_id.as_bytes().to_vec()
}

pub fn encode_value(session: &CallSession) -> Result<Vec<u8>> {
    serde_json::to_vec(session).map_err(|e| WabiError::Validation {
        command: "call_sessions_projection_encode".into(),
        reason: format!("encode failed: {e}"),
    })
}

pub fn decode_value(bytes: &[u8]) -> Result<CallSession> {
    serde_json::from_slice(bytes).map_err(|e| WabiError::Validation {
        command: "call_sessions_projection_decode".into(),
        reason: format!("decode failed: {e}"),
    })
}

/// Bind new local call writes to the parent room whose ownership was checked.
/// Historical replay remains unchanged. Call creation commands are isolated
/// sequencer windows so later commands see their applied parent binding.
pub(crate) fn preflight_room_writes(
    events: &[EventToWrite],
    condition: Option<&RoomOwnerPrecondition>,
    state: &ProjectionState,
) -> Result<()> {
    let invalid = |reason: &str| WabiError::Validation {
        command: "room_owner_precondition".into(),
        reason: reason.into(),
    };
    let mut created = std::collections::HashSet::new();
    for (position, event) in events.iter().enumerate() {
        let kind = event.event_type.as_str();
        if !matches!(
            kind,
            "call_session_created"
                | "call_session_ended"
                | "call_participant_joined"
                | "call_participant_left"
                | "call_signal_emitted"
        ) {
            continue;
        }
        let condition =
            condition.ok_or_else(|| invalid("call write lacks a room owner condition"))?;
        if event.stream_kind != 6 || event.record_kind != crate::format::record::RecordKind::Event {
            return Err(invalid("invalid call write record kind"));
        }
        let value: serde_json::Value = serde_json::from_slice(&event.plaintext)
            .map_err(|_| invalid("invalid call write payload"))?;
        let session_id = value
            .get("session_id")
            .and_then(|v| v.as_str())
            .filter(|id| !id.is_empty() && id.len() <= 256 && !id.chars().any(char::is_control))
            .ok_or_else(|| invalid("invalid call session ID"))?
            .to_owned();
        let expected_stream = match kind {
            "call_session_created" | "call_session_ended" => format!("call_session:{session_id}"),
            "call_participant_joined" | "call_participant_left" => {
                let user = value
                    .get("user_id")
                    .and_then(|v| v.as_u64())
                    .ok_or_else(|| invalid("invalid call participant ID"))?;
                let key = format!("{session_id}:{user}");
                if let Some(actual) = value.get("participant_key") {
                    if actual.as_str() != Some(key.as_str()) {
                        return Err(invalid("call participant key does not match its session"));
                    }
                }
                if kind == "call_participant_left" {
                    if let Some(bytes) = state.get(
                        crate::projections::call_participants::INDEX_NAME,
                        key.as_bytes(),
                    ) {
                        let participant =
                            crate::projections::call_participants::decode_value(&bytes)?;
                        if participant.session_id != session_id
                            || participant.user_id != user
                            || participant.participant_key != key
                        {
                            return Err(WabiError::Corrupt {
                                location: crate::projections::call_participants::INDEX_NAME.into(),
                                detail: "call participant key does not match its record".into(),
                            });
                        }
                    }
                }
                format!("call_participant:{key}")
            }
            _ => format!("call_signal:{session_id}"),
        };
        if event.stream_id != expected_stream {
            return Err(invalid("call write stream does not match its session"));
        }
        let existing = state
            .get(INDEX_NAME, &encode_key(&session_id))
            .map(|bytes| decode_value(&bytes))
            .transpose()?;
        if existing
            .as_ref()
            .is_some_and(|row| row.session_id != session_id)
        {
            return Err(WabiError::Corrupt {
                location: INDEX_NAME.into(),
                detail: "call session key does not match its record".into(),
            });
        }
        let parent = if kind == "call_session_created" {
            if !created.insert(session_id.clone()) {
                return Err(invalid("duplicate call creation in one command"));
            }
            let session: CallSession = serde_json::from_value(value)
                .map_err(|_| invalid("invalid call creation payload"))?;
            if existing
                .as_ref()
                .is_some_and(|row| row.channel_id != session.channel_id)
            {
                return Err(invalid("a call session cannot be rebound to another room"));
            }
            session.channel_id
        } else {
            match kind {
                "call_participant_joined" => {
                    serde_json::from_value::<crate::domain::CallParticipant>(value)
                        .map_err(|_| invalid("invalid call participant payload"))?;
                }
                "call_signal_emitted" => {
                    serde_json::from_value::<crate::domain::CallSignal>(value)
                        .map_err(|_| invalid("invalid call signal payload"))?;
                }
                "call_session_ended"
                    if value.get("active").and_then(|v| v.as_bool()) == Some(false)
                        && value
                            .get("ended_at_micros")
                            .and_then(|v| v.as_i64())
                            .is_some() => {}
                "call_participant_left"
                    if value
                        .get("left_at_micros")
                        .and_then(|v| v.as_i64())
                        .is_some() => {}
                _ => return Err(invalid("invalid call teardown payload")),
            }
            existing
                .ok_or_else(|| invalid("call write has no stored parent session"))?
                .channel_id
        };
        let room_id = placement_room_id(&session_id, &parent)?;
        if room_id != condition.channel_id {
            return Err(invalid(
                "call write owner condition does not match its parent room",
            ));
        }
        if direct_pair(&session_id)?.is_some() {
            if state.get("channels", room_id.as_bytes()).is_some() {
                return Err(invalid(
                    "direct-call placement collides with a Channel record",
                ));
            }
            if kind == "call_session_created" && condition.expected_epoch.is_none() {
                let initializes_owner = events.iter().skip(position + 1).any(|event| {
                    event.event_type == super::room_placement::EVENT
                        && super::room_placement::decode(&event.plaintext).is_ok_and(|record| {
                            record.channel_id == room_id
                                && record.epoch == 1
                                && record.owner_node_id == condition.owner_node_id
                                && record.replica_node_ids.is_empty()
                        })
                });
                if !initializes_owner {
                    return Err(invalid(
                        "unplaced direct-call creation must initialize its owner in the same commit",
                    ));
                }
            }
        }
    }
    Ok(())
}

pub struct CallSessionsProjection;

impl Projection for CallSessionsProjection {
    fn event_type(&self) -> &str {
        "call_session_created"
    }

    /// Handle both create and end events for the same session row.
    fn event_types(&self) -> Vec<&str> {
        vec!["call_session_created", "call_session_ended"]
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        // The event payload may be a full CallSession (create) or a
        // partial update (end). We decode leniently: try CallSession
        // first; if that fails, decode as JSON Value and look for an
        // existing record to update.
        let session: CallSession = match serde_json::from_slice(&event.payload) {
            Ok(s) => s,
            Err(_) => {
                // Partial update: load existing, patch, re-encode.
                let key = encode_key(
                    event
                        .stream_id
                        .strip_prefix("call_session:")
                        .unwrap_or(&event.stream_id),
                );
                // Teardown is idempotent, including an end that arrives after
                // a failed create. Decode first so malformed events still fail.
                let patch: serde_json::Value =
                    serde_json::from_slice(&event.payload).map_err(|e| WabiError::Validation {
                        command: "call_sessions_projection".into(),
                        reason: format!("invalid partial update: {e}"),
                    })?;
                if event.event_type == "call_session_ended"
                    && patch.get("active").and_then(|v| v.as_bool()) == Some(false)
                    && state.get(INDEX_NAME, &key).is_none()
                {
                    return Ok(());
                }
                let existing_bytes =
                    state
                        .get(INDEX_NAME, &key)
                        .ok_or_else(|| WabiError::NotFound {
                            what: format!("call_session:{}", event.stream_id),
                        })?;
                let mut existing = decode_value(&existing_bytes)?;
                if let Some(v) = patch.get("ended_at_micros").and_then(|v| v.as_i64()) {
                    existing.ended_at_micros = Some(v);
                }
                if let Some(v) = patch.get("active").and_then(|v| v.as_bool()) {
                    existing.active = v;
                }
                if let Some(v) = patch.get("last_updated_at_micros").and_then(|v| v.as_i64()) {
                    existing.last_updated_at_micros = v;
                }
                existing
            }
        };

        let key = encode_key(&session.session_id);
        let value = encode_value(&session)?;
        state.insert(INDEX_NAME, key, value, event.commit_seq);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_call_placement_preserves_canonical_scope_and_chat_identity() {
        for (scope, pair, placed) in [
            ("dm:user-1:user-2", [1, 2], "call-dm-user-1-user-2"),
            ("dm:user-10:user-2", [10, 2], "call-dm-user-10-user-2"),
            (
                "dm:user-1:user-9223372036854775807",
                [1, i64::MAX as u64],
                "call-dm-user-1-user-9223372036854775807",
            ),
        ] {
            assert_eq!(direct_pair(scope).unwrap(), Some(pair));
            assert_eq!(placement_room_id(scope, scope).unwrap(), placed);
            assert!(placement_room_id(scope, "dm-user-1-user-2").is_err());
        }
        for invalid in [
            "dm:",
            "dm:user-1",
            "dm:user-1:user-1",
            "dm:user-2:user-1",
            "dm:user-2:user-10",
            "dm:user-01:user-2",
            "dm:user-+1:user-2",
            "dm:user-0:user-2",
            "dm:user--1:user-2",
            "dm:user-1:user-2:extra",
            "dm:user-1:user-9223372036854775808",
            "dm:user-1:user-2\n",
        ] {
            assert!(direct_pair(invalid).is_err(), "{invalid:?}");
        }
        assert_eq!(direct_pair("ordinary-call").unwrap(), None);
        assert_eq!(placement_room_id("ordinary-call", "ch_1").unwrap(), "ch_1");
        assert_eq!(
            placement_room_id("ordinary-call", "dm-user-1-user-2").unwrap(),
            "dm-user-1-user-2"
        );
        assert!(placement_room_id("ordinary-call", "dm:user-1:user-2").is_err());
        assert!(placement_room_id("ordinary-call", "call-dm-user-1-user-2").is_err());
    }

    #[test]
    fn direct_call_creation_requires_matching_atomic_placement() {
        use crate::format::record::RecordKind;
        use crate::projections::room_placement::{self, RoomPlacementRecord};
        let state = ProjectionState::new();
        let scope = "dm:user-1:user-2";
        let room_id = placement_room_id(scope, scope).unwrap().into_owned();
        let session = CallSession::new(scope, scope, "audio-call", 1, 2, "wabidb");
        let condition = RoomOwnerPrecondition {
            channel_id: room_id.clone(),
            owner_node_id: "site-a".into(),
            expected_epoch: None,
        };
        let create = || EventToWrite {
            stream_id: format!("call_session:{scope}"),
            event_type: "call_session_created".into(),
            stream_kind: 6,
            record_kind: RecordKind::Event,
            plaintext: encode_value(&session).unwrap(),
        };
        assert!(preflight_room_writes(&[create()], Some(&condition), &state).is_err());
        let record = RoomPlacementRecord {
            schema_version: 1,
            channel_id: room_id.clone(),
            owner_node_id: "site-a".into(),
            epoch: 1,
            replica_node_ids: vec![],
        };
        let init = |record: &RoomPlacementRecord| EventToWrite {
            stream_id: room_placement::stream_id(&record.channel_id),
            event_type: room_placement::EVENT.into(),
            stream_kind: 6,
            record_kind: RecordKind::Event,
            plaintext: serde_json::to_vec(record).unwrap(),
        };
        let events = [create(), init(&record)];
        assert!(preflight_room_writes(&events, Some(&condition), &state).is_ok());
        assert!(room_placement::preflight_command(&events, 1, &state).is_ok());
        for bad in [
            RoomPlacementRecord {
                owner_node_id: "site-b".into(),
                ..record.clone()
            },
            RoomPlacementRecord {
                epoch: 2,
                ..record.clone()
            },
            RoomPlacementRecord {
                channel_id: "ch_other".into(),
                ..record.clone()
            },
            RoomPlacementRecord {
                replica_node_ids: vec!["site-b".into()],
                ..record.clone()
            },
        ] {
            assert!(
                preflight_room_writes(&[create(), init(&bad)], Some(&condition), &state).is_err()
            );
        }
        assert!(
            preflight_room_writes(&[init(&record), create()], Some(&condition), &state).is_err()
        );
        assert!(preflight_room_writes(
            &[create(), create(), init(&record)],
            Some(&condition),
            &state
        )
        .is_err());
        let literal = RoomOwnerPrecondition {
            channel_id: scope.into(),
            ..condition.clone()
        };
        assert!(preflight_room_writes(&events, Some(&literal), &state).is_err());
        // Legacy unplaced rows may still join/end until stopped migration, but
        // new creation/recreation must initialize the canonical placement.
        state.insert(
            INDEX_NAME,
            encode_key(scope),
            encode_value(&session).unwrap(),
            1,
        );
        let end = EventToWrite {
            stream_id: format!("call_session:{scope}"),
            event_type: "call_session_ended".into(),
            stream_kind: 6,
            record_kind: RecordKind::Event,
            plaintext: serde_json::to_vec(&serde_json::json!({
                "session_id":scope,"active":false,"ended_at_micros":2
            }))
            .unwrap(),
        };
        assert!(preflight_room_writes(&[end], Some(&condition), &state).is_ok());
        state.insert("channels", room_id.as_bytes().to_vec(), vec![], 1);
        assert!(preflight_room_writes(&events, Some(&condition), &state).is_err());
    }

    #[test]
    fn call_admission_binds_each_event_to_its_stored_parent_and_stream() {
        use crate::domain::{CallParticipant, CallSignal};
        use crate::format::record::RecordKind;

        let state = ProjectionState::new();
        let session = CallSession::new("s_1", "ch_1", "audio-call", 1, 10, "webrtc");
        state.insert(
            INDEX_NAME,
            encode_key("s_1"),
            encode_value(&session).unwrap(),
            1,
        );
        let participant = CallParticipant::new("s_1", 1, "stable-1", true);
        state.insert(
            crate::projections::call_participants::INDEX_NAME,
            b"s_1:1".to_vec(),
            crate::projections::call_participants::encode_value(&participant).unwrap(),
            1,
        );
        let signal = CallSignal {
            signal_id: 1,
            session_id: "s_1".into(),
            from_user_id: 1,
            signal_type: "offer".into(),
            target_user_id: None,
            payload: "{}".into(),
            created_at_micros: 1,
        };
        let condition = RoomOwnerPrecondition {
            channel_id: "ch_1".into(),
            owner_node_id: "site-a".into(),
            expected_epoch: None,
        };
        let wrong = RoomOwnerPrecondition {
            channel_id: "ch_other".into(),
            ..condition.clone()
        };
        for (kind, stream, payload) in [
            (
                "call_session_created",
                "call_session:s_1",
                serde_json::to_vec(&session).unwrap(),
            ),
            (
                "call_session_ended",
                "call_session:s_1",
                serde_json::to_vec(&serde_json::json!({
                    "session_id": "s_1", "active": false, "ended_at_micros": 2
                }))
                .unwrap(),
            ),
            (
                "call_participant_joined",
                "call_participant:s_1:1",
                serde_json::to_vec(&participant).unwrap(),
            ),
            (
                "call_participant_left",
                "call_participant:s_1:1",
                serde_json::to_vec(&serde_json::json!({
                    "session_id": "s_1", "user_id": 1, "left_at_micros": 2
                }))
                .unwrap(),
            ),
            (
                "call_signal_emitted",
                "call_signal:s_1",
                serde_json::to_vec(&signal).unwrap(),
            ),
        ] {
            let mut event = EventToWrite {
                stream_id: stream.into(),
                event_type: kind.into(),
                stream_kind: 6,
                record_kind: RecordKind::Event,
                plaintext: payload,
            };
            assert!(
                preflight_room_writes(std::slice::from_ref(&event), Some(&condition), &state)
                    .is_ok(),
                "{kind}"
            );
            assert!(
                preflight_room_writes(std::slice::from_ref(&event), None, &state).is_err(),
                "{kind}"
            );
            assert!(
                preflight_room_writes(std::slice::from_ref(&event), Some(&wrong), &state).is_err(),
                "{kind}"
            );
            event.stream_id = "call_session:different".into();
            assert!(
                preflight_room_writes(std::slice::from_ref(&event), Some(&condition), &state)
                    .is_err(),
                "{kind}"
            );
            event.stream_id = stream.into();
            event.stream_kind = 0;
            assert!(
                preflight_room_writes(std::slice::from_ref(&event), Some(&condition), &state)
                    .is_err(),
                "{kind}"
            );
            event.stream_kind = 6;
            event.record_kind = RecordKind::Tombstone;
            assert!(
                preflight_room_writes(std::slice::from_ref(&event), Some(&condition), &state)
                    .is_err(),
                "{kind}"
            );
            event.record_kind = RecordKind::Event;
            assert!(
                preflight_room_writes(
                    std::slice::from_ref(&event),
                    Some(&condition),
                    &ProjectionState::new()
                )
                .is_ok()
                    == (kind == "call_session_created"),
                "{kind}"
            );
        }
        assert_eq!(
            decode_value(&state.get(INDEX_NAME, b"s_1").unwrap()).unwrap(),
            session
        );
    }

    #[test]
    fn encode_decode_roundtrip() {
        let s = CallSession::new("s_1", "ch_1", "audio-call", 1, 10, "webrtc");
        let bytes = encode_value(&s).unwrap();
        let back = decode_value(&bytes).unwrap();
        assert_eq!(s, back);
    }

    #[test]
    fn encode_key_matches_session_id() {
        assert_eq!(encode_key("abc"), b"abc".to_vec());
    }

    #[test]
    fn absent_teardown_is_idempotent_but_invalid_payload_is_not_accepted() {
        let state = ProjectionState::new();
        let mut event = DurableEvent {
            commit_seq: 1,
            stream_id: "call_session:absent".into(),
            event_type: "call_session_ended".into(),
            payload: serde_json::to_vec(
                &serde_json::json!({"active": false, "ended_at_micros": 42}),
            )
            .unwrap(),
        };
        for _ in 0..2 {
            CallSessionsProjection.apply(&event, &state).unwrap();
        }
        assert!(state.get(INDEX_NAME, b"absent").is_none());
        for invalid in [b"not json".to_vec(), b"{}".to_vec()] {
            event.payload = invalid;
            assert!(CallSessionsProjection.apply(&event, &state).is_err());
        }
    }
}
