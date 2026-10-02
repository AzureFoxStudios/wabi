//! Encrypted stopped-instance export and inactive live-checkpoint restore.
//! Controlled moves require an operator-fenced old writer and matching state;
//! this tool cannot elect a writer after an unreachable-host failure.

use age::{secrecy::ExposeSecret, Decryptor, Encryptor};
use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::SystemTime,
};

mod live;
mod restore_limits;
pub(crate) mod source_context;
mod verify;
pub(crate) use live::{export_frozen, FrozenExport};
pub use live::{LiveArchiveReceipt, LiveCheckpointMetadata, LiveExportLimits};
pub use restore_limits::RestoreLimits;
pub use verify::{verify_inactive_live, InactiveVerificationReceipt};

const MAGIC: &[u8] = b"WABI-INSTANCE-SNAPSHOT-V1\n";
const MAX_ENTRIES: u64 = 10_000_000;
const MAX_PATH_BYTES: usize = 4096;
const WRITER_FENCE_MARKER: &str = "writer-fenced-v1";
const ACTIVATION_PENDING_MARKER: &str = "activation-pending-v1";
const MOVE_PROOF_CONTEXT: &[u8] = b"wabi/controlled-move/fence-receipt/v1\0";
const PASSIVE_MOVE_PROOF_CONTEXT: &[u8] = b"wabi/controlled-passive-move/v1\0";

#[derive(Parser)]
#[command(about = "Encrypted stopped-instance backup and inactive live-checkpoint restore")]
struct Args {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Write a private age identity file and print its public recipient.
    Keygen {
        #[arg(long)]
        identity_file: PathBuf,
    },
    /// Export a stopped Authority while holding its advisory writer lock.
    Export {
        #[arg(long)]
        data_dir: PathBuf,
        #[arg(long)]
        uploads_dir: PathBuf,
        #[arg(long)]
        recipient: String,
        #[arg(long)]
        output: PathBuf,
    },
    /// Decrypt into a new directory; live V2 checkpoints always stay inactive and fenced.
    Restore {
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        identity_file: PathBuf,
        #[arg(long)]
        target_root: PathBuf,
        /// Keep the restored Authority inactive until the controlled fence receipt is checked.
        #[arg(long, conflicts_with = "passive_replica")]
        controlled_move: bool,
        /// Publish the restored copy with a durable WabiDB writer fence for a passive receiver.
        #[arg(long)]
        passive_replica: bool,
        /// Maximum cumulative extracted file bytes (default 4 GiB).
        #[arg(long, default_value_t = 4 * 1024 * 1024 * 1024)]
        max_bytes: u64,
        #[arg(long, default_value_t = 100_000)]
        max_entries: u64,
        #[arg(long, default_value_t = 16 * 1024 * 1024)]
        max_path_bytes: u64,
        #[arg(long, default_value_t = 300)]
        timeout_seconds: u64,
        /// Ciphertext digest from a separately authenticated source receipt.
        #[arg(long)]
        expected_sha256: Option<String>,
    },
    /// Replay a stopped live V2 restore into memory without activating it.
    VerifyInactive {
        #[arg(long)]
        target_root: PathBuf,
        /// Receipt object obtained through the trusted source's authenticated channel.
        #[arg(long)]
        source_receipt: PathBuf,
        /// Original encrypted V2 archive whose digest is in the trusted receipt.
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        identity_file: PathBuf,
        #[arg(long, default_value_t = 10_000)]
        max_entries: u64,
        #[arg(long, default_value_t = 64 * 1024 * 1024)]
        max_bytes: u64,
        #[arg(long, default_value_t = 4 * 1024 * 1024)]
        max_snapshot_bytes: u64,
        #[arg(long, default_value_t = 60)]
        timeout_seconds: u64,
    },
    /// Durably retire a stopped Authority data tree after exporting its replacement.
    FenceStopped {
        #[arg(long)]
        data_dir: PathBuf,
        /// Encrypted archive made before fencing (requires --receipt).
        #[arg(long, requires = "receipt")]
        archive: Option<PathBuf>,
        /// Private receipt tied to --archive (requires --archive).
        #[arg(long, requires = "archive")]
        receipt: Option<PathBuf>,
    },
    /// Allow a controlled-move restore to start after verifying the old-host fence receipt.
    ActivateRestored {
        #[arg(long)]
        target_root: PathBuf,
        #[arg(long)]
        receipt: PathBuf,
    },
    /// Seal a stopped, writer-fenced Authority's complete data/uploads state for a caught-up passive copy.
    SealPassiveMove {
        #[arg(long)]
        data_dir: PathBuf,
        #[arg(long)]
        uploads_dir: PathBuf,
        #[arg(long)]
        receipt: PathBuf,
    },
    /// Activate a matching, stopped passive copy after the old Authority was fenced.
    ActivatePassive {
        #[arg(long)]
        target_root: PathBuf,
        #[arg(long)]
        receipt: PathBuf,
        /// Confirm external secrets, plugins and services were reviewed separately.
        #[arg(long)]
        external_state_reviewed: bool,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FenceReceipt {
    schema_version: u8,
    archive_sha256: String,
    proof: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PassiveMoveClaims {
    schema_version: u8,
    embedded_uploads: String,
    file_count: u64,
    directory_count: u64,
    total_file_bytes: u64,
    tree_sha256: String,
    projection_watermark: u64,
    projection_sha256: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PassiveMoveReceipt {
    claims: PassiveMoveClaims,
    proof: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Entry {
    archive_path: String,
    source_path: PathBuf,
    is_dir: bool,
    size: u64,
    modified: Option<SystemTime>,
}

pub fn run_cli() -> Result<()> {
    match Args::parse().command {
        Command::Keygen { identity_file } => keygen(&identity_file),
        Command::Export {
            data_dir,
            uploads_dir,
            recipient,
            output,
        } => export(&data_dir, &uploads_dir, &recipient, &output),
        Command::Restore {
            input,
            identity_file,
            target_root,
            controlled_move,
            passive_replica,
            max_bytes,
            max_entries,
            max_path_bytes,
            timeout_seconds,
            expected_sha256,
        } => restore_bounded(
            &input,
            &identity_file,
            &target_root,
            controlled_move,
            passive_replica,
            RestoreLimits {
                max_plaintext_bytes: max_bytes,
                max_entries,
                max_path_bytes,
                timeout: std::time::Duration::from_secs(timeout_seconds),
            },
            expected_sha256.as_deref(),
        ),
        Command::VerifyInactive {
            target_root,
            source_receipt,
            input,
            identity_file,
            max_entries,
            max_bytes,
            max_snapshot_bytes,
            timeout_seconds,
        } => {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?;
            let result = runtime.block_on(async {
                let source = verify::read_source_receipt(&source_receipt)?;
                verify_inactive_live(
                    &target_root,
                    &source,
                    &input,
                    &identity_file,
                    wabidb::engine::offline_inspect::InspectionLimits {
                        max_entries,
                        max_file_bytes: max_bytes,
                        max_snapshot_bytes,
                        timeout: std::time::Duration::from_secs(timeout_seconds),
                    },
                )
                .await
            });
            // Public diagnostics must never render raw engine/serde errors:
            // private metadata includes configuration and signing secrets.
            match result {
                Ok(receipt) => {
                    println!("{}", serde_json::to_string(&receipt)?);
                    Ok(())
                }
                Err(_) => {
                    println!("{{\"schemaVersion\":1,\"result\":\"REFUSED\",\"reason\":\"inactive_core_verification_failed\",\"fullInstanceReady\":false}}");
                    bail!("inactive core verification refused; preserve guards and review the protected source/restore")
                }
            }
        }
        Command::FenceStopped {
            data_dir,
            archive,
            receipt,
        } => match (archive, receipt) {
            (Some(archive), Some(receipt)) => {
                fence_stopped_with_receipt(&data_dir, &archive, &receipt)
            }
            (None, None) => fence_stopped(&data_dir),
            _ => unreachable!("clap requires archive and receipt together"),
        },
        Command::ActivateRestored {
            target_root,
            receipt,
        } => activate_restored(&target_root, &receipt),
        Command::SealPassiveMove {
            data_dir,
            uploads_dir,
            receipt,
        } => seal_passive_move(&data_dir, &uploads_dir, &receipt),
        Command::ActivatePassive {
            target_root,
            receipt,
            external_state_reviewed,
        } => activate_passive(&target_root, &receipt, external_state_reviewed),
    }
}

fn archive_sha256(path: &Path) -> Result<[u8; 32]> {
    let mut file =
        File::open(path).with_context(|| format!("open encrypted archive {}", path.display()))?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(hash.finalize().into())
}

fn move_proof(root_key: &[u8], archive_hash: &[u8; 32]) -> Result<String> {
    let mut mac = Hmac::<Sha256>::new_from_slice(root_key)?;
    mac.update(MOVE_PROOF_CONTEXT);
    mac.update(archive_hash);
    Ok(hex::encode(mac.finalize().into_bytes()))
}

fn fence_stopped_with_receipt(data: &Path, archive: &Path, receipt_path: &Path) -> Result<()> {
    if fs::symlink_metadata(receipt_path).is_ok() {
        bail!("fence receipt already exists: {}", receipt_path.display());
    }
    let archive_hash = archive_sha256(archive)?;
    let data = canonical_directory(data)?;
    let _stopped = ensure_stopped(&data)?;
    let marker = data.join("wabidb").join(WRITER_FENCE_MARKER);
    let metadata = fs::symlink_metadata(&marker)
        .context("fence the stopped Authority before exporting a controlled-move archive")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        bail!("old Authority writer fence is not a regular file");
    }
    if fs::read(&marker)? != b"fenced\n" {
        bail!("old Authority writer fence has unexpected contents");
    }
    let root_key = fs::read(data.join("wabidb/root_key"))?;
    let receipt = FenceReceipt {
        schema_version: 1,
        archive_sha256: hex::encode(archive_hash),
        proof: move_proof(&root_key, &archive_hash)?,
    };
    let mut file = private_new_file(receipt_path)?;
    file.write_all(&serde_json::to_vec_pretty(&receipt)?)?;
    file.sync_all()?;
    sync_parent(receipt_path)?;
    println!("Fence receipt: {}", receipt_path.display());
    Ok(())
}

fn activate_restored(target_root: &Path, receipt_path: &Path) -> Result<()> {
    let root = canonical_directory(target_root)?;
    let data = canonical_directory(&root.join("data"))?;
    let stopped = ensure_stopped(&data)?;
    ensure_persisted_keys(&data)?;
    refuse_live_activation(&data)?;
    let marker = data.join("wabidb").join(ACTIVATION_PENDING_MARKER);
    match fs::symlink_metadata(data.join("wabidb").join(WRITER_FENCE_MARKER)) {
        Ok(_) => bail!("restored Authority is itself writer-fenced; it cannot be activated"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let metadata =
        fs::symlink_metadata(&marker).context("controlled-move activation marker is missing")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        bail!("activation marker is not a regular file");
    }
    let expected_hash = fs::read_to_string(&marker)?;
    let hash: [u8; 32] = hex::decode(expected_hash.trim())?
        .try_into()
        .map_err(|_| anyhow::anyhow!("invalid activation archive hash"))?;
    let receipt: FenceReceipt = serde_json::from_slice(&fs::read(receipt_path)?)?;
    if receipt.schema_version != 1 || receipt.archive_sha256 != hex::encode(hash) {
        bail!("fence receipt does not match this restored archive");
    }
    let root_key = fs::read(data.join("wabidb/root_key"))?;
    let actual = hex::decode(&receipt.proof)?;
    let mut mac = Hmac::<Sha256>::new_from_slice(&root_key)?;
    mac.update(MOVE_PROOF_CONTEXT);
    mac.update(&hash);
    mac.verify_slice(&actual)
        .map_err(|_| anyhow::anyhow!("fence receipt proof is invalid"))?;
    stopped.verify()?;
    fs::remove_file(&marker)?;
    sync_parent(&marker)?;
    println!("Controlled-move restore activated: {}", data.display());
    println!("Keep the old Authority fenced; this receipt does not provide automatic failover.");
    Ok(())
}

fn require_writer_fence(data: &Path) -> Result<()> {
    let marker = data.join("wabidb").join(WRITER_FENCE_MARKER);
    let metadata = fs::symlink_metadata(&marker).context("writer fence marker is missing")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || fs::read(&marker)? != b"fenced\n"
    {
        bail!("writer fence marker is invalid: {}", marker.display());
    }
    Ok(())
}

fn ensure_no_pending_activation(data: &Path) -> Result<()> {
    match fs::symlink_metadata(data.join("wabidb").join(ACTIVATION_PENDING_MARKER)) {
        Ok(_) => bail!("activation-pending tree cannot join a passive move"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn embedded_uploads_path(data: &Path, uploads: &Path) -> Result<String> {
    if data == uploads || data.starts_with(uploads) {
        bail!("uploads must be a separate directory or a child of the data directory");
    }
    if uploads.starts_with(data) {
        let relative = uploads
            .strip_prefix(data)?
            .to_str()
            .context("uploads path is not UTF-8")?;
        let relative = relative.replace('\\', "/");
        validate_relative(&format!("data/{relative}"), true)?;
        Ok(relative)
    } else {
        Ok(String::new())
    }
}

fn canonical_projection_snapshot(data: &Path) -> Result<(u64, String)> {
    let path = data.join("wabidb/projections/snapshot.json");
    let metadata = fs::symlink_metadata(&path).context("projection snapshot is missing")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        bail!("projection snapshot must be a regular file");
    }
    let mut record: serde_json::Value = serde_json::from_slice(&fs::read(&path)?)?;
    let watermark = record
        .get("watermark")
        .and_then(|value| value.as_u64())
        .context("projection snapshot has no watermark")?;
    let indexes = record
        .get_mut("indexes")
        .and_then(|value| value.as_array_mut())
        .context("projection snapshot has no index list")?;
    let mut names = HashSet::new();
    for item in indexes.iter_mut() {
        let pair = item.as_array_mut().context("invalid projection index")?;
        if pair.len() != 2 {
            bail!("invalid projection index pair");
        }
        let name = pair[0]
            .as_str()
            .context("invalid projection index name")?
            .to_owned();
        if !names.insert(name) {
            bail!("duplicate projection index name");
        }
        let entries = pair[1]
            .as_array_mut()
            .context("invalid projection index entries")?;
        entries.sort_by_key(|entry| entry.to_string());
    }
    indexes.sort_by(|left, right| left[0].as_str().cmp(&right[0].as_str()));
    Ok((
        watermark,
        hex::encode(Sha256::digest(serde_json::to_vec(&record)?)),
    ))
}

fn passive_move_claims(data: &Path, uploads: &Path) -> Result<PassiveMoveClaims> {
    let embedded_uploads = embedded_uploads_path(data, uploads)?;
    let entries = collect_instance(data, uploads, !embedded_uploads.is_empty())?;
    if entries.len() as u64 > MAX_ENTRIES {
        bail!("passive move has too many entries");
    }
    let (projection_watermark, projection_sha256) = canonical_projection_snapshot(data)?;
    let mut tree = Sha256::new();
    tree.update(b"wabi/passive-move/tree/v1\0");
    let mut file_count = 0u64;
    let mut directory_count = 0u64;
    let mut total_file_bytes = 0u64;
    for entry in &entries {
        if matches!(
            entry.archive_path.as_str(),
            "data/wabidb/writer-fenced-v1" | "data/wabidb/projections/snapshot.json"
        ) {
            continue;
        }
        let path = entry.archive_path.as_bytes();
        tree.update(u32::try_from(path.len())?.to_le_bytes());
        tree.update(path);
        tree.update([if entry.is_dir { 0 } else { 1 }]);
        if entry.is_dir {
            directory_count = directory_count
                .checked_add(1)
                .context("directory count overflow")?;
            continue;
        }
        file_count = file_count.checked_add(1).context("file count overflow")?;
        total_file_bytes = total_file_bytes
            .checked_add(entry.size)
            .context("file size overflow")?;
        tree.update(entry.size.to_le_bytes());
        let before = fs::metadata(&entry.source_path)?;
        if before.len() != entry.size || before.modified().ok() != entry.modified {
            bail!(
                "passive move source changed before hashing: {}",
                entry.source_path.display()
            );
        }
        let mut source = File::open(&entry.source_path)?;
        let mut digest = Sha256::new();
        copy_exact_hashed(&mut source, &mut std::io::sink(), entry.size, &mut digest)?;
        tree.update(digest.finalize());
        let after = fs::metadata(&entry.source_path)?;
        if after.len() != entry.size || after.modified().ok() != entry.modified {
            bail!(
                "passive move source changed while hashing: {}",
                entry.source_path.display()
            );
        }
    }
    if collect_instance(data, uploads, !embedded_uploads.is_empty())? != entries {
        bail!("passive move source tree changed while hashing");
    }
    if canonical_projection_snapshot(data)? != (projection_watermark, projection_sha256.clone()) {
        bail!("passive move projection snapshot changed while hashing");
    }
    Ok(PassiveMoveClaims {
        schema_version: 1,
        embedded_uploads,
        file_count,
        directory_count,
        total_file_bytes,
        tree_sha256: hex::encode(tree.finalize()),
        projection_watermark,
        projection_sha256,
    })
}

fn passive_move_proof(root_key: &[u8], claims: &PassiveMoveClaims) -> Result<String> {
    let mut mac = Hmac::<Sha256>::new_from_slice(root_key)?;
    mac.update(PASSIVE_MOVE_PROOF_CONTEXT);
    mac.update(&serde_json::to_vec(claims)?);
    Ok(hex::encode(mac.finalize().into_bytes()))
}

fn seal_passive_move(data: &Path, uploads: &Path, receipt_path: &Path) -> Result<()> {
    let data = canonical_directory(data)?;
    let uploads = canonical_directory(uploads)?;
    let receipt_parent = canonical_directory(
        receipt_path
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or(Path::new(".")),
    )?;
    let receipt_path = receipt_parent.join(
        receipt_path
            .file_name()
            .context("receipt needs a file name")?,
    );
    if receipt_path.starts_with(&data) || receipt_path.starts_with(&uploads) {
        bail!("passive move receipt must be outside data and uploads trees");
    }
    let stopped = ensure_stopped(&data)?;
    ensure_persisted_keys(&data)?;
    require_writer_fence(&data)?;
    ensure_no_pending_activation(&data)?;
    let claims = passive_move_claims(&data, &uploads)?;
    stopped.verify()?;
    require_writer_fence(&data)?;
    let root_key = fs::read(data.join("wabidb/root_key"))?;
    let receipt = PassiveMoveReceipt {
        proof: passive_move_proof(&root_key, &claims)?,
        claims,
    };
    let mut file = private_new_file(&receipt_path)?;
    file.write_all(&serde_json::to_vec_pretty(&receipt)?)?;
    file.sync_all()?;
    sync_parent(&receipt_path)?;
    println!(
        "Sealed fenced passive-move state: {}",
        receipt_path.display()
    );
    Ok(())
}

fn activate_passive(
    target_root: &Path,
    receipt_path: &Path,
    external_state_reviewed: bool,
) -> Result<()> {
    if !external_state_reviewed {
        bail!("review external secrets, plugins and services before activating a passive copy");
    }
    let root = canonical_directory(target_root)?;
    let data = canonical_directory(&root.join("data"))?;
    let stopped = ensure_stopped(&data)?;
    ensure_persisted_keys(&data)?;
    refuse_live_activation(&data)?;
    require_writer_fence(&data)?;
    ensure_no_pending_activation(&data)?;
    let receipt_meta = fs::symlink_metadata(receipt_path)?;
    if !receipt_meta.is_file()
        || receipt_meta.file_type().is_symlink()
        || receipt_meta.len() > 16 * 1024
    {
        bail!("passive move receipt is not a bounded regular file");
    }
    let receipt: PassiveMoveReceipt = serde_json::from_slice(&fs::read(receipt_path)?)?;
    if receipt.claims.schema_version != 1 {
        bail!("unsupported passive move receipt version");
    }
    let root_key = fs::read(data.join("wabidb/root_key"))?;
    let actual = hex::decode(&receipt.proof)?;
    let mut mac = Hmac::<Sha256>::new_from_slice(&root_key)?;
    mac.update(PASSIVE_MOVE_PROOF_CONTEXT);
    mac.update(&serde_json::to_vec(&receipt.claims)?);
    mac.verify_slice(&actual)
        .map_err(|_| anyhow::anyhow!("passive move receipt proof is invalid"))?;
    let uploads = if receipt.claims.embedded_uploads.is_empty() {
        canonical_directory(&root.join("uploads"))?
    } else {
        validate_relative(&format!("data/{}", receipt.claims.embedded_uploads), true)?;
        canonical_directory(&data.join(&receipt.claims.embedded_uploads))?
    };
    let actual_claims = passive_move_claims(&data, &uploads)?;
    if actual_claims != receipt.claims {
        bail!("passive copy differs from the stopped fenced Authority; activation refused (expected {:#?}, actual {:#?})", receipt.claims, actual_claims);
    }
    stopped.verify()?;
    require_writer_fence(&data)?;
    let marker = data.join("wabidb").join(WRITER_FENCE_MARKER);
    fs::remove_file(&marker)?;
    sync_parent(&marker)?;
    println!("Controlled passive move activated: {}", data.display());
    println!("Keep the old Authority fenced; this is not failover of an unreachable host.");
    Ok(())
}

fn fence_stopped(data: &Path) -> Result<()> {
    let data = canonical_directory(data)?;
    let stopped = ensure_stopped(&data)?;
    ensure_persisted_keys(&data)?;
    let marker = data.join("wabidb").join(WRITER_FENCE_MARKER);
    match fs::symlink_metadata(&marker) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {}
        Ok(_) => bail!(
            "writer fence marker is not a regular file: {}",
            marker.display()
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut file = private_new_file(&marker)?;
            file.write_all(b"fenced\n")?;
            file.sync_all()?;
            sync_parent(&marker)?;
        }
        Err(error) => return Err(error.into()),
    }
    // Hold exclusion through publication: a concurrent server cannot start
    // writing before the durable fence marker is visible.
    stopped.verify().context("writer fence exists, but the process lock changed; keep the host stopped and inspect its process and locks")?;
    println!("Stopped Authority fenced: {}", data.display());
    println!("This data tree must not serve requests again. Keep the marker in place.");
    Ok(())
}

fn keygen(path: &Path) -> Result<()> {
    let identity = age::x25519::Identity::generate();
    let mut file = private_new_file(path)?;
    let result = (|| -> Result<()> {
        file.write_all(identity.to_string().expose_secret().as_bytes())?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        sync_parent(path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(path);
    }
    result?;
    println!("Recipient: {}", identity.to_public());
    println!("Private identity written to {}", path.display());
    Ok(())
}

fn export(data: &Path, uploads: &Path, recipient_text: &str, output: &Path) -> Result<()> {
    let data = canonical_directory(data)?;
    let uploads = canonical_directory(uploads)?;
    if data == uploads || data.starts_with(&uploads) {
        bail!("uploads must be a separate directory or a child of the data directory");
    }
    let output_parent = output
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let output_parent = canonical_directory(output_parent)?;
    let output = output_parent.join(output.file_name().context("output needs a file name")?);
    if output.starts_with(&data) || output.starts_with(&uploads) {
        bail!("snapshot output must be outside the Authority data and uploads trees");
    }
    if output.exists() {
        bail!("snapshot output already exists: {}", output.display());
    }
    let stopped = ensure_stopped(&data)?;
    ensure_persisted_keys(&data)?;
    let uploads_inside_data = uploads.starts_with(&data);
    let embedded_uploads = if uploads_inside_data {
        uploads
            .strip_prefix(&data)?
            .to_str()
            .context("uploads path is not UTF-8")?
            .replace('\\', "/")
    } else {
        String::new()
    };
    let entries = collect_instance(&data, &uploads, uploads_inside_data)?;
    if entries.len() as u64 > MAX_ENTRIES {
        bail!("snapshot has too many entries");
    }
    let recipient = recipient_text
        .parse::<age::x25519::Recipient>()
        .map_err(|error| anyhow::anyhow!("invalid age recipient: {error}"))?;
    let temporary = output_parent.join(format!(".wabi-snapshot-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut output_file = private_new_file(&temporary)?;
        {
            let encryptor =
                Encryptor::with_recipients(std::iter::once(&recipient as &dyn age::Recipient))?;
            let mut writer = encryptor.wrap_output(&mut output_file)?;
            writer.write_all(MAGIC)?;
            write_string(&mut writer, &embedded_uploads)?;
            writer.write_all(&(entries.len() as u64).to_le_bytes())?;
            for entry in &entries {
                writer.write_all(&[if entry.is_dir { 0 } else { 1 }])?;
                write_string(&mut writer, &entry.archive_path)?;
                if !entry.is_dir {
                    writer.write_all(&entry.size.to_le_bytes())?;
                    copy_file_checked(entry, &mut writer)?;
                }
            }
            writer.finish()?;
        }
        output_file.sync_all()?;
        stopped.verify()?;
        let after = collect_instance(&data, &uploads, uploads_inside_data)?;
        if after != entries {
            bail!("source files changed while snapshotting; export was discarded");
        }
        fs::hard_link(&temporary, &output)
            .with_context(|| format!("publish {}", output.display()))?;
        sync_parent(&output)?;
        Ok(())
    })();
    let _ = fs::remove_file(&temporary);
    result?;
    println!(
        "Encrypted stopped snapshot: {} ({} entries)",
        output.display(),
        entries.len()
    );
    Ok(())
}

fn restore(
    input: &Path,
    identity_path: &Path,
    target_root: &Path,
    controlled_move: bool,
    passive_replica: bool,
) -> Result<()> {
    restore_bounded(
        input,
        identity_path,
        target_root,
        controlled_move,
        passive_replica,
        RestoreLimits::default(),
        None,
    )
}

fn restore_bounded(
    input: &Path,
    identity_path: &Path,
    target_root: &Path,
    controlled_move: bool,
    passive_replica: bool,
    limits: RestoreLimits,
    expected_sha256: Option<&str>,
) -> Result<()> {
    let mut budget = restore_limits::RestoreBudget::new(limits)?;
    budget.validate_input(input, identity_path, expected_sha256)?;
    if controlled_move && passive_replica {
        bail!("controlled move and passive replica modes are mutually exclusive");
    }
    let target_parent = target_root
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let target_parent = canonical_directory(target_parent)?;
    let target = target_parent.join(
        target_root
            .file_name()
            .context("target root needs a name")?,
    );
    if fs::symlink_metadata(&target).is_ok() {
        bail!("restore target already exists: {}", target.display());
    }
    let identity_text = fs::read_to_string(identity_path).context("read private identity file")?;
    let identity = identity_text
        .trim()
        .parse::<age::x25519::Identity>()
        .map_err(|error| anyhow::anyhow!("invalid age identity: {error}"))?;
    let stage = target_parent.join(format!(".wabi-restore-{}", uuid::Uuid::new_v4()));
    let expected_archive_hash = if controlled_move {
        Some(budget.hash(input)?)
    } else {
        None
    };
    private_new_dir(&stage)?;
    let mut cleanup = restore_limits::RestoreDirectory::new(stage.clone(), target.clone());
    let mut restored_live = false;
    let result = (|| -> Result<String> {
        let encrypted = budget.reader(File::open(input)?);
        let decryptor = Decryptor::new(encrypted)?;
        if decryptor.is_scrypt() {
            bail!("passphrase snapshots are unsupported");
        }
        let mut reader =
            budget.reader(decryptor.decrypt(std::iter::once(&identity as &dyn age::Identity))?);
        let mut magic = vec![0u8; MAGIC.len()];
        reader.read_exact(&mut magic)?;
        let live_metadata = if magic == live::LIVE_MAGIC {
            if controlled_move {
                bail!("live checkpoint cannot use stopped controlled-move activation");
            }
            Some(live::read_metadata(&mut reader)?)
        } else if magic == MAGIC {
            None
        } else {
            bail!("unsupported Wabi instance snapshot format");
        };
        let mut inventory = live::Inventory::default();
        let embedded_uploads = read_string(&mut reader)?;
        budget.path(&embedded_uploads)?;
        if !embedded_uploads.is_empty() {
            validate_relative(&format!("data/{embedded_uploads}"), true)?;
        }
        let mut count_bytes = [0u8; 8];
        reader.read_exact(&mut count_bytes)?;
        let count = u64::from_le_bytes(count_bytes);
        if count > MAX_ENTRIES || count > budget.max_entries() {
            bail!("snapshot entry count exceeds limit");
        }
        let mut seen = HashSet::new();
        for _ in 0..count {
            let mut kind = [0u8; 1];
            reader.read_exact(&mut kind)?;
            if kind[0] > 1 {
                bail!("invalid snapshot entry type");
            }
            let name = read_string(&mut reader)?;
            budget.path(&name)?;
            let path = validate_relative(&name, embedded_uploads.is_empty())?;
            if !seen.insert(name.clone()) {
                bail!("duplicate snapshot path");
            }
            let destination = stage.join(path);
            if kind[0] == 0 {
                private_new_dir(&destination)?;
                inventory.entry(&name, true, 0, &[0u8; 32]);
            } else {
                let mut size_bytes = [0u8; 8];
                reader.read_exact(&mut size_bytes)?;
                let size = u64::from_le_bytes(size_bytes);
                budget.file(size)?;
                let mut file = private_new_file(&destination)?;
                let mut hash = Sha256::new();
                copy_exact_hashed(&mut reader, &mut file, size, &mut hash)?;
                let mut expected = [0u8; 32];
                reader.read_exact(&mut expected)?;
                let actual: [u8; 32] = hash.finalize().into();
                if actual != expected {
                    bail!("snapshot file hash mismatch: {}", destination.display());
                }
                file.sync_all()?;
                inventory.entry(&name, false, size, &actual);
            }
        }
        if live_metadata.is_some() {
            inventory.verify_footer(&mut reader)?;
        }
        let mut trailing = [0u8; 1];
        if reader.read(&mut trailing)? != 0 {
            bail!("snapshot has trailing data");
        }
        ensure_persisted_keys(&stage.join("data"))?;
        if embedded_uploads.is_empty() && !stage.join("uploads").is_dir() {
            bail!("snapshot omitted its external uploads tree");
        }
        if let Some(metadata) = &live_metadata {
            live::seal_inactive_restore(&stage, metadata)?;
            restored_live = true;
        }
        if let Some(expected) = expected_archive_hash {
            if budget.hash(input)? != expected {
                bail!("encrypted archive changed during restore");
            }
            let old_fence = stage.join("data/wabidb").join(WRITER_FENCE_MARKER);
            let metadata = fs::symlink_metadata(&old_fence).context(
                "controlled-move archive was made before the old Authority was writer-fenced",
            )?;
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                bail!("controlled-move archive has no regular writer fence");
            }
            if fs::read(&old_fence)? != b"fenced\n" {
                bail!("controlled-move archive has an invalid writer fence");
            }
            fs::remove_file(&old_fence)?;
            let marker = stage.join("data/wabidb").join(ACTIVATION_PENDING_MARKER);
            let mut file = private_new_file(&marker)?;
            file.write_all(hex::encode(expected).as_bytes())?;
            file.write_all(b"\n")?;
            file.sync_all()?;
        }
        if passive_replica {
            let wabidb = stage.join("data/wabidb");
            if fs::symlink_metadata(wabidb.join(ACTIVATION_PENDING_MARKER)).is_ok() {
                bail!("controlled-move pending state cannot be a passive replica");
            }
            let marker = wabidb.join(WRITER_FENCE_MARKER);
            match fs::symlink_metadata(&marker) {
                Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {}
                Ok(_) => bail!("passive replica fence marker is not a regular file"),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    let mut file = private_new_file(&marker)?;
                    file.write_all(b"fenced\n")?;
                    file.sync_all()?;
                }
                Err(error) => return Err(error.into()),
            }
        }
        sync_tree_directories(&stage)?;
        budget.check()?;
        if let Some(expected) = expected_sha256 {
            if hex::encode(budget.hash(input)?) != expected.to_ascii_lowercase() {
                bail!("encrypted archive changed from trusted source receipt during restore");
            }
        }
        if fs::symlink_metadata(&target).is_ok() {
            bail!("restore target appeared while extracting");
        }
        fs::rename(&stage, &target)?;
        cleanup.published = true;
        sync_parent(&target)?;
        budget.check()?;
        cleanup.complete = true;
        Ok(embedded_uploads)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&stage);
    }
    let embedded_uploads = result?;
    let uploads_path = if embedded_uploads.is_empty() {
        target.join("uploads")
    } else {
        target.join("data").join(embedded_uploads)
    };
    println!("Restored data: {}", target.join("data").display());
    println!("Restored uploads: {}", uploads_path.display());
    if restored_live {
        println!("Live checkpoint restored inactive and writer-fenced. External state and promotion remain unverified; the stopped-move commands cannot activate it.");
    } else if controlled_move {
        println!("Controlled-move restore is inactive until activate-restored verifies an old-host fence receipt.");
    } else if passive_replica {
        println!("Passive replica restore is writer-fenced; it cannot start as an Authority. Full-instance catch-up and promotion are not available.");
    } else {
        println!("Restore is isolated; promotion and writer fencing are separate operator steps.");
    }
    Ok(())
}

/// Decrypt into a new private, inactive directory. V2 live checkpoints are
/// always fenced; V1 stopped archives request the passive mode explicitly.
pub fn restore_inactive(input: &Path, identity_file: &Path, target_root: &Path) -> Result<()> {
    restore(input, identity_file, target_root, false, true)
}

/// Resource-bounded inactive extraction. A digest authenticates the source only
/// when the caller obtained that digest over its trusted control channel.
pub fn restore_inactive_with_limits(
    input: &Path,
    identity_file: &Path,
    target_root: &Path,
    limits: RestoreLimits,
    expected_sha256: Option<&str>,
) -> Result<()> {
    restore_bounded(
        input,
        identity_file,
        target_root,
        false,
        true,
        limits,
        expected_sha256,
    )
}

fn refuse_live_activation(data: &Path) -> Result<()> {
    match fs::symlink_metadata(data.join("wabidb").join(live::LIVE_MARKER)) {
        Ok(_) => bail!("live checkpoint cannot use stopped-move activation"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn canonical_directory(path: &Path) -> Result<PathBuf> {
    if fs::symlink_metadata(path)?.file_type().is_symlink() {
        bail!("symlink directory is not accepted: {}", path.display());
    }
    let canonical = fs::canonicalize(path)?;
    if !canonical.is_dir() {
        bail!("not a directory: {}", path.display());
    }
    Ok(canonical)
}

struct StoppedAuthority {
    data: PathBuf,
    lock: File,
}

impl StoppedAuthority {
    fn verify(&self) -> Result<()> {
        refuse_legacy_authority_lock(&self.data)?;
        let path = self.data.join("wabidb/.lock");
        let current = fs::symlink_metadata(&path)?;
        if !current.is_file() || current.file_type().is_symlink() {
            bail!("Authority process lock is no longer a regular file");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let held = self.lock.metadata()?;
            if (held.dev(), held.ino()) != (current.dev(), current.ino()) {
                bail!("Authority process lock inode changed during the stopped operation");
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if self.lock.metadata()?.creation_time() != current.creation_time() {
                bail!("Authority process lock changed during the stopped operation");
            }
        }
        Ok(())
    }
}

fn refuse_legacy_authority_lock(data: &Path) -> Result<()> {
    // Older binaries used a PID file outside WabiDB and did not participate
    // in advisory locking. Never infer their inactivity from a successful OS
    // lock; the operator must stop those binaries and resolve this file.
    let path = data.join(".lock");
    match fs::symlink_metadata(&path) {
        Ok(_) => bail!(
            "legacy Authority lock exists at {}; stop all old server processes and resolve the legacy lock before continuing",
            path.display()
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn ensure_stopped(data: &Path) -> Result<StoppedAuthority> {
    use fs4::fs_std::FileExt;

    refuse_legacy_authority_lock(data)?;
    let path = data.join("wabidb/.lock");
    match fs::symlink_metadata(&path) {
        Ok(metadata) if !metadata.is_file() || metadata.file_type().is_symlink() => {
            bail!(
                "Authority process lock is not a regular file: {}",
                path.display()
            );
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)?;
    if !FileExt::try_lock_exclusive(&lock)? {
        bail!("Authority is running; stop the server before accessing its data");
    }
    let stopped = StoppedAuthority {
        data: data.to_owned(),
        lock,
    };
    stopped.verify()?;
    Ok(stopped)
}

fn ensure_persisted_keys(data: &Path) -> Result<()> {
    for name in [
        "jwt_secret",
        "wabidb/root_key",
        "wabidb/storage-manifest.json",
    ] {
        if !data.join(name).is_file() {
            bail!("required persisted state is missing: {}; this tool does not bundle external secret overrides", data.join(name).display());
        }
    }
    Ok(())
}

fn collect_instance(data: &Path, uploads: &Path, embedded: bool) -> Result<Vec<Entry>> {
    let mut entries = Vec::new();
    collect_tree(data, "data", &mut entries)?;
    if !embedded {
        collect_tree(uploads, "uploads", &mut entries)?;
    }
    entries.sort_by(|a, b| a.archive_path.cmp(&b.archive_path));
    Ok(entries)
}

fn collect_tree(path: &Path, archive_path: &str, entries: &mut Vec<Entry>) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        bail!("snapshot source contains a symlink: {}", path.display());
    }
    let is_dir = metadata.is_dir();
    if !is_dir && !metadata.is_file() {
        bail!(
            "snapshot source contains a special file: {}",
            path.display()
        );
    }
    if metadata.is_file()
        && matches!(
            archive_path,
            "data/.lock"
                | "data/wabidb/.lock"
                | "data/.wabi-secret-publication.lock"
                | "data/wabidb/.wabi-secret-publication.lock"
        )
    {
        // Process coordination inodes carry no community state. Their
        // diagnostic PID differs between otherwise identical passive copies.
        return Ok(());
    }
    entries.push(Entry {
        archive_path: archive_path.to_string(),
        source_path: path.to_path_buf(),
        is_dir,
        size: if is_dir { 0 } else { metadata.len() },
        modified: metadata.modified().ok(),
    });
    if is_dir {
        let mut children = fs::read_dir(path)?.collect::<std::io::Result<Vec<_>>>()?;
        children.sort_by_key(|entry| entry.file_name());
        for child in children {
            let name = child
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("snapshot path is not UTF-8"))?;
            let child_archive = format!("{archive_path}/{name}");
            validate_relative(&child_archive, true)?;
            collect_tree(&child.path(), &child_archive, entries)?;
        }
    }
    Ok(())
}

fn copy_file_checked<W: Write>(entry: &Entry, writer: &mut W) -> Result<()> {
    let before = fs::metadata(&entry.source_path)?;
    if before.len() != entry.size || before.modified().ok() != entry.modified {
        bail!(
            "snapshot source changed before reading: {}",
            entry.source_path.display()
        );
    }
    let mut source = File::open(&entry.source_path)?;
    let mut hash = Sha256::new();
    copy_exact_hashed(&mut source, writer, entry.size, &mut hash)?;
    writer.write_all(&hash.finalize())?;
    let after = fs::metadata(&entry.source_path)?;
    if after.len() != entry.size || after.modified().ok() != entry.modified {
        bail!(
            "snapshot source changed during reading: {}",
            entry.source_path.display()
        );
    }
    Ok(())
}

fn copy_exact_hashed<R: Read, W: Write>(
    source: &mut R,
    target: &mut W,
    mut remaining: u64,
    hash: &mut Sha256,
) -> Result<()> {
    let mut buffer = [0u8; 64 * 1024];
    while remaining > 0 {
        let limit = usize::try_from(remaining.min(buffer.len() as u64))?;
        let read = source.read(&mut buffer[..limit])?;
        if read == 0 {
            bail!("snapshot file ended early");
        }
        hash.update(&buffer[..read]);
        target.write_all(&buffer[..read])?;
        remaining -= read as u64;
    }
    Ok(())
}

fn validate_relative(name: &str, allow_external_uploads: bool) -> Result<PathBuf> {
    if name.len() > MAX_PATH_BYTES
        || name.is_empty()
        || name.contains('\\')
        || name.contains('\0')
        || (cfg!(windows) && name.contains(':'))
    {
        bail!("invalid snapshot path");
    }
    let segments: Vec<_> = name.split('/').collect();
    if segments.first() != Some(&"data")
        && !(allow_external_uploads && segments.first() == Some(&"uploads"))
    {
        bail!("snapshot path is outside data/uploads roots");
    }
    if segments
        .iter()
        .any(|segment| segment.is_empty() || *segment == "." || *segment == "..")
    {
        bail!("snapshot path contains an unsafe component");
    }
    let mut path = PathBuf::new();
    for segment in segments {
        path.push(segment);
    }
    Ok(path)
}

fn write_string<W: Write>(writer: &mut W, value: &str) -> Result<()> {
    if value.len() > MAX_PATH_BYTES {
        bail!("snapshot path exceeds limit");
    }
    writer.write_all(&(value.len() as u16).to_le_bytes())?;
    writer.write_all(value.as_bytes())?;
    Ok(())
}

fn read_string<R: Read>(reader: &mut R) -> Result<String> {
    let mut length = [0u8; 2];
    reader.read_exact(&mut length)?;
    let length = u16::from_le_bytes(length) as usize;
    if length > MAX_PATH_BYTES {
        bail!("snapshot path exceeds limit");
    }
    let mut bytes = vec![0u8; length];
    reader.read_exact(&mut bytes)?;
    Ok(String::from_utf8(bytes)?)
}

fn private_new_file(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    Ok(options.open(path)?)
}

fn private_new_dir(path: &Path) -> Result<()> {
    fs::create_dir(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn sync_parent(path: &Path) -> Result<()> {
    #[cfg(unix)]
    File::open(path.parent().context("path has no parent")?)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn sync_tree_directories(path: &Path) -> Result<()> {
    for child in fs::read_dir(path)? {
        let child = child?.path();
        if child.is_dir() {
            sync_tree_directories(&child)?;
        }
    }
    #[cfg(unix)]
    File::open(path)?.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf, String, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("source-data");
        let uploads = temp.path().join("source-uploads");
        fs::create_dir_all(data.join("wabidb")).unwrap();
        fs::create_dir(&uploads).unwrap();
        fs::write(data.join("jwt_secret"), b"fixture-jwt-secret").unwrap();
        fs::write(data.join("wabidb/root_key"), b"fixture-root-key").unwrap();
        fs::write(data.join("wabidb/storage-manifest.json"), b"{}").unwrap();
        #[cfg(unix)]
        {
            let stream = data.join("wabidb/streams/channel/channels:ch_8/events");
            fs::create_dir_all(&stream).unwrap();
            fs::write(stream.join("00000001.wseg"), b"stream bytes").unwrap();
        }
        fs::write(data.join("conversation_notes.json"), b"fixture notes").unwrap();
        fs::write(uploads.join("file.txt"), b"uploaded bytes").unwrap();
        let identity = age::x25519::Identity::generate();
        let identity_file = temp.path().join("identity.txt");
        fs::write(&identity_file, identity.to_string().expose_secret()).unwrap();
        (
            temp,
            data,
            uploads,
            identity.to_public().to_string(),
            identity_file,
        )
    }

    fn projection_fixture(data: &Path) {
        let projections = data.join("wabidb/projections");
        fs::create_dir_all(&projections).unwrap();
        fs::write(
            projections.join("snapshot.json"),
            br#"{"watermark":7,"indexes":[["z",[{"key":"b"},{"key":"a"}]],["a",[]]]}"#,
        )
        .unwrap();
    }

    #[test]
    fn export_restore_roundtrip_preserves_complete_roots() {
        let (temp, data, uploads, recipient, identity) = fixture();
        let archive = temp.path().join("snapshot.age");
        let target = temp.path().join("restored");
        export(&data, &uploads, &recipient, &archive).unwrap();
        assert!(!fs::read(&archive)
            .unwrap()
            .windows(b"fixture notes".len())
            .any(|bytes| bytes == b"fixture notes"));
        restore(&archive, &identity, &target, false, false).unwrap();
        assert_eq!(
            fs::read(target.join("data/conversation_notes.json")).unwrap(),
            b"fixture notes"
        );
        assert_eq!(
            fs::read(target.join("uploads/file.txt")).unwrap(),
            b"uploaded bytes"
        );
        assert!(restore(&archive, &identity, &target, false, false).is_err());
    }

    #[test]
    fn bounded_restore_refuses_entry_path_and_plaintext_budgets_and_cleans_staging() {
        let (temp, data, uploads, recipient, identity) = fixture();
        let archive = temp.path().join("snapshot.age");
        export(&data, &uploads, &recipient, &archive).unwrap();
        for limits in [
            RestoreLimits {
                max_entries: 1,
                ..RestoreLimits::default()
            },
            RestoreLimits {
                max_path_bytes: 1,
                ..RestoreLimits::default()
            },
            RestoreLimits {
                max_plaintext_bytes: 1,
                ..RestoreLimits::default()
            },
        ] {
            let target = temp.path().join("denied");
            assert!(
                restore_inactive_with_limits(&archive, &identity, &target, limits, None).is_err()
            );
            assert!(!target.exists());
            assert!(fs::read_dir(temp.path()).unwrap().all(|entry| {
                !entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".wabi-restore-")
            }));
        }
    }

    #[test]
    fn bounded_restore_binds_trusted_ciphertext_digest_before_extracting() {
        let (temp, data, uploads, recipient, identity) = fixture();
        let archive = temp.path().join("snapshot.age");
        export(&data, &uploads, &recipient, &archive).unwrap();
        let target = temp.path().join("restored");
        assert!(restore_inactive_with_limits(
            &archive,
            &identity,
            &target,
            RestoreLimits::default(),
            Some(&"0".repeat(64))
        )
        .is_err());
        assert!(!target.exists());
        let digest = hex::encode(archive_sha256(&archive).unwrap());
        restore_inactive_with_limits(
            &archive,
            &identity,
            &target,
            RestoreLimits::default(),
            Some(&digest),
        )
        .unwrap();
        assert!(target.join("data/wabidb/writer-fenced-v1").exists());
    }

    #[test]
    fn bounded_restore_rejects_invalid_limits_and_oversized_ciphertext_before_staging() {
        let (temp, _, _, _, identity) = fixture();
        let archive = temp.path().join("oversized.age");
        File::create(&archive)
            .unwrap()
            .set_len(4 * 1024 * 1024)
            .unwrap();
        let target = temp.path().join("denied");
        let limits = RestoreLimits {
            max_plaintext_bytes: 1,
            max_entries: 1,
            max_path_bytes: 1,
            timeout: std::time::Duration::from_secs(1),
        };
        assert!(
            restore_inactive_with_limits(&archive, &identity, &target, limits.clone(), None)
                .unwrap_err()
                .to_string()
                .contains("ciphertext byte budget")
        );
        assert!(restore_inactive_with_limits(
            &archive,
            &identity,
            &target,
            RestoreLimits {
                timeout: std::time::Duration::ZERO,
                ..limits
            },
            None
        )
        .is_err());
        assert!(!target.exists());
    }

    #[test]
    fn passive_replica_restore_is_fenced_before_publication() {
        let (temp, data, uploads, recipient, identity) = fixture();
        let archive = temp.path().join("passive.age");
        let target = temp.path().join("passive-copy");
        export(&data, &uploads, &recipient, &archive).unwrap();
        restore(&archive, &identity, &target, false, true).unwrap();
        assert_eq!(
            fs::read(target.join("data/wabidb/writer-fenced-v1")).unwrap(),
            b"fenced\n"
        );
        assert!(!target.join("data/wabidb/activation-pending-v1").exists());
        assert!(restore(
            &archive,
            &identity,
            &temp.path().join("invalid"),
            true,
            true
        )
        .is_err());
    }

    #[test]
    fn passive_move_requires_matching_whole_tree_and_old_writer_fence() {
        let (temp, data, uploads, recipient, identity) = fixture();
        projection_fixture(&data);
        let archive = temp.path().join("passive.age");
        let target = temp.path().join("passive-copy");
        let receipt = temp.path().join("passive-receipt.json");
        fs::write(data.join("wabidb/.lock"), b"old-writer-pid").unwrap();
        fs::write(data.join(".wabi-secret-publication.lock"), b"").unwrap();
        export(&data, &uploads, &recipient, &archive).unwrap();
        restore(&archive, &identity, &target, false, true).unwrap();
        assert!(!target.join("data/wabidb/.lock").exists());
        assert!(!target.join("data/.wabi-secret-publication.lock").exists());
        // Runtime lock diagnostics on an independently run copy do not form
        // part of its sealed community-state identity.
        fs::write(target.join("data/wabidb/.lock"), b"receiver-pid").unwrap();
        assert!(seal_passive_move(&data, &uploads, &receipt).is_err());
        assert!(!receipt.exists());
        fence_stopped(&data).unwrap();
        seal_passive_move(&data, &uploads, &receipt).unwrap();
        assert!(activate_passive(&target, &receipt, false).is_err());

        // Projection serialization order may differ after a legitimate replay.
        fs::write(
            target.join("data/wabidb/projections/snapshot.json"),
            br#"{"indexes":[["a",[]],["z",[{"key":"a"},{"key":"b"}]]],"watermark":7}"#,
        )
        .unwrap();
        fs::write(target.join("uploads/file.txt"), b"changed bytes").unwrap();
        assert!(activate_passive(&target, &receipt, true).is_err());
        assert!(target.join("data/wabidb/writer-fenced-v1").exists());
        fs::write(target.join("uploads/file.txt"), b"uploaded bytes").unwrap();
        fs::write(target.join("data/unexpected.json"), b"extra state").unwrap();
        assert!(activate_passive(&target, &receipt, true).is_err());
        fs::remove_file(target.join("data/unexpected.json")).unwrap();
        activate_passive(&target, &receipt, true).unwrap();
        assert!(!target.join("data/wabidb/writer-fenced-v1").exists());
        assert!(data.join("wabidb/writer-fenced-v1").exists());
        assert!(activate_passive(&target, &receipt, true).is_err());
    }

    #[test]
    fn passive_move_rejects_tampered_receipt_and_projection() {
        let (temp, data, uploads, recipient, identity) = fixture();
        projection_fixture(&data);
        let archive = temp.path().join("passive.age");
        let target = temp.path().join("passive-copy");
        let receipt = temp.path().join("passive-receipt.json");
        export(&data, &uploads, &recipient, &archive).unwrap();
        restore(&archive, &identity, &target, false, true).unwrap();
        fence_stopped(&data).unwrap();
        seal_passive_move(&data, &uploads, &receipt).unwrap();
        let mut altered: PassiveMoveReceipt =
            serde_json::from_slice(&fs::read(&receipt).unwrap()).unwrap();
        altered.claims.projection_watermark += 1;
        let bad_receipt = temp.path().join("bad-receipt.json");
        fs::write(&bad_receipt, serde_json::to_vec(&altered).unwrap()).unwrap();
        assert!(activate_passive(&target, &bad_receipt, true).is_err());
        fs::write(
            target.join("data/wabidb/projections/snapshot.json"),
            br#"{"watermark":8,"indexes":[["z",[{"key":"b"},{"key":"a"}]],["a",[]]]}"#,
        )
        .unwrap();
        assert!(activate_passive(&target, &receipt, true).is_err());
        assert!(target.join("data/wabidb/writer-fenced-v1").exists());
    }

    #[test]
    fn export_refuses_an_owned_advisory_lock_and_accepts_it_after_release() {
        use fs4::fs_std::FileExt;

        let (temp, data, uploads, recipient, _) = fixture();
        let archive = temp.path().join("snapshot.age");
        let path = data.join("wabidb/.lock");
        let held = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        assert!(FileExt::try_lock_exclusive(&held).unwrap());
        assert!(export(&data, &uploads, &recipient, &archive).is_err());
        assert!(!archive.exists());
        drop(held);
        assert!(path.exists());
        export(&data, &uploads, &recipient, &archive).unwrap();
        assert!(archive.exists());
    }

    #[test]
    fn stopped_guard_prevents_server_start_throughout_the_operation() {
        use fs4::fs_std::FileExt;

        let (_temp, data, _uploads, _recipient, _) = fixture();
        let stopped = ensure_stopped(&data).unwrap();
        let path = data.join("wabidb/.lock");
        let contender = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        assert!(!FileExt::try_lock_exclusive(&contender).unwrap());
        stopped.verify().unwrap();
        drop(stopped);
        assert!(FileExt::try_lock_exclusive(&contender).unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn stopped_guard_refuses_a_replaced_lock_inode() {
        let (_temp, data, _uploads, _recipient, _) = fixture();
        let stopped = ensure_stopped(&data).unwrap();
        let path = data.join("wabidb/.lock");
        fs::remove_file(&path).unwrap();
        fs::write(&path, b"replacement").unwrap();
        assert!(stopped.verify().is_err());
    }

    #[test]
    fn stopped_fence_requires_no_locks_and_survives_repeated_calls() {
        let (_temp, data, _uploads, _recipient, _identity) = fixture();
        let marker = data.join("wabidb/writer-fenced-v1");
        fs::write(data.join(".lock"), b"active or stale").unwrap();
        assert!(fence_stopped(&data).is_err());
        assert!(!marker.exists());
        fs::remove_file(data.join(".lock")).unwrap();
        fence_stopped(&data).unwrap();
        assert_eq!(fs::read(&marker).unwrap(), b"fenced\n");
        fence_stopped(&data).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(marker).unwrap().permissions().mode() & 0o077,
                0
            );
        }
    }

    #[test]
    fn controlled_move_needs_matching_fenced_archive_receipt() {
        let (temp, data, uploads, recipient, identity) = fixture();
        let archive = temp.path().join("move.age");
        let other_archive = temp.path().join("other.age");
        let unfenced_archive = temp.path().join("unfenced.age");
        let target = temp.path().join("replacement");
        let receipt = temp.path().join("fence-receipt.json");
        export(&data, &uploads, &recipient, &unfenced_archive).unwrap();
        assert!(restore(&unfenced_archive, &identity, &target, true, false).is_err());
        assert!(!target.exists());
        assert!(fence_stopped_with_receipt(&data, &unfenced_archive, &receipt).is_err());
        assert!(!receipt.exists());
        fence_stopped(&data).unwrap();
        export(&data, &uploads, &recipient, &archive).unwrap();
        export(&data, &uploads, &recipient, &other_archive).unwrap();
        restore(&archive, &identity, &target, true, false).unwrap();
        assert!(target.join("data/wabidb/activation-pending-v1").exists());
        assert!(!target.join("data/wabidb/writer-fenced-v1").exists());
        assert!(activate_restored(&target, &receipt).is_err());
        assert!(target.join("data/wabidb/activation-pending-v1").exists());
        fence_stopped_with_receipt(&data, &other_archive, &receipt).unwrap();
        assert!(activate_restored(&target, &receipt).is_err());
        assert!(target.join("data/wabidb/activation-pending-v1").exists());
        let matching_receipt = temp.path().join("matching-receipt.json");
        fence_stopped_with_receipt(&data, &archive, &matching_receipt).unwrap();
        let mut altered: FenceReceipt =
            serde_json::from_slice(&fs::read(&matching_receipt).unwrap()).unwrap();
        let mut proof_bytes = hex::decode(&altered.proof).unwrap();
        proof_bytes[0] ^= 1;
        altered.proof = hex::encode(proof_bytes);
        let bad_receipt = temp.path().join("bad-receipt.json");
        fs::write(&bad_receipt, serde_json::to_vec(&altered).unwrap()).unwrap();
        assert!(activate_restored(&target, &bad_receipt).is_err());
        assert!(target.join("data/wabidb/activation-pending-v1").exists());
        activate_restored(&target, &matching_receipt).unwrap();
        assert!(!target.join("data/wabidb/activation-pending-v1").exists());
        assert!(data.join("wabidb/writer-fenced-v1").exists());
    }

    #[test]
    fn corrupt_archive_never_publishes_a_restore() {
        let (temp, data, uploads, recipient, identity) = fixture();
        let archive = temp.path().join("snapshot.age");
        let target = temp.path().join("restored");
        export(&data, &uploads, &recipient, &archive).unwrap();
        let mut bytes = fs::read(&archive).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        fs::write(&archive, bytes).unwrap();
        assert!(restore(&archive, &identity, &target, false, false).is_err());
        assert!(!target.exists());
    }

    #[test]
    fn default_nested_uploads_are_included_once() {
        let (temp, data, uploads, recipient, identity) = fixture();
        let nested = data.join("uploads");
        fs::rename(uploads, &nested).unwrap();
        let archive = temp.path().join("snapshot.age");
        let target = temp.path().join("restored");
        export(&data, &nested, &recipient, &archive).unwrap();
        restore(&archive, &identity, &target, false, false).unwrap();
        assert_eq!(
            fs::read(target.join("data/uploads/file.txt")).unwrap(),
            b"uploaded bytes"
        );
        assert!(!target.join("uploads").exists());
    }

    #[test]
    fn archive_paths_cannot_escape_or_switch_roots() {
        for path in [
            "data/../escape",
            "data//escape",
            "data/./escape",
            "data\\escape",
            "/data/escape",
            "other/escape",
            "data/escape\0hidden",
        ] {
            assert!(validate_relative(path, true).is_err(), "accepted {path:?}");
        }
        assert!(validate_relative("uploads/file", false).is_err());
        #[cfg(unix)]
        assert_eq!(
            validate_relative("data/wabidb/channels:ch_8", true).unwrap(),
            PathBuf::from("data/wabidb/channels:ch_8")
        );
    }

    #[cfg(unix)]
    #[test]
    fn export_refuses_symlinks_in_the_source_tree() {
        use std::os::unix::fs::symlink;

        let (temp, data, uploads, recipient, _) = fixture();
        symlink(data.join("jwt_secret"), data.join("extra-secret-link")).unwrap();
        let archive = temp.path().join("snapshot.age");
        assert!(export(&data, &uploads, &recipient, &archive).is_err());
        assert!(!archive.exists());
    }

    #[test]
    fn wrong_identity_never_publishes_a_restore() {
        let (temp, data, uploads, recipient, _) = fixture();
        let archive = temp.path().join("snapshot.age");
        export(&data, &uploads, &recipient, &archive).unwrap();
        let unrelated = age::x25519::Identity::generate();
        let identity = temp.path().join("wrong-identity.txt");
        fs::write(&identity, unrelated.to_string().expose_secret()).unwrap();
        let target = temp.path().join("restored");
        assert!(restore(&archive, &identity, &target, false, false).is_err());
        assert!(!target.exists());
    }

    #[cfg(unix)]
    #[test]
    fn restore_refuses_an_existing_dangling_symlink_target() {
        use std::os::unix::fs::symlink;

        let (temp, data, uploads, recipient, identity) = fixture();
        let archive = temp.path().join("snapshot.age");
        export(&data, &uploads, &recipient, &archive).unwrap();
        let target = temp.path().join("restored");
        symlink(temp.path().join("absent"), &target).unwrap();
        assert!(restore(&archive, &identity, &target, false, false).is_err());
        assert!(fs::symlink_metadata(&target)
            .unwrap()
            .file_type()
            .is_symlink());
    }
}
