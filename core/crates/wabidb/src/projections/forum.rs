use crate::engine::locks::ProjectionState;
use crate::error::Result;
use crate::projections::codec::RecordCodec;
use crate::projections::handler::{DurableEvent, Projection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ForumPostRecord {
    pub post_id: String,
    pub thread_id: String,
    pub channel_id: String,
    pub author_user_id: u64,
    pub body: String,
    pub created_at_micros: i64,
    pub edited_at_micros: Option<i64>,
    pub is_deleted: bool,
    pub is_thread_starter: bool,
}

impl RecordCodec for ForumPostRecord {
    fn codec_name() -> &'static str {
        "forum_posts"
    }
}

pub fn encode_record(r: &ForumPostRecord) -> Vec<u8> {
    postcard::to_allocvec(r).expect("postcard serialization failed")
}

pub fn decode_record(buf: &[u8]) -> Result<ForumPostRecord> {
    postcard::from_bytes(buf).map_err(|e| crate::error::WabiError::Corrupt {
        location: "forum projection".into(),
        detail: format!("postcard decode failed: {e}"),
    })
}

pub fn encode_key(channel_id: &str, thread_id: &str, post_id: &str) -> Vec<u8> {
    let mut buf = Vec::new();
    buf.extend_from_slice(&(channel_id.len() as u64).to_le_bytes());
    buf.extend_from_slice(channel_id.as_bytes());
    buf.extend_from_slice(&(thread_id.len() as u64).to_le_bytes());
    buf.extend_from_slice(thread_id.as_bytes());
    buf.extend_from_slice(&(post_id.len() as u64).to_le_bytes());
    buf.extend_from_slice(post_id.as_bytes());
    buf
}

impl ForumProjection {
    /// Look up a single forum post.
    pub fn get_post(state: &ProjectionState, channel_id: &str, thread_id: &str, post_id: &str) -> Result<Option<ForumPostRecord>> {
        let key = encode_key(channel_id, thread_id, post_id);
        match state.get("forum_posts", &key) {
            None => Ok(None),
            Some(bytes) => decode_record(&bytes).map(Some),
        }
    }

    /// List all posts in a thread. When `include_deleted` is false (the
    /// common case), soft-deleted records are filtered out.
    pub fn list_posts(state: &ProjectionState, channel_id: &str, thread_id: &str, include_deleted: bool) -> Result<Vec<ForumPostRecord>> {
        let mut prefix = Vec::new();
        prefix.extend_from_slice(&(channel_id.len() as u64).to_le_bytes());
        prefix.extend_from_slice(channel_id.as_bytes());
        prefix.extend_from_slice(&(thread_id.len() as u64).to_le_bytes());
        prefix.extend_from_slice(thread_id.as_bytes());
        let mut results = Vec::new();
        state.prefix_scan("forum_posts", &prefix, |_key, value| {
            if let Ok(record) = decode_record(value) {
                if include_deleted || !record.is_deleted {
                    results.push(record);
                }
            }
        });
        Ok(results)
    }

    /// List all threads (starter posts) in a channel. When `include_deleted`
    /// is false (the common case), soft-deleted records are filtered out.
    pub fn list_threads(state: &ProjectionState, channel_id: &str, include_deleted: bool) -> Result<Vec<ForumPostRecord>> {
        let mut prefix = Vec::new();
        prefix.extend_from_slice(&(channel_id.len() as u64).to_le_bytes());
        prefix.extend_from_slice(channel_id.as_bytes());
        let mut results = Vec::new();
        state.prefix_scan("forum_posts", &prefix, |_key, value| {
            if let Ok(record) = decode_record(value) {
                if record.is_thread_starter && (include_deleted || !record.is_deleted) {
                    results.push(record);
                }
            }
        });
        Ok(results)
    }

    /// Remove all soft-deleted records from the `forum_posts` index.
    pub fn compact(state: &ProjectionState) -> usize {
        state.compact_index("forum_posts", |_key, value| {
            postcard::from_bytes::<ForumPostRecord>(value)
                .ok()
                .map_or(false, |r| r.is_deleted)
        })
    }
}

pub struct ForumProjection;

impl Projection for ForumProjection {
    fn event_type(&self) -> &str {
        "forum_thread_created"
    }

    fn event_types(&self) -> Vec<&str> {
        vec!["forum_thread_created", "forum_post_created", "forum_post_edited", "forum_post_deleted"]
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        match event.event_type.as_str() {
            "forum_thread_created" => self.apply_thread_created(event, state),
            "forum_post_created" => self.apply_post_created(event, state),
            "forum_post_edited" => self.apply_post_edited(event, state),
            "forum_post_deleted" => self.apply_post_deleted(event, state),
            _ => Ok(()),
        }
    }
}

impl ForumProjection {
    fn apply_thread_created(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let mut record: ForumPostRecord = decode_record(&event.payload)?;
        record.post_id = format!("post_{:x}", event.commit_seq);
        record.thread_id.clone_from(&record.post_id);
        record.is_thread_starter = true;
        let key = encode_key(&record.channel_id, &record.thread_id, &record.post_id);
        let value = encode_record(&record);
        state.insert("forum_posts", key, value, event.commit_seq);
        Ok(())
    }

    fn apply_post_created(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let mut record: ForumPostRecord = decode_record(&event.payload)?;
        record.post_id = format!("post_{:x}", event.commit_seq);
        record.is_thread_starter = false;
        let key = encode_key(&record.channel_id, &record.thread_id, &record.post_id);
        let value = encode_record(&record);
        state.insert("forum_posts", key, value, event.commit_seq);
        Ok(())
    }

    fn apply_post_edited(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let record: ForumPostRecord = decode_record(&event.payload)?;
        let key = encode_key(&record.channel_id, &record.thread_id, &record.post_id);
        let value = encode_record(&record);
        state.insert("forum_posts", key, value, event.commit_seq);
        Ok(())
    }

    fn apply_post_deleted(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let record: ForumPostRecord = decode_record(&event.payload)?;
        let key = encode_key(&record.channel_id, &record.thread_id, &record.post_id);
        let value = encode_record(&record);
        state.insert("forum_posts", key, value, event.commit_seq);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_event(seq: u64, event_type: &str, record: &ForumPostRecord) -> DurableEvent {
        DurableEvent {
            commit_seq: seq,
            stream_id: record.channel_id.clone(),
            event_type: event_type.to_string(),
            payload: encode_record(record),
        }
    }

    fn thread_starter() -> ForumPostRecord {
        ForumPostRecord {
            post_id: String::new(),
            thread_id: String::new(),
            channel_id: "ch_forum".into(),
            author_user_id: 42,
            body: "First post!".into(),
            created_at_micros: 1_000_000,
            edited_at_micros: None,
            is_deleted: false,
            is_thread_starter: false,
        }
    }

    #[test]
    fn encode_decode_roundtrip() {
        let r = ForumPostRecord {
            post_id: "post_01".into(),
            thread_id: "thread_01".into(),
            channel_id: "ch_forum".into(),
            author_user_id: 42,
            body: "hello".into(),
            created_at_micros: 1_000_000,
            edited_at_micros: None,
            is_deleted: false,
            is_thread_starter: true,
        };
        let buf = encode_record(&r);
        let decoded = decode_record(&buf).unwrap();
        assert_eq!(r, decoded);
    }

    #[test]
    fn event_type_returns_correct() {
        let proj = ForumProjection;
        assert_eq!(proj.event_type(), "forum_thread_created");
        assert!(proj.event_types().contains(&"forum_post_created"));
        assert!(proj.event_types().contains(&"forum_post_edited"));
        assert!(proj.event_types().contains(&"forum_post_deleted"));
    }

    #[test]
    fn thread_created_sets_thread_id_from_post_id() {
        let state = ProjectionState::new();
        let proj = ForumProjection;
        let r = thread_starter();
        let event = make_event(1, "forum_thread_created", &r);
        proj.apply(&event, &state).unwrap();
        let expected_id = format!("post_{:x}", event.commit_seq);
        let key = encode_key("ch_forum", &expected_id, &expected_id);
        let stored = state.get("forum_posts", &key).unwrap();
        let decoded = decode_record(&stored).unwrap();
        assert_eq!(decoded.post_id, expected_id);
        assert_eq!(decoded.thread_id, expected_id);
        assert!(decoded.is_thread_starter);
    }

    #[test]
    fn post_created_in_thread() {
        let state = ProjectionState::new();
        let proj = ForumProjection;
        let mut thread = thread_starter();
        let thread_event = make_event(1, "forum_thread_created", &thread);
        proj.apply(&thread_event, &state).unwrap();
        let thread_id = format!("post_{:x}", thread_event.commit_seq);
        thread.post_id = String::new();
        thread.thread_id = thread_id.clone();
        thread.body = "Reply".into();
        thread.is_thread_starter = false;
        let reply_event = make_event(2, "forum_post_created", &thread);
        proj.apply(&reply_event, &state).unwrap();
        let reply_id = format!("post_{:x}", reply_event.commit_seq);
        let key = encode_key("ch_forum", &thread_id, &reply_id);
        let stored = state.get("forum_posts", &key).unwrap();
        let decoded = decode_record(&stored).unwrap();
        assert_eq!(decoded.body, "Reply");
        assert!(!decoded.is_thread_starter);
    }

    #[test]
    fn edit_overwrites_post() {
        let state = ProjectionState::new();
        let proj = ForumProjection;
        let r = thread_starter();
        let event = make_event(1, "forum_thread_created", &r);
        proj.apply(&event, &state).unwrap();
        let expected_id = format!("post_{:x}", event.commit_seq);
        let key = encode_key("ch_forum", &expected_id, &expected_id);
        let stored = state.get("forum_posts", &key).unwrap();
        let mut stored_record = decode_record(&stored).unwrap();
        stored_record.body = "Edited body".into();
        let edit_event = DurableEvent {
            commit_seq: 2,
            stream_id: "ch_forum".into(),
            event_type: "forum_post_edited".into(),
            payload: encode_record(&stored_record),
        };
        proj.apply(&edit_event, &state).unwrap();
        let decoded = decode_record(&state.get("forum_posts", &key).unwrap()).unwrap();
        assert_eq!(decoded.body, "Edited body");
    }

    #[test]
    fn delete_marks_post() {
        let state = ProjectionState::new();
        let proj = ForumProjection;
        let r = thread_starter();
        let event = make_event(1, "forum_thread_created", &r);
        proj.apply(&event, &state).unwrap();
        let expected_id = format!("post_{:x}", event.commit_seq);
        let key = encode_key("ch_forum", &expected_id, &expected_id);
        let stored = state.get("forum_posts", &key).unwrap();
        let mut stored_record = decode_record(&stored).unwrap();
        stored_record.is_deleted = true;
        let delete_event = DurableEvent {
            commit_seq: 2,
            stream_id: "ch_forum".into(),
            event_type: "forum_post_deleted".into(),
            payload: encode_record(&stored_record),
        };
        proj.apply(&delete_event, &state).unwrap();
        let decoded = decode_record(&state.get("forum_posts", &key).unwrap()).unwrap();
        assert!(decoded.is_deleted);
    }

    #[test]
    fn typed_get_post_after_insert() {
        let state = ProjectionState::new();
        let proj = ForumProjection;
        let r = thread_starter();
        let event = make_event(1, "forum_thread_created", &r);
        proj.apply(&event, &state).unwrap();
        let expected_id = format!("post_{:x}", event.commit_seq);
        let loaded = ForumProjection::get_post(&state, "ch_forum", &expected_id, &expected_id).unwrap().unwrap();
        assert_eq!(loaded.post_id, expected_id);
    }

    #[test]
    fn typed_list_posts_in_thread() {
        let state = ProjectionState::new();
        let proj = ForumProjection;
        let r = thread_starter();
        let event = make_event(1, "forum_thread_created", &r);
        proj.apply(&event, &state).unwrap();
        let thread_id = format!("post_{:x}", event.commit_seq);
        // Add a reply
        let mut reply = thread_starter();
        reply.thread_id = thread_id.clone();
        reply.body = "Reply".into();
        reply.is_thread_starter = false;
        let reply_event = make_event(2, "forum_post_created", &reply);
        proj.apply(&reply_event, &state).unwrap();
        let posts = ForumProjection::list_posts(&state, "ch_forum", &thread_id, false).unwrap();
        assert_eq!(posts.len(), 2);
    }

    #[test]
    fn list_posts_filters_deleted() {
        let state = ProjectionState::new();
        let proj = ForumProjection;
        let r = thread_starter();
        let event = make_event(1, "forum_thread_created", &r);
        proj.apply(&event, &state).unwrap();
        let thread_id = format!("post_{:x}", event.commit_seq);
        for seq in 2..=4 {
            let mut reply = thread_starter();
            reply.thread_id = thread_id.clone();
            reply.body = format!("Reply {seq}");
            reply.is_thread_starter = false;
            proj.apply(&make_event(seq, "forum_post_created", &reply), &state).unwrap();
        }
        // Delete reply 3.
        let reply3_key = encode_key("ch_forum", &thread_id, &format!("post_{:x}", 3));
        let stored = state.get("forum_posts", &reply3_key).unwrap();
        let mut deleted = decode_record(&stored).unwrap();
        deleted.is_deleted = true;
        proj.apply(&make_event(5, "forum_post_deleted", &deleted), &state).unwrap();

        let all = ForumProjection::list_posts(&state, "ch_forum", &thread_id, false).unwrap();
        assert_eq!(all.len(), 3);
        assert!(all.iter().all(|p| !p.is_deleted));

        let with_deleted = ForumProjection::list_posts(&state, "ch_forum", &thread_id, true).unwrap();
        assert_eq!(with_deleted.len(), 4);
        assert!(with_deleted.iter().any(|p| p.is_deleted));
    }

    #[test]
    fn list_threads_filters_deleted() {
        let state = ProjectionState::new();
        let proj = ForumProjection;
        for seq in 1..=3 {
            let mut r = thread_starter();
            r.body = format!("Thread {seq}");
            proj.apply(&make_event(seq, "forum_thread_created", &r), &state).unwrap();
        }
        // Delete thread 2.
        let key = encode_key("ch_forum", &format!("post_{:x}", 2), &format!("post_{:x}", 2));
        let stored = state.get("forum_posts", &key).unwrap();
        let mut deleted = decode_record(&stored).unwrap();
        deleted.is_deleted = true;
        proj.apply(&make_event(4, "forum_post_deleted", &deleted), &state).unwrap();

        let threads = ForumProjection::list_threads(&state, "ch_forum", false).unwrap();
        assert_eq!(threads.len(), 2);
        assert!(threads.iter().all(|t| !t.is_deleted));

        let with_deleted = ForumProjection::list_threads(&state, "ch_forum", true).unwrap();
        assert_eq!(with_deleted.len(), 3);
        assert!(with_deleted.iter().any(|t| t.is_deleted));
    }

    #[test]
    fn compact_removes_deleted_forum_posts() {
        let state = ProjectionState::new();
        let proj = ForumProjection;
        for seq in 1..=3 {
            let mut r = thread_starter();
            r.body = format!("Thread {seq}");
            proj.apply(&make_event(seq, "forum_thread_created", &r), &state).unwrap();
        }
        // Delete thread 2.
        let key = encode_key("ch_forum", &format!("post_{:x}", 2), &format!("post_{:x}", 2));
        let stored = state.get("forum_posts", &key).unwrap();
        let mut deleted = decode_record(&stored).unwrap();
        deleted.is_deleted = true;
        proj.apply(&make_event(4, "forum_post_deleted", &deleted), &state).unwrap();

        assert_eq!(ForumProjection::list_posts(&state, "ch_forum", &format!("post_{:x}", 2), true).unwrap().len(), 1);
        assert_eq!(ForumProjection::list_threads(&state, "ch_forum", true).unwrap().len(), 3);

        let removed = ForumProjection::compact(&state);
        assert_eq!(removed, 1);

        assert_eq!(ForumProjection::list_threads(&state, "ch_forum", true).unwrap().len(), 2);
    }

    #[test]
    fn typed_list_threads_returns_only_starter_posts() {
        let state = ProjectionState::new();
        let proj = ForumProjection;
        for seq in 1..=2 {
            let mut r = thread_starter();
            r.body = format!("Thread {seq}");
            let event = make_event(seq, "forum_thread_created", &r);
            proj.apply(&event, &state).unwrap();
            // Add a reply to each thread
            let thread_id = format!("post_{:x}", event.commit_seq);
            let mut reply = thread_starter();
            reply.thread_id = thread_id;
            reply.body = format!("Reply to {seq}");
            reply.is_thread_starter = false;
            let reply_event = make_event(10 + seq, "forum_post_created", &reply);
            proj.apply(&reply_event, &state).unwrap();
        }
        let threads = ForumProjection::list_threads(&state, "ch_forum", false).unwrap();
        assert_eq!(threads.len(), 2);
        assert!(threads.iter().all(|p| p.is_thread_starter));
    }

    #[test]
    fn bad_payload_returns_error() {
        let state = ProjectionState::new();
        let event = DurableEvent {
            commit_seq: 1,
            stream_id: "ch_forum".into(),
            event_type: "forum_thread_created".into(),
            payload: vec![0xff],
        };
        let result = ForumProjection.apply(&event, &state);
        assert!(result.is_err());
    }
}
