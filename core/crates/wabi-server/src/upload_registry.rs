//! Upload ownership registry for files served under the generic `/uploads/` URL space.
//!
//! The registry records upload ownership and revocations. Upload URLs remain
//! capability URLs, but the serve path consults revocations. Losing this file
//! can expose a previously revoked upload, so corrupt state must fail closed.
//!
//! Storage layout on disk:
//!   `<data_dir>/upload_registry.json`

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::RwLock;
use wabidb::{
    engine::WabiDbEngine,
    format::record::RecordKind,
    projections::{upload_assets as asset_projection, upload_revocations as revocation_projection},
    sequencer::types::{CommandCommit, EventToWrite, RoomOwnerPrecondition},
};

/// Classification of an uploaded file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UploadKind {
    Attachment,
    Avatar,
    Profile,
    Branding,
    Whiteboard,
    Other,
}

impl UploadKind {
    #[allow(dead_code)]
    pub fn as_str(&self) -> &'static str {
        match self {
            UploadKind::Attachment => "attachment",
            UploadKind::Avatar => "avatar",
            UploadKind::Profile => "profile",
            UploadKind::Branding => "branding",
            UploadKind::Whiteboard => "whiteboard",
            UploadKind::Other => "other",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadMeta {
    /// Final filename as served at `/uploads/{filename}` (e.g. `{uuid}.jpg`).
    pub filename: String,
    /// Original client-provided filename.
    pub original_name: String,
    pub channel_id: Option<String>,
    pub uploader_id: Option<i64>,
    pub kind: UploadKind,
    pub size: u64,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct UploadRegistryData {
    files: HashMap<String, UploadMeta>,
    /// Revoked filenames. A revoked file returns 410 from serve paths.
    #[serde(default)]
    revoked: HashSet<String>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyUploadBackfillReport {
    pub registry_entries: usize,
    pub already_canonical: usize,
    pub revoked: usize,
    pub missing: usize,
    pub eligible: usize,
    pub committed: usize,
    pub deferred: usize,
}

/// JSON-persisted registry of uploaded-file ownership and revocations.
///
/// `get`/`list`/`by_channel`/`total_bytes_for_channel` are read-side operators
/// for future admin tooling; `record` is the only write-path consumer today.
#[derive(Clone, Debug)]
pub struct UploadRegistry {
    data_path: PathBuf,
    inner: Arc<RwLock<UploadRegistryData>>,
}

impl UploadRegistry {
    /// Refuse a restored Authority with a nonempty uploads tree but no revocation history.
    /// Empty fresh installations can create the registry on their first upload.
    pub fn new_for_authority(
        data_dir: impl Into<PathBuf>,
        uploads_dir: impl AsRef<Path>,
    ) -> io::Result<Self> {
        let registry = Self::new_persistent(data_dir)?;
        match std::fs::symlink_metadata(&registry.data_path) {
            Ok(_) => return Ok(registry),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        match std::fs::read_dir(uploads_dir.as_ref()) {
            Ok(entries) => {
                for entry in entries {
                    let entry = entry?;
                    // An earlier startup may have made its empty staging
                    // directory before this guard ran. Only that exact empty
                    // real directory is harmless; staged bytes still block.
                    if entry.file_name() == ".tmp" {
                        let metadata = std::fs::symlink_metadata(entry.path())?;
                        if metadata.is_dir()
                            && !metadata.file_type().is_symlink()
                            && std::fs::read_dir(entry.path())?.next().transpose()?.is_none()
                        {
                            continue;
                        }
                    }
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "uploads directory is not empty but upload_registry.json is missing; restore the matching registry before starting the Authority",
                    ));
                }
                Ok(registry)
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(registry),
            Err(error) => Err(error),
        }
    }

    pub fn new_persistent(data_dir: impl Into<PathBuf>) -> io::Result<Self> {
        let data_path: PathBuf = data_dir.into().join("upload_registry.json");
        let data = match std::fs::symlink_metadata(&data_path) {
            Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
                serde_json::from_slice::<UploadRegistryData>(&std::fs::read(&data_path)?)
                    .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?
            }
            Ok(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "upload registry must be a regular file",
                ));
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => UploadRegistryData::default(),
            Err(error) => return Err(error),
        };
        Ok(Self {
            data_path,
            inner: Arc::new(RwLock::new(data)),
        })
    }

    /// Record ownership of an uploaded file.
    ///
    /// The caller must not report a successful upload when this write fails.
    pub async fn record(
        &self,
        filename: &str,
        original_name: &str,
        channel_id: Option<String>,
        uploader_id: Option<i64>,
        kind: UploadKind,
        size: u64,
    ) -> io::Result<()> {
        let mut guard = self.inner.write().await;
        if let Some(existing) = guard.files.get(filename) {
            if existing.original_name != original_name
                || existing.channel_id != channel_id
                || existing.uploader_id != uploader_id
                || existing.kind != kind
                || existing.size != size
            {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "upload filename already has different metadata",
                ));
            }
            // Retry after an event commit or failed rename must keep the
            // original timestamp so the canonical record stays identical.
            return self.persist_locked(&guard).await;
        }
        let meta = UploadMeta {
            filename: filename.to_string(),
            original_name: original_name.to_string(),
            channel_id,
            uploader_id,
            kind,
            size,
            created_at: Utc::now(),
        };
        guard.files.insert(filename.to_string(), meta);
        self.persist_locked(&guard).await
    }

    /// Keep a new upload outside the public file route until its ownership
    /// record is durable. A failed save leaves no file at the public path.
    pub async fn publish_bytes(
        &self,
        uploads_dir: &Path,
        engine: &WabiDbEngine,
        filename: &str,
        original_name: &str,
        channel_id: Option<String>,
        room_owner_precondition: Option<RoomOwnerPrecondition>,
        uploader_id: Option<i64>,
        kind: UploadKind,
        bytes: &[u8],
    ) -> io::Result<()> {
        validate_room_guard(channel_id.as_deref(), room_owner_precondition.as_ref(), false)?;
        let mut components = Path::new(filename).components();
        if !matches!(components.next(), Some(std::path::Component::Normal(_)))
            || components.next().is_some()
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "upload filename must be one path component",
            ));
        }
        let staging_dir = uploads_dir.join(".tmp");
        tokio::fs::create_dir_all(&staging_dir).await?;
        let staging_path = registry_staging_path(&staging_dir, filename);
        let result = async {
            match tokio::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&staging_path)
                .await
            {
                Ok(mut file) => {
                    file.write_all(bytes).await?;
                    file.sync_all().await?;
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    let metadata = tokio::fs::symlink_metadata(&staging_path).await?;
                    if !metadata.is_file()
                        || metadata.file_type().is_symlink()
                        || metadata.len() != bytes.len() as u64
                        || sha256_file(&staging_path).await? != hex::encode(Sha256::digest(bytes))
                    {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "existing staged upload bytes differ",
                        ));
                    }
                }
                Err(error) => return Err(error),
            }
            sync_upload_directory(&staging_dir).await?;
            self.record(
                filename,
                original_name,
                channel_id,
                uploader_id,
                kind,
                bytes.len() as u64,
            )
            .await?;
            self.prepare_published(
                filename,
                &hex::encode(Sha256::digest(bytes)),
                engine,
                room_owner_precondition,
            )
            .await?;
            tokio::fs::rename(&staging_path, uploads_dir.join(filename)).await?;
            sync_upload_directory(uploads_dir).await
        }
        .await;
        // Even an ambiguous commit error may have durably published the
        // expectation. Keep the private bytes for verified startup recovery.
        result
    }

    /// Look up ownership metadata for a filename.
    #[allow(dead_code)]
    pub async fn get(&self, filename: &str) -> Option<UploadMeta> {
        let guard = self.inner.read().await;
        guard.files.get(filename).cloned()
    }

    /// List all recorded files.
    #[allow(dead_code)]
    pub async fn list(&self) -> Vec<UploadMeta> {
        let guard = self.inner.read().await;
        let mut all: Vec<UploadMeta> = guard.files.values().cloned().collect();
        all.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        all
    }

    /// List all recorded files belonging to a channel.
    #[allow(dead_code)]
    pub async fn by_channel(&self, channel_id: &str) -> Vec<UploadMeta> {
        let guard = self.inner.read().await;
        guard
            .files
            .values()
            .filter(|m| m.channel_id.as_deref() == Some(channel_id))
            .cloned()
            .collect()
    }

    /// Total bytes recorded on disk for a channel.
    #[allow(dead_code)]
    pub async fn total_bytes_for_channel(&self, channel_id: &str) -> u64 {
        self.by_channel(channel_id)
            .await
            .iter()
            .map(|m| m.size)
            .sum()
    }

    /// Build legacy JSON-only fixtures for migration checks.
    #[cfg(test)]
    async fn revoke(&self, filename: &str) -> io::Result<bool> {
        let mut guard = self.inner.write().await;
        let newly_inserted = guard.revoked.insert(filename.to_string());
        // Keep the in-memory denial if the durable write fails. A repeated
        // request must retry persistence even when the name is already set.
        self.persist_locked(&guard).await?;
        Ok(newly_inserted)
    }

    /// Commit the denial to the replicated event log before acknowledging it.
    /// The JSON registry remains a local compatibility copy. Keep an in-memory
    /// denial even if either durable write fails.
    pub async fn revoke_canonical(
        &self,
        filename: &str,
        engine: &WabiDbEngine,
        actor_user_id: u64,
    ) -> io::Result<bool> {
        if !revocation_projection::valid_filename(filename) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid upload filename",
            ));
        }
        let mut guard = self.inner.write().await;
        let newly_inserted = guard.revoked.insert(filename.to_string());
        if engine
            .projection_state()
            .get(revocation_projection::INDEX, filename.as_bytes())
            .is_none()
        {
            commit_revocation(engine, filename, actor_user_id).await?;
        }
        self.persist_locked(&guard).await?;
        Ok(newly_inserted)
    }

    /// On Authority startup, import older JSON-only denials once and merge
    /// replicated denials back into the local registry. Never replace a newer
    /// canonical denial with a stale sidecar's empty set.
    pub async fn reconcile_revocations(&self, engine: &WabiDbEngine) -> io::Result<()> {
        let mut guard = self.inner.write().await;
        let mut canonical = HashSet::new();
        let mut error = None;
        engine
            .projection_state()
            .for_each(
                revocation_projection::INDEX,
                |key, value| match revocation_projection::decode(value) {
                    Ok(record) if key == record.filename.as_bytes() => {
                        canonical.insert(record.filename);
                    }
                    _ => {
                        error = Some(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "invalid canonical upload revocation",
                        ))
                    }
                },
            );
        if let Some(error) = error {
            return Err(error);
        }
        let mut legacy_only: Vec<_> = guard.revoked.difference(&canonical).cloned().collect();
        legacy_only.sort();
        for filename in legacy_only {
            if !revocation_projection::valid_filename(&filename) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "invalid legacy upload revocation",
                ));
            }
            commit_revocation(engine, &filename, 0).await?;
            canonical.insert(filename);
        }
        let before = guard.revoked.len();
        guard.revoked.extend(canonical);
        if guard.revoked.len() != before {
            self.persist_locked(&guard).await?;
        }
        Ok(())
    }

    /// Rebuild metadata that arrived through the event log after a stopped
    /// baseline. Refuse missing or changed nonrevoked bytes instead of making
    /// a restored Authority silently serve an incomplete upload tree.
    pub async fn reconcile_published_assets(
        &self,
        uploads_dir: &Path,
        engine: &WabiDbEngine,
    ) -> io::Result<usize> {
        let mut records = Vec::new();
        let mut invalid = false;
        engine
            .projection_state()
            .for_each(
                asset_projection::INDEX,
                |key, value| match asset_projection::decode(value) {
                    Ok(record) if key == record.filename.as_bytes() => records.push(record),
                    _ => invalid = true,
                },
            );
        if invalid {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid canonical upload publication record",
            ));
        }
        let mut guard = self.inner.write().await;
        let mut restored = 0;
        for record in records {
            let kind = match record.kind.as_str() {
                "attachment" => UploadKind::Attachment,
                "avatar" => UploadKind::Avatar,
                "profile" => UploadKind::Profile,
                "branding" => UploadKind::Branding,
                "whiteboard" => UploadKind::Whiteboard,
                "other" => UploadKind::Other,
                _ => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "invalid upload kind",
                    ))
                }
            };
            let created_at = DateTime::<Utc>::from_timestamp_micros(record.created_at_micros)
                .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid upload time"))?;
            let existing = guard.files.get(&record.filename);
            if let Some(existing) = existing {
                if existing.filename != record.filename
                    || existing.original_name != record.original_name
                    || existing.channel_id != record.channel_id
                    || existing.uploader_id != record.uploader_id
                    || existing.kind != kind
                    || existing.size != record.size
                    || existing.created_at.timestamp_micros() != record.created_at_micros
                {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "upload registry conflicts with canonical publication record",
                    ));
                }
            }
            if !guard.revoked.contains(&record.filename) {
                let path = uploads_dir.join(&record.filename);
                let metadata = match tokio::fs::symlink_metadata(&path).await {
                    Ok(metadata) => metadata,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {
                        recover_staged_upload(uploads_dir, &record).await?;
                        tokio::fs::symlink_metadata(&path).await?
                    }
                    Err(error) => return Err(error),
                };
                if !metadata.is_file()
                    || metadata.file_type().is_symlink()
                    || metadata.len() != record.size
                {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "published upload bytes are missing or changed",
                    ));
                }
                if sha256_file(&path).await? != record.sha256 {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "published upload digest differs from its publication record",
                    ));
                }
            }
            if existing.is_none() {
                guard.files.insert(
                    record.filename.clone(),
                    UploadMeta {
                        filename: record.filename,
                        original_name: record.original_name,
                        channel_id: record.channel_id,
                        uploader_id: record.uploader_id,
                        kind,
                        size: record.size,
                        created_at,
                    },
                );
                restored += 1;
            }
        }
        if restored > 0 {
            self.persist_locked(&guard).await?;
        }
        Ok(restored)
    }

    /// Explicit stopped-Authority migration for older files whose metadata
    /// exists only in upload_registry.json. Never infer ownership from an
    /// unregistered file or publish a revoked/missing entry.
    pub async fn backfill_legacy_assets(
        &self,
        uploads_dir: &Path,
        engine: &WabiDbEngine,
        limit: usize,
        commit: bool,
    ) -> io::Result<LegacyUploadBackfillReport> {
        if limit == 0 || limit > 1_000 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "legacy upload backfill limit must be between 1 and 1000",
            ));
        }
        let guard = self.inner.read().await;
        let mut entries: Vec<_> = guard
            .files
            .iter()
            .map(|(filename, meta)| (filename.clone(), meta.clone()))
            .collect();
        entries.sort_by(|(left, _), (right, _)| left.cmp(right));
        let mut revoked = guard.revoked.clone();
        drop(guard);
        if revoked
            .iter()
            .any(|filename| !revocation_projection::valid_filename(filename))
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid legacy upload revocation",
            ));
        }
        let mut invalid = false;
        engine
            .projection_state()
            .for_each(
                revocation_projection::INDEX,
                |key, value| match revocation_projection::decode(value) {
                    Ok(record) if key == record.filename.as_bytes() => {
                        revoked.insert(record.filename);
                    }
                    _ => invalid = true,
                },
            );
        if invalid {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid canonical upload revocation",
            ));
        }
        let mut report = LegacyUploadBackfillReport {
            registry_entries: entries.len(),
            ..Default::default()
        };
        let mut selected = Vec::new();
        for (filename, meta) in entries {
            if !revocation_projection::valid_filename(&filename) || meta.filename != filename {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "invalid legacy upload filename or registry key",
                ));
            }
            if revoked.contains(&filename) {
                report.revoked += 1;
                continue;
            }
            if let Some(existing) = engine
                .projection_state()
                .get(asset_projection::INDEX, filename.as_bytes())
            {
                let record = asset_projection::decode(&existing).map_err(io::Error::other)?;
                if record.filename != filename
                    || publication_record(&meta, &record.sha256) != record
                {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "legacy upload registry conflicts with canonical publication",
                    ));
                }
                report.already_canonical += 1;
                continue;
            }
            let path = uploads_dir.join(&filename);
            let metadata = match tokio::fs::symlink_metadata(&path).await {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    report.missing += 1;
                    continue;
                }
                Err(error) => return Err(error),
            };
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || metadata.len() != meta.size
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "legacy upload bytes are not a regular file of the recorded size",
                ));
            }
            if report.eligible == limit {
                report.deferred += 1;
                continue;
            }
            let sha256 = sha256_file(&path).await?;
            let record = publication_record(&meta, &sha256);
            let payload = serde_json::to_vec(&record).map_err(io::Error::other)?;
            asset_projection::decode(&payload).map_err(io::Error::other)?;
            report.eligible += 1;
            selected.push((filename, sha256));
        }
        if commit {
            for (filename, sha256) in selected {
                // This operator-only migration requires the Authority to be
                // stopped; it cannot infer a room's live owner from legacy JSON.
                self.prepare_published_inner(&filename, &sha256, engine, None, true)
                    .await?;
                report.committed += 1;
            }
        }
        Ok(report)
    }

    /// True if this filename has been revoked.
    pub async fn is_revoked(&self, filename: &str) -> bool {
        let guard = self.inner.read().await;
        guard.revoked.contains(filename)
    }

    /// Commit the expected bytes while the file is still private. A receiver
    /// must verify this digest and the actual file before considering it ready.
    pub async fn prepare_published(
        &self,
        filename: &str,
        sha256: &str,
        engine: &WabiDbEngine,
        room_owner_precondition: Option<RoomOwnerPrecondition>,
    ) -> io::Result<()> {
        self.prepare_published_inner(
            filename,
            sha256,
            engine,
            room_owner_precondition,
            false,
        )
        .await
    }

    async fn prepare_published_inner(
        &self,
        filename: &str,
        sha256: &str,
        engine: &WabiDbEngine,
        room_owner_precondition: Option<RoomOwnerPrecondition>,
        allow_unfenced_room: bool,
    ) -> io::Result<()> {
        let guard = self.inner.write().await;
        let meta = guard
            .files
            .get(filename)
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "upload metadata is missing"))?;
        validate_room_guard(
            meta.channel_id.as_deref(),
            room_owner_precondition.as_ref(),
            allow_unfenced_room,
        )?;
        let record = publication_record(meta, sha256);
        let payload = serde_json::to_vec(&record).map_err(io::Error::other)?;
        asset_projection::decode(&payload).map_err(io::Error::other)?;
        if let Some(existing) = engine
            .projection_state()
            .get(asset_projection::INDEX, filename.as_bytes())
        {
            if asset_projection::decode(&existing).map_err(io::Error::other)? != record {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "upload identity or digest changed",
                ));
            }
            return Ok(());
        }
        engine
            .get_or_create_stream_key(asset_projection::STREAM)
            .await
            .map_err(io::Error::other)?;
        engine
            .run_command(CommandCommit {
                room_owner_precondition,
                caller_user_id: meta
                    .uploader_id
                    .and_then(|id| u64::try_from(id).ok())
                    .unwrap_or(0),
                caller_device_id: "primary".into(),
                command_name: asset_projection::EVENT.into(),
                idempotency_key: None,
                essential: true,
                response_tx: tokio::sync::oneshot::channel().0,
                events: vec![EventToWrite {
                    stream_id: asset_projection::STREAM.into(),
                    stream_kind: 6,
                    event_type: asset_projection::EVENT.into(),
                    record_kind: RecordKind::Event,
                    plaintext: payload,
                }],
            })
            .await
            .map_err(io::Error::other)?;
        Ok(())
    }

    async fn persist_locked(&self, data: &UploadRegistryData) -> io::Result<()> {
        let bytes = serde_json::to_vec_pretty(data).map_err(io::Error::other)?;
        let path = self.data_path.clone();
        tokio::task::spawn_blocking(move || write_registry_atomically(&path, &bytes))
            .await
            .map_err(io::Error::other)?
    }
}

fn validate_room_guard(
    channel_id: Option<&str>,
    precondition: Option<&RoomOwnerPrecondition>,
    allow_unfenced_room: bool,
) -> io::Result<()> {
    match (channel_id, precondition) {
        (None, None) => Ok(()),
        (Some(_), None) if allow_unfenced_room => Ok(()),
        (Some(channel_id), Some(precondition))
            if !channel_id.is_empty() && precondition.channel_id == channel_id =>
        {
            Ok(())
        }
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "room upload needs a matching owner precondition",
        )),
    }
}

fn publication_record(meta: &UploadMeta, sha256: &str) -> asset_projection::UploadAssetRecord {
    asset_projection::UploadAssetRecord {
        schema_version: 1,
        filename: meta.filename.clone(),
        original_name: meta.original_name.clone(),
        channel_id: meta.channel_id.clone(),
        uploader_id: meta.uploader_id,
        kind: meta.kind.as_str().into(),
        size: meta.size,
        sha256: sha256.to_string(),
        created_at_micros: meta.created_at.timestamp_micros(),
    }
}

fn registry_staging_path(staging_dir: &Path, filename: &str) -> PathBuf {
    staging_dir.join(format!(
        "registry-{}",
        hex::encode(Sha256::digest(filename.as_bytes()))
    ))
}

fn resumable_staging_path(staging_dir: &Path, filename: &str) -> Option<PathBuf> {
    let id = filename.get(..36)?;
    if filename.get(36..37) != Some(".") || uuid::Uuid::parse_str(id).ok()?.to_string() != id {
        return None;
    }
    Some(staging_dir.join(id))
}

async fn recover_staged_upload(
    uploads_dir: &Path,
    record: &asset_projection::UploadAssetRecord,
) -> io::Result<()> {
    let staging_dir = uploads_dir.join(".tmp");
    let staging_meta = tokio::fs::symlink_metadata(&staging_dir)
        .await
        .map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    "published upload bytes are missing",
                )
            } else {
                error
            }
        })?;
    if !staging_meta.is_dir() || staging_meta.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "upload staging directory is not a regular directory",
        ));
    }
    let candidates = [
        Some(registry_staging_path(&staging_dir, &record.filename)),
        resumable_staging_path(&staging_dir, &record.filename),
    ];
    for candidate in candidates.into_iter().flatten() {
        let metadata = match tokio::fs::symlink_metadata(&candidate).await {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() != record.size
            || sha256_file(&candidate).await? != record.sha256
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "staged upload bytes differ from their publication record",
            ));
        }
        tokio::fs::File::open(&candidate).await?.sync_all().await?;
        sync_upload_directory(&staging_dir).await?;
        tokio::fs::rename(&candidate, uploads_dir.join(&record.filename)).await?;
        sync_upload_directory(uploads_dir).await?;
        sync_upload_directory(&staging_dir).await?;
        return Ok(());
    }
    Err(io::Error::new(
        io::ErrorKind::InvalidData,
        "published upload bytes are missing",
    ))
}

pub async fn sha256_file(path: &Path) -> io::Result<String> {
    let mut file = tokio::fs::File::open(path).await?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let count = file.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(hex::encode(digest.finalize()))
}

async fn commit_revocation(
    engine: &WabiDbEngine,
    filename: &str,
    actor_user_id: u64,
) -> io::Result<()> {
    let payload = serde_json::to_vec(&revocation_projection::RevokedUploadRecord {
        schema_version: 1,
        filename: filename.to_string(),
    })
    .map_err(io::Error::other)?;
    revocation_projection::decode(&payload).map_err(io::Error::other)?;
    engine
        .get_or_create_stream_key(revocation_projection::STREAM)
        .await
        .map_err(io::Error::other)?;
    engine
        .run_command(CommandCommit {
            room_owner_precondition: None,
            caller_user_id: actor_user_id,
            caller_device_id: "primary".into(),
            command_name: revocation_projection::EVENT.into(),
            idempotency_key: None,
            essential: true,
            response_tx: tokio::sync::oneshot::channel().0,
            events: vec![EventToWrite {
                stream_id: revocation_projection::STREAM.into(),
                stream_kind: 6,
                event_type: revocation_projection::EVENT.into(),
                record_kind: RecordKind::Event,
                plaintext: payload,
            }],
        })
        .await
        .map_err(io::Error::other)?;
    Ok(())
}

/// Sync a published upload's directory entry on Unix before acknowledging it.
/// The file bytes and registry were synced earlier in the publication path.
pub async fn sync_upload_directory(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        let path = path.to_path_buf();
        tokio::task::spawn_blocking(move || std::fs::File::open(path)?.sync_all())
            .await
            .map_err(io::Error::other)?
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

fn write_registry_atomically(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("registry has no parent"))?;
    std::fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".upload-registry-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> io::Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, path)?;
        #[cfg(unix)]
        std::fs::File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;
    use wabidb::{crypto::bootstrap::BootstrapSource, engine::WabiDbConfig};

    async fn test_engine(path: &Path) -> WabiDbEngine {
        let mut config =
            WabiDbConfig::new(path.to_path_buf(), BootstrapSource::Provided([7_u8; 32]));
        config.allow_init = true;
        WabiDbEngine::open(config).await.unwrap()
    }

    #[tokio::test]
    async fn roundtrip_record_reload_list() {
        let tmp = std::env::temp_dir().join(format!("wabi-upload-reg-test-{}", Uuid::new_v4()));
        let reg = UploadRegistry::new_persistent(&tmp).unwrap();

        let files = [
            (
                "attach-1.jpg",
                "photo.jpg",
                Some("ch_1"),
                Some(42),
                UploadKind::Attachment,
                4096,
            ),
            (
                "avatar-1.png",
                "pic.png",
                Some("ch_2"),
                Some(7),
                UploadKind::Avatar,
                2048,
            ),
            (
                "profile-1.jpg",
                "avatar.jpg",
                None,
                Some(42),
                UploadKind::Profile,
                512,
            ),
            (
                "brand-1.png",
                "logo.png",
                Some("ch_3"),
                Some(9),
                UploadKind::Branding,
                8192,
            ),
            (
                "wb-1.png",
                "drawing.png",
                Some("ch_2"),
                Some(7),
                UploadKind::Whiteboard,
                1024,
            ),
        ];

        for (filename, original, channel, uploader, kind, size) in files {
            reg.record(
                filename,
                original,
                channel.map(str::to_string),
                uploader,
                kind,
                size,
            )
            .await
            .unwrap();
        }

        // In-memory lookups — each recorded file returns its own kind
        for (filename, original, channel, uploader, kind, size) in files {
            let meta = reg.get(filename).await.unwrap();
            assert_eq!(meta.kind, kind);
            assert_eq!(meta.original_name, original);
            assert_eq!(meta.channel_id.as_deref(), channel);
            assert_eq!(meta.uploader_id, uploader);
            assert_eq!(meta.size, size);
        }

        let ch1 = reg.by_channel("ch_1").await;
        assert_eq!(ch1.len(), 1);
        assert_eq!(reg.total_bytes_for_channel("ch_1").await, 4096);
        assert_eq!(reg.total_bytes_for_channel("ch_2").await, 3072);

        // Reload from disk — all five kinds survive a restart
        let reg2 = UploadRegistry::new_persistent(&tmp).unwrap();
        assert_eq!(reg2.list().await.len(), 5);
        for (filename, _, _, _, kind, _) in files {
            assert_eq!(reg2.get(filename).await.unwrap().kind, kind);
        }

        // Corruption cannot erase previously revoked names on startup.
        std::fs::write(tmp.join("upload_registry.json"), "{ not json").unwrap();
        assert!(UploadRegistry::new_persistent(&tmp).is_err());

        let _ = tokio::fs::remove_dir_all(&tmp).await;
    }

    #[tokio::test]
    async fn revoke_and_is_revoked_roundtrip() {
        let tmp = std::env::temp_dir().join(format!("wabi-upload-reg-revoke-{}", Uuid::new_v4()));
        let reg = UploadRegistry::new_persistent(&tmp).unwrap();
        reg.record(
            "file-1.png",
            "pic.png",
            Some("ch_1".to_string()),
            Some(42),
            UploadKind::Attachment,
            1024,
        )
        .await
        .unwrap();

        assert!(!reg.is_revoked("file-1.png").await);
        assert!(reg.revoke("file-1.png").await.unwrap()); // newly revoked
        assert!(!reg.revoke("file-1.png").await.unwrap()); // already revoked
        assert!(reg.is_revoked("file-1.png").await);

        // Reload from disk — revocation persists.
        let reg2 = UploadRegistry::new_persistent(&tmp).unwrap();
        assert!(reg2.is_revoked("file-1.png").await);

        let _ = tokio::fs::remove_dir_all(&tmp).await;
    }

    #[tokio::test]
    async fn failed_revocation_save_is_not_reported_as_success_and_can_retry() {
        let tmp = tempfile::tempdir().unwrap();
        let reg = UploadRegistry::new_persistent(tmp.path()).unwrap();
        let registry_path = tmp.path().join("upload_registry.json");
        std::fs::create_dir(&registry_path).unwrap();
        assert!(reg.revoke("private.png").await.is_err());
        assert!(reg.is_revoked("private.png").await);

        std::fs::remove_dir(&registry_path).unwrap();
        assert!(!reg.revoke("private.png").await.unwrap());
        let reloaded = UploadRegistry::new_persistent(tmp.path()).unwrap();
        assert!(reloaded.is_revoked("private.png").await);
    }

    #[test]
    fn existing_uploads_without_registry_refuse_authority_startup() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        let uploads = temp.path().join("uploads");
        std::fs::create_dir(&data).unwrap();
        std::fs::create_dir(&uploads).unwrap();
        assert!(UploadRegistry::new_for_authority(&data, &uploads).is_ok());

        let staging = uploads.join(".tmp");
        std::fs::create_dir(&staging).unwrap();
        assert!(UploadRegistry::new_for_authority(&data, &uploads).is_ok());
        std::fs::write(staging.join("unfinished.part"), b"private").unwrap();
        assert!(UploadRegistry::new_for_authority(&data, &uploads).is_err());
        std::fs::remove_file(staging.join("unfinished.part")).unwrap();
        assert!(UploadRegistry::new_for_authority(&data, &uploads).is_ok());

        std::fs::write(uploads.join("old-private-file.bin"), b"private").unwrap();
        assert!(UploadRegistry::new_for_authority(&data, &uploads).is_err());

        std::fs::write(
            data.join("upload_registry.json"),
            br#"{"files":{},"revoked":[]}"#,
        )
        .unwrap();
        assert!(UploadRegistry::new_for_authority(&data, &uploads).is_ok());
    }

    #[tokio::test]
    async fn failed_registry_save_never_publishes_new_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        let uploads = temp.path().join("uploads");
        std::fs::create_dir(&data).unwrap();
        std::fs::create_dir(data.join("upload_registry.json")).unwrap();
        let registry = UploadRegistry {
            data_path: data.join("upload_registry.json"),
            inner: Arc::new(RwLock::new(UploadRegistryData::default())),
        };
        let engine = test_engine(&temp.path().join("wabidb")).await;
        assert!(registry
            .publish_bytes(
                &uploads,
                &engine,
                "new-file.bin",
                "new-file.bin",
                None,
                None,
                Some(1),
                UploadKind::Attachment,
                b"private",
            )
            .await
            .is_err());
        assert!(!uploads.join("new-file.bin").exists());
    }

    #[tokio::test]
    async fn published_bytes_have_a_durable_registry_entry() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        let uploads = temp.path().join("uploads");
        let registry = UploadRegistry::new_persistent(&data).unwrap();
        let engine = test_engine(&data.join("wabidb")).await;
        registry
            .publish_bytes(
                &uploads,
                &engine,
                "new-file.bin",
                "new-file.bin",
                None,
                None,
                Some(1),
                UploadKind::Attachment,
                b"private",
            )
            .await
            .unwrap();
        assert_eq!(
            std::fs::read(uploads.join("new-file.bin")).unwrap(),
            b"private"
        );
        assert!(UploadRegistry::new_persistent(&data)
            .unwrap()
            .get("new-file.bin")
            .await
            .is_some());
        let projected = engine
            .projection_state()
            .get(asset_projection::INDEX, b"new-file.bin")
            .expect("upload expectation committed before publication");
        let projected = asset_projection::decode(&projected).unwrap();
        assert_eq!(projected.sha256, hex::encode(Sha256::digest(b"private")));
    }

    #[tokio::test]
    async fn retry_keeps_upload_identity_and_rejects_filename_reuse() {
        let temp = tempfile::tempdir().unwrap();
        let registry = UploadRegistry::new_persistent(temp.path()).unwrap();
        registry
            .record(
                "retry.bin",
                "one.bin",
                None,
                Some(1),
                UploadKind::Attachment,
                3,
            )
            .await
            .unwrap();
        let original = registry.get("retry.bin").await.unwrap();
        registry
            .record(
                "retry.bin",
                "one.bin",
                None,
                Some(1),
                UploadKind::Attachment,
                3,
            )
            .await
            .unwrap();
        assert_eq!(
            registry.get("retry.bin").await.unwrap().created_at,
            original.created_at
        );
        assert!(registry
            .record(
                "retry.bin",
                "two.bin",
                None,
                Some(1),
                UploadKind::Attachment,
                3
            )
            .await
            .is_err());
    }

    #[tokio::test]
    async fn stale_registry_restores_only_a_verified_published_file() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        let uploads = temp.path().join("uploads");
        let registry = UploadRegistry::new_persistent(&data).unwrap();
        let engine = test_engine(&data.join("wabidb")).await;
        registry
            .publish_bytes(
                &uploads,
                &engine,
                "restored.bin",
                "photo.bin",
                Some("channel-1".into()),
                Some(RoomOwnerPrecondition {
                    channel_id: "channel-1".into(),
                    owner_node_id: "node-1".into(),
                    expected_epoch: None,
                }),
                Some(7),
                UploadKind::Attachment,
                b"right",
            )
            .await
            .unwrap();
        let registry_path = data.join("upload_registry.json");
        std::fs::write(&registry_path, br#"{"files":{},"revoked":[]}"#).unwrap();
        let stale = UploadRegistry::new_persistent(&data).unwrap();
        assert_eq!(
            stale
                .reconcile_published_assets(&uploads, &engine)
                .await
                .unwrap(),
            1
        );
        let repaired = UploadRegistry::new_persistent(&data).unwrap();
        assert_eq!(
            repaired.get("restored.bin").await.unwrap().original_name,
            "photo.bin"
        );

        std::fs::write(&registry_path, br#"{"files":{},"revoked":[]}"#).unwrap();
        std::fs::write(uploads.join("restored.bin"), b"wrong").unwrap();
        let stale = UploadRegistry::new_persistent(&data).unwrap();
        assert!(stale
            .reconcile_published_assets(&uploads, &engine)
            .await
            .is_err());
        assert!(stale.get("restored.bin").await.is_none());
        std::fs::remove_file(uploads.join("restored.bin")).unwrap();
        assert!(stale
            .reconcile_published_assets(&uploads, &engine)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn legacy_backfill_previews_and_commits_only_registered_nonrevoked_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        let uploads = temp.path().join("uploads");
        std::fs::create_dir_all(&uploads).unwrap();
        let registry = UploadRegistry::new_persistent(&data).unwrap();
        let engine = test_engine(&data.join("wabidb")).await;
        for (filename, bytes) in [
            ("a.bin", b"first".as_slice()),
            ("b.bin", b"second".as_slice()),
            ("c.bin", b"secret".as_slice()),
            ("d.bin", b"absent".as_slice()),
        ] {
            registry
                .record(
                    filename,
                    filename,
                    None,
                    Some(7),
                    UploadKind::Attachment,
                    bytes.len() as u64,
                )
                .await
                .unwrap();
            if filename != "d.bin" {
                std::fs::write(uploads.join(filename), bytes).unwrap();
            }
        }
        registry.revoke("c.bin").await.unwrap();
        let preview = registry
            .backfill_legacy_assets(&uploads, &engine, 1, false)
            .await
            .unwrap();
        assert_eq!(preview.registry_entries, 4);
        assert_eq!(preview.eligible, 1);
        assert_eq!(preview.deferred, 1);
        assert_eq!(preview.revoked, 1);
        assert_eq!(preview.missing, 1);
        assert_eq!(preview.committed, 0);
        assert!(engine
            .projection_state()
            .get(asset_projection::INDEX, b"a.bin")
            .is_none());

        let first = registry
            .backfill_legacy_assets(&uploads, &engine, 1, true)
            .await
            .unwrap();
        assert_eq!(first.committed, 1);
        assert!(engine
            .projection_state()
            .get(asset_projection::INDEX, b"a.bin")
            .is_some());
        let second = registry
            .backfill_legacy_assets(&uploads, &engine, 1, true)
            .await
            .unwrap();
        assert_eq!(second.already_canonical, 1);
        assert_eq!(second.committed, 1);
        assert!(engine
            .projection_state()
            .get(asset_projection::INDEX, b"b.bin")
            .is_some());
        assert!(engine
            .projection_state()
            .get(asset_projection::INDEX, b"c.bin")
            .is_none());
        assert!(engine
            .projection_state()
            .get(asset_projection::INDEX, b"d.bin")
            .is_none());
    }

    #[tokio::test]
    async fn legacy_backfill_honors_canonical_revocation_even_with_stale_registry() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        let uploads = temp.path().join("uploads");
        std::fs::create_dir_all(&uploads).unwrap();
        let registry = UploadRegistry::new_persistent(&data).unwrap();
        let engine = test_engine(&data.join("wabidb")).await;
        registry
            .record(
                "denied.bin",
                "denied.bin",
                None,
                Some(7),
                UploadKind::Other,
                4,
            )
            .await
            .unwrap();
        std::fs::write(uploads.join("denied.bin"), b"data").unwrap();
        registry
            .revoke_canonical("denied.bin", &engine, 7)
            .await
            .unwrap();
        std::fs::write(
            data.join("upload_registry.json"),
            br#"{"files":{},"revoked":[]}"#,
        )
        .unwrap();
        let stale = UploadRegistry::new_persistent(&data).unwrap();
        stale
            .record(
                "denied.bin",
                "denied.bin",
                None,
                Some(7),
                UploadKind::Other,
                4,
            )
            .await
            .unwrap();
        let report = stale
            .backfill_legacy_assets(&uploads, &engine, 100, true)
            .await
            .unwrap();
        assert_eq!(report.revoked, 1);
        assert_eq!(report.committed, 0);
        assert!(engine
            .projection_state()
            .get(asset_projection::INDEX, b"denied.bin")
            .is_none());
    }

    #[tokio::test]
    async fn legacy_backfill_preflights_size_mismatch_before_any_commit() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        let uploads = temp.path().join("uploads");
        std::fs::create_dir_all(&uploads).unwrap();
        let registry = UploadRegistry::new_persistent(&data).unwrap();
        let engine = test_engine(&data.join("wabidb")).await;
        for filename in ["a.bin", "b.bin"] {
            registry
                .record(filename, filename, None, Some(7), UploadKind::Attachment, 4)
                .await
                .unwrap();
        }
        std::fs::write(uploads.join("a.bin"), b"good").unwrap();
        std::fs::write(uploads.join("b.bin"), b"wrong-size").unwrap();
        assert!(registry
            .backfill_legacy_assets(&uploads, &engine, 100, true)
            .await
            .is_err());
        assert!(engine
            .projection_state()
            .get(asset_projection::INDEX, b"a.bin")
            .is_none());
    }

    #[tokio::test]
    async fn legacy_and_new_revocations_recover_from_canonical_events() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        let registry = UploadRegistry::new_persistent(&data).unwrap();
        registry.revoke("legacy.png").await.unwrap();
        let engine = test_engine(&data.join("wabidb")).await;
        registry.reconcile_revocations(&engine).await.unwrap();
        assert!(engine
            .projection_state()
            .get(revocation_projection::INDEX, b"legacy.png")
            .is_some());

        assert!(registry
            .revoke_canonical("new.png", &engine, 42)
            .await
            .unwrap());
        let after_first = engine.barrier().current();
        assert!(!registry
            .revoke_canonical("new.png", &engine, 42)
            .await
            .unwrap());
        assert_eq!(engine.barrier().current(), after_first);

        std::fs::write(
            data.join("upload_registry.json"),
            br#"{"files":{},"revoked":[]}"#,
        )
        .unwrap();
        let recovered = UploadRegistry::new_persistent(&data).unwrap();
        recovered.reconcile_revocations(&engine).await.unwrap();
        assert!(recovered.is_revoked("legacy.png").await);
        assert!(recovered.is_revoked("new.png").await);
        let reloaded = UploadRegistry::new_persistent(&data).unwrap();
        assert!(reloaded.is_revoked("legacy.png").await);
        assert!(reloaded.is_revoked("new.png").await);
    }

    #[tokio::test]
    async fn committed_revocation_survives_failed_json_save() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        let registry = UploadRegistry::new_persistent(&data).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        let registry_path = data.join("upload_registry.json");
        std::fs::create_dir(&registry_path).unwrap();
        let engine = test_engine(&data.join("wabidb")).await;
        assert!(registry
            .revoke_canonical("private.png", &engine, 42)
            .await
            .is_err());
        assert!(registry.is_revoked("private.png").await);
        assert!(engine
            .projection_state()
            .get(revocation_projection::INDEX, b"private.png")
            .is_some());

        std::fs::remove_dir(&registry_path).unwrap();
        let recovered = UploadRegistry::new_persistent(&data).unwrap();
        recovered.reconcile_revocations(&engine).await.unwrap();
        assert!(recovered.is_revoked("private.png").await);
    }
}
