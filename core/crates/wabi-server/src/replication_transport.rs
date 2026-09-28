//! Reqwest-based `SyncTransport` for WabiDB replication.
//!
//! Implements the `SyncTransport` trait from `wabidb::replication` using
//! `reqwest` to call the peer's HTTP sync endpoints.
//!
//! The current worker pushes committed segment data to a durably fenced
//! WabiDB-only receiver. It does not replicate complete Authority state.

use std::{fmt, net::IpAddr, path::PathBuf, time::Duration};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use wabidb::commit_index::record::CommitIndexEntry;
use wabidb::engine::locks::ProjectionState;
use wabidb::error::{Result, WabiError};
use wabidb::projections::{upload_assets, upload_revocations};
use wabidb::replication::{PeerPosition, SyncTransport};
use wabidb::stream_identity::stream_id_hash;

use crate::api::sync::{
    PushedSegment, SyncEntry, SyncPullRequest, SyncPullResponse, SyncPushRequest, SyncPushResponse,
};
use crate::instance_sidecars::{self, SidecarInventory};

const SYNC_TOKEN_HEADER: &str = "x-wabi-sync-token";
const SYNC_TIMEOUT: Duration = Duration::from_secs(10);
const SYNC_CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const ASSET_CHUNK_MAX: usize = 1024 * 1024;
const ASSET_TICK_BUDGET: u64 = 8 * 1024 * 1024;
const SIDECAR_TICK_BUDGET: usize = 64 * 1024 * 1024;
const MAX_REPLICATED_SEGMENT_BYTES: u64 = 128 * 1024 * 1024;

fn invalid_peer_data(reason: &'static str) -> WabiError {
    WabiError::Validation {
        command: "replication_transport".into(),
        reason: reason.into(),
    }
}

fn decode_pull_response(response: SyncPullResponse, since: u64) -> Result<Vec<CommitIndexEntry>> {
    if response.entries.len() > 10_000 || response.latest_commit_seq < since {
        return Err(invalid_peer_data("peer returned an invalid commit range"));
    }
    let mut previous = since;
    let mut decoded = Vec::with_capacity(response.entries.len());
    for entry in response.entries {
        if entry.commit_seq <= previous || entry.commit_seq > response.latest_commit_seq {
            return Err(invalid_peer_data(
                "peer commits are missing ordering or range",
            ));
        }
        if entry.event_refs.len() != entry.payload_hashes.len()
            || entry.has_idempotency_key != entry.idempotency_key_hash.is_some()
        {
            return Err(invalid_peer_data("peer commit metadata is inconsistent"));
        }
        let payload_hashes = entry
            .payload_hashes
            .iter()
            .map(|text| {
                let mut hash = [0u8; 32];
                hex::decode_to_slice(text, &mut hash)
                    .map_err(|_| invalid_peer_data("peer payload hash is malformed"))?;
                Ok(hash)
            })
            .collect::<Result<Vec<_>>>()?;
        let event_refs = entry
            .event_refs
            .iter()
            .map(|reference| {
                let mut hash = [0u8; 16];
                hex::decode_to_slice(&reference.stream_id_hash, &mut hash)
                    .map_err(|_| invalid_peer_data("peer stream hash is malformed"))?;
                Ok(wabidb::commit_index::record::StreamRef {
                    stream_id_hash: hash,
                    stream_kind: reference.stream_kind,
                    segment_id: reference.segment_id,
                    offset: reference.offset,
                    length: reference.length,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        previous = entry.commit_seq;
        decoded.push(CommitIndexEntry {
            commit_seq: entry.commit_seq,
            timestamp_micros: entry.timestamp_micros,
            caller_user_id: entry.caller_user_id,
            caller_device_id_hash: entry.caller_device_id_hash,
            command_name_hash: entry.command_name_hash,
            has_idempotency_key: entry.has_idempotency_key,
            idempotency_key_hash: entry.idempotency_key_hash,
            event_refs,
            payload_hashes,
        });
    }
    Ok(decoded)
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetNeed {
    pub filename: String,
    pub size: u64,
    pub sha256: String,
    pub offset: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetNeedsResponse {
    pub entries: Vec<AssetNeed>,
    pub next_after: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetPutResponse {
    pub next_offset: u64,
    pub complete: bool,
}

/// A `SyncTransport` that uses authenticated HTTP calls to replicate with a peer.
///
/// The sync token is intentionally captured once at construction and redacted from
/// `Debug`: replication must never place operator credentials into logs.
pub struct ReqwestTransport {
    client: reqwest::Client,
    data_dir: PathBuf,
    uploads_dir: Option<PathBuf>,
    instance_dir: Option<PathBuf>,
    sync_token: Option<String>,
    expected_fingerprint: String,
    asset_cursor: tokio::sync::Mutex<Option<String>>,
}

impl fmt::Debug for ReqwestTransport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ReqwestTransport")
            .field("data_dir", &self.data_dir)
            .field("uploads_dir", &self.uploads_dir)
            .field("instance_dir", &self.instance_dir)
            .field(
                "sync_token",
                &self.sync_token.as_ref().map(|_| "[REDACTED]"),
            )
            .field("expected_fingerprint", &self.expected_fingerprint)
            .finish_non_exhaustive()
    }
}

impl ReqwestTransport {
    /// Create a new transport bound to the given data directory.
    ///
    /// `WABI_SYNC_TOKEN` must match the peer's sync endpoint configuration.
    /// `WABIDB_EXPERIMENTAL_REPLICATION=true` is additionally required because
    /// the current engine worker does not provide complete Authority convergence.
    pub fn new(data_dir: PathBuf, expected_fingerprint: String) -> Self {
        let sync_token = std::env::var("WABI_SYNC_TOKEN")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        Self::with_token(data_dir, sync_token, expected_fingerprint)
    }

    /// Enable verified upload-byte catch-up for a source Authority.
    pub fn with_uploads_dir(mut self, uploads_dir: PathBuf) -> Self {
        self.uploads_dir = Some(uploads_dir);
        self
    }

    /// Enable bounded, eventually consistent copies of explicit Authority sidecars.
    pub fn with_instance_dir(mut self, instance_dir: PathBuf) -> Self {
        self.instance_dir = Some(instance_dir);
        self
    }

    fn with_token(
        data_dir: PathBuf,
        sync_token: Option<String>,
        expected_fingerprint: String,
    ) -> Self {
        let client = reqwest::Client::builder()
            .connect_timeout(SYNC_CONNECT_TIMEOUT)
            .timeout(SYNC_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("static sync HTTP client configuration is valid");
        Self {
            client,
            data_dir,
            uploads_dir: None,
            instance_dir: None,
            sync_token,
            expected_fingerprint,
            asset_cursor: tokio::sync::Mutex::new(None),
        }
    }

    fn experimental_runtime_enabled() -> bool {
        std::env::var("WABIDB_EXPERIMENTAL_REPLICATION")
            .ok()
            .map(|value| value.trim().to_ascii_lowercase())
            .is_some_and(|value| matches!(value.as_str(), "1" | "true" | "yes"))
    }

    fn url(base: &str, path: &str) -> String {
        let base = base.trim_end_matches('/');
        let path = path.trim_start_matches('/');
        format!("{base}/{path}")
    }

    /// Protect the sync token from accidental public-HTTP or redirect leaks.
    /// Private HTTP requires explicit operator opt-in and a protected link.
    pub fn validate_peer_endpoint(endpoint: &str, allow_private_http: bool) -> Result<()> {
        let url = reqwest::Url::parse(endpoint).map_err(|_| WabiError::Validation {
            command: "replication_transport".into(),
            reason: "peer endpoint is not a URL".into(),
        })?;
        if !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
        {
            return Err(WabiError::Validation {
                command: "replication_transport".into(),
                reason: "peer endpoint must be an origin without credentials, path or query".into(),
            });
        }
        let host = url.host_str().unwrap_or("").trim_matches(&['[', ']'][..]);
        let local = host.eq_ignore_ascii_case("localhost")
            || host
                .parse::<IpAddr>()
                .is_ok_and(|address| address.is_loopback());
        let private = host.parse::<IpAddr>().is_ok_and(|address| match address {
            IpAddr::V4(ip) => {
                let octets = ip.octets();
                ip.is_private() || (octets[0] == 100 && (64..=127).contains(&octets[1]))
            }
            IpAddr::V6(ip) => ip.is_unique_local(),
        });
        if url.scheme() != "https"
            && !(url.scheme() == "http" && (local || allow_private_http && private))
        {
            return Err(WabiError::Validation {
                command: "replication_transport".into(),
                reason: "sync token requires HTTPS; private HTTP needs WABIDB_ALLOW_PRIVATE_HTTP=true and a protected transport".into(),
            });
        }
        Ok(())
    }

    fn authorized(&self, request: reqwest::RequestBuilder) -> Result<reqwest::RequestBuilder> {
        self.authorized_with_runtime(request, Self::experimental_runtime_enabled())
    }

    fn authorized_with_runtime(
        &self,
        request: reqwest::RequestBuilder,
        experimental_enabled: bool,
    ) -> Result<reqwest::RequestBuilder> {
        if !experimental_enabled {
            return Err(WabiError::Validation {
                command: "replication_transport".into(),
                reason: "network replication is incomplete and disabled by default; WABIDB_EXPERIMENTAL_REPLICATION=true is required for developer testing and must not be treated as HA".into(),
            });
        }
        let token = self
            .sync_token
            .as_deref()
            .ok_or_else(|| WabiError::Validation {
                command: "replication_transport".into(),
                reason: "WABI_SYNC_TOKEN is required when WABIDB_PEER_ENDPOINT enables replication"
                    .into(),
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

    async fn sync_sidecars(&self, peer_endpoint: &str) -> Result<()> {
        let Some(dir) = &self.instance_dir else {
            return Ok(());
        };
        let dir_meta = tokio::fs::symlink_metadata(dir).await?;
        if !dir_meta.is_dir() || dir_meta.file_type().is_symlink() {
            return Err(invalid_peer_data(
                "source Authority data directory is unsafe",
            ));
        }
        let url = Self::url(peer_endpoint, "/api/v1/sync/sidecars");
        let response =
            Self::checked_response(self.authorized(self.client.get(url))?, "sidecar inventory")
                .await?;
        let inventory: SidecarInventory = response
            .json()
            .await
            .map_err(|error| Self::io_error("sidecar inventory decode", error))?;
        if inventory.files.len() > instance_sidecars::NAMES.len() {
            return Err(invalid_peer_data("peer sidecar inventory is too large"));
        }
        let mut remote = std::collections::HashMap::new();
        for entry in inventory.files {
            if !instance_sidecars::valid_digest(&entry)
                || remote.insert(entry.name.clone(), entry).is_some()
            {
                return Err(invalid_peer_data("peer sidecar inventory is invalid"));
            }
        }
        let mut budget = SIDECAR_TICK_BUDGET;
        for name in instance_sidecars::NAMES {
            let path = dir.join(name);
            let metadata = match tokio::fs::symlink_metadata(&path).await {
                Ok(metadata) => Some(metadata),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(WabiError::Io(error)),
            };
            let endpoint = Self::url(peer_endpoint, &format!("/api/v1/sync/sidecars/{name}"));
            if let Some(metadata) = metadata {
                if !metadata.is_file()
                    || metadata.file_type().is_symlink()
                    || metadata.len() > instance_sidecars::MAX_FILE_BYTES as u64
                {
                    return Err(invalid_peer_data("source sidecar is unsafe or too large"));
                }
                let file = tokio::fs::File::open(&path).await?;
                let opened = file.metadata().await?;
                if !opened.is_file() || opened.len() != metadata.len() {
                    return Err(invalid_peer_data("source sidecar changed while opening"));
                }
                let mut bytes = Vec::with_capacity(opened.len() as usize);
                file.take(instance_sidecars::MAX_FILE_BYTES as u64 + 1)
                    .read_to_end(&mut bytes)
                    .await?;
                if bytes.len() > instance_sidecars::MAX_FILE_BYTES
                    || bytes.len() as u64 != metadata.len()
                {
                    return Err(invalid_peer_data("source sidecar changed while reading"));
                }
                let sha256 = hex::encode(Sha256::digest(&bytes));
                if remote.get(*name).is_some_and(|entry| {
                    entry.size == bytes.len() as u64 && entry.sha256.eq_ignore_ascii_case(&sha256)
                }) {
                    continue;
                }
                if bytes.len() > budget {
                    continue;
                }
                let sent_len = bytes.len();
                Self::checked_response(
                    self.authorized(
                        self.client
                            .put(endpoint)
                            .header("x-wabi-sha256", sha256)
                            .body(bytes),
                    )?,
                    "sidecar copy",
                )
                .await?;
                budget -= sent_len;
            } else if *name != "jwt_secret" && remote.contains_key(*name) {
                Self::checked_response(
                    self.authorized(self.client.delete(endpoint))?,
                    "sidecar deletion",
                )
                .await?;
            }
        }
        Ok(())
    }

    fn read_segments(&self, entries: &[CommitIndexEntry]) -> Result<Vec<PushedSegment>> {
        use std::io::Read;

        let mut seen = std::collections::HashSet::new();
        let mut segments = Vec::new();

        for sr in entries.iter().flat_map(|entry| &entry.event_refs) {
            let key = (sr.stream_id_hash, sr.stream_kind, sr.segment_id);
            if !seen.insert(key) {
                continue;
            }
            let (stream_id, stream_dir) = self.stream_id_for_ref(sr)?;
            let event_dir = stream_dir.join("events");
            let event_dir_meta = std::fs::symlink_metadata(&event_dir)?;
            if !event_dir_meta.is_dir() || event_dir_meta.file_type().is_symlink() {
                return Err(invalid_peer_data("source events directory is unsafe"));
            }
            let seg_path = event_dir.join(format!("{:08}.wseg", sr.segment_id));
            let metadata = std::fs::symlink_metadata(&seg_path)?;
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || metadata.len() > MAX_REPLICATED_SEGMENT_BYTES
            {
                return Err(invalid_peer_data("source segment is unsafe or too large"));
            }
            let mut data = Vec::with_capacity(metadata.len() as usize);
            std::fs::File::open(&seg_path)?
                .take(MAX_REPLICATED_SEGMENT_BYTES + 1)
                .read_to_end(&mut data)?;
            if data.len() as u64 > MAX_REPLICATED_SEGMENT_BYTES {
                return Err(invalid_peer_data(
                    "source segment grew beyond the size limit",
                ));
            }
            segments.push(PushedSegment {
                stream_id,
                stream_kind: sr.stream_kind,
                segment_id: sr.segment_id,
                data,
            });
        }

        Ok(segments)
    }

    fn stream_id_for_ref(
        &self,
        stream_ref: &wabidb::commit_index::record::StreamRef,
    ) -> Result<(String, PathBuf)> {
        let kind_name = wabidb::sequencer::stream_kind_dir_name(stream_ref.stream_kind);
        let streams_root = self.data_dir.join("streams");
        let root_metadata = std::fs::symlink_metadata(&streams_root)?;
        if !root_metadata.is_dir() || root_metadata.file_type().is_symlink() {
            return Err(invalid_peer_data("source streams root is unsafe"));
        }
        let streams_dir = streams_root.join(kind_name);
        let metadata = std::fs::symlink_metadata(&streams_dir)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(invalid_peer_data("source stream directory is unsafe"));
        }
        let mut match_path = None;
        for entry in std::fs::read_dir(streams_dir)? {
            let dir_entry = entry?;
            let Some(stream_id) = dir_entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if stream_id_hash(&stream_id) == stream_ref.stream_id_hash {
                let file_type = dir_entry.file_type()?;
                if !file_type.is_dir() || file_type.is_symlink() || match_path.is_some() {
                    return Err(invalid_peer_data(
                        "source stream identity is unsafe or ambiguous",
                    ));
                }
                match_path = Some((stream_id, dir_entry.path()));
            }
        }
        match_path.ok_or_else(|| invalid_peer_data("source commit references a missing stream"))
    }

    fn entry_to_sync_entry(
        &self,
        entry: &CommitIndexEntry,
        segments: &[PushedSegment],
    ) -> Result<SyncEntry> {
        Ok(SyncEntry {
            commit_seq: entry.commit_seq,
            timestamp_micros: entry.timestamp_micros,
            caller_user_id: entry.caller_user_id,
            caller_device_id_hash: entry.caller_device_id_hash,
            command_name_hash: entry.command_name_hash,
            has_idempotency_key: entry.has_idempotency_key,
            idempotency_key_hash: entry.idempotency_key_hash,
            event_refs: entry
                .event_refs
                .iter()
                .map(|r| {
                    use crate::api::sync::StreamRefEntry;
                    let segment = segments
                        .iter()
                        .find(|segment| {
                            stream_id_hash(&segment.stream_id) == r.stream_id_hash
                                && segment.stream_kind == r.stream_kind
                                && segment.segment_id == r.segment_id
                        })
                        .ok_or_else(|| invalid_peer_data("source commit is missing a segment"))?;
                    let end = u64::from(r.offset)
                        .checked_add(u64::from(r.length))
                        .ok_or_else(|| invalid_peer_data("source record reference overflows"))?;
                    if r.length == 0 || end > segment.data.len() as u64 {
                        return Err(invalid_peer_data(
                            "source record is missing from its segment",
                        ));
                    }
                    Ok(StreamRefEntry {
                        stream_id_hash: hex::encode(r.stream_id_hash),
                        stream_id: segment.stream_id.clone(),
                        stream_kind: r.stream_kind,
                        segment_id: r.segment_id,
                        offset: r.offset,
                        length: r.length,
                    })
                })
                .collect::<Result<Vec<_>>>()?,
            payload_hashes: entry.payload_hashes.iter().map(hex::encode).collect(),
        })
    }

    async fn transfer_needed_asset(
        &self,
        peer_endpoint: &str,
        projections: &ProjectionState,
        need: &AssetNeed,
        budget: u64,
    ) -> Result<u64> {
        let invalid = |reason: &'static str| WabiError::Validation {
            command: "sync_asset".into(),
            reason: reason.into(),
        };
        if !upload_revocations::valid_filename(&need.filename)
            || need.sha256.len() != 64
            || hex::decode(&need.sha256).is_err()
            || need.offset > need.size
            || projections
                .get(upload_revocations::INDEX, need.filename.as_bytes())
                .is_some()
        {
            return Err(invalid("peer requested an invalid or revoked upload"));
        }
        let local = projections
            .get(upload_assets::INDEX, need.filename.as_bytes())
            .ok_or_else(|| invalid("peer requested an unpublished upload"))?;
        let local = upload_assets::decode(&local)?;
        if local.size != need.size || local.sha256 != need.sha256 {
            return Err(invalid(
                "peer upload expectation differs from the Authority",
            ));
        }
        let uploads_dir = self
            .uploads_dir
            .as_ref()
            .ok_or_else(|| invalid("Authority upload tree is not configured"))?;
        let path = uploads_dir.join(&need.filename);
        let metadata = tokio::fs::symlink_metadata(&path).await?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() != need.size {
            return Err(invalid("published upload bytes are missing or changed"));
        }
        let digest = crate::upload_registry::sha256_file(&path).await?;
        if digest != need.sha256 {
            return Err(invalid("published upload digest changed"));
        }

        let mut url = reqwest::Url::parse(&Self::url(peer_endpoint, "/api/v1/sync/assets"))
            .map_err(|_| invalid("invalid peer upload URL"))?;
        url.path_segments_mut()
            .map_err(|_| invalid("invalid peer upload URL"))?
            .push(&need.filename);
        let mut file = tokio::fs::File::open(&path).await?;
        file.seek(std::io::SeekFrom::Start(need.offset)).await?;
        let mut offset = need.offset;
        let mut sent = 0;
        loop {
            let remaining = need.size - offset;
            let count = remaining.min((budget - sent).min(ASSET_CHUNK_MAX as u64)) as usize;
            if count == 0 && !(offset == need.size && sent == 0) {
                break;
            }
            let mut chunk = vec![0u8; count];
            file.read_exact(&mut chunk).await?;
            let request = self.authorized(
                self.client
                    .put(url.clone())
                    .query(&[("offset", offset)])
                    .body(chunk),
            )?;
            let response = Self::checked_response(request, "asset push").await?;
            let receipt: AssetPutResponse = response
                .json()
                .await
                .map_err(|error| Self::io_error("asset receipt decode", error))?;
            let next = offset + count as u64;
            if receipt.next_offset != next || receipt.complete != (next == need.size) {
                return Err(invalid("peer acknowledged an inconsistent upload offset"));
            }
            offset = next;
            sent += count as u64;
            if receipt.complete {
                break;
            }
        }
        Ok(sent)
    }
}

#[async_trait]
impl SyncTransport for ReqwestTransport {
    async fn pull(&self, peer_endpoint: &str, since: u64) -> Result<Vec<CommitIndexEntry>> {
        let url = Self::url(peer_endpoint, "/api/v1/sync/pull");
        let req = SyncPullRequest {
            since_commit_seq: since,
        };
        let request = self.authorized(self.client.post(&url).json(&req))?;
        let response = Self::checked_response(request, "pull").await?;
        let pull_resp: SyncPullResponse = response
            .json()
            .await
            .map_err(|error| Self::io_error("pull decode", error))?;

        decode_pull_response(pull_resp, since)
    }

    async fn push(&self, peer_endpoint: &str, entries: Vec<CommitIndexEntry>) -> Result<()> {
        let url = Self::url(peer_endpoint, "/api/v1/sync/push");
        let Some(last) = entries.last() else {
            return Ok(());
        };
        let local_index = wabidb::commit_index::batcher::read_all_entries(
            &self.data_dir.join("global/commit-index"),
        )?;
        let target_prefix_fingerprint =
            wabidb::replication::commit_prefix_fingerprint(&local_index, last.commit_seq);

        // A batch often contains many commits in the same segment. Read each
        // unique segment once, then check every commit reference against it.
        let all_segments = self.read_segments(&entries)?;
        let sync_entries = entries
            .iter()
            .map(|entry| self.entry_to_sync_entry(entry, &all_segments))
            .collect::<Result<Vec<_>>>()?;

        let req = SyncPushRequest {
            entries: sync_entries,
            segments: all_segments,
            target_prefix_fingerprint,
        };
        let request = self.authorized(self.client.post(&url).json(&req))?;
        let response = Self::checked_response(request, "push").await?;
        let receipt: SyncPushResponse = response
            .json()
            .await
            .map_err(|error| Self::io_error("push receipt decode", error))?;
        if receipt.accepted != entries.len() || receipt.skipped != 0 {
            return Err(WabiError::Validation {
                command: "push".into(),
                reason: "peer did not acknowledge applying every commit".into(),
            });
        }
        Ok(())
    }

    async fn latest_position(&self, peer_endpoint: &str) -> Result<PeerPosition> {
        let url = Self::url(peer_endpoint, "/api/v1/sync/status");
        let request = self.authorized(self.client.get(&url))?;
        let response = Self::checked_response(request, "status").await?;
        let body: serde_json::Value = response
            .json()
            .await
            .map_err(|error| Self::io_error("status decode", error))?;

        if body
            .get("replicaFingerprint")
            .and_then(|value| value.as_str())
            != Some(self.expected_fingerprint.as_str())
        {
            return Err(WabiError::Validation {
                command: "latest_seq".into(),
                reason: "peer WabiDB root identity does not match local community".into(),
            });
        }
        if body.get("role").and_then(|value| value.as_str()) != Some("fenced-wabidb-only")
            || body.get("writerFenced").and_then(|value| value.as_bool()) != Some(true)
        {
            return Err(WabiError::Validation {
                command: "latest_seq".into(),
                reason: "peer is not the fenced passive WabiDB receiver".into(),
            });
        }

        let applied = body
            .get("appliedCommitSeq")
            .and_then(|value| value.as_u64());
        let latest = body.get("latestCommitSeq").and_then(|value| value.as_u64());
        let indexed = body
            .get("indexedCommitSeq")
            .and_then(|value| value.as_u64());
        let prefix_fingerprint = body
            .get("commitPrefixFingerprint")
            .and_then(|value| value.as_str());
        match (applied, latest, indexed, prefix_fingerprint) {
            (Some(applied), Some(latest), Some(indexed), Some(prefix))
                if applied == latest
                    && indexed >= applied
                    && prefix.len() == 64
                    && hex::decode(prefix).is_ok() =>
            {
                Ok(PeerPosition {
                    applied_seq: applied,
                    prefix_fingerprint: prefix.to_owned(),
                })
            }
            _ => Err(WabiError::Validation {
                command: "latest_position".into(),
                reason: "peer returned inconsistent applied/indexed positions or prefix".into(),
            }),
        }
    }

    async fn sync_auxiliary(
        &self,
        peer_endpoint: &str,
        projections: &ProjectionState,
    ) -> Result<()> {
        self.sync_sidecars(peer_endpoint).await?;
        if self.uploads_dir.is_none() {
            return Ok(());
        }
        let mut cursor = self.asset_cursor.lock().await;
        let url = Self::url(peer_endpoint, "/api/v1/sync/assets/missing");
        let mut request = self.client.get(&url);
        if let Some(after) = cursor.as_deref() {
            request = request.query(&[("after", after)]);
        }
        let response = Self::checked_response(self.authorized(request)?, "asset inventory").await?;
        let needs: AssetNeedsResponse = response
            .json()
            .await
            .map_err(|error| Self::io_error("asset inventory decode", error))?;
        if needs.entries.len() > 16
            || needs
                .next_after
                .as_deref()
                .is_some_and(|next| !upload_revocations::valid_filename(next))
            || needs
                .next_after
                .as_ref()
                .is_some_and(|next| cursor.as_ref() == Some(next))
        {
            return Err(WabiError::Validation {
                command: "sync_asset".into(),
                reason: "peer returned an invalid upload inventory page".into(),
            });
        }
        let mut budget = ASSET_TICK_BUDGET;
        let mut next_cursor = needs.next_after;
        for (index, need) in needs.entries.iter().enumerate() {
            if budget == 0 {
                next_cursor = if index == 0 {
                    cursor.clone()
                } else {
                    Some(needs.entries[index - 1].filename.clone())
                };
                break;
            }
            let sent = self
                .transfer_needed_asset(peer_endpoint, projections, need, budget)
                .await?;
            budget -= sent;
            if need.offset + sent < need.size {
                // Revisit this partially sent file on the next tick. Do not
                // skip the rest of the page when the byte budget runs out.
                next_cursor = if index == 0 {
                    cursor.clone()
                } else {
                    Some(needs.entries[index - 1].filename.clone())
                };
                break;
            }
        }
        *cursor = next_cursor;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pull_entry() -> SyncEntry {
        SyncEntry {
            commit_seq: 7,
            timestamp_micros: 8,
            caller_user_id: 9,
            caller_device_id_hash: [0x5a; 16],
            command_name_hash: [0xa5; 16],
            has_idempotency_key: true,
            idempotency_key_hash: Some([0x33; 32]),
            event_refs: vec![crate::api::sync::StreamRefEntry {
                stream_id_hash: hex::encode([0x7b; 16]),
                stream_id: "room-1".into(),
                stream_kind: 6,
                segment_id: 1,
                offset: 0,
                length: 32,
            }],
            payload_hashes: vec![hex::encode([0xc4; 32])],
        }
    }

    #[test]
    fn pull_keeps_binary_identity_hashes_and_rejects_malformed_peer_data() {
        let response = SyncPullResponse {
            latest_commit_seq: 7,
            entries: vec![pull_entry()],
        };
        let decoded = decode_pull_response(response, 4).unwrap();
        assert_eq!(decoded[0].caller_device_id_hash, [0x5a; 16]);
        assert_eq!(decoded[0].command_name_hash, [0xa5; 16]);
        assert_eq!(decoded[0].idempotency_key_hash, Some([0x33; 32]));
        assert_eq!(decoded[0].event_refs[0].stream_id_hash, [0x7b; 16]);
        assert_eq!(decoded[0].payload_hashes, vec![[0xc4; 32]]);

        for mutate in [
            ("payload", "malformed"),
            ("stream", "malformed"),
            ("metadata", ""),
        ] {
            let mut entry = pull_entry();
            match mutate.0 {
                "payload" => entry.payload_hashes[0] = mutate.1.into(),
                "stream" => entry.event_refs[0].stream_id_hash = mutate.1.into(),
                _ => entry.idempotency_key_hash = None,
            }
            assert!(decode_pull_response(
                SyncPullResponse {
                    latest_commit_seq: 7,
                    entries: vec![entry]
                },
                4
            )
            .is_err());
        }
        assert!(decode_pull_response(
            SyncPullResponse {
                latest_commit_seq: 7,
                entries: vec![pull_entry(), pull_entry()]
            },
            4
        )
        .is_err());
    }

    #[test]
    fn push_refuses_missing_or_symlinked_source_segments() {
        let temp = tempfile::tempdir().unwrap();
        let transport = ReqwestTransport::with_token(temp.path().into(), None, "fixture".into());
        let stream_id = "room-1";
        let reference = wabidb::commit_index::record::StreamRef {
            stream_id_hash: stream_id_hash(stream_id),
            stream_kind: 6,
            segment_id: 1,
            offset: 0,
            length: 1,
        };
        let entry = CommitIndexEntry {
            commit_seq: 1,
            timestamp_micros: 1,
            caller_user_id: 1,
            caller_device_id_hash: [0; 16],
            command_name_hash: [0; 16],
            has_idempotency_key: false,
            idempotency_key_hash: None,
            event_refs: vec![reference],
            payload_hashes: vec![[0; 32]],
        };
        assert!(transport
            .read_segments(std::slice::from_ref(&entry))
            .is_err());

        let events = temp
            .path()
            .join("streams")
            .join(wabidb::sequencer::stream_kind_dir_name(6))
            .join(stream_id)
            .join("events");
        std::fs::create_dir_all(&events).unwrap();
        let segment = events.join("00000001.wseg");
        std::fs::write(&segment, b"source bytes").unwrap();
        let mut later = entry.clone();
        later.commit_seq = 2;
        later.event_refs[0].offset = 7;
        later.event_refs[0].length = 5;
        let segments = transport
            .read_segments(&[entry.clone(), later.clone()])
            .unwrap();
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].data, b"source bytes");
        assert!(transport.entry_to_sync_entry(&later, &segments).is_ok());
        later.event_refs[0].offset = 12;
        assert!(transport.entry_to_sync_entry(&later, &segments).is_err());
        #[cfg(unix)]
        {
            std::fs::remove_file(&segment).unwrap();
            std::os::unix::fs::symlink(temp.path().join("outside"), &segment).unwrap();
            assert!(transport
                .read_segments(std::slice::from_ref(&entry))
                .is_err());
        }
    }

    #[test]
    fn replication_requests_require_explicit_experimental_opt_in_and_sync_token() {
        let missing = ReqwestTransport::with_token(
            PathBuf::from("/tmp/wabi-repl-test"),
            None,
            "fixture-fingerprint".into(),
        );
        assert!(missing
            .authorized_with_runtime(missing.client.get("http://127.0.0.1/status"), false)
            .is_err());
        assert!(missing
            .authorized_with_runtime(missing.client.get("http://127.0.0.1/status"), true)
            .is_err());

        let transport = ReqwestTransport::with_token(
            PathBuf::from("/tmp/wabi-repl-test"),
            Some("test-sync-secret".into()),
            "fixture-fingerprint".into(),
        );
        let request = transport
            .authorized_with_runtime(transport.client.get("http://127.0.0.1/status"), true)
            .unwrap()
            .build()
            .unwrap();
        assert_eq!(
            request
                .headers()
                .get(SYNC_TOKEN_HEADER)
                .and_then(|value| value.to_str().ok()),
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

    #[test]
    fn peer_endpoint_requires_https_or_explicit_private_transport() {
        assert!(ReqwestTransport::validate_peer_endpoint("http://127.0.0.1:47074", false).is_ok());
        assert!(
            ReqwestTransport::validate_peer_endpoint("https://203.0.113.7:47074", false).is_ok()
        );
        assert!(
            ReqwestTransport::validate_peer_endpoint("http://203.0.113.7:47074", true).is_err()
        );
        assert!(
            ReqwestTransport::validate_peer_endpoint("http://100.64.1.2:47074", false).is_err()
        );
        assert!(ReqwestTransport::validate_peer_endpoint("http://100.64.1.2:47074", true).is_ok());
        assert!(
            ReqwestTransport::validate_peer_endpoint("https://peer.example/private", false)
                .is_err()
        );
    }
}
