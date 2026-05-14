#![allow(dead_code)]
//! WebSocket service for real-time communication
//!
//! Handles:
//! - WebSocket connections
//! - Message broadcasting
//! - Typing indicators
//! - Presence updates

use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    extract::State,
    response::IntoResponse,
    routing::get,
    Router,
};
use futures::{sink::SinkExt, stream::StreamExt};
use std::sync::Arc;
use tokio::sync::broadcast;
use tracing::{info, warn};

use crate::state::AppState;

/// Message types for WebSocket communication
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type")]
pub enum WsMessage {
    /// Client → Server: Join a channel
    #[serde(rename = "join")]
    Join { channel_id: i64 },

    /// Client → Server: Send a message
    #[serde(rename = "message")]
    Message {
        channel_id: i64,
        content: String,
        message_type: Option<String>,
    },

    /// Client → Server: Typing indicator
    #[serde(rename = "typing")]
    Typing { channel_id: i64 },

    /// Server → Client: New message received
    #[serde(rename = "message-received")]
    MessageReceived {
        id: i64,
        channel_id: i64,
        user_id: i64,
        content: String,
        message_type: String,
        created_at: i64,
    },

    /// Server → Client: User is typing
    #[serde(rename = "user-typing")]
    UserTyping {
        channel_id: i64,
        user_id: i64,
        username: String,
    },

    /// Server → Client: Error
    #[serde(rename = "error")]
    Error { message: String },
}

/// WebSocket connection state
pub struct WebSocketState {
    /// Broadcast channel for messages
    pub tx: broadcast::Sender<Arc<WsMessage>>,
}

impl WebSocketState {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(1000);
        Self { tx }
    }
}

impl Default for WebSocketState {
    fn default() -> Self {
        Self::new()
    }
}

/// Create WebSocket router
pub fn ws_router(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/ws", get(ws_handler))
        .with_state(state)
}

/// Handle WebSocket upgrade
async fn ws_handler(ws: WebSocketUpgrade, State(state): State<Arc<AppState>>) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_socket(socket, state))
}

/// Handle individual WebSocket connection
async fn handle_socket(socket: WebSocket, state: Arc<AppState>) {
    let (mut sender, mut receiver) = socket.split();

    info!("New WebSocket connection");

    // Spawn task to handle incoming messages
    let tx = state.ws_tx.clone();
    let recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            if let Message::Text(text) = msg {
                match serde_json::from_str::<WsMessage>(&text) {
                    Ok(ws_msg) => {
                        info!("Received WS message: {:?}", ws_msg);
                        // Broadcast to all connected clients
                        let _ = tx.send(Arc::new(ws_msg));
                    }
                    Err(e) => {
                        warn!("Failed to parse WebSocket message: {}", e);
                    }
                }
            }
        }
    });

    // Spawn task to handle outgoing messages
    let mut rx = state.ws_tx.subscribe();
    let send_task = tokio::spawn(async move {
        while let Ok(msg) = rx.recv().await {
            let json = match serde_json::to_string(&*msg) {
                Ok(j) => j,
                Err(e) => {
                    warn!("Failed to serialize message: {}", e);
                    continue;
                }
            };

            if sender.send(Message::Text(json.into())).await.is_err() {
                break;
            }
        }
    });

    // Wait for either task to complete
    tokio::select! {
        _ = recv_task => {},
        _ = send_task => {},
    }

    info!("WebSocket connection closed");
}
