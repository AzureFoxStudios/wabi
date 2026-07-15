use crate::error::{Result, WabiError};

#[derive(Debug, Clone)]
pub struct ReplicationConfig {
    pub peer_endpoint: String,
    pub sync_interval_micros: u64,
    pub max_lag_micros: u64,
}

impl ReplicationConfig {
    pub fn new(peer_endpoint: &str, sync_interval_micros: u64, max_lag_micros: u64) -> Self {
        Self {
            peer_endpoint: peer_endpoint.to_string(),
            sync_interval_micros,
            max_lag_micros,
        }
    }

    pub fn validate(&self) -> Result<()> {
        if self.peer_endpoint.is_empty() {
            return Err(WabiError::Validation {
                command: "replication_config".into(),
                reason: "peer_endpoint must not be empty".into(),
            });
        }
        if self.sync_interval_micros == 0 {
            return Err(WabiError::Validation {
                command: "replication_config".into(),
                reason: "sync_interval_micros must be > 0".into(),
            });
        }
        if self.sync_interval_micros > 3_600_000_000 {
            return Err(WabiError::Validation {
                command: "replication_config".into(),
                reason: "sync_interval_micros must not exceed 1 hour".into(),
            });
        }
        if self.max_lag_micros == 0 {
            return Err(WabiError::Validation {
                command: "replication_config".into(),
                reason: "max_lag_micros must be > 0".into(),
            });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_config_succeeds() {
        let config = ReplicationConfig::new("http://peer:8080", 1_000_000, 5_000_000);
        assert!(config.validate().is_ok());
    }

    #[test]
    fn empty_peer_rejected() {
        let config = ReplicationConfig::new("", 1_000_000, 5_000_000);
        let err = config.validate().unwrap_err();
        assert!(matches!(err, WabiError::Validation { .. }));
    }

    #[test]
    fn zero_sync_interval_rejected() {
        let config = ReplicationConfig::new("http://peer:8080", 0, 5_000_000);
        let err = config.validate().unwrap_err();
        assert!(matches!(err, WabiError::Validation { .. }));
    }

    #[test]
    fn zero_max_lag_rejected() {
        let config = ReplicationConfig::new("http://peer:8080", 1_000_000, 0);
        let err = config.validate().unwrap_err();
        assert!(matches!(err, WabiError::Validation { .. }));
    }
}
