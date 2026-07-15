use crate::engine::locks::ProjectionState;
use crate::error::Result;
use crate::projections::codec::RecordCodec;
use crate::projections::handler::{DurableEvent, Projection};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// LoreRepoRecord — persisted registry of Lore repos attached to channels
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LoreRepoRecord {
    pub channel_id: i64,
    pub repo_name: String,
    pub lore_server_url: String,
    pub created_by: i64,
    pub created_at_micros: i64,
}

impl RecordCodec for LoreRepoRecord {
    fn codec_name() -> &'static str {
        "lore_repos"
    }
}

pub fn encode_repo_record(r: &LoreRepoRecord) -> Vec<u8> {
    postcard::to_allocvec(r).expect("postcard serialization failed")
}

pub fn decode_repo_record(buf: &[u8]) -> Result<LoreRepoRecord> {
    postcard::from_bytes(buf).map_err(|e| crate::error::WabiError::Corrupt {
        location: "lore repo projection".into(),
        detail: format!("postcard decode failed: {e}"),
    })
}

pub fn encode_repo_key(channel_id: i64) -> Vec<u8> {
    channel_id.to_le_bytes().to_vec()
}

impl LoreRepoProjection {
    /// Look up a Lore repo by channel_id.
    pub fn get_repo(state: &ProjectionState, channel_id: i64) -> Result<Option<LoreRepoRecord>> {
        let key = encode_repo_key(channel_id);
        match state.get("lore_repos", &key) {
            None => Ok(None),
            Some(bytes) => decode_repo_record(&bytes).map(Some),
        }
    }

    /// List all registered Lore repos.
    pub fn list_repos(state: &ProjectionState) -> Result<Vec<LoreRepoRecord>> {
        let mut results = Vec::new();
        state.for_each("lore_repos", |_key, value| {
            if let Ok(record) = decode_repo_record(value) {
                results.push(record);
            }
        });
        Ok(results)
    }
}

pub struct LoreRepoProjection;

impl Projection for LoreRepoProjection {
    fn event_type(&self) -> &str {
        "lore_repo_registered"
    }

    fn event_types(&self) -> Vec<&str> {
        vec!["lore_repo_registered", "lore_repo_deleted"]
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        match event.event_type.as_str() {
            "lore_repo_registered" => self.apply_registered(event, state),
            "lore_repo_deleted" => self.apply_deleted(event, state),
            _ => Ok(()),
        }
    }
}

impl LoreRepoProjection {
    fn apply_registered(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let record: LoreRepoRecord = decode_repo_record(&event.payload)?;
        let key = encode_repo_key(record.channel_id);
        let value = encode_repo_record(&record);
        state.insert("lore_repos", key, value, event.commit_seq);
        Ok(())
    }

    fn apply_deleted(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let channel_id_bytes: [u8; 8] = event.payload[..8].try_into().map_err(|_| {
            crate::error::WabiError::Corrupt {
                location: "lore repo projection".into(),
                detail: "invalid channel_id in delete payload".into(),
            }
        })?;
        let channel_id = i64::from_le_bytes(channel_id_bytes);
        let key = encode_repo_key(channel_id);
        state.remove("lore_repos", &key);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// LoreCommitRecord — individual file commits within a repo
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LoreCommitRecord {
    pub commit_hash: String,
    pub channel_id: i64,
    pub repo_name: String,
    pub file_path: String,
    pub message: String,
    pub author_user_id: i64,
    pub timestamp_micros: i64,
}

impl RecordCodec for LoreCommitRecord {
    fn codec_name() -> &'static str {
        "lore_commits"
    }
}

pub fn encode_record(r: &LoreCommitRecord) -> Vec<u8> {
    postcard::to_allocvec(r).expect("postcard serialization failed")
}

pub fn decode_record(buf: &[u8]) -> Result<LoreCommitRecord> {
    postcard::from_bytes(buf).map_err(|e| crate::error::WabiError::Corrupt {
        location: "lore projection".into(),
        detail: format!("postcard decode failed: {e}"),
    })
}

pub fn encode_key(channel_id: i64, commit_hash: &str) -> Vec<u8> {
    let mut buf = Vec::new();
    buf.extend_from_slice(&channel_id.to_le_bytes());
    buf.extend_from_slice(&(commit_hash.len() as u64).to_le_bytes());
    buf.extend_from_slice(commit_hash.as_bytes());
    buf
}

impl LoreCommitProjection {
    pub fn get_commit(state: &ProjectionState, channel_id: i64, commit_hash: &str) -> Result<Option<LoreCommitRecord>> {
        let key = encode_key(channel_id, commit_hash);
        match state.get("lore_commits", &key) {
            None => Ok(None),
            Some(bytes) => decode_record(&bytes).map(Some),
        }
    }

    pub fn list_commits(state: &ProjectionState, channel_id: i64) -> Result<Vec<LoreCommitRecord>> {
        let mut prefix = Vec::new();
        prefix.extend_from_slice(&channel_id.to_le_bytes());
        let mut results = Vec::new();
        state.prefix_scan("lore_commits", &prefix, |_key, value| {
            if let Ok(record) = decode_record(value) {
                results.push(record);
            }
        });
        Ok(results)
    }
}

pub struct LoreCommitProjection;

impl Projection for LoreCommitProjection {
    fn event_type(&self) -> &str {
        "lore_commit"
    }

    fn event_types(&self) -> Vec<&str> {
        vec!["lore_commit"]
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        match event.event_type.as_str() {
            "lore_commit" => self.apply_commit(event, state),
            _ => Ok(()),
        }
    }
}

impl LoreCommitProjection {
    fn apply_commit(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let record: LoreCommitRecord = decode_record(&event.payload)?;
        let key = encode_key(record.channel_id, &record.commit_hash);
        let value = encode_record(&record);
        state.insert("lore_commits", key, value, event.commit_seq);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::projections::handler::DispatchTable;
    use std::sync::Arc;

    fn sample_commit() -> LoreCommitRecord {
        LoreCommitRecord {
            commit_hash: "abc123def456".into(),
            channel_id: 42,
            repo_name: "project-assets".into(),
            file_path: "models/character.fbx".into(),
            message: "Initial upload of character model".into(),
            author_user_id: 1,
            timestamp_micros: 1_000_000_000,
        }
    }

    fn make_event(seq: u64, event_type: &str, record: &LoreCommitRecord) -> DurableEvent {
        DurableEvent {
            commit_seq: seq,
            stream_id: record.channel_id.to_string(),
            event_type: event_type.to_string(),
            payload: encode_record(record),
        }
    }

    #[test]
    fn encode_decode_roundtrip() {
        let r = sample_commit();
        let buf = encode_record(&r);
        let decoded = decode_record(&buf).unwrap();
        assert_eq!(r, decoded);
    }

    #[test]
    fn event_type_returns_correct() {
        let proj = LoreCommitProjection;
        assert_eq!(proj.event_type(), "lore_commit");
        assert!(proj.event_types().contains(&"lore_commit"));
    }

    #[test]
    fn insert_and_lookup() {
        let state = ProjectionState::new();
        let proj = LoreCommitProjection;
        let r = sample_commit();
        let event = make_event(1, "lore_commit", &r);
        proj.apply(&event, &state).unwrap();
        let key = encode_key(r.channel_id, &r.commit_hash);
        let stored = state.get("lore_commits", &key).unwrap();
        let decoded = decode_record(&stored).unwrap();
        assert_eq!(decoded.commit_hash, r.commit_hash);
        assert_eq!(decoded.file_path, r.file_path);
    }

    #[test]
    fn dispatch_table_routes_lore_events() {
        let table = DispatchTable::new(vec![Arc::new(LoreCommitProjection)]).unwrap();
        let state = ProjectionState::new();
        let r = sample_commit();
        let event = make_event(1, "lore_commit", &r);
        let handler = table.get("lore_commit").unwrap();
        handler.apply(&event, &state).unwrap();
        let key = encode_key(r.channel_id, &r.commit_hash);
        assert!(state.get("lore_commits", &key).is_some());
    }

    #[test]
    fn typed_get_commit_after_insert() {
        let state = ProjectionState::new();
        let proj = LoreCommitProjection;
        let r = sample_commit();
        let event = make_event(1, "lore_commit", &r);
        proj.apply(&event, &state).unwrap();
        let loaded = LoreCommitProjection::get_commit(&state, r.channel_id, &r.commit_hash).unwrap().unwrap();
        assert_eq!(loaded.commit_hash, r.commit_hash);
    }

    #[test]
    fn typed_list_commits_returns_all() {
        let state = ProjectionState::new();
        let proj = LoreCommitProjection;
        for i in 0..3 {
            let r = LoreCommitRecord {
                commit_hash: format!("hash{i:04x}"),
                channel_id: 42,
                repo_name: "test-repo".into(),
                file_path: format!("file{i}.bin"),
                message: format!("commit {i}"),
                author_user_id: 1,
                timestamp_micros: 1_000_000_000 + i * 1_000,
            };
            proj.apply(&make_event(i as u64 + 1, "lore_commit", &r), &state).unwrap();
        }
        let commits = LoreCommitProjection::list_commits(&state, 42).unwrap();
        assert_eq!(commits.len(), 3);
    }

    #[test]
    fn bad_payload_returns_error() {
        let state = ProjectionState::new();
        let event = DurableEvent {
            commit_seq: 1,
            stream_id: "42".into(),
            event_type: "lore_commit".into(),
            payload: vec![0xff, 0xff],
        };
        let result = LoreCommitProjection.apply(&event, &state);
        assert!(result.is_err());
    }
}
