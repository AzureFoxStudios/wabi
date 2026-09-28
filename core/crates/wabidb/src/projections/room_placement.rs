//! Versioned placement intent for a room. This is a control record, not a
//! writer lease: routing and admission must enforce it before multi-owner use.

use crate::{
    engine::locks::ProjectionState,
    error::{Result, WabiError},
    format::record::RecordKind,
    projections::handler::{DurableEvent, Projection},
    sequencer::types::{EventToWrite, RoomOwnerPrecondition},
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

pub const INDEX: &str = "room_placements";
pub const EVENT: &str = "room_placement_changed_v1";
pub const INIT_EVENT: &str = "room_placement_initialized_v1";
pub const INIT_STREAM: &str = "room-placement-initializations:v1";
const STREAM_PREFIX: &str = "room-placement:v1:";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoomPlacementRecord {
    pub schema_version: u8,
    pub channel_id: String,
    pub epoch: u64,
    pub owner_node_id: String,
    pub replica_node_ids: Vec<String>,
}

/// The ordinary channel ID is derived from the commit sequence. This event
/// shares the channel-created commit so first placement is never a second,
/// failure-prone write.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoomPlacementInitialization {
    pub schema_version: u8,
    pub owner_node_id: String,
    pub replica_node_ids: Vec<String>,
}

pub fn stream_id(channel_id: &str) -> String {
    format!("{STREAM_PREFIX}{channel_id}")
}

fn valid_id(value: &str, max_len: usize) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= max_len
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'_'))
}

fn valid_node_set(owner_node_id: &str, replica_node_ids: &[String]) -> bool {
    if !valid_id(owner_node_id, 64) || replica_node_ids.len() > 7 {
        return false;
    }
    let mut replicas = HashSet::new();
    replica_node_ids.iter().all(|replica| {
        valid_id(replica, 64) && replica != owner_node_id && replicas.insert(replica.as_str())
    })
}

pub fn decode(bytes: &[u8]) -> Result<RoomPlacementRecord> {
    let bad = || WabiError::Corrupt {
        location: INDEX.into(),
        detail: "invalid room placement v1".into(),
    };
    if bytes.len() > 16 * 1024 {
        return Err(bad());
    }
    let record: RoomPlacementRecord = serde_json::from_slice(bytes).map_err(|_| bad())?;
    if record.schema_version != 1
        || !valid_id(&record.channel_id, 128)
        || record.epoch == 0
        || !valid_node_set(&record.owner_node_id, &record.replica_node_ids)
    {
        return Err(bad());
    }
    Ok(record)
}

fn decode_initialization(bytes: &[u8]) -> Result<RoomPlacementInitialization> {
    let bad = || WabiError::Corrupt {
        location: INDEX.into(),
        detail: "invalid room placement initialization v1".into(),
    };
    if bytes.len() > 16 * 1024 {
        return Err(bad());
    }
    let init: RoomPlacementInitialization = serde_json::from_slice(bytes).map_err(|_| bad())?;
    if init.schema_version != 1 || !valid_node_set(&init.owner_node_id, &init.replica_node_ids) {
        return Err(bad());
    }
    Ok(init)
}

/// Reject invalid placement commands before their index entry is durable.
/// Placement commands must be isolated from other queued commands so the
/// projection here is the result of every earlier commit.
pub(crate) fn preflight_command(
    events: &[EventToWrite],
    commit_seq: u64,
    state: &ProjectionState,
) -> Result<()> {
    let mut initial_seen = false;
    let mut placed = HashSet::new();
    for (position, event) in events.iter().enumerate() {
        if matches!(event.event_type.as_str(), EVENT | INIT_EVENT)
            && (event.record_kind != RecordKind::Event || event.stream_kind != 6)
        {
            return Err(invalid_preflight("invalid room placement record kind"));
        }
        let record = match event.event_type.as_str() {
            INIT_EVENT => {
                if initial_seen || event.stream_id != INIT_STREAM {
                    return Err(invalid_preflight(
                        "duplicate or misrouted room initialization",
                    ));
                }
                initial_seen = true;
                let init = decode_initialization(&event.plaintext)
                    .map_err(|_| invalid_preflight("invalid room initialization"))?;
                if position != 1 || events.len() != 2 {
                    return Err(invalid_preflight(
                        "room initialization must share its channel creation commit",
                    ));
                }
                let created = &events[0];
                if created.event_type != "channel_created"
                    || created.stream_id != "channels"
                    || created.record_kind != RecordKind::Event
                {
                    return Err(invalid_preflight(
                        "room initialization requires a preceding channel creation",
                    ));
                }
                let channel =
                    super::channels::decode_created_payload(&created.plaintext).map_err(|_| {
                        invalid_preflight("invalid created channel for room initialization")
                    })?;
                if channel.channel_id == created.stream_id {
                    return Err(invalid_preflight(
                        "room initialization does not match a generated channel ID",
                    ));
                }
                RoomPlacementRecord {
                    schema_version: 1,
                    channel_id: format!("ch_{commit_seq:x}"),
                    epoch: 1,
                    owner_node_id: init.owner_node_id,
                    replica_node_ids: init.replica_node_ids,
                }
            }
            EVENT => {
                let record = decode(&event.plaintext)
                    .map_err(|_| invalid_preflight("invalid room placement"))?;
                if event.stream_id != stream_id(&record.channel_id) {
                    return Err(invalid_preflight(
                        "room placement stream does not match channel",
                    ));
                }
                record
            }
            _ => continue,
        };
        if !placed.insert(record.channel_id.clone()) {
            return Err(invalid_preflight(
                "duplicate placement for one room in a command",
            ));
        }
        let next_epoch = match state.get(INDEX, record.channel_id.as_bytes()) {
            Some(existing) => decode(&existing)?.epoch.checked_add(1),
            None => Some(1),
        };
        if next_epoch != Some(record.epoch) {
            return Err(invalid_preflight(
                "room placement epoch is not the next epoch",
            ));
        }
    }
    Ok(())
}

fn invalid_preflight(reason: &str) -> WabiError {
    WabiError::Validation {
        command: "room_placement".into(),
        reason: reason.into(),
    }
}

/// Check a room write against the placement visible at its sequencer turn.
/// A change from missing to placed also rejects the stale legacy admission.
pub(crate) fn preflight_room_owner(
    precondition: &RoomOwnerPrecondition,
    state: &ProjectionState,
    local_node_id: &str,
) -> Result<()> {
    if precondition.channel_id.is_empty()
        || precondition.channel_id.len() > 512
        || precondition
            .channel_id
            .bytes()
            .any(|byte| byte.is_ascii_control())
        || !valid_id(&precondition.owner_node_id, 64)
        || precondition.expected_epoch == Some(0)
    {
        return Err(invalid_preflight("invalid room owner precondition"));
    }
    if precondition.owner_node_id != local_node_id {
        return Err(WabiError::Validation {
            command: "room_owner_precondition".into(),
            reason: "write owner does not match this engine's local node identity".into(),
        });
    }
    let current = state.get(INDEX, precondition.channel_id.as_bytes());
    let matches = match (current, precondition.expected_epoch) {
        (None, None) => true,
        (Some(bytes), Some(epoch)) => {
            let record = decode(&bytes)?;
            record.channel_id == precondition.channel_id
                && record.owner_node_id == precondition.owner_node_id
                && record.epoch == epoch
        }
        _ => false,
    };
    if !matches {
        return Err(WabiError::Validation {
            command: "room_owner_precondition".into(),
            reason: "room owner or epoch changed before the write was committed".into(),
        });
    }
    Ok(())
}

pub struct RoomPlacementProjection;

impl Projection for RoomPlacementProjection {
    fn event_type(&self) -> &str {
        EVENT
    }

    fn event_types(&self) -> Vec<&str> {
        vec![EVENT, INIT_EVENT]
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let (placement, value) = if event.event_type == INIT_EVENT {
            if event.stream_id != INIT_STREAM {
                return Err(WabiError::Corrupt {
                    location: INDEX.into(),
                    detail: "room placement initialization used the wrong stream".into(),
                });
            }
            let init = decode_initialization(&event.payload)?;
            let channel_id = format!("ch_{:x}", event.commit_seq);
            if state.get("channels", channel_id.as_bytes()).is_none() {
                return Err(WabiError::Corrupt {
                    location: INDEX.into(),
                    detail: "room placement initialization has no created channel".into(),
                });
            }
            let placement = RoomPlacementRecord {
                schema_version: 1,
                channel_id,
                epoch: 1,
                owner_node_id: init.owner_node_id,
                replica_node_ids: init.replica_node_ids,
            };
            let value = serde_json::to_vec(&placement).map_err(|_| WabiError::Corrupt {
                location: INDEX.into(),
                detail: "could not encode room placement initialization".into(),
            })?;
            (placement, value)
        } else {
            let placement = decode(&event.payload)?;
            if event.stream_id != stream_id(&placement.channel_id) {
                return Err(WabiError::Corrupt {
                    location: INDEX.into(),
                    detail: "room placement stream does not match channel".into(),
                });
            }
            (placement, event.payload.clone())
        };
        let next_epoch = match state.get(INDEX, placement.channel_id.as_bytes()) {
            Some(existing) => decode(&existing)?.epoch.checked_add(1),
            None => Some(1),
        };
        if next_epoch != Some(placement.epoch) {
            return Err(WabiError::Corrupt {
                location: INDEX.into(),
                detail: "room placement epoch is not the next epoch".into(),
            });
        }
        state.insert(
            INDEX,
            placement.channel_id.into_bytes(),
            value,
            event.commit_seq,
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(commit_seq: u64, epoch: u64) -> DurableEvent {
        DurableEvent {
            commit_seq,
            stream_id: stream_id("ch_abc"),
            event_type: EVENT.into(),
            payload: serde_json::to_vec(&RoomPlacementRecord {
                schema_version: 1,
                channel_id: "ch_abc".into(),
                epoch,
                owner_node_id: "site-a".into(),
                replica_node_ids: vec!["site-b".into()],
            })
            .unwrap(),
        }
    }

    #[test]
    fn placement_payload_rejects_invalid_ids_and_replica_sets() {
        let mut record = decode(&event(1, 1).payload).unwrap();
        record.replica_node_ids.push("site-b".into());
        assert!(decode(&serde_json::to_vec(&record).unwrap()).is_err());
        record.replica_node_ids = vec!["site-a".into()];
        assert!(decode(&serde_json::to_vec(&record).unwrap()).is_err());
        record.replica_node_ids.clear();
        record.channel_id = "../other".into();
        assert!(decode(&serde_json::to_vec(&record).unwrap()).is_err());
        assert!(decode(&vec![0; 16 * 1024 + 1]).is_err());
    }

    #[test]
    fn placement_preflight_rejects_bad_record_kind_and_orphan_initialization() {
        let state = ProjectionState::new();
        let mut changed = EventToWrite {
            stream_id: stream_id("ch_abc"),
            event_type: EVENT.into(),
            stream_kind: 6,
            record_kind: RecordKind::Snapshot,
            plaintext: event(1, 1).payload,
        };
        assert!(preflight_command(std::slice::from_ref(&changed), 1, &state).is_err());
        changed.record_kind = RecordKind::Event;
        changed.stream_kind = 1;
        assert!(preflight_command(std::slice::from_ref(&changed), 1, &state).is_err());
        changed.stream_kind = 6;
        preflight_command(std::slice::from_ref(&changed), 1, &state).unwrap();

        let initial = EventToWrite {
            stream_id: INIT_STREAM.into(),
            event_type: INIT_EVENT.into(),
            stream_kind: 6,
            record_kind: RecordKind::Event,
            plaintext: serde_json::to_vec(&RoomPlacementInitialization {
                schema_version: 1,
                owner_node_id: "site-a".into(),
                replica_node_ids: vec![],
            })
            .unwrap(),
        };
        assert!(preflight_command(&[initial], 1, &state).is_err());
    }

    #[test]
    fn room_write_precondition_requires_the_observed_owner_and_epoch() {
        let state = ProjectionState::new();
        let precondition = RoomOwnerPrecondition {
            channel_id: "ch_abc".into(),
            owner_node_id: "site-a".into(),
            expected_epoch: None,
        };
        preflight_room_owner(&precondition, &state, "site-a").unwrap();
        assert!(preflight_room_owner(&precondition, &state, "site-b").is_err());
        let legacy_id = RoomOwnerPrecondition {
            channel_id: "legacy:room".into(),
            ..precondition.clone()
        };
        preflight_room_owner(&legacy_id, &state, "site-a").unwrap();
        RoomPlacementProjection.apply(&event(1, 1), &state).unwrap();
        assert!(preflight_room_owner(&precondition, &state, "site-a").is_err());

        let placed = RoomOwnerPrecondition {
            expected_epoch: Some(1),
            ..precondition.clone()
        };
        preflight_room_owner(&placed, &state, "site-a").unwrap();
        assert!(preflight_room_owner(&placed, &state, "site-b").is_err());
        let wrong_owner = RoomOwnerPrecondition {
            owner_node_id: "site-b".into(),
            ..placed.clone()
        };
        assert!(preflight_room_owner(&wrong_owner, &state, "site-a").is_err());
        RoomPlacementProjection.apply(&event(2, 2), &state).unwrap();
        assert!(preflight_room_owner(&placed, &state, "site-a").is_err());
    }

    #[test]
    fn placement_projection_requires_matching_stream_and_contiguous_epoch() {
        let state = ProjectionState::new();
        let projection = RoomPlacementProjection;
        assert!(projection.apply(&event(1, 2), &state).is_err());
        let mut wrong_stream = event(1, 1);
        wrong_stream.stream_id = stream_id("ch_other");
        assert!(projection.apply(&wrong_stream, &state).is_err());
        projection.apply(&event(1, 1), &state).unwrap();
        assert!(projection.apply(&event(2, 1), &state).is_err());
        assert!(projection.apply(&event(2, 3), &state).is_err());
        projection.apply(&event(2, 2), &state).unwrap();
        assert_eq!(
            decode(&state.get(INDEX, b"ch_abc").unwrap()).unwrap().epoch,
            2
        );
    }

    #[test]
    fn initialization_requires_created_channel_in_same_ordered_commit() {
        let state = ProjectionState::new();
        let projection = RoomPlacementProjection;
        let mut initial = DurableEvent {
            commit_seq: 7,
            stream_id: INIT_STREAM.into(),
            event_type: INIT_EVENT.into(),
            payload: serde_json::to_vec(&RoomPlacementInitialization {
                schema_version: 1,
                owner_node_id: "site-a".into(),
                replica_node_ids: vec![],
            })
            .unwrap(),
        };
        assert!(projection.apply(&initial, &state).is_err());
        state.insert("channels", b"ch_7".to_vec(), b"{}".to_vec(), 7);
        initial.stream_id = "wrong".into();
        assert!(projection.apply(&initial, &state).is_err());
        initial.stream_id = INIT_STREAM.into();
        projection.apply(&initial, &state).unwrap();
        assert_eq!(
            decode(&state.get(INDEX, b"ch_7").unwrap())
                .unwrap()
                .owner_node_id,
            "site-a"
        );
        assert!(projection.apply(&initial, &state).is_err());
    }
}
