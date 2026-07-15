//! Server configuration

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ServerRole {
    Authority,
    Anchor,
}

#[allow(dead_code)]
impl ServerRole {
    pub fn from_env() -> Self {
        match std::env::var("WABI_SERVER_ROLE")
            .unwrap_or_else(|_| "authority".to_string())
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "anchor" | "regional_anchor" => Self::Anchor,
            _ => Self::Authority,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Authority => "authority",
            Self::Anchor => "anchor",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
    pub data_dir: String,
    pub uploads_dir: String,
    pub jwt_secret: String,
    pub turn_enabled: bool,
    pub turn_uri: Option<String>,
    pub turn_secret: Option<String>,
    pub node_id: String,
    pub is_primary: bool,
    /// Runtime role. Authority owns WDB; anchor is a stateless regional proxy.
    pub server_role: ServerRole,
    /// Canonical authority URL when running as a regional anchor.
    pub authority_url: Option<String>,
    /// User IDs allowed to create/delete channels. Comma-separated in WABI_ADMIN_USER_IDS env var.
    pub admin_user_ids: Vec<i64>,
    /// Path to blacklist file (format: type|value|reason|expires_timestamp)
    pub blacklist_file: String,
    /// Maximum request body size in bytes (default: 50GB for self-hosted "adult choice")
    pub max_body_size: Option<usize>,
    /// Mesh coordination configuration
    pub mesh_enabled: bool,
    pub mesh_peers: Vec<String>,
    /// Lore addon configuration (version-controlled binary storage)
    #[serde(default)]
    pub lore: LoreAddonConfig,
}

/// Configuration for the optional Lore addon (version-controlled binary storage).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct LoreAddonConfig {
    /// Whether the Lore addon is enabled at startup.
    pub enabled: bool,
    /// Operation mode: embedded, sidecar, or remote.
    pub mode: String,
    /// URL of the Lore server.
    pub server_url: String,
    /// Path to the Lore binary (CLI).
    pub binary_path: String,
    /// Data directory for embedded Lore server.
    pub data_dir: String,
    /// Maximum blob size in MB.
    pub default_blob_max_size_mb: u32,
    /// Auto-create a Lore repo when a channel is created with asset_storage: true.
    pub auto_create_repos: bool,
    /// Name of the Asset Storage channel that finished call recordings are
    /// uploaded to (created once by the operator). Optional; defaults to
    /// "Recordings".
    pub recordings_channel_name: Option<String>,
}

impl Default for LoreAddonConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            mode: "sidecar".into(),
            server_url: "lore://localhost:10000".into(),
            binary_path: "lore".into(),
            data_dir: "/var/wabi/lore".into(),
            default_blob_max_size_mb: 1024,
            auto_create_repos: true,
            recordings_channel_name: None,
        }
    }
}
