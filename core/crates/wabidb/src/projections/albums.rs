use crate::engine::locks::ProjectionState;
use crate::error::Result;
use crate::projections::codec::RecordCodec;
use crate::projections::handler::{DurableEvent, Projection};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const ID_INDEX: &str = "album_by_id";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AlbumRecord {
    pub album_id: String,
    pub scope_type: String,
    pub scope_id: String,
    pub name: String,
    pub description: String,
    pub owner_user_id: u64,
    pub cover_url: String,
    pub created_at_micros: i64,
    pub updated_at_micros: i64,
    pub is_deleted: bool,
}

impl RecordCodec for AlbumRecord {
    fn codec_name() -> &'static str {
        "albums"
    }
}

pub fn encode_record(r: &AlbumRecord) -> Vec<u8> {
    postcard::to_allocvec(r).expect("postcard serialization failed")
}

pub fn decode_record(buf: &[u8]) -> Result<AlbumRecord> {
    postcard::from_bytes(buf).map_err(|e| crate::error::WabiError::Corrupt {
        location: "album projection".into(),
        detail: format!("postcard decode failed: {e}"),
    })
}

pub fn encode_key(scope_type: &str, scope_id: &str, album_id: &str) -> Vec<u8> {
    let mut buf = Vec::new();
    buf.extend_from_slice(&(scope_type.len() as u64).to_le_bytes());
    buf.extend_from_slice(scope_type.as_bytes());
    buf.extend_from_slice(&(scope_id.len() as u64).to_le_bytes());
    buf.extend_from_slice(scope_id.as_bytes());
    buf.extend_from_slice(&(album_id.len() as u64).to_le_bytes());
    buf.extend_from_slice(album_id.as_bytes());
    buf
}

impl AlbumProjection {
    /// Resolve a sequence-assigned album ID without scanning every scope.
    /// Older snapshots predate `album_by_id`; their rows are rebuilt at open.
    pub fn get_album_by_id(state: &ProjectionState, album_id: &str) -> Result<Option<AlbumRecord>> {
        if let Some(key) = state.get(ID_INDEX, album_id.as_bytes()) {
            let bytes = state.get("albums", &key).ok_or_else(|| crate::error::WabiError::Corrupt {
                location: ID_INDEX.into(),
                detail: format!("album {album_id} points to a missing row"),
            })?;
            let record = decode_record(&bytes)?;
            if record.album_id != album_id || encode_key(&record.scope_type, &record.scope_id, album_id) != key {
                return Err(crate::error::WabiError::Corrupt {
                    location: ID_INDEX.into(),
                    detail: format!("album {album_id} lookup does not match its row"),
                });
            }
            return Ok(Some(record));
        }
        if state.index_len(ID_INDEX) == state.index_len("albums") {
            return Ok(None);
        }
        // An old in-memory/snapshot state may lack this derived index. The
        // engine backfills it before serving requests; keep a read-only
        // fallback for callers constructing ProjectionState directly.
        let mut found = None;
        let mut error = None;
        state.for_each("albums", |_key, value| match decode_record(value) {
            Ok(record) if record.album_id == album_id => {
                if found.replace(record).is_some() {
                    error = Some(crate::error::WabiError::Corrupt {
                        location: "albums".into(),
                        detail: format!("duplicate album ID {album_id}"),
                    });
                }
            }
            Ok(_) => {}
            Err(failure) => error = Some(failure),
        });
        if let Some(error) = error {
            return Err(error);
        }
        Ok(found)
    }

    /// Add the derived lookup to snapshots written before this index existed.
    /// Call only before the dispatcher starts; this does not alter durable
    /// album records or the applied commit watermark.
    pub fn rebuild_id_index(state: &ProjectionState) -> Result<usize> {
        let album_count = state.index_len("albums");
        if album_count == state.index_len(ID_INDEX) {
            return Ok(0);
        }
        let mut rows = Vec::with_capacity(album_count);
        let mut error = None;
        state.for_each("albums", |key, value| match decode_record(value) {
            Ok(record) => {
                if key != encode_key(&record.scope_type, &record.scope_id, &record.album_id) {
                    error = Some(crate::error::WabiError::Corrupt {
                        location: "albums".into(),
                        detail: format!("album {} has a mismatched scope key", record.album_id),
                    });
                }
                rows.push((record.album_id, key.to_vec()));
            }
            Err(failure) => error = Some(failure),
        });
        if let Some(error) = error {
            return Err(error);
        }
        let mut seen = HashMap::with_capacity(rows.len());
        for (album_id, key) in &rows {
            if let Some(previous) = seen.insert(album_id, key) {
                if previous != key {
                    return Err(crate::error::WabiError::Corrupt {
                        location: "albums".into(),
                        detail: format!("duplicate album ID {album_id}"),
                    });
                }
            }
            if let Some(existing) = state.get(ID_INDEX, album_id.as_bytes()) {
                if existing != *key {
                    return Err(crate::error::WabiError::Corrupt {
                        location: ID_INDEX.into(),
                        detail: format!("album {album_id} lookup conflicts with its row"),
                    });
                }
            }
        }
        let mut inserted = 0;
        for (album_id, key) in rows {
            if state.get(ID_INDEX, album_id.as_bytes()).is_none() {
                state.insert(ID_INDEX, album_id.into_bytes(), key, state.applied_commit_seq());
                inserted += 1;
            }
        }
        if state.index_len(ID_INDEX) != album_count {
            return Err(crate::error::WabiError::Corrupt {
                location: ID_INDEX.into(),
                detail: "album ID index does not cover the album rows".into(),
            });
        }
        Ok(inserted)
    }

    /// Look up a single album by its scope and ID.
    pub fn get_album(state: &ProjectionState, scope_type: &str, scope_id: &str, album_id: &str) -> Result<Option<AlbumRecord>> {
        let key = encode_key(scope_type, scope_id, album_id);
        match state.get("albums", &key) {
            None => Ok(None),
            Some(bytes) => decode_record(&bytes).map(Some),
        }
    }

    /// List albums within a scope. When `include_deleted` is false (the
    /// common case), soft-deleted records are filtered out.
    pub fn list_albums(state: &ProjectionState, scope_type: &str, scope_id: &str, include_deleted: bool) -> Result<Vec<AlbumRecord>> {
        let mut prefix = Vec::new();
        prefix.extend_from_slice(&(scope_type.len() as u64).to_le_bytes());
        prefix.extend_from_slice(scope_type.as_bytes());
        prefix.extend_from_slice(&(scope_id.len() as u64).to_le_bytes());
        prefix.extend_from_slice(scope_id.as_bytes());
        let mut results = Vec::new();
        state.prefix_scan("albums", &prefix, |_key, value| {
            if let Ok(record) = decode_record(value) {
                if include_deleted || !record.is_deleted {
                    results.push(record);
                }
            }
        });
        Ok(results)
    }

    /// Remove all soft-deleted records from the `albums` index.
    pub fn compact(state: &ProjectionState) -> usize {
        let mut deleted_ids = Vec::new();
        state.for_each("albums", |_key, value| {
            if let Ok(record) = decode_record(value) {
                if record.is_deleted {
                    deleted_ids.push(record.album_id);
                }
            }
        });
        let removed = state.compact_index("albums", |_key, value| {
            postcard::from_bytes::<AlbumRecord>(value)
                .ok()
                .map_or(false, |r| r.is_deleted)
        });
        for id in deleted_ids {
            state.remove(ID_INDEX, id.as_bytes());
        }
        removed
    }
}

pub struct AlbumProjection;

impl Projection for AlbumProjection {
    fn event_type(&self) -> &str {
        "album_created"
    }

    fn event_types(&self) -> Vec<&str> {
        vec!["album_created", "album_updated", "album_deleted"]
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        match event.event_type.as_str() {
            "album_created" => self.apply_created(event, state),
            "album_updated" => self.apply_updated(event, state),
            "album_deleted" => self.apply_deleted(event, state),
            _ => Ok(()),
        }
    }
}

impl AlbumProjection {
    fn write_record(state: &ProjectionState, record: &AlbumRecord, commit_seq: u64) -> Result<()> {
        let key = encode_key(&record.scope_type, &record.scope_id, &record.album_id);
        if let Some(existing) = state.get(ID_INDEX, record.album_id.as_bytes()) {
            if existing != key {
                return Err(crate::error::WabiError::Corrupt {
                    location: ID_INDEX.into(),
                    detail: format!("album {} changed scope or reused an ID", record.album_id),
                });
            }
        }
        state.insert("albums", key.clone(), encode_record(record), commit_seq);
        state.insert(ID_INDEX, record.album_id.as_bytes().to_vec(), key, commit_seq);
        Ok(())
    }

    fn apply_created(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let mut record: AlbumRecord = decode_record(&event.payload)?;
        record.album_id = format!("alb_{:x}", event.commit_seq);
        Self::write_record(state, &record, event.commit_seq)
    }

    fn apply_updated(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let record: AlbumRecord = decode_record(&event.payload)?;
        Self::write_record(state, &record, event.commit_seq)
    }

    fn apply_deleted(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let record: AlbumRecord = decode_record(&event.payload)?;
        Self::write_record(state, &record, event.commit_seq)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::projections::handler::DispatchTable;
    use std::sync::Arc;

    fn sample_album() -> AlbumRecord {
        AlbumRecord {
            album_id: String::new(),
            scope_type: "channel".into(),
            scope_id: "ch_01".into(),
            name: "Trip Photos".into(),
            description: "Photos from our trip".into(),
            owner_user_id: 42,
            cover_url: "https://cdn.example.com/cover.jpg".into(),
            created_at_micros: 1_000_000,
            updated_at_micros: 1_000_000,
            is_deleted: false,
        }
    }

    fn make_event(seq: u64, event_type: &str, record: &AlbumRecord) -> DurableEvent {
        DurableEvent {
            commit_seq: seq,
            stream_id: record.scope_id.clone(),
            event_type: event_type.to_string(),
            payload: encode_record(record),
        }
    }

    #[test]
    fn encode_decode_roundtrip() {
        let r = sample_album();
        let buf = encode_record(&r);
        let decoded = decode_record(&buf).unwrap();
        assert_eq!(r, decoded);
    }

    #[test]
    fn event_type_returns_correct() {
        let proj = AlbumProjection;
        assert_eq!(proj.event_type(), "album_created");
        assert!(proj.event_types().contains(&"album_updated"));
        assert!(proj.event_types().contains(&"album_deleted"));
    }

    #[test]
    fn insert_and_lookup() {
        let state = ProjectionState::new();
        let proj = AlbumProjection;
        let r = sample_album();
        let event = make_event(1, "album_created", &r);
        proj.apply(&event, &state).unwrap();
        let expected_id = format!("alb_{:x}", event.commit_seq);
        let key = encode_key("channel", "ch_01", &expected_id);
        let stored = state.get("albums", &key).unwrap();
        let decoded = decode_record(&stored).unwrap();
        assert_eq!(decoded.album_id, expected_id);
        assert_eq!(decoded.name, "Trip Photos");
        assert_eq!(state.get(ID_INDEX, expected_id.as_bytes()), Some(key));
        assert_eq!(AlbumProjection::get_album_by_id(&state, &expected_id).unwrap(), Some(decoded));
    }

    #[test]
    fn dispatch_table_routes_album_events() {
        let table = DispatchTable::new(vec![Arc::new(AlbumProjection)]).unwrap();
        let state = ProjectionState::new();
        let r = sample_album();
        let event = make_event(1, "album_created", &r);
        let handler = table.get("album_created").unwrap();
        handler.apply(&event, &state).unwrap();
        let expected_id = format!("alb_{:x}", event.commit_seq);
        let key = encode_key("channel", "ch_01", &expected_id);
        assert!(state.get("albums", &key).is_some());
    }

    #[test]
    fn updated_overwrites_record() {
        let state = ProjectionState::new();
        let proj = AlbumProjection;
        let r = sample_album();
        let event = make_event(1, "album_created", &r);
        proj.apply(&event, &state).unwrap();
        let expected_id = format!("alb_{:x}", event.commit_seq);
        let key = encode_key("channel", "ch_01", &expected_id);
        let stored = state.get("albums", &key).unwrap();
        let mut stored_record = decode_record(&stored).unwrap();
        stored_record.name = "Updated Name".into();
        let update_event = DurableEvent {
            commit_seq: 2,
            stream_id: "ch_01".into(),
            event_type: "album_updated".into(),
            payload: encode_record(&stored_record),
        };
        proj.apply(&update_event, &state).unwrap();
        let decoded = decode_record(&state.get("albums", &key).unwrap()).unwrap();
        assert_eq!(decoded.name, "Updated Name");
    }

    #[test]
    fn delete_marks_record() {
        let state = ProjectionState::new();
        let proj = AlbumProjection;
        let r = sample_album();
        let event = make_event(1, "album_created", &r);
        proj.apply(&event, &state).unwrap();
        let expected_id = format!("alb_{:x}", event.commit_seq);
        let key = encode_key("channel", "ch_01", &expected_id);
        let stored = state.get("albums", &key).unwrap();
        let mut stored_record = decode_record(&stored).unwrap();
        stored_record.is_deleted = true;
        let delete_event = DurableEvent {
            commit_seq: 2,
            stream_id: "ch_01".into(),
            event_type: "album_deleted".into(),
            payload: encode_record(&stored_record),
        };
        proj.apply(&delete_event, &state).unwrap();
        let decoded = decode_record(&state.get("albums", &key).unwrap()).unwrap();
        assert!(decoded.is_deleted);
    }

    #[test]
    fn typed_get_album_after_insert() {
        let state = ProjectionState::new();
        let proj = AlbumProjection;
        let r = sample_album();
        let event = make_event(1, "album_created", &r);
        proj.apply(&event, &state).unwrap();
        let expected_id = format!("alb_{:x}", event.commit_seq);
        let loaded = AlbumProjection::get_album(&state, "channel", "ch_01", &expected_id).unwrap().unwrap();
        assert_eq!(loaded.album_id, expected_id);
    }

    #[test]
    fn typed_list_albums_in_scope() {
        let state = ProjectionState::new();
        let proj = AlbumProjection;
        for seq in 1..=3 {
            let r = AlbumRecord {
                album_id: String::new(),
                scope_type: "channel".into(),
                scope_id: "ch_01".into(),
                name: format!("Album {seq}"),
                description: String::new(),
                owner_user_id: seq,
                cover_url: String::new(),
                created_at_micros: seq as i64 * 1_000_000,
                updated_at_micros: seq as i64 * 1_000_000,
                is_deleted: false,
            };
            proj.apply(&make_event(seq, "album_created", &r), &state).unwrap();
        }
        let albums = AlbumProjection::list_albums(&state, "channel", "ch_01", false).unwrap();
        assert_eq!(albums.len(), 3);
    }

    #[test]
    fn list_albums_filters_deleted() {
        let state = ProjectionState::new();
        let proj = AlbumProjection;
        for seq in 1..=3 {
            let r = AlbumRecord {
                album_id: String::new(),
                scope_type: "channel".into(),
                scope_id: "ch_01".into(),
                name: format!("Album {seq}"),
                description: String::new(),
                owner_user_id: seq,
                cover_url: String::new(),
                created_at_micros: seq as i64 * 1_000_000,
                updated_at_micros: seq as i64 * 1_000_000,
                is_deleted: false,
            };
            proj.apply(&make_event(seq, "album_created", &r), &state).unwrap();
        }
        let key = encode_key("channel", "ch_01", &format!("alb_{:x}", 2));
        let stored = state.get("albums", &key).unwrap();
        let mut deleted = decode_record(&stored).unwrap();
        deleted.is_deleted = true;
        proj.apply(&make_event(4, "album_deleted", &deleted), &state).unwrap();

        let all = AlbumProjection::list_albums(&state, "channel", "ch_01", false).unwrap();
        assert_eq!(all.len(), 2);
        assert!(all.iter().all(|a| !a.is_deleted));

        let with_deleted = AlbumProjection::list_albums(&state, "channel", "ch_01", true).unwrap();
        assert_eq!(with_deleted.len(), 3);
        assert!(with_deleted.iter().any(|a| a.is_deleted));
    }

    #[test]
    fn compact_removes_deleted_albums() {
        let state = ProjectionState::new();
        let proj = AlbumProjection;
        for seq in 1..=3 {
            let r = AlbumRecord {
                album_id: String::new(),
                scope_type: "channel".into(),
                scope_id: "ch_01".into(),
                name: format!("Album {seq}"),
                description: String::new(),
                owner_user_id: seq,
                cover_url: String::new(),
                created_at_micros: seq as i64 * 1_000_000,
                updated_at_micros: seq as i64 * 1_000_000,
                is_deleted: false,
            };
            proj.apply(&make_event(seq, "album_created", &r), &state).unwrap();
        }
        let key = encode_key("channel", "ch_01", &format!("alb_{:x}", 2));
        let stored = state.get("albums", &key).unwrap();
        let mut deleted = decode_record(&stored).unwrap();
        deleted.is_deleted = true;
        proj.apply(&make_event(4, "album_deleted", &deleted), &state).unwrap();

        assert_eq!(AlbumProjection::list_albums(&state, "channel", "ch_01", true).unwrap().len(), 3);
        let removed = AlbumProjection::compact(&state);
        assert_eq!(removed, 1);
        assert_eq!(AlbumProjection::list_albums(&state, "channel", "ch_01", true).unwrap().len(), 2);
        assert!(state.get(ID_INDEX, b"alb_2").is_none());
    }

    #[test]
    fn different_scopes_are_independent() {
        let state = ProjectionState::new();
        let proj = AlbumProjection;
        for (seq, scope) in [(1, "ch_01"), (2, "ch_02")] {
            let r = AlbumRecord {
                album_id: String::new(),
                scope_type: "channel".into(),
                scope_id: scope.into(),
                name: format!("Album for {scope}"),
                description: String::new(),
                owner_user_id: 1,
                cover_url: String::new(),
                created_at_micros: 1_000_000,
                updated_at_micros: 1_000_000,
                is_deleted: false,
            };
            proj.apply(&make_event(seq, "album_created", &r), &state).unwrap();
        }
        assert_eq!(AlbumProjection::list_albums(&state, "channel", "ch_01", false).unwrap().len(), 1);
        assert_eq!(AlbumProjection::list_albums(&state, "channel", "ch_02", false).unwrap().len(), 1);
    }

    #[test]
    fn old_snapshot_rebuilds_album_id_lookup_without_changing_records() {
        let temp = tempfile::tempdir().unwrap();
        let state = ProjectionState::new();
        let mut record = sample_album();
        record.album_id = "alb_9".into();
        let key = encode_key(&record.scope_type, &record.scope_id, &record.album_id);
        state.insert("albums", key.clone(), encode_record(&record), 9);
        state.set_applied_commit_seq(9);
        state.save_snapshot(temp.path()).unwrap();

        let (restored, watermark) = ProjectionState::load_snapshot(temp.path()).unwrap().unwrap();
        assert_eq!(watermark, 9);
        assert_eq!(restored.index_len(ID_INDEX), 0);
        assert_eq!(AlbumProjection::rebuild_id_index(&restored).unwrap(), 1);
        assert_eq!(AlbumProjection::get_album_by_id(&restored, "alb_9").unwrap(), Some(record.clone()));
        restored.save_snapshot(temp.path()).unwrap();

        let (reopened, watermark) = ProjectionState::load_snapshot(temp.path()).unwrap().unwrap();
        assert_eq!(watermark, 9);
        assert_eq!(reopened.get(ID_INDEX, b"alb_9"), Some(key));
        assert_eq!(AlbumProjection::get_album_by_id(&reopened, "alb_9").unwrap(), Some(record));
        assert_eq!(AlbumProjection::rebuild_id_index(&reopened).unwrap(), 0);
    }

    #[test]
    fn bad_payload_returns_error() {
        let state = ProjectionState::new();
        let event = DurableEvent {
            commit_seq: 1,
            stream_id: "ch_01".into(),
            event_type: "album_created".into(),
            payload: vec![0xde, 0xad],
        };
        let result = AlbumProjection.apply(&event, &state);
        assert!(result.is_err());
    }
}
