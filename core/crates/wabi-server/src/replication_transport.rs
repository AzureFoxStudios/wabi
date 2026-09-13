//! Reqwest-based `SyncTransport` for WabiDB replication.
//!
//! Implements the `SyncTransport` trait from `wabidb::replication` using
//! `reqwest` to call the peer's HTTP sync endpoints (`/api/v1/sync/pull`,
//! `/api/v1/sync/push`, `/api/v1/sync/status`).

use std::{fmt, path::PathBuf, time::Duration};

use async_trait::async_trait;
use wabidb::commit_index::record::CommitIndexEntry;
use wabidb::error::{Result, WabiError};
use wabidb::replication::SyncTransport;

use crate::api::sync::{PushedSegment, SyncEntry, SyncPullRequest, SyncPullResponse, SyncPushRequest};

const SYNC_TOKEN_HEADER: &str = "x-wabi-sync-token";
const SYNC_TIMEOUT: Duration = Duration::from_secs(10);
const SYNC_CONNECT_TIMEOUT: Duration = Duration::from_secs(3);

/// A `SyncTransport` that uses authenticated HTTP calls to replicate with a peer.
///
/// The sync token is intentionally captured once at construction and redacted from
/// `Debug`: replication must never place operator credentials into logs.
pub struct ReqwestTransport {
    client: reqwest::Client,
    data_dir: PathBuf,
    sync_token: Option<String>,
}

impl fmt::Debug for ReqwestTransport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ReqwestTransport")
            .field("data_dir", &self.data_dir)
            .field("sync_token", &self.sync_token.as_ref().map(|_| "[REDACTED]"))
            .finish_non_exhaustive()
    }
}

impl ReqwestTransport {
    /// Create a new transport bound to the given data directory.
    ///
    /// `WABI_SYNC_TOKEN` must match the peer's sync endpoint configuration.
    /// An absent token is retained as an explicit runtime error rather than
    /// silently sending unauthenticated replication requests.
    pub fn new(data_dir: PathBuf) -> Self {
        let sync_token = std::env::var("WABI_SYNC_TOKEN")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        Self::with_token(data_dir, sync_token)
    }

    fn with_token(data_dir: PathBuf, sync_token: Option<String>) -> Self {
        let client = reqwest::Client::builder()
            .connect_timeout(SYNC_CONNECT_TIMEOUT)
            .timeout(SYNC_TIMEOUT)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            client,
            data_dir,
            sync_token,
        }
    }

    fn url(base: &str, path: &str) -> String {
        let base = base.trim_end_matches('/');
        let path = path.trim_start_matches('/');
        format!("{base}/{path}")
    }

    fn authorized(&self, request: reqwest::RequestBuilder) -> Result<reqwest::RequestBuilder> {
        let token = self.sync_token.as_deref().ok_or_else(|| WabiError::Validation {
            command: "replication_transport".into(),
            reason: "WABI_SYNC_TOKEN is required when WABIDB_PEER_ENDPOINT enables replication".into(),
        })?;
        Ok(request.header(SYNC_TOKEN_HEADER, token))
    }

    async fn checked_response(
        request: reqwest::RequestBuilder,
        operation: &'static str,
    ) -> Result<reqwest::Response> {
        let response = request
            .send()
            .await
            .map_err(|error| Self::io_error(operation, error))?;
        let status = response.status();
        if !status.is_success() {
            // Do not include response bodies: a peer/proxy may echo sensitive
            // configuration. Status is sufficient for replication diagnostics.
            return Err(WabiError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("WabiDB replication {operation} returned HTTP {status}"),
            )));
        }
        Ok(response)
    }

    fn io_error(operation: &'static str, error: reqwest::Error) -> WabiError {
        WabiError::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            format!("WabiDB replication {operation} failed: {error}"),
        ))
    }

    fn read_segments(&self, entry: &CommitIndexEntry) -> Vec<PushedSegment> {
        use std::io::Read;

        let mut seen = Vec::new();
        let mut segments = Vec::new();

        for sr in &entry.event_refs {
            let key = (sr.stream_kind, sr.segment_id);
            if seen.contains(&key) {
                continue;
            }
            seen.push(key);

            let kind_name = wabidb::sequencer::stream_kind_dir_name(sr.stream_kind);
            let streams_dir = self.data_dir.join("streams").join(kind_name);

            if let Ok(read_dir) = std::fs::read_dir(&streams_dir) {
                for dir_entry in read_dir.flatten() {
                    let events_dir = dir_entry.path().join("events");
                    let seg_path = events_dir.join(format!("{:08}.wseg", sr.segment_id));
                    if seg_path.exists() {
                        let mut buf = Vec::new();
                        if std::fs::File::open(&seg_path)
                            .and_then(|mut f| f.read_to_end(&mut buf))
                            .is_ok()
                        {
                            if let Some(stream_id) = dir_entry.file_name().to_str() {
                                segments.push(PushedSegment {
                                    stream_id: stream_id.to_string(),
                                    stream_kind: sr.stream_kind,
                                    segment_id: sr.segment_id,
                                    data: buf,
                                });
                            }
                        }
                        break;
                    }
                }
            }
        }

        segments
    }

    fn entry_to_sync_entry(entry: &CommitIndexEntry) -> SyncEntry {
        SyncEntry {
            commit_seq: entry.commit_seq,
            timestamp_micros: entry.timestamp_micros,
            caller_user_id: entry.caller_user_id,
            caller_device_id_hash: entry.caller_device_id_hash,
            command_name_hash: entry.command_name_hash,
            has_idempotency_key: entry.has_idempotency_key,
            idempotency_key_hash: entry.idempotency_key_hash,
            event_refs: entry.event_refs.iter().map(|r| {
                use crate::api::sync::StreamRefEntry;
                StreamRefEntry {
                    stream_id_hash: hex::encode(r.stream_id_hash),
                    stream_id: String::new(),
                    stream_kind: r.stream_kind,
                    segment_id: r.segment_id,
                    offset: r.offset,
                    length: r.length,
                }
            }).collect(),
            payload_hashes: entry.payload_hashes.iter().map(hex::encode).collect(),
        }
    }
}

#[async_trait]
impl SyncTransport for ReqwestTransport {
    async fn pull(&self, peer_endpoint: &str, since: u64) -> Result<Vec<CommitIndexEntry>> {
        let url = Self::url(peer_endpoint, "/api/v1/sync/pull");
        let req = SyncPullRequest { since_commit_seq: since };
        let request = self.authorized(self.client.post(&url).json(&req))?;
        let response = Self::checked_response(request, "pull").await?;
        let pull_resp: SyncPullResponse = response
            .json()
            .await
            .map_err(|error| Self::io_error("pull decode", error))?;

        let entries: Vec<CommitIndexEntry> = pull_resp
            .entries
            .into_iter()
            .map(|e| {
                let mut hash = [0u8; 16];
                let _ = hex::decode_to_slice(&e.caller_device_id_hash, &mut hash);
                let mut cmd_hash = [0u8; 16];
                let _ = hex::decode_to_slice(&e.command_name_hash, &mut cmd_hash);
                let payload_hashes: Vec<[u8; 32]> = e
                    .payload_hashes
                    .iter()
                    .filter_map(|h| {
                        let mut out = [0u8; 32];
                        hex::decode_to_slice(h, &mut out).ok()?;
                        Some(out)
                    })
                    .collect();
                let event_refs = e
                    .event_refs
                    .iter()
                    .map(|r| {
                        let mut id_hash = [0u8; 16];
                        let _ = hex::decode_to_slice(&r.stream_id_hash, &mut id_hash);
                        wabidb::commit_index::record::StreamRef {
                            stream_id_hash: id_hash,
                            stream_kind: r.stream_kind,
                            segment_id: r.segment_id,
                            offset: r.offset,
                            length: r.length,
                        }
                    })
                    .collect();

                CommitIndexEntry {
                    commit_seq: e.commit_seq,
                    timestamp_micros: e.timestamp_micros,
                    caller_user_id: e.caller_user_id,
                    caller_device_id_hash: hash,
                    command_name_hash: cmd_hash,
                    has_idempotency_key: e.has_idempotency_key,
                    idempotency_key_hash: e.idempotency_key_hash,
                    event_refs,
                    payload_hashes,
                }
            })
            .collect();

        Ok(entries)
    }

    async fn push(&self, peer_endpoint: &str, entries: Vec<CommitIndexEntry>) -> Result<()> {
        let url = Self::url(peer_endpoint, "/api/v1/sync/push");

        let mut sync_entries = Vec::with_capacity(entries.len());
        let mut all_segments = Vec::new();

        for entry in &entries {
            let mut segments = self.read_segments(entry);
            all_segments.append(&mut segments);
            sync_entries.push(Self::entry_to_sync_entry(entry));
        }

        let req = SyncPushRequest {
            entries: sync_entries,
            segments: all_segments,
        };
        let request = self.authorized(self.client.post(&url).json(&req))?;
        let _ = Self::checked_response(request, "push").await?;
        Ok(())
    }

    async fn latest_seq(&self, peer_endpoint: &str) -> Result<u64> {
        let url = Self::url(peer_endpoint, "/api/v1/sync/status");
        let request = self.authorized(self.client.get(&url))?;
        let response = Self::checked_response(request, "status").await?;
        let body: serde_json::Value = response
            .json()
            .await
            .map_err(|error| Self::io_error("status decode", error))?;

        body.get("latestCommitSeq")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| WabiError::Validation {
                command: "latest_seq".into(),
                reason: "peer returned invalid /status response".into(),
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replication_requests_require_and_attach_sync_token() {
        let missing = ReqwestTransport::with_token(PathBuf::from("/tmp/wabi-repl-test"), None);
        assert!(missing.authorized(missing.client.get("http://127.0.0.1/status")).is_err());

        let transport = ReqwestTransport::with_token(
            PathBuf::from("/tmp/wabi-repl-test"),
            Some("test-sync-secret".into()),
        );
        let request = transport
            .authorized(transport.client.get("http://127.0.0.1/status"))
            .unwrap()
            .build()
            .unwrap();
        assert_eq!(
            request.headers().get(SYNC_TOKEN_HEADER).and_then(|value| value.to_str().ok()),
            Some("test-sync-secret")
        );
        assert!(!format!("{transport:?}").contains("test-sync-secret"));
    }

    #[test]
    fn peer_urls_are_joined_without_double_slashes() {
        assert_eq!(
            ReqwestTransport::url("https://peer.example/", "/api/v1/sync/status"),
            "https://peer.example/api/v1/sync/status"
        );
    }
}
