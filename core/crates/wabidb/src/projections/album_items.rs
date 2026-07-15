use crate::engine::locks::ProjectionState;
use crate::error::Result;
use crate::projections::codec::RecordCodec;
use crate::projections::handler::{DurableEvent, Projection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AlbumItemRecord {
    pub item_id: String,
    pub album_id: String,
    pub url: String,
    pub name: String,
    pub size: Option<i64>,
    pub mime: Option<String>,
    pub caption: Option<String>,
    pub sort_order: i64,
    pub created_at_micros: i64,
    pub is_deleted: bool,
}

impl RecordCodec for AlbumItemRecord {
    fn codec_name() -> &'static str {
        "album_items"
    }
}

pub fn encode_record(r: &AlbumItemRecord) -> Vec<u8> {
    postcard::to_allocvec(r).expect("postcard serialization failed")
}

pub fn decode_record(buf: &[u8]) -> Result<AlbumItemRecord> {
    postcard::from_bytes(buf).map_err(|e| crate::error::WabiError::Corrupt {
        location: "album_item projection".into(),
        detail: format!("postcard decode failed: {e}"),
    })
}

pub fn encode_key(album_id: &str, item_id: &str) -> Vec<u8> {
    let mut buf = Vec::new();
    buf.extend_from_slice(&(album_id.len() as u64).to_le_bytes());
    buf.extend_from_slice(album_id.as_bytes());
    buf.extend_from_slice(&(item_id.len() as u64).to_le_bytes());
    buf.extend_from_slice(item_id.as_bytes());
    buf
}

impl AlbumItemsProjection {
    /// Look up a single album item by its ID.
    pub fn get_item(state: &ProjectionState, album_id: &str, item_id: &str) -> Result<Option<AlbumItemRecord>> {
        let key = encode_key(album_id, item_id);
        match state.get("album_items", &key) {
            None => Ok(None),
            Some(bytes) => decode_record(&bytes).map(Some),
        }
    }

    /// List items in an album, ordered by sort_order. When `include_deleted`
    /// is false (the common case), soft-deleted records are filtered out.
    pub fn list_items(state: &ProjectionState, album_id: &str, include_deleted: bool) -> Result<Vec<AlbumItemRecord>> {
        let mut prefix = Vec::new();
        prefix.extend_from_slice(&(album_id.len() as u64).to_le_bytes());
        prefix.extend_from_slice(album_id.as_bytes());
        let mut results = Vec::new();
        state.prefix_scan("album_items", &prefix, |_key, value| {
            if let Ok(record) = decode_record(value) {
                if include_deleted || !record.is_deleted {
                    results.push(record);
                }
            }
        });
        results.sort_by_key(|r| r.sort_order);
        Ok(results)
    }

    /// Remove all soft-deleted records from the `album_items` index.
    pub fn compact(state: &ProjectionState) -> usize {
        state.compact_index("album_items", |_key, value| {
            postcard::from_bytes::<AlbumItemRecord>(value)
                .ok()
                .map_or(false, |r| r.is_deleted)
        })
    }
}

pub struct AlbumItemsProjection;

impl Projection for AlbumItemsProjection {
    fn event_type(&self) -> &str {
        "album_item_added"
    }

    fn event_types(&self) -> Vec<&str> {
        vec!["album_item_added", "album_item_updated", "album_item_removed"]
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        match event.event_type.as_str() {
            "album_item_added" => self.apply_added(event, state),
            "album_item_updated" => self.apply_updated(event, state),
            "album_item_removed" => self.apply_removed(event, state),
            _ => Ok(()),
        }
    }
}

impl AlbumItemsProjection {
    fn apply_added(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let mut record: AlbumItemRecord = decode_record(&event.payload)?;
        record.item_id = format!("item_{:x}", event.commit_seq);
        let key = encode_key(&record.album_id, &record.item_id);
        let value = encode_record(&record);
        state.insert("album_items", key, value, event.commit_seq);
        Ok(())
    }

    fn apply_updated(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let record: AlbumItemRecord = decode_record(&event.payload)?;
        let key = encode_key(&record.album_id, &record.item_id);
        let value = encode_record(&record);
        state.insert("album_items", key, value, event.commit_seq);
        Ok(())
    }

    fn apply_removed(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let record: AlbumItemRecord = decode_record(&event.payload)?;
        let key = encode_key(&record.album_id, &record.item_id);
        let value = encode_record(&record);
        state.insert("album_items", key, value, event.commit_seq);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::projections::handler::DispatchTable;
    use std::sync::Arc;

    fn sample_item() -> AlbumItemRecord {
        AlbumItemRecord {
            item_id: String::new(),
            album_id: "alb_01".into(),
            url: "https://cdn.example.com/photo.jpg".into(),
            name: "Sunset".into(),
            size: Some(1024000),
            mime: Some("image/jpeg".into()),
            caption: Some("Beautiful sunset".into()),
            sort_order: 0,
            created_at_micros: 1_000_000,
            is_deleted: false,
        }
    }

    fn make_event(seq: u64, event_type: &str, record: &AlbumItemRecord) -> DurableEvent {
        DurableEvent {
            commit_seq: seq,
            stream_id: record.album_id.clone(),
            event_type: event_type.to_string(),
            payload: encode_record(record),
        }
    }

    #[test]
    fn encode_decode_roundtrip() {
        let r = sample_item();
        let buf = encode_record(&r);
        let decoded = decode_record(&buf).unwrap();
        assert_eq!(r, decoded);
    }

    #[test]
    fn event_type_returns_correct() {
        let proj = AlbumItemsProjection;
        assert_eq!(proj.event_type(), "album_item_added");
        assert!(proj.event_types().contains(&"album_item_updated"));
        assert!(proj.event_types().contains(&"album_item_removed"));
    }

    #[test]
    fn insert_and_lookup() {
        let state = ProjectionState::new();
        let proj = AlbumItemsProjection;
        let r = sample_item();
        let event = make_event(1, "album_item_added", &r);
        proj.apply(&event, &state).unwrap();
        let expected_id = format!("item_{:x}", event.commit_seq);
        let key = encode_key("alb_01", &expected_id);
        let stored = state.get("album_items", &key).unwrap();
        let decoded = decode_record(&stored).unwrap();
        assert_eq!(decoded.item_id, expected_id);
        assert_eq!(decoded.name, "Sunset");
    }

    #[test]
    fn dispatch_table_routes_item_events() {
        let table = DispatchTable::new(vec![Arc::new(AlbumItemsProjection)]).unwrap();
        let state = ProjectionState::new();
        let r = sample_item();
        let event = make_event(1, "album_item_added", &r);
        let handler = table.get("album_item_added").unwrap();
        handler.apply(&event, &state).unwrap();
        let expected_id = format!("item_{:x}", event.commit_seq);
        let key = encode_key("alb_01", &expected_id);
        assert!(state.get("album_items", &key).is_some());
    }

    #[test]
    fn updated_overwrites_record() {
        let state = ProjectionState::new();
        let proj = AlbumItemsProjection;
        let r = sample_item();
        let event = make_event(1, "album_item_added", &r);
        proj.apply(&event, &state).unwrap();
        let expected_id = format!("item_{:x}", event.commit_seq);
        let key = encode_key("alb_01", &expected_id);
        let stored = state.get("album_items", &key).unwrap();
        let mut stored_record = decode_record(&stored).unwrap();
        stored_record.caption = Some("Updated caption".into());
        let update_event = DurableEvent {
            commit_seq: 2,
            stream_id: "alb_01".into(),
            event_type: "album_item_updated".into(),
            payload: encode_record(&stored_record),
        };
        proj.apply(&update_event, &state).unwrap();
        let decoded = decode_record(&state.get("album_items", &key).unwrap()).unwrap();
        assert_eq!(decoded.caption, Some("Updated caption".into()));
    }

    #[test]
    fn remove_marks_deleted() {
        let state = ProjectionState::new();
        let proj = AlbumItemsProjection;
        let r = sample_item();
        let event = make_event(1, "album_item_added", &r);
        proj.apply(&event, &state).unwrap();
        let expected_id = format!("item_{:x}", event.commit_seq);
        let key = encode_key("alb_01", &expected_id);
        let stored = state.get("album_items", &key).unwrap();
        let mut stored_record = decode_record(&stored).unwrap();
        stored_record.is_deleted = true;
        let remove_event = DurableEvent {
            commit_seq: 2,
            stream_id: "alb_01".into(),
            event_type: "album_item_removed".into(),
            payload: encode_record(&stored_record),
        };
        proj.apply(&remove_event, &state).unwrap();
        let decoded = decode_record(&state.get("album_items", &key).unwrap()).unwrap();
        assert!(decoded.is_deleted);
    }

    #[test]
    fn typed_get_item_after_insert() {
        let state = ProjectionState::new();
        let proj = AlbumItemsProjection;
        let r = sample_item();
        let event = make_event(1, "album_item_added", &r);
        proj.apply(&event, &state).unwrap();
        let expected_id = format!("item_{:x}", event.commit_seq);
        let loaded = AlbumItemsProjection::get_item(&state, "alb_01", &expected_id).unwrap().unwrap();
        assert_eq!(loaded.item_id, expected_id);
    }

    #[test]
    fn typed_list_items_in_album() {
        let state = ProjectionState::new();
        let proj = AlbumItemsProjection;
        for seq in 1..=3 {
            let r = AlbumItemRecord {
                item_id: String::new(),
                album_id: "alb_01".into(),
                url: format!("https://cdn.example.com/photo_{seq}.jpg"),
                name: format!("Photo {seq}"),
                size: Some(seq * 1000),
                mime: Some("image/jpeg".into()),
                caption: None,
                sort_order: seq as i64,
                created_at_micros: seq as i64 * 1_000_000,
                is_deleted: false,
            };
            proj.apply(&make_event(seq as u64, "album_item_added", &r), &state).unwrap();
        }
        let items = AlbumItemsProjection::list_items(&state, "alb_01", false).unwrap();
        assert_eq!(items.len(), 3);
    }

    #[test]
    fn list_items_filters_deleted() {
        let state = ProjectionState::new();
        let proj = AlbumItemsProjection;
        for seq in 1..=3 {
            let r = AlbumItemRecord {
                item_id: String::new(),
                album_id: "alb_01".into(),
                url: format!("https://cdn.example.com/photo_{seq}.jpg"),
                name: format!("Photo {seq}"),
                size: Some(seq * 1000),
                mime: Some("image/jpeg".into()),
                caption: None,
                sort_order: seq as i64,
                created_at_micros: seq as i64 * 1_000_000,
                is_deleted: false,
            };
            proj.apply(&make_event(seq as u64, "album_item_added", &r), &state).unwrap();
        }
        let key = encode_key("alb_01", &format!("item_{:x}", 2));
        let stored = state.get("album_items", &key).unwrap();
        let mut deleted = decode_record(&stored).unwrap();
        deleted.is_deleted = true;
        proj.apply(&make_event(4, "album_item_removed", &deleted), &state).unwrap();

        let all = AlbumItemsProjection::list_items(&state, "alb_01", false).unwrap();
        assert_eq!(all.len(), 2);
        assert!(all.iter().all(|i| !i.is_deleted));

        let with_deleted = AlbumItemsProjection::list_items(&state, "alb_01", true).unwrap();
        assert_eq!(with_deleted.len(), 3);
        assert!(with_deleted.iter().any(|i| i.is_deleted));
    }

    #[test]
    fn compact_removes_deleted_items() {
        let state = ProjectionState::new();
        let proj = AlbumItemsProjection;
        for seq in 1..=3 {
            let r = AlbumItemRecord {
                item_id: String::new(),
                album_id: "alb_01".into(),
                url: format!("https://cdn.example.com/photo_{seq}.jpg"),
                name: format!("Photo {seq}"),
                size: Some(seq * 1000),
                mime: Some("image/jpeg".into()),
                caption: None,
                sort_order: seq as i64,
                created_at_micros: seq as i64 * 1_000_000,
                is_deleted: false,
            };
            proj.apply(&make_event(seq as u64, "album_item_added", &r), &state).unwrap();
        }
        let key = encode_key("alb_01", &format!("item_{:x}", 2));
        let stored = state.get("album_items", &key).unwrap();
        let mut deleted = decode_record(&stored).unwrap();
        deleted.is_deleted = true;
        proj.apply(&make_event(4, "album_item_removed", &deleted), &state).unwrap();

        assert_eq!(AlbumItemsProjection::list_items(&state, "alb_01", true).unwrap().len(), 3);
        let removed = AlbumItemsProjection::compact(&state);
        assert_eq!(removed, 1);
        assert_eq!(AlbumItemsProjection::list_items(&state, "alb_01", true).unwrap().len(), 2);
    }

    #[test]
    fn items_are_sorted_by_sort_order() {
        let state = ProjectionState::new();
        let proj = AlbumItemsProjection;
        for seq in [3u64, 1, 2] {
            let r = AlbumItemRecord {
                item_id: String::new(),
                album_id: "alb_01".into(),
                url: String::new(),
                name: format!("Item {seq}"),
                size: None,
                mime: None,
                caption: None,
                sort_order: seq as i64,
                created_at_micros: seq as i64 * 1_000_000,
                is_deleted: false,
            };
            proj.apply(&make_event(seq, "album_item_added", &r), &state).unwrap();
        }
        let items = AlbumItemsProjection::list_items(&state, "alb_01", false).unwrap();
        assert_eq!(items[0].sort_order, 1);
        assert_eq!(items[1].sort_order, 2);
        assert_eq!(items[2].sort_order, 3);
    }

    #[test]
    fn bad_payload_returns_error() {
        let state = ProjectionState::new();
        let event = DurableEvent {
            commit_seq: 1,
            stream_id: "alb_01".into(),
            event_type: "album_item_added".into(),
            payload: vec![0xde, 0xad],
        };
        let result = AlbumItemsProjection.apply(&event, &state);
        assert!(result.is_err());
    }
}
