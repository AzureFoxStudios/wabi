use crate::engine::locks::ProjectionState;
use crate::error::Result;
use crate::projections::codec::RecordCodec;
use crate::projections::handler::{DurableEvent, Projection};
use crate::projections::query::{apply_limit, ForumFilter, QueryableProjection};
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
    pub title: String,
    pub tags: Vec<String>,
    pub votes_up: u64,
    pub votes_down: u64,
    pub is_solution: bool,
    pub category: Option<String>,
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
        vec![
            "forum_thread_created",
            "forum_post_created",
            "forum_post_edited",
            "forum_post_deleted",
            "forum_post_voted",
            "forum_post_solution_set",
            "forum_thread_meta_updated",
        ]
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        match event.event_type.as_str() {
            "forum_thread_created" => self.apply_thread_created(event, state),
            "forum_post_created" => self.apply_post_created(event, state),
            "forum_post_edited" => self.apply_post_edited(event, state),
            "forum_post_deleted" => self.apply_post_deleted(event, state),
            "forum_post_voted" => self.apply_post_voted(event, state),
            "forum_post_solution_set" => self.apply_post_solution_set(event, state),
            "forum_thread_meta_updated" => self.apply_thread_meta_updated(event, state),
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

    fn apply_post_voted(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        #[derive(Deserialize)]
        struct VotePayload {
            post_id: String,
            thread_id: String,
            channel_id: String,
            direction: String,
            #[allow(dead_code)]
            actor_user_id: u64,
        }
        let v: VotePayload = postcard::from_bytes(&event.payload).map_err(|e| {
            crate::error::WabiError::Corrupt {
                location: "forum projection".into(),
                detail: format!("vote payload decode failed: {e}"),
            }
        })?;
        let key = encode_key(&v.channel_id, &v.thread_id, &v.post_id);
        if let Some(bytes) = state.get("forum_posts", &key) {
            if let Ok(mut record) = postcard::from_bytes::<ForumPostRecord>(&bytes) {
                match v.direction.as_str() {
                    "up" => record.votes_up += 1,
                    "down" => record.votes_down += 1,
                    _ => {}
                }
                let value = encode_record(&record);
                state.insert("forum_posts", key, value, event.commit_seq);
            }
        }
        Ok(())
    }

    fn apply_post_solution_set(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        #[derive(Deserialize)]
        struct SolutionPayload {
            post_id: String,
            thread_id: String,
            channel_id: String,
            #[allow(dead_code)]
            actor_user_id: u64,
        }
        let s: SolutionPayload = postcard::from_bytes(&event.payload).map_err(|e| {
            crate::error::WabiError::Corrupt {
                location: "forum projection".into(),
                detail: format!("solution payload decode failed: {e}"),
            }
        })?;

        // Clear solution on all other posts in this thread
        let mut prefix = Vec::new();
        prefix.extend_from_slice(&(s.channel_id.len() as u64).to_le_bytes());
        prefix.extend_from_slice(s.channel_id.as_bytes());
        prefix.extend_from_slice(&(s.thread_id.len() as u64).to_le_bytes());
        prefix.extend_from_slice(s.thread_id.as_bytes());
        let mut updates: Vec<(Vec<u8>, Vec<u8>)> = Vec::new();
        state.prefix_scan("forum_posts", &prefix, |key, value| {
            if let Ok(mut record) = postcard::from_bytes::<ForumPostRecord>(value) {
                if key != s.post_id.as_bytes() && record.is_solution {
                    record.is_solution = false;
                    updates.push((key.to_vec(), encode_record(&record)));
                }
            }
        });
        for (k, v) in updates {
            state.insert("forum_posts", k, v, event.commit_seq);
        }

        // Set solution on the target post
        let key = encode_key(&s.channel_id, &s.thread_id, &s.post_id);
        if let Some(bytes) = state.get("forum_posts", &key) {
            if let Ok(mut record) = postcard::from_bytes::<ForumPostRecord>(&bytes) {
                record.is_solution = true;
                let value = encode_record(&record);
                state.insert("forum_posts", key, value, event.commit_seq);
            }
        }
        Ok(())
    }

    fn apply_thread_meta_updated(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let record: ForumPostRecord = decode_record(&event.payload)?;
        let key = encode_key(&record.channel_id, &record.thread_id, &record.post_id);
        state.insert("forum_posts", key, event.payload.clone(), event.commit_seq);
        Ok(())
    }
}

impl QueryableProjection for ForumProjection {
    type Record = ForumPostRecord;
    type Filter = ForumFilter;

    fn query(&self, state: &ProjectionState, filter: &ForumFilter) -> Result<Vec<ForumPostRecord>> {
        let mut results = Vec::new();
        match &filter.channel_id {
            // channel_id is the leading key component; thread_id narrows further.
            Some(channel_id) => {
                let mut prefix = Vec::new();
                prefix.extend_from_slice(&(channel_id.len() as u64).to_le_bytes());
                prefix.extend_from_slice(channel_id.as_bytes());
                if let Some(thread_id) = &filter.thread_id {
                    prefix.extend_from_slice(&(thread_id.len() as u64).to_le_bytes());
                    prefix.extend_from_slice(thread_id.as_bytes());
                }
                state.prefix_scan("forum_posts", &prefix, |_key, value| {
                    if let Ok(record) = decode_record(value) {
                        if filter.threads_only && !record.is_thread_starter {
                            return;
                        }
                        if !filter.include_deleted && record.is_deleted {
                            return;
                        }
                        results.push(record);
                    }
                });
            }
            None => {
                state.for_each("forum_posts", |_key, value| {
                    if let Ok(record) = decode_record(value) {
                        if let Some(thread_id) = &filter.thread_id {
                            if &record.thread_id != thread_id {
                                return;
                            }
                        }
                        if filter.threads_only && !record.is_thread_starter {
                            return;
                        }
                        if !filter.include_deleted && record.is_deleted {
                            return;
                        }
                        results.push(record);
                    }
                });
            }
        }
        apply_limit(&mut results, filter.limit);
        Ok(results)
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
            title: String::new(),
            tags: Vec::new(),
            votes_up: 0,
            votes_down: 0,
            is_solution: false,
            category: None,
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
            title: String::new(),
            tags: Vec::new(),
            votes_up: 0,
            votes_down: 0,
            is_solution: false,
            category: None,
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

    #[test]
    fn vote_increments_votes_up() {
        let state = ProjectionState::new();
        let proj = ForumProjection;
        let r = thread_starter();
        let event = make_event(1, "forum_thread_created", &r);
        proj.apply(&event, &state).unwrap();
        let post_id = format!("post_{:x}", event.commit_seq);
        let key = encode_key("ch_forum", &post_id, &post_id);

        // Apply a vote event
        use postcard::to_allocvec;
        let vote_payload = to_allocvec(&serde_json::json!({
            "post_id": post_id,
            "thread_id": post_id,
            "channel_id": "ch_forum",
            "direction": "up",
            "actor_user_id": 99u64,
        })).unwrap();
        // Manually construct a vote payload as postcard-serialized struct
        // Actually we need to use the same format as the projection handler expects
        #[derive(Serialize)]
        struct TestVotePayload {
            post_id: String,
            thread_id: String,
            channel_id: String,
            direction: String,
            actor_user_id: u64,
        }
        let vote_payload = to_allocvec(&TestVotePayload {
            post_id: post_id.clone(),
            thread_id: post_id.clone(),
            channel_id: "ch_forum".into(),
            direction: "up".into(),
            actor_user_id: 99,
        }).unwrap();
        let vote_event = DurableEvent {
            commit_seq: 2,
            stream_id: "ch_forum".into(),
            event_type: "forum_post_voted".into(),
            payload: vote_payload,
        };
        proj.apply(&vote_event, &state).unwrap();

        let decoded = decode_record(&state.get("forum_posts", &key).unwrap()).unwrap();
        assert_eq!(decoded.votes_up, 1);
        assert_eq!(decoded.votes_down, 0);
    }

    #[test]
    fn mark_solution_sets_flag_and_clears_siblings() {
        let state = ProjectionState::new();
        let proj = ForumProjection;
        // Create a thread
        let r = thread_starter();
        let thread_event = make_event(1, "forum_thread_created", &r);
        proj.apply(&thread_event, &state).unwrap();
        let thread_id = format!("post_{:x}", thread_event.commit_seq);

        // Add two replies
        let mut reply1 = thread_starter();
        reply1.thread_id = thread_id.clone();
        reply1.body = "Reply 1".into();
        reply1.is_thread_starter = false;
        let reply1_event = make_event(2, "forum_post_created", &reply1);
        proj.apply(&reply1_event, &state).unwrap();
        let reply1_id = format!("post_{:x}", reply1_event.commit_seq);

        let mut reply2 = thread_starter();
        reply2.thread_id = thread_id.clone();
        reply2.body = "Reply 2".into();
        reply2.is_thread_starter = false;
        let reply2_event = make_event(3, "forum_post_created", &reply2);
        proj.apply(&reply2_event, &state).unwrap();
        let reply2_id = format!("post_{:x}", reply2_event.commit_seq);

        // Mark reply1 as solution
        use postcard::to_allocvec;
        #[derive(Serialize)]
        struct TestSolutionPayload {
            post_id: String,
            thread_id: String,
            channel_id: String,
            actor_user_id: u64,
        }
        let sol_payload = to_allocvec(&TestSolutionPayload {
            post_id: reply1_id.clone(),
            thread_id: thread_id.clone(),
            channel_id: "ch_forum".into(),
            actor_user_id: 42,
        }).unwrap();
        let sol_event = DurableEvent {
            commit_seq: 4,
            stream_id: "ch_forum".into(),
            event_type: "forum_post_solution_set".into(),
            payload: sol_payload,
        };
        proj.apply(&sol_event, &state).unwrap();

        // Check reply1 is solution
        let key1 = encode_key("ch_forum", &thread_id, &reply1_id);
        let decoded1 = decode_record(&state.get("forum_posts", &key1).unwrap()).unwrap();
        assert!(decoded1.is_solution);

        // Check reply2 is NOT solution
        let key2 = encode_key("ch_forum", &thread_id, &reply2_id);
        let decoded2 = decode_record(&state.get("forum_posts", &key2).unwrap()).unwrap();
        assert!(!decoded2.is_solution);

        // Now mark reply2 as solution — reply1 should be cleared
        let sol_payload2 = to_allocvec(&TestSolutionPayload {
            post_id: reply2_id.clone(),
            thread_id: thread_id.clone(),
            channel_id: "ch_forum".into(),
            actor_user_id: 42,
        }).unwrap();
        let sol_event2 = DurableEvent {
            commit_seq: 5,
            stream_id: "ch_forum".into(),
            event_type: "forum_post_solution_set".into(),
            payload: sol_payload2,
        };
        proj.apply(&sol_event2, &state).unwrap();

        let decoded1b = decode_record(&state.get("forum_posts", &key1).unwrap()).unwrap();
        assert!(!decoded1b.is_solution);

        let decoded2b = decode_record(&state.get("forum_posts", &key2).unwrap()).unwrap();
        assert!(decoded2b.is_solution);
    }

    #[test]
    fn thread_created_round_trips_title() {
        let state = ProjectionState::new();
        let proj = ForumProjection;
        let mut r = thread_starter();
        r.title = "My Thread Title".into();
        r.tags = vec!["bug".into(), "discussion".into()];
        r.category = Some("general".into());
        let event = make_event(1, "forum_thread_created", &r);
        proj.apply(&event, &state).unwrap();
        let post_id = format!("post_{:x}", event.commit_seq);
        let loaded = ForumProjection::get_post(&state, "ch_forum", &post_id, &post_id).unwrap().unwrap();
        assert_eq!(loaded.title, "My Thread Title");
        assert_eq!(loaded.tags, vec!["bug", "discussion"]);
        assert_eq!(loaded.category, Some("general".into()));
    }

    // --- ForumProjection query tests ---------------------------------------

    #[test]
    fn query_by_channel_uses_prefix() {
        let state = ProjectionState::new();
        let proj = ForumProjection;
        for seq in 1..=2 {
            let mut r = thread_starter();
            r.body = format!("Thread {seq}");
            proj.apply(&make_event(seq, "forum_thread_created", &r), &state).unwrap();
        }
        let other = thread_starter();
        proj.apply(&make_event(9, "forum_thread_created", &other), &state).unwrap();

        let results = proj.query(&state, &ForumFilter { channel_id: Some("ch_forum".into()), ..Default::default() }).unwrap();
        assert_eq!(results.len(), 3);
        assert!(results.iter().all(|p| p.channel_id == "ch_forum"));
    }

    #[test]
    fn query_threads_only_returns_starters() {
        let state = ProjectionState::new();
        let proj = ForumProjection;
        let ev = make_event(1, "forum_thread_created", &thread_starter());
        proj.apply(&ev, &state).unwrap();
        let thread_id = format!("post_{:x}", ev.commit_seq);
        for seq in 2..=3 {
            let mut reply = thread_starter();
            reply.thread_id = thread_id.clone();
            reply.body = format!("Reply {seq}");
            reply.is_thread_starter = false;
            proj.apply(&make_event(seq, "forum_post_created", &reply), &state).unwrap();
        }
        let threads = proj.query(&state, &ForumFilter { channel_id: Some("ch_forum".into()), threads_only: true, ..Default::default() }).unwrap();
        assert_eq!(threads.len(), 1);
        assert!(threads[0].is_thread_starter);
    }

    #[test]
    fn query_by_thread_narrows() {
        let state = ProjectionState::new();
        let proj = ForumProjection;
        let ev = make_event(1, "forum_thread_created", &thread_starter());
        proj.apply(&ev, &state).unwrap();
        let thread_id = format!("post_{:x}", ev.commit_seq);
        for seq in 2..=4 {
            let mut reply = thread_starter();
            reply.thread_id = thread_id.clone();
            reply.body = format!("Reply {seq}");
            reply.is_thread_starter = false;
            proj.apply(&make_event(seq, "forum_post_created", &reply), &state).unwrap();
        }
        let results = proj.query(&state, &ForumFilter { channel_id: Some("ch_forum".into()), thread_id: Some(thread_id), ..Default::default() }).unwrap();
        assert_eq!(results.len(), 4);
    }

    #[test]
    fn query_filters_deleted_threads() {
        let state = ProjectionState::new();
        let proj = ForumProjection;
        for seq in 1..=2 {
            let mut r = thread_starter();
            r.body = format!("Thread {seq}");
            proj.apply(&make_event(seq, "forum_thread_created", &r), &state).unwrap();
        }
        let key = encode_key("ch_forum", &format!("post_{:x}", 2), &format!("post_{:x}", 2));
        let stored = state.get("forum_posts", &key).unwrap();
        let mut deleted = decode_record(&stored).unwrap();
        deleted.is_deleted = true;
        proj.apply(&make_event(3, "forum_post_deleted", &deleted), &state).unwrap();

        assert_eq!(proj.query(&state, &ForumFilter { channel_id: Some("ch_forum".into()), ..Default::default() }).unwrap().len(), 1);
        assert_eq!(proj.query(&state, &ForumFilter { channel_id: Some("ch_forum".into()), include_deleted: true, ..Default::default() }).unwrap().len(), 2);
    }

    #[test]
    fn query_limit_truncates() {
        let state = ProjectionState::new();
        let proj = ForumProjection;
        for seq in 1..=4 {
            let mut r = thread_starter();
            r.body = format!("Thread {seq}");
            proj.apply(&make_event(seq, "forum_thread_created", &r), &state).unwrap();
        }
        let results = proj.query(&state, &ForumFilter { channel_id: Some("ch_forum".into()), limit: Some(2), ..Default::default() }).unwrap();
        assert_eq!(results.len(), 2);
    }
}
