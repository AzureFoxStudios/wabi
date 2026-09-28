//! Parent-room binding for new local durable message/reaction commands.
//! Historical replay is unchanged. Unplaced rooms retain the single-Authority
//! compatibility path; a placed room cannot accept an unguarded mutation.

use crate::{
    engine::locks::ProjectionState,
    error::{Result, WabiError},
    format::record::RecordKind,
    projections::{message_lookup, messages, reactions, room_placement},
    sequencer::types::{EventToWrite, RoomOwnerPrecondition},
};
use std::collections::HashMap;

fn invalid(reason: &str) -> WabiError {
    WabiError::Validation {
        command: "room_owner_precondition".into(),
        reason: reason.into(),
    }
}

pub(crate) fn bind(
    room: &str,
    condition: Option<&RoomOwnerPrecondition>,
    state: &ProjectionState,
) -> Result<()> {
    if room.is_empty() || room.len() > 512 || room.chars().any(char::is_control) {
        return Err(invalid("invalid write parent room"));
    }
    match condition {
        Some(condition) if condition.channel_id != room => Err(invalid(
            "write owner condition does not match the actual parent room",
        )),
        None if state.get(room_placement::INDEX, room.as_bytes()).is_some() => {
            Err(invalid("placed room write lacks an owner condition"))
        }
        _ => Ok(()),
    }
}

pub(crate) fn preflight_command(
    events: &[EventToWrite],
    condition: Option<&RoomOwnerPrecondition>,
    state: &ProjectionState,
    pending_parents: &HashMap<String, String>,
    commit_seq: u64,
) -> Result<HashMap<String, String>> {
    // Placement commits are control boundaries. No existing message path
    // needs to change an owner and mutate its room in one command; require
    // the later write to observe the applied placement instead.
    if events.iter().any(|event| {
        matches!(
            event.event_type.as_str(),
            room_placement::EVENT | room_placement::INIT_EVENT
        )
    }) && events.iter().any(|event| {
        matches!(
            event.event_type.as_str(),
            "message_created"
                | "message_edited"
                | "message_deleted"
                | "channel_messages_cleared"
                | "reaction_added"
                | "reaction_removed"
        )
    }) {
        return Err(invalid(
            "placement changes and message writes require separate commands",
        ));
    }
    let mut created_parents = HashMap::new();
    for event in events {
        match event.event_type.as_str() {
            "message_created" | "message_edited" | "message_deleted" => {
                if event.record_kind != RecordKind::Event {
                    return Err(invalid("invalid message write record kind"));
                }
                let record = messages::decode_record(&event.plaintext)?;
                if event.stream_id != record.channel_id {
                    return Err(invalid("message write stream does not match its room"));
                }
                if record.message_id.is_empty() && event.event_type != "message_created" {
                    return Err(invalid("message mutation has no target ID"));
                }
                let message_id = if event.event_type == "message_created"
                    && record.message_id.trim().is_empty()
                {
                    format!("msg_{commit_seq:x}")
                } else {
                    record.message_id.clone()
                };
                let existing = message_lookup::get(state, &message_id)?;
                let pending = created_parents
                    .get(&message_id)
                    .or_else(|| pending_parents.get(&message_id));
                if existing
                    .as_ref()
                    .is_some_and(|row| row.channel_id != record.channel_id)
                    || pending.is_some_and(|room| *room != record.channel_id)
                {
                    return Err(invalid("message ID cannot be rebound to another room"));
                }
                if event.event_type != "message_created" && existing.is_none() && pending.is_none()
                {
                    return Err(invalid("message mutation has no stored parent"));
                }
                bind(&record.channel_id, condition, state)?;
                if event.event_type == "message_created" {
                    created_parents.insert(message_id, record.channel_id);
                }
            }
            "channel_messages_cleared" => {
                if event.record_kind != RecordKind::Event {
                    return Err(invalid("invalid channel clear record kind"));
                }
                let clear: messages::ChannelMessagesCleared =
                    serde_json::from_slice(&event.plaintext)
                        .map_err(|_| invalid("invalid channel clear payload"))?;
                if event.stream_id != clear.channel_id {
                    return Err(invalid("channel clear stream does not match its room"));
                }
                bind(&clear.channel_id, condition, state)?;
            }
            "reaction_added" | "reaction_removed" => {
                if event.record_kind != RecordKind::Event {
                    return Err(invalid("invalid reaction write record kind"));
                }
                let reaction = reactions::decode_reaction(&event.plaintext)?;
                let expected = if event.event_type == "reaction_added" {
                    format!("reactions:{}", reaction.message_id)
                } else {
                    format!(
                        "reactions:{}:{}:removed",
                        reaction.message_id, reaction.reaction_type
                    )
                };
                if event.stream_id != expected {
                    return Err(invalid("reaction write stream does not match its target"));
                }
                let room = message_lookup::get(state, &reaction.message_id)?
                    .map(|row| row.channel_id)
                    .or_else(|| {
                        created_parents
                            .get(&reaction.message_id)
                            .or_else(|| pending_parents.get(&reaction.message_id))
                            .cloned()
                    })
                    .ok_or_else(|| invalid("reaction write has no stored parent message"))?;
                bind(&room, condition, state)?;
            }
            _ => {}
        }
    }
    Ok(created_parents)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::projections::{
        message_lookup::tests::{apply, record},
        messages::encode_record,
    };

    fn event(kind: &str, stream: &str, plaintext: Vec<u8>) -> EventToWrite {
        EventToWrite {
            event_type: kind.into(),
            stream_id: stream.into(),
            plaintext,
            stream_kind: 1,
            record_kind: RecordKind::Event,
        }
    }

    #[test]
    fn placed_message_and_reaction_events_require_the_actual_room_guard() {
        let state = ProjectionState::new();
        let stored = record("ch_actual", "msg_a");
        apply(&state, "message_created", &stored, 1);
        state.insert(
            room_placement::INDEX,
            b"ch_actual".to_vec(),
            serde_json::to_vec(&room_placement::RoomPlacementRecord {
                schema_version: 1,
                channel_id: "ch_actual".into(),
                epoch: 1,
                owner_node_id: "site-a".into(),
                replica_node_ids: vec![],
            })
            .unwrap(),
            2,
        );
        let condition = RoomOwnerPrecondition {
            channel_id: "ch_actual".into(),
            owner_node_id: "site-a".into(),
            expected_epoch: Some(1),
        };
        let wrong = RoomOwnerPrecondition {
            channel_id: "ch_other".into(),
            ..condition.clone()
        };
        let reaction = reactions::Reaction {
            message_id: "msg_a".into(),
            user_id: 1,
            reaction_type: "thumbsup".into(),
            created_at_micros: 1,
            key_id: "v0".into(),
        };
        for (kind, stream, payload) in [
            (
                "message_created",
                "ch_actual",
                encode_record(&record("ch_actual", "msg_new")),
            ),
            ("message_edited", "ch_actual", encode_record(&stored)),
            ("message_deleted", "ch_actual", encode_record(&stored)),
            (
                "channel_messages_cleared",
                "ch_actual",
                serde_json::to_vec(&messages::ChannelMessagesCleared {
                    channel_id: "ch_actual".into(),
                    cleared_at_micros: 3,
                })
                .unwrap(),
            ),
            (
                "reaction_added",
                "reactions:msg_a",
                reactions::encode_reaction(&reaction),
            ),
            (
                "reaction_removed",
                "reactions:msg_a:thumbsup:removed",
                reactions::encode_reaction(&reaction),
            ),
        ] {
            let mut command = event(kind, stream, payload);
            assert!(
                preflight_command(
                    std::slice::from_ref(&command),
                    Some(&condition),
                    &state,
                    &HashMap::new(),
                    3
                )
                .is_ok(),
                "{kind}"
            );
            assert!(
                preflight_command(
                    std::slice::from_ref(&command),
                    None,
                    &state,
                    &HashMap::new(),
                    3
                )
                .is_err(),
                "{kind}"
            );
            assert!(
                preflight_command(
                    std::slice::from_ref(&command),
                    Some(&wrong),
                    &state,
                    &HashMap::new(),
                    3
                )
                .is_err(),
                "{kind}"
            );
            command.stream_id = "unrelated".into();
            assert!(
                preflight_command(
                    std::slice::from_ref(&command),
                    Some(&condition),
                    &state,
                    &HashMap::new(),
                    3
                )
                .is_err(),
                "{kind}"
            );
            command.stream_id = stream.into();
            command.record_kind = RecordKind::Snapshot;
            assert!(
                preflight_command(
                    std::slice::from_ref(&command),
                    Some(&condition),
                    &state,
                    &HashMap::new(),
                    3
                )
                .is_err(),
                "{kind}"
            );
        }
        assert_eq!(message_lookup::get(&state, "msg_a").unwrap(), Some(stored));
    }

    #[test]
    fn pending_parents_allow_ordered_batch_writes_without_room_rebinding() {
        let state = ProjectionState::new();
        let create = event(
            "message_created",
            "ch_a",
            encode_record(&record("ch_a", "msg_a")),
        );
        let pending = preflight_command(&[create], None, &state, &HashMap::new(), 1).unwrap();
        let rebind = event(
            "message_created",
            "ch_b",
            encode_record(&record("ch_b", "msg_a")),
        );
        assert!(preflight_command(&[rebind], None, &state, &pending, 2).is_err());
        let edit = event(
            "message_edited",
            "ch_a",
            encode_record(&record("ch_a", "msg_a")),
        );
        assert!(preflight_command(&[edit], None, &state, &pending, 3).is_ok());
        let reaction = reactions::Reaction {
            message_id: "msg_a".into(),
            user_id: 1,
            reaction_type: "thumbsup".into(),
            created_at_micros: 1,
            key_id: "v0".into(),
        };
        let react = || {
            event(
                "reaction_added",
                "reactions:msg_a",
                reactions::encode_reaction(&reaction),
            )
        };
        assert!(preflight_command(&[react()], None, &state, &pending, 3).is_ok());
        assert!(preflight_command(&[react()], None, &state, &HashMap::new(), 3).is_err());
        let wrong = RoomOwnerPrecondition {
            channel_id: "ch_b".into(),
            owner_node_id: "site-a".into(),
            expected_epoch: None,
        };
        assert!(preflight_command(&[react()], Some(&wrong), &state, &pending, 3).is_err());
        assert_eq!(state.index_len("messages"), 0);
    }

    #[test]
    fn legacy_blank_ids_use_the_same_fallback_as_projection_replay() {
        let state = ProjectionState::new();
        let create = event(
            "message_created",
            "ch_a",
            encode_record(&record("ch_a", " \t")),
        );
        let pending = preflight_command(&[create], None, &state, &HashMap::new(), 15).unwrap();
        assert_eq!(pending.get("msg_f").map(String::as_str), Some("ch_a"));
        let rebind = event(
            "message_created",
            "ch_b",
            encode_record(&record("ch_b", "")),
        );
        assert!(preflight_command(&[rebind], None, &state, &pending, 15).is_err());
    }

    #[test]
    fn placement_changes_and_message_writes_require_separate_commits() {
        let state = ProjectionState::new();
        for placement_first in [false, true] {
            let write = event(
                "message_created",
                "ch_a",
                encode_record(&record("ch_a", "msg_a")),
            );
            let placement = event(room_placement::EVENT, "unused", vec![]);
            let events = if placement_first {
                vec![placement, write]
            } else {
                vec![write, placement]
            };
            assert!(preflight_command(&events, None, &state, &HashMap::new(), 1).is_err());
        }
        assert_eq!(state.index_len("messages"), 0);
    }
}
