//! Where bots may post, and a record of what they did.
//!
//! Every bot chat post must answer a trigger: a recent message from a person,
//! in the same channel, that @-mentions the bot. Text a bot reads in one
//! channel therefore cannot make it post anywhere a person did not call it.
//! The owner can allow unprompted posts (for example scheduled summaries) in
//! specific channels; those exceptions live in `<data_dir>/bot_post_policy.json`.
//!
//! The audit log `<data_dir>/bot_audit.jsonl` is append-only, one JSON object
//! per line: posts, refused posts, and owner grant/revoke/rotate/disable
//! actions. Refused posts are the useful alarm: a bot that starts trying to
//! post where it was not called has probably been steered by injected text.
//! The log is best-effort operator diagnostics, not tamper evidence: whoever
//! runs the server controls the file. It rotates once to `bot_audit.jsonl.1`
//! when it passes `AUDIT_ROTATE_BYTES`.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::PathBuf;

/// A trigger older than this cannot authorize a bot reply.
pub const TRIGGER_MAX_AGE_MICROS: i64 = 15 * 60 * 1_000_000;
/// Rotate the audit log when it grows past this size.
pub const AUDIT_ROTATE_BYTES: u64 = 8 * 1024 * 1024;
/// Most audit entries returned by one read.
pub const AUDIT_READ_MAX: usize = 1000;

const POLICY_FILE: &str = "bot_post_policy.json";
const AUDIT_FILE: &str = "bot_audit.jsonl";

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PolicyData {
    /// Bot user ID (as a decimal string, for JSON keys) -> channels where the
    /// owner allowed the bot to post without a trigger.
    unprompted: BTreeMap<String, BTreeSet<String>>,
}

/// One line of the audit log.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEvent {
    pub at_micros: i64,
    pub bot_user_id: u64,
    /// `post`, `post_refused`, `channel_granted`, `channel_revoked`,
    /// `unprompted_allowed`, `unprompted_removed`, `token_rotated`, `disabled`.
    pub event: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
    /// The owner, for owner actions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor_user_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl AuditEvent {
    pub fn new(bot_user_id: u64, event: &'static str) -> Self {
        Self {
            at_micros: now_micros(),
            bot_user_id,
            event,
            channel_id: None,
            message_id: None,
            reply_to: None,
            actor_user_id: None,
            reason: None,
        }
    }
    pub fn channel(mut self, channel_id: &str) -> Self {
        self.channel_id = Some(channel_id.to_owned());
        self
    }
    pub fn message(mut self, message_id: &str) -> Self {
        self.message_id = Some(message_id.to_owned());
        self
    }
    pub fn reply_to(mut self, reply_to: Option<&str>) -> Self {
        self.reply_to = reply_to.map(str::to_owned);
        self
    }
    pub fn actor(mut self, actor_user_id: i64) -> Self {
        self.actor_user_id = Some(actor_user_id);
        self
    }
    pub fn reason(mut self, reason: &str) -> Self {
        self.reason = Some(reason.to_owned());
        self
    }
}

pub struct BotPolicy {
    data_dir: PathBuf,
    policy: tokio::sync::RwLock<PolicyData>,
    audit_lock: tokio::sync::Mutex<()>,
}

impl BotPolicy {
    /// Load the unprompted-post exceptions. A missing file means none. A
    /// malformed file stops startup instead of being silently replaced, like
    /// the other registries in the data directory.
    pub fn load(data_dir: PathBuf) -> Result<Self> {
        let path = data_dir.join(POLICY_FILE);
        let policy = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .with_context(|| format!("{} is malformed; restore it or remove it to allow no unprompted bot posts", path.display()))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => PolicyData::default(),
            Err(error) => return Err(error).with_context(|| format!("read {}", path.display())),
        };
        Ok(Self {
            data_dir,
            policy: tokio::sync::RwLock::new(policy),
            audit_lock: tokio::sync::Mutex::new(()),
        })
    }

    pub async fn allows_unprompted(&self, bot_user_id: u64, channel_id: &str) -> bool {
        self.policy
            .read()
            .await
            .unprompted
            .get(&bot_user_id.to_string())
            .is_some_and(|channels| channels.contains(channel_id))
    }

    pub async fn unprompted_channels(&self, bot_user_id: u64) -> Vec<String> {
        self.policy
            .read()
            .await
            .unprompted
            .get(&bot_user_id.to_string())
            .map(|channels| channels.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Allow or remove unprompted posts for one bot in one channel. The file
    /// is written before memory changes, so a failed write changes nothing.
    pub async fn set_unprompted(&self, bot_user_id: u64, channel_id: &str, allow: bool) -> Result<()> {
        let mut guard = self.policy.write().await;
        let mut candidate = guard.clone();
        let key = bot_user_id.to_string();
        if allow {
            candidate.unprompted.entry(key).or_default().insert(channel_id.to_owned());
        } else if let Some(channels) = candidate.unprompted.get_mut(&key) {
            channels.remove(channel_id);
            if channels.is_empty() {
                candidate.unprompted.remove(&key);
            }
        }
        let path = self.data_dir.join(POLICY_FILE);
        let data = candidate.clone();
        tokio::task::spawn_blocking(move || persist(&path, &data))
            .await
            .context("bot post policy write task failed")??;
        *guard = candidate;
        Ok(())
    }

    /// Append one audit line. Failures are logged, not returned: by the time
    /// a post is recorded it is already stored, and refusing to report a
    /// refusal would hide it.
    pub async fn record(&self, event: AuditEvent) {
        let _guard = self.audit_lock.lock().await;
        let path = self.data_dir.join(AUDIT_FILE);
        let result = tokio::task::spawn_blocking(move || append_audit(&path, &event)).await;
        match result {
            Ok(Ok(())) => {}
            Ok(Err(error)) => tracing::warn!(%error, "bot audit log write failed"),
            Err(error) => tracing::warn!(%error, "bot audit log task failed"),
        }
    }

    /// The newest `limit` entries for one bot, oldest first, across the
    /// rotated and current log.
    pub async fn read_audit(&self, bot_user_id: u64, limit: usize) -> Result<Vec<serde_json::Value>> {
        let _guard = self.audit_lock.lock().await;
        let current = self.data_dir.join(AUDIT_FILE);
        let rotated = self.data_dir.join(format!("{AUDIT_FILE}.1"));
        let limit = limit.clamp(1, AUDIT_READ_MAX);
        tokio::task::spawn_blocking(move || {
            let mut entries = Vec::new();
            for path in [rotated, current] {
                let text = match std::fs::read_to_string(&path) {
                    Ok(text) => text,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(error).with_context(|| format!("read {}", path.display())),
                };
                for line in text.lines() {
                    // A torn final line after a crash is skipped, not fatal.
                    let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) else { continue };
                    if entry["botUserId"].as_u64() == Some(bot_user_id) {
                        entries.push(entry);
                    }
                }
            }
            let skip = entries.len().saturating_sub(limit);
            Ok(entries.split_off(skip))
        })
        .await
        .context("bot audit read task failed")?
    }
}

/// True when `text` @-mentions `name` as a whole word: `@name` not followed by
/// another handle character. Matching ignores ASCII case.
pub fn mentions(text: &str, name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    let is_handle_char = |c: char| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.');
    let lower = text.to_ascii_lowercase();
    let needle = format!("@{}", name.to_ascii_lowercase());
    let mut from = 0;
    while let Some(found) = lower[from..].find(&needle) {
        let start = from + found;
        let end = start + needle.len();
        let before_ok = lower[..start].chars().next_back().is_none_or(|c| !is_handle_char(c) && c != '@');
        let after = lower[end..].chars().next();
        // A trailing '.' ends a sentence ("thanks @bot."), so it does not
        // extend the handle unless more handle characters follow it.
        let after_ok = match after {
            None => true,
            Some('.') => !lower[end + 1..].chars().next().is_some_and(is_handle_char),
            Some(c) => !is_handle_char(c),
        };
        if before_ok && after_ok {
            return true;
        }
        from = start + 1;
    }
    false
}

fn persist(path: &std::path::Path, data: &PolicyData) -> Result<()> {
    let temporary = path.with_file_name(format!(".bot_post_policy-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let bytes = serde_json::to_vec_pretty(data)?;
        if bytes.len() > 16 * 1024 * 1024 {
            bail!("bot post policy exceeds size limit");
        }
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .context("create bot post policy update")?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        std::fs::rename(&temporary, path).context("publish bot post policy update")?;
        #[cfg(unix)]
        std::fs::File::open(path.parent().expect("policy has a directory"))?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

fn append_audit(path: &std::path::Path, event: &AuditEvent) -> Result<()> {
    if std::fs::metadata(path).is_ok_and(|meta| meta.len() >= AUDIT_ROTATE_BYTES) {
        std::fs::rename(path, path.with_file_name(format!("{AUDIT_FILE}.1")))
            .context("rotate bot audit log")?;
    }
    let mut line = serde_json::to_vec(event)?;
    line.push(b'\n');
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .context("open bot audit log")?;
    // One write per line, so concurrent readers never see half an entry
    // except after a crash (handled when reading).
    file.write_all(&line)?;
    Ok(())
}

pub fn now_micros() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_micros() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mention_matches_whole_handles_only() {
        assert!(mentions("@hermes-bot summarize this", "hermes-bot"));
        assert!(mentions("hey @Hermes-Bot, please", "hermes-bot"));
        assert!(mentions("thanks @hermes-bot.", "hermes-bot"));
        assert!(mentions("(@hermes-bot)", "hermes-bot"));
        assert!(!mentions("@hermes-bot2 do it", "hermes-bot"));
        assert!(!mentions("@hermes-bot.evil do it", "hermes-bot"));
        assert!(!mentions("mail me at x@hermes-bot", "hermes-bot"));
        assert!(!mentions("@@hermes-bot", "hermes-bot"));
        assert!(!mentions("hermes-bot without an at sign", "hermes-bot"));
        assert!(!mentions("@hermes-bot", ""));
    }

    #[tokio::test]
    async fn unprompted_policy_survives_reload_and_malformed_file_stops_startup() {
        let dir = tempfile::tempdir().unwrap();
        let policy = BotPolicy::load(dir.path().to_path_buf()).unwrap();
        policy.set_unprompted(7, "ch_a", true).await.unwrap();
        policy.set_unprompted(7, "ch_b", true).await.unwrap();
        policy.set_unprompted(7, "ch_b", false).await.unwrap();
        let reloaded = BotPolicy::load(dir.path().to_path_buf()).unwrap();
        assert!(reloaded.allows_unprompted(7, "ch_a").await);
        assert!(!reloaded.allows_unprompted(7, "ch_b").await);
        assert!(!reloaded.allows_unprompted(8, "ch_a").await);

        std::fs::write(dir.path().join(POLICY_FILE), b"{not json").unwrap();
        assert!(BotPolicy::load(dir.path().to_path_buf()).is_err());
    }

    #[tokio::test]
    async fn audit_log_filters_by_bot_rotates_and_skips_torn_lines() {
        let dir = tempfile::tempdir().unwrap();
        let policy = BotPolicy::load(dir.path().to_path_buf()).unwrap();
        policy.record(AuditEvent::new(1, "post").channel("ch_a").message("m1")).await;
        policy.record(AuditEvent::new(2, "post").channel("ch_b")).await;
        policy.record(AuditEvent::new(1, "post_refused").channel("ch_c").reason("no trigger")).await;
        let path = dir.path().join(AUDIT_FILE);
        let mut file = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"{\"botUserId\":1,\"event\":\"tor").unwrap();
        drop(file);

        let entries = policy.read_audit(1, 10).await.unwrap();
        let events: Vec<&str> = entries.iter().map(|e| e["event"].as_str().unwrap()).collect();
        assert_eq!(events, vec!["post", "post_refused"]);
        assert_eq!(policy.read_audit(1, 1).await.unwrap()[0]["event"], "post_refused");

        // Force a rotation; older entries stay readable from the rotated file.
        std::fs::OpenOptions::new().append(true).open(&path).unwrap().set_len(AUDIT_ROTATE_BYTES).unwrap();
        policy.record(AuditEvent::new(1, "disabled")).await;
        assert!(dir.path().join(format!("{AUDIT_FILE}.1")).exists());
        let entries = policy.read_audit(1, 10).await.unwrap();
        assert_eq!(entries.last().unwrap()["event"], "disabled");
        assert_eq!(entries.len(), 3);
    }
}
