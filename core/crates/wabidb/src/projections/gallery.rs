use crate::engine::locks::ProjectionState;
use crate::error::Result;
use crate::projections::codec::RecordCodec;
use crate::projections::handler::{DurableEvent, Projection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GalleryWorkRecord {
    pub work_id: String,
    pub channel_id: String,
    pub author_user_id: u64,
    pub title: String,
    pub caption: String,
    pub attachment_url: String,
    pub mime_type: String,
    pub category: String,
    pub is_wip: bool,
    pub created_at_micros: i64,
    pub updated_at_micros: i64,
    pub is_deleted: bool,
}

impl RecordCodec for GalleryWorkRecord {
    fn codec_name() -> &'static str {
        "gallery_works"
    }
}

pub fn encode_record(r: &GalleryWorkRecord) -> Vec<u8> {
    postcard::to_allocvec(r).expect("postcard serialization failed")
}

pub fn decode_record(buf: &[u8]) -> Result<GalleryWorkRecord> {
    postcard::from_bytes(buf).map_err(|e| crate::error::WabiError::Corrupt {
        location: "gallery work projection".into(),
        detail: format!("postcard decode failed: {e}"),
    })
}

pub fn encode_key(channel_id: &str, work_id: &str) -> Vec<u8> {
    let mut buf = Vec::new();
    buf.extend_from_slice(&(channel_id.len() as u64).to_le_bytes());
    buf.extend_from_slice(channel_id.as_bytes());
    buf.extend_from_slice(&(work_id.len() as u64).to_le_bytes());
    buf.extend_from_slice(work_id.as_bytes());
    buf
}

impl GalleryWorkProjection {
    /// Look up a single gallery work.
    pub fn get_work(state: &ProjectionState, channel_id: &str, work_id: &str) -> Result<Option<GalleryWorkRecord>> {
        let key = encode_key(channel_id, work_id);
        match state.get("gallery_works", &key) {
            None => Ok(None),
            Some(bytes) => decode_record(&bytes).map(Some),
        }
    }

    /// List gallery works in a channel. When `include_deleted` is false (the
    /// common case), soft-deleted records are filtered out.
    pub fn list_works(state: &ProjectionState, channel_id: &str, include_deleted: bool) -> Result<Vec<GalleryWorkRecord>> {
        let mut prefix = Vec::new();
        prefix.extend_from_slice(&(channel_id.len() as u64).to_le_bytes());
        prefix.extend_from_slice(channel_id.as_bytes());
        let mut results = Vec::new();
        state.prefix_scan("gallery_works", &prefix, |_key, value| {
            if let Ok(record) = decode_record(value) {
                if include_deleted || !record.is_deleted {
                    results.push(record);
                }
            }
        });
        Ok(results)
    }

    /// Remove all soft-deleted records from the `gallery_works` index.
    pub fn compact(state: &ProjectionState) -> usize {
        state.compact_index("gallery_works", |_key, value| {
            postcard::from_bytes::<GalleryWorkRecord>(value)
                .ok()
                .map_or(false, |r| r.is_deleted)
        })
    }
}

pub struct GalleryWorkProjection;

impl Projection for GalleryWorkProjection {
    fn event_type(&self) -> &str {
        "gallery_work_uploaded"
    }

    fn event_types(&self) -> Vec<&str> {
        vec!["gallery_work_uploaded", "gallery_work_edited", "gallery_work_deleted"]
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        match event.event_type.as_str() {
            "gallery_work_uploaded" => self.apply_uploaded(event, state),
            "gallery_work_edited" => self.apply_edited(event, state),
            "gallery_work_deleted" => self.apply_deleted(event, state),
            _ => Ok(()),
        }
    }
}

impl GalleryWorkProjection {
    fn apply_uploaded(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let mut record: GalleryWorkRecord = decode_record(&event.payload)?;
        record.work_id = format!("work_{:x}", event.commit_seq);
        let key = encode_key(&record.channel_id, &record.work_id);
        let value = encode_record(&record);
        state.insert("gallery_works", key, value, event.commit_seq);
        Ok(())
    }

    fn apply_edited(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let record: GalleryWorkRecord = decode_record(&event.payload)?;
        let key = encode_key(&record.channel_id, &record.work_id);
        let value = encode_record(&record);
        state.insert("gallery_works", key, value, event.commit_seq);
        Ok(())
    }

    fn apply_deleted(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let record: GalleryWorkRecord = decode_record(&event.payload)?;
        let key = encode_key(&record.channel_id, &record.work_id);
        let value = encode_record(&record);
        state.insert("gallery_works", key, value, event.commit_seq);
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GalleryFeedbackRecord {
    pub feedback_id: String,
    pub work_id: String,
    pub channel_id: String,
    pub author_user_id: u64,
    pub comment: String,
    pub x_percent: f32,
    pub y_percent: f32,
    pub created_at_micros: i64,
    pub is_deleted: bool,
}

impl RecordCodec for GalleryFeedbackRecord {
    fn codec_name() -> &'static str {
        "gallery_feedback"
    }
}

pub fn encode_feedback_record(r: &GalleryFeedbackRecord) -> Vec<u8> {
    postcard::to_allocvec(r).expect("postcard serialization failed")
}

pub fn decode_feedback_record(buf: &[u8]) -> Result<GalleryFeedbackRecord> {
    postcard::from_bytes(buf).map_err(|e| crate::error::WabiError::Corrupt {
        location: "gallery feedback projection".into(),
        detail: format!("postcard decode failed: {e}"),
    })
}

pub fn encode_feedback_key(channel_id: &str, work_id: &str, feedback_id: &str) -> Vec<u8> {
    let mut buf = Vec::new();
    buf.extend_from_slice(&(channel_id.len() as u64).to_le_bytes());
    buf.extend_from_slice(channel_id.as_bytes());
    buf.extend_from_slice(&(work_id.len() as u64).to_le_bytes());
    buf.extend_from_slice(work_id.as_bytes());
    buf.extend_from_slice(&(feedback_id.len() as u64).to_le_bytes());
    buf.extend_from_slice(feedback_id.as_bytes());
    buf
}

impl GalleryFeedbackProjection {
    /// List feedback for a specific work. When `include_deleted` is false (the
    /// common case), soft-deleted records are filtered out.
    pub fn list_feedback_for_work(state: &ProjectionState, channel_id: &str, work_id: &str, include_deleted: bool) -> Result<Vec<GalleryFeedbackRecord>> {
        let mut prefix = Vec::new();
        prefix.extend_from_slice(&(channel_id.len() as u64).to_le_bytes());
        prefix.extend_from_slice(channel_id.as_bytes());
        prefix.extend_from_slice(&(work_id.len() as u64).to_le_bytes());
        prefix.extend_from_slice(work_id.as_bytes());
        let mut results = Vec::new();
        state.prefix_scan("gallery_feedback", &prefix, |_key, value| {
            if let Ok(record) = decode_feedback_record(value) {
                if include_deleted || !record.is_deleted {
                    results.push(record);
                }
            }
        });
        Ok(results)
    }
}

pub struct GalleryFeedbackProjection;

impl Projection for GalleryFeedbackProjection {
    fn event_type(&self) -> &str {
        "gallery_feedback_added"
    }

    fn event_types(&self) -> Vec<&str> {
        vec!["gallery_feedback_added", "gallery_feedback_deleted"]
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        match event.event_type.as_str() {
            "gallery_feedback_added" => self.apply_added(event, state),
            "gallery_feedback_deleted" => self.apply_deleted(event, state),
            _ => Ok(()),
        }
    }
}

impl GalleryFeedbackProjection {
    fn apply_added(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let mut record: GalleryFeedbackRecord = decode_feedback_record(&event.payload)?;
        record.feedback_id = format!("feedback_{:x}", event.commit_seq);
        let key = encode_feedback_key(&record.channel_id, &record.work_id, &record.feedback_id);
        let value = encode_feedback_record(&record);
        state.insert("gallery_feedback", key, value, event.commit_seq);
        Ok(())
    }

    fn apply_deleted(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let record: GalleryFeedbackRecord = decode_feedback_record(&event.payload)?;
        let key = encode_feedback_key(&record.channel_id, &record.work_id, &record.feedback_id);
        let value = encode_feedback_record(&record);
        state.insert("gallery_feedback", key, value, event.commit_seq);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::projections::handler::DispatchTable;
    use std::sync::Arc;

    fn sample_work() -> GalleryWorkRecord {
        GalleryWorkRecord {
            work_id: String::new(),
            channel_id: "ch_gallery".into(),
            author_user_id: 42,
            title: "Sunset Landscape".into(),
            caption: "A beautiful sunset".into(),
            attachment_url: "https://cdn.example.com/works/sunset.png".into(),
            mime_type: "image/png".into(),
            category: "environment".into(),
            is_wip: false,
            created_at_micros: 1_000_000,
            updated_at_micros: 1_000_000,
            is_deleted: false,
        }
    }

    fn sample_feedback() -> GalleryFeedbackRecord {
        GalleryFeedbackRecord {
            feedback_id: String::new(),
            work_id: "work_01".into(),
            channel_id: "ch_gallery".into(),
            author_user_id: 99,
            comment: "Great lighting!".into(),
            x_percent: 50.0,
            y_percent: 30.0,
            created_at_micros: 2_000_000,
            is_deleted: false,
        }
    }

    fn make_work_event(seq: u64, event_type: &str, record: &GalleryWorkRecord) -> DurableEvent {
        DurableEvent {
            commit_seq: seq,
            stream_id: record.channel_id.clone(),
            event_type: event_type.to_string(),
            payload: encode_record(record),
        }
    }

    fn make_feedback_event(seq: u64, event_type: &str, record: &GalleryFeedbackRecord) -> DurableEvent {
        DurableEvent {
            commit_seq: seq,
            stream_id: record.channel_id.clone(),
            event_type: event_type.to_string(),
            payload: encode_feedback_record(record),
        }
    }

    #[test]
    fn work_encode_decode_roundtrip() {
        let r = sample_work();
        let buf = encode_record(&r);
        let decoded = decode_record(&buf).unwrap();
        assert_eq!(r, decoded);
    }

    #[test]
    fn feedback_encode_decode_roundtrip() {
        let r = sample_feedback();
        let buf = encode_feedback_record(&r);
        let decoded = decode_feedback_record(&buf).unwrap();
        assert_eq!(r, decoded);
    }

    #[test]
    fn work_event_type_returns_correct() {
        let proj = GalleryWorkProjection;
        assert_eq!(proj.event_type(), "gallery_work_uploaded");
        assert!(proj.event_types().contains(&"gallery_work_edited"));
        assert!(proj.event_types().contains(&"gallery_work_deleted"));
    }

    #[test]
    fn feedback_event_type_returns_correct() {
        let proj = GalleryFeedbackProjection;
        assert_eq!(proj.event_type(), "gallery_feedback_added");
        assert!(proj.event_types().contains(&"gallery_feedback_deleted"));
    }

    #[test]
    fn work_insert_and_lookup() {
        let state = ProjectionState::new();
        let proj = GalleryWorkProjection;
        let r = sample_work();
        let event = make_work_event(1, "gallery_work_uploaded", &r);
        proj.apply(&event, &state).unwrap();
        let expected_id = format!("work_{:x}", event.commit_seq);
        let key = encode_key("ch_gallery", &expected_id);
        let stored = state.get("gallery_works", &key).unwrap();
        let decoded = decode_record(&stored).unwrap();
        assert_eq!(decoded.work_id, expected_id);
        assert_eq!(decoded.title, "Sunset Landscape");
    }

    #[test]
    fn work_edit_overwrites_record() {
        let state = ProjectionState::new();
        let proj = GalleryWorkProjection;
        let r = sample_work();
        let event = make_work_event(1, "gallery_work_uploaded", &r);
        proj.apply(&event, &state).unwrap();
        let expected_id = format!("work_{:x}", event.commit_seq);
        let key = encode_key("ch_gallery", &expected_id);
        let stored = state.get("gallery_works", &key).unwrap();
        let mut stored_record = decode_record(&stored).unwrap();
        stored_record.title = "Updated Title".into();
        stored_record.caption = "Updated caption".into();
        stored_record.category = "character".into();
        let edit_event = DurableEvent {
            commit_seq: 2,
            stream_id: "ch_gallery".into(),
            event_type: "gallery_work_edited".into(),
            payload: encode_record(&stored_record),
        };
        proj.apply(&edit_event, &state).unwrap();
        let decoded = decode_record(&state.get("gallery_works", &key).unwrap()).unwrap();
        assert_eq!(decoded.title, "Updated Title");
        assert_eq!(decoded.caption, "Updated caption");
        assert_eq!(decoded.category, "character");
    }

    #[test]
    fn work_delete_marks_record() {
        let state = ProjectionState::new();
        let proj = GalleryWorkProjection;
        let r = sample_work();
        let event = make_work_event(1, "gallery_work_uploaded", &r);
        proj.apply(&event, &state).unwrap();
        let expected_id = format!("work_{:x}", event.commit_seq);
        let key = encode_key("ch_gallery", &expected_id);
        let stored = state.get("gallery_works", &key).unwrap();
        let mut stored_record = decode_record(&stored).unwrap();
        stored_record.is_deleted = true;
        let delete_event = DurableEvent {
            commit_seq: 2,
            stream_id: "ch_gallery".into(),
            event_type: "gallery_work_deleted".into(),
            payload: encode_record(&stored_record),
        };
        proj.apply(&delete_event, &state).unwrap();
        let decoded = decode_record(&state.get("gallery_works", &key).unwrap()).unwrap();
        assert!(decoded.is_deleted);
    }

    #[test]
    fn typed_get_work_after_insert() {
        let state = ProjectionState::new();
        let proj = GalleryWorkProjection;
        let r = sample_work();
        let event = make_work_event(1, "gallery_work_uploaded", &r);
        proj.apply(&event, &state).unwrap();
        let expected_id = format!("work_{:x}", event.commit_seq);
        let loaded = GalleryWorkProjection::get_work(&state, "ch_gallery", &expected_id).unwrap().unwrap();
        assert_eq!(loaded.work_id, expected_id);
    }

    #[test]
    fn typed_list_works_returns_all() {
        let state = ProjectionState::new();
        let proj = GalleryWorkProjection;
        for seq in 1..=3 {
            let r = GalleryWorkRecord {
                work_id: String::new(),
                channel_id: "ch_gallery".into(),
                author_user_id: seq,
                title: format!("Work {seq}"),
                caption: "content".into(),
                attachment_url: "https://cdn.example.com/works/img.png".into(),
                mime_type: "image/png".into(),
                category: "".into(),
                is_wip: false,
                created_at_micros: (seq * 1_000_000) as i64,
                updated_at_micros: (seq * 1_000_000) as i64,
                is_deleted: false,
            };
            proj.apply(&make_work_event(seq, "gallery_work_uploaded", &r), &state).unwrap();
        }
        let works = GalleryWorkProjection::list_works(&state, "ch_gallery", false).unwrap();
        assert_eq!(works.len(), 3);
    }

    #[test]
    fn list_works_filters_deleted() {
        let state = ProjectionState::new();
        let proj = GalleryWorkProjection;
        for seq in 1..=3 {
            let r = GalleryWorkRecord {
                work_id: String::new(),
                channel_id: "ch_gallery".into(),
                author_user_id: seq,
                title: format!("Work {seq}"),
                caption: "content".into(),
                attachment_url: "https://cdn.example.com/works/img.png".into(),
                mime_type: "image/png".into(),
                category: "".into(),
                is_wip: false,
                created_at_micros: (seq * 1_000_000) as i64,
                updated_at_micros: (seq * 1_000_000) as i64,
                is_deleted: false,
            };
            proj.apply(&make_work_event(seq, "gallery_work_uploaded", &r), &state).unwrap();
        }
        // Delete work 2.
        let key = encode_key("ch_gallery", &format!("work_{:x}", 2));
        let stored = state.get("gallery_works", &key).unwrap();
        let mut deleted = decode_record(&stored).unwrap();
        deleted.is_deleted = true;
        proj.apply(&make_work_event(4, "gallery_work_deleted", &deleted), &state).unwrap();

        let all = GalleryWorkProjection::list_works(&state, "ch_gallery", false).unwrap();
        assert_eq!(all.len(), 2);
        assert!(all.iter().all(|p| !p.is_deleted));

        let with_deleted = GalleryWorkProjection::list_works(&state, "ch_gallery", true).unwrap();
        assert_eq!(with_deleted.len(), 3);
        assert!(with_deleted.iter().any(|p| p.is_deleted));
    }

    #[test]
    fn compact_removes_deleted_works() {
        let state = ProjectionState::new();
        let proj = GalleryWorkProjection;
        for seq in 1..=3 {
            let r = GalleryWorkRecord {
                work_id: String::new(),
                channel_id: "ch_gallery".into(),
                author_user_id: seq,
                title: format!("Work {seq}"),
                caption: "content".into(),
                attachment_url: "https://cdn.example.com/works/img.png".into(),
                mime_type: "image/png".into(),
                category: "".into(),
                is_wip: false,
                created_at_micros: (seq * 1_000_000) as i64,
                updated_at_micros: (seq * 1_000_000) as i64,
                is_deleted: false,
            };
            proj.apply(&make_work_event(seq, "gallery_work_uploaded", &r), &state).unwrap();
        }
        // Delete work 2.
        let key = encode_key("ch_gallery", &format!("work_{:x}", 2));
        let stored = state.get("gallery_works", &key).unwrap();
        let mut deleted = decode_record(&stored).unwrap();
        deleted.is_deleted = true;
        proj.apply(&make_work_event(4, "gallery_work_deleted", &deleted), &state).unwrap();

        assert_eq!(GalleryWorkProjection::list_works(&state, "ch_gallery", true).unwrap().len(), 3);
        let removed = GalleryWorkProjection::compact(&state);
        assert_eq!(removed, 1);
        assert_eq!(GalleryWorkProjection::list_works(&state, "ch_gallery", true).unwrap().len(), 2);
    }

    #[test]
    fn feedback_add_and_list() {
        let state = ProjectionState::new();
        let proj = GalleryFeedbackProjection;
        let r = sample_feedback();
        let event = make_feedback_event(1, "gallery_feedback_added", &r);
        proj.apply(&event, &state).unwrap();
        let expected_id = format!("feedback_{:x}", event.commit_seq);
        let key = encode_feedback_key("ch_gallery", "work_01", &expected_id);
        let stored = state.get("gallery_feedback", &key).unwrap();
        let decoded = decode_feedback_record(&stored).unwrap();
        assert_eq!(decoded.feedback_id, expected_id);
        assert_eq!(decoded.comment, "Great lighting!");
    }

    #[test]
    fn feedback_list_filters_deleted() {
        let state = ProjectionState::new();
        let proj = GalleryFeedbackProjection;
        for seq in 1..=3 {
            let r = GalleryFeedbackRecord {
                feedback_id: String::new(),
                work_id: "work_01".into(),
                channel_id: "ch_gallery".into(),
                author_user_id: seq,
                comment: format!("Feedback {seq}"),
                x_percent: 50.0,
                y_percent: 30.0,
                created_at_micros: (seq * 1_000_000) as i64,
                is_deleted: false,
            };
            proj.apply(&make_feedback_event(seq, "gallery_feedback_added", &r), &state).unwrap();
        }
        // Delete feedback 2.
        let key = encode_feedback_key("ch_gallery", "work_01", &format!("feedback_{:x}", 2));
        let stored = state.get("gallery_feedback", &key).unwrap();
        let mut deleted = decode_feedback_record(&stored).unwrap();
        deleted.is_deleted = true;
        proj.apply(&make_feedback_event(4, "gallery_feedback_deleted", &deleted), &state).unwrap();

        let all = GalleryFeedbackProjection::list_feedback_for_work(&state, "ch_gallery", "work_01", false).unwrap();
        assert_eq!(all.len(), 2);
        assert!(all.iter().all(|p| !p.is_deleted));

        let with_deleted = GalleryFeedbackProjection::list_feedback_for_work(&state, "ch_gallery", "work_01", true).unwrap();
        assert_eq!(with_deleted.len(), 3);
        assert!(with_deleted.iter().any(|p| p.is_deleted));
    }

    #[test]
    fn bad_work_payload_returns_error() {
        let state = ProjectionState::new();
        let event = DurableEvent {
            commit_seq: 1,
            stream_id: "ch_gallery".into(),
            event_type: "gallery_work_uploaded".into(),
            payload: vec![0xff, 0xff],
        };
        let result = GalleryWorkProjection.apply(&event, &state);
        assert!(result.is_err());
    }

    #[test]
    fn bad_feedback_payload_returns_error() {
        let state = ProjectionState::new();
        let event = DurableEvent {
            commit_seq: 1,
            stream_id: "ch_gallery".into(),
            event_type: "gallery_feedback_added".into(),
            payload: vec![0xff, 0xff],
        };
        let result = GalleryFeedbackProjection.apply(&event, &state);
        assert!(result.is_err());
    }

    #[test]
    fn dispatch_table_routes_gallery_work_events() {
        let table = DispatchTable::new(vec![Arc::new(GalleryWorkProjection)]).unwrap();
        let state = ProjectionState::new();
        let r = sample_work();
        let event = make_work_event(1, "gallery_work_uploaded", &r);
        let handler = table.get("gallery_work_uploaded").unwrap();
        handler.apply(&event, &state).unwrap();
        let expected_id = format!("work_{:x}", event.commit_seq);
        let key = encode_key("ch_gallery", &expected_id);
        assert!(state.get("gallery_works", &key).is_some());
    }

    #[test]
    fn dispatch_table_routes_gallery_feedback_events() {
        let table = DispatchTable::new(vec![Arc::new(GalleryFeedbackProjection)]).unwrap();
        let state = ProjectionState::new();
        let r = sample_feedback();
        let event = make_feedback_event(1, "gallery_feedback_added", &r);
        let handler = table.get("gallery_feedback_added").unwrap();
        handler.apply(&event, &state).unwrap();
        let expected_id = format!("feedback_{:x}", event.commit_seq);
        let key = encode_feedback_key("ch_gallery", "work_01", &expected_id);
        assert!(state.get("gallery_feedback", &key).is_some());
    }
}
