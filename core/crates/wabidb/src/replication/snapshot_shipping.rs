use std::path::Path;

use crate::error::{Result, WabiError};

#[derive(Clone)]
pub struct SnapshotShipLog {
    pub snapshot_path: String,
    pub peer_endpoint: String,
    pub success: bool,
}

static SHIP_LOG: std::sync::LazyLock<std::sync::Mutex<Vec<SnapshotShipLog>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(Vec::new()));

pub fn clear_ship_log() {
    SHIP_LOG.lock().unwrap().clear();
}

pub fn get_ship_log() -> Vec<SnapshotShipLog> {
    SHIP_LOG.lock().unwrap().clone()
}

pub fn ship_snapshot(snapshot_path: &Path, peer_endpoint: &str) -> Result<()> {
    if !snapshot_path.exists() {
        return Err(WabiError::NotFound {
            what: format!("snapshot not found: {}", snapshot_path.display()),
        });
    }

    SHIP_LOG.lock().unwrap().push(SnapshotShipLog {
        snapshot_path: snapshot_path.to_string_lossy().to_string(),
        peer_endpoint: peer_endpoint.to_string(),
        success: true,
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::WabiError;
    use tempfile::tempdir;

    #[test]
    fn ship_success_recorded_in_log() {
        let dir = tempdir().unwrap();
        let snap_path = dir.path().join("snapshot.bin");
        std::fs::write(&snap_path, b"snapshot data").unwrap();

        let result = ship_snapshot(&snap_path, "http://peer:8080");
        assert!(result.is_ok());
    }

    #[test]
    fn ship_fails_on_missing_snapshot() {
        let dir = tempdir().unwrap();
        let missing = dir.path().join("nonexistent.bin");

        let err = ship_snapshot(&missing, "http://peer:8080").unwrap_err();
        assert!(matches!(err, WabiError::NotFound { .. }));
    }

    #[test]
    fn multiple_ships_append_log() {
        let dir = tempdir().unwrap();

        let snap1 = dir.path().join("snap1.bin");
        let snap2 = dir.path().join("snap2.bin");
        std::fs::write(&snap1, b"data1").unwrap();
        std::fs::write(&snap2, b"data2").unwrap();

        assert!(ship_snapshot(&snap1, "http://peer1").is_ok());
        assert!(ship_snapshot(&snap2, "http://peer2").is_ok());
    }
}
