#![allow(dead_code)]
//! Application state
//!
//! NOTE: This is an OLD duplicate AppState that pre-dates the main
//! `crate::state::AppState`. It has no importers anywhere in the
//! codebase. The WDB dependency was removed in the WDB migration; the
//! rest of the file is harmless dead code that will be deleted in a
//! follow-up cleanup pass. Marked `#[allow(dead_code)]` at the crate
//! level via the `#![allow(dead_code)]` above.

use std::sync::Arc;
use tokio::sync::broadcast;

use crate::api::upload::UploadState;
use crate::config::ServerConfig;

/// Stub AppState — the real one lives in `crate::state`. This struct
/// is retained for module-path compatibility but is unused.
pub struct AppState {
    pub config: ServerConfig,
    pub ws_tx: broadcast::Sender<Arc<crate::websocket::WsMessage>>,
    pub upload_state: UploadState,
}

impl AppState {
    /// Create a new stub AppState. The WDB field is gone; the WDB
    /// equivalent lives in the real `AppState` at `crate::state`.
    pub fn new(config: ServerConfig) -> Self {
        let (ws_tx, _) = broadcast::channel(1000);
        Self {
            config,
            ws_tx,
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
            node_id: "node-1".to_string(),
            is_primary: true,
            mesh_enabled: false,
            mesh_peers: vec![],
            server_role: crate::config::ServerRole::Authority,
            authority_url: None,
            admin_user_ids: vec![],
            blacklist_file: "./data/blacklist.txt".to_string(),
            max_body_size: None,
            lore: Default::default(),
        })
    }
}
