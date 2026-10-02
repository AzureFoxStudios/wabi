//! Database replication sync endpoints.
//!
//! These endpoints implement the experimental commit-index wire protocol.
//! The Authority's engine worker currently pushes committed segment data to a
//! separate, durably fenced WabiDB-only receiver.
//!
//! ## Security and maturity
//!
//! Every endpoint requires both `WABIDB_EXPERIMENTAL_REPLICATION=true` and
//! the operator's `WABI_SYNC_TOKEN`. This is development-only transport; it
//! does not make a peer a recoverable Wabi standby. Inbound commits must be
//! received by a locally fenced WabiDB engine so a writable Authority cannot
//! have its segment files overwritten by a peer.
//!
//! ## Status
//!
//! The worker reads the receiver's applied position and sends missing commits
//! in bounded batches. Full instance state, safe promotion and cross-site
//! recovery remain separate acceptance gates.

use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{extract::State, Json, Router};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tracing::info;

use crate::state::AppState;

/// Sync token guard — mirrors the operator-secret pattern: constant-time
/// compare against WABI_SYNC_TOKEN env var. Returns Ok(()) on success,
/// or a 503/401 response on failure.
///
/// When WABI_SYNC_TOKEN is unset/empty, all sync routes return 503.
fn sync_token_guard(headers: &HeaderMap) -> Result<(), (StatusCode, &'static str)> {
    let expected = std::env::var("WABI_SYNC_TOKEN").unwrap_or_default();
    let enabled = std::env::var("WABIDB_EXPERIMENTAL_REPLICATION")
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .is_some_and(|value| matches!(value.as_str(), "1" | "true" | "yes"));
    sync_token_guard_with(headers, &expected, enabled)
}

fn sync_token_guard_with(
    headers: &HeaderMap,
    expected: &str,
    enabled: bool,
) -> Result<(), (StatusCode, &'static str)> {
    if !enabled {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "experimental sync is disabled",
        ));
    }
    if expected.is_empty() {
        return Err((StatusCode::SERVICE_UNAVAILABLE, "sync token not configured"));
    }
    let provided = headers
        .get("x-wabi-sync-token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    // Constant-time compare.
    if expected.len() != provided.len() {
        return Err((StatusCode::UNAUTHORIZED, "invalid sync token"));
    }
    let mut diff = 0u8;
    for (a, b) in expected.bytes().zip(provided.bytes()) {
        diff |= a ^ b;
    }
    if diff != 0 {
        return Err((StatusCode::UNAUTHORIZED, "invalid sync token"));
    }
    Ok(())
}

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
    /// Sender's commit-index fingerprint through the final included entry.
    /// Binds a batch to all earlier commits, including intentional seq gaps.
    pub target_prefix_fingerprint: String,
}

/// Number of commits successfully applied by the receiver.
#[derive(Debug, Serialize, Deserialize)]
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
    headers: HeaderMap,
    Json(req): Json<SyncPullRequest>,
) -> Result<Json<SyncPullResponse>, (StatusCode, &'static str)> {
    sync_token_guard(&headers)?;
    let engine = state.wdb.engine();
    let data_dir = engine.data_dir();
    let commit_index_dir = data_dir.join("global").join("commit-index");

    let all_entries =
        wabidb::commit_index::batcher::read_all_entries(&commit_index_dir).map_err(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "failed to read commit index",
            )
        })?;

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
            event_refs: e
                .event_refs
                .iter()
                .map(|r| StreamRefEntry {
                    stream_id_hash: ::hex::encode(r.stream_id_hash),
                    stream_id: String::new(),
                    stream_kind: r.stream_kind,
                    segment_id: r.segment_id,
                    offset: r.offset,
                    length: r.length,
                })
                .collect(),
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
    headers: HeaderMap,
    Json(req): Json<SyncPushRequest>,
) -> Result<Json<SyncPushResponse>, (StatusCode, &'static str)> {
    sync_token_guard(&headers)?;
    let engine = state.wdb.engine();
    let response = ingest_push_to_fenced_engine(engine, &req).await?;
    info!(
        "sync/push: accepted={}, segments={}",
        response.accepted,
        req.segments.len(),
    );
    Ok(Json(response))
}

/// Shared receiver contract for the experimental API and the separate
/// passive WabiDB process. Success means the engine applied each commit.
pub async fn ingest_push_to_fenced_engine(
    engine: &wabidb::engine::WabiDbEngine,
    req: &SyncPushRequest,
) -> Result<SyncPushResponse, (StatusCode, &'static str)> {
    if req
        .segments
        .iter()
        .any(|segment| !wabidb::stream_identity::is_safe_stream_id(&segment.stream_id))
    {
        return Err((StatusCode::BAD_REQUEST, "invalid segment stream id"));
    }
    if !engine.local_writer_fenced().await || !engine.durable_writer_fenced() {
        return Err((
            StatusCode::CONFLICT,
            "receiver has no durable local writer fence",
        ));
    }

    let decoded = req
        .entries
        .iter()
        .map(decode_sync_entry)
        .collect::<Result<Vec<_>, _>>()?;
    let index_dir = engine.data_dir().join("global/commit-index");
    let local = wabidb::commit_index::batcher::read_all_entries(&index_dir).map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot read receiver commit index",
        )
    })?;
    validate_complete_prefix(&local, &decoded, &req.target_prefix_fingerprint)?;

    for (entry, commit_entry) in req.entries.iter().zip(decoded) {
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
                    Some((
                        s.stream_id.clone(),
                        s.stream_kind,
                        s.segment_id,
                        s.data.clone(),
                    ))
                } else {
                    None
                }
            })
            .collect();

        engine
            .ingest_replicated_commit(commit_entry, segments)
            .await
            .map_err(|error| {
                tracing::warn!(commit_seq = entry.commit_seq, %error, "replicated commit rejected");
                (
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "replicated commit rejected",
                )
            })?;
    }
    Ok(SyncPushResponse {
        accepted: req.entries.len(),
        skipped: 0,
    })
}

fn decode_sync_entry(
    entry: &SyncEntry,
) -> Result<wabidb::commit_index::record::CommitIndexEntry, (StatusCode, &'static str)> {
    if entry.event_refs.len() != entry.payload_hashes.len()
        || entry.has_idempotency_key != entry.idempotency_key_hash.is_some()
    {
        return Err((StatusCode::BAD_REQUEST, "inconsistent commit metadata"));
    }
    let event_refs = entry
        .event_refs
        .iter()
        .map(|reference| {
            if !wabidb::stream_identity::is_safe_stream_id(&reference.stream_id) {
                return Err((StatusCode::BAD_REQUEST, "invalid stream id"));
            }
            let mut hash = [0u8; 16];
            ::hex::decode_to_slice(&reference.stream_id_hash, &mut hash)
                .map_err(|_| (StatusCode::BAD_REQUEST, "invalid stream id hash"))?;
            if wabidb::stream_identity::stream_id_hash(&reference.stream_id) != hash {
                return Err((StatusCode::BAD_REQUEST, "stream id hash mismatch"));
            }
            Ok(wabidb::commit_index::record::StreamRef {
                stream_id_hash: hash,
                stream_kind: reference.stream_kind,
                segment_id: reference.segment_id,
                offset: reference.offset,
                length: reference.length,
            })
        })
        .collect::<Result<Vec<_>, (StatusCode, &'static str)>>()?;
    let payload_hashes = entry
        .payload_hashes
        .iter()
        .map(|text| {
            let mut hash = [0u8; 32];
            ::hex::decode_to_slice(text, &mut hash)
                .map_err(|_| (StatusCode::BAD_REQUEST, "invalid payload hash"))?;
            Ok(hash)
        })
        .collect::<Result<Vec<_>, (StatusCode, &'static str)>>()?;
    Ok(wabidb::commit_index::record::CommitIndexEntry {
        commit_seq: entry.commit_seq,
        timestamp_micros: entry.timestamp_micros,
        caller_user_id: entry.caller_user_id,
        caller_device_id_hash: entry.caller_device_id_hash,
        command_name_hash: entry.command_name_hash,
        has_idempotency_key: entry.has_idempotency_key,
        idempotency_key_hash: entry.idempotency_key_hash,
        event_refs,
        payload_hashes,
    })
}

fn validate_complete_prefix(
    local: &[wabidb::commit_index::record::CommitIndexEntry],
    incoming: &[wabidb::commit_index::record::CommitIndexEntry],
    target: &str,
) -> Result<(), (StatusCode, &'static str)> {
    use std::collections::BTreeMap;

    let Some(last) = incoming.last() else {
        return Err((
            StatusCode::BAD_REQUEST,
            "sync push needs at least one commit",
        ));
    };
    if target.len() != 64 || ::hex::decode(target).is_err() {
        return Err((StatusCode::BAD_REQUEST, "invalid target commit prefix"));
    }
    if incoming
        .windows(2)
        .any(|pair| pair[0].commit_seq >= pair[1].commit_seq)
    {
        return Err((StatusCode::BAD_REQUEST, "sync commits are not ordered"));
    }
    let mut combined = BTreeMap::new();
    for entry in local {
        if combined.insert(entry.commit_seq, entry.clone()).is_some() {
            return Err((StatusCode::CONFLICT, "receiver has duplicate commit seq"));
        }
    }
    for entry in incoming {
        if let Some(existing) = combined.insert(entry.commit_seq, entry.clone()) {
            if existing != *entry {
                return Err((StatusCode::CONFLICT, "sync commit conflicts with receiver"));
            }
        }
    }
    let merged: Vec<_> = combined.into_values().collect();
    let actual = wabidb::replication::commit_prefix_fingerprint(&merged, last.commit_seq);
    if actual != target {
        return Err((
            StatusCode::CONFLICT,
            "sync batch omits or diverges from source prefix",
        ));
    }
    Ok(())
}

/// Status endpoint: returns the local node's latest commit_seq.
async fn handle_status(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, &'static str)> {
    sync_token_guard(&headers)?;
    let engine = state.wdb.engine();
    let commit_index_dir = engine.data_dir().join("global").join("commit-index");

    let all_entries =
        wabidb::commit_index::batcher::read_all_entries(&commit_index_dir).map_err(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "failed to read commit index",
            )
        })?;

    let latest = all_entries.last().map(|e| e.commit_seq).unwrap_or(0);

    Ok(Json(serde_json::json!({
        "latestCommitSeq": latest,
        "totalEntries": all_entries.len(),
        "replicaFingerprint": engine.replica_fingerprint(),
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
        s.collect_str(&format_args!(
            "{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let s = String::deserialize(d)?;
        base64::engine::general_purpose::STANDARD
            .decode(&s)
            .map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_entry(commit_seq: u64) -> wabidb::commit_index::record::CommitIndexEntry {
        wabidb::commit_index::record::CommitIndexEntry {
            commit_seq,
            timestamp_micros: 1,
            caller_user_id: 1,
            caller_device_id_hash: [0; 16],
            command_name_hash: [0; 16],
            has_idempotency_key: false,
            idempotency_key_hash: None,
            event_refs: vec![],
            payload_hashes: vec![],
        }
    }

    fn wire_entry() -> SyncEntry {
        let id = "reactions:msg_1:👍🏽:removed";
        SyncEntry {
            commit_seq: 1,
            timestamp_micros: 1,
            caller_user_id: 1,
            caller_device_id_hash: [1; 16],
            command_name_hash: [2; 16],
            has_idempotency_key: false,
            idempotency_key_hash: None,
            event_refs: vec![StreamRefEntry {
                stream_id_hash: ::hex::encode(wabidb::stream_identity::stream_id_hash(id)),
                stream_id: id.into(),
                stream_kind: 6,
                segment_id: 1,
                offset: 0,
                length: 48,
            }],
            payload_hashes: vec![::hex::encode([3; 32])],
        }
    }

    #[test]
    fn push_decoder_preserves_unicode_identity_and_refuses_invalid_metadata() {
        let valid = wire_entry();
        let decoded = decode_sync_entry(&valid).unwrap();
        assert_eq!(
            decoded.event_refs[0].stream_id_hash,
            wabidb::stream_identity::stream_id_hash(&valid.event_refs[0].stream_id)
        );
        for id in ["../outside".to_owned(), "a".repeat(256), "another-stream".into()] {
            let mut invalid = wire_entry();
            invalid.event_refs[0].stream_id = id;
            assert!(decode_sync_entry(&invalid).is_err());
        }
        let mut invalid = wire_entry();
        invalid.event_refs[0].stream_id_hash = "not-hex".into();
        assert!(decode_sync_entry(&invalid).is_err());
        let mut invalid = wire_entry();
        invalid.payload_hashes[0] = "not-hex".into();
        assert!(decode_sync_entry(&invalid).is_err());
        let mut invalid = wire_entry();
        invalid.has_idempotency_key = true;
        assert!(decode_sync_entry(&invalid).is_err());
        let mut invalid = wire_entry();
        invalid.payload_hashes.clear();
        assert!(decode_sync_entry(&invalid).is_err());

        let json = serde_json::to_value(wire_entry()).unwrap();
        for field in ["callerDeviceIdHash", "commandNameHash", "idempotencyKeyHash"] {
            let mut invalid = json.clone();
            invalid[field] = serde_json::json!("not-hex");
            assert!(serde_json::from_value::<SyncEntry>(invalid).is_err());
        }
    }

    #[test]
    fn receiver_prefix_rejects_omitted_commits_but_allows_burned_sequences_and_retries() {
        let full = vec![sample_entry(1), sample_entry(2), sample_entry(4)];
        let target = wabidb::replication::commit_prefix_fingerprint(&full, 4);
        assert!(validate_complete_prefix(&full[..1], &full[1..], &target).is_ok());
        assert!(validate_complete_prefix(&full[..2], &full[1..], &target).is_ok());
        assert_eq!(
            validate_complete_prefix(&full[..1], &full[2..], &target),
            Err((
                StatusCode::CONFLICT,
                "sync batch omits or diverges from source prefix"
            ))
        );
        assert!(validate_complete_prefix(&full[..2], &full[2..], &target).is_ok());
    }

    #[test]
    fn sync_api_requires_experimental_mode_and_exact_token() {
        let mut headers = HeaderMap::new();
        headers.insert("x-wabi-sync-token", "test-secret".parse().unwrap());
        assert_eq!(
            sync_token_guard_with(&headers, "test-secret", false),
            Err((
                StatusCode::SERVICE_UNAVAILABLE,
                "experimental sync is disabled"
            ))
        );
        assert_eq!(
            sync_token_guard_with(&headers, "", true),
            Err((StatusCode::SERVICE_UNAVAILABLE, "sync token not configured"))
        );
        assert_eq!(
            sync_token_guard_with(&headers, "wrong-secret", true),
            Err((StatusCode::UNAUTHORIZED, "invalid sync token"))
        );
        assert!(sync_token_guard_with(&headers, "test-secret", true).is_ok());
    }
}
