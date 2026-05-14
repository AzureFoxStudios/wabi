//! Blacklist management for user bans
//!
//! File format (blacklist.txt):
//! # Comments start with #
//! type|value|reason|expires_timestamp
//!
//! Types: user, ip
//! expires_timestamp: Unix timestamp (0 = never expires)

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, info, warn};

/// Blacklist entry
#[derive(Debug, Clone)]
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
}

impl BlacklistType {
    fn from_str(s: &str) -> Option<Self> {
        match s.trim().to_lowercase().as_str() {
            "user" => Some(BlacklistType::User),
            "ip" => Some(BlacklistType::Ip),
            _ => None,
        }
    }
}

/// Blacklist manager - loaded from file, checked in-memory
pub struct BlacklistManager {
    entries: RwLock<HashMap<String, BlacklistEntry>>, // key = "type:value"
    file_path: String,
}

impl BlacklistManager {
    pub fn new(file_path: String) -> Self {
        Self {
            entries: RwLock::new(HashMap::new()),
            file_path,
        }
    }

    /// Load blacklist from file (async, safe for concurrent access)
    pub async fn load_from_file(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let path = Path::new(&self.file_path);

        // Create empty file if it doesn't exist
        if !path.exists() {
            std::fs::write(path, "# Wabi Blacklist\n# Format: type|value|reason|expires_timestamp\n# Types: user, ip\n# expires_timestamp: Unix timestamp (0 = never expires)\n")?;
            info!("[blacklist] Created empty blacklist file at {}", self.file_path);
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
            if parts.len() < 3 {
                warn!("[blacklist] Line {} invalid format (expected type|value|reason|[expires]): {}", line_num + 1, line);
                continue;
            }

            let entry_type = match BlacklistType::from_str(parts[0]) {
                Some(t) => t,
                None => {
                    warn!("[blacklist] Line {} unknown type '{}': {}", line_num + 1, parts[0], line);
                    continue;
                }
            };

            let value = parts[1].trim().to_string();
            let reason = parts[2].trim().to_string();
            let expires_at = parts.get(3)
                .and_then(|s| s.trim().parse::<u64>().ok())
                .filter(|&ts| ts > 0);

            let key = format!("{}:{}", 
                match entry_type { BlacklistType::User => "user", BlacklistType::Ip => "ip" },
                &value
            );

            entries.insert(key, BlacklistEntry {
                entry_type,
                value,
                reason,
                expires_at,
            });
            count += 1;
        }

        info!("[blacklist] Loaded {} entries from {}", count, self.file_path);
        
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

    /// Add a user to the blacklist (in-memory only, doesn't persist)
    pub async fn add_user(&self, user_id: i64, reason: &str, expires_at: Option<u64>) {
        let key = format!("user:{}", user_id);
        let entry = BlacklistEntry {
            entry_type: BlacklistType::User,
            value: user_id.to_string(),
            reason: reason.to_string(),
            expires_at,
        };
        let mut guard = self.entries.write().await;
        guard.insert(key, entry);
        info!("[blacklist] Added user {} to blacklist: {}", user_id, reason);
    }

    /// Remove a user from the blacklist (in-memory only)
    pub async fn remove_user(&self, user_id: i64) {
        let key = format!("user:{}", user_id);
        let mut guard = self.entries.write().await;
        guard.remove(&key);
        info!("[blacklist] Removed user {} from blacklist", user_id);
    }

    /// Reload blacklist from file
    pub async fn reload(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.load_from_file().await
    }
}
