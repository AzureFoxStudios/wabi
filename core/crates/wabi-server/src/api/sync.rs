//! Database replication sync endpoints.
//!
//! These endpoints implement the wire protocol for peer-to-peer commit-index
//! replication. They are used by the background `SyncWorker` (wabidb
//! replication module) to pull/push commit index entries between nodes.
//!
//! ## Security
//!
//! These endpoints ARE NOT authenticated — replication traffic runs over
//! a mutually-authenticated TLS connection between known peer endpoints.
//! In production, deploy these behind a VPN or WireGuard tunnel.
//! A future iteration should add HMAC request signing.
//!
//! ## Status
//!
//! The endpoint handlers are functional (they read/write commit index
//! entries via the engine). The background sync worker loop in wabidb's
//! replication module is wired to the engine but uses a `NoopTransport`
//! by default. To enable active replication:
//!
//! 1. Create a `reqwest`-based `SyncTransport` implementation.
//! 2. Pass it via `WabiDbConfig::sync_transport`.
//! 3. Set `WabiDbConfig::replication_config` with the peer endpoint.
//!
//! See `docs/wabidb-kanban.md` (item 4) for the current replication status.

use axum::{extract::State, Json, Router};
use axum::routing::{get, post};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tracing::info;

use crate::state::AppState;

/// Pull request: ask for entries committed after `since_commit_seq`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPullRequest {
    pub since_commit_seq: u64,
}

/// Sync response: entries sorted by `commit_seq`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPullResponse {
    pub latest_commit_seq: u64,
    pub entries: Vec<SyncEntry>,
}

/// A single commit-index entry in the sync protocol.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncEntry {
    pub commit_seq: u64,
    pub timestamp_micros: i64,
    pub caller_user_id: u64,
    #[serde(with = "hex")]
    pub caller_device_id_hash: [u8; 16],
    #[serde(with = "hex")]
    pub command_name_hash: [u8; 16],
    pub has_idempotency_key: bool,
    #[serde(default, with = "hex::option")]
    pub idempotency_key_hash: Option<[u8; 32]>,
    pub event_refs: Vec<StreamRefEntry>,
    #[serde(default)]
    pub payload_hashes: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamRefEntry {
    pub stream_id_hash: String,
    pub stream_id: String,
    pub stream_kind: u8,
    pub segment_id: u64,
    pub offset: u32,
    pub length: u32,
}

/// Segment data shipped alongside push entries.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushedSegment {
    pub stream_id: String,
    pub stream_kind: u8,
    pub segment_id: u64,
    /// Raw bytes of the `.wseg` file.
    #[serde(with = "base64_data")]
    pub data: Vec<u8>,
}

/// Push request: receive entries + segment data from a peer.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPushRequest {
    pub entries: Vec<SyncEntry>,
    #[serde(default)]
    pub segments: Vec<PushedSegment>,
}

/// Stub push response.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPushResponse {
    pub accepted: usize,
    pub skipped: usize,
}

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/pull", post(handle_pull))
        .route("/push", post(handle_push))
        .route("/status", get(handle_status))
        .with_state(state)
}

/// Handle a pull request: return entries after `since_commit_seq`.
async fn handle_pull(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SyncPullRequest>,
) -> Result<Json<SyncPullResponse>, crate::error::AppError> {
    let engine = state.wdb.engine();
    let data_dir = engine.data_dir();
    let commit_index_dir = data_dir.join("global").join("commit-index");

    let all_entries = wabidb::commit_index::batcher::read_all_entries(&commit_index_dir)
        .map_err(|e| crate::error::AppError::Internal(format!("read_all_entries: {e}")))?;

    let entries_since: Vec<SyncEntry> = all_entries
        .iter()
        .filter(|e| e.commit_seq > req.since_commit_seq)
        .take(10_000)
        .map(|e| SyncEntry {
            commit_seq: e.commit_seq,
            timestamp_micros: e.timestamp_micros,
            caller_user_id: e.caller_user_id,
            caller_device_id_hash: e.caller_device_id_hash,
            command_name_hash: e.command_name_hash,
            has_idempotency_key: e.has_idempotency_key,
            idempotency_key_hash: e.idempotency_key_hash,
            event_refs: e.event_refs.iter().map(|r| StreamRefEntry {
                stream_id_hash: ::hex::encode(r.stream_id_hash),
                stream_id: String::new(),
                stream_kind: r.stream_kind,
                segment_id: r.segment_id,
                offset: r.offset,
                length: r.length,
            }).collect(),
            payload_hashes: e.payload_hashes.iter().map(::hex::encode).collect(),
        })
        .collect();

    let latest = all_entries.last().map(|e| e.commit_seq).unwrap_or(0);

    info!(
        "sync/pull: since={}, returned={}, latest={}",
        req.since_commit_seq,
        entries_since.len(),
        latest
    );

    Ok(Json(SyncPullResponse {
        latest_commit_seq: latest,
        entries: entries_since,
    }))
}

/// Handle a push request: accept entries + segment data from a peer.
///
/// Writes each segment to the correct stream events directory, then
/// appends each commit index entry to the local batcher.
async fn handle_push(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SyncPushRequest>,
) -> Result<Json<SyncPushResponse>, crate::error::AppError> {
    let engine = state.wdb.engine();

    for entry in &req.entries {
        let segments: Vec<(String, u8, u64, Vec<u8>)> = req
            .segments
            .iter()
            .filter_map(|s| {
                let referenced = entry.event_refs.iter().any(|r| {
                    r.stream_id == s.stream_id
                        && r.stream_kind == s.stream_kind
                        && r.segment_id == s.segment_id
                });
                if referenced {
                    Some((s.stream_id.clone(), s.stream_kind, s.segment_id, s.data.clone()))
                } else {
                    None
                }
            })
            .collect();

        let commit_entry = wabidb::commit_index::record::CommitIndexEntry {
            commit_seq: entry.commit_seq,
            timestamp_micros: entry.timestamp_micros,
            caller_user_id: entry.caller_user_id,
            caller_device_id_hash: entry.caller_device_id_hash,
            command_name_hash: entry.command_name_hash,
            has_idempotency_key: entry.has_idempotency_key,
            idempotency_key_hash: entry.idempotency_key_hash,
            event_refs: entry.event_refs.iter().map(|r| {
                let mut hash = [0u8; 16];
                if let Ok(h) = ::hex::decode_to_slice(&r.stream_id_hash, &mut hash) {
                    let _ = h;
                }
                wabidb::commit_index::record::StreamRef {
                    stream_id_hash: hash,
                    stream_kind: r.stream_kind,
                    segment_id: r.segment_id,
                    offset: r.offset,
                    length: r.length,
                }
            }).collect(),
            payload_hashes: entry.payload_hashes.iter().filter_map(|h| {
                let mut out = [0u8; 32];
                ::hex::decode_to_slice(h, &mut out).ok()?;
                Some(out)
            }).collect(),
        };

        engine
            .ingest_replicated_commit(commit_entry, segments)
            .await
            .map_err(|e| crate::error::AppError::Internal(format!("ingest: {e}")))?;
    }

    info!(
        "sync/push: accepted={}, segments={}",
        req.entries.len(),
        req.segments.len(),
    );

    Ok(Json(SyncPushResponse {
        accepted: req.entries.len(),
        skipped: 0,
    }))
}

/// Status endpoint: returns the local node's latest commit_seq.
async fn handle_status(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, crate::error::AppError> {
    let engine = state.wdb.engine();
    let data_dir = engine.data_dir();
    let commit_index_dir = data_dir.join("global").join("commit-index");

    let all_entries = wabidb::commit_index::batcher::read_all_entries(&commit_index_dir)
        .map_err(|e| crate::error::AppError::Internal(format!("read_all_entries: {e}")))?;

    let latest = all_entries.last().map(|e| e.commit_seq).unwrap_or(0);

    Ok(Json(serde_json::json!({
        "latestCommitSeq": latest,
        "totalEntries": all_entries.len(),
        "dataDir": data_dir.display().to_string(),
        "replication": "stub",
    })))
}

mod hex {
    //! Serde helpers for hex-encoded byte arrays.
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8; 16], s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(&format_args!("{}", ::hex::encode(bytes)))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<[u8; 16], D::Error> {
        let s = String::deserialize(d)?;
        let mut out = [0u8; 16];
        ::hex::decode_to_slice(&s, &mut out).map_err(serde::de::Error::custom)?;
        Ok(out)
    }

    pub mod option {
        use serde::{Deserialize, Deserializer, Serializer};

        pub fn serialize<S: Serializer>(v: &Option<[u8; 32]>, s: S) -> Result<S::Ok, S::Error> {
            match v {
                Some(bytes) => s.collect_str(&format_args!("{}", ::hex::encode(bytes))),
                None => s.serialize_none(),
            }
        }

        pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<[u8; 32]>, D::Error> {
            let s: Option<String> = Option::deserialize(d)?;
            match s {
                Some(hex_str) => {
                    let mut out = [0u8; 32];
                    ::hex::decode_to_slice(&hex_str, &mut out).map_err(serde::de::Error::custom)?;
                    Ok(Some(out))
                }
                None => Ok(None),
            }
        }
    }
}

mod base64_data {
    //! Serde helpers for base64-encoded binary data.
    use base64::Engine;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &Vec<u8>, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(&format_args!("{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let s = String::deserialize(d)?;
        base64::engine::general_purpose::STANDARD.decode(&s).map_err(serde::de::Error::custom)
    }
}
