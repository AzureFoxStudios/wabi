//! Plugin system protocol types.
//!
//! These types define the contract for Wabi's plugin system, including
//! plugin manifests, configuration, events, and permissions.

use serde::{Deserialize, Serialize};
#[cfg(feature = "ts")]
use ts_rs::TS;

/// Plugin manifest: metadata about a Wabi plugin.
///
/// This is the canonical structure of a plugin's `manifest.json` file.
/// All plugins must include a valid manifest to be loaded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct PluginManifest {
    /// Unique plugin identifier (reverse-DNS style: com.example.plugin-name)
    pub id: String,
    /// Human-readable plugin name
    pub name: String,
    /// Plugin version (semver)
    pub version: String,
    /// Plugin author(s)
    pub author: String,
    /// Short description (one line)
    pub description: String,
    /// Minimum Wabi version required
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_wabi_version: Option<String>,
    /// Plugin homepage/repository URL
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    /// Plugin icon (relative path or URL)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// Required permissions
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub permissions: Vec<PluginPermission>,
    /// Plugin configuration schema (JSON Schema) - not exported to TS
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(skip))]
    pub config_schema: Option<serde_json::Value>,
    /// Default configuration values - not exported to TS
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(skip))]
    pub default_config: Option<serde_json::Value>,
}

/// Plugin permission: declares what APIs/resources a plugin can access.
#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", ts(export))]
pub enum PluginPermission {
    /// Read messages in channels/DMs
    ReadMessages,
    /// Send messages to channels/DMs
    SendMessages,
    /// Read user presence/status
    ReadPresence,
    /// Modify user settings
    UserSettings,
    /// Access to websocket events
    SocketEvents,
    /// Access to plugin storage (key-value)
    PluginStorage,
    /// Create UI components (panels, modals, etc.)
    UiComponents,
    /// Access to media uploads
    MediaUpload,
    /// Access to call state
    CallState,
    /// Access to whiteboard state
    WhiteboardState,
}

/// Plugin configuration: runtime config for a loaded plugin.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct PluginConfig {
    /// Plugin ID
    pub plugin_id: String,
    /// True if plugin is enabled
    pub enabled: bool,
    /// Configuration values (must match config_schema) - not exported to TS
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(skip))]
    pub values: Option<serde_json::Value>,
}

/// Plugin event: events that plugins can subscribe to or emit.
#[non_exhaustive]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    tag = "type"
)]
#[cfg_attr(feature = "ts", ts(export))]
pub enum PluginEvent {
    /// A message was created
    MessageCreated {
        channel_id: String,
        message_id: String,
    },
    /// A message was deleted
    MessageDeleted {
        channel_id: String,
        message_id: String,
    },
    /// User presence changed
    PresenceChanged { user_id: i64, status: String },
    /// Channel was created
    ChannelCreated { channel_id: String },
    /// Channel was updated
    ChannelUpdated { channel_id: String },
    /// User joined a voice channel
    VoiceChannelJoined { channel_id: String, user_id: i64 },
    /// User left a voice channel
    VoiceChannelLeft { channel_id: String, user_id: i64 },
    /// Plugin configuration changed
    ConfigChanged { plugin_id: String },
    /// Custom plugin-defined event
    Custom {
        plugin_id: String,
        event_name: String,
        #[cfg_attr(feature = "ts", ts(skip))]
        payload: serde_json::Value,
    },
}

/// Plugin API method: methods exposed by the plugin system.
#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", ts(export))]
pub enum PluginApiMethod {
    /// Send a message to a channel
    SendMessage,
    /// Get message by ID
    GetMessage,
    /// Get channel by ID
    GetChannel,
    /// Get user by ID
    GetUser,
    /// Subscribe to plugin events
    SubscribeEvents,
    /// Unsubscribe from plugin events
    UnsubscribeEvents,
    /// Store plugin data (key-value)
    StorageSet,
    /// Retrieve plugin data
    StorageGet,
    /// Delete plugin data
    StorageDelete,
    /// Show a notification
    ShowNotification,
    /// Open a modal/dialog
    ShowModal,
    /// Register a slash command
    RegisterCommand,
    /// Unregister a slash command
    UnregisterCommand,
}

/// Plugin status: current state of a loaded plugin.
#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", ts(export))]
pub enum PluginStatus {
    /// Plugin is loaded and running
    Active,
    /// Plugin is loaded but disabled
    Disabled,
    /// Plugin failed to load (error)
    Error,
    /// Plugin is being loaded
    Loading,
    /// Plugin is being unloaded
    Unloading,
}

/// Plugin error: detailed error information for plugin failures.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct PluginError {
    /// Plugin ID that encountered the error
    pub plugin_id: String,
    /// Error type/category
    pub error_type: String,
    /// Human-readable error message
    pub message: String,
    /// Stack trace (if available)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack_trace: Option<String>,
    /// Timestamp when error occurred (Unix epoch milliseconds)
    pub timestamp: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_manifest_serializes_correctly() {
        let manifest = PluginManifest {
            id: "com.example.test-plugin".to_owned(),
            name: "Test Plugin".to_owned(),
            version: "1.0.0".to_owned(),
            author: "Test Author".to_owned(),
            description: "A test plugin".to_owned(),
            min_wabi_version: Some("0.1.0".to_owned()),
            homepage: Some("https://example.com".to_owned()),
            icon: None,
            permissions: vec![
                PluginPermission::ReadMessages,
                PluginPermission::SendMessages,
            ],
            config_schema: None,
            default_config: None,
        };

        let json = serde_json::to_value(&manifest).unwrap();
        assert_eq!(json["id"], "com.example.test-plugin");
        assert_eq!(
            json["permissions"],
            serde_json::json!(["read_messages", "send_messages"])
        );
    }

    #[test]
    fn plugin_event_serializes_with_tag() {
        let event = PluginEvent::MessageCreated {
            channel_id: "general".to_owned(),
            message_id: "msg_123".to_owned(),
        };

        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["type"], "message_created");
        assert_eq!(json["channelId"], "general");
    }
}
