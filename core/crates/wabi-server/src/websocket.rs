//! Authenticated, resource-scoped call-state subscriptions. Chat and media use
//! Socket.IO; this socket never accepts client-originated broadcast payloads.
use crate::{
    auth_extractor::{authenticate_access_token, AuthUser},
    call_access::*,
    state::AppState,
};
use axum::{
    extract::{
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::IntoResponse,
    routing::get,
    Router,
};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::{
    sync::broadcast,
    time::{timeout, Instant},
};
use wabidb::engine::wabi_store::WabiStore;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type")]
pub enum WsMessage {
    #[serde(rename = "call_session_changed")]
    CallSessionChanged {
        session: wabidb::domain::CallSession,
    },
    #[serde(rename = "call_participant_changed")]
    CallParticipantChanged {
        session_id: String,
        participants: Vec<wabidb::domain::CallParticipant>,
    },
    #[serde(rename = "call_signal_emitted")]
    CallSignalEmitted { signal: wabidb::domain::CallSignal },
    /// Internal control push, translated to subscription_error for the affected
    /// account only. Versioning prevents an old removal from cancelling a later
    /// explicit subscription after re-add.
    CallAccessRevoked { user_id: u64, membership_revision: u64 },
}
#[derive(serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum Incoming {
    Authenticate {
        token: String,
    },
    SubscribeCall {
        session_id: String,
        #[serde(default)]
        since: u64,
    },
    UnsubscribeCall {
        session_id: String,
    },
}

pub fn ws_router(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new().route("/", get(ws_handler)).with_state(state)
}
async fn ws_handler(ws: WebSocketUpgrade, State(state): State<Arc<AppState>>) -> impl IntoResponse {
    ws.max_message_size(16 * 1024)
        .max_frame_size(16 * 1024)
        .on_upgrade(|socket| handle_socket(socket, state))
}
async fn send(socket: &mut WebSocket, value: Value) -> bool {
    matches!(
        timeout(
            Duration::from_secs(5),
            socket.send(Message::Text(value.to_string().into()))
        )
        .await,
        Ok(Ok(()))
    )
}
async fn close(socket: &mut WebSocket, code: u16, reason: &'static str) {
    let _ = timeout(
        Duration::from_secs(5),
        socket.send(Message::Close(Some(CloseFrame {
            code,
            reason: reason.into(),
        }))),
    )
    .await;
}
async fn authenticate(state: &AppState, token: &str) -> Option<AuthUser> {
    let auth = authenticate_access_token(state, token).await.ok()?;
    // No leeway on a long-lived connection: the browser renews before expiry.
    if auth.exp <= chrono::Utc::now().timestamp() {
        return None;
    }
    require_principal(state, auth.user_id).await.ok()?;
    Some(auth)
}
async fn reject_auth(socket: &mut WebSocket) {
    send(
        socket,
        json!({"type":"authentication_error","message":"Valid account access token required"}),
    )
    .await;
    close(socket, 4401, "Authentication required").await;
}

async fn handle_socket(mut socket: WebSocket, state: Arc<AppState>) {
    // One owner, no orphaned reader/writer tasks or global connection registry.
    let mut pushes = state.call_session_push.subscribe();
    let mut subscriptions = HashMap::<String, u64>::new();
    let mut credential: Option<String> = None;
    let mut principal: Option<i64> = None;
    let opened = Instant::now();
    let mut last_pong = Instant::now();
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    let mut last_ping = Instant::now();
    loop {
        tokio::select! {
            _ = tick.tick() => {
                if credential.is_none() {
                    if opened.elapsed() >= Duration::from_secs(5) { reject_auth(&mut socket).await; break; }
                    continue;
                }
                if authenticate(&state, credential.as_deref().unwrap()).await.is_none() { reject_auth(&mut socket).await; break; }
                if last_pong.elapsed() > Duration::from_secs(45) { close(&mut socket, 1001, "Heartbeat timeout").await; break; }
                if last_ping.elapsed() >= Duration::from_secs(15) {
                    if !matches!(timeout(Duration::from_secs(5), socket.send(Message::Ping(Vec::new().into()))).await, Ok(Ok(()))) { break; }
                    last_ping = Instant::now();
                }
            }
            incoming = socket.recv() => {
                let Some(Ok(message)) = incoming else { break; };
                let text = match message {
                    Message::Text(text) => text,
                    Message::Pong(_) => { last_pong = Instant::now(); continue; }
                    Message::Ping(_) => continue, // Axum automatically queues the pong.
                    Message::Close(_) => break,
                    _ => { close(&mut socket, 1003, "Text control messages only").await; break; }
                };
                let request = serde_json::from_str::<Incoming>(&text);
                if let Ok(Incoming::Authenticate { token }) = request {
                    let Some(auth) = authenticate(&state, &token).await else { reject_auth(&mut socket).await; break; };
                    if principal.is_some_and(|uid| uid != auth.user_id) { reject_auth(&mut socket).await; break; }
                    principal = Some(auth.user_id); credential = Some(token);
                    if !send(&mut socket, json!({"type":"authenticated","user_id":auth.user_id,"expires_at":auth.exp})).await { break; }
                    continue;
                }
                let Some(auth) = (match credential.as_deref() { Some(token) => authenticate(&state, token).await, None => None }) else { reject_auth(&mut socket).await; break; };
                match request {
                    Ok(Incoming::SubscribeCall { session_id, since }) => {
                        let membership = state.membership_gate.read().await;
                        let _guard = state.call_session_locks.lock(&session_id).await;
                        let session = require_session(&state, auth.user_id, &session_id).await;
                        if session.is_err() || (!subscriptions.contains_key(&session_id) && subscriptions.len() >= 64) {
                            subscriptions.remove(&session_id);
                            drop(_guard);
                            drop(membership);
                            if !send(&mut socket, json!({"type":"subscription_error","session_id":session_id,"message":"Call unavailable or subscription limit reached"})).await { break; }
                            continue;
                        }
                        let session = session.unwrap();
                        let Ok(participants) = state.wdb.get_call_participants(&session_id).await else { break; };
                        let signals = if require_participant(&state, &session, auth.user_id as u64).await.is_ok() {
                            let Ok(signals) = state.wdb.get_call_signals(&session_id, since).await else { break; };
                            signals.into_iter().filter(|s| s.created_at_micros >= session.started_at_micros && signal_visible(s, auth.user_id as u64)).collect::<Vec<_>>()
                        } else { vec![] };
                        let Ok(revision) = wabidb::projections::channel_members::ChannelMembersProjection::revision(
                            &state.wdb.engine().projection_state(), &session.channel_id,
                        ) else { break; };
                        subscriptions.insert(session_id.clone(), revision);
                        // Network backpressure must never hold a call's write lock.
                        drop(_guard);
                        drop(membership);
                        if !send(&mut socket, json!({"type":"call_snapshot","session_id":session_id,"session":session,"participants":participants,"signals":signals,"membership_revision":revision.to_string()})).await { break; }
                    }
                    Ok(Incoming::UnsubscribeCall { session_id }) => { subscriptions.remove(&session_id); }
                    _ => if !send(&mut socket, json!({"type":"error","message":"Unsupported client message"})).await { break; },
                }
            }
            push = pushes.recv() => {
                let (id, message) = match push {
                    Ok(push) => push,
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        // Never silently pretend a lossy subscription is current.
                        if !send(&mut socket, json!({"type":"resync_required"})).await { break; }
                        subscriptions.clear(); continue;
                    }
                    Err(_) => break,
                };
                let Some(subscribed_revision) = subscriptions.get(&id).copied() else { continue; };
                let Some(auth) = (match credential.as_deref() { Some(token) => authenticate(&state, token).await, None => None }) else { reject_auth(&mut socket).await; break; };
                if let WsMessage::CallAccessRevoked { user_id, membership_revision } = &*message {
                    if *user_id == auth.user_id as u64 && subscribed_revision <= *membership_revision {
                        subscriptions.remove(&id);
                        if !send(&mut socket, json!({"type":"subscription_error","session_id":id,"message":"Group membership revoked","membership_revision":membership_revision.to_string()})).await { break; }
                    }
                    continue;
                }
                let membership = state.membership_gate.read().await;
                let _guard = state.call_session_locks.lock(&id).await;
                let Ok(session) = require_session(&state, auth.user_id, &id).await else {
                    subscriptions.remove(&id);
                    drop(_guard);
                    drop(membership);
                    if !send(&mut socket, json!({"type":"subscription_error","session_id":id,"message":"Call access lost"})).await { break; }
                    continue;
                };
                let value = match &*message {
                    WsMessage::CallSignalEmitted { signal } => {
                        if signal.created_at_micros < session.started_at_micros || !signal_visible(signal, auth.user_id as u64)
                            || require_participant(&state, &session, auth.user_id as u64).await.is_err() { continue; }
                        json!(&*message)
                    }
                    // Read current snapshots so pre-subscription queued pushes
                    // cannot regress the snapshot just sent during subscribe.
                    WsMessage::CallSessionChanged { .. } => json!(WsMessage::CallSessionChanged { session }),
                    WsMessage::CallParticipantChanged { .. } => {
                        let Ok(participants) = state.wdb.get_call_participants(&id).await else { break; };
                        json!(WsMessage::CallParticipantChanged { session_id:id, participants })
                    }
                    WsMessage::CallAccessRevoked { .. } => unreachable!("control pushes handled above"),
                };
                drop(_guard);
                drop(membership);
                if !send(&mut socket, value).await { break; }
            }
        }
    }
}
