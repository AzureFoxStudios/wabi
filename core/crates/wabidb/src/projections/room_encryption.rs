//! Durable per-room marker for the experimental conversation encryption.
//!
//! The server's encryption registry (`e2ee_state.json`, a JSON sidecar beside
//! the data directory) holds device public keys and wrapped room keys. It is
//! the only place those live. This projection holds one small record per
//! conversation saying which encryption state the room has reached (waiting
//! for encryption, server-readable chosen by a participant, or encrypted at a
//! key epoch), so that the database itself knows when a restored or missing
//! registry is behind it. The server writes the marker before the registry
//! entry and refuses readable content when the registry does not cover it.
//!
//! The record holds no key material and no message content.
//!
//! Merging is monotonic in the one direction that matters: once a room is
//! `Enabled`, no later event moves it back to `Pending` or `ServerReadable`,
//! and its epoch never decreases. `Pending` and `ServerReadable` may replace
//! each other (a participant's explicit server-readable choice, and a
//! recreated conversation that starts pending again).

use crate::{
    engine::locks::ProjectionState,
    error::{Result, WabiError},
    format::versioned::{self, RecordFormat},
    projections::handler::{DurableEvent, Projection},
};
use serde::{Deserialize, Serialize};

pub const INDEX: &str = "room_encryption";
pub const EVENT: &str = "room_encryption_marked";
pub const STREAM: &str = "room-encryption:v1";
/// Upper bound on a conversation id in a marker; channel ids are far shorter.
const MAX_CHANNEL_ID: usize = 256;

/// Versioned durable layout of [`RoomEncryptionRecord`]; see `format::versioned`.
/// There was never an unversioned form of this record.
const FORMAT: RecordFormat = RecordFormat::new(*b"RENC", "room encryption marker");

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum RoomEncryptionMode {
    /// A new conversation waiting for participants' devices. No readable
    /// content until encryption is enabled or a sender chooses server-readable.
    Pending,
    /// A participant explicitly chose server-readable messages in a new
    /// conversation. Each sender still has to choose it for themselves.
    ServerReadable,
    /// Experimental encryption is enabled at `epoch` (at least 1).
    Enabled,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoomEncryptionRecord {
    pub channel_id: String,
    pub mode: RoomEncryptionMode,
    /// The room-key epoch for `Enabled`; 0 otherwise.
    pub epoch: u64,
    /// For `ServerReadable` only: the members who chose server-readable
    /// messages on their own device during the current server-readable
    /// period, sorted and unique. Empty in every other mode. A registry that
    /// lists a sender this set does not is not trusted for that sender.
    pub consenting_user_ids: Vec<u64>,
}

/// Version 1 layout, before per-sender consent was recorded. Kept unchanged:
/// a version-1 record decodes with no recorded consent, so every sender has
/// to choose server-readable again (the safe direction).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct RoomEncryptionRecordV1 {
    channel_id: String,
    mode: RoomEncryptionMode,
    epoch: u64,
}

impl From<RoomEncryptionRecordV1> for RoomEncryptionRecord {
    fn from(v1: RoomEncryptionRecordV1) -> Self {
        RoomEncryptionRecord { channel_id: v1.channel_id, mode: v1.mode, epoch: v1.epoch, consenting_user_ids: vec![] }
    }
}

/// Upper bound on recorded consents; a conversation has far fewer members.
const MAX_CONSENTS: usize = 4096;

impl RoomEncryptionRecord {
    pub fn valid(&self) -> bool {
        !self.channel_id.is_empty()
            && self.channel_id.len() <= MAX_CHANNEL_ID
            && match self.mode {
                RoomEncryptionMode::Enabled => self.epoch >= 1,
                _ => self.epoch == 0,
            }
            && (self.mode == RoomEncryptionMode::ServerReadable || self.consenting_user_ids.is_empty())
            && self.consenting_user_ids.len() <= MAX_CONSENTS
            && self.consenting_user_ids.iter().all(|id| *id > 0)
            && self.consenting_user_ids.windows(2).all(|w| w[0] < w[1])
    }

    /// The record that results from applying `next` on top of `self`.
    /// Never leaves `Enabled`, never lowers an epoch. Within one
    /// server-readable period consent only accumulates; a return to
    /// `Pending` ends the period and its consent.
    pub fn merged(&self, next: &RoomEncryptionRecord) -> RoomEncryptionRecord {
        use RoomEncryptionMode::*;
        match (self.mode, next.mode) {
            (Enabled, Enabled) => RoomEncryptionRecord { epoch: self.epoch.max(next.epoch), ..self.clone() },
            (Enabled, _) => self.clone(),
            (ServerReadable, ServerReadable) => {
                let mut ids: Vec<u64> = self.consenting_user_ids.iter().chain(&next.consenting_user_ids).copied().collect();
                ids.sort_unstable();
                ids.dedup();
                RoomEncryptionRecord { consenting_user_ids: ids, ..self.clone() }
            }
            _ => next.clone(),
        }
    }

    /// Whether committing `next` could change nothing but move the marker
    /// down: out of `Enabled`, or to a lower epoch. The engine refuses such
    /// an event before it is durable.
    pub fn would_downgrade(&self, next: &RoomEncryptionRecord) -> bool {
        self.mode == RoomEncryptionMode::Enabled
            && (next.mode != RoomEncryptionMode::Enabled || next.epoch < self.epoch)
    }
}

fn corrupt(detail: String) -> WabiError {
    WabiError::Corrupt { location: FORMAT.location.into(), detail }
}

pub fn encode_record(record: &RoomEncryptionRecord) -> Vec<u8> {
    versioned::encode(&FORMAT, 2, record)
}

pub fn decode_record(bytes: &[u8]) -> Result<RoomEncryptionRecord> {
    let record: RoomEncryptionRecord = versioned::decode(
        &FORMAT,
        bytes,
        |version, body| match version {
            1 => Some(versioned::payload::<RoomEncryptionRecordV1>(&FORMAT, body).map(Into::into)),
            2 => Some(versioned::payload(&FORMAT, body)),
            _ => None,
        },
        |_| Err(corrupt("room encryption marker without a version header".into())),
    )?;
    if !record.valid() {
        return Err(corrupt("invalid room encryption marker".into()));
    }
    Ok(record)
}

/// The marker the database holds for `channel_id`, if any.
pub fn get(state: &ProjectionState, channel_id: &str) -> Result<Option<RoomEncryptionRecord>> {
    match state.get(INDEX, channel_id.as_bytes()) {
        None => Ok(None),
        Some(bytes) => {
            let record = decode_record(&bytes)?;
            if record.channel_id != channel_id {
                return Err(corrupt("room encryption marker stored under another key".into()));
            }
            Ok(Some(record))
        }
    }
}

/// Refuse an invalid marker command before it is durable: one marker event,
/// alone in its command, on its stream, decodable and valid, and never a move
/// out of `Enabled` or to a lower epoch. Marker commands are isolated in the
/// sequencer (`has_room_control_event`), so `state` holds every earlier commit.
pub(crate) fn preflight(events: &[crate::sequencer::types::EventToWrite], state: &ProjectionState) -> Result<()> {
    let bad = |reason: &str| WabiError::Validation { command: EVENT.into(), reason: reason.into() };
    if !events.iter().any(|e| e.event_type == EVENT) {
        return Ok(());
    }
    if events.len() != 1 {
        return Err(bad("a room encryption marker must be a separate command"));
    }
    let event = &events[0];
    if event.stream_id != STREAM || event.stream_kind != 6 || event.record_kind != crate::format::record::RecordKind::Event {
        return Err(bad("invalid room encryption marker stream or record kind"));
    }
    let next = decode_record(&event.plaintext).map_err(|_| bad("invalid room encryption marker"))?;
    if let Some(current) = get(state, &next.channel_id).map_err(|_| bad("stored room encryption marker unreadable"))? {
        if current.would_downgrade(&next) {
            return Err(bad("a room encryption marker never moves out of Enabled or to a lower epoch"));
        }
    }
    Ok(())
}

pub struct RoomEncryptionProjection;

impl Projection for RoomEncryptionProjection {
    fn event_type(&self) -> &str {
        EVENT
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        if event.stream_id != STREAM {
            return Err(WabiError::Corrupt {
                location: INDEX.into(),
                detail: "room encryption marker has wrong stream".into(),
            });
        }
        let next = decode_record(&event.payload)?;
        let merged = match get(state, &next.channel_id)? {
            Some(existing) => existing.merged(&next),
            None => next,
        };
        state.insert(
            INDEX,
            merged.channel_id.as_bytes().to_vec(),
            encode_record(&merged),
            event.commit_seq,
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(mode: RoomEncryptionMode, epoch: u64) -> RoomEncryptionRecord {
        RoomEncryptionRecord { channel_id: "dm_1_2".into(), mode, epoch, consenting_user_ids: vec![] }
    }

    fn readable(ids: &[u64]) -> RoomEncryptionRecord {
        RoomEncryptionRecord { consenting_user_ids: ids.to_vec(), ..record(RoomEncryptionMode::ServerReadable, 0) }
    }

    fn event(seq: u64, r: &RoomEncryptionRecord) -> DurableEvent {
        DurableEvent {
            commit_seq: seq,
            stream_id: STREAM.into(),
            event_type: EVENT.into(),
            payload: encode_record(r),
        }
    }

    /// Golden bytes of version 1, captured from the first encoder. Stored
    /// markers look like this; never regenerate the literal. Version 1 now
    /// only decodes, with no recorded consent.
    #[test]
    fn golden_version_1_bytes() {
        let sample = RoomEncryptionRecord {
            channel_id: "group-ü".into(),
            mode: RoomEncryptionMode::Enabled,
            epoch: 300,
            consenting_user_ids: vec![],
        };
        let golden = "ffffffffffffffffffff52454e43010867726f75702dc3bc02ac02";
        assert_eq!(decode_record(&hex::decode(golden).unwrap()).unwrap(), sample);
        // A version-1 server-readable marker carries no consent.
        let v1_readable = versioned::encode(&FORMAT, 1, &RoomEncryptionRecordV1 {
            channel_id: "grandm".into(), mode: RoomEncryptionMode::ServerReadable, epoch: 0,
        });
        assert_eq!(hex::encode(&v1_readable), "ffffffffffffffffffff52454e4301066772616e646d0100");
        assert_eq!(decode_record(&v1_readable).unwrap().consenting_user_ids, Vec::<u64>::new());
        let pending = "ffffffffffffffffffff52454e4301066772616e646d0000";
        let decoded = decode_record(&hex::decode(pending).unwrap()).unwrap();
        assert_eq!(decoded.mode, RoomEncryptionMode::Pending);
        assert_eq!(decoded.channel_id, "grandm");
    }

    /// Golden bytes of version 2 (consent recorded); never regenerate.
    #[test]
    fn golden_version_2_bytes() {
        let sample = RoomEncryptionRecord {
            channel_id: "dm_3_7".into(),
            mode: RoomEncryptionMode::ServerReadable,
            epoch: 0,
            consenting_user_ids: vec![3, 300],
        };
        let golden = "ffffffffffffffffffff52454e430206646d5f335f37010002 03ac02".replace(' ', "");
        assert_eq!(hex::encode(encode_record(&sample)), golden);
        assert_eq!(decode_record(&hex::decode(&golden).unwrap()).unwrap(), sample);
    }

    #[test]
    fn unversioned_unknown_version_and_invalid_records_are_refused() {
        let bytes = encode_record(&record(RoomEncryptionMode::Pending, 0));
        assert!(decode_record(&bytes[versioned::HEADER_LEN..]).is_err(), "no legacy form");
        let mut v3 = bytes.clone();
        v3[versioned::HEADER_LEN - 1] = 3;
        assert!(decode_record(&v3).is_err());
        for bad in [
            record(RoomEncryptionMode::Enabled, 0),
            record(RoomEncryptionMode::Pending, 3),
            RoomEncryptionRecord { channel_id: String::new(), ..record(RoomEncryptionMode::Pending, 0) },
            RoomEncryptionRecord { channel_id: "x".repeat(257), ..record(RoomEncryptionMode::Pending, 0) },
            RoomEncryptionRecord { consenting_user_ids: vec![1], ..record(RoomEncryptionMode::Pending, 0) },
            readable(&[2, 1]),
            readable(&[1, 1]),
            readable(&[0]),
        ] {
            assert!(decode_record(&encode_record(&bad)).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn enabled_never_moves_back_and_epochs_never_decrease() {
        let state = ProjectionState::new();
        let p = RoomEncryptionProjection;
        p.apply(&event(1, &record(RoomEncryptionMode::Pending, 0)), &state).unwrap();
        p.apply(&event(2, &record(RoomEncryptionMode::ServerReadable, 0)), &state).unwrap();
        assert_eq!(get(&state, "dm_1_2").unwrap().unwrap().mode, RoomEncryptionMode::ServerReadable);
        // A recreated conversation starts pending again.
        p.apply(&event(3, &record(RoomEncryptionMode::Pending, 0)), &state).unwrap();
        assert_eq!(get(&state, "dm_1_2").unwrap().unwrap().mode, RoomEncryptionMode::Pending);
        p.apply(&event(4, &record(RoomEncryptionMode::Enabled, 3)), &state).unwrap();
        for (seq, r) in [
            (5, record(RoomEncryptionMode::Pending, 0)),
            (6, record(RoomEncryptionMode::ServerReadable, 0)),
            (7, record(RoomEncryptionMode::Enabled, 2)),
        ] {
            p.apply(&event(seq, &r), &state).unwrap();
            assert_eq!(get(&state, "dm_1_2").unwrap().unwrap(), record(RoomEncryptionMode::Enabled, 3));
        }
        p.apply(&event(8, &record(RoomEncryptionMode::Enabled, 4)), &state).unwrap();
        assert_eq!(get(&state, "dm_1_2").unwrap().unwrap().epoch, 4);
        assert!(get(&state, "other").unwrap().is_none());
    }

    #[test]
    fn consent_accumulates_within_a_server_readable_period_and_resets_with_pending() {
        let state = ProjectionState::new();
        let p = RoomEncryptionProjection;
        p.apply(&event(1, &record(RoomEncryptionMode::Pending, 0)), &state).unwrap();
        p.apply(&event(2, &readable(&[5])), &state).unwrap();
        p.apply(&event(3, &readable(&[2])), &state).unwrap();
        assert_eq!(get(&state, "dm_1_2").unwrap().unwrap().consenting_user_ids, vec![2, 5]);
        p.apply(&event(4, &record(RoomEncryptionMode::Pending, 0)), &state).unwrap();
        p.apply(&event(5, &readable(&[2])), &state).unwrap();
        assert_eq!(get(&state, "dm_1_2").unwrap().unwrap().consenting_user_ids, vec![2]);
        p.apply(&event(6, &record(RoomEncryptionMode::Enabled, 1)), &state).unwrap();
        assert_eq!(get(&state, "dm_1_2").unwrap().unwrap(), record(RoomEncryptionMode::Enabled, 1));
    }

    #[test]
    fn preflight_refuses_invalid_and_downgrading_markers_before_durability() {
        use crate::{format::record::RecordKind, sequencer::types::EventToWrite};
        let state = ProjectionState::new();
        let write = |r: &RoomEncryptionRecord| EventToWrite {
            stream_id: STREAM.into(), stream_kind: 6, event_type: EVENT.into(),
            record_kind: RecordKind::Event, plaintext: encode_record(r),
        };
        assert!(preflight(&[write(&record(RoomEncryptionMode::Pending, 0))], &state).is_ok());
        let mut invalid = write(&record(RoomEncryptionMode::Pending, 0));
        invalid.plaintext = encode_record(&record(RoomEncryptionMode::Enabled, 0));
        assert!(preflight(&[invalid], &state).is_err(), "enabled at epoch 0");
        let mut misrouted = write(&record(RoomEncryptionMode::Pending, 0));
        misrouted.stream_id = "elsewhere".into();
        assert!(preflight(&[misrouted], &state).is_err());
        assert!(preflight(&[write(&record(RoomEncryptionMode::Pending, 0)), write(&readable(&[1]))], &state).is_err());
        RoomEncryptionProjection.apply(&event(1, &record(RoomEncryptionMode::Enabled, 3)), &state).unwrap();
        for down in [record(RoomEncryptionMode::Pending, 0), readable(&[1]), record(RoomEncryptionMode::Enabled, 2)] {
            assert!(preflight(&[write(&down)], &state).is_err(), "{down:?}");
        }
        assert!(preflight(&[write(&record(RoomEncryptionMode::Enabled, 3))], &state).is_ok());
        assert!(preflight(&[write(&record(RoomEncryptionMode::Enabled, 4))], &state).is_ok());
    }

    #[test]
    fn wrong_stream_is_refused() {
        let state = ProjectionState::new();
        let mut e = event(1, &record(RoomEncryptionMode::Pending, 0));
        e.stream_id = "elsewhere".into();
        assert!(RoomEncryptionProjection.apply(&e, &state).is_err());
    }
}
