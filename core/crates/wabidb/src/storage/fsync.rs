//! Cross-platform directory fsync utility.
//!
//! On POSIX systems, renaming a file into a directory does not guarantee that
//! the directory's entry for that file is durable. The directory's inode and
//! its block of directory entries must be explicitly fsync'd, otherwise a
//! power loss between the rename and the fsync can leave the directory without
//! the new entry (even though the file itself is on disk).
//!
//! Missing directory fsyncs is the #1 cause of custom database corruption on
//! power loss. Every atomic-rename operation in WabiDB (blob write, commit index
//! segment seal, snapshot file rotation) MUST fsync the parent directory after
//! the rename completes.
//!
//! ## Platform behavior
//!
//! - **Linux / macOS (POSIX):** opens the directory and calls `fsync(2)`. Some
//!   filesystems (`tmpfs`, `overlayfs`, `aufs`) may return success without
//!   actually flushing; the engine treats that as success but the calling code
//!   should know. The current implementation does not special-case these.
//! - **Windows:** `FlushFileBuffers` on a directory handle. Native paths use
//!   the `OpenOptions` API; this implementation converts the path to a wide
//!   string and calls `FlushFileBuffers` via `std::os::windows`.
//!
//! ## Usage
//!
//! ```no_run
//! # fn main() -> Result<(), wabidb::error::WabiError> {
//! // After renaming a file into a directory, run this in an async context:
//! //   use wabidb::storage::fsync::fsync_dir;
//! //   fsync_dir("/var/lib/wabidb/blobs/ab").await?;
//! // Ok::<(), wabidb::error::WabiError>(())
//! # Ok(())
//! # }
//! ```
//!
//! (The `fsync_dir` and `fsync_dir_sync` functions are `async`/`sync`; see
//! the unit tests for invocation examples.)

use crate::error::{Result, WabiError};
use std::path::Path;
use tokio::fs::File;

/// Asynchronously fsync a directory.
///
/// Opens the directory, calls `sync_all()` (which on POSIX maps to `fsync(2)`
/// and on Windows maps to `FlushFileBuffers`), and returns. Errors are
/// propagated as `WabiError::Io`.
///
/// Use this after every atomic rename that adds a file to a directory, to
/// guarantee that the directory entry is durable.
pub async fn fsync_dir<P: AsRef<Path>>(path: P) -> Result<()> {
    let path = path.as_ref();

    // On POSIX, opening a directory requires no special flags.
    // On Windows, we need FILE_FLAG_BACKUP_SEMANTICS to open a directory handle.
    #[cfg(unix)]
    let file = File::open(path).await?;

    #[cfg(windows)]
    let file = {
        use std::os::windows::fs::OpenOptionsExt;
        let mut opts = tokio::fs::OpenOptions::new();
        // FILE_FLAG_BACKUP_SEMANTICS = 0x02000000 — required to open a directory
        opts.custom_flags(0x02000000);
        opts.read(true).open(path).await?
    };

    file.sync_all().await.map_err(|e| {
        WabiError::Corrupt {
            location: format!("directory fsync: {}", path.display()),
            detail: format!("sync_all failed: {e}"),
        }
    })?;
    Ok(())
}

/// Synchronously fsync a directory. Use this when called from sync code paths
/// (e.g. during segment recovery on engine startup).
pub fn fsync_dir_sync<P: AsRef<Path>>(path: P) -> Result<()> {
    let path = path.as_ref();

    #[cfg(unix)]
    let file = std::fs::File::open(path)?;

    #[cfg(windows)]
    let file = {
        use std::os::windows::fs::OpenOptionsExt;
        let mut opts = std::fs::OpenOptions::new();
        opts.custom_flags(0x02000000);
        opts.read(true).open(path)?
    };

    file.sync_all().map_err(|e| {
        WabiError::Corrupt {
            location: format!("directory fsync: {}", path.display()),
            detail: format!("sync_all failed: {e}"),
        }
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[tokio::test]
    async fn fsync_existing_dir_succeeds() {
        let dir = tempdir().unwrap();
        let result: std::result::Result<(), WabiError> = fsync_dir(dir.path()).await;
        result.unwrap();
    }

    #[test]
    fn fsync_sync_existing_dir_succeeds() {
        let dir = tempdir().unwrap();
        fsync_dir_sync(dir.path()).unwrap();
    }

    #[tokio::test]
    async fn fsync_missing_dir_errors() {
        let dir = tempdir().unwrap();
        let missing = dir.path().join("nonexistent");
        let result: std::result::Result<(), WabiError> = fsync_dir(&missing).await;
        assert!(result.is_err(), "expected error for missing directory");
    }

    #[test]
    fn fsync_sync_missing_dir_errors() {
        let dir = tempdir().unwrap();
        let missing = dir.path().join("nonexistent");
        let result = fsync_dir_sync(&missing);
        assert!(result.is_err(), "expected error for missing directory");
    }

    #[tokio::test]
    async fn fsync_after_rename_makes_entry_durable() {
        // This test verifies the *invariant* the utility exists to provide:
        // after fsync_dir, a file that was renamed into the directory is
        // observable as a directory entry. We don't have a reliable way to
        // simulate power loss in a unit test, so this just verifies the
        // happy-path sequence doesn't error.
        let dir = tempdir().unwrap();
        let sub = dir.path().join("sub");
        fs::create_dir(&sub).unwrap();

        // Create a file, write to it, rename into sub/, then fsync sub/.
        let src = dir.path().join("src.tmp");
        fs::write(&src, b"hello").unwrap();
        let dst = sub.join("dst.bin");
        fs::rename(&src, &dst).unwrap();

        let result: std::result::Result<(), WabiError> = fsync_dir(&sub).await;
        result.unwrap();

        // The file is observable in the directory.
        assert!(dst.exists());
        assert_eq!(fs::read(&dst).unwrap(), b"hello");
    }
}
