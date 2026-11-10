//! The operator's quarantine list: `global/quarantine.json` in the engine
//! directory names durable commits that replay and the live dispatcher must
//! skip (Task 3.2).
//!
//! A commit lands here only through `wabidb-cli quarantine --seq N`, run
//! against a stopped engine after its startup refused that commit ("repair
//! required before startup"). Skipping a commit discards its effect on every
//! projection: the events stay in the log, but no read model ever sees them.
//! That is the operator's decision to take, after copying the data
//! directory (docs/deployment/BACKUP_AND_RECOVERY.md).
//!
//! Format: `{"version":1,"commit_seqs":[N, ...]}`, ascending, no repeats. A
//! missing file is an empty list. A file that is present but cannot be read
//! or parsed stops startup: treating it as empty would apply events the
//! operator asked to skip.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{Result, WabiError};

const VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct QuarantineFile {
    version: u32,
    commit_seqs: Vec<u64>,
}

/// `data_dir/global/quarantine.json`.
pub(crate) fn path(data_dir: &Path) -> PathBuf {
    data_dir.join("global").join("quarantine.json")
}

fn unreadable(path: &Path, detail: String) -> WabiError {
    WabiError::Corrupt {
        location: path.display().to_string(),
        detail: format!(
            "{detail}; the engine will not start until this file is valid \
             (restore it from the copy taken before quarantine, or remove it \
             to skip nothing)"
        ),
    }
}

/// The quarantined commit_seqs. Empty if the file does not exist.
pub(crate) fn load(data_dir: &Path) -> Result<BTreeSet<u64>> {
    let path = path(data_dir);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(BTreeSet::new());
        }
        Err(error) => return Err(unreadable(&path, format!("cannot read: {error}"))),
    };
    let file: QuarantineFile = serde_json::from_slice(&bytes)
        .map_err(|error| unreadable(&path, format!("cannot parse: {error}")))?;
    if file.version != VERSION {
        return Err(unreadable(
            &path,
            format!("unsupported version {} (this build reads {VERSION})", file.version),
        ));
    }
    Ok(file.commit_seqs.into_iter().collect())
}

/// Add `commit_seq` to the file, atomically: write a temp file, fsync it,
/// rename it over the file, fsync `global/`. Returns the whole list and
/// whether `commit_seq` was already on it (then nothing is written).
///
/// The caller must hold the engine's advisory lock. An unreadable existing
/// file is an error, never overwritten.
pub(crate) fn append(data_dir: &Path, commit_seq: u64) -> Result<(BTreeSet<u64>, bool)> {
    use std::io::Write;

    let mut seqs = load(data_dir)?;
    if !seqs.insert(commit_seq) {
        return Ok((seqs, true));
    }
    let path = path(data_dir);
    let dir = path.parent().expect("quarantine path has a parent");
    let bytes = serde_json::to_vec_pretty(&QuarantineFile {
        version: VERSION,
        commit_seqs: seqs.iter().copied().collect(),
    })
    .map_err(|e| WabiError::InternalInvariantViolated {
        invariant: format!("quarantine serialize: {e}"),
    })?;
    // The advisory lock makes this temp path single-owner.
    let temp = path.with_extension("json.tmp");
    let mut file = std::fs::File::create(&temp)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&temp, &path)?;
    crate::storage::fsync::fsync_dir_sync(dir)?;
    Ok((seqs, false))
}
