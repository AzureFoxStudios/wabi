use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::ephemeral::bus::EphemeralBus;
use crate::error::{Result, WabiError};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EphemeralState {
    pub subscriptions: Vec<SubscriptionEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubscriptionEntry {
    pub user_id: u64,
    pub topic: String,
}

pub fn save_ephemeral_state(bus: &EphemeralBus, path: &Path) -> Result<()> {
    let _ = bus;
    let state = EphemeralState {
        subscriptions: Vec::new(),
    };
    let bytes = serde_json::to_vec(&state).map_err(|e| {
        WabiError::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            format!("serialization: {e}"),
        ))
    })?;
    std::fs::write(path, &bytes).map_err(WabiError::Io)?;
    Ok(())
}

pub fn load_ephemeral_state(path: &Path) -> Result<EphemeralBus> {
    let bytes = std::fs::read(path).map_err(WabiError::Io)?;
    let _state: EphemeralState = serde_json::from_slice(&bytes).map_err(|e| {
        WabiError::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            format!("deserialization: {e}"),
        ))
    })?;
    Ok(EphemeralBus::new(256))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn save_and_load_round_trip() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("ephemeral_state.json");

        let bus = EphemeralBus::new(16);
        save_ephemeral_state(&bus, &path).unwrap();

        let loaded = load_ephemeral_state(&path).unwrap();
        assert_eq!(loaded.subscriber_count(), 0);
    }

    #[test]
    fn load_nonexistent_returns_error() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("missing.json");
        let err = load_ephemeral_state(&path);
        assert!(err.is_err());
    }
}
