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

// ---------------------------------------------------------------------------
// LoreFileChangeRecord — per-file change feed (the sync protocol's cursor log)
// ---------------------------------------------------------------------------

/// One durable per-file change. `seq` is the engine commit_seq — a monotonic
/// cursor sync clients advance over (`GET /repos/{id}/changes?since=<seq>`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LoreFileChangeRecord {
    pub seq: u64,
    pub channel_id: i64,
    pub path: String,
    /// "upload" | "delete" | "snapshot"
    pub action: String,
    /// Content etag after the change (None for deletes).
    pub etag: Option<String>,
    /// Lore commit hash the change landed in.
    pub revision: String,
    pub author_user_id: i64,
    pub timestamp_micros: i64,
}

impl RecordCodec for LoreFileChangeRecord {
    fn codec_name() -> &'static str {
        "lore_file_changes"
    }
}

pub fn encode_change_record(r: &LoreFileChangeRecord) -> Vec<u8> {
    postcard::to_allocvec(r).expect("postcard serialization failed")
}

pub fn decode_change_record(buf: &[u8]) -> Result<LoreFileChangeRecord> {
    postcard::from_bytes(buf).map_err(|e| crate::error::WabiError::Corrupt {
        location: "lore file-change projection".into(),
        detail: format!("postcard decode failed: {e}"),
    })
}

/// Key = channel_id (LE) + seq (BE) so a prefix scan over the channel bytes
/// yields changes in ascending commit order.
pub fn encode_change_key(channel_id: i64, seq: u64) -> Vec<u8> {
    let mut buf = Vec::new();
    buf.extend_from_slice(&channel_id.to_le_bytes());
    buf.extend_from_slice(&seq.to_be_bytes());
    buf
}

pub struct LoreFileChangeProjection;

impl Projection for LoreFileChangeProjection {
    fn event_type(&self) -> &str {
        "lore_file_change"
    }

    fn event_types(&self) -> Vec<&str> {
        vec!["lore_file_change"]
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let mut record: LoreFileChangeRecord = decode_change_record(&event.payload)?;
        // The commit_seq is the authoritative cursor — take it from the event
        // envelope, not the (client-untrusted) payload.
        record.seq = event.commit_seq;
        let key = encode_change_key(record.channel_id, record.seq);
        let value = encode_change_record(&record);
        state.insert("lore_file_changes", key, value, event.commit_seq);
        Ok(())
    }
}

impl LoreFileChangeProjection {
    /// Changes for a channel with `seq > since`, oldest first.
    pub fn list_changes(
        state: &ProjectionState,
        channel_id: i64,
        since: u64,
    ) -> Result<Vec<LoreFileChangeRecord>> {
        let prefix = channel_id.to_le_bytes().to_vec();
        let mut results = Vec::new();
        state.prefix_scan("lore_file_changes", &prefix, |key, value| {
            if key.len() != 16 {
                return;
            }
            let seq_bytes: [u8; 8] = key[8..].try_into().unwrap_or([0xff; 8]);
            let seq = u64::from_be_bytes(seq_bytes);
            if seq > since {
                if let Ok(record) = decode_change_record(value) {
                    results.push(record);
                }
            }
        });
        Ok(results)
    }
}

// ---------------------------------------------------------------------------
// LoreTokenRecord — server-minted external-tool connect tokens (hashed)
// ---------------------------------------------------------------------------

/// A connect token for one channel's repo. Only the SHA-256 of the opaque
/// token is persisted — the plaintext exists exactly once, in the mint
/// response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LoreTokenRecord {
    pub token_hash: String,
    pub channel_id: i64,
    pub user_id: i64,
    /// "read" or "read,write"
    pub scopes: String,
    pub created_at_micros: i64,
    pub revoked: bool,
}

impl RecordCodec for LoreTokenRecord {
    fn codec_name() -> &'static str {
        "lore_tokens"
    }
}

pub fn encode_token_record(r: &LoreTokenRecord) -> Vec<u8> {
    postcard::to_allocvec(r).expect("postcard serialization failed")
}

pub fn decode_token_record(buf: &[u8]) -> Result<LoreTokenRecord> {
    postcard::from_bytes(buf).map_err(|e| crate::error::WabiError::Corrupt {
        location: "lore token projection".into(),
        detail: format!("postcard decode failed: {e}"),
    })
}

pub fn encode_token_key(token_hash: &str) -> Vec<u8> {
    token_hash.as_bytes().to_vec()
}

pub struct LoreTokenProjection;

impl Projection for LoreTokenProjection {
    fn event_type(&self) -> &str {
        "lore_token_minted"
    }

    fn event_types(&self) -> Vec<&str> {
        vec!["lore_token_minted", "lore_token_revoked"]
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        match event.event_type.as_str() {
            "lore_token_minted" => {
                let record: LoreTokenRecord = decode_token_record(&event.payload)?;
                let key = encode_token_key(&record.token_hash);
                let value = encode_token_record(&record);
                state.insert("lore_tokens", key, value, event.commit_seq);
                Ok(())
            }
            "lore_token_revoked" => {
                let token_hash = String::from_utf8_lossy(&event.payload).to_string();
                let key = encode_token_key(&token_hash);
                state.remove("lore_tokens", &key);
                Ok(())
            }
            _ => Ok(()),
        }
    }
}

impl LoreTokenProjection {
    pub fn get_token(state: &ProjectionState, token_hash: &str) -> Result<Option<LoreTokenRecord>> {
        let key = encode_token_key(token_hash);
        match state.get("lore_tokens", &key) {
            None => Ok(None),
            Some(bytes) => decode_token_record(&bytes).map(Some),
        }
    }

    /// Non-revoked tokens for a channel (for the management list UI).
    pub fn list_tokens(state: &ProjectionState, channel_id: i64) -> Result<Vec<LoreTokenRecord>> {
        let mut results = Vec::new();
        state.for_each("lore_tokens", |_key, value| {
            if let Ok(record) = decode_token_record(value) {
                if record.channel_id == channel_id && !record.revoked {
                    results.push(record);
                }
            }
        });
        Ok(results)
    }
}

// ---------------------------------------------------------------------------
// LoreBindingRecord — chat-channel → repo path binding ("pipe")
//
// One binding per channel. Mode is stored as a string ("none"|"direct"|"stage"|"hybrid")
// rather than an enum so adding modes later never breaks postcard replay of older
// events (golden rule 5).
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LoreBindingRecord {
    pub channel_id: i64,
    pub repo_channel_id: i64,
    pub path: String,
    pub branch: String,
    pub mode: String,
    pub allowed_types: Vec<String>,
    pub auto_stage: bool,
    pub updated_by: i64,
    pub updated_at_micros: i64,
}

impl RecordCodec for LoreBindingRecord {
    fn codec_name() -> &'static str {
        "lore_bindings"
    }
}

pub fn encode_binding_record(r: &LoreBindingRecord) -> Vec<u8> {
    postcard::to_allocvec(r).expect("postcard serialization failed")
}

pub fn decode_binding_record(buf: &[u8]) -> Result<LoreBindingRecord> {
    postcard::from_bytes(buf).map_err(|e| crate::error::WabiError::Corrupt {
        location: "lore binding projection".into(),
        detail: format!("postcard decode failed: {e}"),
    })
}

impl LoreBindingProjection {
    /// Look up a channel's Lore binding.
    pub fn get_binding(state: &ProjectionState, channel_id: i64) -> Result<Option<LoreBindingRecord>> {
        let key = channel_id.to_le_bytes().to_vec();
        match state.get("lore_bindings", &key) {
            None => Ok(None),
            Some(bytes) => decode_binding_record(&bytes).map(Some),
        }
    }

    /// All bindings (for startup wiring and admin surfaces).
    pub fn list_bindings(state: &ProjectionState) -> Result<Vec<LoreBindingRecord>> {
        let mut results = Vec::new();
        state.for_each("lore_bindings", |_key, value| {
            if let Ok(record) = decode_binding_record(value) {
                results.push(record);
            }
        });
        Ok(results)
    }
}

pub struct LoreBindingProjection;

impl Projection for LoreBindingProjection {
    fn event_type(&self) -> &str {
        "lore_binding_set"
    }

    fn event_types(&self) -> Vec<&str> {
        vec!["lore_binding_set", "lore_binding_removed"]
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        match event.event_type.as_str() {
            "lore_binding_set" => {
                let record: LoreBindingRecord = decode_binding_record(&event.payload)?;
                let key = record.channel_id.to_le_bytes().to_vec();
                state.insert(
                    "lore_bindings",
                    key,
                    encode_binding_record(&record),
                    event.commit_seq,
                );
                Ok(())
            }
            "lore_binding_removed" => {
                let channel_id_bytes: [u8; 8] = event.payload[..8].try_into().map_err(|_| {
                    crate::error::WabiError::Corrupt {
                        location: "lore binding projection".into(),
                        detail: "invalid channel_id in remove payload".into(),
                    }
                })?;
                let key = i64::from_le_bytes(channel_id_bytes).to_le_bytes().to_vec();
                state.remove("lore_bindings", &key);
                Ok(())
            }
            _ => Ok(()),
        }
    }
}

// ---------------------------------------------------------------------------
// LorePromoteRecord — provenance for attachments promoted from chat into Lore
//
// This is the durable link between a chat message/attachment and the Lore
// commit (or pending review branch) it produced. It deliberately outlives the
// chat message: deleting the message never removes this record (spec
// 2026-08-28, settled decision 7/9).
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LorePromoteRecord {
    pub message_id: String,
    pub channel_id: i64,
    pub repo_channel_id: i64,
    /// Attachment URL as it appeared on the message (`/uploads/{filename}`).
    pub file_url: String,
    pub file_name: String,
    pub path: String,
    pub branch: String,
    /// "direct" | "stage" — the mode actually used at promote time.
    pub mode: String,
    pub revision_hash: String,
    pub pending_review: bool,
    pub review_branch: Option<String>,
    pub promoted_by: i64,
    pub timestamp_micros: i64,
}

impl RecordCodec for LorePromoteRecord {
    fn codec_name() -> &'static str {
        "lore_promotes"
    }
}

pub fn encode_promote_record(r: &LorePromoteRecord) -> Vec<u8> {
    postcard::to_allocvec(r).expect("postcard serialization failed")
}

pub fn decode_promote_record(buf: &[u8]) -> Result<LorePromoteRecord> {
    postcard::from_bytes(buf).map_err(|e| crate::error::WabiError::Corrupt {
        location: "lore promote projection".into(),
        detail: format!("postcard decode failed: {e}"),
    })
}

/// Key: channel_id (8 LE) + message_id + 0x00 + file_url.
pub fn encode_promote_key(channel_id: i64, message_id: &str, file_url: &str) -> Vec<u8> {
    let mut buf = Vec::new();
    buf.extend_from_slice(&channel_id.to_le_bytes());
    buf.extend_from_slice(message_id.as_bytes());
    buf.push(0);
    buf.extend_from_slice(file_url.as_bytes());
    buf
}

impl LorePromoteProjection {
    /// All promotes originating from a message (one per attachment promoted).
    pub fn promotes_for_message(state: &ProjectionState, message_id: &str) -> Result<Vec<LorePromoteRecord>> {
        let mut results = Vec::new();
        state.for_each("lore_promotes", |_key, value| {
            if let Ok(record) = decode_promote_record(value) {
                if record.message_id == message_id {
                    results.push(record);
                }
            }
        });
        Ok(results)
    }

    /// Promotes originating from a channel (prefix scan on channel_id).
    pub fn promotes_for_channel(state: &ProjectionState, channel_id: i64) -> Result<Vec<LorePromoteRecord>> {
        let prefix = channel_id.to_le_bytes().to_vec();
        let mut results = Vec::new();
        state.prefix_scan("lore_promotes", &prefix, |_key, value| {
            if let Ok(record) = decode_promote_record(value) {
                results.push(record);
            }
        });
        Ok(results)
    }
}

pub struct LorePromoteProjection;

impl Projection for LorePromoteProjection {
    fn event_type(&self) -> &str {
        "lore_promoted"
    }

    fn event_types(&self) -> Vec<&str> {
        vec!["lore_promoted"]
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let record: LorePromoteRecord = decode_promote_record(&event.payload)?;
        let key = encode_promote_key(record.channel_id, &record.message_id, &record.file_url);
        state.insert("lore_promotes", key, encode_promote_record(&record), event.commit_seq);
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

    fn sample_change(seq: u64) -> LoreFileChangeRecord {
        LoreFileChangeRecord {
            seq,
            channel_id: 42,
            path: format!("src/file{seq}.rs"),
            action: "upload".into(),
            etag: Some(format!("etag{seq}")),
            revision: format!("rev{seq}"),
            author_user_id: 7,
            timestamp_micros: 1_000_000_000 + seq as i64,
        }
    }

    fn make_change_event(seq: u64, record: &LoreFileChangeRecord) -> DurableEvent {
        DurableEvent {
            commit_seq: seq,
            stream_id: record.channel_id.to_string(),
            event_type: "lore_file_change".to_string(),
            payload: encode_change_record(record),
        }
    }

    #[test]
    fn file_change_feed_is_cursor_ordered() {
        let state = ProjectionState::new();
        let proj = LoreFileChangeProjection;
        for seq in 1..=4 {
            proj.apply(&make_change_event(seq, &sample_change(seq)), &state).unwrap();
        }
        // since=0 → all, ascending
        let all = LoreFileChangeProjection::list_changes(&state, 42, 0).unwrap();
        assert_eq!(all.len(), 4);
        assert!(all.windows(2).all(|w| w[0].seq < w[1].seq));
        // since=2 → only seq 3 and 4
        let tail = LoreFileChangeProjection::list_changes(&state, 42, 2).unwrap();
        assert_eq!(tail.iter().map(|r| r.seq).collect::<Vec<_>>(), vec![3, 4]);
        // other channels see nothing
        assert!(LoreFileChangeProjection::list_changes(&state, 43, 0).unwrap().is_empty());
    }

    #[test]
    fn file_change_seq_is_taken_from_event_envelope() {
        let state = ProjectionState::new();
        let proj = LoreFileChangeProjection;
        // Payload claims seq=99, but the envelope's commit_seq (5) must win.
        let mut r = sample_change(99);
        r.seq = 99;
        let event = DurableEvent {
            commit_seq: 5,
            stream_id: "42".into(),
            event_type: "lore_file_change".to_string(),
            payload: encode_change_record(&r),
        };
        proj.apply(&event, &state).unwrap();
        let changes = LoreFileChangeProjection::list_changes(&state, 42, 0).unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].seq, 5);
    }

    #[test]
    fn token_mint_lookup_revoke() {
        let state = ProjectionState::new();
        let proj = LoreTokenProjection;
        let record = LoreTokenRecord {
            token_hash: "deadbeef".into(),
            channel_id: 42,
            user_id: 7,
            scopes: "read,write".into(),
            created_at_micros: 1,
            revoked: false,
        };
        let mint = DurableEvent {
            commit_seq: 1,
            stream_id: "42".into(),
            event_type: "lore_token_minted".to_string(),
            payload: encode_token_record(&record),
        };
        proj.apply(&mint, &state).unwrap();

        let got = LoreTokenProjection::get_token(&state, "deadbeef").unwrap().unwrap();
        assert_eq!(got.channel_id, 42);
        assert_eq!(got.scopes, "read,write");
        assert_eq!(LoreTokenProjection::list_tokens(&state, 42).unwrap().len(), 1);

        let revoke = DurableEvent {
            commit_seq: 2,
            stream_id: "42".into(),
            event_type: "lore_token_revoked".to_string(),
            payload: b"deadbeef".to_vec(),
        };
        proj.apply(&revoke, &state).unwrap();
        assert!(LoreTokenProjection::get_token(&state, "deadbeef").unwrap().is_none());
        assert!(LoreTokenProjection::list_tokens(&state, 42).unwrap().is_empty());
    }

    #[test]
    fn binding_set_get_remove() {
        let state = ProjectionState::new();
        let proj = LoreBindingProjection;
        let record = LoreBindingRecord {
            channel_id: 7,
            repo_channel_id: 42,
            path: "/art/concepts/".into(),
            branch: "main".into(),
            mode: "hybrid".into(),
            allowed_types: vec!["image/*".into()],
            auto_stage: false,
            updated_by: 3,
            updated_at_micros: 1,
        };
        let set = DurableEvent {
            commit_seq: 1,
            stream_id: "7".into(),
            event_type: "lore_binding_set".to_string(),
            payload: encode_binding_record(&record),
        };
        proj.apply(&set, &state).unwrap();

        let got = LoreBindingProjection::get_binding(&state, 7).unwrap().unwrap();
        assert_eq!(got.repo_channel_id, 42);
        assert_eq!(got.mode, "hybrid");
        assert_eq!(got.allowed_types, vec!["image/*".to_string()]);
        assert_eq!(LoreBindingProjection::list_bindings(&state).unwrap().len(), 1);

        let remove = DurableEvent {
            commit_seq: 2,
            stream_id: "7".into(),
            event_type: "lore_binding_removed".to_string(),
            payload: 7i64.to_le_bytes().to_vec(),
        };
        proj.apply(&remove, &state).unwrap();
        assert!(LoreBindingProjection::get_binding(&state, 7).unwrap().is_none());
        assert!(LoreBindingProjection::list_bindings(&state).unwrap().is_empty());
    }

    #[test]
    fn promote_record_roundtrip_and_queries() {
        let state = ProjectionState::new();
        let proj = LorePromoteProjection;
        let record = LorePromoteRecord {
            message_id: "msg_abc".into(),
            channel_id: 7,
            repo_channel_id: 42,
            file_url: "/uploads/x.png".into(),
            file_name: "x.png".into(),
            path: "/art/x.png".into(),
            branch: "main".into(),
            mode: "direct".into(),
            revision_hash: "abc123".into(),
            pending_review: false,
            review_branch: None,
            promoted_by: 3,
            timestamp_micros: 1,
        };
        let ev = DurableEvent {
            commit_seq: 1,
            stream_id: "7".into(),
            event_type: "lore_promoted".to_string(),
            payload: encode_promote_record(&record),
        };
        proj.apply(&ev, &state).unwrap();

        assert_eq!(LorePromoteProjection::promotes_for_message(&state, "msg_abc").unwrap().len(), 1);
        assert_eq!(LorePromoteProjection::promotes_for_channel(&state, 7).unwrap().len(), 1);
        assert!(LorePromoteProjection::promotes_for_channel(&state, 9).unwrap().is_empty());

        // Re-promote of the same attachment replaces (idempotent key).
        let mut updated = record.clone();
        updated.revision_hash = "def456".into();
        let ev2 = DurableEvent {
            commit_seq: 2,
            stream_id: "7".into(),
            event_type: "lore_promoted".to_string(),
            payload: encode_promote_record(&updated),
        };
        proj.apply(&ev2, &state).unwrap();
        let got = LorePromoteProjection::promotes_for_message(&state, "msg_abc").unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].revision_hash, "def456");
    }
}
