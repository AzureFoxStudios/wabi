//! Socket.IO service for real-time communication

use axum::{
    body::Body,
    extract::{ws::Message, State},
    http::{Request, Response},
    routing::any,
    Router,
};
use futures::{SinkExt, StreamExt};
use std::sync::Arc;
use tokio::sync::broadcast;

use crate::state::AppState;

/// Create Socket.IO router
pub fn create_socket_service(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/", any(socket_handler))
        .with_state(state)
}

/// Socket.IO connection handler
async fn socket_handler(
    State(_state): State<Arc<AppState>>,
    req: Request<Body>,
) -> Response<Body> {
    // TODO: Implement proper Socket.IO protocol
    // For now, upgrade to WebSocket and handle basic events
    
    tracing::info!("Socket.IO connection attempt");
    
    // Placeholder: return 501 Not Implemented
    // Full Socket.IO implementation requires socketioxide crate
    axum::http::Response::builder()
        .status(501)
        .body(Body::from("Socket.IO not yet implemented"))
        .unwrap()
}

/// Handle WebSocket messages
async fn handle_ws_messages(
    mut ws_tx: axum::extract::ws::WebSocket,
    mut ws_rx: futures::stream::SplitStream<axum::extract::ws::WebSocket>,
    state: Arc<AppState>,
) {
    // Create broadcast channel for this connection
    let (_tx, mut rx) = broadcast::channel::<String>(100);
    
    // Spawn task to send messages to client
    let send_task = tokio::spawn(async move {
        while let Ok(msg) = rx.recv().await {
            if ws_tx
                .send(axum::extract::ws::Message::Text(msg))
                .await
                .is_err()
            {
                break;
            }
        }
    });

    // Receive messages from client
    while let Some(Ok(msg)) = ws_rx.next().await {
        match msg {
            axum::extract::ws::Message::Text(text) => {
                tracing::info!("Received socket message: {}", text);
                // TODO: Parse Socket.IO packet and handle event
            }
            axum::extract::ws::Message::Close(_) => {
                tracing::info!("Socket closed");
                break;
            }
            _ => {}
        }
    }

    send_task.abort();
}
