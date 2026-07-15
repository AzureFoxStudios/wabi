use std::path::Path;

use crate::error::{Result, WabiError};

pub async fn restore_cmd(backup_dir: &Path, target_dir: &Path, force: bool) -> Result<()> {
    if !tokio::fs::try_exists(backup_dir).await.unwrap_or(false) {
        return Err(WabiError::NotFound {
            what: format!("backup directory not found: {}", backup_dir.display()),
        });
    }

    if tokio::fs::try_exists(target_dir).await.unwrap_or(false) {
        let mut entries = tokio::fs::read_dir(target_dir).await?;
        if entries.next_entry().await?.is_some() && !force {
            return Err(WabiError::Validation {
                command: "restore".into(),
                reason: format!(
                    "target directory is not empty: {}. Use --force to override.",
                    target_dir.display()
                ),
            });
        }
    }

    tokio::fs::create_dir_all(target_dir).await?;

    let mut entries = tokio::fs::read_dir(backup_dir).await?;
    while let Some(entry) = entries.next_entry().await? {
        let src = entry.path();
        let rel = src.strip_prefix(backup_dir).unwrap();
        let dst = target_dir.join(rel);
        if src.is_dir() {
            tokio::fs::create_dir_all(&dst).await?;
            let mut sub = tokio::fs::read_dir(&src).await?;
            while let Some(sub_entry) = sub.next_entry().await? {
                let sub_src = sub_entry.path();
                if sub_src.is_file() {
                    let sub_rel = sub_src.strip_prefix(backup_dir).unwrap();
                    let sub_dst = target_dir.join(sub_rel);
                    tokio::fs::create_dir_all(sub_dst.parent().unwrap()).await?;
                    tokio::fs::copy(&sub_src, &sub_dst).await?;
                }
            }
        } else if src.is_file() && rel.to_str().map_or(false, |s| s != "storage-manifest.json") {
            let dst_parent = dst.parent().unwrap();
            tokio::fs::create_dir_all(dst_parent).await?;
            tokio::fs::copy(&src, &dst).await?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::WabiError;
    use tempfile::tempdir;

    #[tokio::test]
    async fn restore_empty_backup() {
        let backup_dir = tempdir().unwrap();
        let target_dir = tempdir().unwrap();
        restore_cmd(backup_dir.path(), target_dir.path(), false)
            .await
            .unwrap();
        assert!(target_dir.path().exists());
    }

    #[tokio::test]
    async fn restore_idempotent() {
        let backup_dir = tempdir().unwrap();
        tokio::fs::write(backup_dir.path().join("data.bin"), b"hello")
            .await
            .unwrap();

        let target_dir = tempdir().unwrap();
        restore_cmd(backup_dir.path(), target_dir.path(), false)
            .await
            .unwrap();
        assert!(target_dir.path().join("data.bin").exists());

        restore_cmd(backup_dir.path(), target_dir.path(), true)
            .await
            .unwrap();
        assert!(target_dir.path().join("data.bin").exists());
    }

    #[tokio::test]
    async fn refuse_non_empty_target() {
        let backup_dir = tempdir().unwrap();
        tokio::fs::write(backup_dir.path().join("data.bin"), b"hello")
            .await
            .unwrap();

        let target_dir = tempdir().unwrap();
        tokio::fs::write(target_dir.path().join("existing.txt"), b"existing")
            .await
            .unwrap();

        let err = restore_cmd(backup_dir.path(), target_dir.path(), false)
            .await
            .unwrap_err();
        assert!(matches!(err, WabiError::Validation { .. }));

        // With --force it should succeed
        restore_cmd(backup_dir.path(), target_dir.path(), true)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn missing_backup_dir_errors() {
        let backup_dir = tempdir().unwrap();
        let missing = backup_dir.path().join("nonexistent");
        let target_dir = tempdir().unwrap();
        let err = restore_cmd(&missing, target_dir.path(), false)
            .await
            .unwrap_err();
        assert!(matches!(err, WabiError::NotFound { .. }));
    }
}
