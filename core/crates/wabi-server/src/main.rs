//! Wabi Server - Self-Hosted Server with API
//!
//! Single binary that serves:
//! - Embedded frontend static files
//! - HTTP API routes (auth, channels, messages, user)
//! - Health check endpoints
//! - WebSocket real-time communication
//!
//! Everything lives in the `wabi_server` library; see `startup.rs`.

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    wabi_server::startup::run().await
}
