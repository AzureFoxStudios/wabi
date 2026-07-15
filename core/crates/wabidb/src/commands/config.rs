use std::path::PathBuf;

use crate::error::{Result, WabiError};

pub struct WabiDbConfig {
    pub data_dir: PathBuf,
    pub segment_size_bytes: u64,
    pub commit_batch_size: u32,
    pub commit_batch_age_micros: u64,
    pub max_payload_len: u32,
    pub snapshot_interval_events: u64,
    pub snapshot_interval_seconds: u64,
    pub blob_max_size: u64,
    pub backpressure_timeout_ms: u64,
    pub subscriber_data_channel_capacity: usize,
    pub dispatcher_channel_capacity: usize,
    pub prekey_pool_top_up_threshold: u32,
    pub max_skipped_keys: u32,
}

impl Default for WabiDbConfig {
    fn default() -> Self {
        Self {
            data_dir: PathBuf::from("/var/lib/wabidb"),
            segment_size_bytes: 64 * 1024 * 1024,
            commit_batch_size: 10,
            commit_batch_age_micros: 50_000,
            max_payload_len: 16 * 1024 * 1024,
            snapshot_interval_events: 10_000,
            snapshot_interval_seconds: 86400,
            blob_max_size: 256 * 1024 * 1024,
            backpressure_timeout_ms: 5000,
            subscriber_data_channel_capacity: 256,
            dispatcher_channel_capacity: 1024,
            prekey_pool_top_up_threshold: 20,
            max_skipped_keys: 1000,
        }
    }
}

impl WabiDbConfig {
    pub fn load_from_file(path: &std::path::Path) -> Result<Self> {
        let contents = std::fs::read_to_string(path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                WabiError::NotFound {
                    what: format!("config file not found: {}", path.display()),
                }
            } else {
                WabiError::Io(e)
            }
        })?;

        let parsed: toml::Value = contents.parse().map_err(|e| WabiError::Validation {
            command: "load_config".into(),
            reason: format!("invalid TOML: {e}"),
        })?;

        let config = Self::default();

        let data_dir = parsed
            .get("data_dir")
            .and_then(|v| v.as_str())
            .map(PathBuf::from)
            .unwrap_or(config.data_dir);

        Ok(Self { data_dir, ..config })
    }

    pub fn validate(&self) -> Result<()> {
        if self.data_dir.as_os_str().is_empty() {
            return Err(WabiError::Validation {
                command: "validate_config".into(),
                reason: "data_dir must not be empty".into(),
            });
        }
        if self.segment_size_bytes == 0 {
            return Err(WabiError::Validation {
                command: "validate_config".into(),
                reason: "segment_size_bytes must be > 0".into(),
            });
        }
        if self.commit_batch_size == 0 {
            return Err(WabiError::Validation {
                command: "validate_config".into(),
                reason: "commit_batch_size must be > 0".into(),
            });
        }
        if self.max_payload_len > 64 * 1024 * 1024 {
            return Err(WabiError::Validation {
                command: "validate_config".into(),
                reason: "max_payload_len must not exceed 64 MiB".into(),
            });
        }
        if self.backpressure_timeout_ms == 0 {
            return Err(WabiError::Validation {
                command: "validate_config".into(),
                reason: "backpressure_timeout_ms must be > 0".into(),
            });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::WabiError;
    use tempfile::tempdir;

    #[test]
    fn default_config_is_valid() {
        let config = WabiDbConfig::default();
        assert!(config.validate().is_ok());
    }

    #[test]
    fn load_valid_config_file() {
        let dir = tempdir().unwrap();
        let config_path = dir.path().join("wabidb.toml");
        std::fs::write(
            &config_path,
            r#"
data_dir = "/tmp/wabidb"
"#,
        )
        .unwrap();

        let config = WabiDbConfig::load_from_file(&config_path).unwrap();
        assert_eq!(config.data_dir, PathBuf::from("/tmp/wabidb"));
    }

    #[test]
    fn load_missing_fields_use_defaults() {
        let dir = tempdir().unwrap();
        let config_path = dir.path().join("empty.toml");
        std::fs::write(&config_path, "# empty config\n").unwrap();

        let config = WabiDbConfig::load_from_file(&config_path).unwrap();
        assert_eq!(config.segment_size_bytes, 64 * 1024 * 1024);
        assert_eq!(config.commit_batch_size, 10);
    }

    #[test]
    fn validate_invalid_segment_size() {
        let mut config = WabiDbConfig::default();
        config.segment_size_bytes = 0;
        let err = config.validate().unwrap_err();
        assert!(matches!(err, WabiError::Validation { .. }));
    }

    #[test]
    fn validate_invalid_batch_size() {
        let mut config = WabiDbConfig::default();
        config.commit_batch_size = 0;
        let err = config.validate().unwrap_err();
        assert!(matches!(err, WabiError::Validation { .. }));
    }
}
