use std::path::Path;

use crate::error::{Result, WabiError};

use super::data_backup::BackupManifest;

#[derive(Debug, Clone)]
pub struct BackupVerifyReport {
    pub ok: bool,
    pub errors: Vec<String>,
    pub files_checked: usize,
    pub files_matched: usize,
}

pub async fn verify_backup(backup_dir: &Path) -> Result<BackupVerifyReport> {
    let bm_path = backup_dir.join("backup-manifest.json");
    if !tokio::fs::try_exists(&bm_path).await.unwrap_or(false) {
        return Ok(BackupVerifyReport {
            ok: false,
            errors: vec!["missing backup-manifest.json".into()],
            files_checked: 0,
            files_matched: 0,
        });
    }

    let bm_raw = tokio::fs::read_to_string(&bm_path).await?;
    let manifest: BackupManifest = serde_json::from_str(&bm_raw).map_err(|e| WabiError::Corrupt {
        location: "backup-manifest.json".into(),
        detail: format!("invalid JSON: {e}"),
    })?;

    let mut errors = Vec::new();
    let mut files_matched = 0usize;

    for entry in &manifest.entries {
        let file_path = backup_dir.join(&entry.relative_path);
        if !tokio::fs::try_exists(&file_path).await.unwrap_or(false) {
            errors.push(format!("missing file: {}", entry.relative_path));
            continue;
        }

        let data = match tokio::fs::read(&file_path).await {
            Ok(d) => d,
            Err(e) => {
                errors.push(format!("cannot read {}: {e}", entry.relative_path));
                continue;
            }
        };

        let actual_hash = blake3::hash(&data).to_hex().to_string();
        if actual_hash != entry.blake3_hash {
            errors.push(format!(
                "hash mismatch for {}: expected {}, got {}",
                entry.relative_path, entry.blake3_hash, actual_hash
            ));
            continue;
        }

        files_matched += 1;
    }

    Ok(BackupVerifyReport {
        ok: errors.is_empty(),
        errors,
        files_checked: manifest.entries.len(),
        files_matched,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::retention::data_backup::{backup_data, DataBackupEntry, BackupManifest};
    use tempfile::tempdir;

    #[tokio::test]
    async fn clean_backup_passes() {
        let data_dir = tempdir().unwrap();
        let backup_dir = tempdir().unwrap();

        tokio::fs::write(data_dir.path().join("storage-manifest.json"), b"{}")
            .await
            .unwrap();

        backup_data(data_dir.path(), backup_dir.path()).await.unwrap();
        let report = verify_backup(backup_dir.path()).await.unwrap();
        assert!(report.ok, "expected ok, got errors: {:?}", report.errors);
        assert!(report.errors.is_empty());
        assert_eq!(report.files_checked, report.files_matched);
    }

    #[tokio::test]
    async fn missing_file_reported() {
        let backup_dir = tempdir().unwrap();

        let entry = DataBackupEntry {
            relative_path: "streams/ch_test/events/00000001.wseg".into(),
            size: 100,
            blake3_hash: "abcdef".into(),
        };
        let manifest = BackupManifest {
            format_version: 1,
            created_at_micros: 0,
            entries: vec![entry],
        };
        let bm_json = serde_json::to_string_pretty(&manifest).unwrap();
        tokio::fs::write(backup_dir.path().join("backup-manifest.json"), &bm_json)
            .await
            .unwrap();

        let report = verify_backup(backup_dir.path()).await.unwrap();
        assert!(!report.ok);
        assert!(report.errors.iter().any(|e| e.contains("missing")));
    }

    #[tokio::test]
    async fn hash_mismatch_reported() {
        let backup_dir = tempdir().unwrap();

        let seg_dir = backup_dir.path().join("streams").join("ch_test").join("events");
        tokio::fs::create_dir_all(&seg_dir).await.unwrap();
        tokio::fs::write(seg_dir.join("00000001.wseg"), b"some data").await.unwrap();

        let data = b"some data";
        let _hash = blake3::hash(data).to_hex().to_string();

        let wrong_entry = DataBackupEntry {
            relative_path: "streams/ch_test/events/00000001.wseg".into(),
            size: 9,
            blake3_hash: "wronghash".into(),
        };
        let manifest = BackupManifest {
            format_version: 1,
            created_at_micros: 0,
            entries: vec![wrong_entry],
        };
        let bm_json = serde_json::to_string_pretty(&manifest).unwrap();
        tokio::fs::write(backup_dir.path().join("backup-manifest.json"), &bm_json)
            .await
            .unwrap();

        let report = verify_backup(backup_dir.path()).await.unwrap();
        assert!(!report.ok);
        assert!(report.errors.iter().any(|e| e.contains("hash mismatch")));
    }
}
