use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::{Result, WabiError};

pub struct BackupSummary {
    pub bytes_copied: u64,
    pub files_copied: u64,
    pub duration_micros: i64,
    pub manifest_path: PathBuf,
}

pub async fn backup_cmd(data_dir: &Path, backup_dir: &Path) -> Result<BackupSummary> {
    let start = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_micros() as i64)
        .unwrap_or(0);

    tokio::fs::create_dir_all(backup_dir).await?;

    let manifest_path = backup_dir.join("storage-manifest.json");

    let mut files_copied = 0u64;
    let mut bytes_copied = 0u64;

    if tokio::fs::try_exists(data_dir).await.unwrap_or(false) {
        let mut entries = tokio::fs::read_dir(data_dir).await?;
        while let Some(entry) = entries.next_entry().await? {
            let src = entry.path();
            if src.is_dir() {
                let rel = src.strip_prefix(data_dir).unwrap();
                let dst = backup_dir.join(rel);
                tokio::fs::create_dir_all(&dst).await?;

                let mut sub_entries = tokio::fs::read_dir(&src).await?;
                while let Some(sub) = sub_entries.next_entry().await? {
                    let sub_src = sub.path();
                    if sub_src.is_file() {
                        let sub_rel = sub_src.strip_prefix(data_dir).unwrap();
                        let sub_dst = backup_dir.join(sub_rel);
                        tokio::fs::create_dir_all(sub_dst.parent().unwrap()).await?;
                        tokio::fs::copy(&sub_src, &sub_dst).await?;
                        let meta = tokio::fs::metadata(&sub_src).await?;
                        bytes_copied += meta.len();
                        files_copied += 1;
                    }
                }
            } else if src.is_file() {
                let rel = src.strip_prefix(data_dir).unwrap();
                let dst = backup_dir.join(rel);
                tokio::fs::copy(&src, &dst).await?;
                let meta = tokio::fs::metadata(&src).await?;
                bytes_copied += meta.len();
                files_copied += 1;
            }
        }
    }

    let manifest = serde_json::json!({
        "backup_time_micros": start,
        "source": data_dir.to_string_lossy(),
        "files_copied": files_copied,
        "bytes_copied": bytes_copied,
    });
    let manifest_bytes = serde_json::to_vec_pretty(&manifest).map_err(|e| {
        WabiError::InternalInvariantViolated {
            invariant: format!("manifest serialization failed: {e}"),
        }
    })?;
    tokio::fs::write(&manifest_path, &manifest_bytes).await?;

    let end = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_micros() as i64)
        .unwrap_or(0);

    Ok(BackupSummary {
        bytes_copied,
        files_copied,
        duration_micros: end - start,
        manifest_path,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn empty_data_dir_backup_succeeds() {
        let data_dir = tempdir().unwrap();
        let backup_dir = tempdir().unwrap();
        let summary = backup_cmd(data_dir.path(), backup_dir.path()).await.unwrap();
        assert_eq!(summary.files_copied, 0);
        assert_eq!(summary.bytes_copied, 0);
        assert!(summary.manifest_path.exists());
    }

    #[tokio::test]
    async fn populated_dir_backup_copies_files() {
        let data_dir = tempdir().unwrap();
        tokio::fs::write(data_dir.path().join("file1.bin"), b"hello").await.unwrap();
        tokio::fs::write(data_dir.path().join("file2.bin"), b"world").await.unwrap();

        let backup_dir = tempdir().unwrap();
        let summary = backup_cmd(data_dir.path(), backup_dir.path()).await.unwrap();
        assert_eq!(summary.files_copied, 2);
        assert_eq!(summary.bytes_copied, 10);
        assert!(backup_dir.path().join("file1.bin").exists());
        assert!(backup_dir.path().join("file2.bin").exists());
        assert!(backup_dir.path().join("storage-manifest.json").exists());
    }

    #[tokio::test]
    async fn re_run_is_idempotent() {
        let data_dir = tempdir().unwrap();
        tokio::fs::write(data_dir.path().join("data.bin"), b"test").await.unwrap();

        let backup_dir = tempdir().unwrap();

        let s1 = backup_cmd(data_dir.path(), backup_dir.path()).await.unwrap();
        assert_eq!(s1.files_copied, 1);

        let s2 = backup_cmd(data_dir.path(), backup_dir.path()).await.unwrap();
        assert_eq!(s2.files_copied, 1);
        assert_eq!(s2.bytes_copied, 4);
    }
}
