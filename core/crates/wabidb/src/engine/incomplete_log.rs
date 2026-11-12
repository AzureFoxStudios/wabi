//! The record that a directory's log is incomplete (`global/incomplete-log.json`).
//!
//! A directory can hold a checkpoint that outlived its log: the segment and
//! commit-index files below some commit are gone, and the snapshot and the
//! SQLite read model are then the only copy of what those commits did. The
//! engine opens such a directory when both saved projections agree
//! (`engine::plan_startup`), and from then on it **must never rebuild a
//! projection from the log**: the rebuild would silently drop everything the
//! lost commits did. The commit index alone cannot show that later, because
//! after one more write its highest entry is above both watermarks.
//!
//! So the first start that keeps both saved projections over a short log
//! records the commit below which the log is incomplete. The record is not
//! lifted by restoring log files (commits written since the loss share their
//! file names) but by restoring the whole directory from a backup taken before
//! it. It lives under `global/` so that a live checkpoint carries it to a restored copy
//! (test: `instance_archive::live::tests::the_incomplete_log_record_is_exported`).
//!
//! Format: `{"version":1,"incomplete_below":N}`. A file that is present but
//! cannot be read or parsed stops startup: treating it as absent would allow
//! the rebuild it exists to prevent.
//!
//! **Three copies.** The evidence is also written into `storage-manifest.json`
//! (`incomplete_log_below`) and into every snapshot (`incomplete_log_below`),
//! and the engine takes the largest of the three. Removing the record file
//! alone therefore changes nothing: the commit index cannot show the hole (a
//! commit number can legitimately be missing from it, see
//! `tests::read_model_messages::commit_numbers_can_have_gaps_that_leave_no_trace`),
//! so the evidence is the only thing that does. It is lifted by restoring the
//! whole directory from a backup taken before the hole, which replaces all
//! three.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{Result, WabiError};
use crate::projections::read_model::sync_dir;

const VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u32,
    incomplete_below: u64,
}

/// `data_dir/global/incomplete-log.json`.
pub(crate) fn path(data_dir: &Path) -> PathBuf {
    data_dir.join("global").join("incomplete-log.json")
}

fn unreadable(path: &Path, detail: String) -> WabiError {
    WabiError::Corrupt {
        location: path.display().to_string(),
        detail: format!(
            "{detail}; the engine will not start until this file is valid (restore it from a \
             backup; remove it only if the log below the checkpoint has been restored and \
             `wabidb-cli verify` accepts it)"
        ),
    }
}

/// The record file's value alone.
pub(crate) fn load_record_file(data_dir: &Path) -> Result<Option<u64>> {
    let path = path(data_dir);
    match std::fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_file() => {}
        Ok(_) => return Err(unreadable(&path, "it is not a regular file".into())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(unreadable(&path, format!("cannot read: {error}"))),
    }
    let bytes = std::fs::read(&path).map_err(|e| unreadable(&path, format!("cannot read: {e}")))?;
    let record: Record = serde_json::from_slice(&bytes)
        .map_err(|e| unreadable(&path, format!("cannot parse: {e}")))?;
    if record.version != VERSION {
        return Err(unreadable(&path, format!("unknown version {}", record.version)));
    }
    if record.incomplete_below > crate::projections::read_model::MAX_COMMIT_SEQ {
        return Err(unreadable(&path, "the commit number is not plausible".into()));
    }
    Ok(Some(record.incomplete_below))
}

/// The commit below which the log is incomplete: the largest of the record
/// file, the manifest's field and the snapshot's field (`snapshot_below`,
/// which the caller has already read). `None` when none of them says so.
pub(crate) fn load_with(data_dir: &Path, snapshot_below: Option<u64>) -> Result<Option<u64>> {
    let manifest = super::manifest_field(data_dir, MANIFEST_KEY);
    for value in [manifest, snapshot_below].into_iter().flatten() {
        if value > crate::projections::read_model::MAX_COMMIT_SEQ {
            return Err(unreadable(
                &path(data_dir),
                format!("another copy of the evidence holds {value}, which is not plausible"),
            ));
        }
    }
    Ok([load_record_file(data_dir)?, manifest, snapshot_below].into_iter().flatten().max())
}

/// [`load_with`], reading the snapshot's copy itself.
pub(crate) fn load(data_dir: &Path) -> Result<Option<u64>> {
    let snapshot_below = crate::engine::locks::ProjectionState::read_snapshot_header(data_dir)
        .ok()
        .flatten()
        .and_then(|header| header.incomplete_log_below);
    load_with(data_dir, snapshot_below)
}

pub(crate) const MANIFEST_KEY: &str = "incomplete_log_below";

/// Record that the log is incomplete below `below`; an existing record keeps
/// its larger value. Writes the record file and the manifest's copy, durably;
/// the snapshot's copy follows with the next snapshot. Returns the value stored.
pub(crate) fn record(data_dir: &Path, below: u64) -> Result<u64> {
    let below = load(data_dir)?.map_or(below, |existing| existing.max(below));
    let bytes = serde_json::to_vec(&Record { version: VERSION, incomplete_below: below })
        .map_err(|e| WabiError::InternalInvariantViolated {
            invariant: format!("incomplete-log record serialize: {e}"),
        })?;
    write_atomically(&path(data_dir), &bytes)?;
    super::update_manifest(data_dir, |object| {
        object.insert(MANIFEST_KEY.to_string(), serde_json::json!(below));
    })?;
    Ok(below)
}

/// Write `bytes` to `path` so that a crash leaves the old content or the new,
/// never a mixture: a temporary file in the same directory is written and
/// synced, renamed over `path`, and the directory is synced.
pub(crate) fn write_atomically(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let parent = path.parent().ok_or_else(|| WabiError::InternalInvariantViolated {
        invariant: format!("{} has no parent directory", path.display()),
    })?;
    std::fs::create_dir_all(parent)?;
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".tmp");
    let temp = parent.join(name);
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&temp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&temp, path)?;
    sync_dir(parent)?;
    Ok(())
}
