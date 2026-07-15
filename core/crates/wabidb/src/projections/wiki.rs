use crate::engine::locks::ProjectionState;
use crate::error::Result;
use crate::projections::codec::RecordCodec;
use crate::projections::handler::{DurableEvent, Projection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WikiPageRecord {
    pub page_id: String,
    pub channel_id: String,
    pub title: String,
    pub body: String,
    pub author_user_id: u64,
    pub created_at_micros: i64,
    pub updated_at_micros: i64,
    pub is_deleted: bool,
}

impl RecordCodec for WikiPageRecord {
    fn codec_name() -> &'static str {
        "wiki_pages"
    }
}

pub fn encode_record(r: &WikiPageRecord) -> Vec<u8> {
    postcard::to_allocvec(r).expect("postcard serialization failed")
}

pub fn decode_record(buf: &[u8]) -> Result<WikiPageRecord> {
    postcard::from_bytes(buf).map_err(|e| crate::error::WabiError::Corrupt {
        location: "wiki projection".into(),
        detail: format!("postcard decode failed: {e}"),
    })
}

pub fn encode_key(channel_id: &str, page_id: &str) -> Vec<u8> {
    let mut buf = Vec::new();
    buf.extend_from_slice(&(channel_id.len() as u64).to_le_bytes());
    buf.extend_from_slice(channel_id.as_bytes());
    buf.extend_from_slice(&(page_id.len() as u64).to_le_bytes());
    buf.extend_from_slice(page_id.as_bytes());
    buf
}

impl WikiProjection {
    /// Look up a single wiki page.
    pub fn get_page(state: &ProjectionState, channel_id: &str, page_id: &str) -> Result<Option<WikiPageRecord>> {
        let key = encode_key(channel_id, page_id);
        match state.get("wiki_pages", &key) {
            None => Ok(None),
            Some(bytes) => decode_record(&bytes).map(Some),
        }
    }

    /// List wiki pages in a channel. When `include_deleted` is false (the
    /// common case), soft-deleted records are filtered out.
    pub fn list_pages(state: &ProjectionState, channel_id: &str, include_deleted: bool) -> Result<Vec<WikiPageRecord>> {
        let mut prefix = Vec::new();
        prefix.extend_from_slice(&(channel_id.len() as u64).to_le_bytes());
        prefix.extend_from_slice(channel_id.as_bytes());
        let mut results = Vec::new();
        state.prefix_scan("wiki_pages", &prefix, |_key, value| {
            if let Ok(record) = decode_record(value) {
                if include_deleted || !record.is_deleted {
                    results.push(record);
                }
            }
        });
        Ok(results)
    }

    /// Remove all soft-deleted records from the `wiki_pages` index.
    pub fn compact(state: &ProjectionState) -> usize {
        state.compact_index("wiki_pages", |_key, value| {
            postcard::from_bytes::<WikiPageRecord>(value)
                .ok()
                .map_or(false, |r| r.is_deleted)
        })
    }
}

pub struct WikiProjection;

impl Projection for WikiProjection {
    fn event_type(&self) -> &str {
        "wiki_page_created"
    }

    fn event_types(&self) -> Vec<&str> {
        vec!["wiki_page_created", "wiki_page_edited", "wiki_page_deleted"]
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        match event.event_type.as_str() {
            "wiki_page_created" => self.apply_created(event, state),
            "wiki_page_edited" => self.apply_edited(event, state),
            "wiki_page_deleted" => self.apply_deleted(event, state),
            _ => Ok(()),
        }
    }
}

impl WikiProjection {
    fn apply_created(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let mut record: WikiPageRecord = decode_record(&event.payload)?;
        record.page_id = format!("page_{:x}", event.commit_seq);
        let key = encode_key(&record.channel_id, &record.page_id);
        let value = encode_record(&record);
        state.insert("wiki_pages", key, value, event.commit_seq);
        Ok(())
    }

    fn apply_edited(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let record: WikiPageRecord = decode_record(&event.payload)?;
        let key = encode_key(&record.channel_id, &record.page_id);
        let value = encode_record(&record);
        state.insert("wiki_pages", key, value, event.commit_seq);
        Ok(())
    }

    fn apply_deleted(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let record: WikiPageRecord = decode_record(&event.payload)?;
        let key = encode_key(&record.channel_id, &record.page_id);
        let value = encode_record(&record);
        state.insert("wiki_pages", key, value, event.commit_seq);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::projections::handler::DispatchTable;
    use std::sync::Arc;

    fn sample_page() -> WikiPageRecord {
        WikiPageRecord {
            page_id: String::new(),
            channel_id: "ch_wiki".into(),
            title: "Getting Started".into(),
            body: "Welcome to the wiki!".into(),
            author_user_id: 42,
            created_at_micros: 1_000_000,
            updated_at_micros: 1_000_000,
            is_deleted: false,
        }
    }

    fn make_event(seq: u64, event_type: &str, record: &WikiPageRecord) -> DurableEvent {
        DurableEvent {
            commit_seq: seq,
            stream_id: record.channel_id.clone(),
            event_type: event_type.to_string(),
            payload: encode_record(record),
        }
    }

    #[test]
    fn encode_decode_roundtrip() {
        let r = sample_page();
        let buf = encode_record(&r);
        let decoded = decode_record(&buf).unwrap();
        assert_eq!(r, decoded);
    }

    #[test]
    fn event_type_returns_correct() {
        let proj = WikiProjection;
        assert_eq!(proj.event_type(), "wiki_page_created");
        assert!(proj.event_types().contains(&"wiki_page_edited"));
        assert!(proj.event_types().contains(&"wiki_page_deleted"));
    }

    #[test]
    fn insert_and_lookup() {
        let state = ProjectionState::new();
        let proj = WikiProjection;
        let r = sample_page();
        let event = make_event(1, "wiki_page_created", &r);
        proj.apply(&event, &state).unwrap();
        let expected_id = format!("page_{:x}", event.commit_seq);
        let key = encode_key("ch_wiki", &expected_id);
        let stored = state.get("wiki_pages", &key).unwrap();
        let decoded = decode_record(&stored).unwrap();
        assert_eq!(decoded.page_id, expected_id);
        assert_eq!(decoded.title, "Getting Started");
    }

    #[test]
    fn dispatch_table_routes_wiki_events() {
        let table = DispatchTable::new(vec![Arc::new(WikiProjection)]).unwrap();
        let state = ProjectionState::new();
        let r = sample_page();
        let event = make_event(1, "wiki_page_created", &r);
        let handler = table.get("wiki_page_created").unwrap();
        handler.apply(&event, &state).unwrap();
        let expected_id = format!("page_{:x}", event.commit_seq);
        let key = encode_key("ch_wiki", &expected_id);
        assert!(state.get("wiki_pages", &key).is_some());
    }

    #[test]
    fn edit_overwrites_record() {
        let state = ProjectionState::new();
        let proj = WikiProjection;
        let r = sample_page();
        let event = make_event(1, "wiki_page_created", &r);
        proj.apply(&event, &state).unwrap();
        let expected_id = format!("page_{:x}", event.commit_seq);
        let key = encode_key("ch_wiki", &expected_id);
        let stored = state.get("wiki_pages", &key).unwrap();
        let mut stored_record = decode_record(&stored).unwrap();
        stored_record.title = "Updated Title".into();
        let edit_event = DurableEvent {
            commit_seq: 2,
            stream_id: "ch_wiki".into(),
            event_type: "wiki_page_edited".into(),
            payload: encode_record(&stored_record),
        };
        proj.apply(&edit_event, &state).unwrap();
        let decoded = decode_record(&state.get("wiki_pages", &key).unwrap()).unwrap();
        assert_eq!(decoded.title, "Updated Title");
    }

    #[test]
    fn delete_marks_record() {
        let state = ProjectionState::new();
        let proj = WikiProjection;
        let r = sample_page();
        let event = make_event(1, "wiki_page_created", &r);
        proj.apply(&event, &state).unwrap();
        let expected_id = format!("page_{:x}", event.commit_seq);
        let key = encode_key("ch_wiki", &expected_id);
        let stored = state.get("wiki_pages", &key).unwrap();
        let mut stored_record = decode_record(&stored).unwrap();
        stored_record.is_deleted = true;
        let delete_event = DurableEvent {
            commit_seq: 2,
            stream_id: "ch_wiki".into(),
            event_type: "wiki_page_deleted".into(),
            payload: encode_record(&stored_record),
        };
        proj.apply(&delete_event, &state).unwrap();
        let decoded = decode_record(&state.get("wiki_pages", &key).unwrap()).unwrap();
        assert!(decoded.is_deleted);
    }

    #[test]
    fn typed_get_page_after_insert() {
        let state = ProjectionState::new();
        let proj = WikiProjection;
        let r = sample_page();
        let event = make_event(1, "wiki_page_created", &r);
        proj.apply(&event, &state).unwrap();
        let expected_id = format!("page_{:x}", event.commit_seq);
        let loaded = WikiProjection::get_page(&state, "ch_wiki", &expected_id).unwrap().unwrap();
        assert_eq!(loaded.page_id, expected_id);
    }

    #[test]
    fn typed_list_pages_returns_all() {
        let state = ProjectionState::new();
        let proj = WikiProjection;
        for seq in 1..=3 {
            let r = WikiPageRecord {
                page_id: String::new(),
                channel_id: "ch_wiki".into(),
                title: format!("Page {seq}"),
                body: "content".into(),
                author_user_id: seq,
                created_at_micros: (seq * 1_000_000) as i64,
                updated_at_micros: (seq * 1_000_000) as i64,
                is_deleted: false,
            };
            proj.apply(&make_event(seq, "wiki_page_created", &r), &state).unwrap();
        }
        let pages = WikiProjection::list_pages(&state, "ch_wiki", false).unwrap();
        assert_eq!(pages.len(), 3);
    }

    #[test]
    fn list_pages_filters_deleted() {
        let state = ProjectionState::new();
        let proj = WikiProjection;
        for seq in 1..=3 {
            let r = WikiPageRecord {
                page_id: String::new(),
                channel_id: "ch_wiki".into(),
                title: format!("Page {seq}"),
                body: "content".into(),
                author_user_id: seq,
                created_at_micros: (seq * 1_000_000) as i64,
                updated_at_micros: (seq * 1_000_000) as i64,
                is_deleted: false,
            };
            proj.apply(&make_event(seq, "wiki_page_created", &r), &state).unwrap();
        }
        // Delete page 2.
        let key = encode_key("ch_wiki", &format!("page_{:x}", 2));
        let stored = state.get("wiki_pages", &key).unwrap();
        let mut deleted = decode_record(&stored).unwrap();
        deleted.is_deleted = true;
        proj.apply(&make_event(4, "wiki_page_deleted", &deleted), &state).unwrap();

        let all = WikiProjection::list_pages(&state, "ch_wiki", false).unwrap();
        assert_eq!(all.len(), 2);
        assert!(all.iter().all(|p| !p.is_deleted));

        let with_deleted = WikiProjection::list_pages(&state, "ch_wiki", true).unwrap();
        assert_eq!(with_deleted.len(), 3);
        assert!(with_deleted.iter().any(|p| p.is_deleted));
    }

    #[test]
    fn compact_removes_deleted_pages() {
        let state = ProjectionState::new();
        let proj = WikiProjection;
        for seq in 1..=3 {
            let r = WikiPageRecord {
                page_id: String::new(),
                channel_id: "ch_wiki".into(),
                title: format!("Page {seq}"),
                body: "content".into(),
                author_user_id: seq,
                created_at_micros: (seq * 1_000_000) as i64,
                updated_at_micros: (seq * 1_000_000) as i64,
                is_deleted: false,
            };
            proj.apply(&make_event(seq, "wiki_page_created", &r), &state).unwrap();
        }
        // Delete page 2.
        let key = encode_key("ch_wiki", &format!("page_{:x}", 2));
        let stored = state.get("wiki_pages", &key).unwrap();
        let mut deleted = decode_record(&stored).unwrap();
        deleted.is_deleted = true;
        proj.apply(&make_event(4, "wiki_page_deleted", &deleted), &state).unwrap();

        assert_eq!(WikiProjection::list_pages(&state, "ch_wiki", true).unwrap().len(), 3);
        let removed = WikiProjection::compact(&state);
        assert_eq!(removed, 1);
        assert_eq!(WikiProjection::list_pages(&state, "ch_wiki", true).unwrap().len(), 2);
    }

    #[test]
    fn bad_payload_returns_error() {
        let state = ProjectionState::new();
        let event = DurableEvent {
            commit_seq: 1,
            stream_id: "ch_wiki".into(),
            event_type: "wiki_page_created".into(),
            payload: vec![0xff, 0xff],
        };
        let result = WikiProjection.apply(&event, &state);
        assert!(result.is_err());
    }
}
