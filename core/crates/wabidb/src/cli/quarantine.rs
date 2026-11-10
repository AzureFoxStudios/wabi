//! `wabidb-cli quarantine --seq N`: record commit N in the engine's
//! quarantine list (`global/quarantine.json`), so the next startup skips
//! that commit instead of refusing it (Task 3.2).
//!
//! This is the one command that writes. Unlike `check`, `verify`, `status`
//! and `list-streams`, it takes the engine's advisory lock for as long as it
//! runs, so it fails with `AlreadyRunning` against a live engine (or
//! anything else holding the lock). It never creates or unlinks `.lock`
//! (AGENTS.md golden rule 9): a directory without one is refused, and the
//! lock is released by closing the handle.
//!
//! Only a commit the commit index holds can be quarantined. The sequencer
//! continues above every indexed commit, so a seq the index does not hold
//! could be the seq of the next real write, which would then be skipped.

use std::path::Path;

use crate::error::{Result, WabiError};

#[derive(Debug, Clone)]
pub struct QuarantineReport {
    /// The commit this run was asked to quarantine.
    pub commit_seq: u64,
    /// It was already on the list; nothing was written.
    pub already_quarantined: bool,
    /// Every quarantined commit, ascending, after this run.
    pub quarantined: Vec<u64>,
}

/// Quarantine `commit_seq` in the stopped engine directory `data_dir`.
pub fn quarantine(data_dir: &Path, commit_seq: u64) -> Result<QuarantineReport> {
    let lock_path = data_dir.join(".lock");
    match std::fs::symlink_metadata(&lock_path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(WabiError::Validation {
                command: "quarantine".into(),
                reason: format!(
                    "{} does not exist; DATA_DIR must be an engine directory the server has \
                     opened (e.g. data/wabi-server/wabidb)",
                    lock_path.display()
                ),
            });
        }
        Err(error) => return Err(WabiError::Io(error)),
    }
    // Held until this function returns; dropping the handle releases it.
    let _lock = crate::engine::locks::try_acquire_process_lock(&lock_path)?
        .ok_or(WabiError::AlreadyRunning)?;

    let index_dir = data_dir.join("global").join("commit-index");
    let indexed = crate::commit_index::batcher::read_all_entries(&index_dir)?
        .iter()
        .any(|entry| entry.commit_seq == commit_seq);
    if !indexed {
        return Err(WabiError::Validation {
            command: "quarantine".into(),
            reason: format!(
                "commit {commit_seq} is not in the commit index {}; only a commit \
                 startup refused can be quarantined",
                index_dir.display()
            ),
        });
    }

    let (seqs, already_quarantined) = crate::engine::quarantine::append(data_dir, commit_seq)?;
    Ok(QuarantineReport {
        commit_seq,
        already_quarantined,
        quarantined: seqs.into_iter().collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::test_support::{config, real_engine_tree};
    use crate::error::WabiError;

    #[cfg(unix)]
    fn inode(path: &Path) -> u64 {
        std::os::unix::fs::MetadataExt::ino(&std::fs::metadata(path).unwrap())
    }

    /// Task 3.2 test 3: quarantine must fail while anything else holds the
    /// advisory lock (a live engine, or another process), and must leave
    /// the lock file and the data directory as they were.
    #[tokio::test]
    async fn quarantine_fails_while_the_lock_is_held() {
        let dir = tempfile::tempdir().unwrap();
        real_engine_tree(dir.path()).await;
        let lock = dir.path().join(".lock");
        let file = crate::engine::quarantine::path(dir.path());
        #[cfg(unix)]
        let lock_inode = inode(&lock);

        // A running engine.
        let engine = crate::tests::reopen_after_drop(config(dir.path()), None).await.unwrap();
        let error = quarantine(dir.path(), 2).unwrap_err();
        assert!(matches!(error, WabiError::AlreadyRunning), "{error:?}");
        assert!(!file.exists());
        drop(engine);

        // Another holder of the same lock inode, as another process would be.
        let held = crate::tests::wait_for_stopped_engine(dir.path()).await;
        let error = quarantine(dir.path(), 2).unwrap_err();
        assert!(matches!(error, WabiError::AlreadyRunning), "{error:?}");
        assert!(!file.exists());
        drop(held);

        // Released: it runs, and the lock file is the same inode afterwards.
        assert_eq!(quarantine(dir.path(), 2).unwrap().quarantined, vec![2]);
        assert!(lock.exists(), "quarantine must never unlink the lock file");
        #[cfg(unix)]
        assert_eq!(inode(&lock), lock_inode);
        // And it released the lock again.
        drop(crate::tests::wait_for_stopped_engine(dir.path()).await);
    }

    #[tokio::test]
    async fn quarantine_appends_once_and_refuses_unindexed_seqs() {
        let dir = tempfile::tempdir().unwrap();
        real_engine_tree(dir.path()).await; // commits 1..=4

        assert_eq!(quarantine(dir.path(), 3).unwrap().quarantined, vec![3]);
        let report = quarantine(dir.path(), 1).unwrap();
        assert_eq!(report.quarantined, vec![1, 3]);
        let again = quarantine(dir.path(), 3).unwrap();
        assert!(again.already_quarantined);
        assert_eq!(again.quarantined, vec![1, 3]);
        assert_eq!(
            crate::engine::quarantine::load(dir.path()).unwrap().into_iter().collect::<Vec<_>>(),
            vec![1, 3]
        );

        // A seq the commit index does not hold is refused: it could be the
        // seq the next real write receives.
        for seq in [0, 5, 99] {
            let error = quarantine(dir.path(), seq).unwrap_err();
            assert!(error.to_string().contains("not in the commit index"), "{error}");
        }
        assert_eq!(crate::engine::quarantine::load(dir.path()).unwrap().len(), 2);
        // No temp file is left behind.
        let names: Vec<_> = std::fs::read_dir(dir.path().join("global"))
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert!(!names.iter().any(|n| n.ends_with(".tmp")), "{names:?}");
    }

    /// Without a `.lock` this is not a directory the server has opened.
    /// Creating one here could leave a lock file the server cannot open
    /// (for example, root-owned when the server runs as another user).
    #[tokio::test]
    async fn quarantine_refuses_a_directory_without_a_lock_file() {
        let dir = tempfile::tempdir().unwrap();
        real_engine_tree(dir.path()).await;
        std::fs::remove_file(dir.path().join(".lock")).unwrap();
        let error = quarantine(dir.path(), 1).unwrap_err();
        assert!(error.to_string().contains(".lock"), "{error}");
        assert!(!dir.path().join(".lock").exists());
        assert!(!crate::engine::quarantine::path(dir.path()).exists());
    }
}
