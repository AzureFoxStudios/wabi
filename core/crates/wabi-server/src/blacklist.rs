//! Blacklist management for user bans
//!
//! File format (blacklist.txt):
//! # Comments start with #
//! type|value|reason|expires_timestamp
//!
//! Types: user, ip, channel_ban, channel_timeout
//! expires_timestamp: Unix timestamp (0 = never expires)

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{error, info};

/// Blacklist entry
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct BlacklistEntry {
    pub entry_type: BlacklistType,
    pub value: String,
    pub reason: String,
    pub expires_at: Option<u64>, // None = never expires
}

/// Type of blacklist entry
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum BlacklistType {
    User,
    Ip,
    ChannelBan,
    ChannelTimeout,
}

impl BlacklistType {
    fn from_str(s: &str) -> Option<Self> {
        match s.trim().to_lowercase().as_str() {
            "user" => Some(BlacklistType::User),
            "ip" => Some(BlacklistType::Ip),
            "channel_ban" => Some(BlacklistType::ChannelBan),
            "channel_timeout" => Some(BlacklistType::ChannelTimeout),
            _ => None,
        }
    }
}

/// Blacklist manager - loaded from file, checked in-memory
pub struct BlacklistManager {
    entries: RwLock<HashMap<String, BlacklistEntry>>, // key = "type:value"
    file_path: String,
}

#[allow(dead_code)]
impl BlacklistManager {
    pub fn new(file_path: String) -> Self {
        Self {
            entries: RwLock::new(HashMap::new()),
            file_path,
        }
    }

    /// Load blacklist from file (async, safe for concurrent access)
    pub async fn load_from_file(&self) -> anyhow::Result<()> {
        let path = Path::new(&self.file_path);

        // An absent file is a fresh installation. An unreadable or damaged
        // existing file is never an empty allowlist.
        if !path.exists() {
            if let Some(parent) = path.parent() { std::fs::create_dir_all(parent)?; }
            let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
            file.write_all(b"# Wabi Blacklist\n# Format: type|value|reason|expires_timestamp\n# Types: user, ip, channel_ban, channel_timeout\n# expires_timestamp: Unix timestamp (0 = never expires)\n")?;
            file.sync_all()?;
            info!(
                "[blacklist] Created empty blacklist file at {}",
                self.file_path
            );
            return Ok(());
        }

        let file = File::open(path)?;
        let reader = BufReader::new(file);
        let mut entries = HashMap::new();
        let mut count = 0;

        for (line_num, line_result) in reader.lines().enumerate() {
            let line = line_result?;
            let line = line.trim();

            // Skip empty lines and comments
            if line.is_empty() || line.starts_with('#') {
                continue;
            }

            let parts: Vec<&str> = line.split('|').collect();
            if !(3..=4).contains(&parts.len()) {
                anyhow::bail!("blacklist line {} has invalid format", line_num + 1);
            }

            let entry_type = match BlacklistType::from_str(parts[0]) {
                Some(t) => t,
                None => anyhow::bail!("blacklist line {} has unknown type", line_num + 1),
            };

            let mut value = parts[1].trim().to_string();
            let reason = parts[2].trim().to_string();
            if value.is_empty() {
                anyhow::bail!("blacklist line {} has an empty value", line_num + 1);
            }
            match &entry_type {
                BlacklistType::User => {
                    if value.parse::<i64>().ok().filter(|id| *id > 0).is_none() {
                        anyhow::bail!("blacklist line {} needs a positive numeric user ID", line_num + 1);
                    }
                }
                BlacklistType::Ip => {
                    value = value.parse::<std::net::IpAddr>()
                        .map_err(|_| anyhow::anyhow!("blacklist line {} needs one IP address, not a range or hostname", line_num + 1))?
                        .to_string();
                }
                BlacklistType::ChannelBan | BlacklistType::ChannelTimeout => {
                    let valid = value.rsplit_once(':').is_some_and(|(channel, user)| {
                        !channel.is_empty() && user.parse::<i64>().ok().is_some_and(|id| id > 0)
                    });
                    if !valid { anyhow::bail!("blacklist line {} needs channel_id:user_id", line_num + 1); }
                }
            }
            let expires_at = match parts.get(3) {
                Some(value) => Some(value.trim().parse::<u64>().map_err(|_| anyhow::anyhow!("blacklist line {} has an invalid expiry", line_num + 1))?).filter(|&ts| ts > 0),
                None => None,
            };

            let key = format!(
                "{}:{}",
                match entry_type {
                    BlacklistType::User => "user",
                    BlacklistType::Ip => "ip",
                    BlacklistType::ChannelBan => "channel_ban",
                    BlacklistType::ChannelTimeout => "channel_timeout",
                },
                &value
            );

            entries.insert(
                key,
                BlacklistEntry {
                    entry_type,
                    value,
                    reason,
                    expires_at,
                },
            );
            count += 1;
        }

        info!(
            "[blacklist] Loaded {} entries from {}",
            count, self.file_path
        );

        // Replace entries atomically
        let mut guard = self.entries.write().await;
        *guard = entries;

        Ok(())
    }

    /// Check if a user ID is banned
    pub async fn is_user_banned(&self, user_id: i64) -> Option<BlacklistEntry> {
        let key = format!("user:{}", user_id);
        let guard = self.entries.read().await;

        guard.get(&key).and_then(|entry| {
            if let Some(expires) = entry.expires_at {
                let now = chrono::Utc::now().timestamp() as u64;
                if now >= expires {
                    return None; // Expired
                }
            }
            Some(entry.clone())
        })
    }

    pub async fn active_user_ban_ids(&self) -> Vec<i64> {
        let now = chrono::Utc::now().timestamp() as u64;
        let guard = self.entries.read().await;
        let mut ids: Vec<i64> = guard.values().filter(|entry| {
            entry.entry_type == BlacklistType::User && entry.expires_at.is_none_or(|expires| now < expires)
        }).filter_map(|entry| entry.value.parse::<i64>().ok()).collect();
        ids.sort_unstable();
        ids
    }

    /// Check if an IP is banned
    pub async fn is_ip_banned(&self, ip: &str) -> Option<BlacklistEntry> {
        let key = format!("ip:{}", ip);
        let guard = self.entries.read().await;

        guard.get(&key).and_then(|entry| {
            if let Some(expires) = entry.expires_at {
                let now = chrono::Utc::now().timestamp() as u64;
                if now >= expires {
                    return None; // Expired
                }
            }
            Some(entry.clone())
        })
    }

    async fn active_restriction(&self, kind: &str, channel_id: &str, user_id: i64) -> Option<BlacklistEntry> {
        let key = format!("{kind}:{channel_id}:{user_id}");
        let guard = self.entries.read().await;
        guard.get(&key).filter(|entry| entry.expires_at.is_none_or(|expires| (chrono::Utc::now().timestamp() as u64) < expires)).cloned()
    }

    pub async fn is_channel_banned(&self, channel_id: &str, user_id: i64) -> Option<BlacklistEntry> {
        self.active_restriction("channel_ban", channel_id, user_id).await
    }

    pub async fn is_channel_timed_out(&self, channel_id: &str, user_id: i64) -> Option<BlacklistEntry> {
        self.active_restriction("channel_timeout", channel_id, user_id).await
    }

    pub async fn restrict_channel(&self, channel_id: &str, user_id: i64, reason: &str, expires_at: Option<u64>) -> anyhow::Result<()> {
        let entry_type = if expires_at.is_some() { BlacklistType::ChannelTimeout } else { BlacklistType::ChannelBan };
        let kind = if expires_at.is_some() { "channel_timeout" } else { "channel_ban" };
        let value = format!("{channel_id}:{user_id}");
        let mut guard = self.entries.write().await;
        let mut next = guard.clone();
        next.insert(format!("{kind}:{value}"), BlacklistEntry { entry_type, value, reason: reason.to_string(), expires_at });
        self.persist(&next)?;
        *guard = next;
        Ok(())
    }

    pub async fn remove_channel_restriction(&self, channel_id: &str, user_id: i64, timeout: bool) -> anyhow::Result<()> {
        let kind = if timeout { "channel_timeout" } else { "channel_ban" };
        let mut guard = self.entries.write().await;
        let mut next = guard.clone();
        next.remove(&format!("{kind}:{channel_id}:{user_id}"));
        self.persist(&next)?;
        *guard = next;
        Ok(())
    }

    fn persist(&self, entries: &HashMap<String, BlacklistEntry>) -> anyhow::Result<()> {
        let path = Path::new(&self.file_path);
        let parent = path.parent().ok_or_else(|| anyhow::anyhow!("blacklist path has no parent"))?;
        std::fs::create_dir_all(parent)?;
        let temporary = parent.join(format!(".blacklist-{}.tmp", uuid::Uuid::new_v4()));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        let mut file = options.open(&temporary)?;
        let result = (|| -> anyhow::Result<()> {
            file.write_all(b"# Wabi Blacklist\n# Format: type|value|reason|expires_timestamp\n")?;
            let mut ordered: Vec<_> = entries.values().collect();
            ordered.sort_by_key(|entry| match entry.entry_type {
                BlacklistType::User => format!("user:{}", entry.value),
                BlacklistType::Ip => format!("ip:{}", entry.value),
                BlacklistType::ChannelBan => format!("channel_ban:{}", entry.value),
                BlacklistType::ChannelTimeout => format!("channel_timeout:{}", entry.value),
            });
            for entry in ordered {
                let kind = match entry.entry_type { BlacklistType::User => "user", BlacklistType::Ip => "ip", BlacklistType::ChannelBan => "channel_ban", BlacklistType::ChannelTimeout => "channel_timeout" };
                writeln!(file, "{}|{}|{}|{}", kind, entry.value, entry.reason.replace(['|', '\n', '\r'], " "), entry.expires_at.unwrap_or(0))?;
            }
            file.sync_all()?;
            std::fs::rename(&temporary, path)?;
            #[cfg(unix)]
            File::open(parent)?.sync_all()?;
            Ok(())
        })();
        if result.is_err() { let _ = std::fs::remove_file(&temporary); }
        result
    }

    /// Save the new file before changing the in-memory enforcement map.
    pub async fn add_user(&self, user_id: i64, reason: &str, expires_at: Option<u64>) -> anyhow::Result<()> {
        let key = format!("user:{}", user_id);
        let entry = BlacklistEntry {
            entry_type: BlacklistType::User,
            value: user_id.to_string(),
            reason: reason.to_string(),
            expires_at,
        };
        let mut guard = self.entries.write().await;
        let mut next = guard.clone();
        next.insert(key, entry);
        self.persist(&next)?;
        *guard = next;
        info!(
            "[blacklist] Added user {} to blacklist: {}",
            user_id, reason
        );
        Ok(())
    }

    pub async fn remove_user(&self, user_id: i64) -> anyhow::Result<()> {
        let key = format!("user:{}", user_id);
        let mut guard = self.entries.write().await;
        let mut next = guard.clone();
        next.remove(&key);
        self.persist(&next)?;
        *guard = next;
        info!("[blacklist] Removed user {} from blacklist", user_id);
        Ok(())
    }

    /// Clear all blacklist entries only after the change is durable.
    pub async fn clear_all(&self) -> anyhow::Result<()> {
        let mut guard = self.entries.write().await;
        let count = guard.len();
        self.persist(&HashMap::new())?;
        *guard = HashMap::new();
        info!("[blacklist] Cleared all {} entries", count);
        Ok(())
    }

    /// Sweep expired entries. Required to prevent unbounded memory growth
    /// when entries are added with `expires_at` and never get re-checked
    /// after expiration (the `is_user_banned` check filters at read time
    /// but the entry stays in the map).
    ///
    /// WABI_AUDIT_REPORT.md finding #6 + WABI_BAN_SYSTEM_MEMORY_FIX.md.
    ///
    /// Returns the number of entries removed.
    pub async fn cleanup_expired(&self) -> usize {
        let now = chrono::Utc::now().timestamp() as u64;
        let mut guard = self.entries.write().await;
        let before = guard.len();
        let mut next = guard.clone();
        next.retain(|_, entry| match entry.expires_at {
            None => true,                                // never expires — keep
            Some(expires) => now < expires,              // not yet expired — keep
        });
        let removed = before - next.len();
        if removed > 0 {
            if let Err(error) = self.persist(&next) {
                error!(%error, "[blacklist] Could not persist expired-entry cleanup");
                return 0;
            }
            *guard = next;
            info!("[blacklist] Cleaned up {} expired entries", removed);
        }
        removed
    }

    /// Reload blacklist from file
    pub async fn reload(&self) -> anyhow::Result<()> {
        self.load_from_file().await
    }
}

/// Spawn a periodic cleanup task for the blacklist. 5-minute interval.
/// Returns the JoinHandle so shutdown can cancel the loop.
pub fn spawn_blacklist_cleanup_loop(
    manager: Arc<BlacklistManager>,
    operations: crate::instance_operations::InstanceOperations,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(300));
        interval.tick().await; // skip the immediate first tick
        loop {
            interval.tick().await;
            operations.run(manager.cleanup_expired()).await;
        }
    })
}

#[cfg(test)]
mod tests {
    //! WABI_AUDIT_REPORT.md finding #6 + WABI_BAN_SYSTEM_MEMORY_FIX.md.
    //!
    //! Tests assert the cleanup_expired and clear_all methods work as
    //! expected: expired entries are swept, non-expired entries survive,
    //! and clear_all removes everything.

    use super::*;

    fn test_manager() -> BlacklistManager {
        BlacklistManager::new("/tmp/test_blacklist.txt".to_string())
    }

    #[tokio::test]
    async fn cleanup_expired_removes_expired_keeps_active() {
        let m = test_manager();
        // Active entry (never expires)
        m.add_user(1, "perm ban", None).await;
        // Active entry (far future expiry)
        m.add_user(2, "temp ban", Some(u64::MAX)).await;
        // Already expired
        m.add_user(3, "already expired", Some(1)).await;

        assert_eq!(m.is_user_banned(1).await.is_some(), true);
        assert_eq!(m.is_user_banned(2).await.is_some(), true);
        // is_user_banned returns None for expired (filters at read)
        assert_eq!(m.is_user_banned(3).await.is_some(), false);
        // But the entry is still in the map
        assert_eq!(m.entries.read().await.len(), 3);

        let removed = m.cleanup_expired().await;
        assert_eq!(removed, 1); // only user 3 was expired

        // After cleanup, expired entry is gone
        assert_eq!(m.entries.read().await.len(), 2);
        // Active entries still banned
        assert!(m.is_user_banned(1).await.is_some());
        assert!(m.is_user_banned(2).await.is_some());
        // Expired entry is now also gone (not just filtered)
        assert!(m.is_user_banned(3).await.is_none());
    }

    #[tokio::test]
    async fn clear_all_removes_everything() {
        let m = test_manager();
        m.add_user(1, "ban 1", None).await;
        m.add_user(2, "ban 2", None).await;
        m.add_user(3, "ban 3", None).await;
        assert_eq!(m.entries.read().await.len(), 3);

        m.clear_all().await.unwrap();
        assert_eq!(m.entries.read().await.len(), 0);
        assert!(m.is_user_banned(1).await.is_none());
    }

    #[tokio::test]
    async fn remove_user_only_removes_target() {
        let m = test_manager();
        m.add_user(1, "ban 1", None).await;
        m.add_user(2, "ban 2", None).await;

        m.remove_user(1).await;
        assert!(m.is_user_banned(1).await.is_none());
        assert!(m.is_user_banned(2).await.is_some());
    }
}
