//! Local state: global credentials, per-folder link, and the sync baseline.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Name of the per-folder link file written by `wabi-sync link`.
pub const LINK_FILE: &str = ".wabi-sync.json";
/// Directory (inside the synced folder) holding mutable sync state.
pub const STATE_DIR: &str = ".wabi-sync";

fn global_config_path() -> anyhow::Result<PathBuf> {
    let dir = if let Ok(x) = std::env::var("XDG_CONFIG_HOME") {
        PathBuf::from(x)
    } else {
        let home = std::env::var("HOME")
            .map_err(|_| anyhow::anyhow!("HOME not set; set XDG_CONFIG_HOME"))?;
        PathBuf::from(home).join(".config")
    };
    Ok(dir.join("wabi-sync").join("config.json"))
}

/// Global credentials (`wabi-sync login`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlobalConfig {
    pub server_url: String,
    /// A connect token (`wblore_…`) or a full user JWT.
    pub token: String,
}

impl GlobalConfig {
    pub fn load() -> anyhow::Result<Self> {
        let path = global_config_path()?;
        let raw = std::fs::read_to_string(&path)
            .map_err(|_| anyhow::anyhow!("not logged in — run `wabi-sync login <serverUrl>` (config at {})", path.display()))?;
        Ok(serde_json::from_str(&raw)?)
    }

    pub fn save(&self) -> anyhow::Result<()> {
        let path = global_config_path()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, serde_json::to_string_pretty(self)?)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        }
        Ok(())
    }
}

/// The per-folder link file (`.wabi-sync.json`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkConfig {
    pub server_url: String,
    /// Numeric channel id (canonical form; hex `ch_…` ids are normalized on link).
    pub channel_id: i64,
}

impl LinkConfig {
    pub fn load(folder: &Path) -> anyhow::Result<Self> {
        let path = folder.join(LINK_FILE);
        let raw = std::fs::read_to_string(&path).map_err(|_| {
            anyhow::anyhow!(
                "folder is not linked — run `wabi-sync link <channel> <folder>` (expected {})",
                path.display()
            )
        })?;
        Ok(serde_json::from_str(&raw)?)
    }

    pub fn save(&self, folder: &Path) -> anyhow::Result<()> {
        std::fs::write(folder.join(LINK_FILE), serde_json::to_string_pretty(self)?)?;
        Ok(())
    }

    /// Accept `ch_<hex>`, `0x<hex>`, or decimal; normalize to the decimal id.
    pub fn normalize_channel_id(input: &str) -> anyhow::Result<i64> {
        let input = input.trim();
        if let Some(hex) = input.strip_prefix("ch_") {
            return i64::from_str_radix(hex, 16)
                .map_err(|_| anyhow::anyhow!("invalid channel id '{input}'"));
        }
        if let Some(hex) = input.strip_prefix("0x") {
            return i64::from_str_radix(hex, 16)
                .map_err(|_| anyhow::anyhow!("invalid channel id '{input}'"));
        }
        input
            .parse::<i64>()
            .map_err(|_| anyhow::anyhow!("invalid channel id '{input}'"))
    }
}

/// Mutable sync state: the last-synced etag per path (the three-way baseline)
/// plus the change-feed cursor. None = the file did not exist remotely at
/// last sync.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SyncState {
    pub cursor: u64,
    pub baselines: BTreeMap<String, Option<String>>,
}

impl SyncState {
    fn path_for(folder: &Path) -> PathBuf {
        folder.join(STATE_DIR).join("state.json")
    }

    pub fn load(folder: &Path) -> anyhow::Result<Self> {
        match std::fs::read_to_string(Self::path_for(folder)) {
            Ok(raw) => Ok(serde_json::from_str(&raw)?),
            Err(_) => Ok(Self::default()),
        }
    }

    pub fn save(&self, folder: &Path) -> anyhow::Result<()> {
        let path = Self::path_for(folder);
        std::fs::create_dir_all(path.parent().unwrap_or(folder))?;
        std::fs::write(&path, serde_json::to_string_pretty(self)?)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_id_normalization() {
        assert_eq!(LinkConfig::normalize_channel_id("ch_e1").unwrap(), 225);
        assert_eq!(LinkConfig::normalize_channel_id("0xe1").unwrap(), 225);
        assert_eq!(LinkConfig::normalize_channel_id("225").unwrap(), 225);
        assert!(LinkConfig::normalize_channel_id("ch_zzz").is_err());
        assert!(LinkConfig::normalize_channel_id("nope").is_err());
    }

    #[test]
    fn state_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let mut state = SyncState::default();
        state.cursor = 42;
        state.baselines.insert("a.txt".into(), Some("etag-a".into()));
        state.baselines.insert("b.txt".into(), None);
        state.save(dir.path()).unwrap();
        let loaded = SyncState::load(dir.path()).unwrap();
        assert_eq!(loaded.cursor, 42);
        assert_eq!(loaded.baselines.get("a.txt"), Some(&Some("etag-a".into())));
        assert_eq!(loaded.baselines.get("b.txt"), Some(&None));
    }
}
