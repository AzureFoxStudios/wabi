//! Exact channel-retention sidecar.
//!
//! WabiDB's current RetentionPolicy stores whole days, while Wabi supports
//! sub-day and session-only choices such as `1h` and `live`. Keep the exact
//! operator choice in a small sidecar so restarts never silently turn a Live
//! or short-lived channel into durable/forever history.

use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::PathBuf, sync::{Mutex, OnceLock}};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RetentionOverrides {
    #[serde(default)]
    channels: HashMap<String, String>,
}

fn lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn path(data_dir: &str) -> PathBuf {
    PathBuf::from(data_dir).join("channel_retention.json")
}

fn read_unlocked(data_dir: &str) -> RetentionOverrides {
    std::fs::read(path(data_dir))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn write_unlocked(data_dir: &str, data: &RetentionOverrides) -> anyhow::Result<()> {
    use std::io::Write;
    let path = path(data_dir);
    let parent = path.parent().ok_or_else(|| anyhow::anyhow!("retention path has no parent"))?;
    std::fs::create_dir_all(parent)?;
    let bytes = serde_json::to_vec_pretty(data)?;
    let temporary = parent.join(format!(".channel-retention-{}.tmp", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    let result = (|| -> anyhow::Result<()> {
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, &path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

pub fn set(data_dir: &str, channel_id: &str, label: &str) -> anyhow::Result<()> {
    let _guard = lock().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut data = read_unlocked(data_dir);
    data.channels.insert(channel_id.to_string(), label.to_string());
    write_unlocked(data_dir, &data)
}

pub fn remove(data_dir: &str, channel_id: &str) -> anyhow::Result<()> {
    let _guard = lock().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut data = read_unlocked(data_dir);
    data.channels.remove(channel_id);
    write_unlocked(data_dir, &data)
}

pub fn label(data_dir: &str, channel_id: &str) -> Option<String> {
    let _guard = lock().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    read_unlocked(data_dir).channels.get(channel_id).cloned()
}

pub fn all(data_dir: &str) -> HashMap<String, String> {
    let _guard = lock().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    read_unlocked(data_dir).channels
}

/// Milliseconds for timed labels. `live` and `forever` intentionally return
/// None because they are distinct modes, not "no configured timer" aliases.
pub fn timed_ms(label: &str) -> Option<u64> {
    let normalized = label.trim().to_ascii_lowercase();
    if matches!(normalized.as_str(), "live" | "forever" | "never" | "off") {
        return None;
    }
    let split = normalized.find(|c: char| c.is_ascii_alphabetic()).unwrap_or(normalized.len());
    let (number, unit) = normalized.split_at(split);
    let amount = number.parse::<u64>().ok()?;
    let multiplier = match unit {
        "s" | "sec" | "secs" | "second" | "seconds" => 1_000,
        "m" | "min" | "mins" | "minute" | "minutes" => 60_000,
        "h" | "hr" | "hrs" | "hour" | "hours" => 3_600_000,
        "d" | "day" | "days" => 86_400_000,
        _ => return None,
    };
    Some(amount.saturating_mul(multiplier))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_modes_survive_reload() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        set(root, "live-room", "live").unwrap();
        set(root, "short-room", "1h").unwrap();
        assert_eq!(label(root, "live-room").as_deref(), Some("live"));
        assert_eq!(label(root, "short-room").as_deref(), Some("1h"));
        assert_eq!(timed_ms("1h"), Some(3_600_000));
        assert_eq!(timed_ms("live"), None);
    }
}
