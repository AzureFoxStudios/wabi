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
    channels: HashMap<String, String>,
}

fn lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn path(data_dir: &str) -> PathBuf { PathBuf::from(data_dir).join("channel_retention.json") }

const RECOVERY_ERROR: &str = "Retention policy could not be read. Preserve channel_retention.json and restore it from a matching backup; do not delete it to resume startup.";

pub(crate) fn canonical_label(label: &str) -> anyhow::Result<String> {
    let label = label.trim().to_ascii_lowercase();
    match label.as_str() {
        "live" | "forever" => Ok(label),
        "never" | "off" => Ok("forever".into()),
        _ if timed_ms(&label).is_some_and(|ms| ms > 0 && ms <= 365 * 86_400_000) => Ok(label),
        _ => anyhow::bail!(RECOVERY_ERROR),
    }
}

fn read_unlocked(data_dir: &str) -> anyhow::Result<RetentionOverrides> {
    let bytes = match std::fs::read(path(data_dir)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(RetentionOverrides::default()),
        Err(_) => anyhow::bail!(RECOVERY_ERROR),
    };
    let mut data: RetentionOverrides = serde_json::from_slice(&bytes)
        .map_err(|_| anyhow::anyhow!(RECOVERY_ERROR))?;
    for (channel, label) in &mut data.channels {
        anyhow::ensure!(!channel.trim().is_empty(), RECOVERY_ERROR);
        *label = canonical_label(label)?;
    }
    Ok(data)
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
    let mut data = read_unlocked(data_dir)?;
    data.channels.insert(channel_id.to_string(), canonical_label(label)?);
    write_unlocked(data_dir, &data)
}

pub fn remove(data_dir: &str, channel_id: &str) -> anyhow::Result<()> {
    let _guard = lock().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut data = read_unlocked(data_dir)?;
    data.channels.remove(channel_id);
    write_unlocked(data_dir, &data)
}

pub fn label(data_dir: &str, channel_id: &str) -> anyhow::Result<Option<String>> {
    let _guard = lock().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    Ok(read_unlocked(data_dir)?.channels.get(channel_id).cloned())
}

pub fn all(data_dir: &str) -> anyhow::Result<HashMap<String, String>> {
    let _guard = lock().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    Ok(read_unlocked(data_dir)?.channels)
}

/// Caller must hold retention_policy_lock through selection and deletion.
/// An exact Live/Forever choice overrides even a stale whole-day mirror.
pub async fn channel_expiry_micros(state: &crate::state::AppState, channel_id: &str) -> anyhow::Result<Option<i64>> {
    if let Some(label) = state.channel_auto_delete_label.read().await.get(channel_id) {
        return Ok(effective_micros(timed_ms(label), None));
    }
    use wabidb::engine::wabi_store::WabiStore;
    Ok(match state.wdb.get_channel_retention(channel_id).await? {
        Some(policy) if policy.days > 0 => Some(policy.days as i64 * 86_400_000_000),
        Some(_) => None,
        None => Some(86_400_000_000),
    })
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_modes_survive_reload() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        set(root, "live-room", "live").unwrap();
        set(root, "short-room", "1h").unwrap();
        assert_eq!(label(root, "live-room").unwrap().as_deref(), Some("live"));
        assert_eq!(label(root, "short-room").unwrap().as_deref(), Some("1h"));
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

    #[test]
    fn damaged_or_unknown_policy_is_preserved_and_never_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        for bytes in [b"{".as_slice(), b"{}", b"null", b"{\"channels\":{\"room\":\"unknown\"}}", b"{\"channels\":{\"room\":\"0s\"}}"] {
            std::fs::write(path(root), bytes).unwrap();
            assert!(all(root).is_err());
            assert!(label(root, "room").is_err());
            assert!(set(root, "new", "forever").is_err());
            assert!(remove(root, "room").is_err());
            assert_eq!(std::fs::read(path(root)).unwrap(), bytes);
        }
    }

    #[test]
    fn unreadable_file_fails_but_missing_file_remains_a_fresh_install() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        assert!(all(root).unwrap().is_empty());
        std::fs::create_dir(path(root)).unwrap();
        assert!(all(root).is_err());
        assert!(set(root, "room", "live").is_err());
        assert!(path(root).is_dir());
    }

}
