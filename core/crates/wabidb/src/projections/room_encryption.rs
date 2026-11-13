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
}

impl RoomEncryptionRecord {
    fn valid(&self) -> bool {
        !self.channel_id.is_empty()
            && self.channel_id.len() <= MAX_CHANNEL_ID
            && match self.mode {
                RoomEncryptionMode::Enabled => self.epoch >= 1,
                _ => self.epoch == 0,
            }
    }

    /// The record that results from applying `next` on top of `self`.
    /// Never leaves `Enabled`, never lowers an epoch.
    pub fn merged(&self, next: &RoomEncryptionRecord) -> RoomEncryptionRecord {
        match (self.mode, next.mode) {
            (RoomEncryptionMode::Enabled, RoomEncryptionMode::Enabled) => RoomEncryptionRecord {
                epoch: self.epoch.max(next.epoch),
                ..self.clone()
            },
            (RoomEncryptionMode::Enabled, _) => self.clone(),
            _ => next.clone(),
        }
    }
}

fn corrupt(detail: String) -> WabiError {
    WabiError::Corrupt { location: FORMAT.location.into(), detail }
}

pub fn encode_record(record: &RoomEncryptionRecord) -> Vec<u8> {
    versioned::encode_v1(&FORMAT, record)
}

pub fn decode_record(bytes: &[u8]) -> Result<RoomEncryptionRecord> {
    let record: RoomEncryptionRecord = versioned::decode(
        &FORMAT,
        bytes,
        |version, body| (version == 1).then(|| versioned::payload(&FORMAT, body)),
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
        RoomEncryptionRecord { channel_id: "dm_1_2".into(), mode, epoch }
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
    /// markers look like this; never regenerate the literal.
    #[test]
    fn golden_version_1_bytes() {
        let sample = RoomEncryptionRecord {
            channel_id: "group-ü".into(),
            mode: RoomEncryptionMode::Enabled,
            epoch: 300,
        };
        let golden = "ffffffffffffffffffff52454e43010867726f75702dc3bc02ac02";
        assert_eq!(hex::encode(encode_record(&sample)), golden);
        assert_eq!(decode_record(&hex::decode(golden).unwrap()).unwrap(), sample);
        let pending = "ffffffffffffffffffff52454e4301066772616e646d0000";
        let decoded = decode_record(&hex::decode(pending).unwrap()).unwrap();
        assert_eq!(decoded.mode, RoomEncryptionMode::Pending);
        assert_eq!(decoded.channel_id, "grandm");
    }

    #[test]
    fn unversioned_unknown_version_and_invalid_records_are_refused() {
        let bytes = encode_record(&record(RoomEncryptionMode::Pending, 0));
        assert!(decode_record(&bytes[versioned::HEADER_LEN..]).is_err(), "no legacy form");
        let mut v2 = bytes.clone();
        v2[versioned::HEADER_LEN - 1] = 2;
        assert!(decode_record(&v2).is_err());
        for bad in [
            record(RoomEncryptionMode::Enabled, 0),
            record(RoomEncryptionMode::Pending, 3),
            RoomEncryptionRecord { channel_id: String::new(), mode: RoomEncryptionMode::Pending, epoch: 0 },
            RoomEncryptionRecord { channel_id: "x".repeat(257), mode: RoomEncryptionMode::Pending, epoch: 0 },
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
    fn wrong_stream_is_refused() {
        let state = ProjectionState::new();
        let mut e = event(1, &record(RoomEncryptionMode::Pending, 0));
        e.stream_id = "elsewhere".into();
        assert!(RoomEncryptionProjection.apply(&e, &state).is_err());
    }
}
