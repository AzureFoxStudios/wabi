//! Server configuration

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ServerRole {
    Authority,
    Anchor,
}

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
    pub stdb_uri: String,
    pub stdb_database: String,
    pub node_id: String,
    pub is_primary: bool,
    pub mesh_enabled: bool,
    pub mesh_peers: Vec<String>,
    /// Runtime role. Authority owns STDB; anchor is a stateless regional proxy.
    pub server_role: ServerRole,
    /// Canonical authority URL when running as a regional anchor.
    pub authority_url: Option<String>,
    /// User IDs allowed to create/delete channels. Comma-separated in WABI_ADMIN_USER_IDS env var.
    pub admin_user_ids: Vec<i64>,
    /// Path to blacklist file (format: type|value|reason|expires_timestamp)
    pub blacklist_file: String,
}
