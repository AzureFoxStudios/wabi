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

    /// Client -> Server: Subscribe to a call session for live updates.
    #[serde(rename = "subscribe_call")]
    SubscribeCall { session_id: String },

    /// Client -> Server: Unsubscribe from a call session.
    #[serde(rename = "unsubscribe_call")]
    UnsubscribeCall { session_id: String },

    /// Server -> Client: Call session state changed.
    #[serde(rename = "call_session_changed")]
    CallSessionChanged { session: wabidb::domain::CallSession },

    /// Server -> Client: Call participants list changed.
    #[serde(rename = "call_participant_changed")]
    CallParticipantChanged {
        session_id: String,
        participants: Vec<wabidb::domain::CallParticipant>,
    },

    /// Server -> Client: A new call signal was emitted.
    #[serde(rename = "call_signal_emitted")]
    CallSignalEmitted { signal: wabidb::domain::CallSignal },
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
        .route("/", get(ws_handler))
        .with_state(state)
}

/// Handle WebSocket upgrade
async fn ws_handler(ws: WebSocketUpgrade, State(state): State<Arc<AppState>>) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_socket(socket, state))
}

/// Handle individual WebSocket connection
async fn handle_socket(socket: WebSocket, state: Arc<AppState>) {
    
    let (mut sender, mut receiver) = socket.split();

    // Assign a unique connection id.
    let conn_id = {
        let mut counter = state.ws_conn_id_counter.lock().await;
        let id = *counter;
        *counter += 1;
        id
    };
    {
        let mut subs = state.call_session_subscriptions.lock().await;
        subs.insert(conn_id, std::collections::HashSet::new());
    }

    info!("New WebSocket connection (conn_id={})", conn_id);

    // Spawn task to handle incoming messages
    let tx = state.ws_tx.clone();
    let call_subs = state.call_session_subscriptions.clone();
    let recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            if let Message::Text(text) = msg {
                match serde_json::from_str::<WsMessage>(&text) {
                    Ok(WsMessage::SubscribeCall { session_id }) => {
let mut map = call_subs.lock().await;
                            if let Some(set) = map.get_mut(&conn_id) {
                                set.insert(session_id);
                            }
                    }
                    Ok(WsMessage::UnsubscribeCall { session_id }) => {
let mut map = call_subs.lock().await;
                            if let Some(set) = map.get_mut(&conn_id) {
                                set.remove(&session_id);
                            }
                    }
                    Ok(ws_msg) => {
                        info!("Received WS message: {:?}", ws_msg);
                        let _ = tx.send(Arc::new(ws_msg));
                    }
                    Err(e) => {
                        warn!("Failed to parse WebSocket message: {}", e);
                    }
                }
            }
        }
    });

    // Spawn single outgoing task that multiplexes broadcast + call-push.
    let mut broadcast_rx = state.ws_tx.subscribe();
    let mut call_push_rx = state.call_session_push.subscribe();
    let call_subs_for_outgoing = state.call_session_subscriptions.clone();
    let outgoing_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                biased;
                msg = broadcast_rx.recv() => {
                    match msg {
                        Ok(msg) => {
                            let json = match serde_json::to_string(&*msg) {
                                Ok(j) => j,
                                Err(_) => continue,
                            };
                            if sender.send(Message::Text(json.into())).await.is_err() {
                                break;
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(_) => break,
                    }
                }
                push = call_push_rx.recv() => {
                    match push {
                        Ok((session_id, msg)) => {
                            let is_subscribed = {
                                let map = call_subs_for_outgoing.lock().await;
                                map.get(&conn_id)
                                    .map(|set| set.contains(&session_id))
                                    .unwrap_or(false)
                            };
                            if !is_subscribed { continue; }
                            let json = match serde_json::to_string(&*msg) {
                                Ok(j) => j,
                                Err(_) => continue,
                            };
                            if sender.send(Message::Text(json.into())).await.is_err() {
                                break;
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(_) => break,
                    }
                }
            }
        }
    });
    // Wait for the recv task to end, then abort the other two.
    let _recv_abort = recv_task.abort_handle();
    let outgoing_abort = outgoing_task.abort_handle();
// removed stray let

    let result = recv_task.await;
    match result {
        Ok(_) => info!("WS recv task ended normally"),
        Err(e) if e.is_panic() => warn!("WS recv task PANICKED: {:?}", e),
        Err(e) => warn!("WS recv task cancelled/error: {}", e),
    }
    outgoing_abort.abort();

    // Clean up subscription state.
    state.call_session_subscriptions.lock().await.remove(&conn_id);

    info!("WebSocket connection closed (conn_id={})", conn_id);
}
