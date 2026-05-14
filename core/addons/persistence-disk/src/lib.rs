//! Wabi Persistence Disk Addon
//!
//! Writes messages to JSONL files on disk for compliance/audit purposes.
//! Append-only, line-based format for easy backup and recovery.

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use thiserror::Error;
use tokio::fs::{self, OpenOptions};
use tokio::io::{AsyncBufWriterExt, AsyncWriteExt, BufWriter};
use tokio::sync::{mpsc, Mutex};
use tracing::{error, info, warn};

use wabi_core::protocol::Message;

/// Persistence mode for a channel
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PersistenceMode {
    /// Messages deleted after TTL (default: 5 minutes)
    Ephemeral,
    /// Messages persist until server restart
    Session,
    /// Messages written to disk permanently
    Persistent,
}

/// Configuration for a channel's persistence
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelPersistenceConfig {
    pub channel_id: String,
    pub mode: PersistenceMode,
    pub ttl_minutes: Option<u32>,
    pub retention_days: Option<u32>,
}

/// Addon configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistenceDiskConfig {
    /// Base path for data storage
    pub base_path: PathBuf,
    /// Flush interval in seconds
    pub flush_interval_secs: u64,
    /// Rotation policy
    pub rotation: RotationPolicy,
    /// Max file size before rotation (MB)
    pub max_file_size_mb: u64,
    /// Default channel config
    pub default_mode: PersistenceMode,
}

impl Default for PersistenceDiskConfig {
    fn default() -> Self {
        Self {
            base_path: dirs::home_dir()
                .unwrap_or_default()
                .join(".wabi/data"),
            flush_interval_secs: 10,
            rotation: RotationPolicy::Daily,
            max_file_size_mb: 100,
            default_mode: PersistenceMode::Ephemeral,
        }
    }
}

/// Rotation policy for log files
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RotationPolicy {
    Daily,
    Weekly,
    Monthly,
    Never,
}

/// Errors that can occur during persistence
#[derive(Error, Debug)]
pub enum PersistenceError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("Channel not configured: {0}")]
    ChannelNotConfigured(String),

    #[error("Addon not initialized")]
    NotInitialized,
}

/// A single persisted message record
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedMessage {
    pub ts: DateTime<Utc>,
    pub user_id: String,
    pub content: String,
    pub edited: bool,
    pub message_id: String,
}

impl From<&Message> for PersistedMessage {
    fn from(msg: &Message) -> Self {
        Self {
            ts: Utc::now(),
            user_id: msg.user_id.clone(),
            content: msg.content.clone(),
            edited: msg.edited,
            message_id: msg.id.clone(),
        }
    }
}

/// JSONL writer for a single channel
pub struct ChannelWriter {
    channel_id: String,
    file_path: PathBuf,
    writer: BufWriter<tokio::fs::File>,
    message_count: u64,
    current_size_bytes: u64,
}

impl ChannelWriter {
    pub async fn new(channel_id: String, file_path: PathBuf) -> Result<Self> {
        // Ensure directory exists
        if let Some(parent) = file_path.parent() {
            fs::create_dir_all(parent).await?;
        }

        // Open file in append mode
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&file_path)
            .await
            .context(format!("Failed to open {}", file_path.display()))?;

        let writer = BufWriter::new(file);

        Ok(Self {
            channel_id,
            file_path,
            writer,
            message_count: 0,
            current_size_bytes: 0,
        })
    }

    pub async fn write(&mut self, message: &PersistedMessage) -> Result<()> {
        let json = serde_json::to_string(message)?;
        let line = format!("{}\n", json);
        let bytes = line.as_bytes();

        self.writer.write_all(bytes).await?;
        self.message_count += 1;
        self.current_size_bytes += bytes.len() as u64;

        Ok(())
    }

    pub async fn flush(&mut self) -> Result<()> {
        self.writer.flush().await?;
        Ok(())
    }

    pub fn needs_rotation(&self, max_size_bytes: u64) -> bool {
        self.current_size_bytes >= max_size_bytes
    }

    pub fn file_path(&self) -> &Path {
        &self.file_path
    }

    pub fn message_count(&self) -> u64 {
        self.message_count
    }
}

/// Main persistence disk addon
pub struct PersistenceDiskAddon {
    config: PersistenceDiskConfig,
    channel_configs: Arc<Mutex<HashMap<String, ChannelPersistenceConfig>>>,
    writers: Arc<Mutex<HashMap<String, ChannelWriter>>>,
    message_tx: mpsc::Sender<(String, Message)>,
}

impl PersistenceDiskAddon {
    pub fn new(config: PersistenceDiskConfig) -> Self {
        let (message_tx, _) = mpsc::channel(1000);

        Self {
            config,
            channel_configs: Arc::new(Mutex::new(HashMap::new())),
            writers: Arc::new(Mutex::new(HashMap::new())),
            message_tx,
        }
    }

    /// Initialize the addon
    pub async fn init(&self) -> Result<()> {
        // Ensure base directory exists
        fs::create_dir_all(&self.config.base_path).await?;

        info!(
            "Persistence disk addon initialized: {}",
            self.config.base_path.display()
        );

        Ok(())
    }

    /// Configure persistence for a channel
    pub async fn configure_channel(&self, config: ChannelPersistenceConfig) -> Result<()> {
        let mut configs = self.channel_configs.lock().await;
        configs.insert(config.channel_id.clone(), config);

        info!("Configured persistence for channel: {}", config.channel_id);

        Ok(())
    }

    /// Get persistence config for a channel
    pub async fn get_channel_config(&self, channel_id: &str) -> Option<ChannelPersistenceConfig> {
        let configs = self.channel_configs.lock().await;
        configs.get(channel_id).cloned()
    }

    /// Write a message to disk (if channel is persistent)
    pub async fn write_message(&self, channel_id: &str, message: &Message) -> Result<()> {
        let configs = self.channel_configs.lock().await;
        let config = configs
            .get(channel_id)
            .ok_or_else(|| PersistenceError::ChannelNotConfigured(channel_id.to_string()))?;

        // Only write if persistent mode
        if config.mode != PersistenceMode::Persistent {
            return Ok(());
        }

        drop(configs);

        // Get or create writer for this channel
        let mut writers = self.writers.lock().await;

        if !writers.contains_key(channel_id) {
            let file_path = self.get_channel_file_path(channel_id);
            let writer = ChannelWriter::new(channel_id.to_string(), file_path).await?;
            writers.insert(channel_id.to_string(), writer);
        }

        let writer = writers.get_mut(channel_id).unwrap();
        let persisted = PersistedMessage::from(message);
        writer.write(&persisted).await?;

        // Check if rotation needed
        if writer.needs_rotation(self.config.max_file_size_mb * 1024 * 1024) {
            drop(writers);
            self.rotate_channel(channel_id).await?;
        }

        Ok(())
    }

    /// Flush all writers
    pub async fn flush_all(&self) -> Result<()> {
        let mut writers = self.writers.lock().await;
        for writer in writers.values_mut() {
            if let Err(e) = writer.flush().await {
                error!("Failed to flush writer: {}", e);
            }
        }
        Ok(())
    }

    /// Rotate a channel's log file
    pub async fn rotate_channel(&self, channel_id: &str) -> Result<()> {
        let mut writers = self.writers.lock().await;

        if let Some(writer) = writers.get_mut(channel_id) {
            // Flush current file
            writer.flush().await?;

            // Generate rotated filename with timestamp
            let now = Utc::now();
            let timestamp = now.format("%Y%m%d_%H%M%S");
            let rotated_path = format!(
                "{}.{}",
                writer.file_path().display(),
                timestamp
            );

            // Rename current file
            fs::rename(writer.file_path(), &rotated_path).await?;

            info!(
                "Rotated {} -> {}",
                writer.file_path().display(),
                rotated_path
            );

            // Create new writer
            let new_writer =
                ChannelWriter::new(channel_id.to_string(), writer.file_path().to_path_buf())
                    .await?;
            *writer = new_writer;
        }

        Ok(())
    }

    /// Get the file path for a channel
    fn get_channel_file_path(&self, channel_id: &str) -> PathBuf {
        self.config
            .base_path
            .join("channels")
            .join(channel_id)
            .join("messages.jsonl")
    }

    /// Prune messages older than retention period
    pub async fn prune_channel(&self, channel_id: &str, before: DateTime<Utc>) -> Result<usize> {
        // This would require reading the file, filtering, and rewriting
        // For now, just log that retention policy should be applied
        info!(
            "Prune requested for {} before {}",
            channel_id,
            before.to_rfc3339()
        );

        // TODO: Implement actual pruning
        Ok(0)
    }

    /// Get stats for a channel
    pub async fn get_channel_stats(&self, channel_id: &str) -> Result<ChannelStats> {
        let file_path = self.get_channel_file_path(channel_id);

        if !file_path.exists() {
            return Ok(ChannelStats {
                channel_id: channel_id.to_string(),
                total_messages: 0,
                disk_size_bytes: 0,
                oldest_message_ts: None,
                newest_message_ts: None,
            });
        }

        let metadata = fs::metadata(&file_path).await?;
        let size = metadata.len();

        // Count lines (messages) - could be optimized with index
        let content = fs::read_to_string(&file_path).await?;
        let message_count = content.lines().count() as u64;

        Ok(ChannelStats {
            channel_id: channel_id.to_string(),
            total_messages: message_count,
            disk_size_bytes: size,
            oldest_message_ts: None, // Would need to parse first line
            newest_message_ts: None, // Would need to parse last line
        })
    }
}

/// Statistics for a channel
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelStats {
    pub channel_id: String,
    pub total_messages: u64,
    pub disk_size_bytes: u64,
    pub oldest_message_ts: Option<DateTime<Utc>>,
    pub newest_message_ts: Option<DateTime<Utc>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_channel_writer() {
        let temp_dir = tempfile::tempdir().unwrap();
        let file_path = temp_dir.path().join("test.jsonl");

        let mut writer = ChannelWriter::new("test".to_string(), file_path.clone())
            .await
            .unwrap();

        let msg = PersistedMessage {
            ts: Utc::now(),
            user_id: "user1".to_string(),
            content: "hello".to_string(),
            edited: false,
            message_id: "msg1".to_string(),
        };

        writer.write(&msg).await.unwrap();
        writer.flush().await.unwrap();

        // Verify file exists and has content
        let content = fs::read_to_string(&file_path).await.unwrap();
        assert!(content.contains("hello"));
        assert_eq!(writer.message_count(), 1);
    }
}
