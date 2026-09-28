//! Explicit offline migration of older upload registry entries into canonical
//! WabiDB publication records. This does not make a passive replica complete.

use anyhow::{bail, ensure, Context, Result};
use clap::Parser;
use std::path::{Path, PathBuf};
use wabi_server::{adapter::WdbAdapter, upload_registry::UploadRegistry};

#[derive(Parser)]
#[command(about = "Preview or migrate older uploads while the Authority is stopped")]
struct Args {
    /// Authority data directory containing upload_registry.json and wabidb/.
    #[arg(long)]
    data_dir: PathBuf,
    /// Complete uploads directory from the same stopped Authority.
    #[arg(long)]
    uploads_dir: PathBuf,
    /// Maximum files to hash and, with --apply, publish in this run.
    #[arg(long, default_value_t = 100)]
    limit: usize,
    /// Commit verified publication events; omission previews without appending them.
    #[arg(long)]
    apply: bool,
}

fn require_regular_file(path: &Path, description: &str) -> Result<()> {
    let metadata = std::fs::symlink_metadata(path)
        .with_context(|| format!("{description} is missing: {}", path.display()))?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "{description} must be a regular file: {}",
        path.display()
    );
    Ok(())
}

fn require_real_directory(path: &Path, description: &str) -> Result<()> {
    let metadata = std::fs::symlink_metadata(path)
        .with_context(|| format!("{description} is missing: {}", path.display()))?;
    ensure!(
        metadata.is_dir() && !metadata.file_type().is_symlink(),
        "{description} must be a real directory: {}",
        path.display()
    );
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    ensure!(
        (1..=1_000).contains(&args.limit),
        "--limit must be between 1 and 1000"
    );
    require_real_directory(&args.data_dir, "Authority data directory")?;
    require_real_directory(&args.uploads_dir, "uploads directory")?;
    require_regular_file(
        &args.data_dir.join("upload_registry.json"),
        "upload registry",
    )?;
    let wdb_dir = args.data_dir.join("wabidb");
    require_real_directory(&wdb_dir, "WabiDB directory")?;
    require_regular_file(&wdb_dir.join("storage-manifest.json"), "WabiDB manifest")?;
    let has_external_key = std::env::var("WABIDB_ROOT_KEY")
        .ok()
        .is_some_and(|value| !value.trim().is_empty());
    if !has_external_key {
        require_regular_file(&wdb_dir.join("root_key"), "WabiDB root key")?;
    }
    if args.apply {
        for marker in ["writer-fenced-v1", "activation-pending-v1"] {
            match std::fs::symlink_metadata(wdb_dir.join(marker)) {
                Ok(_) => {
                    bail!("refusing to backfill a fenced or inactive Authority data directory")
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
    }

    // The engine's exclusive data lock is required even for a preview: a
    // concurrent Authority could change bytes after they are inspected.
    let adapter = WdbAdapter::open(&wdb_dir).await?;
    if args.apply && adapter.engine().local_writer_fenced().await {
        bail!("refusing to backfill a writer-fenced WabiDB");
    }
    let registry = UploadRegistry::new_for_authority(&args.data_dir, &args.uploads_dir)?;
    let report = registry
        .backfill_legacy_assets(&args.uploads_dir, adapter.engine(), args.limit, args.apply)
        .await?;
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "applied": args.apply,
            "complete": report.missing == 0 && report.deferred == 0,
            "report": report,
        }))?
    );
    Ok(())
}
