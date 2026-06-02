#![allow(dead_code)]
//! Application state

use std::sync::Arc;
use tokio::sync::broadcast;

use crate::api::upload::UploadState;
use crate::config::ServerConfig;
use crate::db::StdbClient;

/// Shared application state
pub struct AppState {
    pub config: ServerConfig,
    pub ws_tx: broadcast::Sender<Arc<crate::websocket::WsMessage>>,
    pub stdb: StdbClient,
    pub upload_state: UploadState,
}

impl AppState {
    /// Create new application state
    pub fn new(config: ServerConfig) -> Self {
        let (ws_tx, _) = broadcast::channel(1000);

        // Create SpacetimeDB client from environment or defaults
        let stdb_server = std::env::var("WABI_STDB_SERVER")
            .unwrap_or_else(|_| "http://localhost:3100".to_string());
        let stdb_database = std::env::var("WABI_STDB_DATABASE")
            .unwrap_or_else(|_| "wabi-state-benchmark-v2".to_string());
        let stdb_token = std::env::var("WABI_STDB_TOKEN").ok();

        let stdb = StdbClient::new(stdb_server, stdb_database, stdb_token);

        Self {
            config,
            ws_tx,
            stdb,
            upload_state: UploadState::new(),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new(ServerConfig {
            host: "0.0.0.0".to_string(),
            port: 3000,
            data_dir: "./data".to_string(),
            uploads_dir: "./data/uploads".to_string(),
            jwt_secret: "dev-secret".to_string(),
            turn_enabled: false,
            turn_uri: None,
            turn_secret: None,
            stdb_uri: "http://localhost:3100".to_string(),
            stdb_database: "wabi-state-benchmark-v2".to_string(),
            node_id: "node-1".to_string(),
            is_primary: true,
            mesh_enabled: false,
            mesh_peers: vec![],
            server_role: crate::config::ServerRole::Authority,
            authority_url: None,
            admin_user_ids: vec![],
            blacklist_file: "./data/blacklist.txt".to_string(),
        })
    }
}
