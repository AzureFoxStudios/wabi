//! Exact channel-retention sidecar.
//!
//! WabiDB's current RetentionPolicy stores whole days, while Wabi supports
//! sub-day and session-only choices such as `1h` and `live`. Keep the exact
//! operator choice in a small sidecar so restarts never silently turn a Live
//! or short-lived channel into durable/forever history.

use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::PathBuf, sync::{Arc, Mutex, OnceLock}};

use crate::state::AppState;

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

fn path(data_dir: &str) -> PathBuf { PathBuf::from(data_dir).join("channel_retention.json") }

fn read_unlocked(data_dir: &str) -> RetentionOverrides {
    std::fs::read(path(data_dir)).ok()
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
    { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    let mut file = options.open(&temporary)?;
    let result = (|| -> anyhow::Result<()> {
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, &path)?;
        Ok(())
    })();
    if result.is_err() { let _ = std::fs::remove_file(&temporary); }
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
    if matches!(normalized.as_str(), "live" | "forever" | "never" | "off") { return None; }
    let split = normalized.find(|c: char| c.is_ascii_alphabetic()).unwrap_or(normalized.len());
    let (number, unit) = normalized.split_at(split);
    let amount = number.parse::<u64>().ok()?;
    let multiplier = match unit {
        "ms" | "millisecond" | "milliseconds" => 1,
        "s" | "sec" | "secs" | "second" | "seconds" => 1_000,
        "m" | "min" | "mins" | "minute" | "minutes" => 60_000,
        "h" | "hr" | "hrs" | "hour" | "hours" => 3_600_000,
        "d" | "day" | "days" => 86_400_000,
        _ => return None,
    };
    Some(amount.saturating_mul(multiplier))
}

/// Convert the exact millisecond policy to the database timestamp unit before
/// combining it with the whole-day fallback. None means no timed expiry.
pub fn effective_micros(exact_ms: Option<u64>, fallback_micros: Option<i64>) -> Option<i64> {
    let exact = exact_ms.filter(|ms| *ms > 0)
        .map(|ms| i64::try_from(ms).unwrap_or(i64::MAX).saturating_mul(1_000));
    match (exact, fallback_micros) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (Some(a), None) => Some(a),
        (None, fallback) => fallback,
    }
}

/// Restore exact runtime labels/timers from the sidecar after AppState starts.
/// This deliberately does not rewrite WabiDB: it only rehydrates the richer
/// runtime representation that WabiDB's whole-day compatibility policy cannot hold.
pub fn hydrate_runtime(state: Arc<AppState>) {
    let overrides = all(&state.config.data_dir);
    if overrides.is_empty() { return; }
    tokio::spawn(async move {
        let mut labels = state.channel_auto_delete_label.write().await;
        let mut timers = state.channel_auto_delete_ms.write().await;
        for (channel_id, label) in overrides {
            labels.insert(channel_id.clone(), label.clone());
            if let Some(ms) = timed_ms(&label) { timers.insert(channel_id, ms); }
            else { timers.remove(&channel_id); }
        }
        tracing::info!(count = labels.len(), "rehydrated exact channel retention choices");
    });
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
        assert_eq!(timed_ms("1250ms"), Some(1_250));
        assert_eq!(timed_ms("live"), None);
    }
    #[test]
    fn exact_milliseconds_use_microseconds_without_thousandfold_extension() {
        let day = 86_400_000_000;
        assert_eq!(effective_micros(timed_ms("5s"), Some(day)), Some(5_000_000));
        assert_eq!(effective_micros(timed_ms("1h"), Some(day)), Some(3_600_000_000));
        assert_eq!(effective_micros(timed_ms("1250ms"), None), Some(1_250_000));
        assert_eq!(effective_micros(None, Some(day)), Some(day));
        assert_eq!(effective_micros(None, None), None);
        assert_eq!(effective_micros(Some(0), None), None);
        assert_eq!(effective_micros(Some(u64::MAX), None), Some(i64::MAX));
    }

}
