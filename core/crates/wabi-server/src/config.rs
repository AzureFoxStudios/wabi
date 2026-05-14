//! Server configuration

use serde::{Deserialize, Serialize};

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
    /// User IDs allowed to create/delete channels. Comma-separated in WABI_ADMIN_USER_IDS env var.
    pub admin_user_ids: Vec<i64>,
    /// Path to blacklist file (format: type|value|reason|expires_timestamp)
    pub blacklist_file: String,
}
