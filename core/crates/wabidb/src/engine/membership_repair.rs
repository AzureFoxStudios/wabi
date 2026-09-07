//! One-time repair of snapshots made before channel_member_removed was handled.
//! The old dispatcher retained the last unhandled removal in the `events`
//! fallback index. Use that marker, not a new postcard/schema field. Replay
//! validates and orders the relevant historical records before we repair rows.

use std::collections::{HashMap, HashSet};

use crate::{
    engine::locks::ProjectionState,
    error::{Result, WabiError},
    projections::{
        channel_members::{decode_record, encode_key},
        handler::DurableEvent,
    },
};

const MARKER: &[u8] = b"channel_member_removed";

pub(super) struct MembershipRepair {
    stream_hashes: HashSet<[u8; 16]>,
    seen_streams: HashSet<[u8; 16]>,
    removed: HashMap<Vec<u8>, bool>,
}

fn stream_hash(id: &str) -> [u8; 16] {
    blake3::hash(id.as_bytes()).as_bytes()[..16]
        .try_into()
        .unwrap()
}

impl MembershipRepair {
    pub(super) fn from_snapshot(state: &ProjectionState) -> Result<Option<Self>> {
        let Some(marker) = state.get("events", MARKER) else {
            return Ok(None);
        };
        let mut records = vec![decode_record(&marker)];
        state.for_each("channel_members", |_, value| {
            records.push(decode_record(value))
        });
        let mut stream_hashes = HashSet::new();
        for record in records {
            stream_hashes.insert(stream_hash(&format!(
                "channel_members:{}",
                record?.channel_id
            )));
        }
        Ok(Some(Self {
            stream_hashes,
            seen_streams: HashSet::new(),
            removed: HashMap::new(),
        }))
    }

    pub(super) fn includes(&self, hash: &[u8; 16]) -> bool {
        self.stream_hashes.contains(hash)
    }

    pub(super) fn observe(&mut self, event: &DurableEvent) -> Result<()> {
        if event.event_type == "channel_members_changed" {
            let change =
                crate::projections::channel_members::ChannelMembersChanged::decode(&event.payload)?;
            if event.stream_id != format!("channel_members:{}", change.channel_id) {
                return Err(WabiError::Corrupt {
                    location: "channel membership snapshot repair".into(),
                    detail: "membership batch does not match its stream".into(),
                });
            }
            self.seen_streams.insert(stream_hash(&event.stream_id));
            for record in change.upserts {
                self.removed
                    .insert(encode_key(&change.channel_id, record.user_id), false);
            }
            for id in change.removals {
                self.removed
                    .insert(encode_key(&change.channel_id, id), true);
            }
            return Ok(());
        }
        let removed = match event.event_type.as_str() {
            "channel_member_added" => false,
            "channel_member_removed" => true,
            _ => {
                return Err(WabiError::Corrupt {
                    location: "channel membership snapshot repair".into(),
                    detail: "unexpected event in membership stream".into(),
                })
            }
        };
        let record = decode_record(&event.payload)?;
        if event.stream_id != format!("channel_members:{}", record.channel_id) {
            return Err(WabiError::Corrupt {
                location: "channel membership snapshot repair".into(),
                detail: "membership payload does not match its stream".into(),
            });
        }
        self.seen_streams.insert(stream_hash(&event.stream_id));
        self.removed
            .insert(encode_key(&record.channel_id, record.user_id), removed);
        Ok(())
    }

    pub(super) fn finish(self, state: &ProjectionState) -> Result<()> {
        if self.seen_streams != self.stream_hashes {
            return Err(WabiError::Corrupt {
                location: "channel membership snapshot repair".into(),
                detail: "membership history missing; repair required before startup".into(),
            });
        }
        let mut count = 0;
        for (key, removed) in self.removed {
            if removed && state.remove("channel_members", &key) {
                count += 1;
            }
        }
        // Never reinsert old adds: a later user_deleted cascade may have
        // legitimately removed that row. Unrelated snapshot indexes stay intact.
        state.remove("events", MARKER);
        tracing::info!(
            removed_memberships = count,
            "repaired legacy channel membership snapshot"
        );
        Ok(())
    }
}
