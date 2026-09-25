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
    /// A policy change affects messages created from this boundary onward.
    /// Old files have no epochs; their one current label applies from time 0.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    epochs: HashMap<String, Vec<RetentionEpoch>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RetentionEpoch {
    pub from_micros: i64,
    pub label: String,
}

fn lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn path(data_dir: &str) -> PathBuf { PathBuf::from(data_dir).join("channel_retention.json") }

const RECOVERY_ERROR: &str = "Retention policy could not be read. Preserve channel_retention.json and restore it from a matching backup; do not delete it to resume startup.";
const MAX_EPOCHS_PER_CHANNEL: usize = 2048;

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
    for (channel, epochs) in &mut data.epochs {
        anyhow::ensure!(!channel.trim().is_empty() && data.channels.contains_key(channel), RECOVERY_ERROR);
        anyhow::ensure!(!epochs.is_empty() && epochs[0].from_micros == 0, RECOVERY_ERROR);
        anyhow::ensure!(epochs.len() <= MAX_EPOCHS_PER_CHANNEL, RECOVERY_ERROR);
        let mut previous = -1;
        for epoch in epochs.iter_mut() {
            anyhow::ensure!(epoch.from_micros > previous, RECOVERY_ERROR);
            epoch.label = canonical_label(&epoch.label)?;
            previous = epoch.from_micros;
        }
        anyhow::ensure!(epochs.last().is_some_and(|epoch| Some(&epoch.label) == data.channels.get(channel)), RECOVERY_ERROR);
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
    set_with_previous(data_dir, channel_id, label, "24h")
}

/// `previous_label` is used only when a channel has no exact override yet.
/// Caller serializes this transition against message writes with
/// `retention_policy_lock`.
pub fn set_with_previous(data_dir: &str, channel_id: &str, label: &str, previous_label: &str) -> anyhow::Result<()> {
    set_at(data_dir, channel_id, label, previous_label, chrono::Utc::now().timestamp_micros())
}

fn set_at(data_dir: &str, channel_id: &str, label: &str, previous_label: &str, now_micros: i64) -> anyhow::Result<()> {
    let _guard = lock().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut data = read_unlocked(data_dir)?;
    anyhow::ensure!(!channel_id.trim().is_empty() && now_micros > 0, RECOVERY_ERROR);
    let label = canonical_label(label)?;
    let old = data.channels.get(channel_id).cloned().unwrap_or(canonical_label(previous_label)?);
    if old != label {
        let epochs = data.epochs.entry(channel_id.to_string()).or_insert_with(|| vec![RetentionEpoch {
            from_micros: 0, label: old,
        }]);
        anyhow::ensure!(epochs.len() < MAX_EPOCHS_PER_CHANNEL, "Retention history is full; remove older messages before changing this policy again");
        let boundary = now_micros.max(epochs.last().unwrap().from_micros.saturating_add(1));
        epochs.push(RetentionEpoch { from_micros: boundary, label: label.clone() });
    }
    data.channels.insert(channel_id.to_string(), label);
    write_unlocked(data_dir, &data)
}

/// Prune past generations that contain no active durable messages. The caller
/// holds the async policy lock, so no message can be written into a past epoch
/// while its indexed range is checked. Live generations are retained because
/// their session messages are not in the durable projection.
pub fn compact_empty_epochs(
    data_dir: &str,
    channel_id: &str,
    mut contains_messages: impl FnMut(i64, i64) -> anyhow::Result<bool>,
) -> anyhow::Result<usize> {
    let _guard = lock().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut data = read_unlocked(data_dir)?;
    let Some(epochs) = data.epochs.get_mut(channel_id) else { return Ok(0); };
    let mut removed = 0;
    let mut index = 0;
    while index + 1 < epochs.len() {
        if epochs[index].label == "live" {
            index += 1;
            continue;
        }
        let from = epochs[index].from_micros;
        let through = epochs[index + 1].from_micros.saturating_sub(1);
        if contains_messages(from, through)? {
            index += 1;
            continue;
        }
        if index == 0 { epochs[1].from_micros = 0; }
        epochs.remove(index);
        removed += 1;
    }
    if epochs.len() == 1 { data.epochs.remove(channel_id); }
    if removed > 0 { write_unlocked(data_dir, &data)?; }
    Ok(removed)
}

pub fn remove(data_dir: &str, channel_id: &str) -> anyhow::Result<()> {
    let _guard = lock().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut data = read_unlocked(data_dir)?;
    data.channels.remove(channel_id);
    data.epochs.remove(channel_id);
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

/// Full immutable policy history for one channel. `None` means that no exact
/// override exists and the legacy WabiDB/default policy remains in force.
pub fn epochs(data_dir: &str, channel_id: &str) -> anyhow::Result<Option<Vec<RetentionEpoch>>> {
    let _guard = lock().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let data = read_unlocked(data_dir)?;
    let Some(label) = data.channels.get(channel_id) else { return Ok(None); };
    Ok(Some(data.epochs.get(channel_id).cloned().unwrap_or_else(|| vec![RetentionEpoch {
        from_micros: 0, label: label.clone(),
    }])))
}

pub fn deadline_for_message(epochs: &[RetentionEpoch], created_at_micros: i64) -> Option<i64> {
    let label = epochs.iter().rev().find(|epoch| epoch.from_micros <= created_at_micros)?.label.as_str();
    timed_ms(label).map(|ms| created_at_micros.saturating_add((ms as i64).saturating_mul(1_000)))
}

/// Index bounds for each timed generation's expired messages. Untimed
/// generations never enter the query, even if they are older than the cutoff.
pub fn expired_ranges(epochs: &[RetentionEpoch], now_micros: i64) -> Vec<(i64, i64)> {
    epochs.iter().enumerate().filter_map(|(index, epoch)| {
        let duration = timed_ms(&epoch.label)? as i64 * 1_000;
        let end = epochs.get(index + 1).map_or(i64::MAX, |next| next.from_micros.saturating_sub(1));
        let through = end.min(now_micros.saturating_sub(duration));
        (through >= epoch.from_micros).then_some((epoch.from_micros, through))
    }).collect()
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

/// Sub-minute policies need a fast sweep. Longer policies continue through the
/// regular minute sweep so idle servers do not scan every channel each second.
pub fn fast_sweep_channels(data_dir: &str) -> anyhow::Result<Vec<String>> {
    let _guard = lock().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let data = read_unlocked(data_dir)?;
    Ok(data.channels.iter().filter_map(|(channel, current)| {
        let short = |label: &str| timed_ms(label).is_some_and(|ms| ms > 0 && ms <= 60_000);
        if short(current) || data.epochs.get(channel).is_some_and(|epochs| epochs.iter().any(|epoch| short(&epoch.label))) {
            Some(channel.clone())
        } else {
            None
        }
    }).collect())
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
    fn fast_sweep_includes_short_timers_and_excludes_long_or_disabled_channels() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        set_at(root, "five-seconds", "5s", "24h", 1_000_000).unwrap();
        set_at(root, "thirty-seconds", "30s", "24h", 1_000_000).unwrap();
        set_at(root, "one-minute", "1m", "24h", 1_000_000).unwrap();
        set_at(root, "five-minutes", "5m", "24h", 1_000_000).unwrap();
        set_at(root, "forever", "forever", "24h", 1_000_000).unwrap();
        set_at(root, "five-seconds", "forever", "24h", 2_000_000).unwrap();
        let mut fast = fast_sweep_channels(root).unwrap();
        fast.sort();
        assert_eq!(fast, ["five-seconds", "one-minute", "thirty-seconds"]);
    }

    #[test]
    fn policy_changes_only_affect_messages_created_after_each_boundary() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        set_at(root, "room", "forever", "24h", 1_000_000).unwrap();
        set_at(root, "room", "5s", "24h", 2_000_000).unwrap();
        set_at(root, "room", "1h", "24h", 4_000_000).unwrap();
        let timeline = epochs(root, "room").unwrap().unwrap();
        assert_eq!(deadline_for_message(&timeline, 1_500_000), None);
        assert_eq!(deadline_for_message(&timeline, 2_500_000), Some(7_500_000));
        assert_eq!(deadline_for_message(&timeline, 4_500_000), Some(3_604_500_000));
        assert_eq!(expired_ranges(&timeline, 8_000_000), vec![(2_000_000, 3_000_000)]);
        assert_eq!(epochs(root, "room").unwrap().unwrap(), timeline);
        set_at(root, "room", "1h", "24h", 5_000_000).unwrap();
        assert_eq!(epochs(root, "room").unwrap().unwrap(), timeline, "same-value saves do not move the boundary");
    }

    #[test]
    fn legacy_one_label_file_preserves_old_policy_when_first_changed() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        std::fs::write(path(root), br#"{"channels":{"room":"forever"}}"#).unwrap();
        set_at(root, "room", "5s", "24h", 10_000_000).unwrap();
        let epochs = epochs(root, "room").unwrap().unwrap();
        assert_eq!(epochs, [
            RetentionEpoch { from_micros: 0, label: "forever".into() },
            RetentionEpoch { from_micros: 10_000_000, label: "5s".into() },
        ]);
        assert_eq!(deadline_for_message(&epochs, 9_000_000), None);
        assert_eq!(deadline_for_message(&epochs, 11_000_000), Some(16_000_000));
        assert_eq!(expired_ranges(&epochs, 14_000_000), Vec::<(i64, i64)>::new());
        assert_eq!(expired_ranges(&epochs, 16_000_000), vec![(10_000_000, 11_000_000)]);
    }

    #[test]
    fn corrupt_epoch_history_fails_closed_without_overwriting_it() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        for bytes in [
            br#"{"channels":{"room":"5s"},"epochs":{"room":[{"fromMicros":1,"label":"5s"}]}}"#.as_slice(),
            br#"{"channels":{"room":"5s"},"epochs":{"room":[{"fromMicros":0,"label":"forever"}]}}"#,
            br#"{"channels":{"room":"5s"},"epochs":{"room":[{"fromMicros":0,"label":"forever"},{"fromMicros":0,"label":"5s"}]}}"#,
        ] {
            std::fs::write(path(root), bytes).unwrap();
            assert!(all(root).is_err());
            assert!(set(root, "room", "forever").is_err());
            assert_eq!(std::fs::read(path(root)).unwrap(), bytes);
        }
    }

    #[test]
    fn empty_past_epochs_compact_without_changing_retained_message_policy() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        std::fs::write(path(root), br#"{"channels":{"room":"forever"}}"#).unwrap();
        set_at(root, "room", "5s", "24h", 2_000_000).unwrap();
        set_at(root, "room", "1h", "24h", 3_000_000).unwrap();
        let removed = compact_empty_epochs(root, "room", |from, _| Ok(from == 0)).unwrap();
        assert_eq!(removed, 1);
        let timeline = epochs(root, "room").unwrap().unwrap();
        assert_eq!(timeline.len(), 2);
        assert_eq!(deadline_for_message(&timeline, 1_500_000), None);
        assert_eq!(deadline_for_message(&timeline, 3_500_000), Some(3_603_500_000));
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
