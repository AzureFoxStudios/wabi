use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{Result, WabiError};
use crate::storage::fsync::fsync_dir;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestBackupResult {
    pub manifest_size_bytes: u64,
    pub backup_path: String,
}

pub async fn backup_manifest(data_dir: &Path, backup_dir: &Path) -> Result<ManifestBackupResult> {
    let manifest_path = data_dir.join("storage-manifest.json");
    if !tokio::fs::try_exists(&manifest_path).await.unwrap_or(false) {
        return Err(WabiError::NotFound {
            what: format!("storage-manifest.json in {}", data_dir.display()),
        });
    }

    tokio::fs::create_dir_all(backup_dir).await?;

    let backup_path = backup_dir.join("storage-manifest.json");
    tokio::fs::copy(&manifest_path, &backup_path).await?;

    fsync_dir(backup_dir).await?;

    let manifest_size = tokio::fs::metadata(&backup_path).await?.len();

    Ok(ManifestBackupResult {
        manifest_size_bytes: manifest_size,
        backup_path: backup_path.to_string_lossy().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn backup_to_new_dir() {
        let data_dir = tempdir().unwrap();
        let backup_dir = tempdir().unwrap();

        tokio::fs::write(data_dir.path().join("storage-manifest.json"), b"{\"version\":1}")
            .await
            .unwrap();

        let result = backup_manifest(data_dir.path(), backup_dir.path())
            .await
            .unwrap();
        assert!(result.manifest_size_bytes > 0);

        let backed_up = tokio::fs::read_to_string(backup_dir.path().join("storage-manifest.json"))
            .await
            .unwrap();
        assert_eq!(backed_up, "{\"version\":1}");
    }

    #[tokio::test]
    async fn backup_overwrites_existing() {
        let data_dir = tempdir().unwrap();
        let backup_dir = tempdir().unwrap();

        tokio::fs::write(data_dir.path().join("storage-manifest.json"), b"{\"version\":2}")
            .await
            .unwrap();

        // First backup
        backup_manifest(data_dir.path(), backup_dir.path())
            .await
            .unwrap();

        // Update manifest
        tokio::fs::write(data_dir.path().join("storage-manifest.json"), b"{\"version\":3}")
            .await
            .unwrap();

        // Second backup (overwrite)
        let result = backup_manifest(data_dir.path(), backup_dir.path())
            .await
            .unwrap();
        assert!(result.manifest_size_bytes > 0);

        let backed_up = tokio::fs::read_to_string(backup_dir.path().join("storage-manifest.json"))
            .await
            .unwrap();
        assert_eq!(backed_up, "{\"version\":3}");
    }

    #[tokio::test]
    async fn backup_missing_manifest_returns_error() {
        let data_dir = tempdir().unwrap();
        let backup_dir = tempdir().unwrap();
        let err = backup_manifest(data_dir.path(), backup_dir.path())
            .await
            .unwrap_err();
        assert!(matches!(err, WabiError::NotFound { .. }));
    }
}
