//! Development-only passive WabiDB receiver. It does not replicate the full
//! Wabi Authority state or provide a promotion path.

use anyhow::{bail, Context, Result};
use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path as AxumPath, Query, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post, put},
    Json, Router,
};
use clap::Parser;
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    io::ErrorKind,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncSeekExt, AsyncWriteExt},
    sync::Mutex,
};
use wabi_server::api::sync::{ingest_push_to_fenced_engine, SyncPushRequest, SyncPushResponse};
use wabi_server::instance_sidecars::{self, SidecarDigest, SidecarInventory};
use wabi_server::replication_transport::{AssetNeed, AssetNeedsResponse, AssetPutResponse};
use wabi_server::upload_registry::{sha256_file, sync_upload_directory};
use wabidb::{
    crypto::bootstrap::BootstrapSource,
    engine::{WabiDbConfig, WabiDbEngine},
    projections::{upload_assets, upload_revocations},
};

const ASSET_CHUNK_MAX: usize = 1024 * 1024;

#[derive(Parser)]
#[command(about = "Development-only fenced WabiDB receiver; never a full Wabi standby")]
struct Args {
    #[arg(long)]
    data_dir: PathBuf,
    #[arg(long)]
    token_file: PathBuf,
    /// Defaults to <data-dir>/root_key. External key deployments must supply a private file.
    #[arg(long)]
    root_key_file: Option<PathBuf>,
    /// Optional passive upload tree restored from the same stopped archive.
    #[arg(long)]
    uploads_dir: Option<PathBuf>,
    /// Optional Authority data tree from the same fenced stopped restore.
    #[arg(long)]
    instance_dir: Option<PathBuf>,
    #[arg(long, default_value = "127.0.0.1:47074")]
    listen: SocketAddr,
    #[arg(long)]
    allow_remote_listen: bool,
    /// Required acknowledgment that this is not a full Wabi standby.
    #[arg(long)]
    experimental_replication: bool,
}

#[derive(Clone)]
struct ReplicaState {
    engine: Arc<WabiDbEngine>,
    token: Arc<str>,
    uploads_dir: Option<Arc<PathBuf>>,
    asset_gate: Arc<Mutex<()>>,
    upload_pruned_through: Arc<AtomicU64>,
    instance_dir: Option<Arc<PathBuf>>,
    sidecar_gate: Arc<Mutex<()>>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    if !args.experimental_replication {
        bail!("--experimental-replication is required; this is not a full Wabi standby");
    }
    if !args.listen.ip().is_loopback() && !args.allow_remote_listen {
        bail!("non-loopback listening requires --allow-remote-listen and a protected transport");
    }
    let metadata = tokio::fs::symlink_metadata(&args.data_dir)
        .await
        .context("WabiDB data directory is missing")?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        bail!("WabiDB data directory must be a real directory");
    }
    if let Some(ref uploads_dir) = args.uploads_dir {
        let metadata = tokio::fs::symlink_metadata(uploads_dir)
            .await
            .context("passive uploads directory is missing")?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            bail!("passive uploads directory must be a real directory");
        }
    }
    if let Some(ref instance_dir) = args.instance_dir {
        let metadata = tokio::fs::symlink_metadata(instance_dir)
            .await
            .context("passive Authority data directory is missing")?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            bail!("passive Authority data directory must be a real directory");
        }
        let parent_db = tokio::fs::canonicalize(instance_dir.join("wabidb")).await?;
        let configured_db = tokio::fs::canonicalize(&args.data_dir).await?;
        if parent_db != configured_db {
            bail!("--instance-dir must contain the configured fenced WabiDB tree");
        }
    }
    let token = read_private_text(&args.token_file, "sync token").await?;
    if token.len() < 32 || !token.is_ascii() || token.bytes().any(|byte| byte.is_ascii_whitespace())
    {
        bail!("sync token must contain at least 32 non-whitespace ASCII characters");
    }
    let key_path = args
        .root_key_file
        .unwrap_or_else(|| args.data_dir.join("root_key"));
    let key_text = read_private_text(&key_path, "WabiDB root key").await?;
    let bytes = hex::decode(key_text.trim()).context("WabiDB root key is not hex")?;
    let key: [u8; 32] = bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("WabiDB root key must decode to 32 bytes"))?;
    let config = WabiDbConfig::new(args.data_dir, BootstrapSource::Provided(key));
    let engine = Arc::new(WabiDbEngine::open(config).await?);
    if !engine.local_writer_fenced().await || !engine.durable_writer_fenced() {
        bail!("passive receiver requires an existing durable writer-fenced-v1 marker");
    }
    let state = ReplicaState {
        engine,
        token: token.into(),
        uploads_dir: args.uploads_dir.map(Arc::new),
        asset_gate: Arc::new(Mutex::new(())),
        upload_pruned_through: Arc::new(AtomicU64::new(0)),
        instance_dir: args.instance_dir.map(Arc::new),
        sidecar_gate: Arc::new(Mutex::new(())),
    };
    let prune_task = if state.uploads_dir.is_some() {
        prune_revoked_uploads(&state)
            .await
            .map_err(|(_, message)| anyhow::anyhow!(message))?;
        let prune_state = state.clone();
        Some(tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(5)).await;
                if let Err((status, message)) = prune_revoked_uploads(&prune_state).await {
                    tracing::warn!(%status, message, "passive upload revocation cleanup failed");
                }
            }
        }))
    } else {
        None
    };
    let router = router(state.clone());
    let listener = tokio::net::TcpListener::bind(args.listen).await?;
    println!(
        "Fenced WabiDB development receiver listening on {}",
        listener.local_addr()?
    );
    let serve_result = axum::serve(listener, router)
        .with_graceful_shutdown(wait_for_shutdown())
        .await;
    if let Some(task) = prune_task {
        task.abort();
        let _ = task.await;
    }
    // After all requests drain, dropping the last engine owner saves its
    // projection checkpoint and releases the local WabiDB process lock.
    drop(state);
    serve_result?;
    Ok(())
}

async fn wait_for_shutdown() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("install SIGTERM handler for fenced receiver");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = terminate.recv() => {},
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

async fn read_private_text(path: &Path, description: &str) -> Result<String> {
    let metadata = tokio::fs::symlink_metadata(path).await?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        bail!("{description} must be a regular file");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            bail!("{description} file must be private (mode 0600)");
        }
    }
    if metadata.len() > 4096 {
        bail!("{description} file is too large");
    }
    Ok(tokio::fs::read_to_string(path).await?.trim().to_owned())
}

fn authorized(headers: &HeaderMap, token: &str) -> bool {
    let Some(provided) = headers
        .get("x-wabi-sync-token")
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    provided.len() == token.len()
        && provided
            .bytes()
            .zip(token.bytes())
            .fold(0u8, |diff, (left, right)| diff | (left ^ right))
            == 0
}

fn router(state: ReplicaState) -> Router {
    Router::new()
        .route("/livez", get(|| async { StatusCode::OK }))
        .route("/api/v1/sync/status", get(status))
        .route("/api/v1/sync/push", post(push))
        .route("/api/v1/sync/assets/missing", get(missing_assets))
        .route(
            "/api/v1/sync/assets/{filename}",
            put(put_asset).layer(DefaultBodyLimit::max(ASSET_CHUNK_MAX)),
        )
        .route("/api/v1/sync/sidecars", get(sidecar_inventory))
        .route(
            "/api/v1/sync/sidecars/{name}",
            put(put_sidecar)
                .delete(delete_sidecar)
                .layer(DefaultBodyLimit::max(instance_sidecars::MAX_FILE_BYTES)),
        )
        .with_state(state)
}

async fn status(
    State(state): State<ReplicaState>,
    headers: HeaderMap,
) -> std::result::Result<Json<serde_json::Value>, (StatusCode, &'static str)> {
    if !authorized(&headers, &state.token) {
        return Err((StatusCode::UNAUTHORIZED, "invalid sync token"));
    }
    let applied = state.engine.barrier().current();
    let index_dir = state.engine.data_dir().join("global/commit-index");
    let entries = wabidb::commit_index::batcher::read_all_entries(&index_dir).map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot read commit index",
        )
    })?;
    let indexed = entries.last().map(|entry| entry.commit_seq).unwrap_or(0);
    Ok(Json(json!({
        "role": "fenced-wabidb-only",
        "replicaFingerprint": state.engine.replica_fingerprint(),
        "latestCommitSeq": applied,
        "appliedCommitSeq": applied,
        "indexedCommitSeq": indexed,
        "commitPrefixFingerprint": wabidb::replication::commit_prefix_fingerprint(&entries, applied),
        "writerFenced": state.engine.durable_writer_fenced(),
        "uploadCopyEnabled": state.uploads_dir.is_some(),
        "uploadPrunedThroughCommitSeq": state.upload_pruned_through.load(Ordering::Acquire),
        "sidecarCopyEnabled": state.instance_dir.is_some(),
        "fullInstanceReady": false,
    })))
}

async fn push(
    State(state): State<ReplicaState>,
    headers: HeaderMap,
    Json(request): Json<SyncPushRequest>,
) -> std::result::Result<Json<SyncPushResponse>, (StatusCode, &'static str)> {
    if !authorized(&headers, &state.token) {
        return Err((StatusCode::UNAUTHORIZED, "invalid sync token"));
    }
    let response = ingest_push_to_fenced_engine(&state.engine, &request).await?;
    Ok(Json(response))
}

async fn sidecar_dir(state: &ReplicaState) -> AssetResult<&Path> {
    let dir = state
        .instance_dir
        .as_deref()
        .map(|path| path.as_path())
        .ok_or((StatusCode::SERVICE_UNAVAILABLE, "sidecar copy is disabled"))?;
    let metadata = tokio::fs::symlink_metadata(dir).await.map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot inspect passive Authority data directory",
        )
    })?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err((
            StatusCode::CONFLICT,
            "passive Authority data directory is unsafe",
        ));
    }
    Ok(dir)
}

async fn sidecar_inventory(
    State(state): State<ReplicaState>,
    headers: HeaderMap,
) -> AssetResult<Json<SidecarInventory>> {
    if !authorized(&headers, &state.token) {
        return Err((StatusCode::UNAUTHORIZED, "invalid sync token"));
    }
    let dir = sidecar_dir(&state).await?;
    let _gate = state.sidecar_gate.lock().await;
    let mut files = Vec::new();
    for name in instance_sidecars::NAMES {
        let path = dir.join(name);
        match tokio::fs::symlink_metadata(&path).await {
            Ok(metadata)
                if metadata.is_file()
                    && !metadata.file_type().is_symlink()
                    && metadata.len() <= instance_sidecars::MAX_FILE_BYTES as u64 =>
            {
                let sha256 = sha256_file(&path).await.map_err(|_| {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "cannot hash passive sidecar",
                    )
                })?;
                files.push(SidecarDigest {
                    name: (*name).to_owned(),
                    size: metadata.len(),
                    sha256,
                });
            }
            Ok(_) => {
                return Err((
                    StatusCode::CONFLICT,
                    "passive sidecar is unsafe or too large",
                ))
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(_) => {
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "cannot inspect passive sidecar",
                ))
            }
        }
    }
    // A previous PUT/DELETE may have succeeded but failed its directory sync.
    // Repeating inventory completes that durability step before reporting state.
    sync_upload_directory(dir).await.map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot sync passive sidecar directory",
        )
    })?;
    Ok(Json(SidecarInventory { files }))
}

async fn put_sidecar(
    State(state): State<ReplicaState>,
    headers: HeaderMap,
    AxumPath(name): AxumPath<String>,
    bytes: Bytes,
) -> AssetResult<StatusCode> {
    if !authorized(&headers, &state.token) {
        return Err((StatusCode::UNAUTHORIZED, "invalid sync token"));
    }
    let dir = sidecar_dir(&state).await?;
    if !instance_sidecars::allowed(&name) || bytes.len() > instance_sidecars::MAX_FILE_BYTES {
        return Err((StatusCode::BAD_REQUEST, "invalid sidecar name or size"));
    }
    let expected = headers
        .get("x-wabi-sha256")
        .and_then(|value| value.to_str().ok())
        .ok_or((StatusCode::BAD_REQUEST, "missing sidecar digest"))?;
    if expected.len() != 64
        || !expected.bytes().all(|byte| byte.is_ascii_hexdigit())
        || !hex::encode(Sha256::digest(&bytes)).eq_ignore_ascii_case(expected)
    {
        return Err((StatusCode::BAD_REQUEST, "sidecar digest mismatch"));
    }
    let _gate = state.sidecar_gate.lock().await;
    let final_path = dir.join(&name);
    match tokio::fs::symlink_metadata(&final_path).await {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {}
        Ok(_) => return Err((StatusCode::CONFLICT, "passive sidecar path is unsafe")),
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(_) => {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                "cannot inspect passive sidecar",
            ))
        }
    }
    let stage_path = dir.join(format!(".{name}.{}.tmp", uuid::Uuid::new_v4()));
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        options.mode(0o600);
    }
    let result = async {
        let mut file = options.open(&stage_path).await?;
        file.write_all(&bytes).await?;
        file.sync_all().await?;
        drop(file);
        tokio::fs::rename(&stage_path, &final_path).await?;
        sync_upload_directory(dir).await
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&stage_path).await;
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot publish passive sidecar",
        ));
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_sidecar(
    State(state): State<ReplicaState>,
    headers: HeaderMap,
    AxumPath(name): AxumPath<String>,
) -> AssetResult<StatusCode> {
    if !authorized(&headers, &state.token) {
        return Err((StatusCode::UNAUTHORIZED, "invalid sync token"));
    }
    let dir = sidecar_dir(&state).await?;
    if !instance_sidecars::allowed(&name) || name == "jwt_secret" {
        return Err((StatusCode::BAD_REQUEST, "invalid sidecar deletion"));
    }
    let _gate = state.sidecar_gate.lock().await;
    let path = dir.join(&name);
    match tokio::fs::symlink_metadata(&path).await {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
            tokio::fs::remove_file(&path).await.map_err(|_| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "cannot remove passive sidecar",
                )
            })?;
            sync_upload_directory(dir).await.map_err(|_| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "cannot sync passive sidecar directory",
                )
            })?;
        }
        Ok(_) => return Err((StatusCode::CONFLICT, "passive sidecar path is unsafe")),
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(_) => {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                "cannot inspect passive sidecar",
            ))
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

type AssetResult<T> = std::result::Result<T, (StatusCode, &'static str)>;

async fn prune_revoked_uploads(state: &ReplicaState) -> AssetResult<()> {
    let Some(uploads_dir) = state.uploads_dir.as_deref() else {
        return Ok(());
    };
    let applied = state.engine.barrier().current();
    if state.upload_pruned_through.load(Ordering::Acquire) >= applied {
        return Ok(());
    }
    let _gate = state.asset_gate.lock().await;
    if state.upload_pruned_through.load(Ordering::Acquire) >= applied {
        return Ok(());
    }
    let mut revoked = Vec::new();
    let mut invalid = false;
    state
        .engine
        .projection_state()
        .for_each(
            upload_revocations::INDEX,
            |key, value| match upload_revocations::decode(value) {
                Ok(record) if key == record.filename.as_bytes() => revoked.push(record.filename),
                _ => invalid = true,
            },
        );
    if invalid {
        return Err((
            StatusCode::CONFLICT,
            "upload revocation projection is invalid",
        ));
    }
    let stage_dir = uploads_dir.join(".replica");
    let stage_dir_exists = match tokio::fs::symlink_metadata(&stage_dir).await {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => true,
        Ok(_) => {
            return Err((
                StatusCode::CONFLICT,
                "passive upload staging directory is invalid",
            ))
        }
        Err(error) if error.kind() == ErrorKind::NotFound => false,
        Err(_) => {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                "cannot inspect passive upload staging directory",
            ))
        }
    };
    let mut removal_error = None;
    for filename in &revoked {
        if let Err(error) = remove_revoked_file(&uploads_dir.join(filename)).await {
            removal_error = Some(error);
            break;
        }
        if stage_dir_exists {
            if let Err(error) =
                remove_revoked_file(&stage_dir.join(format!("{filename}.part"))).await
            {
                removal_error = Some(error);
                break;
            }
        }
    }
    // Sync even when a previous attempt removed the file but its directory
    // sync failed. A retry must finish the durability step.
    if !revoked.is_empty() {
        sync_upload_directory(uploads_dir).await.map_err(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "cannot sync passive upload directory after revocation",
            )
        })?;
        if stage_dir_exists {
            sync_upload_directory(&stage_dir).await.map_err(|_| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "cannot sync passive upload staging directory after revocation",
                )
            })?;
        }
    }
    if let Some(error) = removal_error {
        return Err(error);
    }
    state
        .upload_pruned_through
        .store(applied, Ordering::Release);
    Ok(())
}

async fn remove_revoked_file(path: &Path) -> AssetResult<()> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) if metadata.is_file() || metadata.file_type().is_symlink() => {
            tokio::fs::remove_file(path).await.map_err(|_| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "cannot remove revoked passive upload",
                )
            })?;
            Ok(())
        }
        Ok(_) => Err((
            StatusCode::CONFLICT,
            "revoked passive upload path is not a file",
        )),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(_) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot inspect revoked passive upload",
        )),
    }
}

#[derive(Deserialize)]
struct AssetPageQuery {
    after: Option<String>,
}

#[derive(Deserialize)]
struct AssetOffsetQuery {
    offset: u64,
}

async fn missing_assets(
    State(state): State<ReplicaState>,
    headers: HeaderMap,
    Query(query): Query<AssetPageQuery>,
) -> AssetResult<Json<AssetNeedsResponse>> {
    if !authorized(&headers, &state.token) {
        return Err((StatusCode::UNAUTHORIZED, "invalid sync token"));
    }
    let uploads_dir = state
        .uploads_dir
        .as_deref()
        .ok_or((StatusCode::SERVICE_UNAVAILABLE, "upload copy is disabled"))?;
    if query
        .after
        .as_deref()
        .is_some_and(|name| !upload_revocations::valid_filename(name))
    {
        return Err((StatusCode::BAD_REQUEST, "invalid upload cursor"));
    }
    prune_revoked_uploads(&state).await?;
    let _gate = state.asset_gate.lock().await;
    let mut candidates = Vec::new();
    let mut corrupt = false;
    state
        .engine
        .projection_state()
        .for_each(upload_assets::INDEX, |key, value| {
            if candidates.len() >= 128
                || query
                    .after
                    .as_deref()
                    .is_some_and(|after| key <= after.as_bytes())
            {
                return;
            }
            match upload_assets::decode(value) {
                Ok(record) if key == record.filename.as_bytes() => candidates.push(record),
                _ => corrupt = true,
            }
        });
    if corrupt {
        return Err((StatusCode::CONFLICT, "upload projection is invalid"));
    }
    let mut entries = Vec::new();
    let mut last_inspected = None;
    let candidate_count = candidates.len();
    for record in candidates {
        last_inspected = Some(record.filename.clone());
        if state
            .engine
            .projection_state()
            .get(upload_revocations::INDEX, record.filename.as_bytes())
            .is_some()
        {
            continue;
        }
        let final_path = uploads_dir.join(&record.filename);
        match tokio::fs::symlink_metadata(&final_path).await {
            Ok(metadata) => {
                if !metadata.is_file()
                    || metadata.file_type().is_symlink()
                    || metadata.len() != record.size
                {
                    return Err((
                        StatusCode::CONFLICT,
                        "passive upload file differs from publication record",
                    ));
                }
                let digest = sha256_file(&final_path).await.map_err(|_| {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "cannot verify passive upload file",
                    )
                })?;
                if digest != record.sha256 {
                    return Err((
                        StatusCode::CONFLICT,
                        "passive upload digest differs from publication record",
                    ));
                }
                continue;
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(_) => {
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "cannot inspect passive upload file",
                ))
            }
        }
        let stage_path = uploads_dir
            .join(".replica")
            .join(format!("{}.part", record.filename));
        let offset = match tokio::fs::symlink_metadata(&stage_path).await {
            Ok(metadata)
                if metadata.is_file()
                    && !metadata.file_type().is_symlink()
                    && metadata.len() <= record.size =>
            {
                metadata.len()
            }
            Ok(_) => {
                return Err((
                    StatusCode::CONFLICT,
                    "passive upload staging file is invalid",
                ))
            }
            Err(error) if error.kind() == ErrorKind::NotFound => 0,
            Err(_) => {
                return Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "cannot inspect passive upload staging file",
                ))
            }
        };
        entries.push(AssetNeed {
            filename: record.filename,
            size: record.size,
            sha256: record.sha256,
            offset,
        });
        if entries.len() == 16 {
            break;
        }
    }
    let next_after = if candidate_count == 128 || entries.len() == 16 {
        last_inspected
    } else {
        None
    };
    Ok(Json(AssetNeedsResponse {
        entries,
        next_after,
    }))
}

async fn put_asset(
    State(state): State<ReplicaState>,
    headers: HeaderMap,
    AxumPath(filename): AxumPath<String>,
    Query(query): Query<AssetOffsetQuery>,
    bytes: Bytes,
) -> AssetResult<Json<AssetPutResponse>> {
    if !authorized(&headers, &state.token) {
        return Err((StatusCode::UNAUTHORIZED, "invalid sync token"));
    }
    let uploads_dir = state
        .uploads_dir
        .as_deref()
        .ok_or((StatusCode::SERVICE_UNAVAILABLE, "upload copy is disabled"))?;
    if !upload_revocations::valid_filename(&filename) || bytes.len() > ASSET_CHUNK_MAX {
        return Err((StatusCode::BAD_REQUEST, "invalid upload chunk"));
    }
    let _gate = state.asset_gate.lock().await;
    if state
        .engine
        .projection_state()
        .get(upload_revocations::INDEX, filename.as_bytes())
        .is_some()
    {
        return Err((StatusCode::GONE, "upload was revoked"));
    }
    let record = state
        .engine
        .projection_state()
        .get(upload_assets::INDEX, filename.as_bytes())
        .ok_or((
            StatusCode::NOT_FOUND,
            "upload publication record is missing",
        ))?;
    let record = upload_assets::decode(&record)
        .map_err(|_| (StatusCode::CONFLICT, "upload projection is invalid"))?;
    if record.filename != filename
        || query.offset > record.size
        || query
            .offset
            .checked_add(bytes.len() as u64)
            .is_none_or(|end| end > record.size)
        || (bytes.is_empty() && query.offset != record.size)
    {
        return Err((
            StatusCode::BAD_REQUEST,
            "upload chunk exceeds publication record",
        ));
    }
    let final_path = uploads_dir.join(&filename);
    match tokio::fs::symlink_metadata(&final_path).await {
        Ok(_) => return Err((StatusCode::CONFLICT, "passive upload already exists")),
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(_) => {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                "cannot inspect passive upload",
            ))
        }
    }
    let stage_dir = uploads_dir.join(".replica");
    tokio::fs::create_dir_all(&stage_dir).await.map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot create passive upload staging directory",
        )
    })?;
    let stage_meta = tokio::fs::symlink_metadata(&stage_dir).await.map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot inspect passive upload staging directory",
        )
    })?;
    if !stage_meta.is_dir() || stage_meta.file_type().is_symlink() {
        return Err((
            StatusCode::CONFLICT,
            "passive upload staging directory is invalid",
        ));
    }
    let stage_path = stage_dir.join(format!("{filename}.part"));
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true);
    match tokio::fs::symlink_metadata(&stage_path).await {
        Ok(metadata)
            if metadata.is_file()
                && !metadata.file_type().is_symlink()
                && metadata.len() == query.offset => {}
        Ok(_) => return Err((StatusCode::CONFLICT, "passive upload offset changed")),
        Err(error) if error.kind() == ErrorKind::NotFound && query.offset == 0 => {
            options.create_new(true);
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Err((
                StatusCode::CONFLICT,
                "passive upload staging file is missing",
            ));
        }
        Err(_) => {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                "cannot inspect passive upload staging file",
            ))
        }
    }
    let mut file = options.open(&stage_path).await.map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot open passive upload staging file",
        )
    })?;
    file.seek(std::io::SeekFrom::Start(query.offset))
        .await
        .map_err(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "cannot seek passive upload staging file",
            )
        })?;
    file.write_all(&bytes).await.map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot write passive upload chunk",
        )
    })?;
    file.sync_all().await.map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "cannot sync passive upload chunk",
        )
    })?;
    drop(file);
    let next_offset = query.offset + bytes.len() as u64;
    let complete = next_offset == record.size;
    if complete {
        let digest = sha256_file(&stage_path).await.map_err(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "cannot hash passive upload",
            )
        })?;
        if digest != record.sha256 {
            let _ = tokio::fs::remove_file(&stage_path).await;
            return Err((StatusCode::CONFLICT, "passive upload digest mismatch"));
        }
        if state
            .engine
            .projection_state()
            .get(upload_revocations::INDEX, filename.as_bytes())
            .is_some()
        {
            let _ = tokio::fs::remove_file(&stage_path).await;
            return Err((StatusCode::GONE, "upload was revoked"));
        }
        tokio::fs::rename(&stage_path, &final_path)
            .await
            .map_err(|_| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "cannot publish passive upload",
                )
            })?;
        sync_upload_directory(uploads_dir).await.map_err(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "cannot sync passive upload directory",
            )
        })?;
    }
    Ok(Json(AssetPutResponse {
        next_offset,
        complete,
    }))
}
